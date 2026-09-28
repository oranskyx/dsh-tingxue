// dsh-tingxue test/inject.test.mjs
//
// 上下文注入时序回归测试。
//
// 守护的 bug：section.text 是同步的，而 assemble() 在跑 system-prompt/assemble 瀑布
// 之前就把它读走了。若「异步预算 + text 同步返回缓存」，缓存永远滞后一轮：
// 首轮空、之后错位，真机上表现为 system 提示词在 6827 / 13872 字符之间抖动。
//
// 本测试用 DSH 真实顺序复现：先同步读 section.text 拼 assembly，再 await 瀑布。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContextCache, installContextInjection, SECTION_NAME } from '../src/context/inject.mjs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { zstdCompressSync } from 'node:zlib'
import { createServer } from 'node:http'
import { createMemoryStore } from '../src/memory/store.mjs'
import { apply } from '../src/plugin-entry.mjs'

/** selfcheck 脚本路径（F3 用例要真跑它，而不是只调内部函数）。 */
const SELFCHECK = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'selfcheck.mjs')

/** 聊天会话 id（与 config.chatSessionId 一致，插件靠 agent.id 认它）。 */
const CHAT_SESSION = 'session-chat-aaa'

/** 主人的真实发问；也是本 turn 的检索 query。 */
const TURN1_QUERY = '今天想吃什么'

/**
 * turn 中途被塞进 inbox 的通知（turn 145 真机形态）：
 * AgentTeams 派单 / 后台子代理完成通知都长这样。
 */
const MID_TURN_NOTICE = 'Background subagent a75f2cb8-7fc8-4718-b2ab-3ca49c283b1f finished. Result: 全部测试通过。'

/**
 * 下一个 turn 主人的真实消息（形如后台子代理通知文本，用于验证换 turn 后确实重检索）。
 * 它落在「通知话题」那一簇向量上，因此检索结果必须整块换掉。
 */
const TURN2_QUERY = 'Background subagent 3b548399-bf60-4f38-87fa-625580949164 finished.'

/** 「主人的话题」记忆（短文本），向量落在簇 A。 */
const FOOD_MEMORIES = [
  '主人爱吃火锅', '主人喜欢川菜', '主人不吃香菜', '主人爱吃拉面',
  '主人爱吃水果', '主人爱喝咖啡', '主人爱吃烧烤', '主人爱吃甜点',
]

/** 「通知话题」记忆（长文本），向量落在簇 B——两簇文本长度不同，便于长度漂移可测。 */
const NOTICE_MEMORIES = Array.from(
  { length: 8 },
  (_, i) => `后台子代理 subagent-${i}-2d83c4f1 已完成：这是一条用于制造长度差异的长记忆文本 ${i}`,
)

/**
 * 确定性向量映射（桩端点用）：把输入文本映射到两簇之一。
 * 顺序要紧：通知特征先判，否则英文 Background/subagent 会落进默认簇。
 */
function vectorFor(text) {
  const t = String(text)
  if (/通知|子代理|subagent|Background/i.test(t)) return [0, 1, 0]
  if (/[吃菜饭面食]/.test(t)) return [1, 0, 0]
  return [0.5, 0.5, 0]
}

/**
 * 起一个 OpenAI 兼容的最小桩端点，只实现 /v1/embeddings。
 * 返回 embedCalls：每次 embed 收到的输入文本（用于证明「同一 turn 只 embed 一次」）。
 */
async function startStubEndpoint() {
  const embedCalls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (!String(req.url ?? '').includes('/embeddings')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let inputs = []
      try {
        const parsed = JSON.parse(body)
        inputs = Array.isArray(parsed?.input) ? parsed.input : [parsed?.input]
      } catch { inputs = [] }
      for (const t of inputs) embedCalls.push(String(t))
      const data = inputs.map((t, i) => ({ index: i, embedding: vectorFor(t) }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    embedCalls,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

/**
 * 真实 apply() 的替身根 ctx：只记录监听器，服务一律缺席。
 * 这条路径正是插件注释里写的「老宿主优雅降级」：settings/settings 注册与
 * agents 自愈都会静默跳过，但上下文注入链路（本次修复的战场）完整真实。
 */
function makeRootCtx() {
  const handlers = new Map()
  const logs = { warn: [], info: [] }
  const ctx = {
    handlers,
    logs,
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const arr = handlers.get(event) ?? []
        const i = arr.indexOf(handler)
        if (i >= 0) arr.splice(i, 1)
      }
    },
    get() { return undefined },
    // 服务永不就绪：回调不执行 = 老宿主，插件按降级路径继续跑
    inject() { return { dispose() {} } },
    logger: {
      warn: (...a) => logs.warn.push(a.map(String).join(' ')),
      info: (...a) => logs.info.push(a.map(String).join(' ')),
    },
    emit(event, payload) {
      for (const h of [...(handlers.get(event) ?? [])]) {
        try { h(payload) } catch (e) { logs.warn.push(`handler threw: ${e?.message ?? e}`) }
      }
    },
  }
  return ctx
}

/** 等 init() 跑完（ready 之前 buildContextText 返回 null，注入会是空的）。 */
async function waitForInit(root, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (root.logs.info.some((m) => m.includes('初始化完成'))) return
    if (root.logs.warn.some((m) => m.includes('初始化失败'))) {
      throw new Error(`插件 init 失败: ${root.logs.warn.join(' | ')}`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(
    `等待 init 完成超时\ninfo: ${root.logs.info.join(' | ')}\nwarn: ${root.logs.warn.join(' | ')}`,
  )
}

/** Windows 上 rm 常报 ENOTEMPTY/EBUSY；重试以免清理失败掩盖真实断言。 */
async function cleanupDir(dir) {
  for (let i = 0; i < 10; i++) {
    try { await rm(dir, { recursive: true, force: true }); return }
    catch (e) {
      if (!/ENOTEMPTY|EBUSY|EPERM|EACCES/.test(String(e?.code ?? ''))) return
      await new Promise((r) => setTimeout(r, 50 * (i + 1)))
    }
  }
}

/**
 * 按 DSH 真实顺序投递一条用户消息：inserted（进 inbox）→ claimed（preStep 同步 claim）。
 *
 * `source.kind` 必须带上：插件靠它区分「主人的真实输入」与「通知/派单」。
 * 真机契约：`MessageSourceMap.user = { kind: 'user' }`，而 user-approval / subagent-settled
 * 这类通知是 `kind: 'plugin'`（packages/llm/llm/src/message.ts:100-126）。
 */
function deliverTurn(root, agent, text, turn, source = { kind: 'user' }) {
  const message = { content: [{ type: 'text', text }], source }
  root.emit('agent/inbox/inserted', { agent, message })
  root.emit('agent/inbox/claimed', { agent, message, turn })
}

/**
 * 投递一条 **turn 中途** 的消息（next-step），按真机顺序成对发 inserted + claimed。
 *
 * 复核 finding F2 指出：只发 inserted 不发 claimed 会绕过承重分支 —— 真机日志里
 * 有 55 例「step≥1 之后仍发生的 next-step claim」，所以通知照样会走 claim（带**同一个**
 * turn 号）。通知用 `kind: 'plugin'`（真机是 subagent-settled / user-approval）。
 */
function deliverMidTurn(root, agent, text, turn, source = { kind: 'plugin', plugin: 'dsh-notifier' }) {
  const message = { content: [{ type: 'text', text }], source }
  root.emit('agent/inbox/inserted', { agent, message })
  root.emit('agent/inbox/claimed', { agent, message, turn })
}

/**
 * 投递「首批次 = 通知在前、主人原话在后」的完整批次（F1 的真实形态）。
 *
 * DSH 的 claim() 先 splice 全部 next-step、**再**推 next-turn，然后按该顺序逐个
 * emit claimed（packages/core/agent/src/inbox.ts:71-77）。所以当首批次里混着一条
 * next-step 通知时，batch[0] 是**通知**，主人的话排在其后 —— 只认 batch[0] 就会
 * 整轮用通知文本去检索记忆（真机 turn 81/102/123/148 就是这种）。
 */
function deliverBatchNoticeThenHuman(root, agent, noticeText, humanText, turn) {
  deliverMidTurn(root, agent, noticeText, turn)
  deliverTurn(root, agent, humanText, turn, { kind: 'user' })
}

/** 最小 systemPrompt 服务：复刻 assemble() 的真实顺序（同步读 text → await 瀑布）。 */
function makeSystemPrompt() {
  const sections = new Map()
  const listeners = []
  return {
    section(def) {
      if (sections.has(def.name)) throw new Error(`duplicate section: ${def.name}`)
      sections.set(def.name, def)
      return () => sections.delete(def.name)
    },
    on(_event, handler) { listeners.push(handler); return () => listeners.splice(listeners.indexOf(handler), 1) },
    /** 复刻 system-prompt/index.ts:504-541 的顺序 */
    async assemble(context) {
      const assembly = {
        sections: [...sections.values()]
          .sort((a, b) => a.order - b.order)
          // 关键：同步求值，早于任何瀑布
          .map((s) => ({ name: s.name, text: typeof s.text === 'function' ? s.text(context) : s.text })),
        contexts: [],
        tools: [],
        variables: {},
      }
      let out = assembly
      for (const h of listeners) {
        const prev = out
        out = await h(prev, context, async () => prev)
      }
      return out
    },
    render(assembly) {
      return assembly.sections.filter((s) => s.text.length > 0).map((s) => s.text).join('\n\n')
    },
  }
}

/** agent 作用域 ctx：get('systemPrompt') + on() + effect()，够插件用。 */
function makeAgent(id, systemPrompt) {
  let cleanup
  return {
    id,
    ctx: {
      get: (n) => (n === 'systemPrompt' ? systemPrompt : undefined),
      on: (e, h) => systemPrompt.on(e, h),
      effect: (fn) => { cleanup = fn() },
    },
    /** 触发 effect 的 disposer（模拟 agent dispose） */
    dispose: () => cleanup?.(),
  }
}

test('首个装配就带上真值（旧设计在这里只能拿到空串）', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)

  // 模拟「异步检索」：真值只有在 await 之后才存在
  const cache = createContextCache({
    getInput: () => '你好',
    build: async () => {
      await new Promise((r) => setTimeout(r, 5))
      return '【听雪档案】\n你是听雪。'
    },
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  const text = sp.render(await sp.assemble({ agent }))
  assert.ok(text.includes('你是听雪'), `首个装配就该有真值，实际拿到: ${JSON.stringify(text)}`)
})

test('多步回合只检索一次（同一句输入不重复 embed）', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  let builds = 0
  const cache = createContextCache({
    getInput: () => '同一句话',
    build: async () => { builds++; return '块' },
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  await sp.assemble({ agent })
  await sp.assemble({ agent })
  await sp.assemble({ agent })
  assert.equal(builds, 1, `同一句输入应只组装一次，实际 ${builds} 次`)
})

test('预热与瀑布共用同一次检索（不重复 embed）', async () => {
  // 真机形态：用户消息到达时后台预热，随后 agent 循环进瀑布。
  // 两者必须命中同一个 in-flight，否则每条消息白检索两次（0.8s × 2）。
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  let builds = 0
  let resolveBuild
  const cache = createContextCache({
    getInput: () => '你好',
    build: () => { builds++; return new Promise((r) => { resolveBuild = r }) },
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  // 预热（不 await，模拟 inbox/inserted 里的后台调用）
  const warm = cache.get()
  // 紧接着瀑布来取 —— 此时预热还没完成
  const viaWaterfall = sp.assemble({ agent })
  resolveBuild('【听雪档案】')
  const [w, assembly] = await Promise.all([warm, viaWaterfall])

  assert.equal(builds, 1, `预热与瀑布应共用一次检索，实际 ${builds} 次`)
  assert.equal(w, '【听雪档案】')
  assert.ok(sp.render(assembly).includes('【听雪档案】'), '瀑布必须拿到预热的结果')
})

test('先发起的慢检索晚回来，不覆盖后发起的新结果', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  let input = '第一条'
  const slow = { resolve: null }
  let builds = 0
  const cache = createContextCache({
    getInput: () => input,
    build: async () => {
      builds++
      const mine = input
      if (builds === 1) await new Promise((r) => { slow.resolve = r }) // 第一条很慢
      return `块:${mine}`
    },
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  const first = cache.get()          // 慢的，卡住
  input = '第二条'
  cache.invalidate()
  const second = await cache.get()   // 快的，先回来
  assert.equal(second, '块:第二条')

  slow.resolve()                     // 慢的现在才回来
  await first

  // 缓存里必须还是第二条的结果
  const fromCache = await cache.get()
  assert.equal(fromCache, '块:第二条', '慢的旧结果不该覆盖新结果')
})

test('同一轮多 step：输入被配对逻辑清空后，记忆块不该消失', async () => {
  // 真机 bug：assistant/message 每个 step 都会触发，step0 结束时把「待配对输入」
  // 清空；若检索拿的是那个变量，step1 的 currentInput 就成了空串 → 记忆块整块消失。
  // 实测同一轮 system 从 15817 掉到 13872（差 1945 = 记忆块）。
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)

  let turn = '今天想吃什么'   // 「本轮输入」：整轮不变，检索与缓存键用它
  let searches = 0

  const cache = createContextCache({
    getInput: () => turn,
    build: async () => {
      if (!turn) return '【听雪档案】'          // 输入空 → 检索被跳过（bug 形态）
      searches++
      return `【听雪档案】\n【相关记忆】\n- 因为${turn}`
    },
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  // step0：有输入，记忆块在
  const step0 = sp.render(await sp.assemble({ agent }))
  assert.ok(step0.includes('【相关记忆】'), 'step0 该有记忆块')

  // step0 结束：配对逻辑清空「待配对输入」。turnInput 不受影响——
  // 这正是修复点：生产代码里它们是两个变量（plugin-entry.mjs 的 turnInput）。

  // step1：同一轮，记忆块必须还在
  const step1 = sp.render(await sp.assemble({ agent }))
  assert.ok(step1.includes('【相关记忆】'), 'step1 记忆块不该消失')
  assert.equal(step1, step0, '同一轮各 step 的 system 应完全一致')
  assert.equal(searches, 1, `同一轮只该检索一次，实际 ${searches} 次`)
})

test('用户换新消息后重新检索', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  let input = '第一句'
  let builds = 0
  const cache = createContextCache({
    getInput: () => input,
    build: async () => { builds++; return `块:${input}` },
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  assert.ok(sp.render(await sp.assemble({ agent })).includes('第一句'))
  input = '第二句'
  cache.invalidate()
  assert.ok(sp.render(await sp.assemble({ agent })).includes('第二句'))
  assert.equal(builds, 2)
})

test('agent 模式返回 null 时不落缓存（切回聊天后不会一直读到空）', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  let agentMode = true
  const cache = createContextCache({
    getInput: () => '你好',
    build: async () => (agentMode ? null : '人格块'),
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  assert.equal(sp.render(await sp.assemble({ agent })), '', 'agent 模式下不该注入')
  agentMode = false
  assert.ok(sp.render(await sp.assemble({ agent })).includes('人格块'), '切回聊天后必须立刻恢复注入')
})

test('只认自己的装配：别的 agent 的 scope 不注入（防跨会话串线）', async () => {
  const sp = makeSystemPrompt()
  const mine = makeAgent('chat-session', sp)
  const other = makeAgent('unrelated-session', sp)
  const cache = createContextCache({ getInput: () => 'x', build: async () => '听雪私密上下文' })
  installContextInjection({ agent: mine, shouldInject: () => true, ensureText: () => cache.get() })

  assert.ok(sp.render(await sp.assemble({ agent: mine })).includes('听雪'))
  assert.equal(sp.render(await sp.assemble({ agent: other })), '', '无关会话绝不能拿到听雪上下文')
  assert.equal(sp.render(await sp.assemble({})), '', '无 agent 的诊断装配也不该拿到')
})

test('块保持就位（order 位置不被推到末尾）', async () => {
  const sp = makeSystemPrompt()
  sp.section({ name: 'deployment:persona', order: 0, text: '人格' })
  sp.section({ name: 'tool-guidance', order: 150, text: '工具指引' })
  const agent = makeAgent('chat-session', sp)
  const cache = createContextCache({ getInput: () => 'x', build: async () => '听雪块' })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  const assembly = await sp.assemble({ agent })
  const names = assembly.sections.map((s) => s.name)
  assert.deepEqual(names, ['deployment:persona', SECTION_NAME, 'tool-guidance'],
    `听雪块应停在自己 order:100 的位置，实际顺序: ${names.join(' -> ')}`)
})

test('section 占位为空文本：不注入时 system 里不留空块', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  const cache = createContextCache({ getInput: () => 'x', build: async () => '' })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  assert.equal(sp.render(await sp.assemble({ agent })), '', '空上下文应渲染为空，不留残余')
})

test('shouldInject 为假时不挂任何东西（无关会话零开销）', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('other', sp)
  const ok = installContextInjection({
    agent, shouldInject: () => false, ensureText: async () => '不该出现',
  })
  assert.equal(ok, false)
  assert.equal(sp.render(await sp.assemble({ agent })), '')
})

test('组装抛错不致命：退化成只有 DSH 本体', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  const errors = []
  const cache = createContextCache({
    getInput: () => 'x',
    build: async () => { throw new Error('向量服务挂了') },
    warn: (m) => errors.push(m),
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get(), warn: (m) => errors.push(m) })

  assert.equal(sp.render(await sp.assemble({ agent })), '', '检索失败不该炸掉整个请求')
  assert.ok(errors.some((m) => m.includes('向量服务挂了')), `应记录告警，实际: ${errors.join('|')}`)
})

test('重复注入同一个 agent 幂等（两个入口都触发也不炸）', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  const errors = []
  const cache = createContextCache({ getInput: () => 'x', build: async () => '块' })
  const install = () => installContextInjection({
    agent, shouldInject: () => true, ensureText: () => cache.get(), warn: (m) => errors.push(m),
  })

  assert.equal(install(), true)
  // 第二次不该因 section 重名抛错，也不该改变装配结果
  assert.equal(install(), true)
  assert.equal(install(), true)
  assert.deepEqual(errors, [], `不该有告警: ${errors.join('|')}`)

  const assembly = await sp.assemble({ agent })
  assert.equal(assembly.sections.filter((s) => s.name === SECTION_NAME).length, 1, '同名块只该有一个')
  assert.ok(sp.render(assembly).includes('块'))
})

test('disposer 卸载后不再注入', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  const cache = createContextCache({ getInput: () => 'x', build: async () => '块' })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  assert.ok(sp.render(await sp.assemble({ agent })).includes('块'))
  agent.dispose()
  assert.equal(sp.render(await sp.assemble({ agent })), '', '卸载后不该再注入')
})

// ---------------------------------------------------------------------------
// 真机回归：同一 turn 内 system 长度漂移
// ---------------------------------------------------------------------------
// 真机现场（turn 145，读自 ~/.dsh/sessions/.../session.jsonl.zstd）：
//   turn/start → step/start → user/message「Background subagent 3b548399… finished…」
//     → request/header reason=resume sysLen=22177（记忆块提到 c54f…）
//     → assistant/message → step/start
//     → user/message「Background subagent a75f2cb8… finished…」   ← turn 中途插入
//     → request/header reason=change sysLen=22272（记忆块变成 2d83…）
//   同一 turn 出现两个 system 长度：[22177, 22272]
//
// 根因不是「记忆块消失」，而是「记忆块被换成另一次检索的结果」：
// 旧实现在 agent/inbox/inserted 里无条件 `turnInput = text`，而该事件对**每一条**
// 进 inbox 的消息都触发——包括 turn 中途作为 next-step 插进来的 AgentTeams 派单、
// 后台子代理完成通知。通知文本成了新的检索 query，缓存键随之改变 → 重新 embed +
// 重新向量检索 → 同一个 turn 内 system 变了（并且白白多付一次检索）。
//
// 本用例驱动的是**真实 apply()**：真实内存 store（LanceDB）+ 真实 assembleContext +
// 真实监听器接线 + 真实缓存；只有「模型端点」换成确定性桩（不联网、不花钱），
// 以及 DSH 运行时服务（agents/settings/webServer）一律缺席（走插件的老宿主降级路径）。
//
/**
 * 起一个「真实 apply()」的听雪运行实例（真机用例共用）。
 *
 * 真实的部分：真实内存 store（LanceDB）+ 真实 assembleContext + 真实监听器接线 + 真实缓存。
 * 只有「模型端点」换成确定性桩（不联网、不花钱），以及 DSH 运行时服务
 * （agents/settings/webServer）一律缺席 —— 走插件的老宿主降级路径。
 *
 * 记忆库预置两簇：簇 A「主人的话题」（短文本）→ [1,0,0]；簇 B「通知话题」（长文本）→ [0,1,0]。
 * 两簇向量可分、文本长度可辨，于是「用谁检索」既能从记忆内容判定，也能从长度判定。
 */
async function startTingxueHarness() {
  const dir = await mkdtemp(join(tmpdir(), 'tx-inject-'))
  const dataDir = join(dir, 'data')
  const profilePath = join(dir, '听雪档案.txt')
  const notifierStateFile = join(dir, 'notifier-state.json')
  const stub = await startStubEndpoint()

  await mkdir(dataDir, { recursive: true })
  await writeFile(profilePath, '【听雪档案】\n你是听雪，主人的专属助手。\n', 'utf8')
  // dsh-notifier 的绑定：聊天会话。插件 init 靠它确定 chatSessionId。
  await writeFile(notifierStateFile, JSON.stringify({ 'bind:qq:USER': CHAT_SESSION }), 'utf8')

  const seed = await createMemoryStore({ dataDir, dimensions: 3, embeddingModel: 'test' })
  for (const text of FOOD_MEMORIES) {
    await seed.addMemory({ text, vector: vectorFor(text), scene: 'chat', source: 'chat' })
  }
  for (const text of NOTICE_MEMORIES) {
    await seed.addMemory({ text, vector: vectorFor(text), scene: 'chat', source: 'chat' })
  }
  await seed.close()

  // 真实 apply()：桩端点 + 固定维度（免探测，让 embed 计数可预期）
  const root = makeRootCtx()
  apply(root, {
    dataDir,
    profilePath,
    modelBackend: 'local',
    baseURL: stub.baseURL,
    embeddingDimensions: 3,
    embeddingModel: 'stub-embed',
    chatSessionId: CHAT_SESSION,
    notifierStateFile,
    channel: 'qq',
    userId: 'USER',
    // 关掉两条与本次修复无关的重外设（面板/记忆 HTTP 服务），保持用例纯净
    graphDashboardEnable: false,
    memoryServiceEnable: false,
  })
  await waitForInit(root)

  // 聊天会话成为 live agent → 插件挂上上下文注入
  const sp = makeSystemPrompt()
  const agent = makeAgent(CHAT_SESSION, sp)
  root.emit('agent/created', { agent })

  const assembleSystem = async () => {
    // 给「不 await 的后台预热」一点时间落定，让每次装配都可预期
    await new Promise((r) => setTimeout(r, 80))
    return sp.render(await sp.assemble({ agent }))
  }

  return {
    dir, dataDir, stub, root, agent, sp, assembleSystem,
    cleanup: async () => {
      try { stub.close() } catch { /* 忽略 */ }
      try { await cleanupDir(dir) } catch { /* 忽略 */ }
    },
  }
}

// 用例在修复前（HEAD fbfede8）必然失败：第 2 次装配会拿到通知文本的检索结果。
test('真机：同一 turn 内插入通知，不得改写检索 query（system 不得漂移）', { timeout: 120000 }, async () => {
  const h = await startTingxueHarness()
  const { root, agent, stub, assembleSystem } = h

  try {
    // 4) turn 145：主人发问 → inserted（进 inbox）+ claimed（preStep 同步 claim）
    deliverTurn(root, agent, TURN1_QUERY, 145)
    const systemStep1 = await assembleSystem()
    const embedsAfterStep1 = stub.embedCalls.length

    assert.ok(
      systemStep1.includes('主人爱吃火锅'),
      `step1 必须带上「主人的话题」的检索结果，实际: ${JSON.stringify(systemStep1.slice(0, 300))}`,
    )
    assert.ok(
      embedsAfterStep1 >= 1,
      `step1 应已发生至少一次 embed，实际 ${embedsAfterStep1}`,
    )

    // 5) turn 中途：一条通知作为 next-step 插进 inbox（**同一个 turn 号**）。
    //    这正是真机 turn 145 的第二个 step 之前发生的事。
    //    复核 F2：必须**成对**发 inserted + claimed —— 真机通知照样会走 claim
    //    （日志里 55 例「step≥1 之后仍发生的 next-step claim」）。只发 inserted 会绕过
    //    「同 turn 后续 claim 不改写」这条承重早退，用例就成了摆设（删掉保护仍全绿）。
    deliverMidTurn(root, agent, MID_TURN_NOTICE, 145)
    const systemStep2 = await assembleSystem()

    // === 核心断言：同一 turn 内 system 必须恒定 ===
    // 修复前这里会变成「通知话题」的检索结果（长文本簇），长度也随之改变。
    assert.equal(
      systemStep2, systemStep1,
      '同一 turn 内插入通知后 system 变了：检索 query 被 mid-turn 通知改写（长度漂移）\n' +
      `  step1 长度=${systemStep1.length}，含主人话题=${systemStep1.includes('主人爱吃火锅')}\n` +
      `  step2 长度=${systemStep2.length}，含通知话题=${systemStep2.includes('后台子代理')}`,
    )
    // 不是「少注入」换来的「不漂移」：记忆块必须仍在，且注入量没降。
    assert.ok(
      systemStep2.includes('主人爱吃火锅'),
      'step2 的记忆块不该消失（禁止用「少注入」换「不漂移」）',
    )
    assert.ok(
      systemStep2.length >= systemStep1.length,
      `注入量不得下降：step1=${systemStep1.length} → step2=${systemStep2.length}`,
    )
    // 同一 turn 只该检索一次：通知不该触发额外的 embed。
    assert.equal(
      stub.embedCalls.length, embedsAfterStep1,
      `同一 turn 内插入通知不该新增 embed（白付一次检索）\n实际调用: ${JSON.stringify(stub.embedCalls)}`,
    )

    // 6) 下一个 turn（146）：主人的新消息 → 必须重检索，检索结果整块换掉。
    deliverTurn(root, agent, TURN2_QUERY, 146)
    const systemTurn2 = await assembleSystem()

    assert.notEqual(
      systemTurn2, systemStep1,
      '换 turn 后必须按新输入重新检索（锁定只能在本 turn 内生效，不能把输入冻死）',
    )
    assert.ok(
      systemTurn2.includes('后台子代理'),
      `turn 146 的检索该命中「通知话题」那一簇，实际: ${JSON.stringify(systemTurn2.slice(0, 300))}`,
    )
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// F1 回归：首批次「通知在前、主人原话在后」时，检索 query 必须是主人原话
// ---------------------------------------------------------------------------
//
// 为什么这条必须单独存在（复核 finding F1，阻断项）：
// t2 最初把 query 锁到「本 turn **第一条被 claim** 的消息」。但 DSH 的 claim()
// 先 splice 全部 next-step、**再**推 next-turn，然后按该顺序逐个 emit claimed
// （packages/core/agent/src/inbox.ts:71-77）。于是当首批次里混着一条 next-step
// 通知时，batch[0] 是**通知**，主人的原话排在其后、被整轮忽略。
//
// 真机日志的确切顺序（turn 148）：
//   seq=734305 INSERT next-step「Background subagent 3b548399… failed before it finished.」
//   seq=734316 INSERT next-turn 「回家了，尽管跑，啥都别怕」   ← 主人的原话
//   seq=734317 turn/start 148
//   seq=734318 CLAIM  next-step（先）= 通知
//   seq=734319 CLAIM  next-turn（后）= 主人原话
// 复核扫了 92 个有首批次的 turn：batch[0] 是后台子代理通知 5 例、AgentTeams 消息 17 例，
// 其中 **4 个回合有害**（batch[0] 非人类、而主人的原话就在同一批次里）：
//   turn 81 / 102 / 123 / 148 —— 被锁成 query 的是 user-approval / subagent-settled 通知。
//
// ⇒ 只锁 batch[0] 会让整个 turn 用**通知文本**检索记忆：不再漂移，却稳定地检索错东西。
// 本用例断言检索 query 是主人原话（记忆块命中「主人话题」簇），而不是通知文本（「通知话题」簇）。
test('真机 F1：首批次通知在前、主人原话在后 —— 检索 query 必须是主人原话', { timeout: 120000 }, async () => {
  const h = await startTingxueHarness()
  const { root, agent, stub, assembleSystem } = h

  try {
    // 真机 turn 148 的形态：通知先被 claim，主人的原话紧随其后（同一个 turn 号）。
    deliverBatchNoticeThenHuman(root, agent, MID_TURN_NOTICE, TURN1_QUERY, 148)
    const system = await assembleSystem()
    const embeds = [...stub.embedCalls]

    // === 核心断言：检索用的是主人原话，不是通知文本 ===
    // 桩端点收到什么就 embed 什么，所以 embed 的输入文本**就是**检索 query 本身（直接证据，
    // 不是从 system 长度反推）。
    assert.ok(
      embeds.some((t) => t.includes(TURN1_QUERY)),
      `检索 query 必须是主人的原话「${TURN1_QUERY}」；实际 embed 输入: ${JSON.stringify(embeds)}`,
    )
    // 关键：**最后一次** embed 必须是主人原话。检索结果就取自最后一次 embed，
    // 所以这一条直接等价于「整轮是用主人的话检索的」。
    assert.ok(
      embeds[embeds.length - 1]?.includes(TURN1_QUERY),
      `最后一次 embed 必须是主人的原话（结果取自它）；实际 embed 输入: ${JSON.stringify(embeds)}`,
    )
    // 也不该白付一次：整批里只有主人的话该被 embed（通知不该先跑一次再被丢弃）。
    assert.equal(
      embeds.length, 1,
      `首批次只该为「主人的话」embed 一次，实际 ${embeds.length} 次: ${JSON.stringify(embeds)}`,
    )

    // 结果侧交叉确认：记忆块命中「主人话题」簇，而不是「通知话题」簇。
    assert.ok(
      system.includes('主人爱吃火锅'),
      `记忆块该是「主人话题」的检索结果，实际: ${JSON.stringify(system.slice(0, 300))}`,
    )
    assert.ok(
      !system.includes('后台子代理'),
      '不得命中「通知话题」簇 —— 说明整轮是用通知文本检索的',
    )
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// F1 反向：整批没有人类输入时，必须退回 batch[0] 兜底
// ---------------------------------------------------------------------------
//
// 复核建议的语义：本批次有主人输入则锁第一条 kind==='user'；整批无人类输入
// （例如整个 turn 只由通知触发）时退回 batch[0] —— 否则 turnInput 永远是空串，
// 等于用「少注入」换「不漂移」，是明确禁止的。
test('真机 F1 反向：整批没有人类输入时退回 batch[0] 兜底（不得变成空输入）', { timeout: 120000 }, async () => {
  const h = await startTingxueHarness()
  const { root, agent, stub, assembleSystem } = h

  try {
    // 整个 turn 只由一条通知触发（没有 kind==='user' 的消息）。
    deliverMidTurn(root, agent, MID_TURN_NOTICE, 200)
    const system = await assembleSystem()

    // 兜底成立：确实用通知文本检索了（而不是空输入导致零注入）。
    assert.ok(
      stub.embedCalls.some((t) => t.includes('a75f2cb8')),
      `无人类输入时应退回 batch[0] 兜底；实际 embed 输入: ${JSON.stringify(stub.embedCalls)}`,
    )
    assert.ok(
      system.length > 0,
      '兜底路径下不得变成空注入（那会连记忆块一起丢掉）',
    )
    assert.ok(
      system.includes('后台子代理'),
      `兜底检索该命中「通知话题」簇，实际: ${JSON.stringify(system.slice(0, 300))}`,
    )
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// F3：「注入轮内恒定」必须具备判别力，否则不得报 ok
// ---------------------------------------------------------------------------
//
// 漂移判据是「同一轮内 system 长度出现多个值」，而长度来自该轮 headers 的去重。
// 故**只有 headerCount >= 2 的回合才可能观察到轮内漂移**。真机实测窗口内 6 个回合
// 全部 headerCount = 1（turn 148–153）——这时 driftedInScope=0 是「没能力看见」，
// 不是「没问题」。把这种绿灯当成「修复有效」的证据正是复核点名的假绿灯（F3）。
//
// 所以判据必须增列「具备观测能力的回合数」，为 0 时降级为 warn 并写明无判别力。
// 下面三条分别钉住：无判别力必须 warn、有漂移必须 fail、有判别力且干净才报 ok。

/** 造合成会话日志（zstd 帧格式 —— 正是 selfcheck 要解的格式），并返回可直接跑的 dataDir。 */
async function makeSessionHome({ mode }) {
  const home = await mkdtemp(join(tmpdir(), 'tx-f3-'))
  const SESSION = 'session-f3-probe'
  const logDir = join(home, 'sessions', 'f3probe', SESSION)
  await mkdir(logDir, { recursive: true })

  const MEM = '\u3010\u76f8\u5173\u8bb0\u5fc6\u3011'
  const BODY = 'You are an AI agent powered by DeepSeek Harness.\n' + MEM + '\n记忆块内容\n人格块'
  const ev = [
    { seq: 1, type: 'turn/start', time: '2026-09-26T12:00:00.000Z', data: { turn: 900 } },
    { seq: 2, type: 'step/start', time: '2026-09-26T12:00:01.000Z', data: {} },
    { seq: 3, type: 'request/header', time: '2026-09-26T12:00:02.000Z', data: { reason: 'resume', header: { system: BODY, tools: [] } } },
  ]
  if (mode !== 'single') {
    // drift → 第二个 header 长度不同（真漂移）；same → 长度相同（有判别力、干净）
    const second = mode === 'drift' ? BODY + '\n多出来的内容' : BODY
    ev.push({ seq: 4, type: 'step/start', time: '2026-09-26T12:00:03.000Z', data: {} })
    ev.push({ seq: 5, type: 'request/header', time: '2026-09-26T12:00:04.000Z', data: { reason: mode === 'drift' ? 'change' : 'resume', header: { system: second, tools: [] } } })
  }
  await writeFile(
    join(logDir, 'session.jsonl.zstd'),
    zstdCompressSync(Buffer.from(ev.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')),
  )
  const dataDir = join(home, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'state.json'),
    JSON.stringify({ mode: 'chat', chatSessionId: SESSION, recentRounds: [] }), 'utf8')
  return { home, dataDir, cleanup: () => rm(home, { recursive: true, force: true }) }
}

/** 直接跑 selfcheck 脚本进程（--only=injection 把判据隔离出来，不依赖在跑的服务）。 */
function runSelfcheck(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SELFCHECK, ...args], {
      encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000, windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }))
  })
}

test('F3：全是单表头回合 → 「注入轮内恒定」必须降级为 warn 并写明无判别力', async () => {
  const h = await makeSessionHome({ mode: 'single' })
  try {
    const r = await runSelfcheck(['--json', '--only=injection', `--data-dir=${h.dataDir}`], { DSH_HOME: h.home })
    const j = JSON.parse(r.stdout)
    assert.equal(j.injection.observableTurns, 0, '单表头回合不具备观测能力')
    const f = j.findings.find((x) => /注入/.test(x.title))
    assert.equal(f.level, 'warn', `无判别力时必须降级为 warn，实际 ${f.level}（标题：${f.title}）`)
    assert.match(f.title, /无判别力/, '标题必须写明「本次窗口无判别力」')
    assert.match(f.detail, /不能.*作为.*证据/, '必须说清 0 漂移不能当证据')
    assert.ok(
      !j.findings.some((x) => x.level === 'ok' && /注入轮内恒定/.test(x.title)),
      '不得报 ok —— 那正是复核点名的假绿灯',
    )
  } finally { await h.cleanup() }
})

test('F3：有双表头且轮内长度不同 → 仍必须 fail（判别力没被削弱）', async () => {
  const h = await makeSessionHome({ mode: 'drift' })
  try {
    const r = await runSelfcheck(['--json', '--only=injection', `--data-dir=${h.dataDir}`], { DSH_HOME: h.home })
    assert.equal(r.code, 1, `真漂移必须 exit 1，实际 ${r.code}\nstdout=${r.stdout}`)
    const j = JSON.parse(r.stdout)
    assert.equal(j.injection.observableTurns, 1, '双表头回合具备观测能力')
    assert.equal(j.injection.driftedInScope, 1)
    const f = j.findings.find((x) => /注入在同轮内变动/.test(x.title))
    assert.equal(f.level, 'fail')
  } finally { await h.cleanup() }
})

test('F3：有双表头但轮内长度恒定 → 报 ok（有判别力且干净）', async () => {
  const h = await makeSessionHome({ mode: 'same' })
  try {
    const r = await runSelfcheck(['--json', '--only=injection', `--data-dir=${h.dataDir}`], { DSH_HOME: h.home })
    assert.equal(r.code, 0, `有判别力且无漂移应 exit 0，实际 ${r.code}\nstdout=${r.stdout}`)
    const j = JSON.parse(r.stdout)
    assert.equal(j.injection.observableTurns, 1)
    const f = j.findings.find((x) => /注入轮内恒定/.test(x.title))
    assert.equal(f.level, 'ok', `有判别力且干净时报 ok，实际 ${f.level}`)
    assert.match(f.detail, /1\/1 轮/, '细节应给出「具备观测能力的回合数/窗口轮数」')
  } finally { await h.cleanup() }
})
