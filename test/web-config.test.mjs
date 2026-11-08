// 同源设置接口 `/dsh-tingxue/config` 的最小验证：
// 起一个真的 http 服务器，把 web-proxy 注册的路由处理器挂上去，用真 fetch 打。
//
// 这条接口是设置卡片在本构建（无 settingsScope 服务）下的唯一数据源，
// 所以至少要把「读 → 改 → 再读」「revision 冲突」「ns 归一化」跑通。
import { createServer } from 'node:http'
import { registerTingxueWeb } from '../src/web-proxy.mjs'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok  ', name); pass++ }
  catch (e) { console.log('  FAIL', name, '->', e.message); fail++ }
}
const ta = async (name, fn) => {
  try { await fn(); console.log('  ok  ', name); pass++ }
  catch (e) { console.log('  FAIL', name, '->', e.message); fail++ }
}

// —— 假的 settings 服务：只实现被测路径用到的 describe / update / mutate ——
const state = {
  ns: 'include:dsh-tingxue', // 故意用带前缀的 id，验证 ns 归一化
  value: { recentRounds: 10, llmModel: 'm1' },
  base: { recentRounds: 5, llmModel: 'm0' },
  user: { recentRounds: 10 },
  revision: 3,
}
const calls = []
const settings = {
  describe() {
    return [
      { ns: 'other-plugin', value: {}, revision: 1 },
      { ns: state.ns, value: { ...state.value }, base: { ...state.base }, user: { ...state.user }, revision: state.revision, applies: 'restart' },
    ]
  },
  async update(ns, patch, expected) {
    calls.push({ op: 'update', ns, patch, expected })
    if (expected !== undefined && expected !== state.revision) throw new Error('revision mismatch')
    state.value = { ...state.value, ...patch }
    state.user = { ...state.user, ...patch }
    state.revision += 1
  },
  async mutate(ns, ops, expected) {
    calls.push({ op: 'mutate', ns, ops, expected })
    if (expected !== undefined && expected !== state.revision) throw new Error('revision mismatch')
    for (const op of ops) {
      if (op.op === 'unset') { delete state.value[op.path[0]]; delete state.user[op.path[0]] }
    }
    state.revision += 1
  },
}

// —— 假 webServer：只收集路由，不真监听 ——
const routes = []
const webServer = {
  register(spec) { routes.push(spec); return () => {} },
}

const ctx = {
  logger: { info() {}, warn() {}, debug() {} },
  get(name) {
    if (name === 'webServer') return webServer
    if (name === 'settings') return settings
    return undefined
  },
}

const dispose = registerTingxueWeb(ctx)

t('注册了反代两条 + 设置接口一条', () => {
  const paths = routes.map((r) => r.path)
  if (!paths.includes('/dsh-tingxue/graph')) throw new Error('缺 graph 路由')
  if (!paths.includes('/dsh-tingxue/memory')) throw new Error('缺 memory 路由')
  if (!paths.includes('/dsh-tingxue/config')) throw new Error('缺 config 路由')
})

const configRoute = routes.find((r) => r.path === '/dsh-tingxue/config')
const server = createServer((req, res) => configRoute.handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  const get1 = await (await fetch(base + '/dsh-tingxue/config')).json()
  await ta('GET 返回 value/base/user/revision', async () => {
    if (get1.ok !== true) throw new Error('ok=' + get1.ok + ' ' + get1.error)
    if (get1.value.recentRounds !== 10) throw new Error('value=' + JSON.stringify(get1.value))
    if (get1.base.recentRounds !== 5) throw new Error('base=' + JSON.stringify(get1.base))
    if (get1.revision !== 3) throw new Error('revision=' + get1.revision)
    if (get1.status !== 'ready') throw new Error('status=' + get1.status)
  })

  await ta('PUT 带 revision 写入并回读生效', async () => {
    const res = await fetch(base + '/dsh-tingxue/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { recentRounds: 42 }, expectedRevision: get1.revision }),
    })
    const data = await res.json()
    if (!res.ok || data.ok !== true) throw new Error('status=' + res.status + ' ' + JSON.stringify(data))
    if (data.value.recentRounds !== 42) throw new Error('回读=' + JSON.stringify(data.value))
    if (data.revision !== 4) throw new Error('revision=' + data.revision)
    const last = calls[calls.length - 1]
    if (last.ns !== state.ns) throw new Error('ns 未归一化: ' + last.ns)
    if (last.expected !== 3) throw new Error('expectedRevision=' + last.expected)
  })

  await ta('unset 走 mutate 且字段被移除', async () => {
    const res = await fetch(base + '/dsh-tingxue/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unset: ['recentRounds'] }),
    })
    const data = await res.json()
    if (!res.ok || data.ok !== true) throw new Error('status=' + res.status + ' ' + JSON.stringify(data))
    if ('recentRounds' in data.value) throw new Error('字段仍在: ' + JSON.stringify(data.value))
    const last = calls[calls.length - 1]
    if (last.op !== 'mutate' || last.ops[0].path[0] !== 'recentRounds') throw new Error('ops=' + JSON.stringify(last.ops))
  })

  await ta('revision 冲突返回 409 且带说明', async () => {
    const res = await fetch(base + '/dsh-tingxue/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { recentRounds: 1 }, expectedRevision: 1 }),
    })
    if (res.status !== 409) throw new Error('status=' + res.status)
    const data = await res.json()
    if (data.ok !== false || !/revision/.test(data.error)) throw new Error('body=' + JSON.stringify(data))
  })

  await ta('非法 JSON 返回 400', async () => {
    const res = await fetch(base + '/dsh-tingxue/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    })
    if (res.status !== 400) throw new Error('status=' + res.status)
  })
} finally {
  await new Promise((resolve) => server.close(resolve))
  dispose()
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
