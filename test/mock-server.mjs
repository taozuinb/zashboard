/*
 * 模拟 mihomo 的 Clash API,用来造出「代理组特别多」的现场(见 issue #784)。
 *
 * 单独跑:
 *   node test/mock-server.mjs --groups 150 --nodes 60 --conns 300 --port 9999
 * 然后把面板指到 http://127.0.0.1:9999 即可(密码留空)。
 *
 * 也被 test/bench.mjs 与 test/verify.mjs 当模块用。
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { parseArgs } from 'node:util'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
}

const buildFixture = ({ groups, nodes, connections, providers: providerCount }) => {
  const now = new Date().toISOString()
  const nodeNames = Array.from({ length: nodes }, (_, i) => `Node-${String(i).padStart(3, '0')} 🇭🇰`)
  const groupNames = Array.from({ length: groups }, (_, i) => `Group-${String(i).padStart(3, '0')}`)
  const proxies = {}

  nodeNames.forEach((name, i) => {
    proxies[name] = {
      name,
      type: 'Vmess',
      udp: true,
      xudp: false,
      alive: i % 7 !== 0,
      // 每 7 个留一个不可用的,好覆盖「隐藏不可用节点」这类分支
      history: [{ time: now, delay: i % 7 === 0 ? 0 : 50 + (i % 400) }],
      'provider-name': `provider-${i % providerCount}`,
    }
  })
  proxies.DIRECT = { name: 'DIRECT', type: 'Direct', udp: true, history: [], alive: true }
  proxies.REJECT = { name: 'REJECT', type: 'Reject', udp: false, history: [], alive: true }

  groupNames.forEach((name, i) => {
    proxies[name] = {
      name,
      // 混着来:面板测速模式只对 Selector 这类走「逐个测速」的分支
      type: i % 3 === 0 ? 'Selector' : 'URLTest',
      now: nodeNames[i % nodes],
      all: [...nodeNames, 'DIRECT', 'REJECT'],
      history: [{ time: now, delay: 80 + (i % 200) }],
      alive: true,
      udp: true,
      hidden: false,
    }
  })
  proxies.GLOBAL = {
    name: 'GLOBAL',
    type: 'Selector',
    now: groupNames[0],
    all: [...groupNames, ...nodeNames, 'DIRECT', 'REJECT'],
    history: [],
    alive: true,
  }

  const providers = {}

  for (let i = 0; i < providerCount; i++) {
    const name = `provider-${i}`

    providers[name] = {
      name,
      type: 'Proxy',
      vehicleType: 'HTTP',
      updatedAt: now,
      proxies: nodeNames.filter((_, index) => index % providerCount === i).map((n) => proxies[n]),
      subscriptionInfo: { Upload: 1e9, Download: 5e10, Total: 1e12, Expire: 1893456000 },
    }
  }

  const activeConnections = Array.from({ length: connections }, (_, i) => ({
    id: `conn-${i}`,
    metadata: {
      network: 'tcp',
      type: 'HTTP',
      sourceIP: '192.168.1.2',
      destinationIP: '1.1.1.1',
      sourcePort: `${10000 + i}`,
      destinationPort: '443',
      host: `example-${i}.com`,
      process: 'chrome',
    },
    upload: 1000 * i,
    download: 5000 * i,
    start: now,
    // 链路带上组名,组卡片的下行速率才有东西可算
    chains: [nodeNames[i % nodes], groupNames[i % groups], groupNames[(i + 1) % groups]],
    rule: 'DomainSuffix',
    rulePayload: 'example.com',
  }))

  return { proxies, providers, nodeNames, groupNames, activeConnections }
}

// 手写 WebSocket 文本帧,省掉一个 ws 依赖
const websocketFrame = (text) => {
  const payload = Buffer.from(text)
  let header

  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }

  return Buffer.concat([header, payload])
}

export const createMockServer = async ({
  port = 0,
  groups = 150,
  nodes = 60,
  connections = 300,
  providers: providerCount = 4,
} = {}) => {
  const fixture = buildFixture({ groups, nodes, connections, providers: providerCount })
  const { proxies, providers, nodeNames, activeConnections } = fixture

  /*
   * 可在运行时改的开关:
   * - stableLatency:关掉「每次拉 /proxies 都换一批延迟」,这样测速时新写进去的值才好辨认;
   * - latencyDelayMs:让单节点测速慢一点,才采得到「乐观写入」的中间态;
   * - speedtestRouteGroup / speedtestNodeDelay / speedtestDefaultDelay:下载测速按「当前选中
   *   的节点」给 /__speedtest 不同的每块延迟,才能造出「哪个节点最快」这个结论;
   * - syntheticSpeedtestConnection:往 /connections 里加一条经过被测组的合成连接,引擎据此
   *   校验「下载确实走了这个组,而不是直连」;
   * - serverSpeedtestForbidden:让 /node-speed 假服务返回 403,用来覆盖「跨来源被拒」这条失败路径。
   * 默认全部是关的,所以 bench / verify / setup / rules 看到的行为不变。
   */
  const control = {
    stableLatency: false,
    latencyDelayMs: 0,
    latencyValue: 999,
    speedtestRouteGroup: '',
    speedtestNodeDelay: {},
    speedtestDefaultDelay: 30,
    syntheticSpeedtestConnection: false,
    serverSpeedtestForbidden: false,
  }
  let fetchCount = 0

  /*
   * 「服务端测速」假服务(node_speed_test):zashboard 把 server-url 配成 mock 的 /node-speed
   * 时才会用到。任务按固定节奏每 250ms 测完一个节点,节点速度按名字造(Node-001 最快),
   * auto_select 完成时像真服务那样改掉内核里的组选中项,这样 e2e 才能断言「测完选中最快」。
   */
  const serverSpeedtest = {
    connection: null,
    task: null,
    warnings: [],
    timers: new Set(),
  }

  const configs = {
    port: 7890,
    'socks-port': 7891,
    'mixed-port': 7890,
    mode: 'rule',
    'log-level': 'info',
    'allow-lan': false,
    tun: { enable: false, stack: 'gVisor' },
    'mode-list': ['rule', 'global', 'direct'],
  }

  const rollLatencies = () => {
    if (control.stableLatency) return

    fetchCount++
    for (const name of nodeNames) {
      const node = proxies[name]

      if (node.history.length) {
        node.history = [{ time: new Date().toISOString(), delay: 100 + ((fetchCount * 7) % 300) }]
      }
    }
  }

  const json = (res, data) => {
    res.writeHead(200, { 'content-type': 'application/json', ...CORS })
    res.end(JSON.stringify(data))
  }

  const readBody = (req) =>
    new Promise((resolve) => {
      let body = ''

      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve({})
        }
      })
    })

  // 假服务自己的应答:错误码也要带 CORS,前端才读得到 detail(跨来源被拒那条用例就靠它)
  const serverSpeedtestReply = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json', ...CORS })
    res.end(JSON.stringify(data))
  }

  const serverSpeedtestClearTimers = () => {
    for (const timer of serverSpeedtest.timers) clearTimeout(timer)
    serverSpeedtest.timers.clear()
  }

  const SERVER_SPEEDTEST_TICK_MS = 250
  // 速度按节点短名造:Node-001 最快,e2e 的结论不依赖时序碰运气
  const SERVER_SPEEDTEST_MBPS = { 'Node-000': 1, 'Node-001': 12, 'Node-002': 2 }
  // 真实服务的 422 detail 是字符串,不是数组
  const SERVER_SPEEDTEST_INVALID = '请求参数无效，请检查输入类型、范围及路由确认。'

  const serverSpeedtestSpeed = (name) => {
    const short = String(name ?? '').split(' ')[0]

    return Math.round((SERVER_SPEEDTEST_MBPS[short] ?? 0.5) * 1024 * 1024)
  }

  const serverSpeedtestGroupOf = (groupId) =>
    serverSpeedtest.connection?.groups.find((group) => group.id === groupId) ?? null

  // results / top 的元素形状与真实服务的 PublicResult 一致
  const serverSpeedtestResult = (task, name) => {
    const speedBps = serverSpeedtestSpeed(name)

    return {
      id: `result-${task.results.length}`,
      name,
      status: 'success',
      bytes_received: Math.round(
        Math.min(
          task.max_bytes > 0 ? task.max_bytes : Number.POSITIVE_INFINITY,
          speedBps * task.duration,
        ),
      ),
      elapsed: task.duration,
      speed_bps: speedBps,
      error: null,
    }
  }

  const serverSpeedtestFinish = (task) => {
    task.status = 'completed'
    task.current_node = null
    task.current_started_at = null
    task.stop_reason = 'exhausted'
    task.finished_at = new Date().toISOString()

    const ranked = task.results
      .filter((result) => result.status === 'success' && result.speed_bps != null)
      .sort((a, b) => b.speed_bps - a.speed_bps)

    // top 是同一批结果里最快的几个(真实服务最多给 3 个)
    task.top = ranked.slice(0, 3).map((result) => ({ ...result }))

    const fastest = ranked[0] ?? null

    if (task.auto_select && fastest) {
      const group = serverSpeedtestGroupOf(task.group_id)

      if (group && proxies[group.name]) proxies[group.name].now = fastest.name

      task.selected_node = fastest.name
      task.selected_result_id = fastest.id
      task.selection_status = 'selected'
      // 服务端自己完成的选中,不需要前端再恢复原选择
      task.restoration = 'not_needed'
    } else {
      // 不自动选:组保持测速前的选择,restoration 直接给最终态
      task.selected_node = null
      task.selected_result_id = null
      task.selection_status = 'not_requested'
      task.restoration = 'restored'
    }
  }

  const serverSpeedtestStartTask = (body, groupInfo) => {
    serverSpeedtestClearTimers()

    const candidates = nodeNames.slice(0, groupInfo.candidate_count)
    const duration = Number(body.duration)
    const maxBytes = Number(body.max_bytes)

    const task = {
      id: `task-${Date.now()}`,
      status: 'running',
      // 契约里 task.group 是组名;组 id 只留内部用
      group: groupInfo.name,
      group_id: groupInfo.id,
      url: body.url ?? '',
      duration: Number.isFinite(duration) && duration > 0 ? duration : 10,
      max_bytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 250 * 1024 * 1024,
      timeout: Number(body.timeout) || 30,
      auto_select: body.auto_select === true,
      route_confirmed: true,
      candidate_total: candidates.length,
      total: candidates.length,
      completed: 0,
      current_node: candidates[0] ?? null,
      current_started_at: Date.now(),
      results: [],
      top: [],
      latency_completed: 0,
      latency_results: [],
      skipped_entries: [],
      stop_reason: null,
      restoration: 'pending',
      error: null,
      selected_node: null,
      selected_result_id: null,
      selection_status: 'not_requested',
      can_select: true,
      manual_selection: false,
      previous_node: proxies[groupInfo.name]?.now ?? '',
      started_at: new Date().toISOString(),
      finished_at: null,
    }

    serverSpeedtest.task = task

    const advance = () => {
      serverSpeedtest.timers.delete(timer)

      // 任务可能已经被 stop / 新任务顶掉,别让旧定时器继续推进
      if (serverSpeedtest.task !== task || task.status !== 'running') return

      const name = candidates[task.completed]

      if (!name) return serverSpeedtestFinish(task)

      task.results.push(serverSpeedtestResult(task, name))
      task.completed += 1
      // 假服务不单独做延迟筛测,直接把完成数同步过去,前端只看进度展示
      task.latency_completed = task.completed

      if (task.completed >= candidates.length) return serverSpeedtestFinish(task)

      task.current_node = candidates[task.completed] ?? null
      task.current_started_at = Date.now()

      timer = setTimeout(advance, SERVER_SPEEDTEST_TICK_MS)
      serverSpeedtest.timers.add(timer)
    }

    let timer = setTimeout(advance, SERVER_SPEEDTEST_TICK_MS)

    serverSpeedtest.timers.add(timer)

    return task
  }

  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://localhost')
    const { pathname } = requestUrl

    if (req.method === 'OPTIONS') {
      // 假服务的预检:真实服务只放行 GET/POST/OPTIONS + Content-Type,这里照着回
      if (pathname.startsWith('/node-speed/')) {
        res.writeHead(204, {
          ...CORS,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'Content-Type',
        })
        return res.end()
      }

      res.writeHead(204, CORS)
      return res.end()
    }

    // 测试脚本用来切换上面那些开关
    if (pathname === '/__mock/control') {
      Object.assign(control, await readBody(req))
      return json(res, control)
    }

    /*
     * 下载测速用的应答:分块写、每块之间按「当前被测组选中的节点」延迟。
     * 浏览器真的把这 N 个字节收完,测出来的吞吐才会因节点而异。
     */
    if (pathname === '/__speedtest') {
      const requested = Number(requestUrl.searchParams.get('bytes'))
      // 默认 1MB,clamp 到 1B..64MB:脚本不该因为一个手滑的 query 把测试拖爆
      const bytes = Math.min(
        Math.max(Number.isFinite(requested) ? Math.floor(requested) : 1024 * 1024, 1),
        64 * 1024 * 1024,
      )
      const headers = {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes),
        // 每个节点都得真的重新下载一遍,不能被浏览器缓存糊弄过去
        'cache-control': 'no-store, no-cache, must-revalidate',
        pragma: 'no-cache',
        expires: '0',
        ...CORS,
      }

      if (req.method === 'HEAD') {
        res.writeHead(200, headers)
        return res.end()
      }

      const selectedProxy = control.speedtestRouteGroup
        ? proxies[control.speedtestRouteGroup]?.now
        : ''
      // 节点名允许配完整名,也允许配去掉空格后缀的短名(如 Node-000),方便手动联调
      const delayMap = control.speedtestNodeDelay ?? {}
      const nodeDelay = delayMap[selectedProxy] ?? delayMap[String(selectedProxy).split(' ')[0]]
      const chunkDelay = Math.max(0, Number(nodeDelay ?? control.speedtestDefaultDelay ?? 30))

      res.writeHead(200, headers)

      const chunkSize = 128 * 1024
      const chunk = Buffer.alloc(chunkSize, 0x20)
      let sent = 0
      let timer = null
      const stop = () => {
        if (timer) clearTimeout(timer)
        timer = null
      }
      const pump = () => {
        timer = null

        if (sent >= bytes) return res.end()
        if (res.destroyed || res.writableEnded) return stop()

        const size = Math.min(chunkSize, bytes - sent)

        sent += size
        res.write(chunk.subarray(0, size))
        timer = setTimeout(pump, chunkDelay)
      }

      // 引擎可能提前取消下载(超时/测够了),别让定时器一直空转
      res.on('close', stop)
      res.on('error', stop)
      pump()

      return
    }

    // ---- 服务端测速假服务(node_speed_test) ----
    if (pathname.startsWith('/node-speed/api/')) {
      const route = pathname.slice('/node-speed'.length).replace(/\/+$/, '')

      // 跨来源被拒:错误体也要带 CORS 头,前端才读得到 detail
      if (control.serverSpeedtestForbidden) {
        return serverSpeedtestReply(res, 403, { detail: '不允许跨来源访问。' })
      }

      if (route === '/api/connection' && req.method === 'POST') {
        const body = await readBody(req)
        const connection = {
          id: 'connection-000',
          controller: body.controller ?? '',
          proxy: body.proxy ?? '',
          groups: [
            {
              id: 'group-000',
              name: 'Group-000',
              // 真实服务回的是内核组类型,mock 跟它保持一致
              kind: 'Selector',
              candidate_count: nodeNames.length,
              available: true,
              reason: null,
            },
            {
              id: 'group-001',
              name: 'Group-001',
              kind: 'URLTest',
              candidate_count: nodeNames.length,
              available: true,
              reason: null,
            },
          ],
        }

        serverSpeedtestClearTimers()
        serverSpeedtest.connection = connection
        serverSpeedtest.task = null

        return serverSpeedtestReply(res, 200, connection)
      }

      if (route === '/api/tasks' && req.method === 'POST') {
        const body = await readBody(req)
        const connection = serverSpeedtest.connection
        // 跟真实服务一样:先建 connection,group 用组 id,路由必须确认过,数值字段在契约范围内
        const group = serverSpeedtestGroupOf(body.group)
        const valid =
          Boolean(connection) &&
          typeof body.connection_id === 'string' &&
          connection.id === body.connection_id &&
          Boolean(group) &&
          group.available === true &&
          body.route_confirmed === true &&
          typeof body.url === 'string' &&
          body.url.length > 0 &&
          typeof body.duration === 'number' &&
          body.duration >= 0.1 &&
          body.duration <= 120 &&
          typeof body.max_bytes === 'number' &&
          Number.isInteger(body.max_bytes) &&
          body.max_bytes >= 1 &&
          body.max_bytes <= 1024 ** 3 &&
          typeof body.timeout === 'number' &&
          body.timeout >= 0.1 &&
          body.timeout <= 30

        if (!valid) return serverSpeedtestReply(res, 422, { detail: SERVER_SPEEDTEST_INVALID })

        if (serverSpeedtest.task?.status === 'running') serverSpeedtestClearTimers()

        return serverSpeedtestReply(res, 202, serverSpeedtestStartTask(body, group))
      }

      if (route === '/api/state' && req.method === 'GET') {
        return serverSpeedtestReply(res, 200, {
          connecting: false,
          connection: serverSpeedtest.connection,
          task: serverSpeedtest.task,
          warnings: serverSpeedtest.warnings,
        })
      }

      const stopMatch = route.match(/^\/api\/tasks\/([^/]+)\/stop$/)

      if (stopMatch && req.method === 'POST') {
        const task = serverSpeedtest.task

        if (!task || task.id !== decodeURIComponent(stopMatch[1])) {
          return serverSpeedtestReply(res, 404, { detail: '任务不存在。' })
        }

        if (task.status === 'running') {
          serverSpeedtestClearTimers()
          task.status = 'cancelled'
          task.current_node = null
          task.current_started_at = null
          task.stop_reason = null
          task.selection_status = 'not_requested'
          task.restoration = 'restored'
          task.finished_at = new Date().toISOString()
        }

        return serverSpeedtestReply(res, 202, task)
      }

      return serverSpeedtestReply(res, 404, { detail: '未知的接口。' })
    }

    if (pathname === '/version') return json(res, { version: 'v1.19.0', meta: true })
    if (pathname === '/configs') {
      // 跟 mihomo 的 PATCH 一样:没送到的字段保持原样,tun 里的子字段也是
      if (req.method === 'PATCH') {
        const patch = await readBody(req)

        Object.assign(configs, patch, patch.tun ? { tun: { ...configs.tun, ...patch.tun } } : {})
      }

      return json(res, configs)
    }
    if (pathname === '/proxies') {
      rollLatencies()
      return json(res, { proxies })
    }
    if (pathname === '/providers/proxies') return json(res, { providers })
    if (pathname === '/providers/rules') return json(res, { providers: {} })
    if (pathname === '/rules')
      return json(res, {
        rules: [
          // 跟真 mihomo 一样,类型是 DomainSuffix / GeoIP / Match 这种写法
          { index: 0, type: 'DomainSuffix', payload: 'example.com', proxy: 'Group-000', size: -1 },
          { index: 1, type: 'GeoIP', payload: 'CN', proxy: 'DIRECT', size: -1 },
          { index: 2, type: 'Match', payload: '', proxy: 'Group-001', size: -1 },
        ],
      })

    // 单节点测速会更新内核里的 history,随后页面重新 GET /proxies 才能看到排序变化。
    // mock 也保留这个语义,否则只能测到请求成功,覆盖不到「测速后重排」这条真实链路。
    const testedProxyName = (() => {
      const proxyMatch = pathname.match(/^\/proxies\/([^/]+)\/delay$/)
      if (proxyMatch) return decodeURIComponent(proxyMatch[1])

      const providerMatch = pathname.match(/^\/providers\/proxies\/[^/]+\/([^/]+)\/healthcheck$/)
      return providerMatch ? decodeURIComponent(providerMatch[1]) : ''
    })()

    if (testedProxyName && proxies[testedProxyName]) {
      proxies[testedProxyName].history = [
        { time: new Date().toISOString(), delay: control.latencyValue },
      ]
    }

    // 测速类端点(节点 / 组 / provider healthcheck)
    if (pathname.endsWith('/delay') || pathname.includes('/healthcheck')) {
      return setTimeout(() => json(res, { delay: control.latencyValue }), control.latencyDelayMs)
    }

    if (pathname.startsWith('/proxies/') && req.method === 'PUT') {
      const groupName = decodeURIComponent(pathname.slice('/proxies/'.length))
      const { name } = await readBody(req)

      if (proxies[groupName] && name) {
        proxies[groupName].now = name
      }

      return json(res, {})
    }

    return json(res, {})
  })

  // 关服务时要主动断掉这些长连接,否则 server.close() 会一直等着它们
  const liveSockets = new Set()

  server.on('upgrade', (req, socket) => {
    liveSockets.add(socket)
    socket.on('close', () => liveSockets.delete(socket))
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )

    const { pathname } = new URL(req.url, 'http://localhost')
    let tick = 0

    /*
     * 下载测速的「路由校验」靠这条合成连接:引擎会去找一条
     * host == 测速 URL 主机 && chains 里同时有被测组和组当前选中节点 的连接。
     * 它只在 control.syntheticSpeedtestConnection 打开时才出现,默认没有。
     */
    const syntheticSpeedtestConnection = () => {
      if (control.syntheticSpeedtestConnection !== true) return []

      const groupName = control.speedtestRouteGroup

      if (!groupName) return []

      const selected = proxies[groupName]?.now

      return [
        {
          id: 'speedtest-synthetic',
          metadata: {
            network: 'tcp',
            type: 'HTTP',
            sourceIP: '192.168.1.2',
            sourcePort: '55555',
            destinationIP: '127.0.0.1',
            // 引擎按 URL.hostname 匹配,host 里不能带端口;端口单独给
            destinationPort: String(server.address()?.port ?? ''),
            host: '127.0.0.1',
          },
          upload: 0,
          download: tick * 1024 * 1024,
          start: new Date().toISOString(),
          chains: [groupName, selected].filter(Boolean),
          rule: 'Match',
          rulePayload: '',
        },
      ]
    }

    const timer = setInterval(() => {
      tick++
      try {
        if (pathname.startsWith('/connections')) {
          socket.write(
            websocketFrame(
              JSON.stringify({
                downloadTotal: 1e9 + tick * 1e6,
                uploadTotal: 1e8,
                memory: 1e8,
                connections: [
                  ...activeConnections.map((connection) => ({
                    ...connection,
                    download: connection.download + tick * 1000,
                    upload: connection.upload + tick * 100,
                  })),
                  ...syntheticSpeedtestConnection(),
                ],
              }),
            ),
          )
        } else if (pathname.startsWith('/traffic')) {
          socket.write(websocketFrame(JSON.stringify({ up: 1e6, down: 5e6 })))
        } else if (pathname.startsWith('/memory')) {
          socket.write(websocketFrame(JSON.stringify({ inuse: 1e8, oslimit: 0 })))
        }
      } catch {
        clearInterval(timer)
      }
    }, 1000)

    socket.on('close', () => clearInterval(timer))
    socket.on('error', () => clearInterval(timer))
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))

  const actualPort = server.address().port

  return {
    ...fixture,
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    close: () =>
      new Promise((resolve) => {
        serverSpeedtestClearTimers()
        for (const socket of liveSockets) socket.destroy()
        liveSockets.clear()
        server.closeAllConnections?.()
        server.close(resolve)
      }),
  }
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())

if (isDirectRun) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '9999' },
      groups: { type: 'string', default: '150' },
      nodes: { type: 'string', default: '60' },
      conns: { type: 'string', default: '300' },
    },
  })
  const mock = await createMockServer({
    port: Number(values.port),
    groups: Number(values.groups),
    nodes: Number(values.nodes),
    connections: Number(values.conns),
  })

  console.log(
    `mock clash api → ${mock.url}  (groups=${values.groups} nodes=${values.nodes} conns=${values.conns})`,
  )
}
