import { measureDownloadSpeedAPI, type DownloadSpeedResult } from '@/api/latency'
import {
  connectNodeSpeedTestAPI,
  fetchNodeSpeedTestStateAPI,
  NodeSpeedTestApiError,
  startNodeSpeedTestTaskAPI,
  stopNodeSpeedTestTaskAPI,
  type NodeSpeedTestTask,
} from '@/api/node-speed-test'
import { can } from '@/assembly/backend'
import { activeConnections, connectionAccessor, disconnectById } from '@/assembly/connections'
import { driver } from '@/assembly/driver'
import { useStorage } from '@/composables/use-storage'
import { DOWNLOAD_SPEEDTEST_SERVER_PROXY_URL, DOWNLOAD_SPEEDTEST_URL, PROXY_TYPE } from '@/constant'
import { showNotification } from '@/helper/notification'
import { getUrlFromBackend, prettyBytesHelper } from '@/helper/utils'
import {
  automaticDisconnection,
  downloadSpeedtestAutoSelect,
  downloadSpeedtestServerDuration,
  downloadSpeedtestServerMaxMB,
  downloadSpeedtestServerProxy,
  downloadSpeedtestServerUrl,
  downloadSpeedtestSkipRouteCheck,
  downloadSpeedtestTimeout,
  downloadSpeedtestUrl,
} from '@/store/settings'
import { activeBackend } from '@/store/setup'
import { computed, ref, watch } from 'vue'
import { fetchProxies } from './actions'
import { isLatencyTestable, proxyMap } from './state'

export type DownloadSpeedRecord = {
  bps: number
  bytes: number
  durationMs: number
  time: number
  url: string
}

export const downloadSpeedMap = useStorage<Record<string, DownloadSpeedRecord>>(
  'cache/proxy-download-speed-map',
  {},
)

export type DownloadSpeedTestPhase = 'testing' | 'selecting' | 'done' | 'aborted' | 'failed'

export type DownloadSpeedTestState = {
  groupName: string
  phase: DownloadSpeedTestPhase
  mode?: 'local' | 'server'
  total: number
  done: number
  currentNode: string
  fastest?: string
  speed?: number
}

export const downloadSpeedTestState = ref<DownloadSpeedTestState | null>(null)

export const isDownloadSpeedTesting = computed(() => {
  const phase = downloadSpeedTestState.value?.phase

  return phase === 'testing' || phase === 'selecting'
})

// 换测速地址后旧结果没有可比性,直接清空缓存
watch(downloadSpeedtestUrl, () => {
  downloadSpeedMap.value = {}
})

export const getDownloadSpeedByName = (name?: string) => {
  if (!name) return 0

  return downloadSpeedMap.value[name]?.bps ?? 0
}

// 只有能手动选成员的分组才谈得上“按速度选取”,负载均衡组不可选
export const isDownloadSpeedTestableGroup = (groupName: string) => {
  const group = proxyMap.value[groupName]

  if (!group?.all?.length) return false
  if (group.type.toLowerCase() === PROXY_TYPE.LoadBalance) return false
  if (group.selectable === false) return false

  return can('downloadSpeedTest')
}

const ROUTE_CHECK_TIMEOUT = 4500
const ROUTE_CHECK_INTERVAL = 250
const SELECT_SETTLE_MS = 150
const MEASURE_DURATION_MS = 2500
const STATE_KEEP_MS = 5000
const TIP_KEY = 'downloadSpeedtest'
const ROUTE_UNVERIFIED = 'download-speedtest-route-unverified'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const autoTestGroupTypes = new Set<string>([
  PROXY_TYPE.Smart,
  PROXY_TYPE.URLTest,
  PROXY_TYPE.Fallback,
])

/*
 * 下载测速的请求是浏览器直接发出的,只有浏览器流量经过内核时才会走被测节点。
 * 内核的 /connections 里能看到连接链路,这里在读完之前保持连接打开并轮询,
 * 确认链路里同时有被测分组和被测节点,否则测出来的只是直连速度。
 */
const waitForRoute = (
  groupName: string,
  nodeName: string,
  hostname: string,
  signal: AbortSignal,
) => {
  return new Promise<boolean>((resolve) => {
    const accessor = connectionAccessor()

    const cleanup = (value: boolean) => {
      clearInterval(timer)
      clearTimeout(deadline)
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }

    const check = () => {
      const matched = activeConnections.value.some((connection) => {
        if (accessor.hostname(connection) !== hostname) return false

        const chains = accessor.chains(connection)

        return chains.includes(groupName) && chains.includes(nodeName)
      })

      if (matched) cleanup(true)
    }

    const onAbort = () => cleanup(false)
    const timer = setInterval(check, ROUTE_CHECK_INTERVAL)
    const deadline = setTimeout(() => cleanup(false), ROUTE_CHECK_TIMEOUT)

    signal.addEventListener('abort', onAbort, { once: true })
    check()
  })
}

const selectGroupMember = async (groupName: string, nodeName: string) => {
  await driver().proxies.select(groupName, nodeName)

  const group = proxyMap.value[groupName]

  if (group) group.now = nodeName

  await sleep(SELECT_SETTLE_MS)
}

const restoreSelection = async (
  groupName: string,
  previousName: string,
  hadFixed: boolean,
  clearFixed: boolean,
) => {
  try {
    if (!clearFixed && previousName) {
      await selectGroupMember(groupName, previousName)
      return
    }

    if (hadFixed && previousName) {
      await selectGroupMember(groupName, previousName)
      return
    }

    await driver().proxies.clearFixed(groupName)
  } catch {
    // 恢复失败不影响已经测得的结果,下一次 fetchProxies 会带回内核真实状态
  }
}

const notify = (
  groupName: string,
  content: string,
  params: Record<string, string>,
  type: 'alert-info' | 'alert-success' | 'alert-warning' | 'alert-error',
  timeout: number,
) => {
  showNotification({
    content,
    key: `${TIP_KEY}:${groupName}`,
    params,
    type,
    timeout,
  })
}

const keepStateForAWhile = (groupName: string) => {
  setTimeout(() => {
    const state = downloadSpeedTestState.value

    if (
      state?.groupName === groupName &&
      (state.phase === 'done' || state.phase === 'failed' || state.phase === 'aborted')
    ) {
      downloadSpeedTestState.value = null
    }
  }, STATE_KEEP_MS)
}

let activeController: AbortController | null = null

let serverTaskRunning = false
let serverCancelRequested = false

export const cancelDownloadSpeedTest = () => {
  if (serverTaskRunning) {
    serverCancelRequested = true
    return
  }

  activeController?.abort()
}

export const proxyGroupDownloadSpeedTest = async (groupName: string) => {
  if (!can('downloadSpeedTest') || activeController) return

  const group = proxyMap.value[groupName]

  if (!group || !isDownloadSpeedTestableGroup(groupName)) return

  const candidates = (group.all ?? []).filter((name) => {
    const node = proxyMap.value[name]

    return Boolean(node) && isLatencyTestable(name) && node.selectable !== false
  })

  if (!candidates.length) return

  let targetUrl: URL

  try {
    // 允许相对路径:把测速文件放在面板同源服务器上也是一种用法
    targetUrl = new URL(downloadSpeedtestUrl.value.trim(), window.location.href)
  } catch {
    notify(groupName, 'downloadSpeedtestFailedTip', { name: groupName }, 'alert-error', 5000)
    return
  }

  const url = targetUrl.href
  const hostname = targetUrl.hostname
  const previousName = group.now
  // 先测当前选中的节点:环境不支持(如局域网直连面板)时,路由校验会在第一次就中止,
  // 这样还没动过任何选择,不会让用户看到节点被临时切走
  const orderedCandidates =
    previousName && candidates.includes(previousName)
      ? [previousName, ...candidates.filter((name) => name !== previousName)]
      : candidates
  const hadFixed = Boolean(group.fixed)
  const shouldClearFixed =
    !hadFixed && autoTestGroupTypes.has(group.type.toLowerCase() as PROXY_TYPE)
  const timeout = Math.max(1000, downloadSpeedtestTimeout.value)
  const skipRouteCheck = downloadSpeedtestSkipRouteCheck.value
  const total = orderedCandidates.length

  const previousAutoDisconnect = automaticDisconnection.value
  const controller = new AbortController()

  activeController = controller
  automaticDisconnection.value = false

  downloadSpeedTestState.value = {
    groupName,
    phase: 'testing',
    mode: 'local',
    total,
    done: 0,
    currentNode: '',
  }

  const measured: Record<string, DownloadSpeedResult> = {}
  let routeVerified = skipRouteCheck
  let routeFailed = false

  try {
    for (const nodeName of orderedCandidates) {
      if (controller.signal.aborted) break

      downloadSpeedTestState.value = {
        ...downloadSpeedTestState.value!,
        currentNode: nodeName,
      }

      const needsRouteCheck = !routeVerified

      try {
        await selectGroupMember(groupName, nodeName)

        const result = await measureDownloadSpeedAPI(url, {
          timeout: timeout + (needsRouteCheck ? ROUTE_CHECK_TIMEOUT + 1000 : 0),
          maxDurationMs: Math.min(timeout, MEASURE_DURATION_MS),
          signal: controller.signal,
          onResponse: needsRouteCheck
            ? async () => {
                const verified = await waitForRoute(
                  groupName,
                  nodeName,
                  hostname,
                  controller.signal,
                )

                if (!verified) throw new Error(ROUTE_UNVERIFIED)
              }
            : undefined,
        })

        if (needsRouteCheck) routeVerified = true
        measured[nodeName] = result

        if (result.bytes > 0) {
          downloadSpeedMap.value[nodeName] = {
            bps: result.bps,
            bytes: result.bytes,
            durationMs: result.durationMs,
            time: Date.now(),
            url,
          }
        }
      } catch (e) {
        if (controller.signal.aborted) break

        if (e instanceof Error && e.message === ROUTE_UNVERIFIED) {
          routeFailed = true
          break
        }

        // 单个节点失败算 0,继续测下一个
      }

      const state: DownloadSpeedTestState = downloadSpeedTestState.value!

      downloadSpeedTestState.value = { ...state, done: state.done + 1 }

      notify(
        groupName,
        'downloadSpeedtestRunningTip',
        {
          name: groupName,
          node: nodeName,
          done: `${state.done + 1}`,
          total: `${total}`,
        },
        'alert-info',
        0,
      )
    }

    let fastest = ''

    for (const [nodeName, result] of Object.entries(measured)) {
      if (result.bytes > 0 && (!fastest || result.bps > measured[fastest].bps)) {
        fastest = nodeName
      }
    }

    if (routeFailed) {
      downloadSpeedTestState.value = { ...downloadSpeedTestState.value!, phase: 'aborted' }
      await restoreSelection(groupName, previousName, hadFixed, shouldClearFixed)
      notify(
        groupName,
        'downloadSpeedtestRouteUnverifiedTip',
        { name: groupName },
        'alert-error',
        10000,
      )
      keepStateForAWhile(groupName)
      return
    }

    if (controller.signal.aborted) {
      downloadSpeedTestState.value = { ...downloadSpeedTestState.value!, phase: 'aborted' }
      await restoreSelection(groupName, previousName, hadFixed, shouldClearFixed)
      notify(groupName, 'downloadSpeedtestCanceledTip', { name: groupName }, 'alert-warning', 4000)
      keepStateForAWhile(groupName)
      return
    }

    if (!fastest) {
      downloadSpeedTestState.value = { ...downloadSpeedTestState.value!, phase: 'failed' }
      await restoreSelection(groupName, previousName, hadFixed, shouldClearFixed)
      notify(groupName, 'downloadSpeedtestFailedTip', { name: groupName }, 'alert-error', 6000)
      keepStateForAWhile(groupName)
      return
    }

    const fastestBps = measured[fastest].bps

    downloadSpeedTestState.value = {
      ...downloadSpeedTestState.value!,
      phase: downloadSpeedtestAutoSelect.value ? 'selecting' : 'done',
      fastest,
      speed: fastestBps,
    }

    if (downloadSpeedtestAutoSelect.value) {
      await selectGroupMember(groupName, fastest)

      // 测速期间关掉了“自动断开”,但最终选中是新选择,按原设置让旧连接重新走新节点
      if (previousAutoDisconnect) {
        activeConnections.value
          .filter((connection) => connectionAccessor().chains(connection).includes(groupName))
          .forEach((connection) => disconnectById(connection.id).catch(() => {}))
      }
    } else {
      await restoreSelection(groupName, previousName, hadFixed, shouldClearFixed)
    }

    downloadSpeedTestState.value = { ...downloadSpeedTestState.value!, phase: 'done' }

    notify(
      groupName,
      'downloadSpeedtestFinishedTip',
      {
        name: groupName,
        node: fastest,
        speed: `${prettyBytesHelper(fastestBps)}/s`,
      },
      'alert-success',
      6000,
    )
    keepStateForAWhile(groupName)
  } catch {
    downloadSpeedTestState.value = { ...downloadSpeedTestState.value!, phase: 'failed' }
    await restoreSelection(groupName, previousName, hadFixed, shouldClearFixed)
    notify(groupName, 'downloadSpeedtestFailedTip', { name: groupName }, 'alert-error', 6000)
    keepStateForAWhile(groupName)
  } finally {
    automaticDisconnection.value = previousAutoDisconnect
    activeController = null
    await fetchProxies().catch(() => {})
  }
}

const SERVER_POLL_INTERVAL_MS = 1000
const SERVER_TIMEOUT_SECONDS = 5
const SERVER_MAX_DURATION_SECONDS = 120
const SERVER_MAX_MB = 1024
const SERVER_TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed'])

export const pendingServerDownloadTestGroup = ref<string | null>(null)

export const isServerSpeedTestConfigured = computed(
  () => can('speedTestServer') && Boolean(downloadSpeedtestServerUrl.value.trim()),
)

const clampSetting = (value: number, min: number, max: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback

  return Math.min(max, Math.max(min, value))
}

// 服务端的下载 URL 必须是绝对 http(s) 地址,相对路径按默认测速地址处理
const resolveServerTestUrl = () => {
  const value = downloadSpeedtestUrl.value.trim()

  try {
    return new URL(value, window.location.href).href
  } catch {
    return DOWNLOAD_SPEEDTEST_URL
  }
}

const applyServerTaskResults = (task: NodeSpeedTestTask, url: string) => {
  for (const result of task.results ?? []) {
    if (result.status !== 'success') continue
    if (typeof result.speed_bps !== 'number' || result.speed_bps <= 0) continue

    downloadSpeedMap.value[result.name] = {
      bps: result.speed_bps,
      bytes: result.bytes_received ?? 0,
      durationMs: result.elapsed && result.elapsed > 0 ? Math.round(result.elapsed * 1000) : 0,
      time: Date.now(),
      url,
    }
  }
}

const notifyServer = (
  groupName: string,
  content: string,
  params: Record<string, string> = {},
  type: 'alert-info' | 'alert-success' | 'alert-warning' | 'alert-error' = 'alert-error',
  timeout = 8000,
) => {
  showNotification({
    content,
    key: `${TIP_KEY}:${groupName}`,
    params,
    type,
    timeout,
  })
}

/*
 * 服务端测速:浏览器只负责调 node_speed_test 的 HTTP API 并轮询进度。
 * 真正的下载由服务端通过内核 mixed-port 完成,所以局域网直连访问面板时也能测。
 */
const runServerDownloadSpeedTest = async (groupName: string) => {
  if (!can('speedTestServer') || serverTaskRunning) return

  const baseUrl = downloadSpeedtestServerUrl.value.trim()

  if (!baseUrl || !isDownloadSpeedTestableGroup(groupName)) return

  const backend = activeBackend.value

  if (!backend || backend.type !== 'clash') {
    notifyServer(groupName, 'downloadSpeedtestServerUnavailableTip')
    return
  }

  const url = resolveServerTestUrl()
  const proxyUrl = downloadSpeedtestServerProxy.value.trim() || DOWNLOAD_SPEEDTEST_SERVER_PROXY_URL
  const duration = clampSetting(
    Number(downloadSpeedtestServerDuration.value),
    0.1,
    SERVER_MAX_DURATION_SECONDS,
    3,
  )
  const maxBytes = Math.round(
    clampSetting(Number(downloadSpeedtestServerMaxMB.value), 1, SERVER_MAX_MB, 20) * 1024 * 1024,
  )

  serverTaskRunning = true
  serverCancelRequested = false

  downloadSpeedTestState.value = {
    groupName,
    phase: 'testing',
    mode: 'server',
    total: 0,
    done: 0,
    currentNode: '',
  }

  let taskId = ''
  let latestTask: NodeSpeedTestTask | null = null
  let cancelled = false
  let publishedDone = -1
  let pollCount = 0

  try {
    const connection = await connectNodeSpeedTestAPI(baseUrl, {
      controller: getUrlFromBackend(backend),
      proxy: proxyUrl,
      secret: backend.password || undefined,
    })
    const target = connection.groups?.find((group) => group.name === groupName)

    if (!target || !target.available) {
      downloadSpeedTestState.value = { ...downloadSpeedTestState.value!, phase: 'failed' }
      notifyServer(groupName, 'downloadSpeedtestServerGroupUnavailableTip', {
        reason: target?.reason || '',
      })
      keepStateForAWhile(groupName)
      return
    }

    const startedTask = await startNodeSpeedTestTaskAPI(baseUrl, {
      connection_id: connection.id,
      group: target.id,
      route_confirmed: true,
      url,
      duration,
      max_bytes: maxBytes,
      timeout: SERVER_TIMEOUT_SECONDS,
      auto_select: downloadSpeedtestAutoSelect.value,
    })

    taskId = startedTask.id
    latestTask = startedTask

    downloadSpeedTestState.value = {
      ...downloadSpeedTestState.value!,
      total: startedTask.candidate_total || startedTask.total || 0,
    }

    for (;;) {
      await sleep(SERVER_POLL_INTERVAL_MS)

      const snapshot = await fetchNodeSpeedTestStateAPI(baseUrl)
      const task = snapshot.task

      if (!task || (taskId && task.id !== taskId)) continue

      latestTask = task

      const state: DownloadSpeedTestState = downloadSpeedTestState.value!

      downloadSpeedTestState.value = {
        ...state,
        total: task.total || task.candidate_total || state.total,
        done: task.completed,
        currentNode: task.current_node ?? '',
      }

      applyServerTaskResults(task, url)

      if (publishedDone !== task.completed) {
        publishedDone = task.completed
        notifyServer(
          groupName,
          'downloadSpeedtestRunningTip',
          {
            name: groupName,
            node: task.current_node ?? '',
            done: `${task.completed}`,
            total: `${task.total || task.candidate_total || state.total}`,
          },
          'alert-info',
          0,
        )
      }

      if (serverCancelRequested && !cancelled) {
        cancelled = true
        stopNodeSpeedTestTaskAPI(baseUrl, task.id).catch(() => {})
      }

      pollCount++

      // 服务端在切换节点,隔一次轮询同步一下面板上的当前选择
      if (pollCount % 2 === 0) fetchProxies().catch(() => {})

      if (SERVER_TERMINAL_STATUSES.has(task.status)) break
    }

    if (latestTask) {
      applyServerTaskResults(latestTask, url)

      downloadSpeedTestState.value = {
        ...downloadSpeedTestState.value!,
        total:
          latestTask.total || latestTask.candidate_total || downloadSpeedTestState.value!.total,
        done: latestTask.completed,
      }
    }

    if (cancelled || latestTask?.status === 'cancelled') {
      downloadSpeedTestState.value = { ...downloadSpeedTestState.value!, phase: 'aborted' }
      notifyServer(groupName, 'downloadSpeedtestCanceledTip', {}, 'alert-warning', 4000)
      keepStateForAWhile(groupName)
      return
    }

    if (latestTask?.status === 'failed') {
      downloadSpeedTestState.value = { ...downloadSpeedTestState.value!, phase: 'failed' }
      notifyServer(groupName, 'downloadSpeedtestServerFailedTip', {
        name: groupName,
        message: latestTask.error || '',
      })
      keepStateForAWhile(groupName)
      return
    }

    const fastest = latestTask?.top?.[0]?.name ?? latestTask?.selected_node ?? ''
    const fastestBps = latestTask?.top?.[0]?.speed_bps ?? 0

    downloadSpeedTestState.value = {
      ...downloadSpeedTestState.value!,
      phase: 'done',
      fastest: fastest || undefined,
      speed: fastestBps || undefined,
    }

    notifyServer(
      groupName,
      'downloadSpeedtestFinishedTip',
      {
        name: groupName,
        node: fastest || latestTask?.selected_node || '',
        speed: fastestBps ? `${prettyBytesHelper(fastestBps)}/s` : '',
      },
      'alert-success',
      6000,
    )
    keepStateForAWhile(groupName)
  } catch (error) {
    downloadSpeedTestState.value = { ...downloadSpeedTestState.value!, phase: 'failed' }

    if (error instanceof NodeSpeedTestApiError) {
      if (error.status === 403) {
        notifyServer(groupName, 'downloadSpeedtestServerForbiddenTip')
      } else if (error.status === 409) {
        notifyServer(groupName, 'downloadSpeedtestServerBusyTip')
      } else if (error.status === 422) {
        notifyServer(groupName, 'downloadSpeedtestServerFailedTip', {
          name: groupName,
          message: error.message,
        })
      } else {
        notifyServer(groupName, 'downloadSpeedtestServerUnavailableTip')
      }
    } else {
      notifyServer(groupName, 'downloadSpeedtestServerUnavailableTip')
    }

    keepStateForAWhile(groupName)
  } finally {
    serverTaskRunning = false
    serverCancelRequested = false
    await fetchProxies().catch(() => {})
  }
}

export const dismissPendingServerDownloadTest = () => {
  pendingServerDownloadTestGroup.value = null
}

export const startPendingServerDownloadTest = async () => {
  const groupName = pendingServerDownloadTestGroup.value

  pendingServerDownloadTestGroup.value = null

  if (groupName) await runServerDownloadSpeedTest(groupName)
}

export const requestDownloadSpeedTest = async (groupName: string) => {
  const state = downloadSpeedTestState.value
  const running = state?.phase === 'testing' || state?.phase === 'selecting'

  if (running) {
    if (state?.groupName === groupName) cancelDownloadSpeedTest()
    return
  }

  if (isServerSpeedTestConfigured.value) {
    pendingServerDownloadTestGroup.value = groupName
    return
  }

  await proxyGroupDownloadSpeedTest(groupName)
}
