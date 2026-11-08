/* dsh-tingxue · service/ui/app.js
 *
 * 记忆图谱管理界面的全部交互逻辑。零依赖、无构建、classic script（不 import）。
 * 接口契约：service/API.md。所有请求都发到 `(query ?api= 或 'api') + path`。
 * 默认用**相对路径** 'api' 而不是绝对 '/api'：这个页面会被嵌进 DSH 面板的
 * iframe 里（src=/dsh-tingxue-graph/），绝对路径会直接打到 dsh-app://app/api/*
 * 变成 404；相对路径则解析成 /dsh-tingxue-graph/api/*，正好被同源反代接住。
 * 直接用 http://127.0.0.1:8765/ 打开时，'api' 同样等价于 '/api'。
 *  - 左侧列表：实体 / 关系 / 记忆 / 回收站，分页「加载更多」
 *  - 中间：canvas 力导向图（graph-engine.js），点击选中、搜索高亮、类型过滤
 *  - 右侧：实体 / 关系 / 记忆详情，可编辑、可删除、可新增关系
 *  - 顶部：搜索、类型过滤、新增、合并、刷新、统计、主题
 *  - 删除 / 合并一律走确认对话框；错误一律走顶部 toast，不用 alert。
 *  - 不渲染向量，不渲染 identity。
 */
(function () {
  'use strict'

  // ============================================================
  // 常量与工具
  // ============================================================
  const params = new URLSearchParams(location.search)
  const API_BASE = normaliseApiBase(params.get('api'))
  const PAGE_SIZE = 50
  const MAX_FETCH = 6000
  const THEME_KEY = 'tx-graph-theme'
  const THEME_MODES = ['auto', 'light', 'dark']
  const THEME_META = {
    auto: { label: '跟随', icon: '◐' },
    light: { label: '浅色', icon: '☀' },
    dark: { label: '深色', icon: '☾' }
  }
  const TABS = ['entities', 'relations', 'memories', 'trash']
  const TAB_NOUN = { entities: '个实体', relations: '条关系', memories: '条记忆', trash: '项' }
  const TYPE_LABEL = { person: '人物', place: '地点', thing: '事物', concept: '概念' }
  const TYPE_OPTIONS = ['person', 'place', 'thing', 'concept']
  const KIND_LABEL = { entity: '实体', relation: '关系', memory: '记忆' }
  const LIST_ID_ATTR = 'data-item-id'

  function normaliseApiBase(raw) {
    const value = String(raw == null ? 'api' : raw).trim()
    if (!value) return 'api'
    const trimmed = value.replace(/\/+$/, '')
    return trimmed || 'api'
  }

  function el(tag, props) {
    const node = document.createElement(tag)
    if (props) {
      Object.keys(props).forEach(function (key) {
        const value = props[key]
        if (value === undefined || value === null || value === false) return
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = String(value)
        else if (key === 'dataset') Object.assign(node.dataset, value)
        else if (key === 'attrs') {
          Object.keys(value).forEach(function (name) {
            if (value[name] === undefined || value[name] === null || value[name] === false) return
            node.setAttribute(name, String(value[name]))
          })
        } else if (key === 'on') {
          Object.keys(value).forEach(function (name) {
            node.addEventListener(name, value[name])
          })
        } else if (key in node) {
          try { node[key] = value } catch (error) { node.setAttribute(key, String(value)) }
        } else {
          node.setAttribute(key, String(value))
        }
      })
    }
    const children = Array.prototype.slice.call(arguments, 2)
    if (children.length) appendChildren(node, children)
    return node
  }

  function appendChildren(node, children) {
    for (let i = 0; i < children.length; i++) {
      let child = children[i]
      if (child === undefined || child === null || child === false) continue
      if (Array.isArray(child)) {
        appendChildren(node, child)
        continue
      }
      if (child instanceof Node) node.appendChild(child)
      else node.appendChild(document.createTextNode(String(child)))
    }
  }

  function truncate(text, max) {
    const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
    if (!value) return ''
    return value.length > max ? value.slice(0, Math.max(0, max - 1)) + '…' : value
  }

  function num(value) {
    if (value === null || value === undefined || value === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  function formatNumber(value) {
    const parsed = num(value)
    if (parsed === null) return '–'
    return parsed.toLocaleString('zh-CN')
  }

  function formatTime(ms) {
    const parsed = num(ms)
    if (parsed === null || parsed <= 0) return '—'
    const date = new Date(parsed)
    if (isNaN(date.getTime())) return '—'
    const pad = function (value) { return String(value).padStart(2, '0') }
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  }

  function formatDistance(value) {
    const parsed = num(value)
    if (parsed === null) return '—'
    return parsed.toFixed(3)
  }

  function typeLabel(type) {
    return TYPE_LABEL[type] || type || '未分类'
  }

  function typeClass(type) {
    return TYPE_OPTIONS.indexOf(type) >= 0 ? type : 'unknown'
  }

  function isActive(relation) {
    return !relation || !relation.validTo || Number(relation.validTo) <= 0
  }

  // ============================================================
  // 错误 / 服务层
  // ============================================================
  class ApiError extends Error {
    constructor(message, details) {
      super(message)
      this.name = 'ApiError'
      details = details || {}
      this.status = details.status || 0
      this.code = details.code || ''
      this.payload = details.payload || null
      this.cause = details.cause || null
    }
  }

  async function request(path, options) {
    options = options || {}
    const init = {
      method: options.method || 'GET',
      headers: {},
      credentials: 'same-origin'
    }
    if (options.body !== undefined) {
      init.headers['content-type'] = 'application/json; charset=utf-8'
      init.body = JSON.stringify(options.body)
    }
    let response
    try {
      response = await fetch(API_BASE + path, init)
    } catch (error) {
      if (error && error.name === 'AbortError') throw error
      throw new ApiError('无法连接记忆服务（' + API_BASE + '）', { status: 0, cause: error })
    }
    let payload = null
    let text = ''
    try { text = await response.text() } catch (error) { text = '' }
    if (text) {
      try { payload = JSON.parse(text) } catch (error) { payload = null }
    }
    if (!response.ok || (payload && payload.ok === false)) {
      const message = payload && payload.error
        ? String(payload.error)
        : '请求失败（HTTP ' + response.status + '）'
      throw new ApiError(message, {
        status: response.status,
        code: payload && payload.code,
        payload: payload
      })
    }
    return payload || {}
  }

  function errorMessage(error) {
    if (!error) return '未知错误'
    if (error instanceof ApiError) return error.message || '请求失败'
    if (error.name === 'AbortError') return '请求已取消'
    if (error.name === 'TypeError') return '无法连接记忆服务（' + API_BASE + '）'
    return error.message || String(error)
  }

  async function fetchAllPages(path, key, limit, maxItems) {
    const items = []
    let offset = 0
    const size = limit || 500
    const cap = maxItems || MAX_FETCH
    for (;;) {
      const separator = path.indexOf('?') >= 0 ? '&' : '?'
      const data = await request(path + separator + 'limit=' + size + '&offset=' + offset)
      const page = Array.isArray(data[key]) ? data[key] : []
      for (let i = 0; i < page.length; i++) items.push(page[i])
      offset += page.length
      const total = num(data.total)
      if (!page.length || page.length < size) break
      if (total !== null && offset >= total) break
      if (offset >= cap) break
    }
    return items
  }

  // ============================================================
  // 全局状态
  // ============================================================
  const state = {
    tab: 'entities',
    search: '',
    type: 'all',
    themeMode: 'auto',
    stats: null,
    selected: null,
    relationDetail: null,
    entityDetail: null,
    memoryDetail: null
  }

  const lists = {
    entities: { items: [], total: null, offset: 0, hasMore: false, loading: false, loaded: false, error: null, seq: 0 },
    relations: { items: [], total: null, offset: 0, hasMore: false, loading: false, loaded: false, error: null, seq: 0 },
    memories: { items: [], total: null, offset: 0, hasMore: false, loading: false, loaded: false, error: null, seq: 0 },
    trash: { items: [], limit: PAGE_SIZE, hasMore: false, loading: false, loaded: false, error: null, seq: 0 }
  }

  const cache = {
    entityIndex: [],
    entityIndexAt: 0,
    entityIndexInflight: null,
    relationMap: new Map(),
    nameById: new Map()
  }

  let graph = null
  let detailSeq = 0
  let graphSeq = 0
  let toastSeq = 0
  let modalSeq = 0
  let lastToast = { message: '', at: 0 }
  let firstGraphLoad = true
  let booted = false
  let searchTimer = 0

  const dom = {}

  function $(selector) {
    return document.querySelector(selector)
  }

  // ============================================================
  // DOM 引用
  // ============================================================
  function cacheDom() {
    dom.searchInput = $('#searchInput')
    dom.searchClear = $('#searchClear')
    dom.typeFilter = $('#typeFilter')
    dom.btnNewEntity = $('#btnNewEntity')
    dom.btnNewRelation = $('#btnNewRelation')
    dom.btnMerge = $('#btnMerge')
    dom.btnRefresh = $('#btnRefresh')
    dom.btnStats = $('#btnStats')
    dom.btnTheme = $('#btnTheme')
    dom.themeIcon = $('#themeIcon')
    dom.themeLabel = $('#themeLabel')
    dom.statMemories = $('#statMemories')
    dom.statEntities = $('#statEntities')
    dom.statRelations = $('#statRelations')
    dom.tabCountEntities = $('#tabCountEntities')
    dom.tabCountRelations = $('#tabCountRelations')
    dom.tabCountMemories = $('#tabCountMemories')
    dom.tabCountTrash = $('#tabCountTrash')
    dom.tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'))
    dom.listHint = $('#listHint')
    dom.btnListReload = $('#btnListReload')
    dom.listBody = $('#listBody')
    dom.btnLoadMore = $('#btnLoadMore')
    dom.canvas = $('#graphCanvas')
    dom.graphOverlay = $('#graphOverlay')
    dom.graphBadge = $('#graphBadge')
    dom.btnFit = $('#btnFit')
    dom.btnHome = $('#btnHome')
    dom.btnZoomIn = $('#btnZoomIn')
    dom.btnZoomOut = $('#btnZoomOut')
    dom.btnMinimap = $('#btnMinimap')
    dom.detailBody = $('#detailBody')
    dom.toastHost = $('#toastHost')
    dom.modalRoot = $('#modalRoot')
  }

  // ============================================================
  // Toast / 忙碌 / 弹窗 / 确认框
  // ============================================================
  function toast(message, options) {
    options = options || {}
    const text = String(message == null ? '' : message)
    if (!text) return function () {}
    const now = Date.now()
    if (!options.force && text === lastToast.message && now - lastToast.at < 1200) {
      return function () {}
    }
    lastToast = { message: text, at: now }
    const type = options.type || 'info'
    const id = 'toast-' + (++toastSeq)
    const closeButton = el('button', {
      class: 'toast-close',
      type: 'button',
      text: '✕',
      attrs: { 'aria-label': '关闭提示' }
    })
    const node = el('div', {
      class: 'toast ' + (type === 'info' ? '' : type),
      attrs: { id: id, role: type === 'error' ? 'alert' : 'status' }
    }, el('span', { class: 'toast-msg', text: text }), closeButton)
    let timer = 0
    function dismiss() {
      if (timer) { clearTimeout(timer); timer = 0 }
      node.classList.remove('show')
      setTimeout(function () { node.remove() }, 220)
    }
    closeButton.addEventListener('click', dismiss)
    dom.toastHost.appendChild(node)
    requestAnimationFrame(function () { node.classList.add('show') })
    timer = setTimeout(dismiss, options.timeout || (type === 'error' ? 5200 : 3200))
    return dismiss
  }

  function showError(error, fallback) {
    const message = errorMessage(error) || fallback || '操作失败'
    if (error) console.error('[tingxue-graph]', error)
    toast(message, { type: 'error', timeout: 5600 })
  }

  function setBusy(button, busy, busyText) {
    if (!button) return
    if (busy) {
      if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent
      button.disabled = true
      button.textContent = busyText || '处理中…'
    } else {
      button.disabled = false
      if (button.dataset.idleLabel) {
        button.textContent = button.dataset.idleLabel
        delete button.dataset.idleLabel
      }
    }
  }

  function openModal(config) {
    config = config || {}
    const backdrop = el('div', { class: 'modal-backdrop' })
    const titleId = 'modal-title-' + (++modalSeq)
    const closeButton = el('button', {
      class: 'icon-btn',
      type: 'button',
      text: '✕',
      attrs: { 'aria-label': '关闭对话框', title: '关闭' }
    })
    const headMain = el('div', { class: 'head-main' }, el('h2', { text: config.title || '对话框', attrs: { id: titleId } }))
    if (config.subtitle) headMain.appendChild(el('p', { class: 'sub', text: config.subtitle }))
    const head = el('div', { class: 'modal-head' }, headMain, closeButton)
    const body = el('div', { class: 'modal-body' })
    if (config.body) appendChildren(body, [config.body])
    const footer = el('div', { class: 'modal-foot' })
    if (config.footer) appendChildren(footer, [config.footer])
    const modal = el('div', {
      class: 'modal',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }
    }, head, body, footer)
    if (config.width) {
      modal.style.setProperty('--modal-width', typeof config.width === 'number' ? config.width + 'px' : config.width)
    }
    backdrop.appendChild(modal)
    dom.modalRoot.appendChild(backdrop)
    requestAnimationFrame(function () { backdrop.classList.add('show') })

    let closed = false
    const handle = { root: backdrop, modal: modal, body: body, footer: footer, close: close }
    function close(result) {
      if (closed) return
      closed = true
      document.removeEventListener('keydown', onKeyDown)
      backdrop.classList.remove('show')
      setTimeout(function () { backdrop.remove() }, 190)
      if (typeof config.onClose === 'function') config.onClose(result)
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    closeButton.addEventListener('click', function () { close() })
    backdrop.addEventListener('mousedown', function (event) {
      if (event.target === backdrop) close()
    })
    setTimeout(function () {
      const focusable = modal.querySelector('.modal-body input:not([type="hidden"]), .modal-body textarea, .modal-body select') || closeButton
      if (focusable) focusable.focus()
    }, 40)
    return handle
  }

  function confirmAction(config) {
    config = config || {}
    return new Promise(function (resolve) {
      let settled = false
      function settle(value) {
        if (settled) return
        settled = true
        resolve(value)
      }
      const cancelButton = el('button', {
        class: 'btn', type: 'button', text: '取消',
        on: { click: function () { settle(false); handle.close() } }
      })
      const confirmButton = el('button', {
        class: 'btn ' + (config.danger === false ? 'primary' : 'danger-solid'),
        type: 'button',
        text: config.confirmLabel || '确认',
        on: { click: function () { settle(true); handle.close() } }
      })
      const body = el('div')
      body.appendChild(el('p', { class: 'confirm-text', text: config.message || '确认执行该操作？' }))
      if (config.detail) {
        body.appendChild(el('p', {
          class: 'confirm-detail' + (config.danger === false ? '' : ' danger'),
          text: config.detail
        }))
      }
      const handle = openModal({
        title: config.title || '确认操作',
        body: body,
        footer: [cancelButton, confirmButton],
        width: 430,
        onClose: function () { settle(false) }
      })
      setTimeout(function () { confirmButton.focus() }, 60)
    })
  }

  // ============================================================
  // 表单小部件
  // ============================================================
  function field(labelText, control, options) {
    options = options || {}
    const head = el('span', { class: 'label' },
      el('span', {}, [labelText, options.required ? el('span', { class: 'required', text: ' *' }) : null]))
    const wrapper = el('label', { class: 'field' }, head, control)
    if (options.help) wrapper.appendChild(el('span', { class: 'help', text: options.help }))
    return wrapper
  }

  function textInput(options) {
    options = options || {}
    const input = el('input', {
      type: options.type || 'text',
      value: options.value == null ? '' : options.value,
      placeholder: options.placeholder || '',
      autocomplete: 'off',
      spellcheck: 'false'
    })
    if (options.maxLength) input.maxLength = options.maxLength
    if (options.ariaLabel) input.setAttribute('aria-label', options.ariaLabel)
    return input
  }

  function textArea(options) {
    options = options || {}
    const input = el('textarea', {
      rows: options.rows || 4,
      placeholder: options.placeholder || ''
    })
    input.value = options.value == null ? '' : options.value
    return input
  }

  function selectInput(options, value) {
    const select = el('select')
    ;(options || []).forEach(function (option) {
      select.appendChild(el('option', {
        value: option.value,
        text: option.label,
        selected: option.value === value
      }))
    })
    return select
  }

  function typeSelect(value) {
    const selected = value || 'concept'
    const options = TYPE_OPTIONS.map(function (type) {
      return { value: type, label: typeLabel(type) }
    })
    // 兼容抽取产生的自定义类型：保留一个额外选项，避免详情一打开就被判成「已修改」。
    if (TYPE_OPTIONS.indexOf(selected) < 0) {
      options.push({ value: selected, label: selected })
    }
    return selectInput(options, selected)
  }

  function chip(text, tone) {
    return el('span', { class: 'chip' + (tone ? ' ' + tone : ''), text: text })
  }

  function typeChip(type) {
    return el('span', { class: 'chip' }, [
      el('span', { class: 'type-dot ' + typeClass(type) }),
      typeLabel(type)
    ])
  }

  function makeButton(label, options) {
    options = options || {}
    return el('button', {
      class: 'btn' + (options.class ? ' ' + options.class : ''),
      type: 'button',
      text: label,
      attrs: options.title ? { title: options.title } : undefined,
      on: options.onClick ? { click: options.onClick } : undefined
    })
  }

  /**
   * 实体选择组合框：输入过滤 + 下拉点选；允许精确同名自动匹配。
   * 返回 { node, getValue, setValue, input }。
   */
  function entityCombobox(index, options) {
    options = options || {}
    const excludeId = options.excludeId ? String(options.excludeId) : ''
    const byId = new Map()
    index.forEach(function (entity) { byId.set(String(entity.id), entity) })

    let selectedId = options.value ? String(options.value) : ''
    const input = textInput({
      value: '',
      placeholder: options.placeholder || '搜索并选择实体…',
      ariaLabel: options.ariaLabel || '选择实体'
    })
    input.setAttribute('role', 'combobox')
    input.setAttribute('aria-autocomplete', 'list')
    input.setAttribute('aria-expanded', 'false')
    const list = el('div', { class: 'combo-list', hidden: true, attrs: { role: 'listbox' } })
    const wrapper = el('div', { class: 'combo' }, input, list)

    if (selectedId && byId.has(selectedId)) input.value = byId.get(selectedId).name || ''

    function pick(entity) {
      selectedId = String(entity.id)
      input.value = entity.name || ''
      list.hidden = true
      input.setAttribute('aria-expanded', 'false')
      if (typeof options.onPick === 'function') options.onPick(entity)
    }

    function renderOptions(queryText) {
      const queryLower = String(queryText || '').trim().toLowerCase()
      const matches = index.filter(function (entity) {
        if (excludeId && String(entity.id) === excludeId) return false
        if (!queryLower) return true
        const haystack = ((entity.name || '') + ' ' + (entity.summary || '')).toLowerCase()
        return haystack.indexOf(queryLower) >= 0
      }).slice(0, 50)
      list.replaceChildren()
      if (!matches.length) {
        list.appendChild(el('div', { class: 'combo-empty', text: '没有匹配的实体' }))
      } else {
        matches.forEach(function (entity) {
          const option = el('button', {
            class: 'combo-option',
            type: 'button',
            attrs: { role: 'option' },
            on: {
              mousedown: function (event) { event.preventDefault() },
              click: function () { pick(entity) }
            }
          }, [
            el('span', { class: 'combo-name', text: entity.name || '（未命名）' }),
            el('span', { class: 'combo-type type-text ' + typeClass(entity.type), text: typeLabel(entity.type) })
          ])
          list.appendChild(option)
        })
      }
      list.hidden = false
      input.setAttribute('aria-expanded', 'true')
    }

    input.addEventListener('input', function () {
      selectedId = ''
      renderOptions(input.value)
    })
    input.addEventListener('focus', function () { renderOptions(input.value) })
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        list.hidden = true
        input.setAttribute('aria-expanded', 'false')
        event.stopPropagation()
      }
    })
    input.addEventListener('blur', function () {
      setTimeout(function () {
        list.hidden = true
        input.setAttribute('aria-expanded', 'false')
      }, 140)
    })

    function getValue() {
      if (selectedId && byId.has(selectedId)) return selectedId
      const exactName = input.value.trim().toLowerCase()
      if (!exactName) return ''
      const exact = index.find(function (entity) {
        if (excludeId && String(entity.id) === excludeId) return false
        return String(entity.name || '').trim().toLowerCase() === exactName
      })
      if (exact) {
        selectedId = String(exact.id)
        return selectedId
      }
      return ''
    }

    function setValue(id) {
      selectedId = id ? String(id) : ''
      const entity = selectedId ? byId.get(selectedId) : null
      input.value = entity ? (entity.name || '') : ''
    }

    return { node: wrapper, getValue: getValue, setValue: setValue, input: input }
  }

  // ============================================================
  // 主题
  // ============================================================
  function prefersDark() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    } catch (error) {
      return false
    }
  }

  function resolvedTheme() {
    return state.themeMode === 'auto' ? (prefersDark() ? 'dark' : 'light') : state.themeMode
  }

  function initTheme() {
    let stored = null
    try { stored = localStorage.getItem(THEME_KEY) } catch (error) { stored = null }
    const fromUrl = params.get('theme')
    const explicitUrl = fromUrl === 'light' || fromUrl === 'dark'
    state.themeMode = explicitUrl
      ? fromUrl
      : (THEME_MODES.indexOf(stored) >= 0 ? stored : (THEME_MODES.indexOf(fromUrl) >= 0 ? fromUrl : 'auto'))
    applyTheme()
    try {
      const media = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = function () {
        if (state.themeMode === 'auto') applyTheme()
      }
      if (media.addEventListener) media.addEventListener('change', onChange)
      else if (media.addListener) media.addListener(onChange)
    } catch (error) { /* 忽略 */ }
  }

  function applyTheme() {
    const resolved = resolvedTheme()
    document.documentElement.setAttribute('data-theme', resolved)
    document.documentElement.setAttribute('data-theme-mode', state.themeMode)
    const meta = THEME_META[state.themeMode] || THEME_META.auto
    if (dom.themeIcon) dom.themeIcon.textContent = meta.icon
    if (dom.themeLabel) dom.themeLabel.textContent = meta.label
    if (dom.btnTheme) {
      dom.btnTheme.title = '主题：' + meta.label + '（点击切换）'
      dom.btnTheme.setAttribute('aria-label', '主题：' + meta.label + '，点击切换')
    }
    if (graph) graph.refreshTheme()
  }

  function cycleTheme() {
    const index = THEME_MODES.indexOf(state.themeMode)
    state.themeMode = THEME_MODES[(index + 1) % THEME_MODES.length]
    try { localStorage.setItem(THEME_KEY, state.themeMode) } catch (error) { /* 忽略 */ }
    applyTheme()
    toast('主题：' + THEME_META[state.themeMode].label, { timeout: 1400 })
  }

  // ============================================================
  // 实体索引缓存
  // ============================================================
  function rememberEntity(entity) {
    if (!entity || entity.id === undefined || entity.id === null) return
    cache.nameById.set(String(entity.id), entity.name || '')
  }

  function rememberRelations(rows) {
    ;(rows || []).forEach(function (relation) {
      if (!relation || relation.id === undefined || relation.id === null) return
      cache.relationMap.set(String(relation.id), relation)
      if (relation.sourceName) cache.nameById.set(String(relation.sourceId), relation.sourceName)
      if (relation.targetName) cache.nameById.set(String(relation.targetId), relation.targetName)
    })
  }

  function nameOf(id) {
    const key = String(id == null ? '' : id)
    if (cache.nameById.has(key)) return cache.nameById.get(key)
    return key || '（未知实体）'
  }

  function invalidateEntityIndex() {
    cache.entityIndexAt = 0
  }

  async function loadEntityIndex(force) {
    if (!force && cache.entityIndex.length && Date.now() - cache.entityIndexAt < 15000) {
      return cache.entityIndex
    }
    if (cache.entityIndexInflight) return cache.entityIndexInflight
    cache.entityIndexInflight = (async function () {
      const entities = await fetchAllPages('/memory/entities', 'entities', 500, 6000)
      cache.entityIndex = entities
      cache.entityIndexAt = Date.now()
      entities.forEach(rememberEntity)
      return entities
    })()
    try {
      return await cache.entityIndexInflight
    } finally {
      cache.entityIndexInflight = null
    }
  }

  // ============================================================
  // 统计
  // ============================================================
  function renderStats() {
    const stats = state.stats || {}
    const relationCount = stats.activeRelations !== undefined ? stats.activeRelations : stats.relations
    dom.statMemories.textContent = stats.memories === undefined ? '–' : formatNumber(stats.memories)
    dom.statEntities.textContent = stats.entities === undefined ? '–' : formatNumber(stats.entities)
    dom.statRelations.textContent = relationCount === undefined ? '–' : formatNumber(relationCount)
    dom.tabCountEntities.textContent = stats.entities === undefined
      ? (lists.entities.total !== null ? formatNumber(lists.entities.total) : '–')
      : formatNumber(stats.entities)
    dom.tabCountRelations.textContent = relationCount === undefined
      ? (lists.relations.total !== null ? formatNumber(lists.relations.total) : '–')
      : formatNumber(relationCount)
    dom.tabCountMemories.textContent = stats.memories === undefined
      ? (lists.memories.total !== null ? formatNumber(lists.memories.total) : '–')
      : formatNumber(stats.memories)
    dom.tabCountTrash.textContent = stats.trash === undefined ? '–' : formatNumber(stats.trash)
  }

  async function loadStats() {
    try {
      const data = await request('/memory/stats')
      state.stats = data
      renderStats()
      return data
    } catch (error) {
      if (!state.stats) renderStats()
      throw error
    }
  }

  // ============================================================
  // 左侧列表
  // ============================================================
  function activeList() {
    return lists[state.tab]
  }

  function listNoun() {
    return TAB_NOUN[state.tab] || '项'
  }

  function updateListChrome() {
    const list = activeList()
    const shown = list.items.length
    const total = state.tab === 'trash'
      ? (state.stats && state.stats.trash !== undefined ? num(state.stats.trash) : shown)
      : (list.total !== null ? list.total : shown)
    let hint
    if (list.loading && !list.loaded) hint = '加载中…'
    else if (list.error) hint = '加载失败'
    else {
      hint = '共 ' + formatNumber(total) + ' ' + listNoun()
      if (state.tab === 'relations') hint = '共 ' + formatNumber(total) + ' 条有效关系'
      if (shown < total) hint += ' · 已显示 ' + formatNumber(shown)
      if (state.search) hint = '搜索「' + truncate(state.search, 24) + '」 · ' + hint
      if (state.type !== 'all' && state.tab === 'entities') hint += ' · ' + typeLabel(state.type)
    }
    dom.listHint.textContent = hint
    const canMore = !!list.hasMore && !list.loading
    dom.btnLoadMore.hidden = !canMore
    if (canMore) {
      dom.btnLoadMore.textContent = list.total !== null
        ? '加载更多（已显示 ' + formatNumber(shown) + ' / ' + formatNumber(list.total) + '）'
        : '加载更多'
    }
    renderStats()
  }

  function setTab(tab) {
    if (TABS.indexOf(tab) < 0) return
    state.tab = tab
    dom.tabs.forEach(function (button) {
      const selected = button.dataset.tab === tab
      button.setAttribute('aria-selected', selected ? 'true' : 'false')
    })
    dom.listBody.scrollTop = 0
    loadActiveList({ reset: true })
  }

  function loadActiveList(options) {
    options = options || {}
    if (state.tab === 'entities') return loadEntities(options)
    if (state.tab === 'relations') return loadRelations(options)
    if (state.tab === 'memories') return loadMemories(options)
    if (state.tab === 'trash') return loadTrash({ more: false })
    return Promise.resolve()
  }

  function renderList() {
    if (state.tab === 'entities') renderEntities()
    else if (state.tab === 'relations') renderRelations()
    else if (state.tab === 'memories') renderMemories()
    else if (state.tab === 'trash') renderTrash()
    updateListChrome()
  }

  function renderListLoading(text) {
    dom.listBody.replaceChildren(
      el('div', { class: 'state' }, el('div', { class: 'spinner' }), el('div', { text: text || '加载中…' }))
    )
  }

  function renderListError(error, retry) {
    dom.listBody.replaceChildren(el('div', { class: 'state error' }, [
      el('div', { class: 'state-icon', text: '⚠' }),
      el('div', { class: 'state-title', text: '加载失败' }),
      el('div', { text: errorMessage(error) }),
      el('button', {
        class: 'btn small', type: 'button', text: '重试',
        on: { click: retry }
      })
    ]))
  }

  function renderListEmpty(title, text, actionLabel, action) {
    dom.listBody.replaceChildren(el('div', { class: 'state' }, [
      el('div', { class: 'state-icon', text: '◇' }),
      el('div', { class: 'state-title', text: title }),
      el('div', { text: text }),
      action ? el('button', {
        class: 'btn small', type: 'button', text: actionLabel,
        on: { click: action }
      }) : null
    ]))
  }

  function bindListItem(node, handler) {
    node.addEventListener('click', handler)
    node.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        handler(event)
      }
    })
  }

  function markItemSelected(node, kind, id) {
    const selected = !!(state.selected && state.selected.kind === kind && String(state.selected.id) === String(id))
    node.classList.toggle('is-selected', selected)
    if (selected) node.setAttribute('aria-current', 'true')
    else node.removeAttribute('aria-current')
    return node
  }

  function syncListSelection() {
    const nodes = dom.listBody.querySelectorAll('.list-item[data-kind]')
    Array.prototype.forEach.call(nodes, function (node) {
      const selected = !!(state.selected &&
        node.dataset.kind === state.selected.kind &&
        String(node.dataset.id) === String(state.selected.id))
      node.classList.toggle('is-selected', selected)
      if (selected) node.setAttribute('aria-current', 'true')
      else node.removeAttribute('aria-current')
    })
  }

  function scrollSelectedIntoView() {
    const node = dom.listBody.querySelector('.list-item.is-selected')
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' })
  }

  function restoreScroll(top) {
    if (typeof top === 'number') dom.listBody.scrollTop = top
  }

  async function loadEntities(options) {
    options = options || {}
    const append = !!options.append
    const list = lists.entities
    if (append && (list.loading || !list.hasMore)) return
    const seq = ++list.seq
    const previousScroll = options.preserveScroll ? dom.listBody.scrollTop : 0
    if (!append) {
      list.items = []
      list.offset = 0
      list.total = null
      list.hasMore = false
      list.error = null
      list.loading = true
      renderListLoading('正在加载实体…')
      updateListChrome()
    } else {
      list.loading = true
      updateListChrome()
    }
    try {
      const query = new URLSearchParams()
      query.set('limit', String(PAGE_SIZE))
      query.set('offset', String(list.offset))
      if (state.search) query.set('q', state.search)
      if (state.type !== 'all') query.set('type', state.type)
      const data = await request('/memory/entities?' + query.toString())
      if (seq !== list.seq) return
      const page = Array.isArray(data.entities) ? data.entities : []
      page.forEach(rememberEntity)
      list.items = append ? list.items.concat(page) : page
      list.offset = list.items.length
      list.total = num(data.total)
      list.hasMore = page.length >= PAGE_SIZE && (list.total === null || list.items.length < list.total)
      list.loading = false
      list.loaded = true
      if (state.tab === 'entities') {
        renderList()
        restoreScroll(previousScroll)
      } else {
        updateListChrome()
      }
    } catch (error) {
      if (seq !== list.seq) return
      list.loading = false
      list.error = error
      if (!append) list.items = []
      if (state.tab === 'entities') renderListError(error, function () { loadEntities({ reset: true }) })
      updateListChrome()
      showError(error)
    }
  }

  async function loadRelations(options) {
    options = options || {}
    const append = !!options.append
    const list = lists.relations
    if (append && (list.loading || !list.hasMore)) return
    const seq = ++list.seq
    const previousScroll = options.preserveScroll ? dom.listBody.scrollTop : 0
    if (!append) {
      list.items = []
      list.offset = 0
      list.total = null
      list.hasMore = false
      list.error = null
      list.loading = true
      renderListLoading('正在加载关系…')
      updateListChrome()
    } else {
      list.loading = true
      updateListChrome()
    }
    try {
      const query = new URLSearchParams()
      query.set('limit', String(PAGE_SIZE))
      query.set('offset', String(list.offset))
      if (state.search) query.set('q', state.search)
      const data = await request('/memory/relations?' + query.toString())
      if (seq !== list.seq) return
      const page = Array.isArray(data.relations) ? data.relations : []
      rememberRelations(page)
      list.items = append ? list.items.concat(page) : page
      list.offset = list.items.length
      list.total = num(data.total)
      list.hasMore = page.length >= PAGE_SIZE && (list.total === null || list.items.length < list.total)
      list.loading = false
      list.loaded = true
      if (state.tab === 'relations') {
        renderList()
        restoreScroll(previousScroll)
      } else {
        updateListChrome()
      }
    } catch (error) {
      if (seq !== list.seq) return
      list.loading = false
      list.error = error
      if (!append) list.items = []
      if (state.tab === 'relations') renderListError(error, function () { loadRelations({ reset: true }) })
      updateListChrome()
      showError(error)
    }
  }

  async function loadMemories(options) {
    options = options || {}
    const append = !!options.append
    const list = lists.memories
    if (append && (list.loading || !list.hasMore)) return
    const seq = ++list.seq
    const previousScroll = options.preserveScroll ? dom.listBody.scrollTop : 0
    if (!append) {
      list.items = []
      list.offset = 0
      list.total = null
      list.hasMore = false
      list.error = null
      list.loading = true
      renderListLoading('正在加载记忆…')
      updateListChrome()
    } else {
      list.loading = true
      updateListChrome()
    }
    try {
      const query = new URLSearchParams()
      query.set('limit', String(PAGE_SIZE))
      query.set('offset', String(list.offset))
      if (state.search) query.set('q', state.search)
      const data = await request('/memory/memories?' + query.toString())
      if (seq !== list.seq) return
      const page = Array.isArray(data.memories) ? data.memories : []
      list.items = append ? list.items.concat(page) : page
      list.offset = list.items.length
      list.total = num(data.total)
      list.hasMore = page.length >= PAGE_SIZE && (list.total === null || list.items.length < list.total)
      list.loading = false
      list.loaded = true
      if (state.tab === 'memories') {
        renderList()
        restoreScroll(previousScroll)
      } else {
        updateListChrome()
      }
    } catch (error) {
      if (seq !== list.seq) return
      list.loading = false
      list.error = error
      if (!append) list.items = []
      if (state.tab === 'memories') renderListError(error, function () { loadMemories({ reset: true }) })
      updateListChrome()
      showError(error)
    }
  }

  async function loadTrash(options) {
    options = options || {}
    const list = lists.trash
    const more = !!options.more
    if (list.loading) return
    const seq = ++list.seq
    const nextLimit = more ? Math.min(list.limit + PAGE_SIZE, 500) : PAGE_SIZE
    list.loading = true
    list.error = null
    if (!more) renderListLoading('正在读取回收站…')
    updateListChrome()
    try {
      const data = await request('/memory/trash?limit=' + nextLimit)
      if (seq !== list.seq) return
      list.items = Array.isArray(data.items) ? data.items : []
      list.limit = nextLimit
      list.hasMore = list.items.length >= nextLimit && nextLimit < 500
      list.loading = false
      list.loaded = true
      if (state.tab === 'trash') renderList()
      else updateListChrome()
    } catch (error) {
      if (seq !== list.seq) return
      list.loading = false
      list.error = error
      if (state.tab === 'trash') renderListError(error, function () { loadTrash({ more: false }) })
      updateListChrome()
      showError(error)
    }
  }

  // ---------- 列表渲染 ----------
  function renderEntities() {
    const list = lists.entities
    if (!list.items.length) {
      if (state.search) {
        renderListEmpty('没有匹配的实体', '搜索「' + truncate(state.search, 40) + '」没有结果。', '清除搜索', clearSearch)
      } else if (state.type !== 'all') {
        renderListEmpty('该类型下没有实体', '当前过滤：' + typeLabel(state.type) + '。', '查看全部类型', function () {
          setTypeFilter('all')
        })
      } else {
        renderListEmpty('还没有实体', '点击「新增实体」，或与听雪聊天让图谱自然生长。', '新增实体', openEntityCreateModal)
      }
      return
    }
    const fragment = document.createDocumentFragment()
    list.items.forEach(function (entity) {
      const item = el('div', {
        class: 'list-item',
        attrs: { role: 'button', tabindex: '0', title: entity.name || '' },
        dataset: { kind: 'entity', id: String(entity.id) }
      })
      item.appendChild(el('div', { class: 'item-head' }, [
        el('span', { class: 'type-dot ' + typeClass(entity.type) }),
        el('span', { class: 'item-name', text: entity.name || '（未命名实体）' }),
        el('span', { class: 'type-text ' + typeClass(entity.type), text: typeLabel(entity.type) })
      ]))
      const metaText = entity.summary
        ? truncate(entity.summary, 70)
        : '创建于 ' + formatTime(entity.createdAt)
      item.appendChild(el('div', { class: 'item-meta' }, [
        el('span', { class: 'item-sub', text: metaText })
      ]))
      markItemSelected(item, 'entity', entity.id)
      bindListItem(item, function () { selectEntity(entity.id, { focus: true }) })
      fragment.appendChild(item)
    })
    dom.listBody.replaceChildren(fragment)
    syncListSelection()
  }

  function renderRelations() {
    const list = lists.relations
    if (!list.items.length) {
      if (state.search) {
        renderListEmpty('没有匹配的关系', '搜索「' + truncate(state.search, 40) + '」没有结果。', '清除搜索', clearSearch)
      } else {
        renderListEmpty('还没有关系', '选中实体后在右侧「新增关系」，或与听雪聊天自动抽取。', '新增关系', function () {
          openRelationCreateModal({})
        })
      }
      return
    }
    const fragment = document.createDocumentFragment()
    list.items.forEach(function (relation) {
      const sourceName = relation.sourceName || nameOf(relation.sourceId)
      const targetName = relation.targetName || nameOf(relation.targetId)
      const item = el('div', {
        class: 'list-item',
        attrs: { role: 'button', tabindex: '0', title: relation.relation || '' },
        dataset: { kind: 'relation', id: String(relation.id) }
      })
      item.appendChild(el('div', { class: 'rel-line' }, [
        el('span', { class: 'end', text: sourceName }),
        el('span', { class: 'rel-arrow', text: '—' }),
        el('span', { class: 'rel-word', text: relation.relation || '关系' }),
        el('span', { class: 'rel-arrow', text: '→' }),
        el('span', { class: 'end', text: targetName })
      ]))
      item.appendChild(el('div', { class: 'item-meta' }, [
        el('span', { class: 'item-sub', text: '创建于 ' + formatTime(relation.validFrom) }),
        isActive(relation) ? null : chip('已结束', 'warn')
      ]))
      markItemSelected(item, 'relation', relation.id)
      bindListItem(item, function () { selectRelation(relation) })
      fragment.appendChild(item)
    })
    dom.listBody.replaceChildren(fragment)
    syncListSelection()
  }

  function renderMemories() {
    const list = lists.memories
    if (!list.items.length) {
      if (state.search) {
        renderListEmpty('没有匹配的记忆', '搜索「' + truncate(state.search, 40) + '」没有结果。', '清除搜索', clearSearch)
      } else {
        renderListEmpty('还没有记忆', '记忆由对话产生；这里可以查看、编辑与删除。')
      }
      return
    }
    const fragment = document.createDocumentFragment()
    list.items.forEach(function (memory) {
      const item = el('div', {
        class: 'list-item',
        attrs: { role: 'button', tabindex: '0' },
        dataset: { kind: 'memory', id: String(memory.id) }
      })
      item.appendChild(el('p', { class: 'item-text', text: truncate(memory.text || '（空记忆）', 120) }))
      item.appendChild(el('div', { class: 'item-meta' }, [
        memory.scene ? chip(memory.scene) : null,
        el('span', { class: 'item-sub', text: formatTime(memory.createdAt) })
      ]))
      markItemSelected(item, 'memory', memory.id)
      bindListItem(item, function () { selectMemory(memory.id) })
      fragment.appendChild(item)
    })
    dom.listBody.replaceChildren(fragment)
    syncListSelection()
  }

  function trashLabel(item) {
    const row = item.row || {}
    if (item.kind === 'entity') return row.name || row.id || '（未命名实体）'
    if (item.kind === 'relation') {
      const source = row.sourceId ? nameOf(row.sourceId) : '？'
      const target = row.targetId ? nameOf(row.targetId) : '？'
      return source + ' —' + (row.relation || '关系') + '→ ' + target
    }
    if (item.kind === 'memory') return truncate(row.text || row.id || '（空记忆）', 110)
    return item.kind || '未知项目'
  }

  function renderTrash() {
    const list = lists.trash
    const keyword = state.search.toLowerCase()
    const items = keyword
      ? list.items.filter(function (item) {
        return trashLabel(item).toLowerCase().indexOf(keyword) >= 0 ||
          (KIND_LABEL[item.kind] || '').toLowerCase().indexOf(keyword) >= 0
      })
      : list.items
    if (!list.items.length) {
      renderListEmpty('回收站是空的', '删除的实体、关系、记忆会出现在这里，可随时恢复。')
      return
    }
    if (!items.length) {
      renderListEmpty('没有匹配的删除项', '搜索「' + truncate(state.search, 40) + '」没有结果。', '清除搜索', clearSearch)
      return
    }
    const fragment = document.createDocumentFragment()
    items.forEach(function (item) {
      const label = trashLabel(item)
      const node = el('div', { class: 'list-item trash-item' })
      node.appendChild(el('div', { class: 'item-head' }, [
        chip(KIND_LABEL[item.kind] || item.kind || '项目', 'warn'),
        el('span', { class: 'item-name', text: label })
      ]))
      node.appendChild(el('div', { class: 'item-meta' }, [
        el('span', { class: 'item-sub', text: '删除于 ' + formatTime(item.deletedAt) }),
        el('span', { class: 'item-sub', text: String(item.trashId || '').slice(0, 8) })
      ]))
      const restoreButton = el('button', {
        class: 'btn small', type: 'button', text: '恢复',
        attrs: { title: '恢复该项到记忆库' },
        on: {
          click: function (event) {
            event.stopPropagation()
            restoreTrashItem(item)
          }
        }
      })
      node.appendChild(el('div', { class: 'restore-row' }, restoreButton))
      fragment.appendChild(node)
    })
    dom.listBody.replaceChildren(fragment)
  }

  // ============================================================
  // 图谱
  // ============================================================
  function graphOverlayContent(kind, config) {
    config = config || {}
    const children = []
    if (kind === 'loading') {
      children.push(el('div', { class: 'spinner' }))
    } else {
      children.push(el('div', { class: 'big', text: kind === 'error' ? '⚠' : '🕸' }))
    }
    children.push(el('div', { class: 'state-title', text: config.title || '' }))
    if (config.text) children.push(el('div', { class: 'hint-text', text: config.text }))
    if (config.actionLabel && config.action) {
      children.push(el('button', {
        class: 'btn', type: 'button', text: config.actionLabel,
        on: { click: config.action }
      }))
    }
    dom.graphOverlay.replaceChildren.apply(dom.graphOverlay, children)
    dom.graphOverlay.hidden = false
  }

  function graphOverlayLoading(text) {
    graphOverlayContent('loading', { title: '正在加载关系图谱…', text: text || '从记忆服务读取实体与关系。' })
  }

  function graphOverlayEmpty() {
    graphOverlayContent('empty', {
      title: '图谱还是空的',
      text: '新增一个实体，或与听雪聊聊天——实体与关系会慢慢长出来。',
      actionLabel: '新增实体',
      action: openEntityCreateModal
    })
  }

  function graphOverlayError(error) {
    graphOverlayContent('error', {
      title: '图谱加载失败',
      text: errorMessage(error),
      actionLabel: '重试',
      action: function () { loadGraph() }
    })
  }

  function hideGraphOverlay() {
    dom.graphOverlay.hidden = true
  }

  async function loadGraph() {
    if (!graph) return
    const seq = ++graphSeq
    graphOverlayLoading()
    try {
      const results = await Promise.all([
        loadEntityIndex(true),
        fetchAllPages('/memory/relations?includeEnded=false', 'relations', 500, 6000)
      ])
      if (seq !== graphSeq) return
      const entities = results[0] || []
      const relations = results[1] || []
      rememberRelations(relations)
      const nodes = entities.map(function (entity) {
        return {
          id: entity.id,
          name: entity.name || '',
          type: entity.type || 'concept',
          summary: entity.summary || ''
        }
      })
      const known = new Set(nodes.map(function (node) { return String(node.id) }))
      const links = relations.filter(function (relation) {
        return known.has(String(relation.sourceId)) && known.has(String(relation.targetId))
      }).map(function (relation) {
        return {
          id: relation.id,
          source: relation.sourceId,
          target: relation.targetId,
          label: relation.relation || ''
        }
      })
      graph.setData(nodes, links)
      const counts = graph.getCounts()
      dom.graphBadge.textContent = '实体 ' + formatNumber(counts.nodes) + ' · 关系 ' + formatNumber(counts.edges)
      if (!nodes.length) {
        graphOverlayEmpty()
      } else {
        hideGraphOverlay()
        if (firstGraphLoad) {
          firstGraphLoad = false
          graph.fit()
        }
      }
    } catch (error) {
      if (seq !== graphSeq) return
      graphOverlayError(error)
      showError(error)
    }
  }

  function setupGraph() {
    if (!window.TXGraph) {
      graphOverlayContent('error', {
        title: '图谱引擎未加载',
        text: '请确认 graph-engine.js 能通过相对路径访问。'
      })
      return
    }
    graph = window.TXGraph.create(dom.canvas, {
      onSelect: function (id) {
        if (id === null || id === undefined) clearSelection()
        else selectEntity(id, { focus: false, fromGraph: true })
      },
      onClearSelection: function () {
        if (state.selected) clearSelection()
      }
    })
    graph.setTypeFilter(state.type)
    graph.setSearch(state.search)

    // iframe 里第一次量到的尺寸可能还没稳定（父容器刚布局完），补两次校准：
    // 一次在布局落定后，一次在字体/滚动条都稳定后。只在尺寸真的变了才重画。
    ;[400, 1200].forEach(function (delay) {
      window.setTimeout(function () {
        try {
          if (!graph) return
          graph.resize()
          graph.fit()
        } catch (error) { /* 卸载或空图时忽略 */ }
      }, delay)
    })
  }

  // ============================================================
  // 详情公共
  // ============================================================
  function detailHead(title, subChildren, closeHandler) {
    const close = el('button', {
      class: 'btn icon detail-close',
      type: 'button',
      text: '✕',
      attrs: { title: '关闭详情', 'aria-label': '关闭详情' },
      on: { click: closeHandler || clearSelection }
    })
    const head = el('div', { class: 'detail-head' },
      el('div', { class: 'head-row' }, el('h2', { text: title || '详情' }), close))
    if (subChildren && subChildren.length) {
      head.appendChild(el('div', { class: 'sub' }, subChildren))
    }
    return head
  }

  function renderDetailShell(head, contents) {
    const scroll = el('div', { class: 'detail-scroll' })
    appendChildren(scroll, contents)
    dom.detailBody.replaceChildren(head, scroll)
    document.body.classList.add('detail-open')
  }

  function renderDetailEmpty() {
    dom.detailBody.replaceChildren(el('div', { class: 'detail-empty' }, [
      el('div', { class: 'state-icon', text: '◎' }),
      el('strong', { text: '未选择' }),
      el('div', { text: '点击左侧列表或画布节点查看详情。实体、关系、记忆都可以在这里编辑与删除。' })
    ]))
    document.body.classList.remove('detail-open')
  }

  function renderDetailLoading(text) {
    dom.detailBody.replaceChildren(el('div', { class: 'detail-empty' }, [
      el('div', { class: 'spinner' }),
      el('div', { text: text || '正在读取详情…' })
    ]))
    document.body.classList.add('detail-open')
  }

  function renderDetailError(error, retry) {
    dom.detailBody.replaceChildren(
      detailHead('读取失败', [], clearSelection),
      el('div', { class: 'detail-scroll' }, el('div', { class: 'state error' }, [
        el('div', { class: 'state-icon', text: '⚠' }),
        el('div', { text: errorMessage(error) }),
        retry ? el('button', { class: 'btn small', type: 'button', text: '重试', on: { click: retry } }) : null
      ]))
    )
  }

  function clearSelection() {
    state.selected = null
    state.relationDetail = null
    state.entityDetail = null
    state.memoryDetail = null
    if (graph) {
      graph.setSelected(null)
      graph.setSelectedEdge(null)
    }
    renderDetailEmpty()
    syncListSelection()
  }

  function ensureSelected(kind, id) {
    return !!(state.selected && state.selected.kind === kind && String(state.selected.id) === String(id))
  }

  // ============================================================
  // 实体详情
  // ============================================================
  async function selectEntity(id, options) {
    options = options || {}
    if (id === null || id === undefined || id === '') {
      clearSelection()
      return
    }
    const key = String(id)
    state.selected = { kind: 'entity', id: key }
    state.relationDetail = null
    state.entityDetail = null
    state.memoryDetail = null
    document.body.classList.add('detail-open')
    if (graph) {
      graph.setSelected(key)
      graph.setSelectedEdge(null)
      if (options.focus !== false) graph.focusNode(key)
    }
    syncListSelection()
    if (options.scrollList) scrollSelectedIntoView()
    await loadEntityDetail(key, { silent: !!options.silent })
  }

  async function loadEntityDetail(id, options) {
    options = options || {}
    const seq = ++detailSeq
    if (!options.silent) renderDetailLoading('正在读取实体详情…')
    try {
      const data = await request('/memory/entities/' + encodeURIComponent(id))
      if (seq !== detailSeq || !ensureSelected('entity', id)) return
      state.entityDetail = data
      renderEntityDetail(data)
    } catch (error) {
      if (seq !== detailSeq) return
      if (error instanceof ApiError && error.status === 404) {
        toast('实体不存在或已被删除', { type: 'error' })
        clearSelection()
        return
      }
      renderDetailError(error, function () { loadEntityDetail(id) })
      if (options.silent) showError(error)
    }
  }

  function renderEntityDetail(data) {
    const entity = data.entity || {}
    const relations = Array.isArray(data.relations) ? data.relations : []
    const memories = Array.isArray(data.memories) ? data.memories : []
    const neighbors = Array.isArray(data.neighbors) ? data.neighbors : []
    const counts = data.counts || {}
    rememberEntity(entity)
    rememberRelations(relations)

    const head = detailHead(entity.name || '（未命名实体）', [
      typeChip(entity.type),
      el('span', { text: '创建于 ' + formatTime(entity.createdAt) }),
      el('span', { text: '关系 ' + (counts.relations !== undefined ? counts.relations : relations.length) }),
      el('span', { text: '记忆 ' + (counts.memories !== undefined ? counts.memories : memories.length) })
    ])

    const nameInput = textInput({
      value: entity.name || '',
      placeholder: '实体名称',
      maxLength: 200,
      ariaLabel: '实体名称'
    })
    const typeInput = typeSelect(entity.type)
    const summaryInput = textArea({
      value: entity.summary || '',
      rows: 4,
      placeholder: '这个实体是什么？一句摘要即可。'
    })
    const errorBox = el('div', { class: 'form-error', hidden: true })
    const initial = {
      name: entity.name || '',
      type: entity.type || 'concept',
      summary: entity.summary || ''
    }
    const saveButton = makeButton('保存', { class: 'primary' })
    const cancelButton = makeButton('取消')
    const deleteButton = makeButton('删除实体', { class: 'danger-ghost' })

    function currentValues() {
      return {
        name: nameInput.value.trim(),
        type: typeInput.value,
        summary: summaryInput.value.trim()
      }
    }
    function isDirty() {
      const values = currentValues()
      return values.name !== initial.name || values.type !== initial.type || values.summary !== initial.summary
    }
    function refreshDirty() {
      const dirty = isDirty()
      saveButton.disabled = !dirty
      cancelButton.disabled = !dirty
    }
    ;[nameInput, summaryInput].forEach(function (input) { input.addEventListener('input', refreshDirty) })
    typeInput.addEventListener('change', refreshDirty)

    cancelButton.addEventListener('click', function () {
      if (!state.selected || state.selected.kind !== 'entity') return
      loadEntityDetail(state.selected.id, { silent: true })
    })
    saveButton.addEventListener('click', function () {
      const values = currentValues()
      if (!values.name) {
        errorBox.hidden = false
        errorBox.textContent = '名称不能为空。'
        nameInput.focus()
        return
      }
      const payload = {}
      if (values.name !== initial.name) payload.name = values.name
      if (values.type !== initial.type) payload.type = values.type
      if (values.summary !== initial.summary) payload.summary = values.summary
      if (!Object.keys(payload).length) return
      errorBox.hidden = true
      setBusy(saveButton, true, '保存中…')
      request('/memory/entities/' + encodeURIComponent(entity.id), { method: 'PATCH', body: payload })
        .then(function (result) {
          rememberEntity(result.entity || values)
          toast('实体已保存', { type: 'ok' })
          invalidateEntityIndex()
          return refreshAfterMutation().then(function () {
            if (ensureSelected('entity', entity.id)) return loadEntityDetail(entity.id, { silent: true })
            return null
          })
        })
        .catch(function (error) {
          if (error && error.code === 'entity-exists') {
            errorBox.hidden = false
            errorBox.textContent = '保存失败：同一类型下已经有同名实体。'
            toast('同名实体已存在，未保存', { type: 'error' })
          } else {
            showError(error, '保存实体失败')
          }
        })
        .finally(function () { setBusy(saveButton, false) })
    })
    deleteButton.addEventListener('click', function () { deleteEntity(entity, data) })
    refreshDirty()

    const form = el('div', { class: 'entity-form' }, [
      errorBox,
      field('名称', nameInput, { required: true, help: '改名会重新计算实体向量；同名同类型会被拒绝。' }),
      field('类型', typeInput),
      field('摘要', summaryInput, { help: '摘要参与向量嵌入，尽量写清「是什么」。' }),
      el('div', { class: 'form-actions' }, [saveButton, cancelButton, el('span', { class: 'spacer' }), deleteButton])
    ])

    // ---- 关系 ----
    const outRelations = relations.filter(function (relation) {
      const direction = relation.direction || (String(relation.sourceId) === String(entity.id) ? 'out' : 'in')
      return direction === 'out'
    })
    const inRelations = relations.filter(function (relation) {
      const direction = relation.direction || (String(relation.sourceId) === String(entity.id) ? 'out' : 'in')
      return direction === 'in'
    })
    const addRelationButton = el('button', {
      class: 'link-btn', type: 'button', text: '＋ 新增关系',
      on: { click: function () { openRelationCreateModal({ sourceId: entity.id }) } }
    })

    function renderRelationRow(relation, direction) {
      const out = direction === 'out'
      const otherId = relation.otherId || (out ? relation.targetId : relation.sourceId)
      const otherName = relation.otherName || nameOf(otherId)
      const row = el('div', { class: 'mini-row' }, [
        el('button', {
          class: 'entity-link', type: 'button',
          attrs: { title: '打开实体' },
          on: { click: function () { selectEntity(otherId, { focus: true }) } }
        }, [el('span', { class: 'dir', text: out ? '→' : '←' }), otherName]),
        el('button', {
          class: 'rel-word-btn', type: 'button',
          attrs: { title: '查看关系详情' },
          on: {
            click: function () {
              selectRelation(Object.assign({}, relation, {
                sourceName: out ? (entity.name || nameOf(entity.id)) : otherName,
                targetName: out ? otherName : (entity.name || nameOf(entity.id))
              }))
            }
          }
        }, relation.relation || '关系'),
        isActive(relation) ? null : chip('已结束', 'warn'),
        el('span', { class: 'grow' }),
        el('button', {
          class: 'icon-btn danger', type: 'button', text: '✕',
          attrs: { title: '删除关系', 'aria-label': '删除关系' },
          on: { click: function () { deleteRelation(relation) } }
        })
      ])
      return row
    }

    const outSection = el('div', { class: 'detail-section' }, [
      el('h3', {}, ['出边', el('span', { class: 'count', text: String(outRelations.length) }), el('span', { class: 'spacer' }), addRelationButton]),
      outRelations.length
        ? outRelations.map(function (relation) { return renderRelationRow(relation, 'out') })
        : el('div', { class: 'state', text: '没有出边。' })
    ])
    const inSection = el('div', { class: 'detail-section' }, [
      el('h3', {}, ['入边', el('span', { class: 'count', text: String(inRelations.length) })]),
      inRelations.length
        ? inRelations.map(function (relation) { return renderRelationRow(relation, 'in') })
        : el('div', { class: 'state', text: '没有入边。' })
    ])

    // ---- 关联记忆 ----
    const memorySection = el('div', { class: 'detail-section' }, [
      el('h3', {}, ['关联记忆', el('span', { class: 'count', text: String(memories.length) })]),
      memories.length
        ? memories.map(function (memory) {
          return el('div', { class: 'mini-card' }, [
            el('p', { class: 'mini-text', text: truncate(memory.text || memory.id || '', 160) }),
            el('div', { class: 'mini-foot' }, [
              memory.scene ? chip(memory.scene) : null,
              el('span', { text: formatTime(memory.createdAt) }),
              el('span', { class: 'spacer' }),
              el('button', {
                class: 'link-btn', type: 'button', text: '查看',
                on: { click: function () { selectMemory(memory.id) } }
              }),
              el('button', {
                class: 'icon-btn danger', type: 'button', text: '✕',
                attrs: { title: '删除记忆', 'aria-label': '删除记忆' },
                on: { click: function () { deleteMemory(memory) } }
              })
            ])
          ])
        })
        : el('div', { class: 'state', text: '没有关联记忆。' })
    ])

    // ---- 向量近邻 ----
    const neighborSection = el('div', { class: 'detail-section' }, [
      el('h3', {}, ['向量近邻', el('span', { class: 'count', text: String(neighbors.length) })]),
      neighbors.length
        ? neighbors.map(function (neighbor) {
          return el('button', {
            class: 'neighbor', type: 'button',
            attrs: { title: '跳转到该实体' },
            on: { click: function () { selectEntity(neighbor.id, { focus: true }) } }
          }, [
            el('span', { class: 'type-dot ' + typeClass(neighbor.type) }),
            el('span', { class: 'name', text: neighbor.name || nameOf(neighbor.id) }),
            el('span', { class: 'distance', text: '距离 ' + formatDistance(neighbor.distance) })
          ])
        })
        : el('div', { class: 'state', text: '没有近邻（实体可能还没有向量）。' })
    ])

    renderDetailShell(head, [form, outSection, inSection, memorySection, neighborSection])
  }

  // ============================================================
  // 关系详情
  // ============================================================
  async function selectRelation(target, options) {
    options = options || {}
    let row = null
    if (target && typeof target === 'object') row = target
    else if (target !== null && target !== undefined) row = cache.relationMap.get(String(target))
    if (!row) {
      try {
        const relations = await fetchAllPages('/memory/relations?includeEnded=true', 'relations', 500, 6000)
        rememberRelations(relations)
        row = relations.find(function (item) { return String(item.id) === String(target) }) || null
      } catch (error) {
        showError(error, '读取关系失败')
        return
      }
    }
    if (!row) {
      toast('关系不存在或已被删除', { type: 'error' })
      return
    }
    rememberRelations([row])
    const index = await loadEntityIndex().catch(function () { return [] })
    const resolved = Object.assign({}, row, {
      sourceName: row.sourceName || nameOf(row.sourceId),
      targetName: row.targetName || nameOf(row.targetId)
    })
    const indexWithEndpoints = index.slice()
    ;[row.sourceId, row.targetId].forEach(function (id) {
      if (!indexWithEndpoints.some(function (entity) { return String(entity.id) === String(id) })) {
        indexWithEndpoints.push({
          id: id,
          name: String(id) === String(row.sourceId) ? resolved.sourceName : resolved.targetName,
          type: 'concept'
        })
      }
    })
    state.selected = { kind: 'relation', id: String(row.id) }
    state.relationDetail = resolved
    state.entityDetail = null
    state.memoryDetail = null
    document.body.classList.add('detail-open')
    if (graph) {
      graph.setSelected(row.sourceId)
      graph.setSelectedEdge(row.id)
      if (options.focus !== false) graph.focusNode(row.sourceId)
    }
    syncListSelection()
    renderRelationDetail(resolved, indexWithEndpoints)
  }

  function renderRelationDetail(relation, entityIndex) {
    const head = detailHead(relation.relation || '关系', [
      chip(isActive(relation) ? '有效' : '已结束', isActive(relation) ? 'ok' : 'warn'),
      el('span', { text: '创建于 ' + formatTime(relation.validFrom) })
    ])

    const relationInput = textInput({
      value: relation.relation || '',
      placeholder: '例如：喜欢 / 住在 / 从事',
      maxLength: 120,
      ariaLabel: '关系词'
    })
    const sourceCombo = entityCombobox(entityIndex, {
      value: relation.sourceId,
      placeholder: '起点实体…',
      ariaLabel: '关系起点'
    })
    const targetCombo = entityCombobox(entityIndex, {
      value: relation.targetId,
      placeholder: '终点实体…',
      ariaLabel: '关系终点'
    })
    const endedInput = el('input', { type: 'checkbox' })
    endedInput.checked = !isActive(relation)
    const endedLabel = el('label', { class: 'field' },
      el('span', { class: 'label' }, '已结束'),
      el('span', {}, [endedInput, ' 把这条关系标记为已结束（validTo > 0）']))
    const errorBox = el('div', { class: 'form-error', hidden: true })

    const saveButton = makeButton('保存', { class: 'primary' })
    const cancelButton = makeButton('取消')
    const deleteButton = makeButton('删除关系', { class: 'danger-ghost' })

    const initial = {
      relation: relation.relation || '',
      sourceId: String(relation.sourceId),
      targetId: String(relation.targetId),
      ended: !isActive(relation)
    }
    function isDirty() {
      return relationInput.value.trim() !== initial.relation ||
        sourceCombo.getValue() !== initial.sourceId ||
        targetCombo.getValue() !== initial.targetId ||
        endedInput.checked !== initial.ended
    }
    function refreshDirty() {
      const dirty = isDirty()
      saveButton.disabled = !dirty
      cancelButton.disabled = !dirty
    }
    relationInput.addEventListener('input', refreshDirty)
    endedInput.addEventListener('change', refreshDirty)
    ;[sourceCombo.input, targetCombo.input].forEach(function (input) {
      input.addEventListener('input', refreshDirty)
    })

    cancelButton.addEventListener('click', function () {
      if (state.relationDetail) renderRelationDetail(state.relationDetail, entityIndex)
    })
    saveButton.addEventListener('click', function () {
      const relationWord = relationInput.value.trim()
      const sourceId = sourceCombo.getValue()
      const targetId = targetCombo.getValue()
      if (!relationWord) {
        errorBox.hidden = false
        errorBox.textContent = '关系词不能为空。'
        relationInput.focus()
        return
      }
      if (!sourceId || !targetId) {
        errorBox.hidden = false
        errorBox.textContent = '请从下拉列表中选择起点与终点实体。'
        return
      }
      if (sourceId === targetId) {
        errorBox.hidden = false
        errorBox.textContent = '关系不能指向实体自身。'
        return
      }
      const payload = {}
      if (relationWord !== initial.relation) payload.relation = relationWord
      if (sourceId !== initial.sourceId) payload.sourceId = sourceId
      if (targetId !== initial.targetId) payload.targetId = targetId
      if (endedInput.checked !== initial.ended) payload.validTo = endedInput.checked ? Date.now() : 0
      if (!Object.keys(payload).length) return
      errorBox.hidden = true
      setBusy(saveButton, true, '保存中…')
      request('/memory/relations/' + encodeURIComponent(relation.id), { method: 'PATCH', body: payload })
        .then(function (result) {
          const updated = result.relation || Object.assign({}, relation, payload)
          rememberRelations([updated])
          toast('关系已保存', { type: 'ok' })
          return refreshAfterMutation().then(function () {
            state.relationDetail = Object.assign({}, relation, updated, {
              sourceName: nameOf(updated.sourceId || payload.sourceId || relation.sourceId),
              targetName: nameOf(updated.targetId || payload.targetId || relation.targetId)
            })
            if (ensureSelected('relation', relation.id)) {
              selectRelation(state.relationDetail, { focus: false })
            }
            return null
          })
        })
        .catch(function (error) { showError(error, '保存关系失败') })
        .finally(function () { setBusy(saveButton, false) })
    })
    deleteButton.addEventListener('click', function () { deleteRelation(relation) })
    refreshDirty()

    const form = el('div', { class: 'relation-form' }, [
      errorBox,
      field('关系词', relationInput, { required: true }),
      field('起点', sourceCombo.node, { required: true, help: '从已有实体中选择。' }),
      field('终点', targetCombo.node, { required: true }),
      endedLabel,
      el('div', { class: 'form-actions' }, [saveButton, cancelButton, el('span', { class: 'spacer' }), deleteButton])
    ])

    const metaSection = el('div', { class: 'detail-section' }, [
      el('h3', {}, '元数据'),
      el('dl', { class: 'meta-grid' }, [
        el('dt', { text: '起点' }),
        el('dd', {}, el('button', {
          class: 'entity-link', type: 'button',
          on: { click: function () { selectEntity(relation.sourceId, { focus: true }) } }
        }, relation.sourceName || nameOf(relation.sourceId))),
        el('dt', { text: '终点' }),
        el('dd', {}, el('button', {
          class: 'entity-link', type: 'button',
          on: { click: function () { selectEntity(relation.targetId, { focus: true }) } }
        }, relation.targetName || nameOf(relation.targetId))),
        el('dt', { text: '开始' }),
        el('dd', { text: formatTime(relation.validFrom) }),
        el('dt', { text: '结束' }),
        el('dd', { text: isActive(relation) ? '仍然有效（validTo = 0）' : formatTime(relation.validTo) }),
        el('dt', { text: '来源' }),
        el('dd', { text: relation.source || '—' })
      ])
    ])

    renderDetailShell(head, [form, metaSection])
  }

  // ============================================================
  // 记忆详情
  // ============================================================
  async function selectMemory(id, options) {
    options = options || {}
    const key = String(id)
    state.selected = { kind: 'memory', id: key }
    state.entityDetail = null
    state.relationDetail = null
    state.memoryDetail = null
    document.body.classList.add('detail-open')
    if (graph) {
      graph.setSelected(null)
      graph.setSelectedEdge(null)
    }
    syncListSelection()
    await loadMemoryDetail(key, { silent: !!options.silent })
  }

  async function loadMemoryDetail(id, options) {
    options = options || {}
    const seq = ++detailSeq
    if (!options.silent) renderDetailLoading('正在读取记忆…')
    try {
      const data = await request('/memory/memories/' + encodeURIComponent(id))
      if (seq !== detailSeq || !ensureSelected('memory', id)) return
      state.memoryDetail = data
      renderMemoryDetail(data)
    } catch (error) {
      if (seq !== detailSeq) return
      if (error instanceof ApiError && error.status === 404) {
        toast('记忆不存在或已被删除', { type: 'error' })
        clearSelection()
        return
      }
      renderDetailError(error, function () { loadMemoryDetail(id) })
      if (options.silent) showError(error)
    }
  }

  function renderMemoryDetail(data) {
    const memory = data.memory || {}
    const entities = Array.isArray(data.entities) ? data.entities : []
    entities.forEach(rememberEntity)

    const head = detailHead('记忆详情', [
      memory.scene ? chip(memory.scene) : null,
      el('span', { text: formatTime(memory.createdAt) }),
      el('span', { text: '关联实体 ' + entities.length })
    ])

    const textBodyInput = textArea({
      value: memory.text || '',
      rows: 9,
      placeholder: '记忆正文…'
    })
    const sceneInput = textInput({
      value: memory.scene || '',
      placeholder: '场景（例如 chat / selftest）',
      maxLength: 80,
      ariaLabel: '记忆场景'
    })
    const errorBox = el('div', { class: 'form-error', hidden: true })
    const saveButton = makeButton('保存', { class: 'primary' })
    const cancelButton = makeButton('取消')
    const deleteButton = makeButton('删除记忆', { class: 'danger-ghost' })
    const reextractButton = makeButton('重新抽取图谱', { class: 'subtle' })

    const initial = { text: memory.text || '', scene: memory.scene || '' }
    function isDirty() {
      return textBodyInput.value.trim() !== initial.text.trim() || sceneInput.value.trim() !== initial.scene.trim()
    }
    function refreshDirty() {
      const dirty = isDirty()
      saveButton.disabled = !dirty
      cancelButton.disabled = !dirty
    }
    textBodyInput.addEventListener('input', refreshDirty)
    sceneInput.addEventListener('input', refreshDirty)
    cancelButton.addEventListener('click', function () {
      if (state.selected && state.selected.kind === 'memory') loadMemoryDetail(state.selected.id, { silent: true })
    })
    saveButton.addEventListener('click', function () {
      const text = textBodyInput.value.trim()
      const scene = sceneInput.value.trim()
      if (!text) {
        errorBox.hidden = false
        errorBox.textContent = '记忆正文不能为空。'
        textBodyInput.focus()
        return
      }
      const payload = {}
      if (text !== initial.text) payload.text = text
      if (scene !== initial.scene) payload.scene = scene
      if (!Object.keys(payload).length) return
      errorBox.hidden = true
      setBusy(saveButton, true, '保存中…')
      request('/memory/memories/' + encodeURIComponent(memory.id), { method: 'PATCH', body: payload })
        .then(function (result) {
          toast('记忆已保存', { type: 'ok' })
          return refreshAfterMutation().then(function () {
            if (ensureSelected('memory', memory.id)) {
              state.memoryDetail = { memory: result.memory || memory, entities: entities }
              renderMemoryDetail(state.memoryDetail)
            }
            return null
          })
        })
        .catch(function (error) { showError(error, '保存记忆失败') })
        .finally(function () { setBusy(saveButton, false) })
    })
    deleteButton.addEventListener('click', function () { deleteMemory(memory) })
    reextractButton.addEventListener('click', function () { reextractMemory(memory) })
    refreshDirty()

    const form = el('div', { class: 'memory-form' }, [
      errorBox,
      field('正文', textBodyInput, { required: true, help: '修改正文会重新计算记忆向量。' }),
      field('场景', sceneInput),
      el('div', { class: 'form-actions' }, [saveButton, cancelButton, reextractButton, el('span', { class: 'spacer' }), deleteButton])
    ])

    const entitySection = el('div', { class: 'detail-section' }, [
      el('h3', {}, ['关联实体', el('span', { class: 'count', text: String(entities.length) })]),
      entities.length
        ? el('div', { class: 'chip-list' }, entities.map(function (entity) {
          return el('button', {
            class: 'chip accent', type: 'button',
            attrs: { title: '打开实体' },
            on: { click: function () { selectEntity(entity.id, { focus: true }) } }
          }, [el('span', { class: 'type-dot ' + typeClass(entity.type) }), entity.name || nameOf(entity.id)])
        }))
        : el('div', { class: 'state', text: '这条记忆还没有关联实体。' })
    ])

    const metaSection = el('div', { class: 'detail-section' }, [
      el('h3', {}, '元数据'),
      el('dl', { class: 'meta-grid' }, [
        el('dt', { text: '创建时间' }),
        el('dd', { text: formatTime(memory.createdAt) }),
        el('dt', { text: '来源' }),
        el('dd', { text: memory.source || '—' }),
        el('dt', { text: 'ID' }),
        el('dd', { text: String(memory.id || '—') }),
        el('dt', { text: '场景' }),
        el('dd', { text: memory.scene || '—' })
      ])
    ])

    renderDetailShell(head, [form, entitySection, metaSection])
  }

  // ============================================================
  // 写操作后的刷新
  // ============================================================
  async function refreshAfterMutation() {
    invalidateEntityIndex()
    const tasks = [loadStats(), loadGraph(), loadActiveList({ reset: true, preserveScroll: true })]
    await Promise.allSettled(tasks)
    if (graph) {
      const counts = graph.getCounts()
      dom.graphBadge.textContent = '实体 ' + formatNumber(counts.nodes) + ' · 关系 ' + formatNumber(counts.edges)
    }
    syncListSelection()
  }

  async function reloadSelectedDetail() {
    if (!state.selected) return
    if (state.selected.kind === 'entity') await loadEntityDetail(state.selected.id, { silent: true })
    else if (state.selected.kind === 'memory') await loadMemoryDetail(state.selected.id, { silent: true })
    else if (state.selected.kind === 'relation') {
      const row = cache.relationMap.get(String(state.selected.id))
      if (row) await selectRelation(row, { focus: false })
    }
  }

  // ============================================================
  // 删除 / 合并 / 恢复
  // ============================================================
  async function deleteEntity(entity, detail) {
    const counts = (detail && detail.counts) || {}
    const confirmed = await confirmAction({
      title: '删除实体',
      message: '确定要删除实体「' + (entity.name || entity.id) + '」吗？',
      detail: '将级联删除 ' + (counts.relations || 0) + ' 条关系，并从 ' +
        (counts.memories || 0) + ' 条记忆中移除引用。实体与关系会进入回收站，删除后可在回收站恢复。',
      confirmLabel: '删除实体'
    })
    if (!confirmed) return
    try {
      const result = await request('/memory/entities/' + encodeURIComponent(entity.id), { method: 'DELETE' })
      if (state.selected && state.selected.kind === 'entity' && String(state.selected.id) === String(entity.id)) {
        clearSelection()
      }
      toast('已删除实体「' + (entity.name || entity.id) + '」' +
        (result && result.relationsDeleted !== undefined ? '（' + result.relationsDeleted + ' 条关系）' : '') +
        '，可在回收站恢复。', { type: 'ok', timeout: 5200 })
      await refreshAfterMutation()
    } catch (error) {
      showError(error, '删除实体失败')
    }
  }

  async function deleteRelation(relation) {
    const sourceName = relation.sourceName || nameOf(relation.sourceId)
    const targetName = relation.targetName || nameOf(relation.targetId)
    const confirmed = await confirmAction({
      title: '删除关系',
      message: '删除「' + sourceName + ' —' + (relation.relation || '关系') + '→ ' + targetName + '」？',
      detail: '关系会进入回收站，删除后可在回收站恢复。',
      confirmLabel: '删除关系'
    })
    if (!confirmed) return
    try {
      await request('/memory/relations/' + encodeURIComponent(relation.id), { method: 'DELETE' })
      if (state.selected && state.selected.kind === 'relation' && String(state.selected.id) === String(relation.id)) {
        clearSelection()
      }
      toast('关系已删除，可在回收站恢复。', { type: 'ok', timeout: 4600 })
      await refreshAfterMutation()
      if (state.selected && state.selected.kind === 'entity') {
        await loadEntityDetail(state.selected.id, { silent: true })
      }
    } catch (error) {
      showError(error, '删除关系失败')
    }
  }

  async function deleteMemory(memory) {
    const confirmed = await confirmAction({
      title: '删除记忆',
      message: '删除这条记忆？',
      detail: '「' + truncate(memory.text || memory.id || '', 90) + '」\n' +
        '记忆会进入回收站，删除后可在回收站恢复。',
      confirmLabel: '删除记忆'
    })
    if (!confirmed) return
    try {
      await request('/memory/memories/' + encodeURIComponent(memory.id), { method: 'DELETE' })
      if (state.selected && state.selected.kind === 'memory' && String(state.selected.id) === String(memory.id)) {
        clearSelection()
      }
      toast('记忆已删除，可在回收站恢复。', { type: 'ok', timeout: 4600 })
      await refreshAfterMutation()
      if (state.selected && state.selected.kind === 'entity') {
        await loadEntityDetail(state.selected.id, { silent: true })
      }
    } catch (error) {
      showError(error, '删除记忆失败')
    }
  }

  async function reextractMemory(memory) {
    const confirmed = await confirmAction({
      title: '重新抽取图谱',
      message: '对这条记忆重新运行实体/关系抽取？',
      detail: '抽取会调用模型并在后台异步执行，可能新增实体或关系；不会修改记忆正文。',
      confirmLabel: '重新抽取',
      danger: false
    })
    if (!confirmed) return
    try {
      await request('/memory/memories/' + encodeURIComponent(memory.id) + '/reextract', { method: 'POST' })
      toast('已提交重新抽取（异步执行）。', { type: 'ok' })
    } catch (error) {
      showError(error, '提交重新抽取失败')
    }
  }

  async function restoreTrashItem(item) {
    const label = trashLabel(item)
    const confirmed = await confirmAction({
      title: '恢复删除项',
      message: '把' + (KIND_LABEL[item.kind] || '项目') + '「' + truncate(label, 60) + '」恢复到记忆库？',
      detail: '恢复按原 id 写回；如果同 id 已存在，服务端会拒绝恢复。',
      confirmLabel: '恢复',
      danger: false
    })
    if (!confirmed) return
    try {
      await request('/memory/trash/' + encodeURIComponent(item.trashId) + '/restore', { method: 'POST' })
      toast('已恢复' + (KIND_LABEL[item.kind] || '项目') + '。', { type: 'ok' })
      invalidateEntityIndex()
      await Promise.allSettled([loadStats(), loadGraph(), loadTrash({ more: false })])
    } catch (error) {
      if (error && error.code === 'restore-conflict') {
        toast('恢复冲突：该 id 已存在，无法恢复。', { type: 'error' })
      } else {
        showError(error, '恢复失败')
      }
    }
  }

  // ============================================================
  // 新增 / 合并 弹窗
  // ============================================================
  function openEntityCreateModal() {
    const nameInput = textInput({ placeholder: '例如：听雪 / 上海 / 咖啡', ariaLabel: '实体名称', maxLength: 200 })
    const typeInput = typeSelect('concept')
    const summaryInput = textArea({ rows: 3, placeholder: '可选。写清这个实体是什么，会参与向量嵌入。' })
    const errorBox = el('div', { class: 'form-error', hidden: true })
    const cancelButton = makeButton('取消')
    const submitButton = makeButton('创建', { class: 'primary' })

    const body = el('div', { class: 'form' }, [
      errorBox,
      field('名称', nameInput, { required: true }),
      field('类型', typeInput),
      field('摘要', summaryInput, { help: '名称 + 摘要会被向量化，用于近邻与语义检索。' })
    ])

    const modal = openModal({
      title: '新增实体',
      subtitle: '同名同类型实体已存在时，服务端会返回 409，不会重复创建。',
      body: body,
      footer: [cancelButton, submitButton],
      width: 470
    })
    cancelButton.addEventListener('click', function () { modal.close() })

    let existingEntity = null
    submitButton.addEventListener('click', function () {
      const name = nameInput.value.trim()
      const type = typeInput.value
      const summary = summaryInput.value.trim()
      errorBox.hidden = true
      if (!name) {
        errorBox.hidden = false
        errorBox.textContent = '名称不能为空。'
        nameInput.focus()
        return
      }
      setBusy(submitButton, true, '创建中…')
      existingEntity = null
      request('/memory/entities', { method: 'POST', body: { name: name, type: type, summary: summary } })
        .then(function (result) {
          modal.close()
          toast('实体「' + name + '」已创建', { type: 'ok' })
          invalidateEntityIndex()
          return refreshAfterMutation().then(function () {
            return selectEntity(result.entity && result.entity.id, { focus: true, scrollList: true })
          })
        })
        .catch(function (error) {
          if (error && error.code === 'entity-exists') {
            existingEntity = error.payload && error.payload.entity
            errorBox.hidden = false
            errorBox.textContent = '同一类型下已经有同名实体。'
            if (existingEntity && existingEntity.id) {
              const openExisting = el('button', {
                class: 'link-btn', type: 'button', text: '打开已存在的实体「' + (existingEntity.name || existingEntity.id) + '」',
                on: {
                  click: function () {
                    modal.close()
                    refreshAfterMutation().then(function () {
                      selectEntity(existingEntity.id, { focus: true, scrollList: true })
                    })
                  }
                }
              })
              errorBox.appendChild(document.createElement('br'))
              errorBox.appendChild(openExisting)
            }
          } else {
            showError(error, '创建实体失败')
          }
        })
        .finally(function () { setBusy(submitButton, false) })
    })

    setTimeout(function () { nameInput.focus() }, 50)
  }

  async function openRelationCreateModal(options) {
    options = options || {}
    let entityIndex
    try {
      entityIndex = await loadEntityIndex()
    } catch (error) {
      showError(error, '读取实体列表失败')
      return
    }
    if (!entityIndex.length) {
      toast('还没有实体，请先新增实体。', { type: 'error' })
      return
    }
    const sourceValue = options.sourceId || ''
    const targetValue = options.targetId || ''
    const sourceCombo = entityCombobox(entityIndex, {
      value: sourceValue,
      placeholder: '搜索起点实体…',
      ariaLabel: '关系起点'
    })
    const targetCombo = entityCombobox(entityIndex, {
      value: targetValue,
      placeholder: '搜索终点实体…',
      ariaLabel: '关系终点',
      excludeId: sourceValue
    })
    const relationInput = textInput({
      placeholder: '例如：喜欢 / 住在 / 从事',
      maxLength: 120,
      ariaLabel: '关系词'
    })
    const errorBox = el('div', { class: 'form-error', hidden: true })
    const cancelButton = makeButton('取消')
    const submitButton = makeButton('创建', { class: 'primary' })

    const body = el('div', { class: 'form' }, [
      errorBox,
      field('起点实体', sourceCombo.node, { required: true }),
      field('关系词', relationInput, { required: true }),
      field('终点实体', targetCombo.node, { required: true }),
      el('div', { class: 'help', text: '两端都必须是已有实体，且不能指向自身。' })
    ])
    const modal = openModal({
      title: '新增关系',
      subtitle: '关系会立刻出现在图谱与实体详情中。',
      body: body,
      footer: [cancelButton, submitButton],
      width: 470
    })
    cancelButton.addEventListener('click', function () { modal.close() })

    submitButton.addEventListener('click', function () {
      const sourceId = sourceCombo.getValue()
      const targetId = targetCombo.getValue()
      const relationWord = relationInput.value.trim()
      errorBox.hidden = true
      if (!sourceId || !targetId) {
        errorBox.hidden = false
        errorBox.textContent = '请从下拉列表中选择起点与终点实体。'
        return
      }
      if (sourceId === targetId) {
        errorBox.hidden = false
        errorBox.textContent = '关系不能指向实体自身。'
        return
      }
      if (!relationWord) {
        errorBox.hidden = false
        errorBox.textContent = '关系词不能为空。'
        relationInput.focus()
        return
      }
      setBusy(submitButton, true, '创建中…')
      request('/memory/relations', { method: 'POST', body: { sourceId: sourceId, targetId: targetId, relation: relationWord } })
        .then(function (result) {
          const created = Object.assign({}, result.relation || {
            id: '',
            sourceId: sourceId,
            targetId: targetId,
            relation: relationWord
          }, {
            sourceName: nameOf(sourceId),
            targetName: nameOf(targetId)
          })
          rememberRelations([created])
          modal.close()
          toast('关系已创建', { type: 'ok' })
          invalidateEntityIndex()
          return refreshAfterMutation().then(function () {
            if (sourceValue && state.selected && state.selected.kind === 'entity') {
              return loadEntityDetail(state.selected.id, { silent: true })
            }
            return selectRelation(created, { focus: true })
          })
        })
        .catch(function (error) { showError(error, '创建关系失败') })
        .finally(function () { setBusy(submitButton, false) })
    })
  }

  async function openMergeModal() {
    let entityIndex
    try {
      entityIndex = await loadEntityIndex()
    } catch (error) {
      showError(error, '读取实体列表失败')
      return
    }
    if (entityIndex.length < 2) {
      toast('至少需要两个实体才能合并。', { type: 'error' })
      return
    }
    const keepCombo = entityCombobox(entityIndex, { placeholder: '搜索要保留的实体…', ariaLabel: '保留方实体' })
    const mergeCombo = entityCombobox(entityIndex, { placeholder: '搜索要被合并的实体…', ariaLabel: '被合并实体' })
    const errorBox = el('div', { class: 'form-error', hidden: true })
    const cancelButton = makeButton('取消')
    const mergeButton = makeButton('合并', { class: 'danger-solid' })
    const warning = el('p', { class: 'confirm-detail danger', text: '合并会把被合并实体的关系与记忆引用迁移到保留方，被合并实体进入回收站。合并后关系迁移不会随恢复自动回滚。' })

    const body = el('div', { class: 'form' }, [
      errorBox,
      field('保留方（keepId）', keepCombo.node, { required: true }),
      field('被合并方（mergeId）', mergeCombo.node, { required: true }),
      warning
    ])
    const modal = openModal({
      title: '合并实体',
      subtitle: '把「被合并方」的关系、记忆引用迁移到「保留方」。',
      body: body,
      footer: [cancelButton, mergeButton],
      width: 500
    })
    cancelButton.addEventListener('click', function () { modal.close() })

    mergeButton.addEventListener('click', async function () {
      const keepId = keepCombo.getValue()
      const mergeId = mergeCombo.getValue()
      errorBox.hidden = true
      if (!keepId || !mergeId) {
        errorBox.hidden = false
        errorBox.textContent = '请分别选择保留方与被合并方。'
        return
      }
      if (keepId === mergeId) {
        errorBox.hidden = false
        errorBox.textContent = '保留方与被合并方不能是同一个实体。'
        return
      }
      const keepName = nameOf(keepId)
      const mergeName = nameOf(mergeId)
      const confirmed = await confirmAction({
        title: '确认合并实体',
        message: '把「' + mergeName + '」合并进「' + keepName + '」？',
        detail: '操作会立即迁移关系与记忆引用，并把「' + mergeName + '」放进回收站。',
        confirmLabel: '确认合并'
      })
      if (!confirmed) return
      setBusy(mergeButton, true, '合并中…')
      try {
        const result = await request('/memory/entities/merge', { method: 'POST', body: { keepId: keepId, mergeId: mergeId } })
        modal.close()
        toast('已把「' + mergeName + '」合并进「' + keepName + '」：迁移 ' +
          (result.relationsMoved === undefined ? '—' : result.relationsMoved) + ' 条关系，更新 ' +
          (result.memoriesUpdated === undefined ? '—' : result.memoriesUpdated) + ' 条记忆。', { type: 'ok', timeout: 5200 })
        invalidateEntityIndex()
        const wasMergeSelected = !!(state.selected && state.selected.kind === 'entity' && String(state.selected.id) === String(mergeId))
        const wasKeepSelected = !!(state.selected && state.selected.kind === 'entity' && String(state.selected.id) === String(keepId))
        if (wasMergeSelected) clearSelection()
        invalidateEntityIndex()
        await refreshAfterMutation()
        if (wasMergeSelected || wasKeepSelected) await selectEntity(keepId, { focus: true, scrollList: true })
        else if (state.selected) await reloadSelectedDetail()
      } catch (error) {
        showError(error, '合并实体失败')
      } finally {
        setBusy(mergeButton, false)
      }
    })
  }

  // ============================================================
  // 统计弹窗
  // ============================================================
  async function openStatsModal() {
    const body = el('div')
    body.appendChild(el('div', { class: 'state' }, el('div', { class: 'spinner' }), el('div', { text: '读取统计…' })))
    const closeButton = makeButton('关闭')
    const modal = openModal({
      title: '统计与最近操作',
      subtitle: '数据来自 GET /memory/stats 与 GET /memory/audit；不含向量与凭据。',
      body: body,
      footer: [closeButton],
      width: 540
    })
    closeButton.addEventListener('click', function () { modal.close() })

    async function fill() {
      body.replaceChildren(el('div', { class: 'state' }, el('div', { class: 'spinner' }), el('div', { text: '读取统计…' })))
      try {
        const [stats, audit] = await Promise.all([
          request('/memory/stats'),
          request('/memory/audit?limit=15').catch(function () { return null })
        ])
        state.stats = stats
        renderStats()
        const cards = el('div', { class: 'stat-grid' }, [
          statCard('记忆', stats.memories),
          statCard('实体', stats.entities, true),
          statCard('关系', stats.relations),
          statCard('有效关系', stats.activeRelations),
          statCard('回收站', stats.trash),
          statCard('实体类型', TYPE_OPTIONS.length)
        ])
        const children = [cards]
        const auditSection = el('div', { class: 'audit-list' })
        auditSection.appendChild(el('h3', { text: '最近管理操作' }))
        if (audit && Array.isArray(audit.items) && audit.items.length) {
          audit.items.forEach(function (item) {
            auditSection.appendChild(el('div', { class: 'audit-item' }, [
              el('span', { class: 'op', text: item.op || '操作' }),
              el('span', { class: 'detail', text: auditDetail(item) }),
              el('span', { class: 'at', text: formatTime(item.at) })
            ]))
          })
        } else {
          auditSection.appendChild(el('div', { class: 'state', text: '没有审计记录（或服务端未提供 /memory/audit）。' }))
        }
        children.push(auditSection)
        children.push(el('p', { class: 'audit-note', text: 'API base：' + API_BASE + ' · 主题：' + (state.themeMode === 'auto' ? '跟随系统' : THEME_META[state.themeMode].label) }))
        body.replaceChildren.apply(body, children)
      } catch (error) {
        body.replaceChildren(el('div', { class: 'state error' }, [
          el('div', { class: 'state-icon', text: '⚠' }),
          el('div', { text: errorMessage(error) }),
          el('button', { class: 'btn small', type: 'button', text: '重试', on: { click: fill } })
        ]))
      }
    }

    function statCard(label, value, accent) {
      return el('div', { class: 'stat-card' + (accent ? ' accent' : '') }, [
        el('div', { class: 'stat-label', text: label }),
        el('div', { class: 'stat-value', text: value === undefined || value === null ? '—' : formatNumber(value) })
      ])
    }

    function auditDetail(item) {
      if (item.detail) return String(item.detail)
      const kind = KIND_LABEL[item.kind] || item.kind || ''
      return (kind ? kind + ' ' : '') + (item.id ? String(item.id) : '')
    }

    fill()
  }

  // ============================================================
  // 搜索 / 过滤 / 刷新
  // ============================================================
  function applySearch(value) {
    const next = String(value == null ? '' : value).trim()
    if (next === state.search) return
    state.search = next
    dom.searchClear.hidden = !next
    if (graph) graph.setSearch(next)
    loadActiveList({ reset: true })
  }

  function clearSearch() {
    clearTimeout(searchTimer)
    dom.searchInput.value = ''
    dom.searchClear.hidden = true
    applySearch('')
    dom.searchInput.focus()
  }

  function setTypeFilter(type) {
    if (type !== 'all' && TYPE_OPTIONS.indexOf(type) < 0) return
    state.type = type
    const buttons = dom.typeFilter.querySelectorAll('button[data-type]')
    Array.prototype.forEach.call(buttons, function (button) {
      button.setAttribute('aria-pressed', button.dataset.type === type ? 'true' : 'false')
    })
    if (graph) graph.setTypeFilter(type)
    if (state.tab === 'entities') loadEntities({ reset: true })
    else updateListChrome()
  }

  async function refreshEverything(options) {
    options = options || {}
    dom.btnRefresh.disabled = true
    dom.btnRefresh.classList.add('is-spinning')
    invalidateEntityIndex()
    const tasks = [loadStats(), loadGraph(), loadActiveList({ reset: true, preserveScroll: true })]
    if (state.selected) tasks.push(reloadSelectedDetail())
    const results = await Promise.allSettled(tasks)
    dom.btnRefresh.disabled = false
    dom.btnRefresh.classList.remove('is-spinning')
    const failed = results.filter(function (result) { return result.status === 'rejected' })
    if (!options.silent) {
      if (failed.length) toast('刷新完成，但有 ' + failed.length + ' 项失败', { type: 'error' })
      else toast('已刷新', { type: 'ok', timeout: 1600 })
    }
  }

  // ============================================================
  // 事件绑定与启动
  // ============================================================
  function bindEvents() {
    dom.searchInput.addEventListener('input', function () {
      const value = dom.searchInput.value
      dom.searchClear.hidden = !value.trim()
      if (graph) graph.setSearch(value)
      clearTimeout(searchTimer)
      searchTimer = setTimeout(function () { applySearch(value) }, 260)
    })
    dom.searchInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        clearTimeout(searchTimer)
        applySearch(dom.searchInput.value)
      } else if (event.key === 'Escape') {
        if (dom.searchInput.value) {
          event.stopPropagation()
          clearSearch()
        }
      }
    })
    dom.searchClear.addEventListener('click', clearSearch)

    dom.typeFilter.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-type]')
      if (!button) return
      setTypeFilter(button.dataset.type)
    })

    dom.tabs.forEach(function (button) {
      button.addEventListener('click', function () { setTab(button.dataset.tab) })
    })
    dom.btnLoadMore.addEventListener('click', function () {
      if (state.tab === 'entities') loadEntities({ append: true })
      else if (state.tab === 'relations') loadRelations({ append: true })
      else if (state.tab === 'memories') loadMemories({ append: true })
      else if (state.tab === 'trash') loadTrash({ more: true })
    })
    dom.btnListReload.addEventListener('click', function () {
      if (state.tab === 'trash') loadTrash({ more: false })
      else loadActiveList({ reset: true })
    })

    dom.btnNewEntity.addEventListener('click', openEntityCreateModal)
    dom.btnNewRelation.addEventListener('click', function () {
      openRelationCreateModal({})
    })
    dom.btnMerge.addEventListener('click', openMergeModal)
    dom.btnRefresh.addEventListener('click', function () { refreshEverything() })
    dom.btnStats.addEventListener('click', openStatsModal)
    dom.btnTheme.addEventListener('click', cycleTheme)

    dom.btnFit.addEventListener('click', function () { if (graph) graph.fit() })
    dom.btnHome.addEventListener('click', function () { if (graph) graph.home() })
    dom.btnZoomIn.addEventListener('click', function () { if (graph) graph.zoomIn() })
    dom.btnZoomOut.addEventListener('click', function () { if (graph) graph.zoomOut() })
    dom.btnMinimap.addEventListener('click', function () {
      if (!graph) return
      const mode = graph.toggleMinimap()
      dom.btnMinimap.setAttribute('aria-pressed', mode === 'eagle' ? 'true' : 'false')
      toast(mode === 'eagle' ? '小地图：鹰眼模式' : '小地图：全图缩略 + 视口框', { timeout: 1600 })
    })

    document.addEventListener('keydown', function (event) {
      const tag = (event.target && event.target.tagName ? event.target.tagName : '').toLowerCase()
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' ||
        (event.target && event.target.isContentEditable)
      if (!typing && (event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'))) {
        event.preventDefault()
        dom.searchInput.focus()
        dom.searchInput.select()
      }
    })
  }

  function renderDetailEmptyInitial() {
    renderDetailEmpty()
  }

  async function boot() {
    cacheDom()
    initTheme()
    setupGraph()
    bindEvents()
    renderDetailEmptyInitial()
    renderStats()
    booted = true
    // 左侧列表与图谱各自加载；失败时各自有内联状态 + toast。
    loadActiveList({ reset: true })
    loadStats().catch(function (error) { showError(error) })
    loadGraph()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
