// dsh-tingxue src/plugin-entry.mjs
// 听雪 · 双模式虚拟生命系统 — 插件入口。
// 组装：模型适配层 → LanceDB 记忆存储 → 关系图谱 → 状态管理 → 命令处理 → agent 服务。
// 通过 agent/pre-step 瀑布拦截关键词命令，通过 systemPrompt.section 注入四块上下文。

import { createModelAdapter } from './models/index.mjs'
import { createMemoryStore } from './memory/store.mjs'
import { createGraphService } from './graph/index.mjs'
import { createStateManager } from './state/index.mjs'
import { createCommandHandler } from './commands/index.mjs'
import { createAgentService } from './agent/index.mjs'
import { assembleContext, blocksToSystemText } from './context/assemble.mjs'
import { createContextCache, installContextInjection } from './context/inject.mjs'
import { join, basename } from 'node:path'
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import { getBinding, notifierStateDir, setAgentRoute, deleteAgentRoute, setBinding, isAgentSessionId, setNotifierPrefs } from './bind/index.mjs'
import { createGraphDashboard } from './graph-dashboard/index.mjs'
import { createMemoryService } from './memory-service/index.mjs'
import { mountModelCatalogRoutes } from './model-catalog/index.mjs'
import { installTingxueSettings } from './settings/index.mjs'

export const name = 'dsh-tingxue'
// 所有依赖均通过 ctx.get() 可选获取，不声明硬依赖，避免阻塞宿主启动。

export function apply(ctx, config = {}) {
  const logger = ctx?.logger
  const warn = (m) => { try { logger?.warn?.('[dsh-tingxue]', m) } catch {} }
  const info = (m) => { try { logger?.info?.('[dsh-tingxue]', m) } catch {} }

  // 解析配置（init() 里注册完 settings 命名空间后会重读一次，让用户层配置生效）
  let dataDir = config.dataDir || join(process.cwd(), '.dsh-tingxue')
  let profilePath = config.profilePath || ''
  let modelBackend = config.modelBackend ?? 'sta1n'
  let embeddingModel = config.embeddingModel ?? 'gemini-embedding-2'
  let llmModel = config.llmModel ?? 'gemini-3.1-flash-lite'
  let embeddingDimensions = config.embeddingDimensions

  const disposers = []
  let store = null
  let model = null
  let graph = null
  let state = null
  let commands = null
  let agentService = null
  let ready = false
  let chatSessionId = null
  let dashboardUrl = null
  let memoryServiceUrl = null
  // 待归档的 agent 对话（agent 模式退出时归档）
  const pendingAgentRounds = []
  // 工作副本/中间产物路径（QQ 附件下载到 workcopy 后登记；/agentstop 按 fileDeleteScope 清理）
  const workFiles = []

  /**
   * 从 DSH 凭据服务解析一个环境变量名对应的 key。
   *
   * 每次调用都重新 `ctx.get('credentials')`，绝不闭包捕获：init 早于
   * credentials 挂载时闭包会固定成 undefined，之后每次取 key 都 401。
   * 模型适配层与模型目录路由共用这一份解析，保证「选择器问到的端点/key」
   * 与「真正发请求时用的」完全一致。
   * @param {string} envName - 凭据名（如 STA1N_API_KEY）
   * @returns {Promise<string|undefined>}
   */
  async function resolveApiKey(envName) {
    const credentials = ctx.get('credentials')
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve(envName)
        return resolved?.value
      } catch { /* 回退环境变量 */ }
    }
    return undefined
  }

  /**
   * 把设置侧边栏里的两个通知开关物化到 dsh-notifier 的 state（`prefs:tingxue`）。
   *
   * 为什么走 state 而不是改 dsh-notifier 的 profile 配置：dsh-notifier 的推送行为由
   * 「tasks 补丁」（patches/dsh-notifier.patch）读取该键决定，键级合并写、500ms 读收敛，
   * 开关一改就热生效，不需要重启也不需要动 profile 的 YAML。
   *  - statusNotice: 是否发「任务开始/完成/中止、心跳、疑似卡住」等状态提示
   *  - approvalAllowlistOnly: 审批是否只推给被显式放行出站的会话
   */
  async function applyNotifierPrefs() {
    try {
      const stateFile = config.notifierStateFile || join(notifierStateDir(), 'state.json')
      const ok = await setNotifierPrefs({
        statusNotice: config.qqStatusNotice !== false,
        approvalAllowlistOnly: config.approvalAllowlistOnly !== false,
      }, stateFile)
      if (!ok) warn('通知偏好写盘失败（dsh-notifier 通知开关可能未生效）')
    } catch (e) {
      warn(`通知偏好写入异常（不影响对话）: ${e.message}`)
    }
  }

  /**
   * 自愈：把绑定会话恢复成 live agent（若它是冷会话）。
   *
   * 背景：web 环境会话是惰性恢复的——只有桌面端 UI 打开某会话时才被
   * `ctx.agents.resume()` 恢复成 live agent。而 dsh-notifier 的 QQ 投递和
   * /status 直接用 `ctx.agents.get()` 判断，冷会话不在 live 列表 → QQ 消息
   * 报「会话不存在或已退出」、/status 报「未找到」。
   *
   * 这里在插件启动时把绑定会话恢复成 live agent，QQ 一进来就能投递。
   * 恢复时 mount 会话记录的 agent preset（standard），保证工具/人格与
   * 桌面端打开时一致；并注入听雪上下文 section（与聊天会话同款）。
   *
   * 幂等：若会话已是 live agent 则跳过；resume 失败只告警不致命。
   */
  function startSelfHeal() {
    const target = chatSessionId
    if (!target) return
    // 等 agents / agentPresets / sessionPersistence 服务就绪后再恢复
    const fiber = ctx.inject(['agents', 'agentPresets', 'sessionPersistence'], async (childCtx) => {
      try {
        const agents = childCtx.agents
        const presets = childCtx.agentPresets
        const persistence = childCtx.sessionPersistence
        // 已是 live agent：无需恢复
        let live = null
        try { live = agents.get(target) } catch { live = null }
        if (live !== undefined && live !== null) {
          info(`聊天会话已是 live agent，无需自愈：${target}`)
          return
        }
        // 确认会话在持久化存储里存在（冷会话）
        let stored = null
        try {
          const list = await persistence.list()
          stored = (Array.isArray(list) ? list : []).find((h) => h?.id === target) ?? null
        } catch (e) {
          warn(`自愈：读取持久化会话列表失败: ${e.message}`)
        }
        if (stored === null) {
          warn(`自愈：会话 ${target} 不在持久化存储中，跳过恢复`)
          return
        }
        // 读取会话记录的 preset（与桌面端恢复一致），默认 standard
        let presetId = 'standard'
        try {
          const inspected = await persistence.inspect(target)
          const header = inspected?.meta
          const events = inspected?.events
          if (header?.agentPreset) presetId = header.agentPreset
          // 若日志里有 agent-preset/selected 事件，以最新为准
          if (Array.isArray(events)) {
            for (let i = events.length - 1; i >= 0; i -= 1) {
              if (events[i]?.type === 'agent-preset/selected' && events[i]?.data?.agentPreset) {
                presetId = events[i].data.agentPreset
                break
              }
            }
          }
        } catch (e) {
          warn(`自愈：读取会话 preset 失败，回落 standard: ${e.message}`)
        }
        // 恢复成 live agent
        // 默认模型：优先用配置显式 provider/model，否则用 DSH 的 agentDefaultModel 当前选择。
        // 必须提供 model，否则 deployment:persona 的 {{model}} 模板变量无值 → 会话无法回复。
        const dm = (() => {
          try { return childCtx.get('agentDefaultModel')?.currentSelection?.() ?? {} } catch { return {} }
        })()
        const provider = config.provider ?? dm.provider
        const model = config.model ?? dm.model
        const handle = await agents.resume({
          resumeSessionId: target,
          agentOptions: { provider, model },
          setup: async (agentCtx) => {
            // 1. mount 会话记录的 agent preset（保证工具/人格与桌面端一致）
            try {
              if (presets && typeof presets.mount === 'function') {
                await presets.mount(agentCtx, presetId)
              }
            } catch (e) {
              warn(`自愈：mount preset ${presetId} 失败: ${e.message}`)
            }
            // 2. 听雪上下文 section 不再在 setup 里注入：
            //    /agent/created 监听器会在会话发布后、依据 agent.id===chatSessionId
            //    在聊天会话自己的作用域注册，避免重复注册同名 section 抛错。
          },
        })
        if (handle?.agent) {
          info(`自愈成功：聊天会话已恢复为 live agent（preset=${presetId}）：${target}`)
        }
      } catch (e) {
        warn(`自愈失败（不致命）: ${e.message}`)
      }
    })
    disposers.push(() => { try { fiber?.dispose?.() } catch {} })
  }

  // 初始化（异步，失败不致命）
  async function init() {
    try {
      // 0. 注册 settings 命名空间（设置卡片 Host 半侧），然后重读配置。
      //    这样 Web 设置页里保存的用户层配置能在本次启动就生效；
      //    无 settings 服务的宿主下此步直接返回 false，配置按 cordis.patch.yml 走。
      try {
        const ok = await installTingxueSettings(ctx, config, {
          warn,
          // 每次设置保存后立刻把通知开关物化到 dsh-notifier state
          onApply: () => { void applyNotifierPrefs() },
        })
        if (ok) info('settings 命名空间已注册（设置页可配置）')
        // 用户层/默认层已回写到 config，重读一次
        dataDir = config.dataDir || dataDir
        profilePath = config.profilePath || profilePath
        modelBackend = config.modelBackend ?? modelBackend
        embeddingModel = config.embeddingModel ?? embeddingModel
        llmModel = config.llmModel ?? llmModel
        embeddingDimensions = config.embeddingDimensions ?? embeddingDimensions
      } catch (e) {
        warn(`settings 注册异常（不影响运行）: ${e.message}`)
      }

      // 1. 模型适配层（用 DSH credentials 服务解析 key）
      // 注意：credentials 服务必须在每次 resolve 时重新获取（ctx.get），
      // 不能 init 时同步捕获闭包——若 init 早于 credentials 挂载，闭包会固定为
      // undefined，导致后续每次取 key 都失败（401）。契约要求每次操作重新 resolve。
      model = createModelAdapter({
        modelBackend, embeddingModel, llmModel,
        baseURL: config.baseURL, apiKey: config.apiKey,
        embeddingDimensions,
      }, {
        logger,
        resolveApiKey,
      })

      // 2. 确定向量维度：先试一次 embedding
      let dims = embeddingDimensions
      if (!dims) {
        try {
          const probe = await model.embed(['probe'])
          dims = probe[0]?.length
        } catch (e) {
          warn(`向量维度探测失败: ${e.message}，请在配置中显式设置 embeddingDimensions`)
        }
      }
      if (!dims) {
        warn('无法确定向量维度，记忆库不可用（请配置 embeddingDimensions 或检查 embedding 模型）')
        return
      }

      // 3. LanceDB 记忆存储
      store = await createMemoryStore({ dataDir, dimensions: dims, embeddingModel }, { logger })

      // 4. 关系图谱
      // 注意：graph 依赖 store（构造入参，正常 DI，单向）；绝不反向把 store.graph 挂回 graph——
      // 那会形成 store↔graph 双向引用/运行期互相注入。graph 消费方一律通过显式依赖传入。
      graph = createGraphService(store, model, { logger })

      // 5. 状态管理
      state = await createStateManager({ dataDir })

      // 5.1 初始化聊天会话 id
      // 注意：绝不能无条件采用 dsh-notifier 的当前绑定作为 chatSessionId。
      //   bind 在 /agentstart 时会指向 isolate agent 会话（tingxue-agent-*）；
      //   若因 /agentstart → /agentstop 未闭环（或中途崩溃）导致 bind 残留在 agent 会话，
      //   直接采用它会把 chatSessionId 污染成 agent id，之后 /agentstop 回绑就永远回不到聊天会话。
      //   因此：
      //     - 优先用持久化 state 里已有的 chatSessionId（它是聊天会话，绝不带 agent 前缀）；
      //     - 只有当前绑定是「非 agent 前缀」的会话时才更新 chatSessionId；
      //     - 若持久化 chatSessionId 缺失而 bind 却指向 agent 会话，视为残留：清空 bind，
      //       待 /agentstop 的清理逻辑或用户显式绑定来纠正（不在此强行猜一个会话）。
      const notifierStateFile = config.notifierStateFile || join(notifierStateDir(), 'state.json')
      const channel = config.channel ?? 'qq'
      const userId = config.userId ?? ''
      // 已知可信的聊天会话 id（配置显式指定时最强；用于自愈回绑）
      const cfgChat = (() => {
        const v = config.chatSessionId
        return (typeof v === 'string' && v.trim() !== '' && !isAgentSessionId(v)) ? v.trim() : null
      })()
      let chatSessionIdInInit = null
      try {
        chatSessionIdInInit = await getBinding(channel, userId, notifierStateFile)
      } catch (e) {
        warn(`读取当前绑定失败: ${e.message}`)
      }
      // 可信的持久化聊天会话（绝不带 agent 前缀）
      const savedChat = (state.chatSessionId && !isAgentSessionId(state.chatSessionId)) ? state.chatSessionId : null
      const bindIsAgent = !!chatSessionIdInInit && isAgentSessionId(chatSessionIdInInit)
      // 依次优先：配置显式 id > 持久化 id > 非-agent 的当前绑定
      const effectiveChat = cfgChat || savedChat || (!chatSessionIdInInit ? null : (bindIsAgent ? null : chatSessionIdInInit))
      if (effectiveChat) {
        chatSessionId = effectiveChat
        await state.setChatSessionId(effectiveChat)
        info(`聊天会话已绑定：${effectiveChat}`)
        if (chatSessionIdInInit && chatSessionIdInInit !== effectiveChat) {
          // 绑定残留漂移（到 agent 会话或其他会话）：自愈回绑到可信聊天会话
          const ok = await setBinding(channel, userId, effectiveChat, notifierStateFile)
          warn(`绑定自愈：bind:${channel}:${userId} 由 ${chatSessionIdInInit.slice(0, 24)}… 回绑到 ${effectiveChat}（${ok ? '成功' : '失败'}）`)
        }
      } else if (bindIsAgent) {
        // 无可信聊天会话且绑定残留指向 agent 会话：清空绑定键，避免继续污染
        warn(`检测到 bind 残留指向 agent 会话（${chatSessionIdInInit.slice(0, 24)}…），已清空绑定键；请用 /agentstop 或重新绑定聊天会话。`)
        try { await setBinding(channel, userId, '', notifierStateFile) } catch (e) { warn(`清空绑定失败: ${e.message}`) }
      }

      // 5.1.3 自愈：mode 残留为 agent，但 QQ 并未绑到那个隔离会话 → 重置回聊天模式。
      // 背景：/agentstart 建了隔离会话、但 bind 切换没完成（或中途崩溃）时，mode 会永久停在
      // agent。而组装在 agent 模式下返回空 → 聊天会话从此收不到
      // 人格 / 记忆 / 最近对话，QQ 却依旧投递到聊天会话 = 静默丢掉全部上下文（真机实测：
      // 卡住后 system 提示词从 11.6K 掉回 6.8K，听雪的块全部消失）。
      // 判据：agent 模式只有在 QQ 确实绑着该隔离会话时才算数。
      if (state.isAgentMode()) {
        const agentSid = state.agentSessionId
        if (agentSid && chatSessionIdInInit !== agentSid) {
          warn(
            `检测到 mode 残留为 agent（隔离会话 ${String(agentSid).slice(0, 24)}…），` +
            `但 QQ 实际绑定 ${String(chatSessionIdInInit ?? '(空)').slice(0, 24)}… —— ` +
            '已重置回聊天模式，恢复人格/记忆/最近对话注入。'
          )
          try { await state.exitAgent() } catch (e) { warn(`重置聊天模式失败: ${e.message}`) }
        }
      }

      // 5.1.1 自愈：若聊天会话是「冷会话」（磁盘存在但非 live agent），主动 resume 恢复。
      // 背景：web 环境会话是惰性恢复的——只有桌面端 UI 打开某会话时才被 ctx.agents.resume()
      // 恢复成 live agent。而 dsh-notifier 的 QQ 投递和 /status 直接用 ctx.agents.get() 判断，
      // 冷会话不在 live 列表 → QQ 消息报「会话不存在或已退出」、/status 报「未找到」。
      // 这里在插件启动时把绑定会话恢复成 live agent，QQ 一进来就能投递。
      startSelfHeal()

      // 5.1.2 补注入「早于 chatSessionId 确定的 live 聊天会话」。
      // 若聊天会话在插件加载前就已经是 live agent（Web 桌面一直开着、或上一轮插件
      // reload 前就活动），其 /agent/created 事件发生在我们登记监听器之前，
      // 单靠 /agent/created 会漏掉→必须在这里对当前已 live 的聊天会话补一次注入。
      try {
        const agentsSvc = ctx.get('agents')
        if (chatSessionId && agentsSvc && typeof agentsSvc.get === 'function') {
          const live = agentsSvc.get(chatSessionId)
          if (live) injectChatSection(live)
        }
      } catch (e) { warn(`补注入 live 聊天会话失败（agent/created 监听会兜底，但首轮可能缺注入）: ${e.message}`) }

      // 5.2 解决"听雪收到其他 DSH 会话消息"：配置 route:agents 出站分流。
      //  - 所有无关会话 workspace=dsh，用 workspace 键静默掉（channels: []，走精确层即被覆盖）。
      //  - 精确放行听雪聊天会话（agent-exact 层优先于 workspace 层），让听雪/agent 通知仍送达 QQ。
      //  - agent 隔离会话由 /agentstart 动态放行、/agentstop 动态回归静默（commands 里做）。
      //  - 对话回复走独立的入站投递链路，不受 route 静默影响（只影响状态通知/审批/错误广播）。
      try {
        const cfgWorkspace = config.routeWorkspace || 'dsh'
        const wsChannels = config.routeWorkspaceChannels
        if (Array.isArray(wsChannels)) {
          await setAgentRoute(cfgWorkspace, { channels: wsChannels }, notifierStateFile)
        } else if (config.quietOtherWorkspace !== false) {
          // 默认静默整个 workspace（仅聊天的 workspace），避免其他 dsh 会话通知打扰 QQ
          await setAgentRoute(cfgWorkspace, { channels: [] }, notifierStateFile)
        }
        // 精确放行听雪聊天会话（覆盖 workspace 层的静默）
        if (chatSessionId) {
          await setAgentRoute(chatSessionId, { channels: ['qq-bot'] }, notifierStateFile)
          info(`听雪聊天会话出站已放行：${chatSessionId}`)
        }
      } catch (e) {
        warn(`route:agents 配置失败: ${e.message}`)
      }

      // 5.3 通知偏好（设置侧边栏的两个开关）物化到 dsh-notifier state：
      //  - statusNotice=false 时，dsh-notifier 补丁不再发状态提示行（回复正文照常）
      //  - approvalAllowlistOnly=true 时，审批只推给被显式放行的会话（上面刚写好的 route:agents）
      await applyNotifierPrefs()

      // 6. agent 服务（先创建，命令处理器依赖它做归档）
      agentService = createAgentService({ state, memory: store, graph, model, config, logger })

      // 7. 命令处理
      const notifier = ctx.get('notifier')
      const agents = ctx.get('agents')
      // 默认模型选择（供 /agentstart 创建隔离会话时提供 {{model}} 变量）
      let defaultModel = {}
      try {
        defaultModel = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {}
      } catch { defaultModel = {} }
      commands = createCommandHandler({
        state, notifier, agents, config, logger,
        agentService,
        pendingAgentRounds,
        workFiles,
        notifierStateFile,
        channel,
        userId,
        defaultModel,
      })

      // 8. 关系图谱可视化面板（本机可交互，默认开启）
      if (config.graphDashboardEnable !== false) {
        try {
          const dashboard = createGraphDashboard({ store, config, logger })
          const panelUrl = await dashboard.start()
          if (panelUrl) {
            dashboardUrl = panelUrl
            disposers.push(() => dashboard.stop())
          }
        } catch (e) {
          warn(`图谱面板初始化失败: ${e.message}`)
        }
      }

      // 8.1 记忆服务（管家）：DSH 唯一写者，暴露 HTTP API 供 AstrBot 读写记忆库
      if (config.memoryServiceEnable !== false) {
        try {
          const memoryService = createMemoryService({ store, model, graph, profilePath, logger }, config)
          const msUrl = await memoryService.start()
          if (msUrl) {
            memoryServiceUrl = msUrl
            disposers.push(() => memoryService.stop())
          }
        } catch (e) {
          warn(`记忆服务初始化失败: ${e.message}`)
        }
      }

      // 8.2 模型目录路由：设置页的模型选择器靠它问端点当前提供哪些模型。
      //     走宿主自己的 webServer（与 GUI 同一个端口），不另开监听端口，
      //     因此不存在跨源和额外暴露面。宿主没有 webServer 时静默跳过，
      //     选择器退化成手填模型 id。
      try {
        const disposeCatalog = mountModelCatalogRoutes(ctx, { logger, warn, resolveApiKey })
        if (disposeCatalog) disposers.push(disposeCatalog)
      } catch (e) {
        warn(`模型目录路由初始化失败: ${e.message}`)
      }

      ready = true
      info(`初始化完成：dataDir=${dataDir} embedding=${embeddingModel} llm=${llmModel} dims=${dims}`)
    } catch (e) {
      warn(`初始化失败: ${e.message}`)
    }
  }

  // 启动初始化
  init()

  // ---- 命令拦截：agent/pre-step 瀑布 ----
  // 命中 /agentstart /agentstop 则处理并消费（不进入模型），否则放行。
  const preStep = ctx.on('agent/pre-step', async (payload, next) => {
    if (!ready || !commands) return next()
    try {
      const messages = payload.messages ?? []
      // 取最后一条用户消息
      const last = messages[messages.length - 1]
      const text = last?.content?.find?.((b) => b.type === 'text')?.text ?? ''
      if (commands.isCommand(text)) {
        const consumed = await commands.handle(text)
        if (consumed) {
          // 消费：拒绝该 step，不进入模型
          return { kind: 'reject' }
        }
      }
      // 文件接口：检测 [文件] 标记（dsh-notifier 把 QQ attachments 拼成
      // 「[文件] 文件名\n下载地址: url」），下载到 workcopy → 读取内容 → 注入上下文。
      // 聊天模式与 agent 模式都支持；下载失败不阻塞对话（仅告警）。
      const fileMatch = /\[文件\]\s*([^\n]+)\n下载地址:\s*(\S+)/.exec(text)
      if (fileMatch) {
        const fileName = fileMatch[1].trim()
        const fileUrl = fileMatch[2].trim()
        const injected = await downloadAndInjectFile(fileName, fileUrl)
        if (injected) {
          // 把文件内容注入为一条新的用户消息（追加到 messages 末尾），
          // 让模型能看到文件内容；原 [文件] 标记消息保留（含文件名/地址）。
          const contentBlock = { type: 'text', text: injected }
          if (Array.isArray(last?.content)) last.content.push(contentBlock)
          else if (last) last.content = [contentBlock]
        }
      }
    } catch (e) {
      warn(`命令拦截异常: ${e.message}`)
    }
    return next()
  })
  disposers.push(preStep)

  // ---- 上下文注入：section 占位 + 异步瀑布取真值 ----
  //
  // 为什么必须在瀑布里算，而不是「异步预计算 + section.text 同步返回缓存」：
  // agent.ts 的 preStep 先 assemble() 再发 agent/pre-step。而 assemble() 内部是
  // 「同步读 section.text → 再 await system-prompt/assemble 瀑布」，同步读发生在
  // 检索做完之前 —— 缓存只能是上一轮的值。真机表现：人格/记忆块整块时有时无，
  // system 在 6827 与 13872 字符之间抖动（6827 = 一块都没注入）。
  //
  // 瀑布是唯一能 await 的接缝，且其返回值是权威的（system-prompt/index.ts:532），
  // 所以：section 只留个占位块保住名字与顺序，真值在瀑布里组装并覆盖。
  // 细节见 src/context/inject.mjs。
  //
  // 判断一个 agent 是否为「绑定聊天会话」的 live agent
  const isChatAgent = (agent) => {
    if (!chatSessionId) return false
    const id = agent?.id
    return typeof id === 'string' && id === chatSessionId
  }

  // 两个输入变量，别合并（下面几处监听器分别写它们）：
  //   lastUserText —— 「待配对输入」：AI 回复后配对成一轮写进滑动窗口 + 记忆，随后清空。
  //   turnInput    —— 「本轮输入」：供检索输入与缓存键使用。**它必须整轮恒定**，
  //                    由下面的 turnInputTurn 保证（见该处注释）。
  // 合并的后果：assistant/message 每个 step 都触发，step0 结束就清空 lastUserText，
  // 于是 step1 的检索输入成了空串 → 记忆块在同一轮里突然消失
  // （实测同一轮 15817 → 13872，掉的 1945 字符正是记忆块）。
  let lastUserText = ''
  let turnInput = ''
  // turnInput 的「权威值」按 turn 锁定：
  //   turnInputTurn —— turnInput 当前锁在哪个 turn（null = 还没锁过）；
  //                    turnInput 本身就是那个 turn 的检索输入。
  //                    **优先**取该 turn 第一条 source.kind === 'user'（主人的真实输入）
  //                    的消息；整批无人类输入时才退回第一条被 claim 的消息（兜底）。
  // 为什么必须锁：agent/inbox/inserted 对**每一条**进 inbox 的消息都触发——包括 turn
  // 中途作为 next-step 插进来的 AgentTeams 派单、后台子代理完成通知。这些消息会把
  // turnInput 改写成通知文本，于是同一个 turn 内 system-prompt 的检索键变了：
  // 记忆块被换成**另一次检索**的结果。真机实测 turn 145：
  //   step1 header 22177（记忆块提到 c54f…）→ 中途插入 a75f2cb8 通知 →
  //   step2 header 22272（记忆块变成 2d83…）—— 同一 turn 出现两个 system 长度。
  let turnInputTurn = null
  // 锁定值是否「权威」：
  //   true  —— turnInput 取自本 turn 第一条 **主人的真实输入**（source.kind === 'user'）。
  //   false —— 只是兜底：本 turn 到这一刻还没有人类输入，暂用第一条被 claim 的消息。
  // 为什么要区分：DSH 的 claim() 先 splice 全部 next-step、**再**推 next-turn，然后按
  // 该顺序逐个 emit claimed（packages/core/agent/src/inbox.ts:71-77）。所以当本 turn
  // 第一步的批次里混着一条 next-step 通知时，batch[0] 是通知，主人的话排在它后面。
  // 只认 batch[0] 会让整个 turn 用**通知文本**去检索记忆——真实危害（实测 4 个回合：
  // turn 81/102/123/148，被锁成 query 的是 user-approval / subagent-settled 通知，
  // 主人的原话就在同一批次里被丢掉）。所以兜底值必须在主人开口后被**升级**。
  let turnInputAuthoritative = false

  /**
   * 真正做检索与组装。返回 null 表示「此刻不该算」（未 ready / agent 模式）：
   * 那种状态下没算过，缓存不该落键，否则 mode 切回聊天后一直读到空串。
   */
  async function buildContextText() {
    if (!ready || !state || state.isAgentMode()) return null
    try {
      const recentRounds = state.recentRounds.map((r) => ({ user: r.user, assistant: r.assistant }))
      // 关系增强依赖 graph.expandFromEntities（不在 store 上）：
      // 只传 store 会令 assembleContext 里的增强分支永远静默失效（死代码），此处一并注入。
      const memoryForCtx = Object.create(store)
      if (graph?.expandFromEntities) memoryForCtx.expandFromEntities = graph.expandFromEntities
      const assembled = await assembleContext({
        profilePath,
        // 检索用「本轮输入」，不是「待配对输入」：后者在 step0 结束时就被清空了，
        // 若拿它检索，同一轮 step1 起 currentInput 变空 → 记忆块整块消失
        // （实测同一轮 15817 → 13872，掉的 1945 字符正是记忆块）。
        currentInput: turnInput,
        memory: memoryForCtx,
        model,
        recentRounds,
        config,
      })
      return blocksToSystemText(assembled.blocks)
    } catch (e) {
      warn(`上下文组装失败: ${e.message}`)
      return ''
    }
  }

  // 按「本轮输入」缓存：同一 turn 只算一次（多步回合不重复 embed + 向量检索）。
  //
  // 关于 createContextCache 的 invalidate()：本文件**刻意不调用**它。
  // 先澄清它到底做什么（复核 finding F4 指出早先注释说反了）：invalidate() 会把
  // cachedInput 置回 undefined（src/context/inject.mjs:86-89），即**清掉缓存键的有效性
  // 状态**、并递增 gen 让在途的旧组装回来时无法落缓存 —— 它不是「只递增代号而不换键」。
  // 之所以无需调用，是因为正确性已经由键保证：缓存命中条件是 `cachedInput === getInput()`
  // （同文件 :50），而 getInput() 就是 turnInput，turnInput 已按 turn 锁定（见
  // agent/inbox/claimed 监听器）。于是「换 turn」本身就等价于「换键」，旧结果天然不会被
  // 复用；在这个前提下 getInput() 的变化已足以让缓存失效，不需要额外的 invalidate。
  // 反过来在这里调用它只有坏处：它会把「同一 turn 内已预热好的结果」丢掉、下次装配重算
  // 一遍（白付一次 embed + 检索），且并不带来任何额外的正确性。
  // 因此 invalidate 保留给「键不变但值必须重算」的场景（本文件下方 agent 模式自愈用的
  // ensureContextText(true) 走的是 force 分支），不用于 turn 切换。
  // 全仓调用点仅测试两处（test/inject.test.mjs 的 invalidate 用例），无产品路径依赖它。
  const contextCache = createContextCache({
    getInput: () => turnInput,
    build: buildContextText,
    warn,
  })
  const ensureContextText = (force = false) => contextCache.get(force)
  // 运行期自愈：mode=agent 只有在「QQ 绑定确实指向隔离会话」时才成立。
  // 若 /agentstart 的 bind 切换失败（或中途崩溃），QQ 仍投聊天会话，而组装在
  // agent 模式下返回空 → 静默失去人格/记忆/最近对话，同时根本没有隔离。
  // 启动时那次自愈救不了运行期改的 mode，所以这里按真实绑定纠正。
  let reconciling = false
  async function reconcileAgentMode() {
    if (reconciling) return
    reconciling = true
    try {
      const bindFile = config.notifierStateFile || join(notifierStateDir(), 'state.json')
      const ch = config.channel ?? 'qq'
      const uid = config.userId ?? ''
      const bound = await getBinding(ch, uid, bindFile)
      const agentSid = state.agentSessionId
      if (agentSid && bound !== agentSid) {
        warn(
          `检测到 mode 残留为 agent（隔离会话 ${String(agentSid).slice(0, 24)}…），` +
          `但 QQ 实际绑定 ${String(bound ?? '(空)').slice(0, 24)}… —— 已重置回聊天模式，恢复上下文注入。`
        )
        await state.exitAgent()
        await ensureContextText(true)
      }
    } catch (e) {
      warn(`agent 模式自愈失败: ${e.message}`)
    } finally {
      reconciling = false
    }
  }
  // 每轮只做「agent 模式自愈」这一件事，不再碰缓存。
  // 检索输入的锁定与预热都在上面的 agent/inbox/claimed 监听器里做；
  // 缓存键随 turn 变化（turnInput 按 turn 锁定），无需在此 invalidate。
  const refreshDisposer = ctx.on('agent/inbox/inserted', (payload) => {
    if (!ready || !isChatAgent(payload?.agent)) return
    if (state?.isAgentMode?.()) reconcileAgentMode().catch(() => {})
  })
  disposers.push(refreshDisposer)

  // 在聊天会话自己的 agent 作用域注入听雪上下文 section。
  // 关键修复：不能注册在 root ctx——DSH 的 systemPrompt.section 是作用域继承的，
  // root 层注册会对所有 DSH 会话生效（人格/记忆/最近对话泄漏到无关会话 = 上下文串线）。
  // 注册在 agent.ctx 上时：只对聊天会话可见，且随该 agent dispose 自动卸载。
  function injectChatSection(agent) {
    try {
      installContextInjection({ agent, shouldInject: isChatAgent, ensureText: ensureContextText, warn })
    } catch (e) {
      warn(`聊天会话上下文注入失败: ${e.message}`)
    }
  }
  // 聊天会话成为 live agent 时注入。覆盖：init 前就 live、自愈 resume 成功、
  // /agentstart 回绑、用户首条消息把冷会话变 live 等所有入口。
  const chatSectionDisposer = ctx.on('agent/created', (payload) => {
    if (!isChatAgent(payload?.agent)) return
    injectChatSection(payload.agent)
  })
  disposers.push(chatSectionDisposer)

  // ---- 记忆写入：监听对话轮次 ----
  // 通过 agent/inbox/inserted 记录用户消息，通过 session/event 记录 AI 回复。
  // 隔离铁律：只有属于「当前 agent 隔离会话」的消息才进 pendingAgentRounds，
  // 聊天会话与 agent 会话的记忆/上下文必须完全隔离。
  const isAgentSession = (sessionOrAgent) => {
    if (!state?.isAgentMode?.() || !state?.agentSessionId) return false
    const id = sessionOrAgent?.session?.id ?? sessionOrAgent?.id ?? sessionOrAgent
    return typeof id === 'string' && id === state.agentSessionId
  }
  const inboxDisposer = ctx.on('agent/inbox/inserted', (payload) => {
    if (!ready || !state) return
    try {
      const agent = payload?.agent
      const message = payload?.message
      const text = message?.content?.find?.((b) => b.type === 'text')?.text ?? ''
      if (!text) return
      // 记录用户消息到待归档（仅 agent 隔离会话；退出时归档）
      if (state.isAgentMode() && isAgentSession(agent)) {
        pendingAgentRounds.push({ user: text, assistant: '' })
      }
    } catch (e) { warn(`agent 待归档记录失败（该轮可能漏归档）: ${e.message}`) }
  })
  disposers.push(inboxDisposer)

  // 监听 AI 回复完成，写入记忆（聊天模式）
  const sessionEventDisposer = ctx.on('session/event', (session, event) => {
    if (!ready || !state || !store) return
    try {
      if (event?.type !== 'assistant/message') return
      const blocks = event.data?.message?.content
      if (!Array.isArray(blocks)) return
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
      if (!text) return
      // 聊天模式：把用户+AI 作为一轮写入记忆（仅聊天会话）
      if (!state.isAgentMode()) {
        const sessionId = session?.id
        if (sessionId && chatSessionId && sessionId !== chatSessionId) return // 非聊天会话，隔离
        const lastUser = lastUserText
        if (lastUser) {
          const roundText = `用户：${lastUser}\n听雪：${text}`
          // 异步写入记忆（不阻塞）
          writeMemory(roundText, 'chat').catch((e) => warn(`记忆写入失败: ${e.message}`))
          // 滑动窗口持久化失败同样要留线索：静默丢弃会让「轮次莫名不增长/重启后丢历史」
          // 变成无头案（写入路径有重试，走到这里说明已重试耗尽）。
          state.pushRound(lastUser, text).catch((e) => warn(`滑动窗口写入失败: ${e.message}`))
          // 只清「待配对输入」；turnInput 整轮保持，供同一轮后续 step 复用检索结果
          lastUserText = ''
        }
      } else if (state.isAgentMode() && isAgentSession(session)) {
        // agent 模式：补全待归档轮次（仅 agent 隔离会话）
        const last = pendingAgentRounds[pendingAgentRounds.length - 1]
        if (last && last.assistant === '') last.assistant = text
      }
    } catch (e) { warn(`配对/记忆写入异常（不影响对话）: ${e.message}`) }
  })
  disposers.push(sessionEventDisposer)

  // 记录最近用户文本（供 AI 回复后配对成一轮）
  // 隔离：只有「绑定聊天会话」的用户消息才记录；其他 DSH 会话（含 agent 隔离会话）
  // 的消息绝不能覆盖 lastUserText——否则会被当成聊天会话的用户话，串进上下文组装
  // 或写进记忆库（跨会话数据污染）。
  const userEventDisposer = ctx.on('agent/inbox/inserted', (payload) => {
    if (!ready || !isChatAgent(payload?.agent)) return
    try {
      const message = payload?.message
      const text = message?.content?.find?.((b) => b.type === 'text')?.text ?? ''
      if (!text || commands?.isCommand?.(text)) return
      lastUserText = text
      // turnInput 一律不在这里改写（否则 turn 内通知会把它带偏，见 claimed 监听器）。
      // 唯一例外：宿主不提供 agent/inbox/claimed（老 DSH）时，turnInputTurn 永远为 null，
      // 此时退化成修复前的行为——宁可像以前那样可能漂移，也绝不变成「永远空输入」
      // （那会连记忆块一起丢掉，等于用「少注入」换「不漂移」，是明确禁止的）。
      // 这里**不预热**：inserted 早于 claimed（真机里通知的 inserted 先到、主人原话的
      // claimed 后到），若在此预热就等于拿「本批次第一条消息」先跑一次 embed + 向量检索——
      // 而那条往往是通知。预热只留给「已确认为主人的话」的 claimed 分支。
      // 不预热不影响正确性：assemble 会 await 同一个 ensureContextText()，按当时的输入建缓存。
      if (turnInputTurn === null) {
        turnInput = text
      }
    } catch { /* 忽略 */ }
  })
  disposers.push(userEventDisposer)

  /**
   * 按 turn 锁定检索输入 —— 这是「同一 turn 内 system 漂移」的根治点。
   *
   * 为什么不能用 agent/inbox/inserted：它对**每一条**进 inbox 的消息都触发，其中包括
   * turn 中途作为 next-step 插进来的 AgentTeams 派单、后台子代理完成通知。旧实现
   * 在这些通知上无条件 `turnInput = text`，于是同一个 turn 里检索键被改写：
   * 记忆块被换成**另一次检索**的结果（不是消失）。真机实测 turn 145：
   *   step1 header 22177（记忆块提到 c54f…）→ 插入 a75f2cb8 通知
   *   → step2 header 22272（记忆块变成 2d83…）
   * 副作用同样真实：每次改写都让缓存 miss → 白跑一次 embed + 向量检索（就是「还多花钱」）。
   *
   * 为什么用 agent/inbox/claimed：它携带 **turn 号**（DSH runtime-types.ts:197），
   * 且 DSH 的 preStep 里 `inbox.claim()` 是**同步**发生在 `systemPrompt.assemble()`
   * 之前（agent-loop/src/agent.ts:229-230），所以本监听器一定先于本次装配执行——
   * 锁定后的键在同一 turn 的每次 assemble 上都一样，缓存必然命中。
   *
   * 语义：一个 turn 的检索 query = 该 turn **第一条 source.kind === 'user'**（主人真实
   * 输入）的消息。mid-turn 通知（同一个 turn 号）不再改写它 ⇒ 同 turn 内 system 恒定，
   * 且注入量不变（只是不再变）。
   *
   * 为什么不能只取「第一条被 claim 的消息」：claim() 先 splice 全部 next-step、再推
   * next-turn，然后按该顺序逐个 emit claimed（inbox.ts:71-77）。首批次里混着通知时，
   * batch[0] 是通知而主人的话排在其后——整轮就会用**通知文本**检索记忆。真机实测
   * 4 个有害回合：turn 81/102/123/148（source.kind 是 plugin:user-approval /
   * subagent-settled，主人的原话在同一批次里被丢掉）。
   *
   * 判据来源：agent/inbox/claimed 的 message 是 UserMessage，携带 source: MessageSource
   * （packages/llm/llm/src/message.ts:137-143，MessageSourceMap.user = { kind: 'user' }），
   * 故 payload.message.source?.kind === 'user' 即可判定，无需新增事件。
   *
   * 语义取舍：本 turn 已有权威值（主人的话）则**绝不**被后续 claim 改写；整批无人类
   * 输入时退回 batch[0] 兜底（否则会变成「永远空输入」，等于用「少注入」换「不漂移」，
   * 是明确禁止的）。兜底值一旦等到主人的话就会被升级为权威值。
   */
  const claimedDisposer = ctx.on('agent/inbox/claimed', (payload) => {
    if (!ready || !isChatAgent(payload?.agent)) return
    try {
      const turn = payload?.turn
      if (typeof turn !== 'number') return
      const text = payload?.message?.content?.find?.((b) => b.type === 'text')?.text ?? ''
      if (!text || commands?.isCommand?.(text)) return
      const isHuman = payload?.message?.source?.kind === 'user'
      // 本 turn 的锁定已「够用」时早退——这是「同 turn 内 system 恒定」的**唯一**承重保护，
      // 刻意只写这一条（不拆成两个并列 if）：拆开会让后续某个 if 兜住本该失败的场景，
      // 于是「删掉这条早退」不再能让套件变红，保护就退化成了不可验证的摆设。
      //   turnInputAuthoritative —— 已锁到主人的话，任何后续 claim 都不得改写（含通知）。
      //   !isHuman               —— 已锁到兜底值，本 turn 再来非人类消息也不该覆盖它。
      // 两种「够用」都必须早退：只退其一都会留下一个能被通知改写的窗口 = 轮内漂移。
      if (turnInputTurn === turn && (turnInputAuthoritative || !isHuman)) return
      turnInputTurn = turn
      turnInput = text
      turnInputAuthoritative = isHuman
      // 只有锁到**主人的话**才预热。理由：claim() 把整批消息在同一个同步循环里
      // emit 完（inbox.ts:71-77），所以首批次「通知在前、主人原话在后」时，先给
      // 通知预热等于白跑一次 embed + 向量检索（正是要消灭的成本）。不预热也不影响
      // 正确性——随后 system-prompt/assemble 瀑布会 await 同一个 ensureContextText()，
      // 按最终输入建缓存；通知独占的 turn 只是没有叠加收益，不会少注入。
      // 不 await——让它与 agent 循环并发跑；assemble 拿到的是同一个 in-flight promise
      // （createContextCache 按输入去重），既不重复检索也不丢正确性。
      // 不吞错：buildContextText 内部已 catch 并 warn，能走到这里的都是意外异常。
      if (turnInputAuthoritative) {
        ensureContextText().catch((e) => { warn(`上下文预热失败: ${e?.message ?? e}`) })
      }
    } catch { /* 忽略 */ }
  })
  disposers.push(claimedDisposer)

  /** 写入记忆（含实体抽取）。 */
  async function writeMemory(text, scene) {
    if (!store || !model) return
    const vec = await model.embed([text])
    const memoryId = await store.addMemory({ text, vector: vec[0], scene, source: scene })
    try {
      if (graph) await graph.ingest(text, { source: scene })
    } catch (e) {
      warn(`实体抽取失败: ${e.message}`)
    }
    return memoryId
  }

  /**
   * 下载 QQ 附件到 workcopy 并读取内容，返回注入文本。
   * 文件生命周期：下载到 dataDir/workcopy/ 下，读取内容后返回注入文本；
   * 文件路径登记到 workFiles（/agentstop 时按 fileDeleteScope 清理）。
   * 下载/读取失败返回 null（不阻塞对话，仅告警）。
   * @param {string} fileName - 文件名
   * @param {string} fileUrl - 下载地址
   * @returns {Promise<string|null>} 注入文本（含文件内容），失败返回 null
   */
  async function downloadAndInjectFile(fileName, fileUrl) {
    try {
      if (!/^https?:\/\//.test(fileUrl)) {
        warn(`文件下载地址非法，跳过: ${fileUrl}`)
        return null
      }
      // 下载到 workcopy 目录
      const workDir = join(dataDir, 'workcopy')
      await mkdir(workDir, { recursive: true })
      const safeName = String(fileName || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
      const filePath = join(workDir, `${Date.now().toString(36)}-${safeName}`)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      let buffer
      try {
        const res = await fetch(fileUrl, { signal: controller.signal })
        if (!res.ok) {
          warn(`文件下载失败 HTTP ${res.status}: ${fileUrl}`)
          return null
        }
        buffer = Buffer.from(await res.arrayBuffer())
      } finally {
        clearTimeout(timer)
      }
      if (buffer.length > 5 * 1024 * 1024) {
        warn(`文件过大跳过读取: ${fileName} (${buffer.length} bytes)`)
        return null
      }
      await writeFile(filePath, buffer)
      // 登记到 workFiles（/agentstop 清理用）
      if (Array.isArray(workFiles)) workFiles.push(filePath)
      // 读取内容（文本文件；二进制文件只给元信息）
      let content = ''
      try {
        content = buffer.toString('utf-8')
        // 若含大量替换字符，视为二进制，不注入全文
        const replacementRatio = (content.match(/\uFFFD/g)?.length ?? 0) / Math.max(1, content.length)
        if (replacementRatio > 0.05) content = ''
      } catch { content = '' }
      const sizeKb = Math.round(buffer.length / 1024)
      if (content.trim() === '') {
        return `【文件内容】\n文件名: ${fileName}\n大小: ${sizeKb} KB\n（二进制或不可读文件，已保存到工作副本，可要求我读取）`
      }
      return `【文件内容】\n文件名: ${fileName}\n大小: ${sizeKb} KB\n\n${content.slice(0, 8000)}`
    } catch (e) {
      warn(`文件下载/读取失败: ${e.message}`)
      return null
    }
  }

  // 清理
  return () => {
    for (const d of disposers) { try { d?.() } catch {} }
    if (store) { try { store.close() } catch {} }
  }
}
