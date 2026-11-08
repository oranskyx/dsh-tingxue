// 客户端面板冒烟测试：在极简 React / __ModuleLoader__ 替身里执行 client/panel.js。
//
// 为什么必须有这个文件：2026-11-08 面板并入主包后，panel.js 的模块 id 仍写着
// `dsh-tingxue-ui`，与独立的 UI 包重名 → 浏览器报
//   client-modules: duplicate factory registration for "dsh-tingxue-ui"
// → web boot 「1 entry did not activate」→ 整个 DSH 起不来。
// 当时 CI 只测了 Host 侧 import，客户端一行没测，所以零防护。
//
// 这个测试只回答三件事：
//   1. 模块能执行完、只注册一次、id 是 dsh-tingxue（不撞别人）；
//   2. apply() 在假 ctx 下不抛错，注册出「三个面板」；
//   3. 三个页面的渲染函数能跑（假数据），不抛。
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

const source = readFileSync(new URL('../client/panel.js', import.meta.url), 'utf8')

// 极简 React 替身：只做 createElement，state 返回初值，effect 不执行。
const fakeReact = {
  createElement(type, props, ...children) {
    const merged = { ...(props || {}) }
    const flat = children.length <= 1 ? children[0] : children
    if (flat !== undefined) merged.children = flat
    return { type, props: merged }
  },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect() {},
  useRef(value) { return { current: value } },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
}

const captured = []
const fakeWindow = { __ModuleLoader__: { load(definition) { captured.push(definition) } } }

const factory = new Function('window', 'console', source)
factory(fakeWindow, { warn() {}, error() {}, log() {} })

test('只注册一个客户端模块，且 id 不与独立 UI 包重名', () => {
  assert.equal(captured.length, 1, '一个 bundle 只能注册一个模块')
  assert.equal(captured[0].id, 'dsh-tingxue', 'id 必须是 dsh-tingxue（旧值 dsh-tingxue-ui 会与独立包撞车）')
})

test('apply 在假 ctx 下注册三个面板且不抛错', () => {
  const definition = captured[0]
  assert.equal(typeof definition.factory, 'function')

  const modules = definition.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error(`unexpected require: ${id}`)
  })

  const slots = []
  const locale = {
    register() { return () => {} },
    bind() { return (key, fallback) => fallback ?? key },
  }
  const ctx = {
    effect(fn) { try { fn() } catch { /* 测试里忽略 */ } return () => {} },
    slots: { inject(name, fn) { fn() }, register(entry, component) { slots.push({ entry, component }) } },
    locale,
  }

  // 客户端面板会 fire-and-forget 一个自检回报；替身里吞掉。
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, json: async () => null })
  try {
    modules.apply(ctx)
  } finally {
    globalThis.fetch = realFetch
  }

  const entryIds = slots.map((s) => s.entry.id).filter(Boolean)
  assert.deepEqual(entryIds, ['tingxue-companion', 'tingxue-agent', 'tingxue-memory'])
  const mainKeys = slots.filter((s) => s.entry.name === 'main').map((s) => s.entry.key)
  assert.deepEqual(mainKeys, ['tingxue-companion', 'tingxue-agent', 'tingxue-memory'])
})

test('三个页面在假数据下都能渲染', () => {
  const definition = captured[0]
  // 把页面组件暴露出来（只在内存里改写源码，不落盘）
  const patched = source.replace(
    '    return {\n      inject: [\'slots\', \'locale\'],',
    '    globalThis.__PANEL_TEST__ = { CompanionPage, AgentPage, MemoryPage, makeTr, DICT }\n    return {\n      inject: [\'slots\', \'locale\'],',
  )
  assert.notEqual(patched, source, '页面组件必须能被测试拿到')
  const localCaptured = []
  new Function('window', 'console', patched)(
    { __ModuleLoader__: { load(d) { localCaptured.push(d) } } },
    { warn() {}, error() {}, log() {} },
  )
  const modules = localCaptured[0].factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error(`unexpected require: ${id}`)
  })
  modules.apply({
    effect(fn) { try { fn() } catch { /* 忽略 */ } return () => {} },
    slots: { inject(name, fn) { fn() }, register() {} },
    locale: { register() { return () => {} }, bind() { return (k, f) => f ?? k } },
  })
  const exposed = globalThis.__PANEL_TEST__
  assert.ok(exposed, '页面组件应已暴露')

  const state = {
    status: 'ready',
    ping: { memory: { online: true, origin: 'http://127.0.0.1:8766', ms: 3 } },
    health: { ok: true, service: 'dsh-tingxue-memory', port: 8766 },
    config: { hasApiKey: true, config: { modelBackend: 'sta1n', baseURL: '', embeddingModel: '', embeddingDimensions: 3072, llmModel: '' } },
    stats: { memories: 1, entities: 2, relations: 3, trash: 0 },
    panel: { settings: {} },
    archives: [],
    context: {},
  }
  for (const name of ['CompanionPage', 'AgentPage', 'MemoryPage']) {
    const Page = exposed[name]
    assert.equal(typeof Page, 'function', `${name} 必须是组件`)
    const tree = Page({ tr: (k, f) => f ?? k, state })
    assert.ok(tree && typeof tree === 'object', `${name} 必须返回元素`)
  }
})
