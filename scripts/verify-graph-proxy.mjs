// 本地验证：panel-host 的 /dsh-tingxue-graph/* 反代能不能把 8765 的界面完整送出来。
import http from 'node:http'
import { apply } from '../src/panel-host.mjs'

const registered = []
const fakeWebServer = {
  register(route) {
    registered.push(route)
    return () => {}
  },
}

const ctx = {
  get(name) {
    if (name === 'webServer') return fakeWebServer
    return undefined
  },
  inject() {},
  effect() { return () => {} },
}

apply(ctx, {})

const graphRoute = registered.find((r) => r.path === '/dsh-tingxue-graph')
const assetRoute = registered.find((r) => r.path === '/dsh-tingxue-ui/assets')
if (!graphRoute) {
  console.error('FAIL: 没有注册 /dsh-tingxue-graph 路由')
  console.error('已注册: ' + registered.map((r) => r.path).join(', '))
  process.exit(1)
}
console.log('路由已注册: ' + graphRoute.path + ' (' + graphRoute.kind + ')')

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/dsh-tingxue-graph')) return graphRoute.handler(req, res)
  if (req.url.startsWith('/dsh-tingxue-ui/assets') && assetRoute) return assetRoute.handler(req, res)
  res.writeHead(404).end('no route')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const checks = [
  { path: '/dsh-tingxue-graph/', expect: 200, type: 'text/html', needle: '记忆图谱' },
  { path: '/dsh-tingxue-graph/app.js', expect: 200, type: 'javascript', needle: null },
  { path: '/dsh-tingxue-graph/styles.css', expect: 200, type: 'css', needle: null },
  { path: '/dsh-tingxue-graph/graph-data.json', expect: 200, type: 'json', needle: '"nodes"' },
  { path: '/dsh-tingxue-graph/api/health', expect: 200, type: 'json', needle: '"ok"' },
  { path: '/dsh-tingxue-ui/assets/graph-engine.js', expect: 200, type: 'javascript', needle: 'TXGraph' },
  { path: '/dsh-tingxue-ui/assets/../panel-host.mjs', expect: 404, type: '', needle: null },
]

let failed = 0
for (const check of checks) {
  const res = await fetch(base + check.path)
  const body = await res.text()
  const type = res.headers.get('content-type') || ''
  const okStatus = res.status === check.expect
  const okType = type.includes(check.type)
  const okNeedle = check.needle ? body.includes(check.needle) : true
  const ok = okStatus && okType && okNeedle
  if (!ok) failed++
  console.log(
    (ok ? 'ok   ' : 'FAIL ') + check.path.padEnd(34) +
    ` status=${res.status} type=${type.split(';')[0]} bytes=${body.length}` +
    (okNeedle ? '' : ` 缺少 ${check.needle}`),
  )
}

server.close()
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
