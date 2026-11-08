// dsh-tingxue src/memory-service/index.mjs
// 记忆服务（管家）：DSH 唯一写者，暴露 HTTP REST API 供 AstrBot / 图谱 UI 读写记忆库。
//  - 人脑仿生记忆：写记忆时自动抽实体/关系（人物节点 + 关系边 + 记忆挂人物）。
//  - 写队列：所有写操作串行化，一次只写一条，规避 LanceDB 单写者并发冲突。
//  - 读操作不排队，可并行（LanceDB 读安全）。
//  - 仅监听 loopback（127.0.0.1），本机访问，不暴露公网。
//
// 端点（契约见 service/API.md）：
//   §1 兼容端点：POST /memory、GET /memory/search、GET /memory/entities（无参旧行为）、
//                 GET /memory/relations（无参旧行为）、GET /memory/expand、
//                 DELETE /memory?id=、GET /profile
//   §2 实体管理：/memory/entities（分页/过滤）、/memory/entities/:id、/memory/entities/merge
//   §3 关系管理：/memory/relations（分页/过滤）、/memory/relations/:id
//   §4 记忆管理：/memory/memories、/memory/memories/:id、/memory/memories/:id/reextract
//   §5 统计/回收站/审计：/memory/stats、/memory/trash、/memory/trash/:id/restore、/memory/audit
//   §6 配置：GET/PUT /config（apiBaseUrl 可回显；apiKey 写入 <dataDir>/secrets.json 且永不回显）
//   §7 图谱 UI：同进程另起 8765，serving service/ui/，/api/* 走同一处理器，/graph-data.json
//
// 约定：成功 {ok:true,...}；失败 {ok:false,error,code?}；所有 Int64 已由 store 转 Number。

import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'

import { findPort, readBody, sendJson } from '../http/index.mjs'
import { createMemoryManagement, ManageError } from '../memory/manage.mjs'
import { readSecrets, writeSecrets } from './secrets.mjs'

// ---- 常量 ----

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

/** API.md §0：只对这两个来源放行 CORS。 */
const CORS_ORIGINS = new Set([
  'http://127.0.0.1:8765',
  'http://localhost:8765',
])
const CORS_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS'

/**
 * GET/PUT /config 里走 `service/config.json` 的字段白名单（apiKey 永远不在其中）。
 * 注意：这是**仓库内被 git 跟踪**的配置文件，只放非机密配置。
 */
const CONFIG_KEYS = [
  'dataDir', 'profilePath', 'memoryServiceHost', 'memoryServicePort',
  'graphDashboardHost', 'graphDashboardPort', 'memoriesIdentity',
  'modelBackend', 'embeddingModel', 'embeddingDimensions', 'llmModel',
]
/**
 * 走 `<dataDir>/secrets.json` 的字段（数据目录，不进 git）。
 * apiKey 只写不读；apiBaseUrl 允许回显。两者改动都对模型客户端即时生效
 * （模型适配器每次请求重新解析），不需要重启。
 */
const SECRET_KEYS = ['apiBaseUrl', 'apiKey']
/** 改这些字段需要重启进程；graphDashboardHost/Port 可运行期即时生效。 */
const RESTART_KEYS = new Set(CONFIG_KEYS.filter((key) => key !== 'graphDashboardHost' && key !== 'graphDashboardPort'))

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/** service/ui 不存在时的最小占位页：不报错，DSH iframe 里至少能看到说明。 */
const PLACEHOLDER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>听雪 · 图谱</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#0a0e1a;color:#eef2fb;
    font-family:"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
  .box{max-width:520px;padding:32px;border:1px solid rgba(122,168,255,.25);border-radius:16px;
    background:rgba(20,26,46,.9);text-align:center;line-height:1.8}
  h1{font-size:18px;margin:0 0 10px;color:#7aa8ff}
  p{font-size:13px;color:#93a0bd;margin:6px 0}
  code{color:#ffd166}
</style>
</head>
<body>
<div class="box">
  <h1>听雪 · 关系图谱</h1>
  <p>图谱 UI 静态资源尚未安装（缺少 <code>service/ui/index.html</code>）。</p>
  <p>记忆管理 API 仍可正常使用：<code>/api/health</code>、<code>/api/memory/stats</code>。</p>
</div>
</body>
</html>`

/**
 * 创建记忆服务。
 * @param {object} deps - { store, model, graph, profilePath, logger,
 *                          dataDir, configPath, configView, apiKeyPresent, uiDir }
 * @param {object} config - { memoryServiceHost, memoryServicePort, memoriesIdentity,
 *                            graphDashboardHost, graphDashboardPort }
 */
export function createMemoryService(deps = {}, config = {}) {
  const { store, model, graph, profilePath, logger } = deps
  const warn = (m) => { try { logger?.warn?.('[dsh-tingxue/memory-service]', m) } catch {} }
  const info = (m) => { try { logger?.info?.('[dsh-tingxue/memory-service]', m) } catch {} }

  const host = config.memoryServiceHost ?? '127.0.0.1'
  const port = config.memoryServicePort ?? 8766
  /**
   * 本记忆服务的**权威身份**（t13）：写入与检索都用它，**不读客户端传的 identity**。
   *
   * 为什么必须是服务端权威：若 identity 由请求体决定，客户端改一个字段就能把记忆写进
   * 别人名下、或把别人的记忆检索出来——那样「加了 identity 过滤」也等于没有隔离。
   *
   * 默认 `'user'`：与 `store.addMemory` 的默认 identity 一致，**单用户场景行为不变**，
   * 且既有（无 identity 写入的）库存仍可被检索到，无需数据迁移。
   * 多来源部署时在 profile 配置里把它设成该来源的稳定标识（例如 `qq:<userId>`）。
   */
  const serverIdentity = String(config.memoriesIdentity ?? '').trim() || 'user'

  // 管理文件（回收站/审计）落在启动时的 dataDir；PUT /config 改 dataDir 只写文件，需重启生效。
  // 独立服务入口显式传 dataDir；DSH 插件入口没传，则回退到 store 记录的 dataDir（同一目录）。
  const runtimeDataDir = String(
    deps.dataDir ?? config.dataDir ?? store?.dataDir ?? '',
  ).trim()
  const configPath = deps.configPath ? resolve(String(deps.configPath)) : ''
  const uiDir = deps.uiDir ? resolve(String(deps.uiDir)) : ''
  const apiKeyPresent = Boolean(deps.apiKeyPresent)

  // 可运行期变更的图谱 UI 地址（PUT /config 即时生效）。
  let uiHost = String(config.graphDashboardHost ?? deps.configView?.graphDashboardHost ?? '127.0.0.1')
  let uiPort = config.graphDashboardPort ?? deps.configView?.graphDashboardPort

  /**
   * 配置展示视图（脱敏）：字段白名单 + 端口等以运行期实际值为准。
   * 绝不包含 apiKey / credentialsPath。
   */
  const configView = {
    dataDir: runtimeDataDir,
    profilePath: String(profilePath ?? ''),
    memoryServiceHost: host,
    memoryServicePort: Number(port),
    graphDashboardHost: uiHost,
    graphDashboardPort: uiPort === undefined || uiPort === null ? null : Number(uiPort),
    memoriesIdentity: serverIdentity,
    modelBackend: '',
    embeddingModel: '',
    embeddingDimensions: 0,
    llmModel: '',
    /** 有效模型端点（secrets.json > config.json > 后端默认）；空串表示用后端默认。 */
    apiBaseUrl: '',
    ...(deps.configView ?? {}),
  }

  let server = null
  let boundUrl = ''
  let uiServer = null
  let uiUrl = ''

  // ---- 写队列：所有写操作串行化 ----
  let writeChain = Promise.resolve()
  function enqueueWrite(fn) {
    const run = writeChain.then(fn)
    writeChain = run.catch(() => {})   // 一个失败不卡死队列
    return run
  }

  // ---- 管理业务（实体/关系/记忆/回收站/审计） ----
  const manage = createMemoryManagement({
    store,
    model,
    graph,
    dataDir: runtimeDataDir,
    enqueueWrite,
    defaultIdentity: serverIdentity,
    logger,
  })

  // ---- 通用工具 ----

  /** CORS：仅对 API.md §0 列出的 8765 来源回显。 */
  function applyCors(req, res) {
    const origin = req.headers?.origin
    if (!origin || !CORS_ORIGINS.has(origin)) return
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', CORS_METHODS)
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Max-Age', '600')
  }

  /** 分页参数：limit 默认 50、最大 500；offset 默认 0。 */
  function pageParams(searchParams) {
    const limitRaw = searchParams.get('limit')
    let limit = limitRaw === null || limitRaw === '' ? DEFAULT_LIMIT : Number(limitRaw)
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT
    limit = Math.min(Math.floor(limit), MAX_LIMIT)
    const offsetRaw = searchParams.get('offset')
    let offset = offsetRaw === null || offsetRaw === '' ? 0 : Number(offsetRaw)
    if (!Number.isFinite(offset) || offset < 0) offset = 0
    return { limit, offset: Math.floor(offset) }
  }

  function flag(searchParams, name) {
    const value = searchParams.get(name)
    return value === '' || value === '1' || value === 'true'
  }

  function decodeSegment(value) {
    try { return decodeURIComponent(value) } catch { return value }
  }

  async function readJsonBody(req) {
    let raw
    try {
      raw = await readBody(req)
    } catch (error) {
      throw new ManageError(400, `读取 body 失败: ${error.message}`)
    }
    if (!raw.trim()) return {}
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      throw new ManageError(400, 'body 不是合法 JSON')
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ManageError(400, 'body 必须是 JSON 对象')
    }
    return body
  }

  function sendError(res, error) {
    if (error instanceof ManageError) {
      return sendJson(res, error.status, {
        ok: false,
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.payload ?? {}),
      })
    }
    return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }

  /** 统一包装管理调用：成功 {ok:true,...payload}。 */
  function reply(res, payload) {
    return sendJson(res, 200, { ok: true, ...payload })
  }

  // ---- 配置（面板代理） ----

  async function readConfigFile() {
    if (!configPath) return {}
    try {
      return JSON.parse(await readFile(configPath, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return {}
      throw new Error(`无法读取配置 ${configPath}: ${error.message}`)
    }
  }

  function sanitizedConfig() {
    const config = {}
    for (const key of CONFIG_KEYS) {
      if (configView[key] !== undefined) config[key] = configView[key]
    }
    return config
  }

  /**
   * apiBaseUrl 归一化：空串/缺省 = 清除覆盖（回落后端默认）；否则必须是
   * http/https 绝对 URL，并去掉尾部斜杠（`.../v1/` 与 `.../v1` 等价）。
   */
  function normalizeApiBaseUrl(value) {
    const text = String(value ?? '').trim()
    if (!text) return ''
    let parsed
    try {
      parsed = new URL(text)
    } catch {
      throw new ManageError(400, 'apiBaseUrl 不是合法 URL', { code: 'invalid-config' })
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ManageError(400, 'apiBaseUrl 只支持 http/https', { code: 'invalid-config' })
    }
    return text.replace(/\/+$/, '')
  }

  /**
   * 校验并归一化 PUT /config 的 body。
   *
   * 返回两组字段：
   *   patch       —— 写 `service/config.json`（非机密）
   *   secretPatch —— 写 `<dataDir>/secrets.json`（apiKey / apiBaseUrl）
   *
   * 已知字段之外的键一律忽略（向后兼容旧面板）。apiKey 的错误消息绝不带值。
   */
  function normalizeConfigPatch(body) {
    const patch = {}
    const secretPatch = {}
    for (const key of CONFIG_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue
      const value = body[key]
      if (key === 'memoryServicePort' || key === 'graphDashboardPort') {
        const number = Number(value)
        if (!Number.isInteger(number) || number < 0 || number > 65535) {
          throw new ManageError(400, `${key} 必须是 0-65535 的整数`, { code: 'invalid-config' })
        }
        patch[key] = number
      } else if (key === 'embeddingDimensions') {
        const number = Number(value)
        if (!Number.isInteger(number) || number <= 0) {
          throw new ManageError(400, 'embeddingDimensions 必须是正整数', { code: 'invalid-config' })
        }
        patch[key] = number
      } else {
        const text = String(value ?? '').trim()
        if (!text) throw new ManageError(400, `${key} 不能为空`, { code: 'invalid-config' })
        patch[key] = text
      }
    }
    for (const key of SECRET_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue
      if (key === 'apiKey') {
        const raw = body[key]
        // 只校验类型与长度；错误消息里不出现值本身（可能是误传的对象/数组）。
        if (raw !== null && raw !== undefined && typeof raw !== 'string') {
          throw new ManageError(400, 'apiKey 必须是字符串', { code: 'invalid-config' })
        }
        const text = typeof raw === 'string' ? raw.trim() : ''
        if (text.length > 8192) {
          throw new ManageError(400, 'apiKey 长度超过 8192', { code: 'invalid-config' })
        }
        secretPatch.apiKey = text // '' = 清除，回退环境变量/凭据文件
      } else {
        secretPatch.apiBaseUrl = normalizeApiBaseUrl(body[key])
      }
    }
    if (Object.keys(patch).length === 0 && Object.keys(secretPatch).length === 0) {
      throw new ManageError(400, '没有可更新的配置字段', { code: 'no-config-fields' })
    }
    return { patch, secretPatch }
  }

  /**
   * 当前是否解析到 API Key 及其来源。只回布尔与来源名，**绝不回值**。
   * 优先问入口注入的解析器（服务入口会按 secrets → env → credentials 顺序解析）。
   */
  async function effectiveApiKeyInfo() {
    if (typeof deps.resolveApiKeyInfo === 'function') {
      try {
        const info = await deps.resolveApiKeyInfo()
        if (info && typeof info === 'object') {
          return { present: Boolean(info.present), source: String(info.source ?? 'unknown') }
        }
      } catch { /* 回退到启动快照 */ }
    }
    let fromSecrets = false
    try {
      fromSecrets = Boolean((await readSecrets(runtimeDataDir)).apiKey)
    } catch { /* 读失败按无处理：GET 不该因坏文件 500 */ }
    if (fromSecrets) return { present: true, source: 'secrets' }
    return { present: apiKeyPresent, source: apiKeyPresent ? 'external' : 'none' }
  }

  /** 有效 apiBaseUrl：secrets.json > 启动配置 > 后端默认（空串）。 */
  async function effectiveApiBaseUrl() {
    const fromDeps = deps.resolveApiBaseUrl
    if (typeof fromDeps === 'function') {
      try {
        const value = String((await fromDeps()) ?? '').trim()
        if (value) return value
      } catch { /* 回退到文件读取 */ }
    }
    try {
      const value = String((await readSecrets(runtimeDataDir)).apiBaseUrl ?? '').trim()
      if (value) return value
    } catch { /* 读失败回退到启动配置 */ }
    return String(configView.apiBaseUrl ?? '')
  }

  async function applyConfig(patch) {
    if (!configPath) throw new Error('配置路径未配置（无法写 service/config.json）')
    const fileConfig = await readConfigFile()
    // 保留配置文件里的未知字段，只覆盖白名单里的键。
    const merged = { ...fileConfig, ...patch }
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')

    let restartRequired = false
    let uiChanged = false
    for (const [key, value] of Object.entries(patch)) {
      const previous = configView[key]
      const changed = (key.endsWith('Port') || key === 'embeddingDimensions')
        ? Number(previous) !== Number(value)
        : String(previous ?? '') !== String(value)
      configView[key] = value
      if (!changed) continue
      if (RESTART_KEYS.has(key)) restartRequired = true
      if (key === 'graphDashboardHost' || key === 'graphDashboardPort') uiChanged = true
    }

    let warning = ''
    if (uiChanged) {
      uiHost = String(configView.graphDashboardHost ?? uiHost)
      uiPort = configView.graphDashboardPort
      try {
        await restartUiServer()
      } catch (error) {
        warning = `图谱 UI 重启失败: ${error.message}`
        warn(warning)
      }
    }
    return { restartRequired, warning }
  }

  // ---- 图数据（兼容旧 UI：nodes + links；旧 dashboard 另认 edges） ----

  async function collectGraphData() {
    if (!store) return { nodes: [], links: [], edges: [] }
    try {
      const [entities, relations] = await Promise.all([
        store.listAllEntities?.({ limit: 1500 }) ?? [],
        store.listAllRelations?.({ limit: 6000 }) ?? [],
      ])
      const nodeIds = new Set(entities.map((entity) => entity.id))
      const links = relations
        .filter((relation) => nodeIds.has(relation.sourceId) && nodeIds.has(relation.targetId))
        .map((relation) => ({
          id: relation.id,
          source: relation.sourceId,
          target: relation.targetId,
          label: relation.relation,
        }))
      // 旧 graph-dashboard 页面读 edges(from/to/label)，一并给出。
      const edges = links.map((link) => ({
        id: link.id, from: link.source, to: link.target, label: link.label,
      }))
      const nodes = entities.map((entity) => ({
        id: entity.id,
        name: entity.name,
        type: entity.type ?? 'concept',
        summary: entity.summary ?? '',
      }))
      return { nodes, links, edges }
    } catch (error) {
      warn(`收集图谱数据失败: ${error.message}`)
      return { nodes: [], links: [], edges: [] }
    }
  }

  // ---- 主处理器（8766 API 与 8765 /api 别名共用） ----

  async function handle(req, res, overrideUrl) {
    const rawUrl = overrideUrl ?? req.url ?? '/'
    let parsed
    try {
      parsed = new URL(rawUrl, 'http://127.0.0.1')
    } catch {
      return sendJson(res, 400, { ok: false, error: '非法 URL' })
    }
    const url = parsed.pathname
    const method = req.method || 'GET'
    const params = parsed.searchParams

    applyCors(req, res)
    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    try {
      // ---- §1 POST /memory — 写一条记忆（含实体抽取） ----
      if (method === 'POST' && url === '/memory') {
        let body
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch {
          // 非法 JSON：客户端错误，返回 400 而不是 500
          return sendJson(res, 400, { ok: false, error: 'body 不是合法 JSON' })
        }
        const text = String((body && body.text) ?? '').trim()
        if (!text) return sendJson(res, 400, { ok: false, error: 'text 必填' })
        const scene = String((body && body.scene) ?? 'chat').trim() || 'chat'
        // **identity 由服务端决定，不接受客户端伪造**（t13 修复）。
        const clientIdentity = String((body && body.identity) ?? '').trim()
        const identity = serverIdentity
        const source = String((body && body.source) ?? 'astrbot').trim() || 'astrbot'

        // 记忆正文 + 向量尽快落库并立刻返回：实体抽取是慢模型调用，
        // 若同步做会在响应路径里卡住 AstrBot 的 15s 超时。
        const memoryId = await enqueueWrite(async () => {
          if (!store || !model) throw new Error('记忆服务未就绪')
          const vec = await model.embed([text])
          return store.addMemory({ text, vector: vec[0], scene, identity, source })
        })
        // 先回 200，再异步抽取实体/关系（失败只记日志，不再让客户端等）。
        // scene=selftest 是服务自检写入：跳过图谱抽取，保证测完删除后库完全无残留。
        if (scene !== 'selftest') {
          enqueueWrite(async () => {
            if (!graph) return
            try {
              await graph.ingest(text, { source })
            } catch (e) { warn(`实体抽取失败: ${e.message}`) }
          }).catch(() => {})
        }
        const payload = { ok: true, memoryId, entityIds: [], newEntities: 0, async: true, identity }
        if (clientIdentity && clientIdentity !== identity) {
          payload.ignoredIdentity = clientIdentity
          warn(`客户端传入的 identity=${clientIdentity} 已被忽略，按服务端 identity=${identity} 写入`)
        }
        return sendJson(res, 200, payload)
      }

      // ---- §1 GET /memory/search — 语义检索记忆 ----
      if (method === 'GET' && url === '/memory/search') {
        const q = params.get('q') ?? ''
        const limit = Number(params.get('limit') ?? 8)
        const scene = params.get('scene') ?? undefined
        if (!q.trim()) return sendJson(res, 400, { ok: false, error: 'q 必填' })
        if (!store || !model) throw new Error('记忆服务未就绪')
        const vec = await model.embed([q])
        // 强制服务端 identity：检索永远只在本来源自己的记忆里做（不跨来源串味）。
        const results = await store.searchMemories(vec[0], { limit, scene, identity: serverIdentity })
        return sendJson(res, 200, { ok: true, results, identity: serverIdentity })
      }

      // ---- §1/§2 GET /memory/entities — 无参保持旧行为，有参走分页/过滤 ----
      if (method === 'GET' && url === '/memory/entities') {
        const hasFilter = ['q', 'type', 'limit', 'offset'].some((key) => params.has(key))
        if (!hasFilter) {
          const entities = await store.listAllEntities?.({ limit: 1500 }) ?? []
          return sendJson(res, 200, { ok: true, entities })
        }
        const { limit, offset } = pageParams(params)
        return reply(res, await manage.listEntities({
          q: params.get('q') ?? '',
          type: params.get('type') ?? '',
          limit,
          offset,
        }))
      }

      // ---- §1/§3 GET /memory/relations — 无参保持旧行为（含已结束、上限 6000） ----
      if (method === 'GET' && url === '/memory/relations') {
        const hasFilter = ['q', 'includeEnded', 'limit', 'offset'].some((key) => params.has(key))
        if (!hasFilter) {
          const [relations, entities] = await Promise.all([
            store.listAllRelations?.({ limit: 6000 }) ?? [],
            store.listAllEntities?.({ limit: 1500 }) ?? [],
          ])
          // 旧响应只保证 relations 数组；额外补 sourceName/targetName 与 total，
          // 让无参调用同样满足 §3 的字段约定（旧客户端忽略多余字段）。
          const nameById = new Map(entities.map((entity) => [entity.id, entity.name ?? '']))
          const enriched = relations.map((relation) => ({
            ...relation,
            sourceName: nameById.get(relation.sourceId) ?? '',
            targetName: nameById.get(relation.targetId) ?? '',
          }))
          return sendJson(res, 200, { ok: true, relations: enriched, total: enriched.length })
        }
        const { limit, offset } = pageParams(params)
        return reply(res, await manage.listRelations({
          q: params.get('q') ?? '',
          includeEnded: flag(params, 'includeEnded'),
          limit,
          offset,
        }))
      }

      // ---- §2 实体详情 / PATCH / DELETE ----
      const entityMatch = /^\/memory\/entities\/([^/]+)$/.exec(url)
      if (entityMatch && method === 'GET') {
        const id = decodeSegment(entityMatch[1])
        return reply(res, await manage.getEntityDetail(id))
      }
      if (entityMatch && method === 'PATCH') {
        const id = decodeSegment(entityMatch[1])
        const body = await readJsonBody(req)
        return reply(res, await manage.updateEntity(id, body))
      }
      if (entityMatch && method === 'DELETE') {
        const id = decodeSegment(entityMatch[1])
        return reply(res, await manage.deleteEntity(id))
      }

      // ---- §2 POST /memory/entities/merge（必须先于普通 :id 匹配思路，但路径不同无冲突） ----
      if (method === 'POST' && url === '/memory/entities/merge') {
        const body = await readJsonBody(req)
        return reply(res, await manage.mergeEntities({
          keepId: String(body.keepId ?? '').trim(),
          mergeId: String(body.mergeId ?? '').trim(),
        }))
      }

      // ---- §2 POST /memory/entities ----
      if (method === 'POST' && url === '/memory/entities') {
        const body = await readJsonBody(req)
        return reply(res, await manage.createEntity({
          name: body.name,
          type: body.type,
          summary: body.summary,
        }))
      }

      // ---- §3 关系详情/PATCH/DELETE ----
      const relationMatch = /^\/memory\/relations\/([^/]+)$/.exec(url)
      if (relationMatch && method === 'GET') {
        const id = decodeSegment(relationMatch[1])
        return reply(res, await manage.getRelation(id))
      }
      if (relationMatch && method === 'PATCH') {
        const id = decodeSegment(relationMatch[1])
        const body = await readJsonBody(req)
        return reply(res, await manage.updateRelation(id, body))
      }
      if (relationMatch && method === 'DELETE') {
        const id = decodeSegment(relationMatch[1])
        return reply(res, await manage.deleteRelation(id))
      }

      // ---- §3 POST /memory/relations ----
      if (method === 'POST' && url === '/memory/relations') {
        const body = await readJsonBody(req)
        return reply(res, await manage.createRelation({
          sourceId: body.sourceId,
          targetId: body.targetId,
          relation: body.relation,
          source: body.source,
        }))
      }

      // ---- §4 POST /memory/memories/:id/reextract（先于 :id 匹配） ----
      const reextractMatch = /^\/memory\/memories\/([^/]+)\/reextract$/.exec(url)
      if (reextractMatch && method === 'POST') {
        const id = decodeSegment(reextractMatch[1])
        return reply(res, await manage.reextractMemory(id))
      }

      // ---- §4 记忆详情/PATCH/DELETE ----
      const memoryMatch = /^\/memory\/memories\/([^/]+)$/.exec(url)
      if (memoryMatch && method === 'GET') {
        const id = decodeSegment(memoryMatch[1])
        return reply(res, await manage.getMemoryDetail(id))
      }
      if (memoryMatch && method === 'PATCH') {
        const id = decodeSegment(memoryMatch[1])
        const body = await readJsonBody(req)
        return reply(res, await manage.updateMemory(id, body))
      }
      if (memoryMatch && method === 'DELETE') {
        const id = decodeSegment(memoryMatch[1])
        return reply(res, await manage.deleteMemory(id))
      }

      // ---- §4 GET /memory/memories ----
      if (method === 'GET' && url === '/memory/memories') {
        const { limit, offset } = pageParams(params)
        return reply(res, await manage.listMemories({
          q: params.get('q') ?? '',
          scene: params.get('scene') ?? '',
          identity: params.has('identity') ? params.get('identity') : undefined,
          limit,
          offset,
        }))
      }

      // ---- §5 GET /memory/stats ----
      if (method === 'GET' && url === '/memory/stats') {
        return reply(res, await manage.stats())
      }

      // ---- §5 GET /memory/trash ----
      if (method === 'GET' && url === '/memory/trash') {
        const { limit } = pageParams(params)
        return reply(res, await manage.listTrash({ limit }))
      }

      // ---- §5 POST /memory/trash/:trashId/restore ----
      const restoreMatch = /^\/memory\/trash\/([^/]+)\/restore$/.exec(url)
      if (restoreMatch && method === 'POST') {
        const trashId = decodeSegment(restoreMatch[1])
        return reply(res, await manage.restoreTrash(trashId))
      }

      // ---- §5 GET /memory/audit ----
      if (method === 'GET' && url === '/memory/audit') {
        const { limit } = pageParams(params)
        return reply(res, await manage.listAudit({ limit }))
      }

      // ---- §6 GET /config（脱敏；apiBaseUrl 可回显，apiKey 只回布尔/来源） ----
      if (method === 'GET' && url === '/config') {
        const [apiKeyInfo, apiBaseUrl] = await Promise.all([
          effectiveApiKeyInfo(),
          effectiveApiBaseUrl(),
        ])
        return sendJson(res, 200, {
          ok: true,
          config: { ...sanitizedConfig(), apiBaseUrl },
          hasApiKey: apiKeyInfo.present,
          // 只回来源名（secrets/env/credentials/config/none），不含任何密钥片段。
          apiKeySource: apiKeyInfo.source,
        })
      }

      // ---- §6 PUT /config ----
      if (method === 'PUT' && url === '/config') {
        const body = await readJsonBody(req)
        const { patch, secretPatch } = normalizeConfigPatch(body)
        let restartRequired = false
        let warning = ''

        // 1) 非机密配置 → service/config.json（保留未知字段）
        if (Object.keys(patch).length > 0) {
          const applied = await applyConfig(patch)
          restartRequired = applied.restartRequired
          if (applied.warning) warning = applied.warning
        }

        // 2) API 凭据 → <dataDir>/secrets.json（不进 git，仅当前用户可读）
        let secretsResult = null
        if (Object.keys(secretPatch).length > 0) {
          if (!runtimeDataDir) {
            throw new ManageError(500, '数据目录未知，无法保存 API 配置', { code: 'no-data-dir' })
          }
          let written
          try {
            written = await writeSecrets(runtimeDataDir, secretPatch)
          } catch (error) {
            // secrets.mjs 的错误消息只含路径，不含字段值。
            throw new ManageError(500, `保存 API 配置失败: ${error.message}`, {
              code: 'secrets-write-failed',
            })
          }
          if (written.permission?.warning) {
            warning = warning ? `${warning}; ${written.permission.warning}` : written.permission.warning
          }
          // 模型适配器每次请求都重新解析 secrets.json → 改完即时生效，无需重启。
          if (Object.prototype.hasOwnProperty.call(secretPatch, 'apiBaseUrl')) {
            configView.apiBaseUrl = secretPatch.apiBaseUrl || ''
          }
          secretsResult = {
            persisted: true,
            file: written.path,
            cleared: written.removed,
            // 只回字段名，绝不回字段值。
            fields: Object.keys(secretPatch),
          }
        }

        return sendJson(res, 200, {
          ok: true,
          restartRequired,
          ...(warning ? { warning } : {}),
          ...(secretsResult ? { api: secretsResult } : {}),
        })
      }

      // ---- §1 GET /memory/expand — 从人物沿关系扩展 ----
      if (method === 'GET' && url === '/memory/expand') {
        const entityId = params.get('entityId') ?? ''
        const depth = Number(params.get('depth') ?? 1)
        if (!entityId) return sendJson(res, 400, { ok: false, error: 'entityId 必填' })
        if (!graph) throw new Error('图谱服务未就绪')
        const result = await graph.expandFromEntities([entityId], { depth })
        return sendJson(res, 200, { ok: true, ...result })
      }

      // ---- §1 DELETE /memory?id= — 按精确 ID 删除一条记忆（旧语义：不进回收站） ----
      if (method === 'DELETE' && url === '/memory') {
        const id = params.get('id') ?? ''
        if (!id.trim()) return sendJson(res, 400, { ok: false, error: 'id 必填' })
        await enqueueWrite(async () => {
          if (!store) throw new Error('记忆服务未就绪')
          await store.deleteMemory(id)
        })
        return sendJson(res, 200, { ok: true, deleted: id })
      }

      // ---- §1 GET /profile ----
      if (method === 'GET' && url === '/profile') {
        const profile = await readProfile()
        return sendJson(res, 200, { ok: true, profile })
      }

      // ---- §7 8766 /graph → 8765 图谱 UI（可选重定向） ----
      if (method === 'GET' && (url === '/graph' || url === '/graph/')) {
        if (uiUrl) {
          res.writeHead(302, { Location: `${uiUrl}/` })
          res.end()
          return
        }
        return sendJson(res, 404, { ok: false, error: '图谱 UI 未启用' })
      }

      // ---- 健康检查 ----
      if (method === 'GET' && (url === '/' || url === '/health')) {
        return sendJson(res, 200, { ok: true, service: 'dsh-tingxue-memory', port: server?.address()?.port ?? port })
      }

      return sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      return sendError(res, error)
    }
  }

  // ---- 人格 ----
  async function readProfile() {
    if (!profilePath) return ''
    try {
      const { readFile } = await import('node:fs/promises')
      return await readFile(profilePath, 'utf-8')
    } catch (e) {
      warn(`读取人格失败: ${e.message}`)
      return ''
    }
  }

  // ---- §7 8765 图谱 UI / 静态资源 / 同源 /api 别名 ----

  function contentTypeFor(path) {
    return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  }

  async function serveIndex(res, method) {
    let html = null
    if (uiDir) {
      try {
        html = await readFile(join(uiDir, 'index.html'), 'utf8')
      } catch { /* 目录/文件不存在 → 占位页 */ }
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(method === 'HEAD' ? undefined : (html ?? PLACEHOLDER_HTML))
  }

  async function serveStatic(res, pathname, method) {
    if (!uiDir) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    // 允许 /ui/app.js 与 /app.js 两种相对资源路径；禁止路径穿越。
    const relative = pathname.startsWith('/ui/') ? pathname.slice(4) : pathname
    const base = resolve(uiDir)
    const target = resolve(base, relative.replace(/^\/+/, ''))
    if (target !== base && !target.startsWith(base + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    try {
      const data = await readFile(target)
      res.writeHead(200, {
        'Content-Type': contentTypeFor(target),
        'Cache-Control': 'no-store',
      })
      res.end(method === 'HEAD' ? undefined : data)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
    }
  }

  async function handleUi(req, res) {
    const method = req.method || 'GET'
    applyCors(req, res)
    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    let parsed
    try {
      parsed = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('bad request')
      return
    }
    const pathname = parsed.pathname

    // 同源别名：/api/* 交给与 8766 完全相同的处理器。
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const subPath = pathname.slice(4) || '/'
      return handle(req, res, `${subPath}${parsed.search}`)
    }

    // 旧页面数据：{nodes,links}（另附 edges 兼容旧 dashboard）。
    if (pathname === '/graph-data.json' || pathname === '/graph.json') {
      const payload = await collectGraphData()
      return sendJson(res, 200, payload)
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }

    if (pathname === '/' || pathname === '/graph' || pathname === '/graph/') {
      return serveIndex(res, method)
    }
    return serveStatic(res, pathname, method)
  }

  // ---- 启动 / 停止 ----

  async function listen(serverInstance, listenPort, listenHost) {
    serverInstance.listen(listenPort, listenHost)
    await new Promise((resolveListen, reject) => {
      serverInstance.once('listening', resolveListen)
      serverInstance.once('error', reject)
    })
    return serverInstance.address()?.port ?? listenPort
  }

  /** 启动 8765 图谱 UI（若配置了端口）。失败不拖垮记忆 API。 */
  async function startUiServer() {
    if (uiServer) return uiUrl
    if (uiPort === undefined || uiPort === null) return ''
    const wanted = Number(uiPort)
    const actualPort = Number.isInteger(wanted) && wanted >= 0 ? wanted : 0
    const instance = createServer(async (req, res) => {
      try {
        await handleUi(req, res)
      } catch (error) {
        warn(`图谱 UI 请求处理失败: ${error.message}`)
        if (!res.writableEnded) sendJson(res, 500, { ok: false, error: error.message })
      }
    })
    const bound = await listen(instance, actualPort, uiHost)
    uiServer = instance
    uiUrl = `http://${uiHost}:${bound}`
    info(`图谱 UI 已启动：${uiUrl}（静态目录：${uiDir || '(未配置，占位页)'}；/api 同源别名）`)
    return uiUrl
  }

  async function stopUiServer() {
    if (!uiServer) return
    const instance = uiServer
    uiServer = null
    uiUrl = ''
    try { await new Promise((resolveClose) => instance.close(resolveClose)) } catch { /* 忽略 */ }
  }

  async function restartUiServer() {
    await stopUiServer()
    return startUiServer()
  }

  /** 启动 HTTP 服务。返回启动成功的 URL 或 null。 */
  async function start() {
    if (server) return boundUrl
    const requested = Number(port)
    const actualPort = Number.isInteger(requested) && requested >= 0
      ? requested
      : ((await findPort(8766, host)) ?? 8766)
    try {
      server = createServer(async (req, res) => {
        try {
          await handle(req, res)
        } catch (e) {
          warn(`请求处理失败: ${e.message}`)
          sendJson(res, 500, { ok: false, error: e.message })
        }
      })
      const boundPort = await listen(server, actualPort, host)
      boundUrl = `http://${host}:${boundPort}`
      info(`记忆服务已启动：${boundUrl}（DSH 唯一写者，AstrBot 通过 HTTP 对接）`)
    } catch (e) {
      warn(`记忆服务启动失败: ${e.message}`)
      server = null
      return null
    }

    // 同一进程内再起 8765（UI + 同源 /api）；失败只告警，不影响记忆 API。
    try {
      await startUiServer()
    } catch (e) {
      warn(`图谱 UI 启动失败: ${e.message}`)
      uiServer = null
      uiUrl = ''
    }
    return boundUrl
  }

  async function stop() {
    await stopUiServer()
    if (!server) return
    try { await new Promise((r) => server.close(r)) } catch {}
    server = null
  }

  return {
    start,
    stop,
    get url() { return boundUrl },
    get graphUrl() { return uiUrl },
  }
}
