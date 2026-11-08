// dsh-tingxue src/models/index.mjs
// 模型适配层：把 embedding 与语义推理（小 LLM）抽象成统一接口。
// 你随时换模型/供应商，只需实现本接口，插件逻辑零改动。
//
// 接口契约：
//   embed(texts: string[]): Promise<number[][]>   —— 文本 → 向量（同库单一模型，维度一致）
//   complete(prompt: string, opts?): Promise<string> —— 小 LLM 语义推理（实体抽取/摘要/关联）
//
// 实现选择（config.modelBackend）：
//   'sta1n'   —— 走 sta1n 供应商（openai-completions），用 flash-lite 小模型，零部署
//   'local'   —— 走本地 OpenAI 兼容端点（ollama/llama.cpp），你自选模型
//   'custom'  —— 完全自定义（实现 src/models/custom.mjs 的 createCustomModel）
//
// 所有实现都通过 fetch 调用 OpenAI 兼容 /v1/embeddings 与 /v1/chat/completions，
// 因此本地 ollama/llama.cpp 与 sta1n 共用同一套协议。

/**
 * 创建模型适配器。
 * @param {object} config - { modelBackend, embeddingModel, llmModel, baseURL, apiKey, embeddingDimensions }
 * @param {object} deps - { logger, resolveApiKey, getApiKey, getBaseURL }
 *   resolveApiKey: async (envName) => string | undefined —— 从 DSH credentials 服务解析 key
 *   getApiKey:     async () => string —— 每次请求重新解析 key（独立服务用它读 secrets.json）
 *   getBaseURL:    async () => string —— 每次请求重新解析端点（独立服务用它读 secrets.json）
 * @returns {object} { embed, complete, listModels, dispose }
 */
export function createModelAdapter(config, deps = {}) {
  const logger = deps.logger
  const warn = (m) => { try { logger?.warn?.('[dsh-tingxue/models]', m) } catch {} }

  const backend = config.modelBackend ?? 'sta1n'
  const embeddingModel = config.embeddingModel ?? 'gemini-embedding-2'
  const llmModel = config.llmModel ?? 'gemini-3.1-flash-lite'
  const dimensions = config.embeddingDimensions

  // 各后端默认端点
  const ENDPOINTS = {
    sta1n: { base: 'https://cdn.sta1n.cn/v1', apiKeyEnv: 'STA1N_API_KEY' },
    local: { base: 'http://127.0.0.1:11434/v1', apiKeyEnv: '' },
    custom: { base: '', apiKeyEnv: '' },
  }
  const ep = ENDPOINTS[backend] ?? ENDPOINTS.sta1n

  // 端点优先级：config.baseURL（非空）> 后端默认。config.baseURL 对所有后端生效，
  // 独立服务还会通过 deps.getBaseURL 提供「面板最新值」（secrets.json）作为更高优先。
  const staticBase = (String(config.baseURL ?? '').trim() || ep.base).replace(/\/+$/, '')

  /**
   * 当前生效的端点。独立记忆服务注入 getBaseURL，面板改完 apiBaseUrl
   * 下一次模型调用就生效（无需重启）；插件入口不注入时用构造时的静态值。
   */
  async function currentBaseURL() {
    if (typeof deps.getBaseURL === 'function') {
      try {
        const value = String((await deps.getBaseURL()) ?? '').trim()
        if (value) return value.replace(/\/+$/, '')
      } catch { /* 回退静态端点 */ }
    }
    return staticBase
  }

  /**
   * 解析 API Key。优先级：
   *   1. deps.getApiKey（独立服务：secrets.json > 环境变量 > .credentials.yaml）
   *   2. config.apiKey（构造时的快照，用于插件入口）
   *   3. DSH credentials 服务
   *   4. 环境变量
   * embedding 与 LLM 两条链路共用本函数，保证同一份 key。
   */
  async function resolveApiKey() {
    if (typeof deps.getApiKey === 'function') {
      try {
        const value = String((await deps.getApiKey()) ?? '').trim()
        if (value) return value
      } catch { /* 回退静态配置 */ }
    }
    if (config.apiKey) return config.apiKey
    if (ep.apiKeyEnv) {
      // 优先用 DSH credentials 服务
      if (typeof deps.resolveApiKey === 'function') {
        try {
          const v = await deps.resolveApiKey(ep.apiKeyEnv)
          if (v) return v
        } catch { /* 回退环境变量 */ }
      }
      try { return process.env[ep.apiKeyEnv] ?? '' } catch { return '' }
    }
    return ''
  }

  /** 错误文本里如果回显了 key（某些服务端会），替换成 *** 再抛。 */
  function redact(text, apiKey) {
    if (!apiKey) return text
    return String(text).split(apiKey).join('***')
  }

  async function post(path, body) {
    const apiKey = await resolveApiKey()
    const base = await currentBaseURL()
    if (!base) throw new Error('模型端点未配置（baseURL 为空，请先在面板配置 API）')
    const headers = { 'Content-Type': 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`模型请求失败 ${res.status}: ${redact(text, apiKey).slice(0, 300)}`)
    }
    return res.json()
  }

  /**
   * 列出端点当前提供的模型（OpenAI 兼容 `GET /v1/models`）。
   *
   * 供设置页的模型选择器用：把「手打模型 id」换成「从端点真实列表里挑」。
   * 端点不实现 /models（部分本地推理框架没有）时抛错，由调用方转成提示，
   * 用户可以继续手填。
   *
   * @returns {Promise<Array<{ id: string, name?: string }>>} 端点顺序的模型列表
   */
  async function listModels() {
    const apiKey = await resolveApiKey()
    const base = await currentBaseURL()
    if (!base) throw new Error('模型端点未配置（baseURL 为空，请先在面板配置 API）')
    const headers = { accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const res = await fetch(`${base}/models`, { method: 'GET', headers })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(
        `模型列表请求失败 ${res.status}${res.status === 401 || res.status === 403 ? '（API Key 无效）' : ''}: ${redact(text, apiKey).slice(0, 200)}`,
      )
    }
    const data = await res.json()
    const rows = Array.isArray(data?.data) ? data.data : []
    return rows
      .map((row) => ({
        id: String(row?.id ?? '').trim(),
        ...(typeof row?.name === 'string' && row.name !== '' ? { name: row.name } : {}),
      }))
      .filter((row) => row.id !== '')
  }

  /** 文本 → 向量。 */
  async function embed(texts) {
    const list = Array.isArray(texts) ? texts : [texts]
    if (list.length === 0) return []
    const data = await post('/embeddings', {
      model: embeddingModel,
      input: list,
    })
    const vectors = (data.data ?? []).map((item) => item.embedding)
    if (dimensions && vectors.length > 0 && vectors[0].length !== dimensions) {
      warn(`向量维度 ${vectors[0].length} 与配置 ${dimensions} 不一致（同库单一模型铁律）`)
    }
    return vectors
  }

  /** 小 LLM 语义推理。 */
  async function complete(prompt, opts = {}) {
    const data = await post('/chat/completions', {
      model: llmModel,
      messages: [
        { role: 'system', content: opts.system ?? 'You are a precise semantic analysis assistant.' },
        { role: 'user', content: prompt },
      ],
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1024,
    })
    return data.choices?.[0]?.message?.content ?? ''
  }

  return {
    embed,
    complete,
    listModels,
    get embeddingModel() { return embeddingModel },
    get llmModel() { return llmModel },
    get dimensions() { return dimensions },
    dispose() { /* 无状态，无需清理 */ },
  }
}
