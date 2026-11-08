# 记忆图谱管理界面（service/ui）

听雪记忆服务的单页管理界面。零外部依赖、无 CDN、无构建步骤；由记忆服务在 **8765** 端口以 `/`（或 `/graph`）提供，资源全部用相对路径，便于 DSH 反代到子路径（`/dsh-tingxue/graph/*`）。

## 文件

| 文件 | 职责 |
|---|---|
| `index.html` | 页面骨架：顶部栏、左侧列表、中间 canvas、右侧详情、弹窗/ toast 挂载点；首屏主题引导脚本。 |
| `styles.css` | 全部样式。深浅色语义变量（`--dsh-*` 沿用 DSH 命名习惯）+ 图谱专用变量（`--graph-*`、`--type-*`）。 |
| `graph-engine.js` | 零依赖 canvas 力导向图谱引擎（复制并扩展自 `src/graph-dashboard/index.mjs`）：聚类布局、斥力/弹簧/阻尼、缩放/拖动/空白平移、邻域高亮、标签避让、小地图、搜索/类型过滤调暗、选中节点/边高亮。颜色逐帧从 CSS 变量读取，`refreshTheme()` 立即重绘。 |
| `app.js` | 全部交互逻辑：API 封装、列表分页、详情编辑、增删改、合并、回收站、搜索、主题、toast/确认框、统计弹窗。 |

## 服务端要求（已与 service-api 对齐）

- `GET /`、`GET /graph` → `service/ui/index.html`
- `GET /ui/*` → `service/ui/*`；同时根路径 `/styles.css`、`/graph-engine.js`、`/app.js` 也要能命中 `service/ui` 下同名文件（页面里是 `./styles.css` 这类相对引用）。
- MIME：`.html` → `text/html; charset=utf-8`，`.css` → `text/css; charset=utf-8`，`.js` → `text/javascript; charset=utf-8`；不要让脚本落到 `text/plain`（`nosniff` 下会被浏览器拦截）。
- 静态响应带 `Cache-Control: no-store` 即可；页面不使用 `/graph-data.json`。

## 使用的 API（严格按 `service/API.md`）

- 实体：`GET /memory/entities`（q/type/limit/offset）、`GET /memory/entities/:id`、`POST /memory/entities`、`PATCH /memory/entities/:id`、`DELETE /memory/entities/:id`、`POST /memory/entities/merge`
- 关系：`GET /memory/relations`（q/limit/offset）、`POST /memory/relations`、`PATCH /memory/relations/:id`、`DELETE /memory/relations/:id`
- 记忆：`GET /memory/memories`（q/limit/offset）、`GET /memory/memories/:id`、`PATCH /memory/memories/:id`、`DELETE /memory/memories/:id`、`POST /memory/memories/:id/reextract`
- 统计 / 回收站 / 审计：`GET /memory/stats`、`GET /memory/trash`、`POST /memory/trash/:trashId/restore`、`GET /memory/audit`

API base：`new URLSearchParams(location.search).get('api') || '/api'`，所有请求都是 `fetch(api + path)`。
图谱数据不依赖 `/graph-data.json`，而是用实体 / 关系列表接口翻页（每页 500）拼装。

**不渲染** `identity`，**不渲染**任何 `vector`（回收站 `row.vector` 也不碰）。

## 主题

- URL：`?theme=light|dark|auto`（默认 `auto`）。
- 页面内按钮循环：跟随 → 浅色 → 深色，写入 `localStorage['tx-graph-theme']`。
- 优先级：`?theme=light|dark` 是显式指定，优先于 localStorage；`?theme=auto`（DSH iframe 固定传这个）则使用用户上次保存的选择。
- 深浅色只替换 `:root` / `:root[data-theme="dark"]` 的变量；canvas 的节点、边、背景、网格、标签、小地图颜色都由 `getComputedStyle` 读取这些变量，切换时 `refreshTheme()` + 重绘。

## 已做的验证

- `node --check service/ui/app.js`、`node --check service/ui/graph-engine.js` 通过。
- 静态一致性检查：app.js 引用的 40 个 DOM id 均存在；CSS 58 个变量均声明；资源全部相对路径；无外部 URL、无 `innerHTML`、无 `alert/confirm/prompt`；11 条 API 路径均在 API.md 覆盖范围内。
- 用临时 mock 服务（60 实体 / 70 关系 / 12 记忆 / 3 回收站项）在 Node 最小 DOM 桩里真实执行两份脚本并通过真实 HTTP 请求跑了 14 组烟测：列表/分页、实体详情与 PATCH、主题循环与 localStorage、关系详情、记忆详情、回收站恢复、统计弹窗、新增实体→搜索→删除→回收站、关系新增/删除、实体合并、类型过滤；同时断言页面 DOM 中不出现 identity 与 vector 哨兵字符串。

## 仍需真机验证（Lead 起 8765 后）

- 真实浏览器下的 canvas 视觉（节点发光、标签避让、小地图位置）与 DPR/缩放。
- 鼠标/触屏交互：滚轮缩放、拖动节点、空白平移、点击节点、悬停邻域高亮、小地图点击跳转。
- 真实数据量下的性能（数百到上千实体）与真实 API 的字段细节。
- DSH 反代子路径下的资源与 API 路径（`?api=/dsh-tingxue/memory`）。
