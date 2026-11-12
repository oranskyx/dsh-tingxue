// 反代必须把编辑请求透传给 8765，否则面板里的图谱就是「只读」的。
//
// 2026-11-12 的 bug：handleGraphProxy 只放行 GET/HEAD，其余一律 405
// 「图谱界面只读」。iframe 里看图没问题，一改实体/加关系/删记忆就全挂。
// 这个测试用一个假上游（不需要真的 8765 在跑），断言方法、请求体和
// content-type 都原样到达上游，并且 GET 仍然正常。

import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'

import { apply } from '../src/panel-host.mjs'

/** 假上游：记录每个请求，并把它原样回显。 */
async function startFakeUpstream() {
  const log = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    log.push({ method: req.method, url: req.url, body, contentType: req.headers['content-type'] || null })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, echo: { method: req.method, url: req.url, body } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, log, origin: `http://127.0.0.1:${server.address().port}` }
}

async function startProxy(upstreamOrigin) {
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            registered.push(route)
            return () => {}
          },
        }
      }
      return undefined
    },
    inject() {},
    effect() {
      return () => {}
    },
  }
  apply(ctx, { graphDashboardUrl: upstreamOrigin })

  const route = registered.find((r) => r.path === '/dsh-tingxue-graph')
  assert.ok(route, '没有注册 /dsh-tingxue-graph 路由')

  const server = http.createServer((req, res) => route.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}`, route }
}

test('反代把 POST / PUT / DELETE 连同请求体转发给上游，而不是 405', async () => {
  const upstream = await startFakeUpstream()
  const proxy = await startProxy(upstream.origin)
  try {
    const cases = [
      { method: 'POST', path: '/dsh-tingxue-graph/api/memory/entities', body: '{"name":"测试实体","type":"thing"}' },
      { method: 'PUT', path: '/dsh-tingxue-graph/api/memory/entities/abc', body: '{"summary":"改一下"}' },
      { method: 'DELETE', path: '/dsh-tingxue-graph/api/memory/entities/abc', body: '' },
    ]

    for (const item of cases) {
      const res = await fetch(proxy.base + item.path, {
        method: item.method,
        headers: item.body ? { 'content-type': 'application/json' } : {},
        ...(item.body ? { body: item.body } : {}),
      })
      const text = await res.text()

      assert.notEqual(
        res.status,
        405,
        `${item.method} ${item.path} 被反代挡了（405）：${text.slice(0, 120)}`,
      )
      assert.ok(
        !text.includes('图谱界面只读'),
        `${item.method} 仍然返回「图谱界面只读」，说明方法白名单又收窄了`,
      )
      assert.equal(res.status, 200, `${item.method} 的响应状态应为 200，实际 ${res.status}`)

      const json = JSON.parse(text)
      assert.equal(json.echo.method, item.method, '上游收到的方法不对')
      assert.equal(json.echo.body, item.body, '上游收到的请求体不对（被吞了或变形了）')
      if (item.body) {
        assert.match(String(upstream.log.at(-1).contentType ?? ''), /application\/json/, 'content-type 没透传')
      }
    }
  } finally {
    await new Promise((resolve) => proxy.server.close(resolve))
    await new Promise((resolve) => upstream.server.close(resolve))
  }
})

test('GET 仍然正常透传（别修写把读修坏了）', async () => {
  const upstream = await startFakeUpstream()
  const proxy = await startProxy(upstream.origin)
  try {
    const res = await fetch(proxy.base + '/dsh-tingxue-graph/graph-data.json')
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.echo.method, 'GET')
    assert.equal(upstream.log.at(-1).url, '/graph-data.json', '前缀没被剥掉或地址拼错')
  } finally {
    await new Promise((resolve) => proxy.server.close(resolve))
    await new Promise((resolve) => upstream.server.close(resolve))
  }
})

test('超大请求体被 413 挡住（反代不能变成无上限的写通道）', async () => {
  const upstream = await startFakeUpstream()
  const proxy = await startProxy(upstream.origin)
  try {
    const huge = 'x'.repeat(1024 * 1024 + 1024)
    const res = await fetch(proxy.base + '/dsh-tingxue-graph/api/memory/entities', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: huge,
    })
    assert.equal(res.status, 413, `超大请求体应被 413 拒绝，实际 ${res.status}`)
    assert.equal(upstream.log.length, 0, '超限请求不该到达上游')
  } finally {
    await new Promise((resolve) => proxy.server.close(resolve))
    await new Promise((resolve) => upstream.server.close(resolve))
  }
})
