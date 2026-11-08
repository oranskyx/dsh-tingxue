// dsh-tingxue-ui · 浏览器半边
//
// 手写的 lazy-CJS 客户端模块（格式同 dsh-vision-router / dsh-cost-meter 这类外部插件）：
// 客户端模块系统把整个文件包进 CJS factory，内核采纳 { apply, inject } 作为客户端插件。
//
// 两页注册进侧栏：
//   sidebar.panellist  ← 两个入口图标（听雪 / 听雪-agent）
//   main               ← 两个整页组件，key 与入口 id 相同
//
// 所有网络请求都走 Host 半边注册的同源路径（/dsh-tingxue-ui/*），浏览器不直连 8766，
// 因此没有 CORS 问题；Host 半边没起来时页面显示「离线 / 未接线」，不白屏、不抛错。
// 全部颜色只取宿主主题令牌（--dsw-alias-* / --dsw-radius-*），不写死深浅色。

window.__ModuleLoader__.load({
  id: 'dsh-tingxue',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ── 常量 ────────────────────────────────────────────────────────────────
    const NS = 'dsh-tingxue-panel'
    const MEMORY = '/dsh-tingxue-ui/memory'
    const PING = '/dsh-tingxue-ui/ping'
    const PANEL = '/dsh-tingxue-ui/panel'
    const CONTEXT = '/dsh-tingxue-ui/context'

    const PANEL_COMPANION = 'tingxue-companion'
    const PANEL_AGENT = 'tingxue-agent'
    /** 记忆服务面板：放所有「两个 bot 共用」的配置（模型 / API / 服务状态 / 记忆库 / QQ 通道）。 */
    const PANEL_MEMORY = 'tingxue-memory'
  const PANEL_GRAPH = 'tingxue-graph'

    const DEFAULT_MEMORY = 'http://127.0.0.1:8766'
    const DEFAULT_SKILLS_DIR = 'D:\\dsh-home\\skills'

    // ── 文案（目标用户为中文；注册进 locale 服务，缺失时回落到这里的兜底）────
    const DICT = {
      nav_companion: '聊天面板',
      nav_agent: 'agent面板',
      nav_memory: '记忆服务面板',
      nav_graph: '记忆图谱',
      graph_title: '记忆图谱',
      graph_sub: '实体关系可视化 · 实体 / 关系 / 记忆 / 回收站',
      graph_offline: '图谱界面没有响应：8765 面板没起来。启动记忆服务后刷新即可。',
      graph_fallback: '如果上面是空白，说明内嵌被拦了——',
      graph_open_raw: '在新标签页打开图谱',
      graph_fallback2: '（同一份数据，只是外面少了面板壳）',

      loading: '连接中…',
      refresh: '刷新',
      refreshing: '刷新中…',
      last_updated: '上次刷新 {time}',
      save: '保存',
      saving: '保存中…',
      retry: '重试',

      companion_title: '聊天面板',
      companion_sub: '陪伴 bot · 记忆、模型与人格',
      companion_badge: '陪伴',
      agent_title: 'agent面板',
      memory_title: '记忆服务面板',
      agent_sub: '干活 bot · 只召回已完结的项目档案',
      agent_badge: 'agent',

      status_title: '服务状态',
      memory_service: '记忆服务',
      online: '在线',
      offline: '离线',
      latency: '延迟',
      ms: 'ms',
      open_graph: '打开图谱',
      service_addr: '地址',
      status_hint: '探活由 Host 半边发起（同源 /dsh-tingxue-ui/ping），浏览器不直连本机端口。',

      stats_title: '记忆库统计',
      memories: '记忆',
      entities: '实体',
      relations: '关系',
      trash: '回收站',
      stats_hint: '数字来自记忆服务 GET /memory/stats。',

      api_title: 'API 配置',
      api_sub: '读写记忆服务 GET /config 与 PUT /config；API Key 只经 PUT 交给服务端，页面不落盘。',
      backend: '后端名',
      backend_hint: '记忆服务使用的模型后端（sta1n 云端 / local 本地 / custom 自定义）。',
      base_url: 'API Base URL',
      base_url_hint: 'OpenAI 兼容端点根地址，例如 https://cdn.sta1n.cn/v1。',
      api_key: 'API Key',
      api_key_hint: '密码框，可显示 / 清空；只在本页内存里持有，保存时经 PUT /config 交给服务端。',
      api_key_set: '服务端已配置 Key',
      api_key_unset: '服务端未配置 Key',
      api_key_placeholder: '输入 API Key（仅本次保存发送）',
      show_key: '显示',
      hide_key: '隐藏',
      clear_key: '清空',
      embedding_model: '向量模型',
      embedding_model_hint: '同库单一模型：换模型需要全量重嵌入。',
      embedding_dims: '向量维度',
      embedding_dims_hint: '必须与向量模型的实际输出维度一致。',
      llm_model: '小 LLM 模型',
      llm_model_hint: '实体抽取 / 摘要用的语义推理模型。',
      save_api: '保存 API 配置',
      api_offline: '记忆服务离线，暂时读不到也写不了配置。',
      api_saved: '已保存：{fields}',
      api_saved_none: '服务端没有回显任何字段',
      api_ignored: '服务端未接受：{fields}（当前服务版本忽略这两个字段，需服务端支持）',
      api_restart: '服务端提示需要重启记忆服务才生效。',
      api_warning: '服务端提示：{text}',
      api_unchanged: '没有改动，无需保存。',
      dims_invalid: '向量维度必须是正整数。',
      backend_required: '后端名不能为空。',
      model_required: '模型名不能为空。',
      api_failed: '保存失败：{reason}',

      switch_title: '记忆开关',
      switch_sub: '注入档位决定每轮给模型带多少记忆；改动保存到面板配置。',
      tier: '注入档位',
      tier_full: '全量',
      tier_full_desc: '召回全部相关记忆与最近对话，上下文最完整。',
      tier_archive: '仅档案',
      tier_archive_desc: '只召回已完结的项目档案，适合干活场景。',
      tier_off: '关闭',
      tier_off_desc: '不注入任何记忆，模型只看当前会话。',
      relation_expand: '关系扩展',
      relation_expand_desc: '沿实体关系把相邻记忆一起带进上下文。',
      write_back: '每轮回写',
      write_back_desc: '每轮结束后把本轮结论写回记忆库。',
      save_switch: '保存开关',
      switch_saved: '开关已保存到面板配置。',
      switch_failed: '开关保存失败：{reason}',
      agent_switch_note: '干活 bot 只召回已完结项目档案：默认档位为「仅档案」，避免把聊天上下文带进任务。',

      persona_title: '人格',
      persona_sub: '只读预览，面板不修改人格档案。',
      persona_path: '档案路径',
      persona_chars: '字数',
      persona_preview: '预览',
      persona_empty: '人格档案为空或不可读。',
      persona_offline: '记忆服务离线，读不到人格档案。',
      chars: '字',

      archive_title: '收工归档',
      archive_sub: '收工触发词命中后，把本轮产出归档进 skill 输出目录。',
      archive_keyword: '触发词',
      archive_keyword_hint: '默认 agentout；在 QQ 里发这个词开始收工归档。',
      archive_keyword_required: '触发词不能为空。',
      skills_dir: 'skill 输出目录',
      skills_dir_hint: '归档产出的落点目录。',
      skills_dir_required: '输出目录不能为空。',
      archive_recent: '最近归档',
      archive_empty: '目录里还没有归档。',
      archive_missing: '目录不存在或不可读。',
      archive_hint: '列表来自 Host 半边读取该目录，按修改时间倒序。',
      save_archive: '保存归档设置',
      archive_saved: '归档设置已保存。',
      archive_failed: '归档设置保存失败：{reason}',
      dir_kind: '目录',

      context_title: '上下文',
      context_sub: 'DSH 自动压缩（compaction-basic）：上下文用到多少比例时压缩、压缩后保留多少。',
      context_threshold: '上下文压缩阈值',
      context_threshold_hint: '百分比，10–95 的整数；上下文占到这条线就把较早历史压成一条摘要。落盘为 thresholdRatio（除以 100）。',
      context_shared: '两个 bot 共用（框架层只有一个阈值）',
      context_retain: '压缩后保留',
      context_retain_hint: '压缩后原样保留的最近对话比例，0–100 的整数；落盘为 retainRatio（除以 100）。',
      context_pct: '%',
      context_current: '当前生效：压缩阈值 {threshold} · 保留 {retain}',
      context_default: '使用默认值',
      context_global_note: 'DSH 不支持按 bot 单独设置上下文长度。',
      context_save: '保存上下文设置',
      context_saved: '已保存：压缩阈值 {threshold} · 保留 {retain}',
      context_failed: '保存失败：{reason}',
      context_invalid: '压缩阈值请填 10–95 的整数百分比，保留请填 0–100。',
      context_none: '至少填一项再保存。',
      context_offline: '上下文设置接口未就绪：Host 半边没有响应（/dsh-tingxue-ui/context）。插件可能还没加载，或需要重装插件。',
      context_unavailable: '改不了：{reason}',
      context_compact_hint: '要立即压缩，在对话输入框发送 /compact（作用于当前会话）。',
      context_readback: '保存后回读的值来自 profile 配置层，不是页面自己记的。',

      workspace_title: '工作区',
      workspace_sub: '当前会话的默认工作区，由 Host 的 workingDirectory 提供。',
      workspace_path: '工作区路径',
      copy: '复制',
      copied: '已复制',

      host_missing: 'Host 面板接口未就绪：/dsh-tingxue-ui/panel 没有响应。插件可能还没加载，或需要重启 DSH。',
      host_forbidden: '面板接口只允许本机 loopback 访问；当前连接不是本机。',
      load_failed: '读取失败：{reason}',
      no_data: '—',
    }

    function makeTr(t) {
      return (key, fallback) => {
        if (typeof t === 'function') {
          try {
            const value = t(key)
            if (value && value !== key) return value
          } catch { /* 回落到内嵌中文 */ }
        }
        if (fallback !== undefined) return fallback
        return DICT[key] !== undefined ? DICT[key] : key
      }
    }

    // ── 网络 ────────────────────────────────────────────────────────────────
    /** 同源 GET；非 2xx 或 ok:false 都转成带原因的 Error。 */
    function fetchJson(url, init) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), 9000) : null
      const options = {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        ...(init || {}),
      }
      if (controller) options.signal = controller.signal
      return fetch(url, options)
        .then(async (response) => {
          let body = null
          try { body = await response.json() } catch { body = null }
          if (!response.ok) {
            throw new Error((body && body.error) || ('HTTP ' + response.status))
          }
          if (body && body.ok === false) {
            throw new Error((body && body.error) || '请求失败')
          }
          return body
        })
        .finally(() => { if (timer) clearTimeout(timer) })
    }

    function putJson(url, payload) {
      return fetchJson(url, {
        method: 'PUT',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    }

    /** 一次拉齐两页要用的只读数据；任何一路失败都只让对应区域显示「离线」。 */
    function useDashboard() {
      const [state, setState] = React.useState({
        status: 'loading', at: 0, ping: null, health: null, stats: null,
        config: null, profile: null, panel: null, context: null, errors: [],
      })
      const seq = React.useRef(0)
      const load = React.useCallback(async () => {
        const id = ++seq.current
        setState((previous) => ({ ...previous, status: 'loading' }))
        const results = await Promise.allSettled([
          fetchJson(PING),
          fetchJson(MEMORY + '/health'),
          fetchJson(MEMORY + '/memory/stats'),
          fetchJson(MEMORY + '/config'),
          fetchJson(MEMORY + '/profile'),
          fetchJson(PANEL),
          fetchJson(CONTEXT),
        ])
        if (id !== seq.current) return
        const pick = (result) => (result.status === 'fulfilled' ? result.value : null)
        const errors = results
          .filter((result) => result.status === 'rejected')
          .map((result) => String((result.reason && result.reason.message) || result.reason))
        setState({
          status: 'ready',
          at: Date.now(),
          ping: pick(results[0]),
          health: pick(results[1]),
          stats: pick(results[2]),
          config: pick(results[3]),
          profile: pick(results[4]),
          panel: pick(results[5]),
          context: pick(results[6]),
          errors: Array.from(new Set(errors)),
        })
      }, [])
      React.useEffect(() => { void load() }, [load])
      return [state, load]
    }

    // ── 小工具 ──────────────────────────────────────────────────────────────
    const text = (value) => (value === undefined || value === null ? '' : String(value))

    function formatInt(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString('zh-CN')
      if (value === undefined || value === null || value === '') return '—'
      return String(value)
    }

    function formatTime(ms) {
      try {
        return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
      } catch {
        return String(ms)
      }
    }

    function formatDate(ms) {
      try {
        return new Date(ms).toLocaleString('zh-CN', { hour12: false })
      } catch {
        return String(ms)
      }
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—'
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / 1024 / 1024).toFixed(1) + ' MB'
    }

    function hasHostRouteError(state) {
      return state.errors.some((message) => /404/.test(message))
    }

    function hasForbidden(state) {
      return state.errors.some((message) => /403|loopback/i.test(message))
    }

    // ── 图标（16×16 线稿，颜色一律 currentColor）────────────────────────────
    const stroke = {
      fill: 'none', stroke: 'currentColor', strokeWidth: '1.3',
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    }

    function IconPulse() {
      return h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, ...stroke },
        h('path', { d: 'M1.6 8h2.6l1.8-4.6L8.4 12l1.9-4h4.1' }))
    }

    function IconDatabase() {
      return h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, ...stroke },
        h('ellipse', { cx: 8, cy: 4, rx: 5.4, ry: 2.2 }),
        h('path', { d: 'M2.6 4v4c0 1.2 2.4 2.2 5.4 2.2s5.4-1 5.4-2.2V4' }),
        h('path', { d: 'M2.6 8v4c0 1.2 2.4 2.2 5.4 2.2s5.4-1 5.4-2.2V8' }))
    }

    function IconKey() {
      return h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, ...stroke },
        h('circle', { cx: 5.4, cy: 10.6, r: 2.6 }),
        h('path', { d: 'M7.4 8.6L13.4 2.6' }),
        h('path', { d: 'M11 5l1.8 1.8M9.2 6.8l1.5 1.5' }))
    }

    function IconSliders() {
      return h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, ...stroke },
        h('path', { d: 'M2 4.5h7M12.5 4.5H14M2 11.5h2.5M8 11.5h6' }),
        h('circle', { cx: 10.6, cy: 4.5, r: 1.6 }),
        h('circle', { cx: 6.2, cy: 11.5, r: 1.6 }))
    }

    function IconGauge() {
      return h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, ...stroke },
        h('path', { d: 'M2.2 11.4a6.2 6.2 0 1 1 11.6 0' }),
        h('path', { d: 'M8 11.4L10.9 6.3' }),
        h('circle', { cx: 8, cy: 11.4, r: 1.1 }))
    }

    function IconUser() {
      return h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, ...stroke },
        h('circle', { cx: 8, cy: 5.2, r: 2.6 }),
        h('path', { d: 'M2.8 13.6c.7-2.6 2.8-4 5.2-4s4.5 1.4 5.2 4' }))
    }

    function IconArchive() {
      return h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, ...stroke },
        h('rect', { x: 1.8, y: 2.6, width: 12.4, height: 3.2, rx: 1 }),
        h('path', { d: 'M3 5.8v6.4c0 .7.6 1.2 1.2 1.2h7.6c.6 0 1.2-.5 1.2-1.2V5.8' }),
        h('path', { d: 'M6.3 8.6h3.4' }))
    }

    function IconFolder() {
      return h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, ...stroke },
        h('path', { d: 'M1.8 4.6c0-.7.5-1.2 1.2-1.2h3.2l1.4 1.7h5.4c.7 0 1.2.5 1.2 1.2v5.6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.6z' }))
    }

    /** 侧栏「听雪」入口图标：16×16 雪花。 */
    /**
     * 侧栏「聊天面板」图标：16×16 六角雪花。
     *
     * 六条臂**每条末端都有 V 形分叉** —— 之前只有竖直那一条的两端有分叉，
     * 四条斜臂是光秃秃的直线，看起来像「加号加两道杠」而不是雪花。
     * 分叉从臂的 4.4 半径处向两侧各张 55°、长 2.3，六条臂对称。
     */
    function CompanionIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, ...stroke },
        h('path', { d: 'M8 7.1L8 1.6M8.78 7.55L13.54 4.8M8.78 8.45L13.54 11.2M8 8.9L8 14.4M7.22 8.45L2.46 11.2M7.22 7.55L2.46 4.8M8 3.6L6.12 2.28M8 3.6L9.88 2.28M11.81 5.8L12.01 3.51M11.81 5.8L13.9 6.77M11.81 10.2L13.9 9.23M11.81 10.2L12.01 12.49M8 12.4L9.88 13.72M8 12.4L6.12 13.72M4.19 10.2L3.99 12.49M4.19 10.2L2.1 9.23M4.19 5.8L2.1 6.77M4.19 5.8L3.99 3.51' }),
        h('circle', { cx: 8, cy: 8, r: 0.9 }))
    }

    /** 侧栏「听雪-agent」入口图标：16×16 终端窗口。 */
    function AgentIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, ...stroke },
        h('rect', { x: 1.7, y: 2.4, width: 12.6, height: 11.2, rx: 2 }),
        h('path', { d: 'M4.6 6.2l2.3 2-2.3 2' }),
        h('path', { d: 'M8.8 10.2h2.7' }))
    }

    /** 记忆图谱图标：三个节点 + 连线，和另三个图标的笔画风格一致。 */
    function GraphIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, ...stroke },
        h('circle', { cx: 3.4, cy: 4.2, r: 1.7 }),
        h('circle', { cx: 12.6, cy: 4.2, r: 1.7 }),
        h('circle', { cx: 8, cy: 12.2, r: 1.7 }),
        h('path', { d: 'M4.9 5.3l2.2 5.5' }),
        h('path', { d: 'M11.1 5.3L8.9 10.8' }),
        h('path', { d: 'M5.1 4.2h5.8' }))
    }

    /** 记忆服务面板图标：一个库（三层）+ 底部支撑，和另两个图标的笔画风格一致。 */
    function MemoryIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, ...stroke },
        h('ellipse', { cx: 8, cy: 3.6, rx: 5.4, ry: 2 }),
        h('path', { d: 'M2.6 3.6v8.8c0 1.1 2.4 2 5.4 2s5.4-.9 5.4-2V3.6' }),
        h('path', { d: 'M2.6 8c0 1.1 2.4 2 5.4 2s5.4-.9 5.4-2' }))
    }

    // ── 通用小件 ────────────────────────────────────────────────────────────
    function Card(props) {
      return h('section', { className: 'txu-card' },
        h('div', { className: 'txu-card-head' },
          props.icon ? h('span', { className: 'txu-ico' }, props.icon) : null,
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { className: 'txu-card-title' }, props.title),
            props.sub ? h('div', { className: 'txu-card-sub' }, props.sub) : null),
          props.right || null),
        props.children)
    }

    function Banner({ kind, children }) {
      return h('div', { className: 'txu-banner txu-banner-' + kind, role: kind === 'err' ? 'alert' : 'status' }, children)
    }

    function Switch({ checked, label, onChange }) {
      return h('button', {
        type: 'button', className: 'txu-switch', 'data-on': checked ? 'true' : 'false',
        role: 'switch', 'aria-checked': checked ? 'true' : 'false', 'aria-label': label,
        onClick: () => onChange(!checked),
      }, h('span', { className: 'txu-switch-thumb' }))
    }

    function StatusLine({ online, busy, tr }) {
      if (busy) {
        return h('span', { className: 'txu-pill txu-wait' },
          h('span', { className: 'txu-dot' }), tr('loading', '连接中…'))
      }
      return h('span', { className: 'txu-pill ' + (online ? 'txu-ok' : 'txu-bad') },
        h('span', { className: 'txu-dot' }),
        online ? tr('online', '在线') : tr('offline', '离线'))
    }

    // ── 页头 ────────────────────────────────────────────────────────────────
    function PageHeader({ title, sub, badge, state, tr, onRefresh }) {
      const busy = state.status === 'loading'
      return h('div', { className: 'txu-head' },
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { className: 'txu-title-row' },
            h('div', { className: 'txu-title' }, title),
            badge ? h('span', { className: 'txu-badge' }, badge) : null),
          h('div', { className: 'txu-sub' }, sub)),
        h('div', { className: 'txu-head-actions' },
          state.at ? h('span', { className: 'txu-muted' },
            tr('last_updated', '上次刷新 {time}').replace('{time}', formatTime(state.at))) : null,
          h('button', {
            type: 'button', className: 'txu-btn', disabled: busy, onClick: onRefresh,
          }, busy ? tr('refreshing', '刷新中…') : tr('refresh', '刷新'))))
    }

    // ── 服务状态 ─────────────────────────────────────────────────────────────
    function StatusCards({ state, tr }) {
      const ping = state.ping || {}
      const memory = ping.memory || null
      const graph = ping.graph || null
      const busy = state.status === 'loading' && !state.ping
      const memoryOnline = memory ? memory.online === true : !!(state.health && state.health.ok)
      const memoryOrigin = (memory && memory.origin) || DEFAULT_MEMORY

      const card = (key, title, data, online, origin, extra) => h('div', { key, className: 'txu-status' },
        h('div', { className: 'txu-status-head' },
          h('div', { className: 'txu-status-title' }, title),
          h(StatusLine, { online, busy: busy && !data, tr })),
        h('div', { className: 'txu-kv' },
          h('span', { className: 'txu-k' }, tr('service_addr', '地址')),
          h('span', { className: 'txu-v txu-mono' }, origin),
          data && typeof data.ms === 'number'
            ? h('span', { className: 'txu-k' }, tr('latency', '延迟'))
            : null,
          data && typeof data.ms === 'number'
            ? h('span', { className: 'txu-v txu-mono' }, data.ms + ' ' + tr('ms', 'ms'))
            : null),
        extra || null)

      return h('div', { className: 'txu-status-grid' },
        card('memory', tr('memory_service', '记忆服务'), memory, memoryOnline, memoryOrigin,
          state.health && state.health.service
            ? h('div', { className: 'txu-muted', style: { marginTop: 8 } },
              text(state.health.service) + (state.health.port ? ' · :' + text(state.health.port) : ''))
            : null))
    }

    // ── 统计 ────────────────────────────────────────────────────────────────
    function StatsCard({ state, tr }) {
      const stats = state.stats || {}
      const busy = state.status === 'loading' && !state.stats
      const tiles = [
        { key: 'memories', label: tr('memories', '记忆'), value: stats.memories },
        { key: 'entities', label: tr('entities', '实体'), value: stats.entities },
        { key: 'relations', label: tr('relations', '关系'), value: stats.relations },
        { key: 'trash', label: tr('trash', '回收站'), value: stats.trash },
      ]
      return h(Card, {
        icon: h(IconDatabase),
        title: tr('stats_title', '记忆库统计'),
        sub: tr('stats_hint', '数字来自记忆服务 GET /memory/stats。'),
        right: h('span', { className: 'txu-muted' }, busy ? tr('loading', '连接中…') : ''),
      }, h('div', { className: 'txu-stats' },
        tiles.map((tile) => h('div', { key: tile.key, className: 'txu-stat' },
          h('div', { className: 'txu-stat-label' }, tile.label),
          h('div', { className: 'txu-stat-value' }, formatInt(tile.value))))))
    }

    // ── API 配置 ─────────────────────────────────────────────────────────────
    const BACKENDS = ['sta1n', 'local', 'custom']

    function seedForm(config) {
      const value = (config && config.config) || {}
      return {
        modelBackend: text(value.modelBackend) || 'sta1n',
        baseURL: text(value.baseURL),
        embeddingModel: text(value.embeddingModel),
        embeddingDimensions: value.embeddingDimensions === undefined || value.embeddingDimensions === null
          ? '' : String(value.embeddingDimensions),
        llmModel: text(value.llmModel),
      }
    }

    function ApiCard({ state, online, tr, reload }) {
      const config = state.config
      const hasApiKey = !!(config && config.hasApiKey)
      const seeded = React.useRef(false)
      const [form, setForm] = React.useState(() => seedForm(config))
      const [keyDraft, setKeyDraft] = React.useState('')
      const [keyVisible, setKeyVisible] = React.useState(false)
      const [keyCleared, setKeyCleared] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      // 模型列表：null = 还没拉过；[] = 拉到了空；非空 = 可下拉选。
      const [models, setModels] = React.useState(null)
      const [modelsBusy, setModelsBusy] = React.useState(false)

      /**
       * 问端点要模型列表。
       * 为什么把「表单当前值」发过去而不是用已保存的配置：用户刚换端点 / 刚填 key 时，
       * 保存前就该能先看看这个端点有哪些模型 —— 否则只能盲填一个名字再保存，错了再改。
       * key 只在这一次请求里用，不落盘也不回显。
       */
      async function fetchModels() {
        setModelsBusy(true)
        setModels(null)
        try {
          const response = await fetch('/dsh-tingxue-ui/models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ baseURL: form.baseURL, apiKey: keyDraft || undefined }),
          })
          const body = await response.json().catch(() => null)
          if (!response.ok || !body || body.ok !== true) {
            setModels([])
            setResult({ kind: 'err', text: tr('models_failed', '拉取模型列表失败：{reason}').replace('{reason}', String((body && body.error) || response.status)) })
          } else {
            setModels(body.models)
            setResult({ kind: 'ok', text: tr('models_ok', '拿到 {n} 个模型，可以从下拉里选。').replace('{n}', String(body.count ?? body.models.length)) })
          }
        } catch (error) {
          setModels([])
          setResult({ kind: 'err', text: tr('models_failed', '拉取模型列表失败：{reason}').replace('{reason}', String((error && error.message) || error)) })
        } finally {
          setModelsBusy(false)
        }
      }

      /** 某个模型字段的控件：手填 + 拉列表 + 下拉选（三者并存，谁都不强制）。 */
      const modelControl = (key, placeholder) => {
        const picked = Array.isArray(models) && models.length > 0
        return h('div', { className: 'txu-keyrow' },
          h('input', {
            className: 'txu-input txu-mono', type: 'text', value: form[key], disabled: offline || busy,
            placeholder,
            onChange: (event) => setField(key, event.target.value),
          }),
          picked ? h('select', {
            className: 'txu-input', value: '', disabled: offline || busy,
            onChange: (event) => { if (event.target.value) setField(key, event.target.value) },
          },
            h('option', { value: '' }, tr('pick_model', '选择模型…')),
            models.map((id) => h('option', { key: id, value: id }, id))) : null,
          h('button', {
            type: 'button', className: 'txu-btn', disabled: offline || busy || modelsBusy,
            title: tr('fetch_models_hint', '用上面填的 Base URL / Key 问端点要模型列表'),
            onClick: () => { void fetchModels() },
          }, modelsBusy ? tr('fetching', '拉取中…') : tr('fetch_models', '列表')))
      }

      React.useEffect(() => {
        if (seeded.current || !config) return
        seeded.current = true
        setForm(seedForm(config))
      }, [config])

      const offline = !online
      const setField = (key, value) => setForm((previous) => ({ ...previous, [key]: value }))

      const labelOf = (key) => {
        if (key === 'modelBackend') return tr('backend', '后端名')
        if (key === 'baseURL') return tr('base_url', 'API Base URL')
        if (key === 'apiKey') return tr('api_key', 'API Key')
        if (key === 'embeddingModel') return tr('embedding_model', '向量模型')
        if (key === 'embeddingDimensions') return tr('embedding_dims', '向量维度')
        if (key === 'llmModel') return tr('llm_model', '小 LLM 模型')
        return key
      }

      async function save() {
        setResult(null)
        const dims = Number(String(form.embeddingDimensions).trim())
        if (!Number.isInteger(dims) || dims <= 0) {
          setResult({ kind: 'err', text: tr('dims_invalid', '向量维度必须是正整数。') })
          return
        }
        if (!form.modelBackend.trim()) {
          setResult({ kind: 'err', text: tr('backend_required', '后端名不能为空。') })
          return
        }
        if (!form.embeddingModel.trim() || !form.llmModel.trim()) {
          setResult({ kind: 'err', text: tr('model_required', '模型名不能为空。') })
          return
        }

        const patch = {
          modelBackend: form.modelBackend.trim(),
          embeddingModel: form.embeddingModel.trim(),
          embeddingDimensions: dims,
          llmModel: form.llmModel.trim(),
        }
        const sent = ['modelBackend', 'embeddingModel', 'embeddingDimensions', 'llmModel']
        if (form.baseURL.trim()) { patch.baseURL = form.baseURL.trim(); sent.push('baseURL') }
        if (keyDraft) { patch.apiKey = keyDraft; sent.push('apiKey') }
        else if (keyCleared) { patch.apiKey = ''; sent.push('apiKey') }

        setBusy(true)
        try {
          const body = await putJson(MEMORY + '/config', patch)
          const after = await fetchJson(MEMORY + '/config').catch(() => null)
          const echoed = (after && after.config) || null
          const ignored = echoed
            ? sent.filter((key) => key !== 'apiKey' && echoed[key] === undefined)
            : []

          if (sent.includes('apiKey')) {
            const keyNow = !!(after && after.hasApiKey)
            if (keyDraft && !keyNow) ignored.push('apiKey')
            if (keyCleared && keyNow) ignored.push('apiKey')
          }

          const accepted = sent.filter((key) => !ignored.includes(key))
          let message = tr('api_saved', '已保存：{fields}')
            .replace('{fields}', accepted.map(labelOf).join('、') || tr('api_saved_none', '服务端没有回显任何字段'))
          if (ignored.length > 0) {
            message += '；' + tr('api_ignored', '服务端未接受：{fields}（当前服务版本忽略这两个字段，需服务端支持）')
              .replace('{fields}', ignored.map(labelOf).join('、'))
          }
          if (body && body.restartRequired) message += '；' + tr('api_restart', '服务端提示需要重启记忆服务才生效。')
          if (body && body.warning) message += '；' + tr('api_warning', '服务端提示：{text}').replace('{text}', text(body.warning))
          setResult({ kind: ignored.length > 0 ? 'warn' : 'ok', text: message })
          setKeyDraft('')
          setKeyCleared(false)
          setKeyVisible(false)
          if (reload) void reload()
        } catch (error) {
          const reason = String((error && error.message) || error)
          setResult({
            kind: 'err',
            text: tr('api_failed', '保存失败：{reason}').replace('{reason}', reason),
          })
        } finally {
          setBusy(false)
        }
      }

      const field = (key, label, hint, control) => h('div', { key, className: 'txu-field' },
        h('div', { className: 'txu-flabel' }, label, hint ? h('span', { className: 'txu-fhint' }, hint) : null),
        h('div', { className: 'txu-fcontrol' }, control))

      return h(Card, {
        icon: h(IconKey),
        title: tr('api_title', 'API 配置'),
        sub: tr('api_sub', '读写记忆服务 GET /config 与 PUT /config；API Key 只经 PUT 交给服务端，页面不落盘。'),
        right: h('span', { className: 'txu-pill ' + (hasApiKey ? 'txu-ok' : 'txu-bad') },
          h('span', { className: 'txu-dot' }),
          hasApiKey ? tr('api_key_set', '服务端已配置 Key') : tr('api_key_unset', '服务端未配置 Key')),
      },
      offline ? h(Banner, { kind: 'warn' }, tr('api_offline', '记忆服务离线，暂时读不到也写不了配置。')) : null,
      h('div', { className: 'txu-form' },
        field('backend', tr('backend', '后端名'), tr('backend_hint', '记忆服务使用的模型后端（sta1n 云端 / local 本地 / custom 自定义）。'),
          h('select', {
            className: 'txu-input', value: form.modelBackend, disabled: offline || busy,
            onChange: (event) => setField('modelBackend', event.target.value),
          }, BACKENDS.map((value) => h('option', { key: value, value }, value)))),
        field('baseURL', tr('base_url', 'API Base URL'), tr('base_url_hint', 'OpenAI 兼容端点根地址，例如 https://cdn.sta1n.cn/v1。'),
          h('input', {
            className: 'txu-input txu-mono', type: 'text', value: form.baseURL, disabled: offline || busy,
            placeholder: 'https://cdn.sta1n.cn/v1',
            onChange: (event) => setField('baseURL', event.target.value),
          })),
        field('apiKey', tr('api_key', 'API Key'), tr('api_key_hint', '密码框，可显示 / 清空；只在本页内存里持有，保存时经 PUT /config 交给服务端。'),
          h('div', { className: 'txu-keyrow' },
            h('input', {
              className: 'txu-input txu-mono', type: keyVisible ? 'text' : 'password',
              value: keyDraft, disabled: offline || busy,
              placeholder: keyCleared ? tr('clear_key', '清空') : (hasApiKey ? '••••••••（已配置，不回显）' : tr('api_key_placeholder', '输入 API Key（仅本次保存发送）')),
              autoComplete: 'off', spellCheck: false,
              onChange: (event) => { setKeyDraft(event.target.value); setKeyCleared(false) },
            }),
            h('button', {
              type: 'button', className: 'txu-btn', disabled: offline || busy,
              onClick: () => setKeyVisible((visible) => !visible),
            }, keyVisible ? tr('hide_key', '隐藏') : tr('show_key', '显示')),
            h('button', {
              type: 'button', className: 'txu-btn', disabled: offline || busy,
              onClick: () => { setKeyDraft(''); setKeyCleared(true); setKeyVisible(false) },
            }, tr('clear_key', '清空')))),
        field('embeddingModel', tr('embedding_model', '向量模型'), tr('embedding_model_hint', '同库单一模型：换模型需要全量重嵌入。'),
          modelControl('embeddingModel', 'gemini-embedding-2')),
        field('embeddingDimensions', tr('embedding_dims', '向量维度'), tr('embedding_dims_hint', '必须与向量模型的实际输出维度一致。'),
          h('input', {
            className: 'txu-input txu-mono', type: 'number', min: 1, step: 1,
            value: form.embeddingDimensions, disabled: offline || busy,
            placeholder: '3072',
            onChange: (event) => setField('embeddingDimensions', event.target.value),
          })),
        field('llmModel', tr('llm_model', '小 LLM 模型'), tr('llm_model_hint', '实体抽取 / 摘要用的语义推理模型。'),
          modelControl('llmModel', 'gemini-3.1-flash-lite'))),
      h('div', { className: 'txu-toolbar' },
        h('button', {
          type: 'button', className: 'txu-btn txu-btn-primary',
          disabled: offline || busy, onClick: () => { void save() },
        }, busy ? tr('saving', '保存中…') : tr('save_api', '保存 API 配置'))),
      result ? h(Banner, { kind: result.kind }, result.text) : null)
    }

    // ── QQ 通道（dsh-im 的 bot 配置）──────────────────────────────────────────
    /**
     * 一个 bot 一行：别名、工作区可改；App Secret 可填（写进 DSH 凭据服务，不回显）。
     *
     * 改 appId 的语义是「换成另一个 bot」——botId 由 appId 的 sha256 算出，
     * 换了 appId 就是新 bot，旧 bot 的会话绑定不会跟着走。界面上必须说清楚，
     * 否则用户会以为「改个号而已，怎么消息跑到新会话里去了」。
     */
    /**
     * QQ 机器人配置。读 dsh-im 自己的 config.json / workspaces.json，不另存一份。
     *
     * 能改的：昵称、工作区（低风险）、App ID（= 换一个 bot，botId 由 appId 的 sha256 决定）、
     *         App Secret（写进 DSH 凭据服务，永远不回显）。
     * 每一个 bot 单独一段，保存按钮只作用于那一个 bot —— 避免「一保存全变」。
     */
    function ChannelCard({ state, tr, reload }) {
      const [data, setData] = React.useState(null)
      const [busyId, setBusyId] = React.useState('')
      const [result, setResult] = React.useState(null)
      const [draft, setDraft] = React.useState({})

      const load = React.useCallback(async () => {
        try {
          const response = await fetch('/dsh-tingxue-ui/channels')
          const body = await response.json().catch(() => null)
          if (body && body.ok) setData(body)
          else setData({ ok: false, bots: [], error: (body && body.error) || ('HTTP ' + response.status) })
        } catch (error) {
          setData({ ok: false, bots: [], error: String((error && error.message) || error) })
        }
      }, [])

      React.useEffect(function () { void load() }, [load])

      const bots = (data && data.bots) || []

      function valueOf(bot, key) {
        const d = draft[bot.botId] || {}
        if (d[key] !== undefined) return d[key]
        return key === 'appSecret' ? '' : (bot[key] || '')
      }

      function setValue(bot, key, value) {
        setDraft(function (prev) {
          const next = Object.assign({}, prev)
          next[bot.botId] = Object.assign({}, prev[bot.botId] || {}, { [key]: value })
          return next
        })
      }

      async function save(bot) {
        const d = draft[bot.botId] || {}
        const payload = { botId: bot.botId }
        if (d.alias !== undefined) payload.alias = d.alias
        if (d.workspace !== undefined) payload.workspace = d.workspace
        if (d.appId !== undefined && d.appId !== '' && d.appId !== bot.appId) payload.appId = d.appId
        if (d.appSecret) payload.appSecret = d.appSecret
        if (Object.keys(payload).length <= 1) {
          setResult({ kind: 'warn', text: tr('ch_nothing', '没有要保存的改动。') })
          return
        }
        setBusyId(bot.botId)
        setResult(null)
        try {
          const response = await fetch('/dsh-tingxue-ui/channels', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const body = await response.json().catch(() => null)
          if (!response.ok || !body || body.ok !== true) {
            setResult({ kind: 'err', text: tr('ch_save_failed', '保存失败：{reason}').replace('{reason}', String((body && body.error) || response.status)) })
          } else {
            setResult({ kind: 'ok', text: (body.notes || []).join('；') || tr('ch_saved', '已保存。') })
            setDraft(function (prev) { const next = Object.assign({}, prev); next[bot.botId] = {}; return next })
            await load()
            if (reload) void reload()
          }
        } catch (error) {
          setResult({ kind: 'err', text: tr('ch_save_failed', '保存失败：{reason}').replace('{reason}', String((error && error.message) || error)) })
        } finally {
          setBusyId('')
        }
      }

      function renderBot(bot) {
        const disabled = busyId === bot.botId
        const field = (key, label, hint, input) => h('div', { className: 'txu-field' },
          h('div', { className: 'txu-flabel' }, label, hint ? h('span', { className: 'txu-fhint' }, hint) : null),
          h('div', { className: 'txu-fcontrol' }, input))

        return h('div', { key: bot.botId, className: 'txu-chan' },
          h('div', { className: 'txu-chan-head' },
            h('span', { className: 'txu-tag' }, bot.botId),
            h('span', { className: 'txu-muted' }, bot.appIdMasked || bot.appId || '')),
          h('div', { className: 'txu-form' },
            field('alias', tr('ch_alias', '昵称'), null,
              h('input', {
                className: 'txu-input', type: 'text', disabled,
                value: valueOf(bot, 'alias'), placeholder: '听雪DSH',
                onChange: (event) => setValue(bot, 'alias', event.target.value),
              })),
            field('workspace', tr('ch_workspace', '工作区'), null,
              h('input', {
                className: 'txu-input txu-mono', type: 'text', disabled,
                value: valueOf(bot, 'workspace'), placeholder: 'D:\\my\\bot-workspace',
                onChange: (event) => setValue(bot, 'workspace', event.target.value),
              })),
            field('appId', tr('ch_appid', 'App ID'),
              tr('ch_appid_hint', '改了就是另一个 bot（botId 由 appId 算出），旧 bot 的绑定不动。'),
              h('input', {
                className: 'txu-input txu-mono', type: 'text', disabled,
                value: valueOf(bot, 'appId'), placeholder: '1900000000',
                onChange: (event) => setValue(bot, 'appId', event.target.value),
              })),
            field('appSecret', tr('ch_secret', 'App Secret'),
              tr('ch_secret_hint', '只写不读：写进 DSH 凭据服务，页面永远不回显。'),
              h('input', {
                className: 'txu-input txu-mono', type: 'password', disabled,
                value: valueOf(bot, 'appSecret'),
                placeholder: bot.secretRef ? '••••••（已配置，留空不改）' : '填一次即可',
                autoComplete: 'off', spellCheck: false,
                onChange: (event) => setValue(bot, 'appSecret', event.target.value),
              }))),
          h('div', { className: 'txu-toolbar' },
            h('button', {
              type: 'button', className: 'txu-btn txu-btn-primary', disabled,
              onClick: () => { void save(bot) },
            }, disabled ? tr('saving', '保存中…') : tr('ch_save', '保存这个 bot'))))
      }

      const pathNote = data && data.ok !== false && data.configPath
        ? h('div', { className: 'txu-muted', style: { marginTop: 10 } },
            tr('ch_paths', '配置文件：{config} / {workspaces}')
              .replace('{config}', data.configPath)
              .replace('{workspaces}', data.workspacesPath))
        : null

      return h(Card, {
        icon: h(IconKey),
        title: tr('ch_title', 'QQ 机器人'),
        sub: tr('ch_sub', '读写 dsh-im 自己的配置文件：昵称与工作区可改，App Secret 写进 DSH 凭据服务。'),
        right: h('button', { type: 'button', className: 'txu-btn txu-btn-link', onClick: () => { void load() } },
          tr('reload', '刷新')),
      },
      !data ? h('div', { className: 'txu-muted' }, tr('loading', '读取中…')) : null,
      data && data.ok === false
        ? h(Banner, { kind: 'err' }, tr('ch_failed', '读不到 QQ 配置：{reason}').replace('{reason}', String(data.error || '')))
        : null,
      data && data.ok !== false && bots.length === 0
        ? h('div', { className: 'txu-empty' },
            tr('ch_empty', '还没有配置任何 QQ 机器人。先在 dsh-im 里建一个，这里会自动列出来。'))
        : null,
      bots.map(renderBot),
      result ? h(Banner, { kind: result.kind }, result.text) : null,
      pathNote)
    }


    // ── 记忆开关 ─────────────────────────────────────────────────────────────
    const TIERS = [
      { id: 'full', titleKey: 'tier_full', title: '全量', descKey: 'tier_full_desc', desc: '召回全部相关记忆与最近对话，上下文最完整。' },
      { id: 'archive', titleKey: 'tier_archive', title: '仅档案', descKey: 'tier_archive_desc', desc: '只召回已完结的项目档案，适合干活场景。' },
      { id: 'off', titleKey: 'tier_off', title: '关闭', descKey: 'tier_off_desc', desc: '不注入任何记忆，模型只看当前会话。' },
    ]

    function SwitchCard({ section, state, tr, reload, note, tierDefault }) {
      const settings = state.panel && state.panel.settings
      const sectionSettings = (settings && settings[section]) || null
      const [form, setForm] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const seeded = React.useRef(false)

      React.useEffect(() => {
        if (seeded.current) return
        if (!sectionSettings && !(state.status === 'ready')) return
        seeded.current = true
        setForm({
          injectTier: (sectionSettings && sectionSettings.injectTier) || tierDefault || 'full',
          relationExpand: !!(sectionSettings && sectionSettings.relationExpand),
          writeBack: !!(sectionSettings && sectionSettings.writeBack),
        })
      }, [sectionSettings, state.status, tierDefault])

      const current = form || {
        injectTier: tierDefault || 'full',
        relationExpand: false,
        writeBack: false,
      }
      const hostMissing = state.panel === null

      async function save() {
        setResult(null)
        setBusy(true)
        try {
          const payload = { settings: { [section]: current } }
          await putJson(PANEL, payload)
          setResult({ kind: 'ok', text: tr('switch_saved', '开关已保存到面板配置。') })
          if (reload) void reload()
        } catch (error) {
          const reason = String((error && error.message) || error)
          setResult({ kind: 'err', text: tr('switch_failed', '开关保存失败：{reason}').replace('{reason}', reason) })
        } finally {
          setBusy(false)
        }
      }

      return h(Card, {
        icon: h(IconSliders),
        title: tr('switch_title', '记忆开关'),
        sub: tr('switch_sub', '注入档位决定每轮给模型带多少记忆；改动保存到面板配置。'),
      },
      note ? h(Banner, { kind: 'info' }, note) : null,
      h('div', { className: 'txu-seg', role: 'radiogroup', 'aria-label': tr('tier', '注入档位') },
        TIERS.map((tier) => h('button', {
          key: tier.id, type: 'button', role: 'radio',
          'aria-checked': current.injectTier === tier.id ? 'true' : 'false',
          'data-active': current.injectTier === tier.id ? 'true' : 'false',
          className: 'txu-seg-btn', disabled: busy,
          onClick: () => setForm({ ...current, injectTier: tier.id }),
        },
          h('div', { className: 'txu-seg-title' }, tr(tier.titleKey, tier.title)),
          h('div', { className: 'txu-seg-desc' }, tr(tier.descKey, tier.desc))))),
      h('div', { className: 'txu-switch-row' },
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { className: 'txu-switch-title' }, tr('relation_expand', '关系扩展')),
          h('div', { className: 'txu-fhint' }, tr('relation_expand_desc', '沿实体关系把相邻记忆一起带进上下文。'))),
        h(Switch, {
          checked: current.relationExpand, label: tr('relation_expand', '关系扩展'),
          onChange: (next) => setForm({ ...current, relationExpand: next }),
        })),
      h('div', { className: 'txu-switch-row' },
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { className: 'txu-switch-title' }, tr('write_back', '每轮回写')),
          h('div', { className: 'txu-fhint' }, tr('write_back_desc', '把每轮对话写进长期记忆（会调用模型，慢但不影响回复）'))),
        h(Switch, {
          checked: current.writeBack, label: tr('write_back', '每轮回写'),
          onChange: (next) => setForm({ ...current, writeBack: next }),
        })),
      h('div', { className: 'txu-toolbar' },
        h('button', {
          type: 'button', className: 'txu-btn txu-btn-primary', disabled: busy || hostMissing,
          onClick: () => { void save() },
        }, busy ? tr('saving', '保存中…') : tr('save_switch', '保存开关'))),
      hostMissing ? h('div', { className: 'txu-muted', style: { marginTop: 8 } }, tr('host_missing', 'Host 面板接口未就绪：/dsh-tingxue-ui/panel 没有响应。插件可能还没加载，或需要重启 DSH。')) : null,
      result ? h(Banner, { kind: result.kind }, result.text) : null)
    }

    // ── 上下文压缩（全局，@deepseek-ai/dsh-compaction-basic）─────────────────
    function ContextCard({ state, tr }) {
      const info = state.context
      const [form, setForm] = React.useState({ threshold: '', retain: '' })
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const seeded = React.useRef(false)

      React.useEffect(() => {
        if (seeded.current) return
        if (!info && state.status !== 'ready') return
        seeded.current = true
        const pct = (value) => (typeof value === 'number' && Number.isFinite(value)
          ? String(Math.round(value * 100)) : '')
        setForm({
          threshold: info && typeof info.compactionRatio === 'number'
            ? String(info.compactionRatio)
            : pct(info && info.thresholdRatio),
          retain: pct(info && info.retainRatio),
        })
      }, [info, state.status])

      const loaded = state.status === 'ready'
      const offline = loaded && state.context === null
      const available = !!(info && info.available === true)
      const disabled = !available || busy
      const percentLabel = (value) => (typeof value === 'number' && Number.isFinite(value)
        ? String(Math.round(value)) + tr('context_pct', '%')
        : tr('context_default', '使用默认值'))
      const ratioLabel = (value) => (typeof value === 'number' && Number.isFinite(value)
        ? Math.round(value * 100) + tr('context_pct', '%')
        : tr('context_default', '使用默认值'))

      const parseCompaction = (value) => {
        const trimmed = String(value === undefined || value === null ? '' : value).trim()
        if (!trimmed) return undefined
        if (!/^\d{1,2}$/.test(trimmed)) return Number.NaN
        const number = Number(trimmed)
        return number >= 10 && number <= 95 ? number : Number.NaN
      }
      const parseRetain = (value) => {
        const trimmed = String(value === undefined || value === null ? '' : value).trim()
        if (!trimmed) return undefined
        if (!/^\d{1,3}$/.test(trimmed)) return Number.NaN
        const number = Number(trimmed)
        return number >= 0 && number <= 100 ? number : Number.NaN
      }

      async function save() {
        setResult(null)
        const threshold = parseCompaction(form.threshold)
        const retain = parseRetain(form.retain)
        if (Number.isNaN(threshold) || Number.isNaN(retain)) {
          setResult({ kind: 'err', text: tr('context_invalid', '压缩阈值请填 10–95 的整数百分比，保留请填 0–100。') })
          return
        }
        if (threshold === undefined && retain === undefined) {
          setResult({ kind: 'err', text: tr('context_none', '至少填一项再保存。') })
          return
        }
        const payload = {}
        if (threshold !== undefined) payload.compactionRatio = threshold
        if (retain !== undefined) payload.retainRatio = retain / 100

        setBusy(true)
        try {
          const response = await putJson(CONTEXT, payload)
          const pct = (value) => (typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value * 100)) : '')
          setForm({
            threshold: response && typeof response.compactionRatio === 'number'
              ? String(response.compactionRatio)
              : pct(response && response.thresholdRatio),
            retain: pct(response && response.retainRatio),
          })
          setResult({
            kind: 'ok',
            text: tr('context_saved', '已保存：压缩阈值 {threshold} · 保留 {retain}')
              .replace('{threshold}', percentLabel(response && response.compactionRatio))
              .replace('{retain}', ratioLabel(response && response.retainRatio)),
          })
        } catch (error) {
          const reason = String((error && error.message) || error)
          setResult({
            kind: 'err',
            text: tr('context_failed', '保存失败：{reason}').replace('{reason}', reason),
          })
        } finally {
          setBusy(false)
        }
      }

      const field = (key, label, hint, control) => h('div', { key, className: 'txu-field' },
        h('div', { className: 'txu-flabel' }, label, hint ? h('span', { className: 'txu-fhint' }, hint) : null),
        h('div', { className: 'txu-fcontrol' }, control))

      return h(Card, {
        icon: h(IconGauge),
        title: tr('context_title', '上下文'),
        sub: tr('context_sub', 'DSH 自动压缩（compaction-basic）：上下文用到多少比例时压缩、压缩后保留多少。'),
        right: available
          ? h('span', { className: 'txu-muted txu-mono' }, 'compaction-basic')
          : null,
      },
      offline ? h(Banner, { kind: 'warn' }, tr('context_offline', '上下文设置接口未就绪：Host 半边没有响应（/dsh-tingxue-ui/context）。插件可能还没加载，或需要重装插件。')) : null,
      !offline && info && info.available === false
        ? h(Banner, { kind: 'warn' }, tr('context_unavailable', '改不了：{reason}').replace('{reason}', String(info.reason || '')))
        : null,
      h('div', { className: 'txu-form' },
        field('compactionRatio', tr('context_threshold', '上下文压缩阈值'), tr('context_threshold_hint', '百分比，10–95 的整数；上下文占到这条线就把较早历史压成一条摘要。落盘为 thresholdRatio（除以 100）。'),
          h('div', null,
            h('input', {
              className: 'txu-input txu-mono', type: 'number', min: 10, max: 95, step: 1,
              value: form.threshold, disabled,
              placeholder: tr('context_default', '使用默认值'),
              onChange: (event) => setForm({ ...form, threshold: event.target.value }),
            }),
            h('div', { className: 'txu-fhint', style: { marginTop: 4 } }, tr('context_shared', '两个 bot 共用（框架层只有一个阈值）')))),
        field('retainRatio', tr('context_retain', '压缩后保留'), tr('context_retain_hint', '压缩后原样保留的最近对话比例，0–100 的整数；落盘为 retainRatio（除以 100）。'),
          h('input', {
            className: 'txu-input txu-mono', type: 'number', min: 0, max: 100, step: 1,
            value: form.retain, disabled,
            placeholder: tr('context_default', '使用默认值'),
            onChange: (event) => setForm({ ...form, retain: event.target.value }),
          }))),
      h('div', { className: 'txu-muted', style: { marginTop: 4 } }, available
        ? tr('context_current', '当前生效：压缩阈值 {threshold} · 保留 {retain}')
          .replace('{threshold}', percentLabel(info && info.compactionRatio))
          .replace('{retain}', ratioLabel(info && info.retainRatio))
        : tr('no_data', '—')),
      h('div', { className: 'txu-fhint', style: { marginTop: 10 } }, tr('context_global_note', 'DSH 不支持按 bot 单独设置上下文长度。')),
      h('div', { className: 'txu-fhint', style: { marginTop: 4 } }, tr('context_compact_hint', '要立即压缩，在对话输入框发送 /compact（作用于当前会话）。')),
      h('div', { className: 'txu-toolbar' },
        h('button', {
          type: 'button', className: 'txu-btn txu-btn-primary', disabled: disabled || !loaded,
          onClick: () => { void save() },
        }, busy ? tr('saving', '保存中…') : tr('context_save', '保存上下文设置'))),
      result ? h(Banner, { kind: result.kind }, result.text) : null,
      available ? h('div', { className: 'txu-muted', style: { marginTop: 8 } },
        tr('context_readback', '保存后回读的值来自 profile 配置层，不是页面自己记的。')) : null)
    }

    // ── 人格 ────────────────────────────────────────────────────────────────
    function PersonaCard({ state, online, tr }) {
      const config = state.config && state.config.config
      const path = (config && text(config.profilePath)) || ''
      const profile = state.profile
      const body = profile && typeof profile.profile === 'string' ? profile.profile : ''
      const chars = body ? Array.from(body).length : 0
      const preview = body ? (body.length > 1200 ? body.slice(0, 1200) + '…' : body) : ''

      return h(Card, {
        icon: h(IconUser),
        title: tr('persona_title', '人格'),
        sub: tr('persona_sub', '只读预览，面板不修改人格档案。'),
        right: h('span', { className: 'txu-muted' },
          body ? chars.toLocaleString('zh-CN') + ' ' + tr('chars', '字') : ''),
      },
      h('div', { className: 'txu-kv', style: { marginBottom: 12 } },
        h('span', { className: 'txu-k' }, tr('persona_path', '档案路径')),
        h('span', { className: 'txu-v txu-mono' }, path || tr('no_data', '—')),
        h('span', { className: 'txu-k' }, tr('persona_chars', '字数')),
        h('span', { className: 'txu-v txu-mono' }, body ? chars.toLocaleString('zh-CN') : tr('no_data', '—'))),
      !online
        ? h('div', { className: 'txu-empty' }, tr('persona_offline', '记忆服务离线，读不到人格档案。'))
        : (preview
          ? h('pre', { className: 'txu-pre', tabIndex: 0 }, preview)
          : h('div', { className: 'txu-empty' }, tr('persona_empty', '人格档案为空或不可读。'))))
    }

    // ── 收工归档（agent 页）──────────────────────────────────────────────────
    function ArchiveCard({ state, tr, reload }) {
      const settings = state.panel && state.panel.settings
      const agent = (settings && settings.agent) || null
      const [keyword, setKeyword] = React.useState('')
      const [skillsDir, setSkillsDir] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const seeded = React.useRef(false)

      React.useEffect(() => {
        if (seeded.current) return
        if (agent) {
          seeded.current = true
          setKeyword(agent.archiveKeyword || 'agentout')
          setSkillsDir(agent.skillsDir || DEFAULT_SKILLS_DIR)
        } else if (state.status === 'ready' && state.panel === null) {
          // Host 半边没起来：仍显示默认值，方便用户看清目标配置，但保存按钮禁用。
          seeded.current = true
          setKeyword('agentout')
          setSkillsDir(DEFAULT_SKILLS_DIR)
        }
      }, [agent, state.status, state.panel])

      const archives = (state.panel && state.panel.archives) || []
      const dir = skillsDir || (agent && agent.skillsDir) || DEFAULT_SKILLS_DIR
      const hostMissing = state.panel === null

      async function save() {
        setResult(null)
        const nextKeyword = keyword.trim()
        const nextDir = skillsDir.trim()
        if (!nextKeyword) {
          setResult({ kind: 'err', text: tr('archive_keyword_required', '触发词不能为空。') })
          return
        }
        if (!nextDir) {
          setResult({ kind: 'err', text: tr('skills_dir_required', '输出目录不能为空。') })
          return
        }
        setBusy(true)
        try {
          await putJson(PANEL, {
            settings: { agent: { archiveKeyword: nextKeyword, skillsDir: nextDir } },
          })
          setResult({ kind: 'ok', text: tr('archive_saved', '归档设置已保存。') })
          if (reload) void reload()
        } catch (error) {
          const reason = String((error && error.message) || error)
          setResult({ kind: 'err', text: tr('archive_failed', '归档设置保存失败：{reason}').replace('{reason}', reason) })
        } finally {
          setBusy(false)
        }
      }

      return h(Card, {
        icon: h(IconArchive),
        title: tr('archive_title', '收工归档'),
        sub: tr('archive_sub', '收工触发词命中后，把本轮产出归档进 skill 输出目录。'),
        right: !hostMissing && archives.length > 0
          ? h('span', { className: 'txu-muted' }, archives.length + ' / ' + tr('archive_recent', '最近归档'))
          : null,
      },
      h('div', { className: 'txu-form' },
        h('div', { className: 'txu-field' },
          h('div', { className: 'txu-flabel' }, tr('archive_keyword', '触发词'),
            h('span', { className: 'txu-fhint' }, tr('archive_keyword_hint', '默认 agentout；在 QQ 里发这个词开始收工归档。'))),
          h('div', { className: 'txu-fcontrol' },
            h('input', {
              className: 'txu-input txu-mono', type: 'text', value: keyword, disabled: busy || hostMissing,
              placeholder: 'agentout', spellCheck: false,
              onChange: (event) => setKeyword(event.target.value),
            }))),
        h('div', { className: 'txu-field' },
          h('div', { className: 'txu-flabel' }, tr('skills_dir', 'skill 输出目录'),
            h('span', { className: 'txu-fhint' }, tr('skills_dir_hint', '归档产出的落点目录。'))),
          h('div', { className: 'txu-fcontrol' },
            h('input', {
              className: 'txu-input txu-mono', type: 'text', value: skillsDir, disabled: busy || hostMissing,
              placeholder: DEFAULT_SKILLS_DIR, spellCheck: false,
              onChange: (event) => setSkillsDir(event.target.value),
            })))),
      h('div', { className: 'txu-subhead' }, tr('archive_recent', '最近归档')),
      archives.length === 0
        ? h('div', { className: 'txu-empty' },
          hostMissing
            ? tr('host_missing', 'Host 面板接口未就绪：/dsh-tingxue-ui/panel 没有响应。插件可能还没加载，或需要重启 DSH。')
            : tr('archive_empty', '目录里还没有归档。') + '（' + dir + '）')
        : h('ul', { className: 'txu-list' },
          archives.map((item) => h('li', { key: item.name, className: 'txu-list-item' },
            h('span', { className: 'txu-tag' }, item.kind === 'dir' ? tr('dir_kind', '目录') : 'FILE'),
            h('span', { className: 'txu-v txu-mono', style: { flex: '1 1 auto', minWidth: 0 } }, item.name),
            h('span', { className: 'txu-muted' }, formatDate(item.mtime)),
            h('span', { className: 'txu-muted txu-mono' }, formatBytes(item.bytes))))),
      h('div', { className: 'txu-toolbar' },
        h('button', {
          type: 'button', className: 'txu-btn txu-btn-primary', disabled: busy || hostMissing,
          onClick: () => { void save() },
        }, busy ? tr('saving', '保存中…') : tr('save_archive', '保存归档设置'))),
      result ? h(Banner, { kind: result.kind }, result.text) : null)
    }

    // ── 工作区（agent 页）────────────────────────────────────────────────────
    function WorkspaceCard({ state, tr }) {
      const panel = state.panel
      const path = (panel && text(panel.workspace)) || ''
      const settingsFile = panel && panel.settingsFile
      const [copied, setCopied] = React.useState(false)

      async function copy() {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(path)
          }
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch { /* 剪贴板不可用：保持原样 */ }
      }

      return h(Card, {
        icon: h(IconFolder),
        title: tr('workspace_title', '工作区'),
        sub: tr('workspace_sub', '当前会话的默认工作区，由 Host 的 workingDirectory 提供。'),
      },
      h('div', { className: 'txu-kv' },
        h('span', { className: 'txu-k' }, tr('workspace_path', '工作区路径')),
        h('span', { className: 'txu-v txu-mono' }, path || tr('no_data', '—'))),
      path
        ? h('div', { className: 'txu-toolbar' },
          h('button', { type: 'button', className: 'txu-btn', onClick: () => { void copy() } },
            copied ? tr('copied', '已复制') : tr('copy', '复制')))
        : h('div', { className: 'txu-muted', style: { marginTop: 10 } },
          tr('host_missing', 'Host 面板接口未就绪：/dsh-tingxue-ui/panel 没有响应。插件可能还没加载，或需要重启 DSH。')),
      settingsFile
        ? h('div', { className: 'txu-muted', style: { marginTop: 10 } }, '面板配置：' + settingsFile)
        : null)
    }

    // ── 两页 ─────────────────────────────────────────────────────────────────
    /** 页面永远拿得到 tr：注入缺失时回落到内嵌中文字典，绝不因 props 缺字段白屏。 */
    function pageTr(props) {
      return props && typeof props.tr === 'function' ? props.tr : makeTr(null)
    }

    function CompanionPage(props) {
      const tr = pageTr(props)
      const [state, reload] = useDashboard()
      return h('div', { className: 'txu-page', 'data-dsh-tingxue-ui': 'companion' },
        h('style', null, CSS),
        h('div', { className: 'txu-inner' },
          h(PageHeader, {
            title: tr('companion_title', '聊天面板'),
            sub: tr('companion_sub', '陪伴 bot · 记忆、模型与人格'),
            badge: tr('companion_badge', '陪伴'),
            state, tr, onRefresh: reload,
          }),
          hasForbidden(state) ? h(Banner, { kind: 'warn' }, tr('host_forbidden', '面板接口只允许本机 loopback 访问；当前连接不是本机。')) : null,
          hasHostRouteError(state) && state.panel === null ? h(Banner, { kind: 'warn' }, tr('host_missing', 'Host 面板接口未就绪：/dsh-tingxue-ui/panel 没有响应。插件可能还没加载，或需要重启 DSH。')) : null,
          h(StatusCards, { state, tr }),
          h(SwitchCard, { section: 'companion', state, tr, reload, tierDefault: 'full' }),
          h(ContextCard, { state, tr }),
          h(PersonaCard, { state, online: isMemoryOnline(state), tr })))
    }

    function AgentPage(props) {
      const tr = pageTr(props)
      const [state, reload] = useDashboard()
      return h('div', { className: 'txu-page', 'data-dsh-tingxue-ui': 'agent' },
        h('style', null, CSS),
        h('div', { className: 'txu-inner' },
          h(PageHeader, {
            title: tr('agent_title', 'agent面板'),
            sub: tr('agent_sub', '干活 bot · 只召回已完结的项目档案'),
            badge: tr('agent_badge', 'agent'),
            state, tr, onRefresh: reload,
          }),
          hasForbidden(state) ? h(Banner, { kind: 'warn' }, tr('host_forbidden', '面板接口只允许本机 loopback 访问；当前连接不是本机。')) : null,
          hasHostRouteError(state) && state.panel === null ? h(Banner, { kind: 'warn' }, tr('host_missing', 'Host 面板接口未就绪：/dsh-tingxue-ui/panel 没有响应。插件可能还没加载，或需要重启 DSH。')) : null,
          h(StatusCards, { state, tr }),
          h(SwitchCard, {
            section: 'agent', state, tr, reload, tierDefault: 'archive',
            note: tr('agent_switch_note', '干活 bot 只召回已完结项目档案：默认档位为「仅档案」，避免把聊天上下文带进任务。'),
          }),
          h(ContextCard, { state, tr }),
          h(ArchiveCard, { state, tr, reload }),
          h(WorkspaceCard, { state, tr })))
    }

    /**
     * 记忆服务面板 —— 所有「两个 bot 共用」的东西都在这里。
     *
     * 为什么要把共享配置从两个 bot 页里抽出来：模型端点、API Key、服务状态、记忆库统计
     * 改了是**两边一起变**的，原来在两个页面各放一份，用户会以为能分别设，改完发现另一边
     * 也变了 —— 那是让人不信任面板的最快方式。分开之后语义就清楚了：
     * 聊天面板 / agent面板 = 这个 bot 自己的东西；记忆服务面板 = 大家共用的东西。
     */
    /**
     * 记忆图谱面板：侧边栏直接看图，不用再去开浏览器标签页。
     *
     * 图谱本体是 8765 那套现成界面（canvas 力导向 + 四个管理页签），重写一遍
     * 既浪费又会引入新 bug。这里用同源反代嵌进面板：
     *   /dsh-tingxue-graph/*  →  http://127.0.0.1:8765/*
     * 同源所以 iframe 不被跨域拦，主题跟着面板走。
     */
    function GraphPage(props) {
      const tr = pageTr(props)
      const [state, reload] = useDashboard()
      return h('div', { className: 'txu-page', 'data-dsh-tingxue-ui': 'graph' },
        h('style', null, CSS),
        h('div', { className: 'txu-inner txu-inner-graph' },
          h(PageHeader, {
            title: tr('graph_title', '记忆图谱'),
            sub: tr('graph_sub', '实体关系可视化 · 实体 / 关系 / 记忆 / 回收站'),
            state, tr, onRefresh: reload,
          }),
          h('iframe', {
            className: 'txu-graph-frame',
            src: '/dsh-tingxue-graph/',
            title: tr('graph_title', '记忆图谱'),
          }),
          h('p', { className: 'txu-muted', style: { marginTop: '8px' } },
            tr('graph_fallback', '如果上面是空白，说明内嵌被拦了——') ,
            h('a', {
              href: 'http://127.0.0.1:8765/',
              target: '_blank',
              rel: 'noreferrer',
              style: { color: 'var(--dsw-alias-state-business-primary, #4c8dff)' },
            }, tr('graph_open_raw', '在新标签页打开图谱')),
            tr('graph_fallback2', '（同一份数据，只是外面少了面板壳）'))))
    }

    function MemoryPage(props) {
      const tr = pageTr(props)
      const [state, reload] = useDashboard()
      return h('div', { className: 'txu-page', 'data-dsh-tingxue-ui': 'memory' },
        h('style', null, CSS),
        h('div', { className: 'txu-inner' },
          h(PageHeader, {
            title: tr('memory_title', '记忆服务面板'),
            sub: tr('memory_sub', '两个 bot 共用：模型与 API、记忆服务、记忆库、QQ 通道'),
            badge: tr('memory_badge', '共用'),
            state, tr, onRefresh: reload,
          }),
          hasForbidden(state) ? h(Banner, { kind: 'warn' }, tr('host_forbidden', '面板接口只允许本机 loopback 访问；当前连接不是本机。')) : null,
          hasHostRouteError(state) && state.panel === null ? h(Banner, { kind: 'warn' }, tr('host_missing', 'Host 面板接口未就绪：/dsh-tingxue-ui/panel 没有响应。插件可能还没加载，或需要重启 DSH。')) : null,
          h(StatusCards, { state, tr }),
          h(StatsCard, { state, tr }),
          h(ApiCard, { state, online: isMemoryOnline(state), tr, reload }),
          h(ChannelCard, { state, tr, reload }),
          h(ArchiveCard, { state, tr, reload }),
          h(ContextCard, { state, tr })))
    }

    /** 记忆服务是否在线：优先看 ping，其次看 /health 是否拿到了 ok 响应。 */
    function isMemoryOnline(state) {
      if (state.ping && state.ping.memory) return state.ping.memory.online === true
      return !!(state.health && state.health.ok)
    }

    // ── 样式（全部主题令牌，深浅色自动跟随）─────────────────────────────────
    const CSS = `
.txu-page{box-sizing:border-box;height:100%;overflow-y:auto;padding:22px 28px 48px;color:var(--dsw-alias-label-primary,inherit);font-family:inherit;-webkit-font-smoothing:antialiased}
.txu-inner{max-width:980px;margin:0 auto}
.txu-inner-graph{max-width:none}
.txu-graph-frame{display:block;width:100%;min-height:calc(100vh - 210px);border:0;border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color-scheme:light dark}
.txu-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.txu-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.txu-title{font-size:20px;font-weight:600;line-height:1.35;letter-spacing:.01em}
.txu-sub{font-size:12px;color:var(--dsw-alias-label-secondary,currentColor);margin-top:4px;line-height:1.5}
.txu-badge{font-size:10.5px;padding:2px 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));color:var(--dsw-alias-label-secondary,currentColor);letter-spacing:.04em}
.txu-head-actions{display:flex;align-items:center;gap:10px}
.txu-muted{font-size:11px;color:var(--dsw-alias-label-tertiary,currentColor);line-height:1.5}
.txu-card{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.045));border-radius:var(--dsw-radius-xl,14px);padding:16px 18px;margin-bottom:14px;box-shadow:var(--dsw-elevation-panel,none)}
.txu-card-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:2px}
.txu-ico{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-state-business-primary,#4c8dff);flex:none}
.txu-card-title{font-size:13.5px;font-weight:600;line-height:1.4}
.txu-card-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,currentColor);margin:3px 0 14px;line-height:1.55}
.txu-status-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin-bottom:14px}
.txu-status{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.045));border-radius:var(--dsw-radius-xl,14px);padding:14px 16px}
.txu-status-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.txu-status-title{font-size:12.5px;font-weight:600}
.txu-pill{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;white-space:nowrap}
.txu-dot{width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 16%,transparent)}
.txu-ok{color:var(--dsw-alias-state-success-primary,#2ea043)}
.txu-bad{color:var(--dsw-alias-state-error-primary,#d9534f)}
.txu-wait{color:var(--dsw-alias-label-tertiary,currentColor)}
.txu-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;font-size:12px;align-items:baseline}
.txu-k{color:var(--dsw-alias-label-secondary,currentColor);font-size:11.5px;white-space:nowrap}
.txu-v{word-break:break-all;line-height:1.55}
.txu-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px}
.txu-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px}
.txu-stat{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:var(--dsw-radius-lg,10px);padding:12px 14px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.03))}
.txu-stat-label{font-size:11px;color:var(--dsw-alias-label-secondary,currentColor);letter-spacing:.03em}
.txu-stat-value{font-size:23px;font-weight:600;margin-top:6px;font-variant-numeric:tabular-nums;line-height:1.15}
.txu-form{display:grid;grid-template-columns:180px minmax(0,1fr);gap:12px 18px;align-items:start}
.txu-field{display:contents}
.txu-flabel{font-size:12.5px;padding-top:7px;line-height:1.4}
.txu-fhint{display:block;font-size:10.5px;color:var(--dsw-alias-label-tertiary,currentColor);margin-top:3px;line-height:1.5;font-weight:400}
.txu-fcontrol{min-width:0}
.txu-input{width:100%;box-sizing:border-box;padding:7px 10px;font-size:12.5px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s}
.txu-input:focus-visible{border-color:var(--dsw-alias-state-business-primary,#4c8dff);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4c8dff) 22%,transparent)}
.txu-input:disabled{opacity:.65}
.txu-input::placeholder{color:var(--dsw-alias-label-tertiary,currentColor);opacity:.7}
.txu-keyrow{display:flex;gap:8px;align-items:center}
.txu-keyrow .txu-input{flex:1 1 auto;min-width:0}
.txu-btn{font-size:12px;padding:6px 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;cursor:pointer;transition:background .15s,border-color .15s,opacity .15s;font-family:inherit;line-height:1.5;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.txu-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.txu-btn:disabled{opacity:.5;cursor:default}
.txu-btn:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4c8dff) 30%,transparent)}
.txu-btn-primary{background:var(--dsw-alias-state-business-primary,#4c8dff);border-color:transparent;color:#fff;font-weight:600}
.txu-btn-primary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary,#4c8dff);filter:brightness(1.07)}
.txu-btn-link{font-size:11.5px;padding:4px 10px}
.txu-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:16px;flex-wrap:wrap}
.txu-banner{margin-top:12px;font-size:12px;line-height:1.6;padding:9px 12px;border-radius:9px;border:.5px solid transparent;color:var(--dsw-alias-label-primary,inherit)}
.txu-banner-ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2ea043) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2ea043) 10%,transparent)}
.txu-banner-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d29922) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d29922) 10%,transparent)}
.txu-banner-err{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9534f) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9534f) 10%,transparent)}
.txu-banner-info{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));font-size:11.5px;color:var(--dsw-alias-label-secondary,currentColor)}
.txu-seg{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:6px}
.txu-seg-btn{text-align:left;padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:transparent;color:inherit;cursor:pointer;font-family:inherit;transition:background .15s,border-color .15s}
.txu-seg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.txu-seg-btn[data-active='true']{border-color:var(--dsw-alias-state-business-primary,#4c8dff);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4c8dff) 12%,transparent)}
.txu-seg-btn:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4c8dff) 26%,transparent)}
.txu-seg-title{font-size:12.5px;font-weight:600}
.txu-seg-desc{font-size:10.5px;color:var(--dsw-alias-label-tertiary,currentColor);margin-top:4px;line-height:1.5}
.txu-switch-row{display:flex;align-items:flex-start;gap:14px;padding:12px 0 4px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));margin-top:12px}
.txu-switch-title{font-size:12.5px;line-height:1.4}
.txu-switch{position:relative;width:34px;height:20px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.18));cursor:pointer;flex:none;padding:0;transition:background .16s,border-color .16s}
.txu-switch[data-on='true']{background:var(--dsw-alias-state-business-primary,#4c8dff);border-color:transparent}
.txu-switch:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4c8dff) 28%,transparent)}
.txu-switch-thumb{position:absolute;top:1px;left:1px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);transition:transform .16s;box-shadow:0 1px 2px rgba(0,0,0,.25)}
.txu-switch[data-on='true'] .txu-switch-thumb{transform:translateX(14px)}
.txu-pre{margin:0;max-height:220px;overflow:auto;padding:12px 14px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));white-space:pre-wrap;word-break:break-word;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.75;color:var(--dsw-alias-label-secondary,currentColor)}
.txu-pre:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4c8dff) 24%,transparent)}
.txu-empty{border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-radius:10px;padding:18px 16px;text-align:center;font-size:11.5px;color:var(--dsw-alias-label-tertiary,currentColor);line-height:1.6;word-break:break-all}
.txu-chan{border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));padding-top:12px;margin-top:12px}
.txu-chan-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.txu-list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.txu-list-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));font-size:11.5px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}
.txu-tag{font-size:10px;padding:1px 6px;border-radius:5px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));color:var(--dsw-alias-label-secondary,currentColor);flex:none}
.txu-subhead{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,currentColor);letter-spacing:.04em;margin:16px 0 2px}
@media (max-width:720px){.txu-form{grid-template-columns:minmax(0,1fr)}.txu-flabel{padding-top:0}.txu-seg{grid-template-columns:minmax(0,1fr)}.txu-page{padding:18px 16px 36px}}
@media (prefers-reduced-motion:reduce){.txu-btn,.txu-switch,.txu-switch-thumb,.txu-input,.txu-seg-btn{transition:none}}
`

    // ── 插件 apply ──────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT, en: DICT }), 'dsh-tingxue-ui:dictionary')
      const tr = makeTr(ctx.locale.bind(NS))

      // 三个侧栏入口：图标注册进 root-scoped 的 sidebar.panellist 列表。
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_COMPANION,
        order: 38,
        label: () => tr('nav_companion', '聊天面板'),
      }, CompanionIcon))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_AGENT,
        order: 39,
        label: () => tr('nav_agent', 'agent面板'),
      }, AgentIcon))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_MEMORY,
        order: 40,
        label: () => tr('nav_memory', '记忆服务面板'),
      }, MemoryIcon))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_GRAPH,
        order: 41,
        label: () => tr('nav_graph', '记忆图谱'),
      }, GraphIcon))

      // 两个整页：main 是 keyed 槽位，key 必须等于上面的入口 id。
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_COMPANION,
        inject: () => ({ tr }),
      }, CompanionPage))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_AGENT,
        inject: () => ({ tr }),
      }, AgentPage))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_GRAPH,
        component: GraphPage,
      }))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_MEMORY,
        inject: () => ({ tr }),
      }, MemoryPage))

      // 自检回报：Host 半边据此确认这两页真的在浏览器里注册成功（排障用，失败不影响页面）。
      try {
        void fetch('/dsh-tingxue-ui/client-report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            panelSlot: 'sidebar.panellist',
            pageSlot: 'main',
            panels: [
              { id: PANEL_COMPANION, label: tr('nav_companion', '聊天面板') },
              { id: PANEL_AGENT, label: tr('nav_agent', 'agent面板') },
              { id: PANEL_MEMORY, label: tr('nav_memory', '记忆服务面板') },
            ],
          }),
          keepalive: true,
        }).catch(() => {})
      } catch { /* 自检失败不影响页面 */ }
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})


