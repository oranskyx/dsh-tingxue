// dsh-tingxue-ui · Host 半边
//
// 三件事，全部围绕「同源、只读优先、永不抛错」：
//   1. /dsh-tingxue-ui/memory/*  → 转发到本机记忆服务（默认 http://127.0.0.1:8766）。
//      浏览器直连 8766 会被 CORS 拦下，走宿主 webServer
//      的同源反代就没有跨源问题，也不用在页面里写死跨源地址。
//   2. /dsh-tingxue-ui/ping     → 记忆服务与图谱 UI 的探活 + 往返延迟。
//   3. /dsh-tingxue-ui/panel    → 两页共享的面板偏好（注入档位、收工归档参数等），
//      落在用户配置目录的 dsh-tingxue-ui/settings.json，并附带工作区路径与最近归档。
//
// 安全边界：所有路由只接受本机 loopback 来源（反代的是本机管理接口），
// 上游不可达一律回 502 JSON，绝不把连接错误抛给宿主进程。

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 反代前缀；客户端 client.js 用同一个常量。 */
const MEMORY_PREFIX = '/dsh-tingxue-ui/memory'
/** 图谱界面（8765）同源反代前缀。iframe 只认同源，必须由宿主转发。 */
const GRAPH_PREFIX = '/dsh-tingxue-graph'
/** 一键启动记忆服务（面板里点按钮走这里，不用去开终端）。 */
const SERVICE_START_PATH = '/dsh-tingxue-ui/service/start'
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PING_PATH = '/dsh-tingxue-ui/ping'
const PANEL_PATH = '/dsh-tingxue-ui/panel'
/** 浏览器半边注册成功后的自检回报；只存最近一次，用于排障。 */
const CLIENT_REPORT_PATH = '/dsh-tingxue-ui/client-report'
/** 全局上下文压缩设置（@deepseek-ai/dsh-compaction-basic）的读写。 */
const CONTEXT_PATH = '/dsh-tingxue-ui/context'
/** 拉模型列表：把「表单当前显示的 baseURL + 还没保存的 key」发给端点问一圈。
 *  为什么要 POST 而不是 GET：key 不能进 URL（会进浏览器历史 / 代理日志 / 服务器 access log）。 */
const MODELS_PATH = '/dsh-tingxue-ui/models'
/** QQ 通道配置：读写 dsh-im 的 config.json + workspaces.json（同源、本机、带备份）。 */
const CHANNELS_PATH = '/dsh-tingxue-ui/channels'
/** 压缩设置所属的 Loader 入口 id。 */
const COMPACTION_ENTRY = 'compaction-basic'

const DEFAULT_MEMORY_ORIGIN = 'http://127.0.0.1:8766'
const DEFAULT_GRAPH_ORIGIN = 'http://127.0.0.1:8765'
const DEFAULT_SKILLS_DIR = 'D:\\dsh-home\\skills'

const PROBE_TIMEOUT_MS = 1500
const PROXY_TIMEOUT_MS = 8000
const BODY_LIMIT_BYTES = 1024 * 1024

const INJECT_TIERS = ['full', 'archive', 'off']
/** 压缩阈值的百分比边界（框架字段 thresholdRatio = 百分比 / 100）。 */
const COMPACTION_RATIO_MIN = 10
const COMPACTION_RATIO_MAX = 95
const COMPACTION_RATIO_DEFAULT = 80

/** 两页的默认面板偏好；companion = 陪伴 bot，agent = 干活 bot。 */
const DEFAULT_SETTINGS = {
  companion: { injectTier: 'full', relationExpand: false, writeBack: false },
  agent: {
    injectTier: 'archive',
    relationExpand: false,
    writeBack: false,
    archiveKeyword: 'agentout',
    skillsDir: DEFAULT_SKILLS_DIR,
  },
}

/** 面板偏好的落盘位置：用户配置目录，不碰 DSH profile，也不碰听雪插件目录。 */
function settingsFile() {
  const base = process.env.LOCALAPPDATA
    || process.env.XDG_CONFIG_HOME
    || join(homedir(), '.config')
  return join(base, 'dsh-tingxue-ui', 'settings.json')
}

function trimSlash(value) {
  return String(value ?? '').trim().replace(/\/+$/, '')
}

function isLoopback(req) {
  const address = String(req?.socket?.remoteAddress ?? '')
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

function sendJson(res, status, payload, headers = {}) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function normalizeTier(value, fallback) {
  return INJECT_TIERS.includes(value) ? value : fallback
}

/** 只认白名单字段，类型不对就退回默认值——坏文件不会让页面白屏。 */
function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const companion = source.companion && typeof source.companion === 'object' ? source.companion : {}
  const agent = source.agent && typeof source.agent === 'object' ? source.agent : {}
  const defaults = DEFAULT_SETTINGS
  return {
    companion: {
      injectTier: normalizeTier(companion.injectTier, defaults.companion.injectTier),
      relationExpand: typeof companion.relationExpand === 'boolean' ? companion.relationExpand : defaults.companion.relationExpand,
      writeBack: typeof companion.writeBack === 'boolean' ? companion.writeBack : defaults.companion.writeBack,
    },
    agent: {
      injectTier: normalizeTier(agent.injectTier, defaults.agent.injectTier),
      relationExpand: typeof agent.relationExpand === 'boolean' ? agent.relationExpand : defaults.agent.relationExpand,
      writeBack: typeof agent.writeBack === 'boolean' ? agent.writeBack : defaults.agent.writeBack,
      archiveKeyword: String(agent.archiveKeyword ?? defaults.agent.archiveKeyword).trim() || defaults.agent.archiveKeyword,
      skillsDir: String(agent.skillsDir ?? defaults.agent.skillsDir).trim() || defaults.agent.skillsDir,
    },
  }
}

async function readSettings() {
  try {
    const text = await readFile(settingsFile(), 'utf8')
    return normalizeSettings(JSON.parse(text))
  } catch {
    return normalizeSettings(undefined)
  }
}

/**
 * 面板偏好落盘：先写同目录临时文件再 rename。
 * 听雪 host 插件按 mtime 轮询这个文件，原子替换可以避免它读到写了一半的 JSON。
 */
async function writeSettings(next) {
  const target = settingsFile()
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(temp, target)
}

/** 最近归档：读 skill 输出目录，按修改时间倒序；目录不存在就是空列表。 */
async function listArchives(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const rows = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (!entry.isDirectory() && !entry.isFile()) continue
      const full = join(dir, entry.name)
      let info
      try { info = await stat(full) } catch { continue }
      rows.push({
        name: entry.name,
        kind: entry.isDirectory() ? 'dir' : 'file',
        mtime: Math.round(info.mtimeMs),
        bytes: info.size,
      })
    }
    rows.sort((a, b) => b.mtime - a.mtime)
    return rows.slice(0, 8)
  } catch {
    return []
  }
}

/** 探活一个上游根地址；超时/拒绝连接都只是「离线」，不抛错。 */
async function probe(origin, path = '/') {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(origin + path, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    return {
      online: response.status < 500,
      status: response.status,
      ms: Date.now() - started,
    }
  } catch {
    return { online: false, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

function createRoutes(config = {}, ctx) {
  const memoryOrigin = trimSlash(config.memoryServiceUrl) || DEFAULT_MEMORY_ORIGIN
  const graphOrigin = trimSlash(config.graphDashboardUrl) || DEFAULT_GRAPH_ORIGIN
  /** 最近一次浏览器半边自检回报（进程内存，不落盘）。 */
  let clientReport = null

  async function handleProxy(req, res) {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '面板代理只允许本机 loopback 访问' })
    let rest = '/'
    let search = ''
    try {
      const url = new URL(String(req.url ?? '/'), 'http://localhost')
      rest = url.pathname.slice(MEMORY_PREFIX.length) || '/'
      if (!rest.startsWith('/')) rest = `/${rest}`
      search = url.search
    } catch {
      return sendJson(res, 400, { ok: false, error: '无法解析请求地址' })
    }

    const method = String(req.method ?? 'GET').toUpperCase()
    if (!['GET', 'HEAD', 'PUT', 'POST', 'PATCH', 'DELETE'].includes(method)) {
      return sendJson(res, 405, { ok: false, error: `不支持的请求方法 ${method}` }, { Allow: 'GET, HEAD, PUT, POST, PATCH, DELETE' })
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS)
    try {
      const init = {
        method,
        signal: controller.signal,
        headers: { accept: 'application/json', 'cache-control': 'no-store' },
      }
      if (method !== 'GET' && method !== 'HEAD') {
        const body = await readBody(req)
        init.body = body
        init.headers['content-type'] = req.headers['content-type'] || 'application/json'
      }
      const upstream = await fetch(memoryOrigin + rest + search, init)
      const text = await upstream.text()
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(text)
    } catch (error) {
      const reason = error?.name === 'AbortError' ? '请求超时' : String(error?.message ?? error)
      sendJson(res, 502, { ok: false, error: `记忆服务不可达（${memoryOrigin}）：${reason}` })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 图谱界面反代：/dsh-tingxue-graph/<path> → http://127.0.0.1:8765/<path>。
   * 只转发 GET/HEAD（那是只读的看图界面），并原样透传 content-type，
   * 这样 index.html / app.js / styles.css / graph-data.json 都能直接跑。
   */
  async function handleGraphProxy(req, res) {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '图谱界面只允许本机 loopback 访问' })
    let rest = '/'
    let search = ''
    try {
      const url = new URL(String(req.url ?? '/'), 'http://localhost')
      rest = url.pathname.slice(GRAPH_PREFIX.length) || '/'
      if (!rest.startsWith('/')) rest = `/${rest}`
      search = url.search
    } catch {
      return sendJson(res, 400, { ok: false, error: '无法解析请求地址' })
    }

    const method = String(req.method ?? 'GET').toUpperCase()
    if (!['GET', 'HEAD'].includes(method)) {
      return sendJson(res, 405, { ok: false, error: '图谱界面只读' }, { Allow: 'GET, HEAD' })
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS)
    try {
      const upstream = await fetch(graphOrigin + rest + search, {
        method,
        signal: controller.signal,
        headers: { accept: String(req.headers?.accept ?? '*/*') },
      })
      const buffer = Buffer.from(await upstream.arrayBuffer())
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
        'cache-control': 'no-store',
        'content-length': buffer.length,
      })
      res.end(buffer)
    } catch (error) {
      const reason = error?.name === 'AbortError' ? '请求超时' : String(error?.message ?? error)
      sendJson(res, 502, { ok: false, error: `图谱界面不可达（${graphOrigin}）：${reason}` })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 一键启动记忆服务。
   *
   * 为什么不是「插件自己拉起来」：DSH 的 job object 会连坐杀掉自己 spawn 的子进程
   * （start-tingxue-memory.ps1 的注释里记着这条教训）。这里改成让人点按钮触发，
   * 并且用 detached + unref，尽量脱离当前进程组；万一还是被连坐，至少用户看得见
   * 失败原因，而不是某个面板莫名其妙空白。
   */
  async function handleServiceStart(req, res) {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '只允许本机 loopback 触发启动' })

    // 已经在跑就别再起一个（会抢端口）。
    try {
      const probe = await fetch(`${memoryOrigin}/health`, { signal: AbortSignal.timeout(1500) })
      if (probe.ok) return sendJson(res, 200, { ok: true, already: true, message: '记忆服务已在运行' })
    } catch { /* 没起来，继续往下走 */ }

    const script = join(REPO_ROOT, 'service', 'memory-service.mjs')
    if (!existsSync(script)) {
      return sendJson(res, 500, { ok: false, error: `找不到服务入口：${script}` })
    }

    // Electron 的 exe 加上这个环境变量就以 Node 模式跑，等价于 node 本身。
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    try {
      const child = spawn(process.execPath, [script], {
        cwd: REPO_ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env,
      })
      child.unref()
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: `启动失败：${String(error?.message ?? error)}` })
    }

    // 给服务 6 秒起来（Embedding 初始化要读 LanceDB），期间反复探活。
    for (let i = 0; i < 12; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        const probe = await fetch(`${memoryOrigin}/health`, { signal: AbortSignal.timeout(1200) })
        if (probe.ok) return sendJson(res, 200, { ok: true, started: true, message: '记忆服务已启动' })
      } catch { /* 继续等 */ }
    }
    return sendJson(res, 502, { ok: false, error: '已发出启动命令，但 6 秒内没探到健康响应；稍后刷新，或手动运行 start-tingxue-memory.ps1 看报错' })
  }

  // ── QQ 通道（dsh-im 的 config.json + workspaces.json）─────────────────────
  const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  const QQ_DIR = join(DSH_HOME, 'integrations', 'dsh-qq')
  const QQ_CONFIG = join(QQ_DIR, 'config.json')
  const QQ_WORKSPACES = join(QQ_DIR, 'workspaces.json')

  async function readJson(p, fallback) {
    try { return JSON.parse(await readFile(p, 'utf8')) } catch { return fallback }
  }

  /** 原子写：先写临时文件再 rename，避免写一半断电/被其它进程读到半截 JSON。 */
  async function writeJsonAtomic(p, value) {
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
    await mkdir(dirname(p), { recursive: true })
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, p)
  }

  /** 与 dsh-im 完全一致的派生规则：appId → botId / secretRef（sha256 前 24 位）。 */
  function deriveQqIdentity(appId) {
    const raw = String(appId || '').trim()
    if (!raw) throw new TypeError('appId 不能为空')
    const digest = createHash('sha256').update(raw).digest('hex').slice(0, 24)
    return { botId: `qq_${digest}`, secretRef: `DSH_QQBOT_APP_SECRET_${digest.toUpperCase()}` }
  }

  function maskAppId(appId) {
    const v = String(appId || '')
    if (!v) return ''
    return v.length <= 10 ? `${v.slice(0, 3)}•••` : `${v.slice(0, 6)}••••${v.slice(-4)}`
  }

  /**
   * GET /dsh-tingxue-ui/channels → 当前两个（或多个）QQ bot 的配置。
   *
   * 只回**脱敏后的 appId**，绝不回 secret（secret 在 DSH 凭据服务里，面板只报「已配置/未配置」）。
   * 读的是 dsh-im 自己的文件，不另存一份 —— 否则两边会不一致，界面上看到 A、实际跑的是 B。
   */
  async function handleChannelsGet(res) {
    const config = await readJson(QQ_CONFIG, { version: 1, bots: [] })
    const workspaces = await readJson(QQ_WORKSPACES, { version: 2, workspaces: {}, aliases: {} })
    const bots = (Array.isArray(config.bots) ? config.bots : []).map((bot) => ({
      botId: bot.botId,
      appIdMasked: maskAppId(bot.appId),
      appId: bot.appId,
      ownerUserOpenid: bot.ownerUserOpenid,
      alias: (workspaces.aliases && workspaces.aliases[bot.botId]) || '',
      workspace: (workspaces.workspaces && workspaces.workspaces[bot.botId]) || '',
      secretRef: bot.secretRef,
    }))
    return sendJson(res, 200, {
      ok: true,
      configPath: QQ_CONFIG,
      workspacesPath: QQ_WORKSPACES,
      bots,
    })
  }

  /**
   * PUT /dsh-tingxue-ui/channels
   *   { botId, alias?, workspace?, appId?, appSecret? }
   *
   * 三条安全线：
   *  1. 只改 workspaces.json 的 alias/workspace 是**低风险**操作，直接做；
   *  2. 改 appId 等于换一个 bot（botId 由 appId 算出），旧 bot 的绑定不动，新 bot 需要重新绑定 —— 这是语义，不是 bug；
   *  3. appSecret 写进 DSH 凭据服务（和 dsh-im 同一处），**不落 config.json**，也不回显。
   * 每次写之前留一份 .bak，写失败原样还原。
   */
  async function handleChannelsPut(req, res, hostCtx) {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '只允许本机 loopback 访问' })
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { return sendJson(res, 400, { ok: false, error: '请求体不是 JSON' }) }
    const botId = String(body.botId || '').trim()
    if (!botId) return sendJson(res, 400, { ok: false, error: '缺少 botId' })

    const config = await readJson(QQ_CONFIG, { version: 1, bots: [] })
    const workspaces = await readJson(QQ_WORKSPACES, { version: 2, workspaces: {}, aliases: {} })
    const bot = (Array.isArray(config.bots) ? config.bots : []).find((b) => b.botId === botId)
    if (!bot) return sendJson(res, 404, { ok: false, error: `没有这个 bot：${botId}` })

    const notes = []
    const backups = new Map()
    const snapshot = async (p) => { if (!backups.has(p)) backups.set(p, await readFile(p, 'utf8').catch(() => null)) }
    const restore = async () => {
      for (const [p, content] of backups) {
        try { if (content === null) { try { await unlink(p) } catch { /* 本来就不存在 */ } } else await writeFile(p, content, 'utf8') } catch { /* 还原失败只能记日志 */ }
      }
    }

    try {
      // ① 别名 / 工作区（写 workspaces.json）
      if (body.alias !== undefined || body.workspace !== undefined) {
        await snapshot(QQ_WORKSPACES)
        workspaces.version = workspaces.version || 2
        workspaces.aliases = workspaces.aliases || {}
        workspaces.workspaces = workspaces.workspaces || {}
        if (body.alias !== undefined) {
          const alias = String(body.alias).trim()
          if (alias) workspaces.aliases[botId] = alias
          else delete workspaces.aliases[botId]
        }
        if (body.workspace !== undefined) {
          const ws = String(body.workspace).trim()
          if (ws) workspaces.workspaces[botId] = ws
          else delete workspaces.workspaces[botId]
        }
        await writeJsonAtomic(QQ_WORKSPACES, workspaces)
        notes.push('别名 / 工作区已保存')
      }

      // ② appId（换 bot）：重算 botId/secretRef，旧条目保留（它的绑定还挂在旧 id 上）
      let targetBotId = botId
      if (body.appId !== undefined && String(body.appId).trim() && String(body.appId).trim() !== bot.appId) {
        const identity = deriveQqIdentity(body.appId)
        if (identity.botId === botId) {
          notes.push('appId 没变')
        } else {
          await snapshot(QQ_CONFIG)
          const exists = config.bots.some((b) => b.botId === identity.botId)
          if (exists) {
            notes.push(`已存在同一个 appId 的 bot（${identity.botId}），未新建`)
          } else {
            config.bots.push({
              botId: identity.botId,
              appId: String(body.appId).trim(),
              secretRef: identity.secretRef,
              ownerUserOpenid: String(body.ownerUserOpenid || bot.ownerUserOpenid || '*').trim(),
              createdAt: new Date().toISOString(),
              connectedAt: null,
            })
            // 新 bot 默认继承旧 bot 的工作区与别名，省一次配置
            workspaces.workspaces = workspaces.workspaces || {}
            workspaces.aliases = workspaces.aliases || {}
            if (!workspaces.workspaces[identity.botId] && workspaces.workspaces[botId]) workspaces.workspaces[identity.botId] = workspaces.workspaces[botId]
            if (!workspaces.aliases[identity.botId] && workspaces.aliases[botId]) workspaces.aliases[identity.botId] = workspaces.aliases[botId]
            await snapshot(QQ_WORKSPACES)
            await writeJsonAtomic(QQ_CONFIG, config)
            await writeJsonAtomic(QQ_WORKSPACES, workspaces)
            targetBotId = identity.botId
            notes.push(`已新增 bot ${identity.botId}（appId 变了所以是一个新 bot，旧 bot 的绑定不动）`)
          }
        }
      }

      // ③ appSecret → DSH 凭据服务（与 dsh-im 同一处）
      if (body.appSecret !== undefined && String(body.appSecret).trim()) {
        let credentials
        try { credentials = typeof hostCtx?.get === 'function' ? hostCtx.get('credentials') : undefined } catch { credentials = undefined }
        if (!credentials || typeof credentials.set !== 'function') {
          notes.push('本机没有 credentials 服务，App Secret 未保存（其余字段已保存）')
        } else {
          const ref = (config.bots.find((b) => b.botId === targetBotId) || bot).secretRef
          await credentials.set(ref, String(body.appSecret).trim())
          notes.push('App Secret 已写入 DSH 凭据服务（不回显）')
        }
      }

      return sendJson(res, 200, { ok: true, botId: targetBotId, notes })
    } catch (error) {
      await restore()
      return sendJson(res, 500, { ok: false, error: `保存失败，已还原：${String(error?.message ?? error)}` })
    }
  }

  /**
   * 拉模型列表。请求体里的 baseURL / apiKey 是**表单当前值**（可能还没保存），
   * 这样用户刚填进去的端点也能立刻试，不用先保存再回来。
   *
   * 安全：key 只用于这一次询问，不落盘、不回显、不进 URL。
   */
  async function handleModels(req, res) {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '只允许本机 loopback 访问' })
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { return sendJson(res, 400, { ok: false, error: '请求体不是 JSON' }) }
    const baseURL = trimSlash(body.baseURL)
    if (!baseURL) return sendJson(res, 400, { ok: false, error: '先填 API Base URL（例如 https://cdn.sta1n.cn/v1）' })
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    const url = baseURL.replace(/\/+$/, '') + '/models'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    try {
      const upstream = await fetch(url, {
        signal: controller.signal,
        headers: apiKey ? { authorization: `Bearer ${apiKey}`, accept: 'application/json' } : { accept: 'application/json' },
      })
      const text = await upstream.text()
      if (!upstream.ok) {
        return sendJson(res, 502, {
          ok: false,
          error: `端点返回 ${upstream.status}${/401|403/.test(String(upstream.status)) ? '（多半是 API Key 不对；Key 只在内存里，没保存过就填一次再试）' : ''}`,
          detail: text.slice(0, 400),
        })
      }
      let parsed
      try { parsed = JSON.parse(text) } catch { return sendJson(res, 502, { ok: false, error: '端点返回的不是 JSON（可能不是 OpenAI 兼容协议）', detail: text.slice(0, 200) }) }
      const raw = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : []
      const models = raw.map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter((x) => typeof x === 'string' && x.trim())
      if (models.length === 0) return sendJson(res, 502, { ok: false, error: '端点没返回任何模型（data/models 都是空的）' })
      models.sort()
      return sendJson(res, 200, { ok: true, models, count: models.length })
    } catch (error) {
      const reason = error?.name === 'AbortError' ? '请求超时（20s）' : String(error?.message ?? error)
      return sendJson(res, 502, { ok: false, error: `拉取失败：${reason}` })
    } finally {
      clearTimeout(timer)
    }
  }

  async function handlePing(req, res) {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '面板探活只允许本机 loopback 访问' })
    const [memory] = await Promise.all([
      probe(memoryOrigin, '/health'),
    ])
    return sendJson(res, 200, {
      ok: true,
      memory: { ...memory, origin: memoryOrigin },
      at: Date.now(),
    })
  }

  async function handlePanel(req, res, ctx) {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '面板配置只允许本机 loopback 访问' })
    const method = String(req.method ?? 'GET').toUpperCase()
    const settings = await readSettings()

    if (method === 'GET' || method === 'HEAD') {
      let workspace = ''
      try {
        workspace = String(ctx?.get?.('workingDirectory')?.defaultDirectory ?? '') || process.cwd()
      } catch {
        workspace = process.cwd()
      }
      return sendJson(res, 200, {
        ok: true,
        settings,
        workspace,
        skillsDir: settings.agent.skillsDir,
        archives: await listArchives(settings.agent.skillsDir),
        memoryServiceUrl: memoryOrigin,
        settingsFile: settingsFile(),
      })
    }

    if (method !== 'PUT' && method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: `不支持的请求方法 ${method}` }, { Allow: 'GET, HEAD, PUT, POST' })
    }

    let body = {}
    try {
      const text = (await readBody(req)).toString('utf8')
      body = text ? JSON.parse(text) : {}
    } catch {
      return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    }

    const patch = body && typeof body.settings === 'object' && body.settings !== null ? body.settings : null
    if (!patch) return sendJson(res, 400, { ok: false, error: '缺少 settings 字段' })

    const merged = normalizeSettings({
      companion: { ...settings.companion, ...(patch.companion ?? {}) },
      agent: { ...settings.agent, ...(patch.agent ?? {}) },
    })

    try {
      await writeSettings(merged)
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: `写入面板配置失败：${String(error?.message ?? error)}` })
    }

    return sendJson(res, 200, {
      ok: true,
      settings: merged,
      savedAt: Date.now(),
      settingsFile: settingsFile(),
    })
  }

  async function handleClientReport(req, res) {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '自检回报只允许本机 loopback 访问' })
    const method = String(req.method ?? 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD') {
      return sendJson(res, 200, { ok: true, report: clientReport, at: clientReport ? clientReport.at : null })
    }
    if (method !== 'POST' && method !== 'PUT') {
      return sendJson(res, 405, { ok: false, error: `不支持的请求方法 ${method}` }, { Allow: 'GET, HEAD, POST, PUT' })
    }
    try {
      const text = (await readBody(req)).toString('utf8')
      clientReport = { ...JSON.parse(text || '{}'), at: Date.now() }
    } catch {
      return sendJson(res, 400, { ok: false, error: '回报内容不是合法 JSON' })
    }
    return sendJson(res, 200, { ok: true, at: clientReport.at })
  }

  /** 找到 compaction-basic 这一行，并合并出它当前生效的原始配置。 */
  function findCompaction(editor) {
    const rows = typeof editor.configuration === 'function' ? editor.configuration() : []
    const list = Array.isArray(rows) ? rows : []
    const idOf = (row) => String(row?.entry?.options?.id ?? '')
    const row = list.find((item) => idOf(item) === COMPACTION_ENTRY)
      ?? list.find((item) => idOf(item).endsWith(COMPACTION_ENTRY))
    if (!row) return null
    const plain = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
    const effective = {
      ...plain(row.inherited),
      ...plain(row.override),
      ...plain(row.entry?.options?.config),
    }
    return { row, effective }
  }

  /** 上下文压缩设置：读 compaction-basic 当前值，写回 profile 配置（经 configEditor）。 */
  async function handleContext(req, res) {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '上下文设置只允许本机 loopback 访问' })

    let editor
    try { editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined } catch { editor = undefined }
    if (!editor || typeof editor.edit !== 'function' || typeof editor.configuration !== 'function') {
      return sendJson(res, 200, {
        ok: true,
        available: false,
        entryId: COMPACTION_ENTRY,
        reason: '宿主没有 configEditor 服务，改不了全局压缩设置',
      })
    }

    let found
    try { found = findCompaction(editor) } catch (error) {
      return sendJson(res, 200, {
        ok: true,
        available: false,
        entryId: COMPACTION_ENTRY,
        reason: `读取压缩配置失败：${String(error?.message ?? error)}`,
      })
    }
    if (!found) {
      return sendJson(res, 200, {
        ok: true,
        available: false,
        entryId: COMPACTION_ENTRY,
        reason: '当前 profile 没有 compaction-basic 入口（自动压缩未启用）',
      })
    }

    /** 配置层阈值 → 整数百分比；没有显式配置时给框架默认 80。 */
    const ratioPercent = (value) => (typeof value === 'number' && Number.isFinite(value)
      ? Math.min(COMPACTION_RATIO_MAX, Math.max(COMPACTION_RATIO_MIN, Math.round(value * 100)))
      : COMPACTION_RATIO_DEFAULT)

    const method = String(req.method ?? 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD') {
      return sendJson(res, 200, {
        ok: true,
        available: true,
        entryId: COMPACTION_ENTRY,
        compactionRatio: ratioPercent(found.effective.thresholdRatio),
        thresholdRatio: typeof found.effective.thresholdRatio === 'number' ? found.effective.thresholdRatio : null,
        retainRatio: typeof found.effective.retainRatio === 'number' ? found.effective.retainRatio : null,
        auto: typeof found.effective.auto === 'boolean' ? found.effective.auto : null,
      })
    }
    if (method !== 'PUT' && method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: `不支持的请求方法 ${method}` }, { Allow: 'GET, HEAD, PUT, POST' })
    }

    let body = {}
    try {
      const text = (await readBody(req)).toString('utf8')
      body = text ? JSON.parse(text) : {}
    } catch {
      return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    }

    /** 面板只接受 10–95 的整数百分比；越界一律 400，不写半截。 */
    const readCompactionRatio = (value) => {
      if (value === undefined || value === null || value === '') return undefined
      const number = Number(value)
      if (!Number.isInteger(number) || number < COMPACTION_RATIO_MIN || number > COMPACTION_RATIO_MAX) {
        throw new Error(`compactionRatio 必须是 ${COMPACTION_RATIO_MIN}–${COMPACTION_RATIO_MAX} 的整数百分比（收到 ${String(value)}）`)
      }
      return number
    }

    const readRatio = (value, name) => {
      if (value === undefined || value === null || value === '') return undefined
      const number = Number(value)
      if (!Number.isFinite(number) || number < 0 || number > 1) {
        throw new Error(`${name} 必须在 0 到 1 之间`)
      }
      return number
    }

    let compactionRatio
    let thresholdRatio
    let retainRatio
    try {
      compactionRatio = readCompactionRatio(body.compactionRatio)
      // compactionRatio 优先；兼容老客户端直接传 thresholdRatio 的写法。
      thresholdRatio = compactionRatio !== undefined
        ? compactionRatio / 100
        : readRatio(body.thresholdRatio, 'thresholdRatio')
      retainRatio = readRatio(body.retainRatio, 'retainRatio')
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
    if (thresholdRatio === undefined && retainRatio === undefined) {
      return sendJson(res, 400, { ok: false, error: '没有要写入的字段（compactionRatio / retainRatio）' })
    }

    try {
      await editor.edit(found.row.entry, (current) => {
        const next = { ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}) }
        if (thresholdRatio !== undefined) next.thresholdRatio = thresholdRatio
        if (retainRatio !== undefined) next.retainRatio = retainRatio
        return next
      })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: `写入压缩配置失败：${String(error?.message ?? error)}` })
    }

    // 落盘后重新读一遍：返回的是配置层回读值，不是「我以为写了什么」。
    let after
    try { after = findCompaction(editor) } catch { after = null }
    const effective = after?.effective ?? {}
    if (thresholdRatio !== undefined) {
      const actual = typeof effective.thresholdRatio === 'number' ? Math.round(effective.thresholdRatio * 100) : null
      const expected = Math.round(thresholdRatio * 100)
      if (actual !== expected) {
        return sendJson(res, 500, {
          ok: false,
          error: `写入后回读不一致：期望 ${expected}%，配置层是 ${actual === null ? '未设置' : `${actual}%`}`,
        })
      }
    }

    return sendJson(res, 200, {
      ok: true,
      available: true,
      entryId: COMPACTION_ENTRY,
      saved: true,
      compactionRatio: ratioPercent(effective.thresholdRatio),
      thresholdRatio: typeof effective.thresholdRatio === 'number' ? effective.thresholdRatio : null,
      retainRatio: typeof effective.retainRatio === 'number' ? effective.retainRatio : null,
      savedAt: Date.now(),
    })
  }

  return {
    memoryOrigin,
    graphOrigin,
    routes: [
      { kind: 'prefix', path: MEMORY_PREFIX, handler: handleProxy },
      { kind: 'prefix', path: GRAPH_PREFIX, handler: handleGraphProxy },
      { kind: 'exact', path: SERVICE_START_PATH, handler: handleServiceStart },
      { kind: 'exact', path: PING_PATH, handler: handlePing },
      { kind: 'exact', path: PANEL_PATH, handler: (req, res) => handlePanel(req, res, ctx) },
      { kind: 'exact', path: CONTEXT_PATH, handler: handleContext },
      { kind: 'exact', path: MODELS_PATH, handler: handleModels },
      { kind: 'exact', path: CHANNELS_PATH, handler: (req, res) => (String(req.method).toUpperCase() === 'GET'
        ? handleChannelsGet(res)
        : handleChannelsPut(req, res, ctx)) },
      { kind: 'exact', path: CLIENT_REPORT_PATH, handler: handleClientReport },
    ],
  }
}

export function apply(ctx, config = {}) {
  const { routes } = createRoutes(config ?? {}, ctx)
  const disposers = []

  const mount = (webServer) => {
    if (!webServer || typeof webServer.register !== 'function') return
    for (const route of routes) {
      try {
        disposers.push(webServer.register(route))
      } catch (error) {
        try { console.warn('[dsh-tingxue-ui] 注册路由失败', route.path, error?.message ?? error) } catch { /* 忽略 */ }
      }
    }
  }

  let webServer
  try { webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined } catch { webServer = undefined }
  if (webServer) {
    mount(webServer)
  } else {
    // webServer 还没就绪：等它出现再挂（宿主没有该服务时回调不会触发，插件照常卸载）。
    try {
      ctx.inject(['webServer'], (hostCtx) => {
        const resolved = hostCtx?.webServer
          ?? (typeof hostCtx?.get === 'function' ? hostCtx.get('webServer') : undefined)
        mount(resolved)
      })
    } catch (error) {
      try { console.warn('[dsh-tingxue-ui] 无法等待 webServer', error?.message ?? error) } catch { /* 忽略 */ }
    }
  }

  ctx.effect(() => () => {
    while (disposers.length > 0) {
      const dispose = disposers.pop()
      try { dispose() } catch { /* 卸载期间忽略 */ }
    }
  })
}
