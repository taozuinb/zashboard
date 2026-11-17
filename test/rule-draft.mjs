/*
 * 规则草稿的行为回归。
 *
 * mihomo 的 REST API 只能读规则(GET /rules)和开关规则(PATCH /rules/disable),没有增删改接口,
 * 所以规则页的「新增 / 修改 / 删除」都落在本地草稿上:改动存 localStorage,导出 YAML 写进配置
 * 才会真正生效。这个脚本确认草稿能改、能存、能导出,而且不会动到内核返回的原列表。
 *
 *   pnpm build && node test/rule-draft.mjs
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

const results = []

const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
}

const section = (title) => console.log(`\n${title}`)

const harness = await startHarness({
  groups: 3,
  nodes: 2,
  connections: 5,
  appUrl: values.url,
  headless: !values.headful,
})

try {
  const page = await harness.openProxiesPage()

  // 抓到页面里抛出的异常：草稿层全是响应式推导，出错时界面只会「看着不对」而不报错
  await page.evaluate(`(() => {
    window.__ruleDraftErrors = []
    window.addEventListener('error', (e) => window.__ruleDraftErrors.push(String(e.message)))
    window.addEventListener('unhandledrejection', (e) =>
      window.__ruleDraftErrors.push('unhandled: ' + String(e.reason)),
    )
  })()`)

  const exists = (selector) =>
    page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)

  const waitExists = (selector, timeout = 15000) =>
    waitFor(async () => await exists(selector), { timeout, interval: 100 })

  const click = async (selector) => {
    const clicked = await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      el.click()
      return true
    })()`)

    if (!clicked) throw new Error(`点不到 ${selector}`)
  }

  const clickRowAction = async (rowIndex, action) => {
    const clicked = await page.evaluate(`(() => {
      const row = document.querySelectorAll('[data-rule-row]')[${rowIndex}]
      if (!row) return false
      const button = row.querySelector('[data-rule-action="${action}"]')
      if (!button) return false
      button.click()
      return true
    })()`)

    if (!clicked) throw new Error(`第 ${rowIndex} 行点不到 ${action}`)
  }

  const fill = async (name, value) => {
    const selector = `input[name="${name}"]`
    const filled = await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, ${JSON.stringify(String(value))})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)

    if (!filled) throw new Error(`填不了 ${selector}`)
  }

  const readRows = () =>
    page.evaluateJson(`JSON.stringify(
      [...document.querySelectorAll('[data-rule-row]')].map((el) => ({
        state: el.dataset.ruleState,
        text: el.innerText.split('\\n').join(' ').replace(/\\s+/g, ' ').trim(),
      })),
    )`)

  const waitRows = (count, timeout = 15000) =>
    waitFor(async () => (await readRows()).length === count, { timeout, interval: 100 })

  const draftCount = () =>
    page.evaluate(`Number(document.querySelector('[data-rule-drafts]')?.dataset.draftCount ?? -1)`)

  const gotoRules = async () => {
    await page.goto(`${harness.app.url}/#/rules`)
    await waitRows(3)
    await sleep(300)
  }

  const addRule = async ({ type, payload, proxy, position }) => {
    await click('[data-rule-draft="add"]')
    await waitExists('[data-rule-editor]')

    if (type) await fill('rule-type', type)
    if (payload) await fill('rule-payload', payload)
    if (proxy) await fill('rule-proxy', proxy)
    if (position) await fill('rule-position', position)

    await click('[data-rule-save]')
  }

  const resetDrafts = async () => {
    await click('[data-rule-draft="reset"]')
    await waitExists('.modal-box .btn-error')
    await click('.modal-box .btn-error')
    await sleep(300)
  }

  section('入口与基线')
  await gotoRules()
  let rows = await readRows()

  check('规则页读到内核规则', rows.length === 3, `${rows.length} 条`)
  check('默认不显示草稿栏', !(await exists('[data-rule-drafts]')))

  await click('[data-rule-edit="toggle"]')
  await waitExists('[data-rule-drafts]')

  check('编辑模式显示草稿栏', await exists('[data-rule-drafts]'))
  check('初始草稿数为 0', (await draftCount()) === 0)

  section('新增')
  await addRule({
    type: 'DOMAIN-SUFFIX',
    payload: 'shop.example.com',
    proxy: 'Group-000',
    position: 1,
  })
  await waitRows(4)
  rows = await readRows()

  check('新增的规则插到指定位置', rows[0].text.includes('shop.example.com'))
  check('新增行带草稿标记', rows[0].state === 'add')
  check('草稿计数为 1', (await draftCount()) === 1)

  section('修改草稿行')
  await clickRowAction(0, 'edit')
  await waitExists('[data-rule-editor]')
  await fill('rule-payload', 'shop2.example.com')
  await click('[data-rule-save]')
  await sleep(300)
  rows = await readRows()

  check(
    '再次编辑草稿行不会重复新增',
    rows.length === 4 && rows[0].text.includes('shop2.example.com'),
  )
  check('草稿计数仍为 1', (await draftCount()) === 1)

  section('删除草稿行')
  await clickRowAction(0, 'remove')
  await waitRows(3)
  rows = await readRows()

  check('删掉新增行后回到内核条数', (await draftCount()) === 0)
  check('新增的规则已从列表消失', !rows.some((row) => row.text.includes('shop2.example.com')))

  section('修改内核规则')
  await clickRowAction(0, 'edit')
  await waitExists('[data-rule-editor]')

  // 内核返回 DomainSuffix,编辑器里要换成配置写法
  const prefilledType = await page.evaluate(`document.querySelector('input[name=rule-type]').value`)
  check('类型按配置写法回填', prefilledType === 'DOMAIN-SUFFIX', prefilledType)

  await fill('rule-proxy', 'DIRECT')
  await click('[data-rule-save]')
  await sleep(300)
  rows = await readRows()

  check('内核规则显示为已修改', rows[0].state === 'update' && rows[0].text.includes('DIRECT'))
  check('原规则仍在列表里', rows[0].text.includes('example.com'))

  section('不需要内容的规则')
  await clickRowAction(2, 'edit')
  await waitExists('[data-rule-editor]')

  const matchType = await page.evaluate(`document.querySelector('input[name=rule-type]').value`)
  const matchPayloadDisabled = await page.evaluate(
    `document.querySelector('input[name=rule-payload]').disabled`,
  )

  check('MATCH 类型回填为 MATCH', matchType === 'MATCH', matchType)
  check('MATCH 的内容框自动禁用', matchPayloadDisabled === true)

  await click('.modal-box [aria-label="close"]')
  await sleep(300)

  section('删除内核规则')
  await clickRowAction(1, 'remove')
  await waitRows(2)
  rows = await readRows()

  check('删除后列表少一条', rows.length === 2 && (await draftCount()) === 2)
  check('被删规则从列表里消失', !rows.some((row) => row.text.includes('GeoIP')))

  await click('[data-draft-kind="delete"] button')
  await waitRows(3)
  check(
    '撤销删除后规则回到列表',
    (await readRows()).some((row) => row.text.includes('GeoIP')),
  )

  await clickRowAction(1, 'remove')
  await waitRows(2)

  section('导出')
  await click('[data-rule-draft="export"]')
  await waitExists('.textarea')

  const yaml = await page.evaluate(`document.querySelector('.textarea').value`)
  const exportedLines = yaml
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))

  check('导出包含修改后的规则', yaml.includes('example.com,DIRECT'))
  check('导出不含已删除的规则', !yaml.includes('GEOIP'))
  check('导出把类型转成配置写法', yaml.includes('DOMAIN-SUFFIX,example.com,DIRECT'))
  check('导出条数与列表一致', exportedLines.length === 2, `${exportedLines.length} 条`)

  await click('.modal-box [aria-label="close"]')
  await sleep(300)

  section('放弃改动')
  await resetDrafts()
  await waitRows(3)
  rows = await readRows()

  check('放弃后草稿清零', (await draftCount()) === 0)
  check(
    '放弃后规则恢复内核原样',
    rows.every((row) => row.state === 'core'),
  )

  section('持久化')
  await addRule({ type: 'DOMAIN-KEYWORD', payload: 'ads', proxy: 'REJECT', position: 2 })
  await waitRows(4)

  await page.reload()
  await waitRows(4)
  rows = await readRows()

  await click('[data-rule-edit="toggle"]')
  await waitExists('[data-rule-drafts]')

  check(
    '刷新后草稿仍在',
    rows.some((row) => row.state === 'add' && row.text.includes('ads')),
  )
  check('刷新后草稿计数不变', (await draftCount()) === 1)
  check('内核规则条数没有被改动', rows.filter((row) => row.state === 'core').length === 3)

  await resetDrafts()
  await waitRows(3)

  section('表格视图')
  // 字符串设置用的是 vueuse 的 string 序列化,存的是裸值,不带 JSON 引号
  await page.evaluate(`localStorage.setItem('config/rule-display-style', 'table')`)
  await page.reload()
  const tableRendered = await waitExists('table')

  await click('[data-rule-edit="toggle"]')
  await waitExists('[data-rule-action="edit"]')

  await click('[data-rule-action="edit"]')
  const tableEditor = await waitExists('[data-rule-editor]')

  check('规则列表切到表格视图', tableRendered !== null)
  check('表格视图也能打开编辑器', tableEditor !== null)

  await click('.modal-box [aria-label="close"]')
  await page.evaluate(`localStorage.removeItem('config/rule-display-style')`)

  section('页面异常')
  const pageErrors = await page.evaluateJson(`JSON.stringify(window.__ruleDraftErrors ?? [])`)

  check('整个流程没有未捕获异常', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await harness.close()
}

const failed = results.filter((result) => !result.ok)

console.log(`\n${results.length - failed.length}/${results.length} 项通过`)

if (failed.length) process.exit(1)
