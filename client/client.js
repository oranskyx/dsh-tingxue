// dsh-tingxue browser half — 设置在 Web GUI「设置 → 插件配置」里的一张卡片。
//
// 手写 lazy-CJS 工厂产物（本仓库外没有发布的 tsdown 预设，格式照
// dsh-vision-router / dsh-cost-meter 这类外部插件的做法复刻）：
// 客户端模块系统把整个文件包进 CJS factory，内核采纳 { apply, inject } 作为客户端插件。
//
// 纯自持：不导入任何其他插件的值（bundle 纯净度门禁），自带暂存表单与 revision 设栅。
// 只依赖 React 与三个服务：slots / locale / settingsScope。

window.__ModuleLoader__.load({
  id: 'dsh-tingxue',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useCallback } = React

    // ── i18n ────────────────────────────────────────────────────────────────
    const NS = 'settings.tingxue'
    const zh = {
      nav: '听雪',
      graphNav: '记忆图谱',
      title: '听雪',
      subtitle: '双模式虚拟生命系统',
      // —— 侧栏「听雪」页：记忆服务状态总览 ——
      overview: '状态总览',
      overviewHint: '只读探活与计数；记忆服务由插件自己拉起，这里不会写入或修改记忆库。',
      serviceStatus: '服务状态',
      statusOnline: '在线',
      statusOffline: '离线',
      statusLoading: '连接中…',
      memories: '记忆',
      entities: '实体',
      relations: '关系',
      activeRelations: '有效关系',
      trash: '回收站',
      serviceAddress: '服务地址',
      sameOriginPath: '同源路径',
      refresh: '刷新',
      refreshing: '刷新中…',
      lastUpdated: '上次刷新 {time}',
      updatedAt: '上次刷新',
      actions: '入口',
      openGraph: '打开记忆图谱',
      openSettings: '打开设置',
      dualModePending: '双模式：待接线',
      loadFailed: '读取失败',
      offlineHint: '记忆服务未响应：确认「面板与服务 → 启用记忆服务」已打开，并检查服务端口。',
      graphFrameTitle: '听雪 · 记忆图谱',
      description: '聊天模式与 agent 模式的人格、记忆库、模型、绑定与面板配置。改动在下次重启 DSH 后生效。',
      save: '保存',
      discard: '放弃',
      saving: '保存中…',
      overridden: '已覆盖',
      reset: '重置',
      loading: '读取中…',
      unavailable: '当前连接不可写（远程浏览器无法修改这些设置）。',
      unsaved: '有未保存的改动',
      saved: '已保存',
      invalidNumber: '请填数字',
      restartHint: '标注「已覆盖」的字段会覆盖部署配置；重置即回落到部署层。',
      // —— 模型选择器 ——
      pickModel: '选择模型',
      pickModelFor: '为「{field}」选择模型',
      fetching: '正在询问端点…',
      fetchFailed: '取列表失败',
      fetchEmpty: '端点没有列出任何模型，请手动填写。',
      fetchTitle: '选择要使用的模型',
      fetchDescription: '以下是该端点当前提供的模型，勾选要用的那个。',
      fetchSelect: '选用',
      fetchCancel: '取消',
      searchPlaceholder: '搜索模型 id…',
      noMatch: '没有匹配的模型。',
      manualHint: '也可以直接在输入框里手填模型 id。',
      currentBadge: '当前',
      modelCount: '共 {n} 个',
      close: '关闭',
    }
    const en = {
      nav: 'Tingxue',
      graphNav: 'Memory graph',
      title: 'Tingxue',
      subtitle: 'dual-mode virtual life system',
      // —— sidebar "Tingxue" page: memory service overview ——
      overview: 'Status overview',
      overviewHint: 'Read-only health probe and counts; the memory service is started by the plugin — nothing here writes to the store.',
      serviceStatus: 'Service',
      statusOnline: 'Online',
      statusOffline: 'Offline',
      statusLoading: 'Connecting…',
      memories: 'Memories',
      entities: 'Entities',
      relations: 'Relations',
      activeRelations: 'Active relations',
      trash: 'Trash',
      serviceAddress: 'Service address',
      sameOriginPath: 'Same-origin path',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      lastUpdated: 'Last refreshed {time}',
      updatedAt: 'Last refreshed',
      actions: 'Actions',
      openGraph: 'Open memory graph',
      openSettings: 'Open settings',
      dualModePending: 'Dual mode: not wired yet',
      loadFailed: 'Failed to load',
      offlineHint: 'The memory service did not answer. Check “Panels & services → Enable memory service” and its port.',
      graphFrameTitle: 'Tingxue · Memory graph',
      description: 'Persona, memory store, models, binding and panel settings. Changes apply after the next DSH restart.',
      save: 'Save',
      discard: 'Discard',
      saving: 'Saving…',
      overridden: 'overridden',
      reset: 'Reset',
      loading: 'Loading…',
      unavailable: 'This connection is read-only.',
      unsaved: 'Unsaved changes',
      saved: 'Saved',
      invalidNumber: 'Enter a number',
      restartHint: 'Overridden fields replace the deployment layer; resetting falls back to it.',
      // —— model picker ——
      pickModel: 'Choose model',
      pickModelFor: 'Choose a model for "{field}"',
      fetching: 'Asking the endpoint…',
      fetchFailed: 'Could not fetch the list',
      fetchEmpty: 'The endpoint listed no models; enter one by hand.',
      fetchTitle: 'Choose a model',
      fetchDescription: 'These are the models this endpoint currently serves.',
      fetchSelect: 'Use this',
      fetchCancel: 'Cancel',
      searchPlaceholder: 'Search model id…',
      noMatch: 'No matching model.',
      manualHint: 'You can also type a model id directly.',
      currentBadge: 'current',
      modelCount: '{n} models',
      close: 'Close',
    }
    /** t 缺失时回落到内嵌中文，卡片永不空着。 */
    function makeT(t) {
      return (key, fallback) => {
        if (typeof t === 'function') {
          try {
            const v = t(key)
            if (v && v !== key) return v
          } catch { /* 回落到内嵌文案 */ }
        }
        return fallback === undefined ? key : fallback
      }
    }

    // ── 模型目录 ────────────────────────────────────────────────────────────
    /**
     * 需要「从端点列表里挑」的字段：值是模型 id，端点就是模型后端本身。
     * 其余字段一律照旧手填 —— 选择器只加在这两处，不扩散到没必要的字段上。
     */
    const MODEL_FIELDS = new Set(['embeddingModel', 'llmModel'])

    /** 与 Host 半侧 MODEL_CATALOG_PATH 同一个路径。 */
    const CATALOG_PATH = '/dsh-tingxue/models'

    /** 搜索框的类名与它那条 ::placeholder 规则的 id（全局唯一，避免重复注入）。 */
    const PICKER_INPUT_CLASS = 'dsh-tingxue-picker-input'
    const PICKER_PLACEHOLDER_STYLE_ID = 'dsh-tingxue-picker-placeholder'

    /**
     * 询问端点当前提供哪些模型。
     *
     * 走宿主自己的 webServer（和 GUI 同一个端口），所以不带跨源问题，也不用
     * 额外的 key。请求体是「表单当前显示的值」而不是已保存的配置：刚填进去、
     * 还没保存的端点或 key 也能立刻试。服务端只读，不写任何配置。
     *
     * @param {object} draft - { modelBackend, baseURL, apiKey }
     * @returns {Promise<{models?: Array<{id: string}>, error?: string}>}
     */
    async function fetchModels(draft) {
      try {
        const res = await fetch(CATALOG_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        })
        if (!res.ok) return { error: 'HTTP ' + res.status }
        const body = await res.json().catch(() => ({}))
        if (body && body.ok === true && Array.isArray(body.models)) return { models: body.models }
        return { error: (body && body.error) || 'unknown' }
      } catch (e) {
        return { error: (e && e.message) || String(e) }
      }
    }

    /**
     * 模型选择弹窗：照 DSH「设置 → 模型」的获取流程做的（询问端点 → 从候选里挑）。
     *
     * 与那份实现的两点差异，都是这里用不上的能力：不批量勾选（一次只选一个
     * 字段的值），不采纳容量元数据（听雪只关心模型 id）。搜索框是这里多出来的，
     * 因为 sta1n 的列表有 102 项，靠眼睛翻不现实。
     */
    function ModelPicker(props) {
      const tr = props.tr
      const [rows, setRows] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [query, setQuery] = React.useState('')

      const load = React.useCallback(() => {
        setBusy(true); setFailure(null)
        fetchModels(props.draft).then((r) => {
          setBusy(false)
          if (r.models) { setRows(r.models); if (r.models.length === 0) setFailure(tr('fetchEmpty', '端点没有列出任何模型，请手动填写。')); return }
          setFailure((r.error || '') + '')
        })
      }, [props.draft.modelBackend, props.draft.baseURL, props.draft.apiKey])

      React.useEffect(() => {
        load()
        // placeholder 的颜色内联样式管不到，只能落在样式表里。DSH 自己也没有全局的
        // input::placeholder 规则（每个输入框组件各带一条，互不越界），所以这条只
        // 命中弹窗里这一个 input，不会影响宿主或其它插件的输入框。
        if (!document.getElementById(PICKER_PLACEHOLDER_STYLE_ID)) {
          const style = document.createElement('style')
          style.id = PICKER_PLACEHOLDER_STYLE_ID
          style.textContent = '.' + PICKER_INPUT_CLASS + '::placeholder{color:#5c5c66;opacity:1}'
          document.head.appendChild(style)
        }
      }, [load])

      const all = rows || []
      const q = query.trim().toLowerCase()
      const shown = q === '' ? all : all.filter((m) => String(m.id).toLowerCase().includes(q))
      const current = props.currentValue

      const itemStyle = (isCurrent) => ({
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6,
        cursor: 'pointer', fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        background: isCurrent ? 'rgba(128,128,128,.14)' : 'transparent',
        border: '1px solid ' + (isCurrent ? 'var(--dsh-border, rgba(128,128,128,.45))' : 'transparent'),
      })

      return h('div', { style: S.overlay, onClick: (e) => { if (e.target === e.currentTarget) props.onClose() } },
        h('div', { style: S.modal, role: 'dialog', 'aria-label': tr('fetchTitle', '选择要使用的模型') },
          h('div', { style: S.modalHead },
            h('div', { style: { fontWeight: 600, fontSize: 13 } }, tr('pickModelFor', '选择模型').replace('{field}', props.fieldLabel)),
            h('span', { style: { flex: 1 } }),
            h('span', { style: S.badge }, busy ? tr('fetching', '正在询问端点…') : tr('modelCount', '共 {n} 个').replace('{n}', String(all.length))),
            h('button', { type: 'button', style: S.btn, onClick: props.onClose }, tr('close', '关闭')),
          ),
          h('div', { style: { fontSize: 11, opacity: 0.6, margin: '4px 0 8px' } }, tr('fetchDescription', '以下是该端点当前提供的模型，勾选要用的那个。')),
          h('input', {
            style: S.inputOnDark, type: 'text', value: query, autoFocus: true,
            className: PICKER_INPUT_CLASS,
            placeholder: tr('searchPlaceholder', '搜索模型 id…'),
            onChange: (e) => { setQuery(e.target.value) },
          }),
          h('div', { style: S.modalBody },
            busy && all.length === 0 ? h('div', { style: { fontSize: 12, opacity: 0.6, padding: 8 } }, tr('fetching', '正在询问端点…')) : null,
            failure ? h('div', { style: S.err }, tr('fetchFailed', '取列表失败') + '：' + failure) : null,
            !busy && !failure && shown.length === 0 ? h('div', { style: { fontSize: 12, opacity: 0.6, padding: 8 } }, tr('noMatch', '没有匹配的模型。')) : null,
            ...shown.map((m) => h('div', {
              key: m.id, style: itemStyle(m.id === current),
              title: m.id,
              onClick: () => { props.onPick(String(m.id)); props.onClose() },
            },
              h('span', { style: { flex: 1, wordBreak: 'break-all' } }, String(m.id)),
              m.id === current ? h('span', { style: S.badge }, tr('currentBadge', '当前')) : null,
            )),
          ),
          failure || busy ? null : h('div', { style: { fontSize: 11, opacity: 0.55, marginTop: 8 } }, tr('manualHint', '也可以直接在输入框里手填模型 id。')),
        ))
    }

    // ── 字段表（与 Host 半侧 src/settings/index.mjs 的 SETTINGS_FIELDS 对齐）──
    const FIELDS = [
      { key: 'profilePath', kind: 'string', group: '人格与记忆', label: '听雪档案路径', hint: '人格提示词 txt 的绝对路径' },
      { key: 'dataDir', kind: 'string', group: '人格与记忆', label: '记忆库目录', hint: 'LanceDB 本地文件即库的数据目录' },
      { key: 'recentRounds', kind: 'number', group: '人格与记忆', label: '最近 N 轮滑动窗口', hint: '注入上下文保留的最近对话轮数（仅打开「重复注入最近对话」时生效）' },
      { key: 'injectRecentRounds', kind: 'boolean', group: '人格与记忆', label: '重复注入最近对话', hint: '默认关。会话历史本身已含最近对话，再注入一遍等于同一段话付两次 token（约 1.5K/轮）。只有换绑到新会话、历史不可用时才需要打开' },
      { key: 'memoryBudgetTokens', kind: 'number', group: '人格与记忆', label: '记忆块预算', hint: '向量记忆检索块 token 上限' },
      { key: 'latestInfoBudgetTokens', kind: 'number', group: '人格与记忆', label: '最新信息块预算', hint: '最新信息块 token 上限' },
      { key: 'modelBackend', kind: 'enum', group: '模型', label: '模型后端', hint: 'sta1n 云端 / local 本地 / custom 自定义', values: ['sta1n', 'local', 'custom'] },
      { key: 'embeddingModel', kind: 'string', group: '模型', label: '向量模型', hint: '同库单一模型铁律：换模型须全量重嵌入。点「选择模型」可从当前端点列表里挑' },
      { key: 'embeddingDimensions', kind: 'number', group: '模型', label: '向量维度', hint: '须与向量模型实际输出一致' },
      { key: 'llmModel', kind: 'string', group: '模型', label: '语义推理小 LLM', hint: '实体抽取/摘要用的小模型。点「选择模型」可从当前端点列表里挑' },
      { key: 'baseURL', kind: 'string', group: '模型', label: '自定义端点', hint: 'local/custom 时的 OpenAI 兼容 base URL' },
      { key: 'apiKey', kind: 'secret', group: '模型', label: 'API Key', hint: '留空则回落到 DSH 凭据服务里的 STA1N_API_KEY' },
      { key: 'agentStartKeyword', kind: 'string', group: '双模式命令', label: '进入 agent 模式关键词', hint: 'QQ 聊天中触发隔离会话' },
      { key: 'agentStopKeyword', kind: 'string', group: '双模式命令', label: '退出 agent 模式关键词', hint: '归档并销毁隔离会话' },
      { key: 'fileDeleteScope', kind: 'enum', group: '双模式命令', label: '文件删除范围', hint: 'workcopy 只删工作副本 / keep 一律保留', values: ['workcopy', 'keep'] },
      { key: 'channel', kind: 'string', group: '绑定与推送', label: '绑定通道', hint: 'dsh-notifier 的 channel' },
      { key: 'userId', kind: 'string', group: '绑定与推送', label: '绑定用户', hint: 'dsh-notifier 的 userId' },
      { key: 'chatSessionId', kind: 'string', group: '绑定与推送', label: '聊天会话 id', hint: '自愈回绑用的可信聊天会话 id' },
      { key: 'notifierStateFile', kind: 'string', group: '绑定与推送', label: 'notifier state 路径', hint: '留空用默认的 dsh-notifier state.json' },
      { key: 'routeWorkspace', kind: 'string', group: '绑定与推送', label: '出站分流 workspace', hint: '被静音的默认 workspace' },
      { key: 'quietOtherWorkspace', kind: 'boolean', group: '绑定与推送', label: '静音其他会话推送', hint: '只让听雪自己的消息送达 QQ' },
      { key: 'qqStatusNotice', kind: 'boolean', group: '绑定与推送', label: 'QQ 显示任务状态提示', hint: '关掉后不再发任务开始/完成/中止/心跳/疑似卡住这类状态行；回复正文照常送达（出错通知仍保留）' },
      { key: 'approvalAllowlistOnly', kind: 'boolean', group: '绑定与推送', label: '审批只推 QQ 对话会话', hint: '只有听雪聊天会话 / agent 隔离会话的批准询问发到 QQ，其他 DSH 会话的审批只在桌面弹' },
      { key: 'graphDashboardEnable', kind: 'boolean', group: '面板与服务', label: '启用关系图谱面板', hint: '本机可交互蜘蛛网 UI' },
      { key: 'graphDashboardHost', kind: 'string', group: '面板与服务', label: '图谱面板监听地址', hint: '默认仅本机 loopback' },
      { key: 'graphDashboardPort', kind: 'number', group: '面板与服务', label: '图谱面板端口', hint: '' },
      { key: 'memoryServiceEnable', kind: 'boolean', group: '面板与服务', label: '启用记忆服务', hint: 'DSH 唯一写者，AstrBot 经 HTTP 对接' },
      { key: 'memoryServiceHost', kind: 'string', group: '面板与服务', label: '记忆服务监听地址', hint: '默认仅本机 loopback' },
      { key: 'memoryServicePort', kind: 'number', group: '面板与服务', label: '记忆服务端口', hint: '' },
    ]
    const GROUPS = ['人格与记忆', '模型', '双模式命令', '绑定与推送', '面板与服务']

    // ── 极简 snapshot store（HostObservable：getSnapshot + subscribe）────────
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: (fn) => {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
        set: (next) => {
          snapshot = next
          for (const fn of Array.from(listeners)) {
            try { fn() } catch { /* 单个订阅者失败不影响其他 */ }
          }
        },
      }
    }

    const fmt = (v) => (v === undefined || v === null ? '' : String(v))
    const jsonEqual = (a, b) => {
      if (a === b) return true
      if (typeof a !== typeof b) return false
      if (a === null || b === null) return false
      if (typeof a !== 'object') return false
      try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
    }
    /** 把草稿文本解析成该字段的类型。 */
    function parseDraft(text, field) {
      if (field.kind === 'number') {
        const n = Number(String(text).trim())
        if (String(text).trim() === '' || !Number.isFinite(n)) return { invalid: true }
        return { value: n }
      }
      if (field.kind === 'boolean') return { value: text === 'true' }
      return { value: String(text) }
    }

    /** 卡片控制器：scope → 暂存表单 → 快照。 */
    function createCardController(scope) {
      const drafts = new Map()
      let saving = false
      let error = null
      let store = null

      const scopeSnapshot = () => {
        try { return scope.getSnapshot?.() ?? {} } catch { return {} }
      }

      function project() {
        const snap = scopeSnapshot()
        const value = (snap && snap.value) || {}
        const base = (snap && snap.base) || {}
        const user = (snap && snap.user) || {}
        const fields = FIELDS.map((f) => {
          const hasDraft = drafts.has(f.key)
          const resolved = value[f.key]
          const draft = hasDraft ? drafts.get(f.key) : fmt(resolved)
          const parsed = hasDraft ? parseDraft(draft, f) : { value: resolved }
          return {
            key: f.key, kind: f.kind, group: f.group, label: f.label, hint: f.hint,
            values: f.values,
            draft,
            value: resolved,
            base: base[f.key],
            overridden: Object.prototype.hasOwnProperty.call(user, f.key),
            invalid: hasDraft ? parsed.invalid === true : false,
          }
        })
        return {
          status: snap.status ?? 'loading',
          writable: snap.writable === true,
          saving,
          error,
          dirty: drafts.size > 0,
          fields,
        }
      }
      function push() { if (store) store.set(project()) }

      store = createStore(project())
      try {
        const off = scope.subscribe?.(() => { push() })
        if (typeof off === 'function') store.dispose = off
      } catch { /* 无订阅能力时退化为手动刷新 */ }

      return {
        store,
        edit(field, text) { drafts.set(field, text); push() },
        discard() { drafts.clear(); error = null; push() },
        reseed() { drafts.clear(); error = null; push() },
        async resetField(field) {
          drafts.delete(field)
          try {
            await scope.unset?.(field)
            error = null
          } catch (e) { error = (e && e.message) || String(e) }
          push()
        },
        async save() {
          const value = (scopeSnapshot().value) || {}
          const bad = FIELDS.filter((f) => drafts.has(f.key) && parseDraft(drafts.get(f.key), f).invalid === true)
          if (bad.length > 0) {
            error = bad.map((f) => f.label).join('、') + '：' + '请填数字'
            push()
            return
          }
          saving = true; error = null; push()
          const failures = []
          for (const f of FIELDS) {
            if (!drafts.has(f.key)) continue
            const parsed = parseDraft(drafts.get(f.key), f)
            if (jsonEqual(parsed.value, value[f.key])) { drafts.delete(f.key); continue }
            try {
              await scope.set?.(f.key, parsed.value)
              drafts.delete(f.key)
            } catch (e) {
              failures.push(((e && e.message) || String(e)))
            }
          }
          saving = false
          error = failures.length > 0 ? failures.join('；') : null
          push()
        },
        inject() {
          // hooks 隔间在渲染侧绑定成 useCard 选择器钩子；其余成员原样成为 props。
          return {
            hooks: { card: store },
            save: () => { void this.save() },
            discard: () => { this.discard() },
            edit: (field, text) => { this.edit(field, text) },
            resetField: (field) => { void this.resetField(field) },
          }
        },
      }
    }

    // ── 样式（内联，自带外观）────────────────────────────────────────────────
    const S = {
      page: { padding: '2px 2px 24px' },
      pageTitle: { fontSize: 16, fontWeight: 600 },
      head: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      badge: { fontSize: 11, opacity: 0.75, border: '1px solid currentColor', borderRadius: 999, padding: '0 6px' },
      desc: { fontSize: 12, opacity: 0.7, margin: '6px 0 10px', lineHeight: 1.5 },
      groupTitle: { fontSize: 11, fontWeight: 600, opacity: 0.6, margin: '12px 0 6px', letterSpacing: '.04em' },
      row: { display: 'grid', gridTemplateColumns: '220px 1fr auto', gap: 8, alignItems: 'center', padding: '3px 0' },
      label: { fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      hint: { fontSize: 11, opacity: 0.55, display: 'block', marginTop: 1 },
      input: { width: '100%', boxSizing: 'border-box', padding: '4px 8px', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit' },
      /**
       * 模型选择弹窗的搜索框专用样式：明确的白底 + 深色字。
       *
       * 不复用 S.input —— 那份是「贴合宿主主题」的设置输入框（transparent + inherit），
       * 而弹窗自带一块深色底，两者叠在一起时主题色会失灵。这里就按弹窗自己的底色配
       * 一套固定配色：白底 #fff、字 #1b1b1f（对比度约 19:1）。
       *
       * placeholder 的颜色内联样式管不到（::placeholder 是伪元素），所以由 ModelPicker
       * 挂载时注入一条只命中 .dsh-tingxue-picker-input 的规则：#5c5c66、opacity 1，
       * 落在白底上约 5.9:1，达到 AA 正文要求。DSH 自己没有全局 input::placeholder
       * 规则，这条不会波及宿主或其它插件的输入框。
       */
      inputOnDark: {
        width: '100%', boxSizing: 'border-box', padding: '6px 10px', fontSize: 12, borderRadius: 6,
        border: '1px solid #3f3f46', background: '#ffffff', color: '#1b1b1f',
        caretColor: '#1b1b1f', outline: 'none',
      },
      reset: { fontSize: 11, padding: '2px 7px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      btn: { fontSize: 12, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      err: { fontSize: 12, color: '#d9534f', marginTop: 8 },
      meta: { fontSize: 11, opacity: 0.6, marginTop: 8 },
      // —— 模型选择弹窗 ——
      overlay: {
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      },
      modal: {
        width: 'min(560px, 100%)', maxHeight: 'min(70vh, 560px)', display: 'flex', flexDirection: 'column',
        // 弹窗自带固定深底，所以前景也必须固定：color:'inherit' 会从宿主设置页继承，
        // 在浅色主题下就是「深底 + 深字」，标题/说明/列表项全部看不见（实测 1.04:1）。
        background: 'var(--dsh-bg, #1b1b1f)', color: 'var(--dsh-fg, #e8e8ea)', borderRadius: 12,
        border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', padding: '14px 16px',
        boxShadow: '0 18px 48px rgba(0,0,0,.4)',
      },
      modalHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 },
      modalBody: { flex: 1, overflowY: 'auto', marginTop: 8, paddingRight: 2 },

      // —— 侧栏「听雪」页（状态总览）——
      // 全部颜色取自宿主主题令牌；令牌缺失时用 currentColor / transparent 兜底，
      // 不写死深色或浅色，主题切换时自动跟随。
      txPage: {
        flex: '1 1 auto', minHeight: 0, height: '100%', boxSizing: 'border-box',
        overflowY: 'auto', padding: '24px 28px 36px',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      txHead: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 18 },
      txTitle: { fontSize: 20, fontWeight: 600, lineHeight: 1.3, color: 'var(--dsw-alias-label-primary, inherit)' },
      txSub: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, currentColor)', marginTop: 3 },
      txCard: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        borderRadius: 'var(--dsw-radius-panel, 12px)',
        padding: '16px 18px', marginBottom: 14,
      },
      txCardTitle: { fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--dsw-alias-label-primary, inherit)' },
      txKV: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '6px 16px', fontSize: 12, alignItems: 'baseline' },
      txK: { color: 'var(--dsw-alias-label-secondary, currentColor)', fontSize: 12 },
      txV: { fontSize: 12, wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary, inherit)' },
      txMuted: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, currentColor)', lineHeight: 1.6 },
      txStats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: 12, marginBottom: 14 },
      txStat: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        borderRadius: 'var(--dsw-radius-panel, 12px)', padding: '14px 16px',
      },
      txStatLabel: { fontSize: 11, letterSpacing: '.04em', color: 'var(--dsw-alias-label-secondary, currentColor)' },
      txStatValue: { fontSize: 24, fontWeight: 600, marginTop: 5, fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-primary, inherit)' },
      txStatus: { display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 },
      txDot: { width: 8, height: 8, borderRadius: 999, display: 'inline-block', background: 'currentColor' },
      txRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      txError: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, currentColor)', marginTop: 10 },
      txDual: {
        marginTop: 2, fontSize: 12, padding: '10px 12px',
        color: 'var(--dsw-alias-label-secondary, currentColor)',
        border: '1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        borderRadius: 'var(--dsw-radius-md, 8px)',
      },

      // —— 侧栏「记忆图谱」页：整页 iframe ——
      txGraphWrap: {
        flex: '1 1 auto', minHeight: 0, height: '100%', width: '100%',
        display: 'flex', overflow: 'hidden', background: 'transparent',
        borderRadius: 'var(--dsw-radius-panel, 12px)',
      },
      txGraphFrame: {
        flex: '1 1 auto', width: '100%', height: '100%',
        border: 0, display: 'block', background: 'transparent',
      },
    }

    // ── 设置侧边栏页面 ──────────────────────────────────────────────────────
    /**
     * 设置侧边栏里的独立一页（导航项「听雪」）。
     *
     * 只注册这一个入口：早先还在「设置 → 插件 → 插件配置」里挂过同一份设置的第二张
     * 卡片，两处渲染同一个控制器、内容完全重复，用户明确要求只留侧边栏这一处。
     */
    function TingxueSection(props) {
      const tr = makeT(props.t)
      const state = props.useCard ? props.useCard((s) => s) : undefined
      // 命名与侧边栏 nav 统一成「听雪」；「双模式虚拟生命系统」降为下方说明行。
      const heading = () => h('span', { style: S.pageTitle }, tr('title', '听雪'))
      if (!state || state.status === 'loading') {
        return h('div', { style: S.page }, heading(), h('div', { style: S.desc }, tr('loading', '读取中…')))
      }
      if (state.status === 'unavailable' || !state.writable) {
        return h('div', { style: S.page }, heading(), h('div', { style: S.desc }, tr('unavailable', '当前连接不可写。')))
      }

      const groupNodes = GROUPS.map((g) => {
        const rows = state.fields.filter((f) => f.group === g)
        if (rows.length === 0) return null
        // 模型选择器要看「同一个表单里当前的」后端/端点/key，所以从本组已投影的
        // 字段里取草稿值（含未保存的改动），而不是读已保存的配置。
        const draftOf = (key) => {
          const hit = state.fields.find((f) => f.key === key)
          return hit ? String(hit.draft ?? '') : ''
        }
        const draft = {
          modelBackend: draftOf('modelBackend') || 'sta1n',
          baseURL: draftOf('baseURL'),
          apiKey: draftOf('apiKey'),
        }
        return h('div', { key: g },
          h('div', { style: S.groupTitle }, g),
          ...rows.map((f) => h(FieldRow, { key: f.key, f, tr, props, draft })),
        )
      })

      const head = h('div', { style: S.head },
        heading(),
        state.dirty ? h('span', { style: S.badge }, tr('unsaved', '有未保存的改动')) : null,
        h('span', { style: { flex: 1 } }),
        h('button', {
          type: 'button', style: S.btn, disabled: state.saving || !state.dirty,
          onClick: () => { props.discard && props.discard() },
        }, tr('discard', '放弃')),
        h('button', {
          type: 'button', style: S.btn, disabled: state.saving || !state.dirty,
          onClick: () => { props.save && props.save() },
        }, state.saving ? tr('saving', '保存中…') : tr('save', '保存')),
      )

      return h('div', { style: S.page },
        head,
        h('div', { style: S.desc }, tr('subtitle', '双模式虚拟生命系统')),
        h('div', { style: S.desc }, tr('description', '聊天模式与 agent 模式的人格、记忆库、模型、绑定与面板配置。改动在下次重启 DSH 后生效。')),
        ...groupNodes,
        state.error ? h('div', { style: S.err }, state.error) : null,
        h('div', { style: S.meta }, tr('restartHint', '标注「已覆盖」的字段会覆盖部署配置；重置即回落到部署层。')),
      )
    }

    /** 一个字段行：控件 + 覆盖标记 + 重置。 */
    function FieldRow(input) {
      const { f, tr, props, draft } = input
      const [picking, setPicking] = React.useState(false)
      const disabled = false
      const onEdit = (text) => { props.edit && props.edit(f.key, text) }
      // 只有模型 id 字段带选择器：值是端点上的一个 id，端点就是模型后端本身。
      const pickable = MODEL_FIELDS.has(f.key) && draft !== undefined
      const control = (() => {
        if (f.kind === 'boolean') {
          return h('input', {
            type: 'checkbox', checked: f.draft === 'true', disabled,
            style: { width: 15, height: 15 },
            onChange: (e) => { onEdit(e.target.checked ? 'true' : 'false') },
          })
        }
        if (f.kind === 'enum') {
          return h('select', {
            style: S.input, value: f.draft, disabled,
            onChange: (e) => { onEdit(e.target.value) },
          }, ...(f.values || []).map((v) => h('option', { key: v, value: v }, v)))
        }
        return h('input', {
          type: f.kind === 'number' ? 'number' : 'text',
          style: S.input, value: f.draft, disabled,
          'aria-invalid': f.invalid ? 'true' : undefined,
          onChange: (e) => { onEdit(e.target.value) },
        })
      })()

      // 弹窗挂在这一行的外层：放进行内会让它成为网格的第 4 个单元，
      // 把三列（标签/控件/重置）的排布挤歪。
      return h('div', null,
        h('div', { style: S.row },
          h('div', { style: S.label },
            h('span', null, f.label),
            f.overridden ? h('span', { style: S.badge }, tr('overridden', '已覆盖')) : null,
            f.hint ? h('span', { style: S.hint }, f.hint) : null,
          ),
          h('div', null,
            h('div', { style: pickable ? { display: 'flex', gap: 6, alignItems: 'flex-end' } : undefined },
              h('div', { style: pickable ? { flex: 1, minWidth: 0 } : undefined },
                control,
                f.invalid ? h('span', { style: { fontSize: 11, color: '#d9534f' } }, tr('invalidNumber', '请填数字')) : null,
              ),
              pickable ? h('button', {
                type: 'button', style: S.btn, title: tr('pickModel', '选择模型'),
                onClick: () => { setPicking(true) },
              }, tr('pickModel', '选择模型')) : null,
            ),
          ),
          f.overridden
            ? h('button', {
              type: 'button', style: S.reset, title: tr('reset', '重置'),
              onClick: () => { props.resetField && props.resetField(f.key) },
            }, tr('reset', '重置'))
            : h('span', null),
        ),
        picking ? h(ModelPicker, {
          tr, draft, currentValue: String(f.draft ?? ''), fieldLabel: f.label,
          onPick: (id) => { onEdit(id) },
          onClose: () => { setPicking(false) },
        }) : null,
      )
    }

    // ── 侧栏入口 / 同源反代 / 图谱页 ────────────────────────────────────────
    /** 两个侧栏入口 id；同一个 id 也是 main 槽位的 key 与反代前缀的末段。 */
    const PANEL_ID_TINGXUE = 'tingxue'
    const PANEL_ID_GRAPH = 'tingxue-graph'
    /** 同源反代前缀（Host 半侧 src/web-proxy.mjs 注册的两条 prefix 路由）。 */
    const MEMORY_PROXY_PATH = '/dsh-tingxue/memory'
    const GRAPH_PROXY_PATH = '/dsh-tingxue/graph'
    /** 记忆服务真实监听地址；只用于展示，浏览器不发跨源请求。 */
    const MEMORY_UPSTREAM = 'http://127.0.0.1:8766'
    /** 契约端点：健康探活与统计计数（都经同源反代转发）。 */
    const HEALTH_ENDPOINT = MEMORY_PROXY_PATH + '/health'
    const STATS_ENDPOINT = MEMORY_PROXY_PATH + '/stats'

    /** 没有注入翻译时的兜底（组件单独渲染/测试替身下不空着）。 */
    const fallbackTr = (key, fallback) => (fallback === undefined ? key : fallback)

    /**
     * 读宿主当前主题。
     *
     * 宿主（ui-layout 的 theme presenter）把生效的明暗投影成
     * `body[data-ds-dark-theme]` 与 `html{color-scheme}`；主题包也可能写
     * `data-theme` / class。按「显式标记 → 宿主投影 → 计算样式 → 系统偏好」
     * 逐层读，任一层能确定就返回，全读不到时才按浅色。
     * @returns {'light'|'dark'}
     */
    function readHostTheme() {
      const root = typeof document !== 'undefined' ? document.documentElement : null
      const body = typeof document !== 'undefined' ? document.body : null
      const rootMark = root && typeof root.getAttribute === 'function'
        ? (root.getAttribute('data-theme') || root.getAttribute('data-color-scheme'))
        : null
      const bodyMark = body && typeof body.getAttribute === 'function'
        ? (body.getAttribute('data-theme') || body.getAttribute('data-color-scheme'))
        : null
      const explicit = rootMark || bodyMark
      if (explicit === 'dark' || explicit === 'light') return explicit
      if (body && typeof body.hasAttribute === 'function' && body.hasAttribute('data-ds-dark-theme')) return 'dark'
      if (body && typeof body.hasAttribute === 'function' && body.hasAttribute('data-ds-light-theme')) return 'light'
      for (const name of ['dark', 'theme-dark', 'dsh-dark', 'ds-dark']) {
        if (root && root.classList && root.classList.contains(name)) return 'dark'
      }
      for (const name of ['light', 'theme-light', 'dsh-light', 'ds-light']) {
        if (root && root.classList && root.classList.contains(name)) return 'light'
      }
      try {
        if (root && typeof getComputedStyle === 'function') {
          const scheme = String(getComputedStyle(root).colorScheme || '').toLowerCase()
          if (scheme.includes('dark')) return 'dark'
          if (scheme.includes('light')) return 'light'
        }
      } catch { /* 计算样式不可读：继续回落 */ }
      try {
        if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
      } catch { /* 没有 matchMedia：按浅色 */ }
      return 'light'
    }

    /**
     * 图谱 iframe 地址。
     *
     * 契约里的默认值是 `/dsh-tingxue/graph/?api=/dsh-tingxue/memory&theme=auto`；
     * 这里把 auto 换成宿主解析出的 light|dark，让 iframe 首帧就与宿主一致，
     * 不再让图谱页自己猜一次主题。
     * @param {'light'|'dark'} theme
     * @returns {string}
     */
    function graphSrc(theme) {
      const resolved = theme === 'dark' ? 'dark' : 'light'
      return GRAPH_PROXY_PATH + '/?api=' + MEMORY_PROXY_PATH + '&theme=' + resolved
    }

    /** GET 一个听雪 JSON 端点；非 2xx 或 ok!==true 都转成可显示的 Error。 */
    async function fetchJson(path) {
      const response = await fetch(path, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      let body = null
      try { body = await response.json() } catch { body = null }
      if (!response.ok) throw new Error((body && body.error) || ('HTTP ' + response.status))
      if (!body || body.ok !== true) throw new Error((body && body.error) || '响应不是有效的听雪 API 数据')
      return body
    }

    /**
     * 打开宿主设置对话框。
     *
     * 设置面板归 ui-settings-general 所有，浏览器侧没有公开 service 可调用
     * （`settings.open` 快捷键只在它自己的 resolve 里执行），因此这里点它渲染在
     * `sidebar.settings` 槽里的 trigger 按钮；槽位找不到时再派发一次宿主快捷键。
     * 两种情况都失败就静默返回 false，不影响页面其它功能。
     * @returns {boolean}
     */
    function openHostSettings() {
      try {
        if (typeof document !== 'undefined') {
          const seat = document.querySelector('[data-slot="sidebar.settings"]')
          const trigger = seat && (seat.querySelector('button[aria-haspopup="dialog"]') || seat.querySelector('button'))
          if (trigger && typeof trigger.click === 'function') {
            trigger.click()
            return true
          }
        }
      } catch { /* 落到快捷键 */ }
      try {
        if (typeof document === 'undefined' || typeof KeyboardEvent !== 'function') return false
        const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(String(navigator.platform || ''))
        const event = new KeyboardEvent('keydown', {
          key: ',', code: 'Comma', bubbles: true, cancelable: true,
          ctrlKey: !mac, metaKey: mac, altKey: true,
        })
        document.dispatchEvent(event)
        return true
      } catch { return false }
    }

    /** 状态总览的数据源：健康探活 + 统计计数，挂载即拉一次，刷新按钮可重拉。 */
    function useMemoryOverview() {
      const [state, setState] = React.useState({ status: 'loading', health: null, stats: null, error: null, at: 0 })
      const reload = React.useCallback(async () => {
        setState((previous) => ({ ...previous, status: 'loading', error: null }))
        const [healthResult, statsResult] = await Promise.allSettled([
          fetchJson(HEALTH_ENDPOINT),
          fetchJson(STATS_ENDPOINT),
        ])
        const health = healthResult.status === 'fulfilled' ? healthResult.value : null
        const stats = statsResult.status === 'fulfilled' ? statsResult.value : null
        const failures = [healthResult, statsResult]
          .filter((result) => result.status === 'rejected')
          .map((result) => String(result.reason && result.reason.message ? result.reason.message : result.reason))
        setState({
          status: health ? 'online' : 'offline',
          health,
          stats,
          error: failures.length > 0 ? failures.join('；') : null,
          at: Date.now(),
        })
      }, [])
      React.useEffect(() => { void reload() }, [reload])
      return { state, reload }
    }

    function formatClock(at) {
      try {
        return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      } catch { return String(at) }
    }

    /**
     * 侧栏「听雪」图标：16×16 线稿雪花（三条轴线 + 中心圆），参数与宿主
     * 其它 panel 行一致：strokeWidth 1.3、currentColor、round。
     * 行本身由宿主 shell 拥有；glyph 用 data-dsh-panel-entry 标出归属。
     */
    function TingxuePanelIcon({ size = 16, active }) {
      return h('svg', {
        'data-dsh-panel-entry': PANEL_ID_TINGXUE,
        'data-active': active ? 'true' : undefined,
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.3',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { key: 'axis', d: 'M8 2v12' }),
        h('path', { key: 'diagonal-a', d: 'M2.9 5l10.2 6' }),
        h('path', { key: 'diagonal-b', d: 'M13.1 5L2.9 11' }),
        h('circle', { key: 'hub', cx: 8, cy: 8, r: 1.05 }),
      )
    }

    /** 侧栏「记忆图谱」图标：16×16 线稿三节点连线（两个圆 + 一条连到第三点）。 */
    function TingxueGraphIcon({ size = 16, active }) {
      return h('svg', {
        'data-dsh-panel-entry': PANEL_ID_GRAPH,
        'data-active': active ? 'true' : undefined,
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.3',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { key: 'edge-ab', d: 'M4.6 10.7l2.5-5.3' }),
        h('path', { key: 'edge-bc', d: 'M9.2 4.8l2.5 2.9' }),
        h('path', { key: 'edge-ac', d: 'M5 11.3l5.8-2' }),
        h('circle', { key: 'node-a', cx: 3.7, cy: 11.7, r: 1.35 }),
        h('circle', { key: 'node-b', cx: 8, cy: 3.6, r: 1.35 }),
        h('circle', { key: 'node-c', cx: 12.4, cy: 9.2, r: 1.35 }),
      )
    }

    /** 侧栏「听雪」页：记忆服务的只读状态总览 + 两个入口 + 双模式占位。 */
    function TingxuePanelPage(props) {
      const tr = props.tr || fallbackTr
      const { state, reload } = useMemoryOverview()
      const busy = state.status === 'loading'
      const online = state.status === 'online'
      const health = state.health || {}
      const stats = state.stats || {}
      const statusText = busy
        ? tr('statusLoading', '连接中…')
        : (online ? tr('statusOnline', '在线') : tr('statusOffline', '离线'))
      const statusColor = busy
        ? 'var(--dsw-alias-label-tertiary, currentColor)'
        : (online ? 'var(--dsw-alias-state-success-primary, currentColor)' : 'var(--dsw-alias-state-error-primary, currentColor)')
      const number = (value) => {
        if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString()
        if (value === undefined || value === null || value === '') return '—'
        return String(value)
      }
      const tiles = [
        { key: 'memories', label: tr('memories', '记忆'), value: stats.memories },
        { key: 'entities', label: tr('entities', '实体'), value: stats.entities },
        { key: 'relations', label: tr('relations', '关系'), value: stats.relations },
        { key: 'activeRelations', label: tr('activeRelations', '有效关系'), value: stats.activeRelations },
        { key: 'trash', label: tr('trash', '回收站'), value: stats.trash },
      ]

      return h('div', { style: S.txPage, 'data-dsh-tingxue-view': 'home' },
        h('div', { style: S.txHead },
          h('div', null,
            h('div', { style: S.txTitle }, tr('title', '听雪')),
            h('div', { style: S.txSub }, tr('subtitle', '双模式虚拟生命系统')),
          ),
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button', style: S.btn, disabled: busy,
            onClick: () => { void reload() },
          }, busy ? tr('refreshing', '刷新中…') : tr('refresh', '刷新')),
        ),

        h('div', { style: S.txCard },
          h('div', { style: S.txCardTitle }, tr('overview', '状态总览')),
          h('div', { style: S.txKV },
            h('span', { style: S.txK }, tr('serviceStatus', '服务状态')),
            h('span', { style: S.txV },
              h('span', { style: { ...S.txStatus, color: statusColor } },
                h('span', { style: S.txDot }),
                h('span', null, statusText),
              ),
              online && health.service
                ? h('span', { style: { ...S.txMuted, marginLeft: 8 } },
                  String(health.service) + (health.port ? ' · :' + String(health.port) : ''))
                : null,
            ),
            h('span', { style: S.txK }, tr('serviceAddress', '服务地址')),
            h('span', { style: S.txV }, MEMORY_UPSTREAM),
            h('span', { style: S.txK }, tr('sameOriginPath', '同源路径')),
            h('span', { style: S.txV }, MEMORY_PROXY_PATH),
            state.at ? h('span', { style: S.txK }, tr('updatedAt', '上次刷新')) : null,
            state.at ? h('span', { style: S.txV }, formatClock(state.at)) : null,
          ),
          state.error ? h('div', { style: S.txError }, tr('loadFailed', '读取失败') + '：' + state.error) : null,
          !busy && !online ? h('div', { style: { ...S.txMuted, marginTop: 8 } }, tr('offlineHint', '记忆服务未响应：确认「面板与服务 → 启用记忆服务」已打开，并检查服务端口。')) : null,
          h('div', { style: { ...S.txMuted, marginTop: 8 } }, tr('overviewHint', '只读探活与计数；记忆服务由插件自己拉起，这里不会写入或修改记忆库。')),
        ),

        h('div', { style: S.txStats },
          ...tiles.map((tile) => h('div', { key: tile.key, style: S.txStat },
            h('div', { style: S.txStatLabel }, tile.label),
            h('div', { style: S.txStatValue }, number(tile.value)),
          )),
        ),

        h('div', { style: S.txCard },
          h('div', { style: S.txCardTitle }, tr('actions', '入口')),
          h('div', { style: S.txRow },
            h('button', {
              type: 'button', style: S.btn,
              onClick: () => { if (typeof props.openGraph === 'function') props.openGraph() },
            }, tr('openGraph', '打开记忆图谱')),
            h('button', {
              type: 'button', style: S.btn,
              onClick: () => { if (typeof props.openSettings === 'function') props.openSettings() },
            }, tr('openSettings', '打开设置')),
          ),
        ),

        h('div', { style: S.txDual }, tr('dualModePending', '双模式：待接线')),
      )
    }

    /**
     * 侧栏「记忆图谱」页：整页 iframe。
     *
     * 图谱资源由 8765 提供、接口走同源反代 `/dsh-tingxue/memory`，浏览器不接触
     * 8765/8766 的跨源地址。主题从宿主读一次，然后用 MutationObserver（html/body
     * 的 data-theme/class/style）与 matchMedia 监听变化，变化时更新 src。
     * 组件只在 layout 选中本 panel 时挂载，切走即卸载（iframe 随之销毁）。
     */
    function TingxueGraphPage(props) {
      const tr = props.tr || fallbackTr
      const [theme, setTheme] = React.useState(readHostTheme)
      React.useEffect(() => {
        let live = true
        const sync = () => {
          if (!live) return
          setTheme((previous) => {
            const next = readHostTheme()
            return next === previous ? previous : next
          })
        }
        const observer = typeof MutationObserver === 'function' ? new MutationObserver(sync) : null
        const attributes = ['data-theme', 'data-ds-dark-theme', 'data-ds-light-theme', 'data-color-scheme', 'class', 'style']
        try {
          if (observer && typeof document !== 'undefined') {
            observer.observe(document.documentElement, { attributes: true, attributeFilter: attributes })
            if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: attributes })
          }
        } catch { /* 观察失败：仍保留首帧主题 */ }
        let media = null
        try { media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null } catch { media = null }
        if (media) {
          if (typeof media.addEventListener === 'function') media.addEventListener('change', sync)
          else if (typeof media.addListener === 'function') media.addListener(sync)
        }
        sync()
        return () => {
          live = false
          try { observer?.disconnect?.() } catch { /* 已断开 */ }
          if (media) {
            try {
              if (typeof media.removeEventListener === 'function') media.removeEventListener('change', sync)
              else if (typeof media.removeListener === 'function') media.removeListener(sync)
            } catch { /* 已移除 */ }
          }
        }
      }, [])

      return h('div', { style: S.txGraphWrap, 'data-dsh-tingxue-view': 'graph' },
        h('iframe', {
          src: graphSrc(theme),
          title: tr('graphFrameTitle', '听雪 · 记忆图谱'),
          style: S.txGraphFrame,
          referrerPolicy: 'no-referrer',
        }),
      )
    }

    // ── 插件 apply ──────────────────────────────────────────────────────────
    /** 设置命名空间——与 Host 半侧 TINGXUE_SETTINGS_NS 同一个键。 */
    const TINGXUE_NS = 'dsh-tingxue'

    /**
     * HTTP 作用域：宿主 0.2.1-rc.5 的浏览器端没有 settingsScope 服务，
     * 改用 Host 半侧挂在同源上的 `/dsh-tingxue/config`（读 describe / 写 update）。
     * 形状与 settingsScope.bind() 的返回值对齐：getSnapshot / subscribe / set / unset。
     */
    function createHttpScope() {
      const endpoint = '/dsh-tingxue/config'
      let snapshot = { status: 'loading', writable: true, value: {}, base: {}, user: {}, revision: 0 }
      const listeners = new Set()
      const notify = () => { for (const fn of listeners) { try { fn() } catch { /* 订阅者异常不影响其他订阅者 */ } } }
      const usable = () => typeof fetch === 'function'

      async function refresh() {
        if (!usable()) { snapshot = { ...snapshot, status: 'error', error: 'no fetch' }; notify(); return }
        try {
          const response = await fetch(endpoint, { credentials: 'same-origin', headers: { accept: 'application/json' } })
          const data = await response.json()
          if (data && data.ok !== false) {
            snapshot = {
              status: 'ready',
              writable: data.writable !== false,
              value: data.value || {},
              base: data.base || {},
              user: data.user || {},
              revision: typeof data.revision === 'number' ? data.revision : 0,
            }
          } else {
            snapshot = { ...snapshot, status: 'error', error: (data && data.error) || ('HTTP ' + response.status) }
          }
        } catch (error) {
          const isShell = typeof location !== 'undefined' && !/^https?:$/.test(location.protocol)
          snapshot = {
            ...snapshot,
            status: 'error',
            error: isShell
              ? '桌面外壳里读不到设置：请在浏览器打开 Web GUI（http://127.0.0.1:63078）后修改，或等 RPC 版接线'
              : ((error && error.message) || String(error)),
          }
        }
        notify()
      }

      async function write(body) {
        if (!usable()) throw new Error('当前环境没有 fetch')
        const response = await fetch(endpoint, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, expectedRevision: snapshot.revision }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok || data.ok === false) {
          throw new Error((data && data.error) || ('写入设置失败：HTTP ' + response.status))
        }
        await refresh()
      }

      if (usable()) void refresh()
      return {
        getSnapshot: () => snapshot,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
        set(key, value) { return write({ patch: { [key]: value } }) },
        unset(key) { return write({ unset: [key] }) },
        refresh,
      }
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tingxue: dictionaries')

      // 设置作用域：优先用宿主真正提供的 settingsScope（老构建）；
      // 本构建（0.2.1-rc.5）没有这个服务，退回到同源 `/dsh-tingxue/config`。
      // 两条路径都失败时只少一张设置卡片，侧栏与图谱页照常，启动永不被拖住。
      let card = null
      let scopeService = null
      try {
        scopeService = typeof ctx.get === 'function' ? ctx.get('settingsScope') : ctx.settingsScope
      } catch { /* 服务未注册 */ }
      if (scopeService && typeof scopeService.bind === 'function') {
        try {
          card = createCardController(scopeService.bind({ namespace: TINGXUE_NS }))
        } catch (error) {
          try { console.warn('[dsh-tingxue] settingsScope.bind 失败，改用同源配置接口:', error?.message ?? error) } catch { /* 忽略 */ }
        }
      }
      if (!card) {
        try {
          card = createCardController(createHttpScope())
        } catch (error) {
          try { console.warn('[dsh-tingxue] 设置卡片不可用（侧栏仍加载）:', error?.message ?? error) } catch { /* 忽略 */ }
        }
      }
      /** 侧栏页/入口共用同一份翻译（含内嵌中文兜底）。 */
      const tr = makeT(ctx.locale.bind(NS))

      /**
       * 切到「记忆图谱」panel。
       * layout 是可选服务：宿主没有它时静默忽略，入口不会因为切页报错而崩。
       */
      function openGraph() {
        try {
          const layout = ctx.get?.('layout')
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID_GRAPH)
        } catch { /* 无 layout / key 未注册：保持当前 panel */ }
      }

      /** 打开宿主设置对话框（链路见 openHostSettings 注释）。 */
      function openSettings() {
        openHostSettings()
      }

      // ── 侧栏两个入口 + 两个 main 页 ──────────────────────────────────────
      // seat 由宿主 shell（ui-sidebar / ui-layout）声明，用 slots.inject 包住：
      // 声明顺序无关；宿主没有该 seat 时入口自然缺席，也不会阻塞插件启动。
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID_TINGXUE,
        order: 40,
        label: () => tr('nav', '听雪'),
      }, TingxuePanelIcon))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID_GRAPH,
        order: 41,
        label: () => tr('graphNav', '记忆图谱'),
      }, TingxueGraphIcon))
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID_TINGXUE,
        inject: () => ({ tr, openGraph, openSettings }),
      }, TingxuePanelPage))
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID_GRAPH,
        inject: () => ({ tr }),
      }, TingxueGraphPage))

      // 唯一设置入口：设置侧边栏里的独立一页（导航项「听雪」，排在 agent-presets 之后）。
      // 不再注册 settings.plugin.item 的第二张卡片：两处渲染同一份设置，纯重复。
      // Host 半侧的命名空间注册（src/settings/index.mjs）与浏览器侧入口无关，
      // 所以去掉卡片不影响保存链路。
      if (card) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'tingxue',
          order: 26,
          label: () => ctx.locale.bind(NS)('nav'),
          locale: NS,
          inject: () => card.inject(),
        }, TingxueSection))
      }
    }

    exports.apply = apply
    // 只声明本构建确实提供的服务。加任何本构建没有的服务（曾误加
    // settingsScope）都会让插件永久 pending，web boot 失败、整个应用起不来。
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
