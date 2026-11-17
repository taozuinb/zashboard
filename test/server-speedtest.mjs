/*
 * 「服务端测速」模式的端到端回归。
 *
 *   pnpm build && node test/server-speedtest.mjs
 *
 * 与前端直接下载测速不同,服务端模式把测速交给外部 node_speed_test 服务:zashboard 建连接、
 * 让用户确认测速流量走该分组,再轮询服务端任务状态,服务端测完自动选中最快节点。
 * 这条链路几乎全在「前端 ↔ 外部服务」的接口契约上,任何字段/时序对不上都不会报错,
 * 只会测不出来或选错节点,所以这里起一个自己的假服务(test/mock-server.mjs 的 /node-speed/*)
 * 把它整条盯住:
 *
 *   1. 点组头测速入口 → 弹确认弹窗 → 点开始;
 *   2. 假服务每 250ms 测完一个节点(Node-001 最快),节点卡出现服务端测出的速度;
 *   3. 任务完成 auto_select 后,假后端 /proxies 里该组的 now 变成 Node-001,并弹成功 toast;
 *   4. 按速度降序排序时最快节点排最前;
 *   5. 假服务返回 403(跨来源被拒)时弹错误提示,且当前选择不被改掉。
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
const CONFIRM_DIALOG = '.download-speedtest-confirm-dialog'
const CONFIRM_START = '.download-speedtest-confirm-start'
const SPEEDTEST_URL = 'https://example.com/test.bin'
// 假服务里 Node-001 是 12MB/s,节点卡显示成 "12.6 MB/s" 这种;用 MB/s 而不是只认 /s,
// 免得把卡上本来就有的其它单位文本当成测速结果
const SPEED_TEXT = /MB\/s/

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

const nodeNames = harness.mock.nodeNames

const mockJson = (path, init) =>
  fetch(`${harness.mock.url}${path}`, init).then((response) => response.json())
const selectedInGroup = async (groupName) =>
  (await mockJson('/proxies')).proxies?.[groupName]?.now ?? ''

// 失败时把假服务那边的任务状态带出来,好判断是「前端没发出任务」还是「任务跑完了但 UI 没反应」
const serverTaskSummary = async () => {
  try {
    const state = await mockJson('/node-speed/api/state')
    const task = state?.task

    if (!task) return 'state.task=null(前端可能没发出 /api/tasks)'

    const results = (task.results ?? [])
      .map((result) => `${shortName(result.name)}:${result.status}:${result.speed_bps ?? '-'}`)
      .join(',')

    return `task=${task.status} ${task.completed}/${task.total} selected=${task.selected_node ?? '-'} results=[${results}]`
  } catch (error) {
    return `读 /node-speed/api/state 失败:${error?.message ?? error}`
  }
}

let page

try {
  section('准备现场')
  await harness.setMockControl({ stableLatency: true })

  page = await harness.openProxiesPage({
    settings: {
      // 非空 = 服务端模式;指向 mock 自己的假服务
      'config/download-speedtest-server-url': `${harness.mock.url}/node-speed`,
      'config/download-speedtest-server-proxy': 'http://127.0.0.1:7890',
      'config/download-speedtest-server-duration': '1',
      'config/download-speedtest-server-max-mb': '1',
      'config/download-speedtest-auto-select': 'true',
      'config/download-speedtest-url': SPEEDTEST_URL,
    },
  })

  await page.waitForCards(1)
  await sleep(1000)

  const groupSelector = `[data-group-name="${TARGET_GROUP}"]`
  const nodeCardSelector = `${groupSelector} [data-node-name]`
  const speedTagSelector = `${groupSelector} .download-speed-tag[data-speedtest-group="${TARGET_GROUP}"]`

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

  const waitForSelector = (selector, timeout = 20000) =>
    waitFor(() => page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), {
      timeout,
    })

  const fastestCardText = () =>
    page.evaluate(`(() => {
      const card = [...document.querySelectorAll(${JSON.stringify(nodeCardSelector)})].find(
        (el) => (el.dataset.nodeName ?? '').split(' ')[0] === ${JSON.stringify(FASTEST_NODE)},
      )
      return card ? card.innerText : ''
    })()`)

  const waitPageReady = async (label) => {
    const ready = await waitFor(
      () =>
        page.evaluate(
          `Boolean(document.querySelector('.overflow-y-scroll')) && location.hash.includes('proxies')`,
        ),
      { timeout: 30000, interval: 200 },
    )

    if (ready === null) throw new Error(`${label}后代理页没能起来`)

    await page.waitForCards(1)
    await sleep(1000)
  }

  section('服务端测速:确认弹窗 → 测速 → 自动选中最快')
  await expandTargetGroup()

  const tagReady = await waitForSelector(speedTagSelector)

  check(
    '分组头有下载测速入口',
    tagReady !== null,
    tagReady !== null ? '' : `找不到 ${speedTagSelector}`,
  )

  if (tagReady !== null) await page.clickSelector(speedTagSelector)

  const dialogShown = tagReady !== null ? await waitForSelector(CONFIRM_DIALOG) : null

  check(
    '点击测速入口弹出确认弹窗',
    dialogShown !== null,
    dialogShown !== null ? CONFIRM_DIALOG : `20s 内没有 ${CONFIRM_DIALOG}`,
  )

  const startReady = await waitForSelector(CONFIRM_START, 10000)

  if (startReady !== null) await page.clickSelector(CONFIRM_START)

  check(
    '确认弹窗可以开始测速',
    startReady !== null,
    startReady !== null ? `点了 ${CONFIRM_START}` : `弹窗里没有 ${CONFIRM_START}`,
  )

  let lastFastestText = ''
  const speedShown =
    startReady !== null
      ? await waitFor(
          async () => {
            lastFastestText = await fastestCardText()

            return SPEED_TEXT.test(lastFastestText)
          },
          { timeout: 30000, interval: 300 },
        )
      : null

  check(
    '节点卡显示服务端测出的速度',
    speedShown !== null,
    speedShown !== null
      ? lastFastestText.replace(/\n/g, ' | ').slice(0, 120)
      : `没有 MB/s 文本:${lastFastestText.replace(/\n/g, ' | ').slice(0, 120) || '(空)'};${await serverTaskSummary()}`,
  )

  let lastSelected = ''
  const autoSelected =
    startReady !== null
      ? await waitFor(
          async () => {
            lastSelected = await selectedInGroup(TARGET_GROUP)
            const successToast = await page.evaluate(
              `Boolean(document.querySelector('.app-toast[data-toast-type="success"]'))`,
            )

            return successToast && shortName(lastSelected) === FASTEST_NODE
          },
          { timeout: 90000, interval: 300 },
        )
      : null

  check(
    '服务端自动选中最快节点并弹成功提示',
    autoSelected !== null,
    autoSelected !== null
      ? `${shortName(lastSelected)} 用时 ${(autoSelected / 1000).toFixed(1)}s`
      : `90s 内没有成功 toast、now 也没停在 ${FASTEST_NODE},最后是 ${lastSelected || '(空)'};${await serverTaskSummary()}`,
  )

  // 等服务把速度表写进 localStorage:下一段排序要刷新页面,靠的就是它
  await sleep(800)

  section('按服务端测出的速度排序')
  await page.evaluate(`localStorage.setItem('config/proxy-sort-type', 'speeddesc')`)
  await page.reload()
  await waitPageReady('排序前刷新')
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

  section('服务端拒绝(403)时中止且不改选择')
  // 假服务整体 403:跨来源被拒时前端应弹错误提示,且不许动组当前选择
  await harness.setMockControl({ serverSpeedtestForbidden: true })
  await page.reload()
  await waitPageReady('拒绝场景刷新')

  const selectedBefore = await selectedInGroup(TARGET_GROUP)

  check(
    '前提:当前选择仍是最快节点',
    shortName(selectedBefore) === FASTEST_NODE,
    selectedBefore || '(空)',
  )

  const forbidTagReady = await waitForSelector(speedTagSelector)

  if (forbidTagReady !== null) await page.clickSelector(speedTagSelector)

  const forbidDialog = forbidTagReady !== null ? await waitForSelector(CONFIRM_DIALOG) : null
  const forbidStart = forbidDialog !== null ? await waitForSelector(CONFIRM_START, 10000) : null

  if (forbidStart !== null) await page.clickSelector(CONFIRM_START)

  const errorToast =
    forbidStart !== null
      ? await waitFor(
          () =>
            page.evaluate(`Boolean(document.querySelector('.app-toast[data-toast-type="error"]'))`),
          { timeout: 30000, interval: 200 },
        )
      : null

  check(
    '服务端拒绝时弹出错误提示',
    errorToast !== null,
    errorToast !== null
      ? '出现 .app-toast[data-toast-type="error"]'
      : `30s 内没有错误 toast(入口:${forbidTagReady !== null},弹窗:${forbidDialog !== null},开始:${forbidStart !== null})`,
  )

  // 留出恢复/收尾时间,再断言选择没被改掉
  await sleep(3000)

  const selectedAfter = await selectedInGroup(TARGET_GROUP)

  check(
    '服务端拒绝不改变当前选择',
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
