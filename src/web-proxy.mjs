// dsh-tingxue src/web-proxy.mjs
// 同源反代：把 Web GUI 的同源前缀转发到本机听雪服务，客户端与 iframe 都不需要跨源。
//
// 契约见 service/API.md §7：
//   /dsh-tingxue/graph/*  → http://127.0.0.1:8765/*   （图谱 UI + 静态资源）
//   /dsh-tingxue/memory/* → http://127.0.0.1:8766/*   （记忆管理 API）
//
// 走宿主自己的 webServer（与 GUI 同一个端口、同一个监听地址），因此不另开端口、
// 也没有 CORS 问题。宿主没有 webServer 服务时静默跳过，不抛错、不阻塞插件启动。
//
// 安全边界：
//   - 只接受 loopback 来源（反代的是本机管理接口，不能替远程浏览器转发）；
//   - 只放行契约里的方法；
//   - 上游不可达回 502 JSON，绝不把连接错误抛给宿主（宿主会统一变成 400/断连）。
//
// 关于 `/stats` 别名：API.md §5 的统计端点是上游的 `/memory/stats`，而侧栏页要求
// `/dsh-tingxue/memory/stats`。按「去掉前缀」直译会得到上游 `/stats`（404），
// 所以这里对这一条做显式别名；其余路径仍严格按前缀剥离转发。

/** 设置命名空间 / profile 入口 id：Host 半侧与 patch 都用这同一个键。 */
const SETTINGS_NS = 'dsh-tingxue'

/** `/dsh-tingxue/config` 的精确路径（不是前缀路由的转发目标）。 */
const CONFIG_PATH = '/dsh-tingxue/config'

/**
 * 在 describe() 的结果里找工作表的描述符。
 *
 * 设置服务的 ns 是「profile 入口 id」：本插件的 patch id 是 `dsh-tingxue`，
 * 但宿主也可能把它规范化成 `include:dsh-tingxue` 之类。两种都认，写回时
 * 用找到的那个 ns，避免把用户配置写到不存在的入口上。
 * @param {Array<{ ns: string }>} descriptors
 */
function pickDescriptor(descriptors) {
  if (!Array.isArray(descriptors)) return null
  return descriptors.find((d) => d && d.ns === SETTINGS_NS)
    ?? descriptors.find((d) => d && typeof d.ns === 'string' && d.ns.endsWith(SETTINGS_NS))
    ?? null
}

/**
 * 读/写本插件的设置（`/dsh-tingxue/config`）。
 *
 * 为什么需要它：DSH 0.2.1-rc.5 的浏览器端已经没有 `settingsScope` 服务，
 * 第三方设置卡片拿不到作用域。宿主侧的 `settings` 服务仍在（describe / update /
 * mutate），所以这里把它包成一条同源 HTTP 接口，客户端照旧渲染同一张卡片。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} ctx - 插件根上下文
 */
async function handleConfig(req, res, ctx) {
  const method = String(req.method || 'GET').toUpperCase()
  if (!isLoopback(req)) {
    return sendJson(res, 403, { ok: false, error: '设置接口仅允许本机 loopback 访问' })
  }
  let settings
  try {
    settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
  } catch {
    settings = undefined
  }
  if (!settings || typeof settings.describe !== 'function') {
    return sendJson(res, 503, { ok: false, error: '宿主没有 settings 服务（设置卡片不可用）' })
  }

  const describe = () => pickDescriptor(settings.describe({ redactSecrets: false }))

  if (method === 'GET' || method === 'HEAD') {
    let d
    try {
      d = describe()
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: '读取设置失败：' + String(error?.message ?? error) })
    }
    if (!d) return sendJson(res, 404, { ok: false, error: '设置命名空间未注册（插件可能没有加载 Host 半侧）' })
    return sendJson(res, 200, {
      ok: true,
      status: 'ready',
      writable: true,
      value: d.value ?? {},
      base: d.base ?? {},
      user: d.user ?? {},
      revision: d.revision ?? 0,
      applies: d.applies ?? 'restart',
    })
  }

  if (method !== 'PUT' && method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'method not allowed' }, { Allow: 'GET, HEAD, PUT, POST' })
  }

  let body
  try {
    body = JSON.parse((await readRequestBody(req)).toString('utf8') || '{}')
  } catch {
    return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
  }

  let d
  try {
    d = describe()
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: '读取设置失败：' + String(error?.message ?? error) })
  }
  if (!d) return sendJson(res, 404, { ok: false, error: '设置命名空间未注册' })

  const expectedRevision = typeof body.expectedRevision === 'number' ? body.expectedRevision : d.revision
  try {
    const patch = body && typeof body.patch === 'object' && body.patch !== null ? body.patch : null
    const unset = Array.isArray(body?.unset) ? body.unset.filter((k) => typeof k === 'string') : []
    if (patch && Object.keys(patch).length > 0) {
      await settings.update(d.ns, patch, expectedRevision)
    }
    if (unset.length > 0) {
      const ops = unset.map((key) => ({ op: 'unset', path: [key] }))
      await settings.mutate(d.ns, ops, expectedRevision + (patch ? 1 : 0))
    }
    if (!patch && unset.length === 0) {
      return sendJson(res, 400, { ok: false, error: '没有要写入的字段' })
    }
  } catch (error) {
    return sendJson(res, 409, { ok: false, error: '写入设置失败：' + String(error?.message ?? error) })
  }

  let after
  try {
    after = describe()
  } catch { /* 忽略：回读失败不影响写入结果 */ }
  return sendJson(res, 200, {
    ok: true,
    revision: after?.revision ?? expectedRevision + 1,
    value: after?.value ?? {},
    base: after?.base ?? {},
    user: after?.user ?? {},
  })
}

/** 反代路由表：prefix 由 webServer 以最长前缀匹配；target 只允许 loopback。 */
const PREFIX_ROUTES = [
  {
    kind: 'graph',
    prefix: '/dsh-tingxue/graph',
    target: 'http://127.0.0.1:8765',
    aliases: Object.create(null),
  },
  {
    kind: 'memory',
    prefix: '/dsh-tingxue/memory',
    target: 'http://127.0.0.1:8766',
    aliases: { '/stats': '/memory/stats' },
  },
]

/** 契约要求的方法集合（HEAD 一并接受，按 GET 转发但丢弃响应体）。 */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'])

/** 请求体上限：管理 API 只有 JSON，8 MB 足够且能挡住误传的大文件。 */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024

/** 上游超时：记忆服务偶发慢查询，但不应让 GUI 请求永久挂住。 */
const UPSTREAM_TIMEOUT_MS = 20_000

/**
 * 是否为本机来源。反代只服务本机浏览器/桌面端；远程浏览器不得借道访问管理接口。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isLoopback(req) {
  const address = String(req.socket?.remoteAddress ?? '')
  if (address === '::1') return true
  if (address === '::ffff:127.0.0.1') return true
  if (address.startsWith('127.')) return true
  if (address.startsWith('::ffff:127.')) return true
  return false
}

/**
 * 统一 JSON 响应。响应已结束/客户端断开时静默跳过。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} payload
 * @param {Record<string, string>} [extraHeaders]
 */
function sendJson(res, status, payload, extraHeaders = {}) {
  if (!res || res.writableEnded || res.destroyed) return
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    body = '{"ok":false,"error":"proxy response serialization failed"}'
  }
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(Buffer.byteLength(body)),
      ...extraHeaders,
    })
    res.end(body)
  } catch {
    // 客户端已断开：忽略，避免影响下一次请求。
  }
}

/**
 * 读取请求体（Buffer，保留二进制）。超过上限时 reject（code=body-too-large）。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_REQUEST_BYTES) {
        const error = new Error('request body too large')
        error.code = 'body-too-large'
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * 把同源 URL 拆成「上游路径 + query」。前缀必须整段匹配（等价于 `/prefix` 或
 * `/prefix/...`），剥离后保留 query（`?api=` 等参数图谱 UI 仍然要读）。
 * @param {{ prefix: string, aliases: Record<string, string> }} route
 * @param {string|undefined} requestUrl
 * @returns {{ path: string, search: string }|null}
 */
function splitTargetUrl(route, requestUrl) {
  let url
  try {
    url = new URL(requestUrl || '/', 'http://127.0.0.1')
  } catch {
    return null
  }
  const pathname = url.pathname
  if (pathname !== route.prefix && !pathname.startsWith(route.prefix + '/')) return null
  let path = pathname.slice(route.prefix.length)
  if (path === '') path = '/'
  if (!path.startsWith('/')) path = '/' + path
  const alias = route.aliases[path]
  if (alias) path = alias
  return { path, search: url.search }
}

/** 上游 Location 若指向上游根地址，改写成同源前缀（避免浏览器跳出反代）。 */
function rewriteLocation(location, route) {
  if (location.startsWith(route.target)) {
    const rest = location.slice(route.target.length)
    return route.prefix + (rest.startsWith('/') || rest === '' ? rest : '/' + rest)
  }
  return location
}

/** HTML/JS/CSS/JSON/SVG 属于「改完要立刻看到」的资源，一律 no-store。 */
function isTextualContentType(contentType) {
  const type = String(contentType || '').toLowerCase()
  return type === ''
    || type.includes('text/html')
    || type.includes('text/plain')
    || type.includes('javascript')
    || type.includes('ecmascript')
    || type.includes('text/css')
    || type.includes('application/json')
    || type.includes('image/svg')
}

/**
 * 透传上游响应：status/content-type/body 原样给出，HTML/JS 不缓存。
 * @param {import('node:http').ServerResponse} res
 * @param {{ kind: string, target: string, prefix: string }} route
 * @param {number} status
 * @param {Headers} upstreamHeaders
 * @param {Buffer} payload
 * @param {string} method
 */
function writeUpstreamResponse(res, route, status, upstreamHeaders, payload, method) {
  const headers = {}
  const contentType = upstreamHeaders.get('content-type')
  if (contentType) headers['Content-Type'] = contentType
  const location = upstreamHeaders.get('location')
  if (location) headers.Location = rewriteLocation(location, route)

  const upstreamCache = upstreamHeaders.get('cache-control')
  if (isTextualContentType(contentType) || !upstreamCache) headers['Cache-Control'] = 'no-store'
  else headers['Cache-Control'] = upstreamCache

  headers['X-Dsh-Tingxue-Proxy'] = route.kind
  if (method !== 'HEAD' && status !== 204 && status !== 304) {
    headers['Content-Length'] = String(payload.length)
  }

  try {
    res.writeHead(status, headers)
    res.end(method === 'HEAD' || status === 204 || status === 304 ? undefined : payload)
  } catch {
    // 客户端已断开：忽略。
  }
}

/**
 * 单条反代请求。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {typeof PREFIX_ROUTES[number]} route
 * @returns {Promise<void>}
 */
async function proxyRequest(req, res, route) {
  const method = String(req.method || 'GET').toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    return sendJson(res, 405, { ok: false, error: 'method not allowed' }, {
      Allow: 'GET, HEAD, POST, PATCH, DELETE, OPTIONS',
    })
  }
  if (!isLoopback(req)) {
    return sendJson(res, 403, { ok: false, error: '反代仅允许本机 loopback 访问' })
  }

  const target = splitTargetUrl(route, req.url)
  if (target === null) return sendJson(res, 404, { ok: false, error: 'not found' })

  let requestBody
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    try {
      requestBody = await readRequestBody(req)
    } catch (error) {
      if (error?.code === 'body-too-large') {
        return sendJson(res, 413, { ok: false, error: '请求体过大（上限 8 MB）' })
      }
      return sendJson(res, 400, { ok: false, error: '读取请求体失败' })
    }
  }

  const headers = { accept: req.headers.accept || '*/*' }
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type']
  if (req.headers['accept-language']) headers['accept-language'] = req.headers['accept-language']
  // 条件请求原样透传，让静态资源的 ETag/Last-Modified 校验语义与直连一致。
  if (req.headers['if-none-match']) headers['if-none-match'] = req.headers['if-none-match']
  if (req.headers['if-modified-since']) headers['if-modified-since'] = req.headers['if-modified-since']

  const targetUrl = route.target + target.path + target.search
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, UPSTREAM_TIMEOUT_MS)
  try {
    let upstream
    try {
      upstream = await fetch(targetUrl, {
        method: method === 'HEAD' ? 'GET' : method,
        headers,
        body: requestBody && requestBody.length > 0 ? requestBody : undefined,
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (error) {
      return sendJson(res, 502, {
        ok: false,
        error: '上游服务不可达：' + String(error?.message ?? error),
        target: route.target,
        code: 'proxy-unreachable',
      })
    }

    const status = upstream.status
    let payload = Buffer.alloc(0)
    if (method !== 'HEAD' && status !== 204 && status !== 304) {
      try {
        payload = Buffer.from(await upstream.arrayBuffer())
      } catch (error) {
        return sendJson(res, 502, {
          ok: false,
          error: '读取上游响应失败：' + String(error?.message ?? error),
          target: route.target,
          code: 'proxy-response-failed',
        })
      }
    }
    writeUpstreamResponse(res, route, status, upstream.headers, payload, method)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 挂载听雪同源反代。
 *
 * 注册两条 `prefix` 路由：`/dsh-tingxue/graph` 与 `/dsh-tingxue/memory`。
 * 宿主没有 webServer 时静默跳过；路由注册失败（例如前缀被占用）只告警。
 *
 * @param {object} ctx - 插件根上下文（需要 webServer 服务 / ctx.inject）
 * @returns {() => void} disposer：释放两条路由与等待中的 inject fiber
 */
export function registerTingxueWeb(ctx) {
  if (!ctx || typeof ctx !== 'object') return () => {}

  let disposeRoutes = null
  let fiber = null

  const warn = (message) => {
    try { ctx.logger?.warn?.('[dsh-tingxue/web-proxy]', message) } catch { /* logger 不可用 */ }
  }

  /** 在拿到 webServer 后注册两条路由；返回释放函数，失败返回 null。 */
  const mount = (webServer) => {
    if (!webServer || typeof webServer.register !== 'function') return null
    const disposers = []
    try {
      // 设置读写（同源，仅 loopback）。客户端设置卡片靠它，不再依赖
      // 本构建已移除的 `settingsScope` 服务。
      disposers.push(webServer.register({
        kind: 'prefix',
        path: CONFIG_PATH,
        handler: (req, res) => {
          const pathname = String(req.url || '').split('?')[0]
          if (pathname !== CONFIG_PATH && pathname !== CONFIG_PATH + '/') {
            return sendJson(res, 404, { ok: false, error: 'not found' })
          }
          handleConfig(req, res, ctx).catch((error) => {
            warn(`设置接口处理失败: ${error?.message ?? error}`)
            sendJson(res, 500, { ok: false, error: '设置接口处理失败' })
          })
        },
      }))
      for (const route of PREFIX_ROUTES) {
        disposers.push(webServer.register({
          kind: 'prefix',
          path: route.prefix,
          handler: (req, res) => {
            proxyRequest(req, res, route).catch((error) => {
              warn(`反代 ${route.prefix} 处理失败: ${error?.message ?? error}`)
              sendJson(res, 502, { ok: false, error: '反代处理失败', code: 'proxy-failure' })
            })
          },
        }))
      }
      try {
        ctx.logger?.info?.(
          '[dsh-tingxue/web-proxy] 同源反代已挂载：/dsh-tingxue/graph → 127.0.0.1:8765，'
          + '/dsh-tingxue/memory → 127.0.0.1:8766',
        )
      } catch { /* logger 不可用 */ }
      return () => {
        for (const dispose of disposers.splice(0)) {
          try { dispose() } catch { /* 已释放 */ }
        }
      }
    } catch (error) {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* 已释放 */ }
      }
      warn(`反代路由注册失败（前缀可能已被占用）: ${error?.message ?? error}`)
      return null
    }
  }

  try {
    // 宿主通常已经挂好 webServer；直接取得时同步注册，避免路由晚一拍才生效。
    let existing
    try {
      existing = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    } catch {
      existing = undefined
    }
    if (existing) disposeRoutes = mount(existing)

    // webServer 尚未就绪（或加载顺序不定）时等它出现；无此服务则回调永不触发。
    if (!disposeRoutes && typeof ctx.inject === 'function') {
      fiber = ctx.inject(['webServer'], (hostCtx) => {
        const webServer = hostCtx?.webServer
          ?? (typeof hostCtx?.get === 'function' ? hostCtx.get('webServer') : undefined)
        if (!webServer) return
        disposeRoutes = mount(webServer)
      })
    }

    if (!disposeRoutes && !fiber) {
      // 静默跳过：客户端页仍能打开（接口会 502），但插件不因缺少 webServer 失败。
      try { ctx.logger?.debug?.('[dsh-tingxue/web-proxy] 宿主没有 webServer，跳过同源反代') } catch { /* 忽略 */ }
    }
  } catch (error) {
    warn(`同源反代挂载失败（不致命）: ${error?.message ?? error}`)
  }

  return () => {
    try { disposeRoutes?.() } catch { /* 已释放 */ }
    try { fiber?.dispose?.() } catch { /* 已释放 */ }
    disposeRoutes = null
    fiber = null
  }
}
