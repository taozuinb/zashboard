# AGENTS.md

面向在本仓库里工作的编码代理，也适用于人类贡献者。这里记录的是**约束和背后的原因**；用户向说明在
[README.md](./README.md)，测试脚本的用法在 [test/README.md](./test/README.md)。

## 1. 项目是什么

zashboard 是一个**纯前端**的 Clash 内核控制面板：构建产物是一堆静态文件，浏览器直接读写内核的
HTTP / WebSocket API。没有服务端、没有数据库、没有 Node 运行时。

| 内核                      | `BackendType` | 说明                                                  |
| ------------------------- | ------------- | ----------------------------------------------------- |
| mihomo（meta/alpha/smart） | `clash`       | 主要目标，能力最全，版本号里带 `alpha` / `meta` 等前缀 |
| honk                      | `clash`       | mihomo 分支内核，靠 `/version` 里的 `honk` 字样识别    |
| dae                       | `dae`         | 原生 dae API，能力由内核上报的 resource manifest 决定  |

sing-box 支持已在 3.23.0 移除（[docs/sing-box-deprecation.md](./docs/sing-box-deprecation.md)），
不要以“恢复兼容”为目标改代码。

技术栈：Vue 3.5 + TypeScript 6 + Vite 8、Tailwind CSS 4 + daisyUI 5、TanStack Table / Virtual、
ECharts、three.js（地球卡片）、vue-i18n、axios、ReconnectingWebSocket、tippy.js。

## 2. 环境

- Node 22+（`test/` 里的脚本直接用内置 WebSocket）。
- pnpm 11：`packageManager` 固定了 `pnpm@11.20.0`，装了 corepack 会自动切换。**不要用 npm / yarn**，
  `pnpm-lock.yaml` 是唯一的锁文件。
- 浏览器基线见 README（Chrome 111 / Firefox 128 / Safari 16.4），新语法前先确认在这个范围里。

## 3. 常用命令

```bash
pnpm install
pnpm dev              # Vite 开发服务器，未配置后端时会落到 /setup
pnpm build            # 产物在 dist/，默认打包全部字体
pnpm preview
pnpm type-check       # vue-tsc --build --force
pnpm lint             # eslint . --fix
pnpm format           # prettier --write scripts/ src/ test/
pnpm gen:icon         # 重建 public/ 图标，依赖系统里的 rsvg-convert 与 magick
```

字体变体：`pnpm build:<variant>`，variant ∈ `cdn-fonts | firasans-only | misans-only |
pingfang-only | sarasa-only | no-fonts`，本质是设置 `FONT=` 环境变量后构建（见 `vite.config.ts`）。

测试脚本（都跑 `dist/`，**必须先 `pnpm build`**）：

```bash
pnpm test:bench      # 代理页性能基准，--cpu 10 才接近真实设备
pnpm test:verify     # 代理页行为冒烟
node test/collapse.mjs   # 折叠动画时序
pnpm test:setup      # 设置页登录与同源自动连接
pnpm test:rules      # 规则页的本地草稿（新增/修改/删除/导出）
pnpm test:mock       # 只起假 mihomo 后端，手动在浏览器里点
```

`pre-commit` 钩子跑 `pnpm type-check` + `lint-staged`：类型不过，提交会失败。

## 4. 目录与分层

```
src/
  api/         传输层：一个后端方言一个文件（clash.ts / dae.ts / dae-auth.ts），只做 HTTP/WS 原语
  assembly/    后端门面：视图层唯一允许直接依赖的地方（也是后端数据的唯一来源）
  store/       前端状态与持久化（后端列表、设置、页面态）
  components/  视图组件，按域分目录；以 <script setup> 为主，表格/工具栏少数用 .tsx
  views/       路由级页面
  composables/ 组合式函数，文件名 use-*.ts
  helper/      纯函数与零散副作用工具（通知、主题、搜索、时间…）
  i18n/        en / zh / zh-tw / ru 四份文案
  types/       全局与方言类型（dae.d.ts 是内核契约，改动要跟后端对齐）
  constant/    枚举与常量（路由名、图标、表格列 key、内核仓库地址…）
  assets/      样式、字体、图片；styles/theme 下是主题 token
```

数据流只有一条：

```
component / view  →  assembly（门面）  →  driver（按 backend.type 选实现）  →  api（HTTP/WS）  →  内核
```

**分层红线**（ESLint `app/view-layer-boundaries` 强制，见 `eslint.config.js`）：
`src/components/**`、`src/views/**`、`src/composables/**` 中

- 不能从 `@/api/clash` 导入，也不能从 `@/assembly/backend` 取 `core` / `resetCore`；
- 需要判断“这个内核支不支持某功能”时用 `can(cap)`，不要自己写 `if (core.value === ...)`；
- 例外是与后端方言无关的外部调用——`@/api/geoip`、`@/api/latency`、`@/api/dae-auth`——可以直接用。

新增一个后端相关功能时，正确顺序是：`api` 加原语 → `driver` 加实现（两个 dialect 都要考虑能不能支持）
→ `assembly` 暴露门面 → 视图调用门面。

## 5. 关键机制

### 5.1 driver

`src/assembly/driver/types.ts` 定义了 `Driver`：`system` / `metrics` / `proxies` / `rules` / `config` /
`logs` / `connections` 七个域，另有可选的 `events`。`clashDriver`（`driver/clash.ts`）和
`daeDriver`（`driver/dae.ts`）各实现一份，`driverFor(backend)` 按类型挑选，缺省回落到 clash。
后端方言差异（字段名、分页、patch 语义、流式 vs 轮询）都吸收在这一层，**不要泄漏到 assembly 之上**。
`Dae*` 那一大堆类型在 `src/types/dae.d.ts`，对应内核的 API 契约，改动前确认后端版本。

### 5.2 能力协商 `can()`

`src/assembly/backend.ts` 里 `Cap` 是能力的全集，`clashCaps` / `daeCaps` 各自给出判定：

- clash 侧按内核（mihomo / honk / 分支内核的 `displayAllFeatures` 开关）静态给出；
- dae 侧读取 `daeCapabilities`（来自内核的 resource manifest，`assembly/capabilities.ts`）。

视图层一律 `can('cap')` 决定入口是否可见/可用。新增能力 = `Cap` 加成员 + 两边各写判定 + 视图包入口；
漏写 dae 侧判定会得到 `undefined !== true` 即“不支持”，这通常比错误地显示按钮安全。

### 5.3 内核识别

`assembly/version.ts` 的 `detectCore()`：版本号含 `honk` → Honk；`backend.type === 'dae'` → Dae；
版本号非空 → Mihomo。`coreReady()` 用来在探测完成后再做依赖内核的请求（例如 `assembly/storage.ts`
的同步设置）。

### 5.4 HTTP

全应用共用一个 axios 实例，`baseURL` 与 `Authorization` 由 `src/api/http.ts` 的拦截器统一注入：

- 普通后端：`Bearer <password>`；
- dae 的 password 模式：先换 bearer token，遇到 401 自动重登并重放一次请求；
- 401 且当前有活动后端时，会打开后端编辑弹窗并提示。

所以 api 函数里**不要自己拼 host/port，也不要手写鉴权头**；URL 拼装统一走 `helper/utils.ts` 的
`getUrlFromBackend()`（IPv6 主机会自动加方括号）。

### 5.5 持久化

`composables/use-storage.ts` 是 `@vueuse/core` 的 `useStorage` 薄封装，关键行为是
`writeDefaults: false`：用户没改过的项不会写入 localStorage。

键名有语义，别乱起：

- `setup/` 后端列表与活动后端——不参与设置导出；
- `config/` 用户设置——设置页的导出 / 导入 / 重置（`helper/utils.ts`）都按这个前缀工作；
- `cache/` 可重建的缓存——导出与重置不碰它。

**改键名必须同时写迁移**（`store/settings.ts` 顶部的 `migrateLegacyStorageKey`、
`store/setup.ts` 顶部的 legacy backend 迁移）。用户的设置存在浏览器里，不会自己跟着代码改名。

### 5.6 路由

hash 路由（`router/index.ts`）。`/` 重定向到 `proxies`；没有活动后端时守卫把用户推到 `/setup`。
加页面的清单：`constant` 的 `ROUTE_NAME` 与 `ROUTE_ICON_MAP`、路由表、i18n 文案、侧边栏与移动端
tab bar（`HomePage.vue` 里按 `ROUTE_NAME` 渲染）。

### 5.7 国际化

`src/i18n/{en,zh,zh-tw,ru}.ts`，模板里 `$t('key')`，TS 里 `i18n.global.t('key')`。
**加文案四个文件都要加**（en 是 fallback，但缺项会让另外三种语言直接显示 key）。

### 5.8 样式与主题

Tailwind 4（CSS-first，`@theme inline`）+ daisyUI 5。主题靠 `document.documentElement` 上的
`data-theme` 切换，颜色 token 在 `src/assets/styles/theme/*.css`（`tokens.css` 是运行时变量，
`presets.css` 是内置主题）。组件优先用语义色（`base-100` / `base-content` / `primary`），
不要写死颜色；玻璃拟态统一用 `backdrop-filter` 加现有工具类，动画相关有
`helper/panel-motion.ts` 与 `composables/use-collapse-*`。

### 5.9 性能纪律

代理页是最容易“快了但坏了”的地方：`VirtualColumn` + 懒挂载 + 行高测量（`use-virtual-row-shift`、
`composables/use-render-proxy-list.ts`）。延迟数据是按测速 URL 建的全局 computed 表，
`proxyMap` / `now` / `history` 三种写入都必须还能触发刷新——少一处依赖追踪就会停在旧数字上且不报错
（`test/verify.mjs` 专门盯这个）。动这块必须跑 `test:verify` 和 `test:bench`。

## 6. 代码风格

- Prettier：无分号、单引号、100 列、`singleAttributePerLine`、导入自动整理、Tailwind 类名排序。
  不确定就 `pnpm format`。
- ESLint：vue essential + TS 推荐；`vue/max-attributes-per-line` 单行/多行都只允许一个属性，
  属性多就换行。
- 命名：`.ts` 文件 kebab-case；`.vue` 组件 PascalCase；composable 文件 `use-foo.ts`、导出 `useFoo`；
  常量枚举 UPPER_SNAKE，类型 PascalCase。
- 注释只写“为什么”，不复述代码。仓库有过“移除注释”的重构提交，别加解释显而易见逻辑的注释；
  中文注释是常态，不算违规。

## 7. 常见改动配方

**加一个设置项**

1. `src/store/settings.ts` 加 `useStorage('config/xxx', 默认值)`（要可导出/可同步就用 `config/` 前缀）；
2. 需要出现在设置页：在 `src/config/settings-items.ts` 注册（key / label / section），
   组件放到 `src/components/settings/<分类>/`；
3. 文案补进四个 i18n 文件；
4. 若默认值依赖设备（深浅色、屏幕宽度），沿用文件里已有的 computed 包装方式。

**加一个后端能力**：见 5.2；如果 dae 侧依赖 manifest 字段，先确认字段名与内核契约
（`src/types/dae.d.ts`）一致，别在前端猜。

**加一个 assembly 域**：新建 `src/assembly/<domain>.ts`，内部只用 `driver()`，对外暴露状态与动作；
需要跨页面共享的响应式状态放这里，别放 store 再让组件互相传。

## 8. 提交与发布

- 提交信息用 Conventional Commits：`feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `test:`，
  标题小写祈使句，能带 issue 就带（历史提交形如 `fix: ... (#828)`）。
- 版本号与 `CHANGELOG.md` 由 release-please 在 `main` 上自动生成，**不要手改** `package.json` 的
  `version` 或 `CHANGELOG.md`。
- 推到 `main` 会触发 `.github/workflows/deploy.yml`：7 个字体变体各构建一次 → 分别发到
  `gh-pages*` 分支、Release 资产、ghcr 镜像。所以影响构建的改动要保证至少 `all` 与 `none` 两个
  变体都能过。
- 新增字体变体的联动点：`src/assets/load-fonts.ts`、`vite.config.ts` 的 `FONT` 注释、`package.json`
  脚本、workflow 的 matrix、README 的下载表。

## 9. 提交前自检

1. `pnpm type-check`（pre-commit 也会跑）；
2. `pnpm lint`；
3. `pnpm build`；
4. 动了代理页 / 连接表格 / 页面转场 / 折叠动画：`pnpm build` 后跑 `pnpm test:verify`、`test:collapse.mjs`，
   性能相关再加 `pnpm test:bench --cpu 10`；
5. 动了设置页登录、同源自动连接：`pnpm test:setup`；
6. 动了规则页、规则草稿或导出：`pnpm test:rules`。

仓库**没有单元测试框架**（没有 vitest / jest / playwright 依赖），`test/` 是一套 CDP 驱动的端到端
脚本：假后端 + 静态服务 + headless Chrome，用系统里已有的 Chrome（或 `CHROME_BIN=`）。

## 10. 容易踩的坑

- **测试脚本跑的是 `dist/`**：忘了 `pnpm build` 等于在测上一版。
- **PWA 的 service worker 会用旧构建应付请求**，脚本已统一 `Network.setBypassServiceWorker`；
  自己写新脚本时别忘了。
- **`localStorage` 要等页面落到应用 origin 再写**，写到 `about:blank` 的存储区里应用读不到，
  表现是“配了后端却停在 /setup”。
- **不限速的开发机测不出代理页问题**，`--cpu 10` 才接近中低端手机。
- **构建会嵌入 git commit id**（`__COMMIT_ID__`），release 提交里会跳过；不要依赖它在本地构建里的值。
- **别在视图层判断 `backend.type`**，能力差异走 `can()`；后端方言差异走 driver。
