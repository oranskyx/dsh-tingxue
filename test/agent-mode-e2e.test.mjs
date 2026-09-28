// dsh-tingxue test/agent-mode-e2e.test.mjs
//
// 真机路径全流程（不改真实绑定：全程用临时 state / data 目录）
//
// 驱动的是**真实的** createCommandHandler + createStateManager + setBindingDetailed，
// 只把 ctx.agents / ctx.notifier 换成替身（它们要的是 DSH 运行时，测试环境没有）。
// 这样 /agentstart → /agentstop 的完整状态机、绑定写入、route 清理、记忆归档全部真实执行。

import { createStateManager } from '../src/state/index.mjs'
import { createCommandHandler } from '../src/commands/index.mjs'
import {
  readNotifierState, writeNotifierState, setBindingDetailed, getBinding, WRITE_RETRY_DEFAULTS,
} from '../src/bind/index.mjs'
import { mkdtemp, readFile, rm, open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 写盘退避的**总睡眠时长**（由 src/bind 导出的常量算出，不写死毫秒）。
 *
 * 用途：第 12 组要构造「回绑写盘失败、紧接着清键写盘成功」。两次写的是同一个文件，
 * 靠一个读句柄让 rename 报 EPERM —— 若句柄一直握着，两次都失败（那是 unresolved，
 * 归第 13 组）；要得到 `cleared`，就得在**第一次的退避预算耗尽之后、第二次的预算
 * 耗尽之前**释放句柄。这里把「第一次要多久才耗尽」算出来，避免写死 2550ms 这类
 * 数字——一旦有人调整 WRITE_RETRY_DEFAULTS，释放时机跟着变而不是悄悄失效。
 */
function writeRetryBudgetMs() {
  const { attempts, baseDelayMs, maxDelayMs } = WRITE_RETRY_DEFAULTS
  let total = 0
  for (let i = 0; i < attempts - 1; i++) total += Math.min(baseDelayMs * 2 ** i, maxDelayMs)
  return total
}

test('真机路径：/agentstart → /agentstop 全流程', async () => {
  const KEY = 'bind:qq:USER'
  const results = []
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
  }

  const dir = await mkdtemp(join(tmpdir(), 'tx-e2e-'))
  const dataDir = join(dir, 'data')
  const stateFile = join(dir, 'notifier-state.json')
  await (await import('node:fs/promises')).mkdir(dataDir, { recursive: true })

  // 模拟 dsh-notifier 里已有一个 QQ 绑定 + 别的键（验证键级合并不被抹）
  await (await import('node:fs/promises')).writeFile(stateFile, JSON.stringify({
    [KEY]: 'session-chat-aaa',
    'admin:token-hash': 'keep-me',
    'route:agents': { 'dsh': { quiet: true } },
  }), 'utf8')

  const state = await createStateManager({ dataDir })
  // 真实场景里插件启动时会从 dsh-notifier 当前绑定读出 chatSessionId 并持久化。
  // 不补这一步，/agentstop 就没有回绑目标（真机里由 init() 完成）。
  await state.setChatSessionId('session-chat-aaa')

  // 替身：agents / notifier
  const created = []
  const disposed = []
  let pushed = []
  const agents = {
    async create(opts = {}) {
      const id = `tingxue-agent-test${created.length}-xyz`
      created.push({ id, opts })
      return { id, session: { id }, dispose: async () => { disposed.push(id) } }
    },
  }
  const notifier = {
    // 命令层回执走 notifier.push({ title, content }, { sourceName })
    async push(msg) { pushed.push(msg) },
  }

  const commands = createCommandHandler({
    state, notifier, agents,
    config: {
      agentStartKeyword: '/agentstart',
      agentStopKeyword: '/agentstop',
      profilePath: join(process.cwd(), '听雪档案.txt'),
      dataDir, notifierStateFile: stateFile, channel: 'qq', userId: 'USER',
    },
    logger: { warn: () => {}, info: () => {} },
  })

  console.log('=== 1) isCommand 判定 ===')
  check('/agentstart 是命令', commands.isCommand('/agentstart'))
  check('/agentstop 是命令', commands.isCommand('/agentstop'))
  check('/agentstartx 不是命令', !commands.isCommand('/agentstartx'))
  check('普通文本不是命令', !commands.isCommand('你好'))
  check('带前后空白也算', commands.isCommand('  /agentstart  '))

  console.log('')
  console.log('=== 2) /agentstart 全流程（真实写绑定）===')
  const before = state
  const started = await commands.handle('/agentstart')
  const st1 = state
  const nState1 = await readNotifierState(stateFile)

  check('/agentstart 被消费（返回 true）', started === true)
  check('创建了隔离会话', created.length === 1, created[0]?.id ?? '')
  check('state.mode 变为 agent', st1.mode === 'agent', `mode=${st1.mode}`)
  check('state.agentSessionId 已记录', !!st1.agentSessionId, st1.agentSessionId ?? '')
  check('绑定切到了 agent 会话', nState1[KEY] === st1.agentSessionId, `${nState1[KEY]} vs ${st1.agentSessionId}`)
  check('绑定不是聊天会话了', nState1[KEY] !== 'session-chat-aaa')
  check('键级合并：admin:token-hash 保留', nState1['admin:token-hash'] === 'keep-me')
  check('键级合并：route:agents 的 dsh 条目保留', nState1['route:agents']?.dsh?.quiet === true)
  check('给 agent 会话建了 route', !!nState1['route:agents']?.[st1.agentSessionId], JSON.stringify(nState1['route:agents']?.[st1.agentSessionId]))
  check('推送了切换成功提示', pushed.some(m => /agent|模式/.test(String(m?.content ?? ''))), `${pushed.length} 条: ${String(pushed[0]?.content ?? '').slice(0, 40).replace(/\n/g, ' ')}`)

  console.log('')
  console.log('=== 3) 重复 /agentstart 应幂等（已在该模式）===')
  const pushedBefore = pushed.length
  const again = await commands.handle('/agentstart')
  check('重复执行不报错', again === true)
  check('没有重复创建会话', created.length === 1, `created=${created.length}`)

  console.log('')
  console.log('=== 4) /agentstop 全流程（真实回绑）===')
  const stopped = await commands.handle('/agentstop')
  const st2 = state
  const nState2 = await readNotifierState(stateFile)

  check('/agentstop 被消费', stopped === true)
  check('state.mode 回到 chat', st2.mode === 'chat', `mode=${st2.mode}`)
  check('agentSessionId 已清空', !st2.agentSessionId, String(st2.agentSessionId))
  check('隔离会话被 dispose', disposed.length === 1, disposed.join(','))
  check('绑定回到聊天会话', nState2[KEY] === st2.chatSessionId, `${nState2[KEY]} vs ${st2.chatSessionId}`)
  check('回绑目标不是 agent 前缀', !String(nState2[KEY]).startsWith('tingxue-agent-'))
  check('键级合并仍保留 admin 键', nState2['admin:token-hash'] === 'keep-me')
  check('agent 的 route 被清理', !nState2['route:agents']?.[st1.agentSessionId], JSON.stringify(nState2['route:agents'] ?? {}))
  check('route:agents 的 dsh 条目仍在', nState2['route:agents']?.dsh?.quiet === true)

  console.log('')
  console.log('=== 5) 未进入 agent 模式时 /agentstop 不应乱动 ===')
  const st3before = state
  await commands.handle('/agentstop')
  const st3 = state
  check('仍为 chat 模式', st3.mode === 'chat')
  check('绑定没被改成别的', (await readNotifierState(stateFile))[KEY] === st3before.chatSessionId)

  console.log('')
  console.log('=== 6) 绑定写入失败时不得进入 agent 模式（本次修复的核心保护）===')
  // 把 state 文件变成目录 → 写入必然失败（rename 到目录上稳定报错）
  const badStateFile = join(dir, 'bad-state.json')
  await (await import('node:fs/promises')).mkdir(badStateFile, { recursive: true })
  const state2 = await createStateManager({ dataDir: join(dir, 'data2') })
  const cmds2 = createCommandHandler({
    state: state2, notifier, agents,
    config: {
      agentStartKeyword: '/agentstart', agentStopKeyword: '/agentstop',
      profilePath: join(process.cwd(), '听雪档案.txt'),
      dataDir: join(dir, 'data2'), notifierStateFile: badStateFile, channel: 'qq', userId: 'USER',
    },
    logger: { warn: () => {}, info: () => {} },
  })
  const disposedBefore = disposed.length
  const createdBefore = created.length
  const badRes = await cmds2.handle('/agentstart')
  // dispose 走 setImmediate 延迟（避免在 pre-step 内销毁正在跑的 agent），
  // 要给它一个 tick 才反映到 disposed 数组。
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  const st4 = state2

  check('写绑定失败时仍被消费（有回执）', badRes === true)
  // 顺序已改为「先写绑定，再建会话」（t3 修复）：绑定失败时**根本没建会话**，
  // 因此不需要 dispose，也不可能在磁盘上留下 295 字节的空壳会话。
  // 这比旧断言（回滚已建会话）更强：从源头就不产生垃圾。
  check('失败时未创建隔离会话（不留空壳）', created.length === createdBefore,
    `created ${createdBefore} → ${created.length}`)
  check('失败时不需 dispose（因为压根没建）', disposed.length === disposedBefore,
    `disposed ${disposedBefore} → ${disposed.length}`)
  check('失败时 mode 不得停在 agent（防静默失忆）', st4.mode === 'chat', `mode=${st4.mode}`)
  check('失败时 agentSessionId 不得残留', !st4.agentSessionId, String(st4.agentSessionId))

  console.log('')
  console.log('=== 7) 失败回执必须带真因（本次修复的核心）===')
  const failMsgs = pushed.filter(m => /失败/.test(String(m?.content ?? '')))
  const lastFail = failMsgs[failMsgs.length - 1]
  check('推送了失败回执', !!lastFail, `${failMsgs.length} 条`)
  check(
    '回执带真因（EPERM/具体错误），不是光一句「切换QQ绑定失败」',
    /EPERM|operation not permitted|原因/.test(String(lastFail?.content ?? '')),
    String(lastFail?.content ?? '').slice(0, 100).replace(/\n/g, ' '),
  )

  console.log('')
  console.log('=== 汇总 ===')
  const pass = results.filter(r => r.ok).length
  console.log(`  ${pass}/${results.length} 通过`)

  await rm(dir, { recursive: true, force: true })

  // 汇总：任何一项失败都让 test 变红
  const failed = results.filter(r => !r.ok)
  assert.deepEqual(
    failed.map(f => `${f.name} ${f.detail}`), [],
    `${failed.length}/${results.length} 项失败`,
  )
  assert.ok(results.length >= 30, `用例数异常：${results.length}`)
})

/**
 * t3 回归（写盘之争用 + 顺序缺陷）。
 *
 * 实测背景（真实 state.json ≈ 55–56 KB / 120 键；测量时刻 2026-09-25，`Get-Item` 取长度）：
 *   无争用连写 5 次 5/5 成功、4–9ms（平均 6ms）；但另一进程持读句柄时 rename 抛 EPERM。
 *   **旧预算：6 次退避睡眠合计约 248ms（8+16+32+64+128）**——那是**睡眠之和**，
 *   不是硬边界；**实测失败点约 310–330ms**（含写 tmp / rename / 清理的开销）。
 *   本 test 含多条真实争用窗口（400ms/350ms 各一）+ 多次 12 次重试，单项已约 2.7s，
 *   慢机上会接近默认上限，故显式给 timeout。
 */
test('写盘争用重试预算与「先绑定后建会话」（旧代码会失败）', { timeout: 60000 }, async () => {
  const results = []
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
  }
  const dir = await mkdtemp(join(tmpdir(), 'tx-e2e2-'))
  const writeFile2 = (await import('node:fs/promises')).writeFile
  const open2 = (await import('node:fs/promises')).open
  const mkdir2 = (await import('node:fs/promises')).mkdir
  /** 稳健清理：Windows 上 rm 常报 ENOTEMPTY/EBUSY，重试以免清理失败掩盖真实断言。 */
  const cleanup = async (d) => {
    for (let i = 0; i < 10; i++) {
      try { await rm(d, { recursive: true, force: true }); return }
      catch (e) {
        if (!/ENOTEMPTY|EBUSY|EPERM|EACCES/.test(String(e?.code ?? ''))) throw e
        await new Promise((r) => setTimeout(r, 30 * (i + 1)))
      }
    }
  }
  /** 造一个「别的进程持着读句柄」的时间窗：holdMs 内 rename 必 EPERM。 */
  const withHold = async (file, holdMs, fn) => {
    const h = await open2(file, 'r')
    let released = false
    const release = async () => { if (!released) { released = true; try { await h.close() } catch {} } }
    const t = setTimeout(() => { release() }, holdMs)
    try { return await fn() } finally { clearTimeout(t); await release() }
  }

  console.log('=== 8) 重试预算：旧 6 次/≈248ms 不够，必须可配且更宽 ===')
  const file = join(dir, 'state.json')
  await writeFile2(file, JSON.stringify({ 'bind:qq:U': 'sess-chat' }))
  // 小预算扛不过 400ms 争用（证明争用窗口真实存在）
  const smallErr = await withHold(file, 400, async () => {
    try { await writeNotifierState({ a: 1 }, file, { attempts: 2, baseDelayMs: 10, maxDelayMs: 20 }); return null }
    catch (e) { return e }
  })
  check('小预算（2 次）在 400ms 争用下必须失败', smallErr !== null, String(smallErr?.code ?? ''))
  check('争用错误码是 EPERM', smallErr?.code === 'EPERM', String(smallErr?.code))
  // 宽预算同窗口必须成功
  let bigErr = null
  const t0 = Date.now()
  await withHold(file, 400, async () => {
    try { await writeNotifierState({ b: 2 }, file, { attempts: 12, baseDelayMs: 30, maxDelayMs: 300 }) }
    catch (e) { bigErr = e }
  })
  check('宽预算（12 次）扛过同一 400ms 争用窗口', bigErr === null, `${Date.now() - t0}ms`)
  // 默认预算必须宽于旧的 ≈248ms
  let defErr = null
  const t1 = Date.now()
  await withHold(file, 350, async () => {
    try { await writeNotifierState({ c: 3 }, file) } catch (e) { defErr = e }
  })
  check('默认预算扛过 350ms 争用（旧默认仅 ≈248ms）', defErr === null, `${Date.now() - t1}ms`)

  console.log('')
  console.log('=== 9) 失败必须给可定位诊断（不是光一句失败文案）===')
  const badDir = join(dir, 'bad-state.json')
  await mkdir2(badDir, { recursive: true })
  const diag = await setBindingDetailed('qq', 'U', 'sess-x', badDir)
  check('写盘失败时 ok=false 且回传 Error', diag.ok === false && diag.error instanceof Error)
  check('带回可定位错误码', diag.code === 'EPERM', String(diag.code))
  check('报出尝试次数与耗时', Number.isInteger(diag.attempts) && typeof diag.elapsedMs === 'number',
    `attempts=${diag.attempts} elapsedMs=${diag.elapsedMs}`)
  check('给出处置建议', typeof diag.suggestion === 'string' && /重试|建议|原因/.test(diag.suggestion),
    String(diag.suggestion).slice(0, 60))

  console.log('')
  console.log('=== 10) 绑定失败时不得创建隔离会话（不留空壳）===')
  const data3 = join(dir, 'data3')
  const state3 = await createStateManager({ dataDir: data3 })
  await state3.setChatSessionId('session-chat-aaa')
  const created3 = []
  const pushed3 = []
  const cmds3 = createCommandHandler({
    state: state3,
    notifier: { async push(m) { pushed3.push(String(m?.content ?? '')) } },
    agents: { async create(o) { created3.push(o.sessionId); return { id: o.sessionId, dispose: async () => {} } } },
    config: {
      agentStartKeyword: '/agentstart', agentStopKeyword: '/agentstop',
      profilePath: join(process.cwd(), '听雪档案.txt'),
      dataDir: data3, notifierStateFile: badDir, channel: 'qq', userId: 'U',
    },
    logger: { warn: () => {}, info: () => {} },
  })
  await cmds3.handle('/agentstart')
  check('绑定失败时未创建任何隔离会话', created3.length === 0, `${created3.length} 个`)
  check('绑定失败时保持聊天模式', state3.mode === 'chat', `mode=${state3.mode}`)
  const failText = pushed3.join('\n')
  check('失败回执带真因（EPERM）', /EPERM/.test(failText), failText.replace(/\n/g, ' ').slice(0, 80))
  check('失败回执说明未留空壳', /未创建隔离会话/.test(failText))

  console.log('')
  console.log('=== 11) 绑定成功 → 新建会话（顺序反转后仍落到正确判据）===')
  const okFile = join(dir, 'ok-state.json')
  await writeFile2(okFile, JSON.stringify({ 'bind:qq:U': 'session-chat-aaa', 'admin:token-hash': 'keep' }))
  const data4 = join(dir, 'data4')
  const state4 = await createStateManager({ dataDir: data4 })
  await state4.setChatSessionId('session-chat-aaa')
  const created4 = []
  const cmds4 = createCommandHandler({
    state: state4, notifier: { async push() {} },
    agents: { async create(o) { created4.push(o.sessionId); return { id: o.sessionId, dispose: async () => {} } } },
    config: {
      agentStartKeyword: '/agentstart', agentStopKeyword: '/agentstop',
      profilePath: join(process.cwd(), '听雪档案.txt'),
      dataDir: data4, notifierStateFile: okFile, channel: 'qq', userId: 'U',
    },
    logger: { warn: () => {}, info: () => {} },
  })
  await cmds4.handle('/agentstart')
  const bound4 = await getBinding('qq', 'U', okFile)
  check('绑定成功后 mode=agent', state4.mode === 'agent', `mode=${state4.mode}`)
  check('创建了 1 个隔离会话', created4.length === 1)
  check('QQ 绑定指向隔离会话（agent 模式的唯一判据）',
    bound4 === state4.agentSessionId && String(bound4).startsWith('tingxue-agent-'), String(bound4))
  check('键级合并未抹掉其他键',
    JSON.parse(await readFile(okFile, 'utf-8'))['admin:token-hash'] === 'keep')
  // /agentstop 回到聊天会话
  await cmds4.handle('/agentstop')
  check('/agentstop 后回到聊天模式', state4.mode === 'chat', `mode=${state4.mode}`)
  check('/agentstop 后绑定回到原聊天会话',
    (await getBinding('qq', 'U', okFile)) === 'session-chat-aaa')

  console.log('')
  console.log('=== 12) /agentstop 回绑失败 → 必须清空绑定键（F1：cleared 分支）===')
  // 这是「mode=chat 但绑定仍指着已销毁隔离会话」的唯一防线，此前零覆盖。
  //
  // 【注入手法为什么不沿用「文件 → 同名目录」】
  // 旧手法把 state.json 换成同名目录。实测（本机 Windows）那会让**读取**也失败
  // ——`readNotifierState`（src/bind/index.mjs:50-59）的 catch 回退空对象，
  // 于是 `getBinding` 在 /agentstop **之前**就返回 null：断言 `绑定 !== agentSid`
  // 在被测逻辑跑之前就已恒真，与旧版硬编码 `true` 的空断言等价（批次 1 的 R2-F1）。
  // 实测三态对照：
  //   文件→目录 : setBinding 失败(EPERM)，但 getBinding=null ← 断言恒真（坏）
  //   持读句柄  : setBinding 失败(EPERM)，文件**始终可读** ← 断言真实（用这个）
  //
  // 【为什么能拿到 `cleared` 而不是 `unresolved`】
  // writeExitBinding 里是两次独立写盘：①回绑聊天会话 ②失败后清键。
  // 只握一个读句柄会让①和②都失败 → 那是 unresolved（第 13 组）。
  // 要得到 cleared：必须在①的退避预算耗尽后、②的预算耗尽前释放句柄。
  //
  // 释放时机**不靠猜毫秒**：writeExitBinding 在①失败、发起②之前会 `warn` 一句
  // 「…改为清空绑定键…」。钩住这句日志再释放句柄，就是①②之间那个确定性时点。
  // （按 WRITE_RETRY_DEFAULTS 算出的预算只用作兜底超时，防止 warn 未触发时句柄漏关。）
  const f1File = join(dir, 'f1-state.json')
  await writeFile2(f1File, JSON.stringify({ 'bind:qq:U': 'session-chat-aaa' }))
  const data5 = join(dir, 'data5')
  const state5 = await createStateManager({ dataDir: data5 })
  await state5.setChatSessionId('session-chat-aaa')
  const agents5 = { async create(o) { return { id: o.sessionId, dispose: async () => {} } } }
  const cfg5 = {
    agentStartKeyword: '/agentstart', agentStopKeyword: '/agentstop',
    profilePath: join(process.cwd(), '听雪档案.txt'),
    dataDir: data5, notifierStateFile: f1File, channel: 'qq', userId: 'U',
  }
  const cmds5 = createCommandHandler({
    state: state5, notifier: { async push() {} }, agents: agents5, config: cfg5,
    logger: { warn: () => {}, info: () => {} },
  })
  await cmds5.handle('/agentstart')
  check('F1 前置：已进入 agent 模式', state5.mode === 'agent', `mode=${state5.mode}`)
  const agentSid5 = state5.agentSessionId
  // 关键前置：此刻绑定**确实是**那个隔离会话（不是 null）。
  // 没有这一条，后面「绑定 !== agentSid」就可能是「本来就是 null」的恒真。
  const boundBeforeStop = await getBinding('qq', 'U', f1File)
  check('F1 前置：/agentstop 前绑定是真实的隔离会话 id（非 null）',
    boundBeforeStop === agentSid5 && String(boundBeforeStop).startsWith('tingxue-agent-'),
    `绑定=${JSON.stringify(boundBeforeStop)} agentSid=${agentSid5}`)

  // 注入：持读句柄 → rename 覆盖报 EPERM，但文件始终可读
  let guard5Open = true
  const closeGuard5 = async () => {
    if (guard5Open) { guard5Open = false; try { await guard5.close() } catch {} }
  }
  const guard5 = await open(f1File, 'r')
  // ①→②之间的确定性释放点：writeExitBinding 在回绑失败后、清键之前必 warn 一次
  const f1Warns = []
  // 注意：commands 里的 warn 是 `logger?.warn?.('[dsh-tingxue/commands]', m)`——两个参数，
  // 真因在**第二个**上。只取首个参数会拿到前缀、断言静默失真。
  const warn5 = (...args) => {
    const m = args.map((a) => String(a)).join(' ')
    f1Warns.push(m)
    if (/改为清空绑定键/.test(m)) void closeGuard5()
  }
  // 兜底：万一 warn 文案改了，也保证句柄被释放（按导出的预算算，不写死毫秒）
  const release5 = setTimeout(() => { void closeGuard5() }, writeRetryBudgetMs() + 500)
  const f1Pushed = []
  const f1Infos = []
  // info 打点：`if (exitBinding.cleared) info('退出 agent 模式：回绑失败，已清空绑定键…')`
  // 在 src/commands/index.mjs:244-246，**只在 cleared 分支**执行。它比回执文案更贴近
  // 分支本身（回执是下游读同一字段再渲染），用作 F2 的插桩证据。
  const info5 = (...args) => { f1Infos.push(args.map((a) => String(a)).join(' ')) }
  const cmds5b = createCommandHandler({
    state: state5, notifier: { async push(m) { f1Pushed.push(String(m?.content ?? '')) } },
    agents: agents5, config: cfg5, logger: { warn: warn5, info: info5 },
  })
  try {
    await cmds5b.handle('/agentstop')
  } finally {
    clearTimeout(release5)
    await closeGuard5()
  }
  const f1Text = f1Pushed.join('\n')
  const bindingAfterStop = await getBinding('qq', 'U', f1File)
  check('F1 回绑那次写盘确实失败了（有 warn 真因，不是没触发）',
    f1Warns.some((m) => /写盘失败/.test(m) && /EPERM/.test(m)),
    f1Warns.join(' | ').replace(/\n/g, ' ').slice(0, 160))
  check('F1 绑定被清空（cleared：回绑失败后删键，QQ 不再指向已销毁会话）',
    bindingAfterStop === null, `键值=${JSON.stringify(bindingAfterStop)}`)
  check('F1 回执明说已清空绑定，不能只回一句「已退出 agent 模式」',
    /已清空绑定|既未回绑也没能清空/.test(f1Text) && !/^已退出 agent 模式，回到日常聊天。$/.test(f1Text.trim()),
    f1Text.replace(/\n/g, ' | ').slice(0, 140))
  // 【R2-F1 的真正修复】本组标题声称覆盖 cleared，就必须**真的**走到 cleared；
  // 否则它结构性只能走 UNRESOLVED-compound（旧注入的毛病）。这里断言回执是
  // cleared 文案、且**不得**是 unresolved 文案，把分支钉死。
  check('F1 走的是 cleared 分支而不是 unresolved（回执文案必须自证）',
    /已清空绑定/.test(f1Text) && !/既未回绑也没能清空/.test(f1Text),
    f1Text.replace(/\n/g, ' | ').slice(0, 140))
  // F2 的插桩证据：`if (exitBinding.cleared) info(...)`（src/commands/index.mjs:244-246）
  // 只在 cleared 真分支里跑。它独立于回执渲染，证明本组到达的就是 cleared。
  check('F2 插桩：cleared 专属 info 打点被触达（本组真的进了 cleared 分支）',
    f1Infos.some((m) => /已清空绑定键/.test(m)),
    f1Infos.join(' | ').slice(0, 140) || '（info 未被打点）')
  // 真断言：绑定既不能指向已销毁的隔离会话，也不能停留在「无绑定」以外的错误值上。
  // 这条现在**真的能失败**：把 writeExitBinding 倒退成旧实现（只 warn、不回绑、
  // 不清键）后，绑定会停在 agentSid5 → 本行变红（倒退实验见提交说明）。
  check('F1 绑定不得停留在已销毁的隔离会话',
    bindingAfterStop !== agentSid5,
    `键值=${JSON.stringify(bindingAfterStop)} 原 agentSid=${agentSid5}`)

  console.log('')
  console.log('=== 12b) 回绑失败的成因自证：持读句柄期间写盘确实失败，但文件仍可读 ===')
  // 证明上面的「回绑失败」不是靠把文件读坏伪造出来的——文件全程可读。
  {
    const probeFile = join(dir, 'f1-probe.json')
    await writeFile2(probeFile, JSON.stringify({ 'bind:qq:U': 'session-chat-aaa' }))
    const guardProbe = await open(probeFile, 'r')
    const heldWrite = await setBindingDetailed('qq', 'U', 'tingxue-agent-probe', probeFile, { attempts: 2, baseDelayMs: 5 })
    const stillReadable = await getBinding('qq', 'U', probeFile)
    await guardProbe.close()
    check('12b：持读句柄时写盘确实失败（EPERM），不是靠读坏伪造',
      heldWrite.ok === false && heldWrite.code === 'EPERM',
      `ok=${heldWrite.ok} code=${heldWrite.code}`)
    check('12b：同一时刻文件仍可读（绑定读到真实值，不是 null）',
      stillReadable === 'session-chat-aaa', `读到=${JSON.stringify(stillReadable)}`)
    const afterRelease = await setBindingDetailed('qq', 'U', 'tingxue-agent-probe2', probeFile, { attempts: 2, baseDelayMs: 5 })
    check('12b：释放句柄后写盘恢复正常（证明失败只由句柄引起）',
      afterRelease.ok === true, `ok=${afterRelease.ok}`)
  }

  console.log('')
  console.log('=== 13) /agentstop：回绑与清空双双失败 → 必须报 unresolved（F1 的 unresolved 分支）===')
  // 覆盖目标：writeExitBinding 的 `unresolved` 分支（回绑失败 **且** 清空也失败）。
  // writeExitBinding 只在 /agentstop 路径上运行，所以本组必须真的走 /agentstop。
  // 构造方式：
  //   ① 先在**可写**路径上正常 /agentstart 进入 agent 模式（前置断言 mode=agent）；
  //   ② 把 chatSessionId 清掉 → handleStop 会走「无可信聊天会话可回绑」那条分支
  //      （原语意：回绑目标不存在 = 回绑失败）；
  //   ③ 把 notifierStateFile 换成同名目录 → 清键的写盘也稳定失败（EPERM）。
  // 于是「回绑失败 + 清空失败」两条同时成立 → unresolved。
  const f1cFile = join(dir, 'f1c-state.json')
  await writeFile2(f1cFile, JSON.stringify({ 'bind:qq:U': 'session-chat-aaa' }))
  const data6 = join(dir, 'data6')
  const state6 = await createStateManager({ dataDir: data6 })
  await state6.setChatSessionId('session-chat-aaa')
  const cfg6 = {
    agentStartKeyword: '/agentstart', agentStopKeyword: '/agentstop',
    profilePath: join(process.cwd(), '听雪档案.txt'),
    dataDir: data6, notifierStateFile: f1cFile, channel: 'qq', userId: 'U',
  }
  const agents6 = { async create(o) { return { id: o.sessionId, dispose: async () => {} } } }
  const cmds6 = createCommandHandler({
    state: state6, notifier: { async push() {} }, agents: agents6, config: cfg6,
    logger: { warn: () => {}, info: () => {} },
  })
  await cmds6.handle('/agentstart')
  check('第13组前置：已进入 agent 模式', state6.mode === 'agent', `mode=${state6.mode}`)
  // ② 清掉 chatSessionId（回绑目标不存在）
  await state6.setChatSessionId(null)
  // ③ 写盘目标变目录（清键也失败）
  await rm(f1cFile, { force: true })
  await mkdir2(f1cFile, { recursive: true })
  const f1cPushed = []
  const cmds6b = createCommandHandler({
    state: state6, notifier: { async push(m) { f1cPushed.push(String(m?.content ?? '')) } },
    agents: agents6, config: cfg6, logger: { warn: () => {}, info: () => {} },
  })
  await cmds6b.handle('/agentstop')
  const f1cText = f1cPushed.join('\n')
  check('第13组 mode 回到 chat', state6.mode === 'chat', `mode=${state6.mode}`)
  check('第13组：回执出现 unresolved 文案「既未回绑也没能清空」',
    /既未回绑也没能清空/.test(f1cText),
    f1cText.replace(/\n/g, ' | ').slice(0, 160))
  check('第13组：回执不得只是「已退出 agent 模式，回到日常聊天。」',
    !/^已退出 agent 模式，回到日常聊天。$/.test(f1cText.trim()),
    f1cText.replace(/\n/g, ' | ').slice(0, 160))

  console.log('')
  console.log('=== 14) 绑定成功但 agents.create 失败 → 绑定回滚到原值（F2）===')
  const f2File = join(dir, 'f2-state.json')
  await writeFile2(f2File, JSON.stringify({ 'bind:qq:U': 'session-chat-aaa' }))
  const data7 = join(dir, 'data7')
  const state7 = await createStateManager({ dataDir: data7 })
  await state7.setChatSessionId('session-chat-aaa')
  const f2Pushed = []
  const cmds7 = createCommandHandler({
    state: state7, notifier: { async push(m) { f2Pushed.push(String(m?.content ?? '')) } },
    agents: { async create() { throw new Error('模拟 agents.create 失败') } },
    config: {
      agentStartKeyword: '/agentstart', agentStopKeyword: '/agentstop',
      profilePath: join(process.cwd(), '听雪档案.txt'),
      dataDir: data7, notifierStateFile: f2File, channel: 'qq', userId: 'U',
    },
    logger: { warn: () => {}, info: () => {} },
  })
  await cmds7.handle('/agentstart')
  const f2Text = f2Pushed.join('\n')
  check('F2 回执说明是「创建隔离会话失败」', /创建隔离会话失败/.test(f2Text),
    f2Text.replace(/\n/g, ' | ').slice(0, 140))
  check('F2 绑定回到原值（原本有值 → restored）',
    (await getBinding('qq', 'U', f2File)) === 'session-chat-aaa',
    `键值=${JSON.stringify(await getBinding('qq', 'U', f2File))}`)
  check('F2 mode 保持 chat', state7.mode === 'chat', `mode=${state7.mode}`)
  check('F2 回执据实说「回滚到原聊天会话」', /回滚到原聊天会话/.test(f2Text))

  console.log('')
  console.log('=== 15) 原本无绑定 + create 失败 → 键不存在，且不谎称「回滚到原聊天会话」（F2）===')
  const f2bFile = join(dir, 'f2b-state.json')
  await writeFile2(f2bFile, JSON.stringify({ 'admin:token-hash': 'keep' })) // 刻意无 bind 键
  const data8 = join(dir, 'data8')
  const state8 = await createStateManager({ dataDir: data8 })
  await state8.setChatSessionId('session-chat-aaa')
  const f2bPushed = []
  const cmds8 = createCommandHandler({
    state: state8, notifier: { async push(m) { f2bPushed.push(String(m?.content ?? '')) } },
    agents: { async create() { throw new Error('模拟 agents.create 失败') } },
    config: {
      agentStartKeyword: '/agentstart', agentStopKeyword: '/agentstop',
      profilePath: join(process.cwd(), '听雪档案.txt'),
      dataDir: data8, notifierStateFile: f2bFile, channel: 'qq', userId: 'U',
    },
    logger: { warn: () => {}, info: () => {} },
  })
  await cmds8.handle('/agentstart')
  const f2bText = f2bPushed.join('\n')
  check('F2b 原本无绑定时键不存在（cleared，不是 restored）',
    (await getBinding('qq', 'U', f2bFile)) === null)
  check('F2b 键级合并未抹掉其他键',
    JSON.parse(await readFile(f2bFile, 'utf-8'))['admin:token-hash'] === 'keep')
  check('F2b 不得谎称「回滚到原聊天会话」', !/回滚到原聊天会话/.test(f2bText),
    f2bText.replace(/\n/g, ' | ').slice(0, 140))
  check('F2b 据实说明原本没有绑定', /原本没有绑定/.test(f2bText),
    f2bText.replace(/\n/g, ' | ').slice(0, 140))

  console.log('')
  console.log('=== 16) 退出回执只反映本次退出：上一次的失败结果不得泄漏进下一次（F4）===')
  // 覆盖目标：`handleStop()` 的返回值契约 —— 本次回执结果只经由返回值流动，
  //           **不再**放模块级共享变量（`src/commands/index.mjs`，见那里的注释）。
  // 为什么必须这样：回执是**每次退出**的独立结论。若把结果放共享变量，上一次退出留下的
  // 非 ok 结果会跨调用残留，被下一次「其实成功了」的退出误读成 unresolved/cleared
  // —— 主人会收到一句假警报（或反过来漏报）。
  //
  // 【本组的可证伪性（MUT 证据）】历史上这里曾断言「handleStop 开头那行 `exitBinding = null`
  // 复位」。但实测删掉那行后本组仍绿——因为紧随其后的赋值是无条件的、且先于任何读取，
  // 那行复位是**不可达的死代码**，断言恒真。现已改为断言真正的性质，并实测如下：
  //   MUT-G（把结果改回模块级共享变量 + 缓存式赋值，即修复前的旧形态）→ 本组**变红**，
  //        报「回执必须是干净成功文案」实际得到上一次的 unresolved 文案（2/45 失败）。
  // 构造：① 先制造一次真·失败的退出（无 chatSessionId + 清键也失败 → unresolved）；
  //       ② 恢复可写、重新进入 agent 模式、正常退出 → 回执必须是**干净的成功文案**。
  const f4File = join(dir, 'f4-state.json')
  const data9 = join(dir, 'data9')
  const mkF4Writable = async () => {
    await rm(f4File, { recursive: true, force: true })
    await writeFile2(f4File, JSON.stringify({ 'bind:qq:U': 'session-chat-aaa' }))
  }
  await mkF4Writable()
  const state9 = await createStateManager({ dataDir: data9 })
  await state9.setChatSessionId('session-chat-aaa')
  const cfg9 = {
    agentStartKeyword: '/agentstart', agentStopKeyword: '/agentstop',
    profilePath: join(process.cwd(), '听雪档案.txt'),
    dataDir: data9, notifierStateFile: f4File, channel: 'qq', userId: 'U',
  }
  const agents9 = { async create(o) { return { id: o.sessionId, dispose: async () => {} } } }
  const f4Pushed = []
  const cmds9 = createCommandHandler({
    state: state9, notifier: { async push(m) { f4Pushed.push(String(m?.content ?? '')) } },
    agents: agents9, config: cfg9, logger: { warn: () => {}, info: () => {} },
  })
  await cmds9.handle('/agentstart')
  // ① 制造非 ok 退出：回绑目标不存在 + 写盘目标变目录 → unresolved
  await state9.setChatSessionId(null)
  await rm(f4File, { force: true })
  await mkdir2(f4File, { recursive: true })
  await cmds9.handle('/agentstop')
  const firstFailText = f4Pushed.join('\n')
  check('F4 前置：第一次退出确实是失败态（unresolved 文案）',
    /既未回绑也没能清空/.test(firstFailText),
    firstFailText.replace(/\n/g, ' | ').slice(0, 120))
  // ② 恢复正常，重新进入 agent 模式并正常退出
  f4Pushed.length = 0
  await mkF4Writable()
  await state9.setChatSessionId('session-chat-aaa')
  await cmds9.handle('/agentstart')
  check('F4 第二段前置：重新进入 agent 模式', state9.mode === 'agent', `mode=${state9.mode}`)
  f4Pushed.length = 0 // 只取第二次 /agentstop 的回执
  await cmds9.handle('/agentstop')
  const secondText = f4Pushed.join('\n').trim()
  // 关键断言：第二次是成功退出，回执必须是干净文案。
  // 可证伪性：把结果改回模块级共享变量 + 缓存式赋值（MUT-G，即修复前的旧形态）后，
  // 第一次的 unresolved 文案会残留 → 本行变红。实测 MUT-G 下本行确实失败。
  check('F4 第二次正常退出的回执必须是干净成功文案（不得复用上一次的失败结果）',
    secondText === '已退出 agent 模式，回到日常聊天。',
    `回执=${JSON.stringify(secondText).slice(0, 160)}`)
  check('F4 第二次回执不得出现上一次的 unresolved/cleared 字样',
    !/既未回绑也没能清空/.test(secondText) && !/已清空绑定/.test(secondText),
    secondText.replace(/\n/g, ' | ').slice(0, 160))

  console.log('')
  console.log('=== 汇总 ===')
  const pass = results.filter(r => r.ok).length
  console.log(`  ${pass}/${results.length} 通过`)
  await cleanup(dir)
  const failed = results.filter(r => !r.ok)
  assert.deepEqual(failed.map(f => `${f.name} ${f.detail}`), [], `${failed.length}/${results.length} 项失败`)
})
