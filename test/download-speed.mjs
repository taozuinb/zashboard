/*
 * 下载测速 + 按速度选取的端到端回归。
 *
 *   pnpm build && node test/download-speed.mjs
 *
 * 面板的「下载测速」是纯前端做的:临时逐个切换组内节点,浏览器真的去下载测速文件量吞吐,
 * 结果缓存下来,最后自动选中最快的那个。这条链路跨了「前端切换节点(PUT /proxies)」
 * 「浏览器下载」「/connections 路由校验」三块,任何一块悄悄失效都不会报错,只会结论不对,
 * 所以这里造一个速度可控的现场把它整个盯住:
 *
 *   1. mock 的 /__speedtest 按「被测组当前选中的节点」给不同的每块延迟 → Node-001 最快;
 *   2. 点组头上的测速入口后,轮询假后端的 /proxies,确认 now 真的变成 Node-001;
 *   3. 节点卡上出现速度文本,且按速度降序排序时最快节点排最前;
 *   4. 关掉合成连接(路由校验必然失败)后重新测速:弹错误提示,且当前选择不被改掉。
 *
 * 脚本跑的是 dist/,别忘了先 pnpm build。
 */
import { parseArgs } from 'node:util'
import { sleep, waitFor } from './lib/cdp.mjs'
import { startHarness } from './lib/harness.mjs'

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    headful: { type: 'boolean', default: false },
  },
})

const TARGET_GROUP = 'Group-000'
// 组内节点名是 mock 造的「Node-00N 🇭🇰」,断言时只比前一段,免得被 emoji 或加壳格式绊住
const FASTEST_NODE = 'Node-001'
// 每块 128KB,每块之间等 delay;这几个值拉开差距,Node-001 才稳定最快
const NODE_DELAYS_SHORT = {
  'Node-000': 120,
  'Node-001': 10,
  'Node-002': 60,
  DIRECT: 200,
}
/*
 * 引擎做路由校验时会顶着响应头最多 hold 4.5s 先不读 body,等 /connections 的推送里出现
 * 「host == 测速 URL 主机 && chains 含被测组+被测节点」的连接。假后端的合成连接是每个 WS
 * tick(1s)推一次,所以文件要大到第一次推送时连接还在写:1MB 在 Node-000 上 ~960ms 就写完了,
 * 窗口太窄。4MB 下各节点延迟不变,算出来的 bps 不变。
 */
const DOWNLOAD_BYTES = 4 * 1024 * 1024

const results = []

const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
}

const section = (title) => console.log(`\n${title}`)

const shortName = (name) => String(name ?? '').split(' ')[0]

const harness = await startHarness({
  groups: 2,
  nodes: 3,
  connections: 0,
  appUrl: values.url,
  headless: !values.headful,
})

// 完整节点名(带 emoji)才是后端里真正的值;control 里用完整名配延迟
const nodeNames = harness.mock.nodeNames
const speedtestNodeDelay = Object.fromEntries(
  Object.entries(NODE_DELAYS_SHORT).map(([short, delay]) => {
    const fullName = nodeNames.find((name) => shortName(name) === short)

    return [fullName ?? short, delay]
  }),
)

const mockJson = (path, init) =>
  fetch(`${harness.mock.url}${path}`, init).then((response) => response.json())
const selectedInGroup = async (groupName) =>
  (await mockJson('/proxies')).proxies?.[groupName]?.now ?? ''

let page

try {
  section('准备现场')
  await harness.setMockControl({
    stableLatency: true,
    speedtestRouteGroup: TARGET_GROUP,
    syntheticSpeedtestConnection: true,
    speedtestNodeDelay,
  })

  page = await harness.openProxiesPage({
    settings: {
      'config/download-speedtest-url': `${harness.mock.url}/__speedtest?bytes=${DOWNLOAD_BYTES}`,
      'config/download-speedtest-timeout': '5000',
      'config/download-speedtest-auto-select': 'true',
      'config/download-speedtest-skip-route-check': 'false',
    },
  })

  await page.waitForCards(1)
  await sleep(1000)

  const groupSelector = `[data-group-name="${TARGET_GROUP}"]`
  const nodeCardSelector = `${groupSelector} [data-node-name]`
  const speedTagSelector = `${groupSelector} .download-speed-tag`

  const nodeCards = () =>
    page.evaluateJson(
      `JSON.stringify([...document.querySelectorAll(${JSON.stringify(nodeCardSelector)})].map((el) => el.dataset.nodeName))`,
    )

  // 节点头部收着的时候节点卡不挂载,先展开;已经展开就别再点(点了会收起来)
  const expandTargetGroup = async () => {
    if ((await nodeCards()).length >= nodeNames.length) return

    const headerSelector = `${groupSelector} .collapse-motion-header`
    const openSelector = `${groupSelector} .collapse-motion-open`
    const headerReady = await waitFor(
      () => page.evaluate(`Boolean(document.querySelector(${JSON.stringify(headerSelector)}))`),
      { timeout: 20000 },
    )

    if (headerReady === null) throw new Error(`找不到 ${TARGET_GROUP} 的分组头:${headerSelector}`)

    const isOpen = await page.evaluate(
      `Boolean(document.querySelector(${JSON.stringify(openSelector)}))`,
    )

    if (!isOpen) {
      await page.clickSelector(headerSelector, { dx: 60, dy: 12 })
      await sleep(500)
    }

    const cardsReady = await waitFor(async () => (await nodeCards()).length >= nodeNames.length, {
      timeout: 20000,
    })

    if (cardsReady === null)
      throw new Error(
        `展开 ${TARGET_GROUP} 后没看到带 data-node-name 的节点卡(ui 契约改了吗?):${JSON.stringify(await nodeCards())}`,
      )
  }

  const clickDownloadTest = async () => {
    const ready = await waitFor(
      () => page.evaluate(`Boolean(document.querySelector(${JSON.stringify(speedTagSelector)}))`),
      { timeout: 20000 },
    )

    if (ready === null) return false

    await page.clickSelector(speedTagSelector)

    return true
  }

  const fastestCardText = () =>
    page.evaluate(`(() => {
      const card = [...document.querySelectorAll(${JSON.stringify(nodeCardSelector)})].find(
        (el) => (el.dataset.nodeName ?? '').split(' ')[0] === ${JSON.stringify(FASTEST_NODE)},
      )
      return card ? card.innerText : ''
    })()`)

  section('下载测速并自动选中最快节点')
  await expandTargetGroup()

  const tagReady = await clickDownloadTest()

  check('分组头有下载测速入口', tagReady, tagReady ? '' : `找不到 ${speedTagSelector}`)

  let lastSelected = ''
  const autoSelected = tagReady
    ? await waitFor(
        async () => {
          lastSelected = await selectedInGroup(TARGET_GROUP)
          /*
           * 引擎每测一个节点都会把它临时切过去,只盯 now 会在「刚要测 Node-001」时就误判成结束;
           * 成功 toast 只在整轮测速收尾时出现,拿它当终点,最终选择与速度缓存才都落定了。
           */
          const finishedToast = await page.evaluate(
            `Boolean(document.querySelector('.app-toast[data-toast-type="success"]'))`,
          )

          return finishedToast && shortName(lastSelected) === FASTEST_NODE
        },
        { timeout: 90000, interval: 300 },
      )
    : null

  check(
    '测速结束后自动选中最快节点',
    autoSelected !== null,
    autoSelected !== null
      ? `${shortName(lastSelected)} 用时 ${(autoSelected / 1000).toFixed(1)}s`
      : `90s 内没有测速结束、now 也没停在 ${FASTEST_NODE},最后是 ${lastSelected || '(空)'}`,
  )

  // 等 useStorage 把速度表写进 localStorage:下一段的排序要刷新页面,靠的就是它
  await sleep(800)

  let lastCardText = ''
  const speedShown = await waitFor(
    async () => {
      lastCardText = await fastestCardText()

      return lastCardText.includes('/s')
    },
    { timeout: 20000, interval: 250 },
  )

  check(
    '节点卡显示下载速度',
    speedShown !== null,
    speedShown !== null
      ? lastCardText.replace(/\n/g, ' | ').slice(0, 120)
      : `卡片文本里没有 /s:${lastCardText.replace(/\n/g, ' | ').slice(0, 120) || '(空)'}`,
  )

  section('按下载速度排序')
  await page.evaluate(`localStorage.setItem('config/proxy-sort-type', 'speeddesc')`)
  await page.reload()

  const reloaded = await waitFor(
    () =>
      page.evaluate(
        `Boolean(document.querySelector('.overflow-y-scroll')) && location.hash.includes('proxies')`,
      ),
    { timeout: 30000, interval: 200 },
  )

  if (reloaded === null) throw new Error('刷新后代理页没能起来')

  await page.waitForCards(1)
  await sleep(1000)
  await expandTargetGroup()

  const sortedCards = await nodeCards()
  // DIRECT / REJECT 在现有排序里被当成「组」排到最前,所以只在组内节点之间比先后
  const sortedNodes = sortedCards.filter((name) => shortName(name).startsWith('Node-'))
  const fastestFirst = shortName(sortedNodes[0]) === FASTEST_NODE

  check(
    '按速度降序时最快节点排最前',
    fastestFirst,
    sortedNodes.length
      ? `节点顺序:${sortedNodes.join(' / ')}(全部:${sortedCards.join(' / ')})`
      : '(没有节点卡)',
  )

  section('路由校验失败时中止且不改选择')
  // 关掉合成连接:引擎在 /connections 里找不到「经过被测组」的流量,路由校验必然失败
  await harness.setMockControl({ syntheticSpeedtestConnection: false })
  await page.reload()

  const reloadedForSafety = await waitFor(
    () =>
      page.evaluate(
        `Boolean(document.querySelector('.overflow-y-scroll')) && location.hash.includes('proxies')`,
      ),
    { timeout: 30000, interval: 200 },
  )

  if (reloadedForSafety === null) throw new Error('安全路径测试前刷新代理页失败')

  await page.waitForCards(1)
  await sleep(1000)

  const selectedBefore = await selectedInGroup(TARGET_GROUP)

  check(
    '前提:当前选择仍是最快节点',
    shortName(selectedBefore) === FASTEST_NODE,
    selectedBefore || '(空)',
  )

  const safetyTagReady = await clickDownloadTest()
  const errorToast = safetyTagReady
    ? await waitFor(
        () =>
          page.evaluate(`Boolean(document.querySelector('.app-toast[data-toast-type="error"]'))`),
        { timeout: 30000, interval: 200 },
      )
    : null

  check(
    '路由校验失败会弹出错误提示',
    errorToast !== null,
    errorToast !== null ? '出现 .app-toast[data-toast-type="error"]' : '30s 内没有错误 toast',
  )

  // 给引擎留出「把临时切过去的节点恢复回来」的时间,再断言选择没被改掉
  await sleep(3000)

  const selectedAfter = await selectedInGroup(TARGET_GROUP)

  check(
    '路由校验失败不改变当前选择',
    selectedAfter === selectedBefore,
    `${selectedBefore || '(空)'} → ${selectedAfter || '(空)'}`,
  )
} catch (error) {
  check('脚本执行完毕', false, error?.message ?? String(error))
} finally {
  await harness.close()
}

const failed = results.filter((result) => !result.ok)

console.log(`\n${results.length - failed.length}/${results.length} 项通过`)

if (failed.length) {
  process.exitCode = 1
}
