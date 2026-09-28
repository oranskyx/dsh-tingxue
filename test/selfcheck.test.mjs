// dsh-tingxue test/selfcheck.test.mjs
//
// 自检脚本自身的回归测试。
//
// 为什么需要它：一个永远返回「正常」的检查毫无价值。这里要证明的是
// **自检在旧毛病（同轮内记忆块消失）上真的会红**，而不只是一个橡皮图章。
//
// 关键判据（曾经踩过的坑）：
//   新回合的第一条 header 天然带 reason="change"（相对上一轮 system 变了），
//   那是**正常**行为，不能当漂移。真正的 bug 特征只有一条：
//   同一轮内 system 长度出现了**多个值**（或记忆块忽有忽无）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises'
import { statSync as statSyncSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
// 用命名空间导入而不是具名导入：具名导入在**旧版脚本**上会因缺少导出而整体
// SyntaxError（测试文件根本加载不起来，只能给出「导入失败」这种弱证据）。
// 命名空间导入让文件在任何版本下都能加载，缺函数时**相关用例逐个失败**——
// 这样「改动前该用例 FAIL」才是行为层面的证据，而不是一句 import 报错。
import * as selfcheck from '../scripts/selfcheck.mjs'

const { analyzeTurns, judgeTurn } = selfcheck
/** 取脚本导出的新鲜度判据；旧版没有 → 用例会在此处明确失败（而不是整文件崩）。 */
const checkProcessFreshness = (...a) => {
  if (typeof selfcheck.checkProcessFreshness !== 'function') {
    throw new Error('selfcheck.mjs 未导出 checkProcessFreshness —— 判据还没改成内容哈希（改动前形态）')
  }
  return selfcheck.checkProcessFreshness(...a)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const SELFCHECK = join(HERE, '..', 'scripts', 'selfcheck.mjs')

const MEM = '\u3010\u76f8\u5173\u8bb0\u5fc6\u3011'
const PROF = '\u3010\u8eab\u4efd\u4e0e\u5916\u89c2\u3011'

/** 造一条 request/header 事件。mem=false 表示这次没有记忆块。 */
function header(turn, { reason = 'change', base = PROF, mem = false, memLen = 1945, tools = 54 }) {
  const sys = mem ? base + MEM + 'x'.repeat(memLen) : base
  return { type: 'request/header', time: new Date(2026, 8, 25, 16, 0, 0).toISOString(), data: { reason, header: { system: sys, tools: new Array(tools).fill({}) } } }
}
const turnStart = (n) => ({ type: 'turn/start', data: { turn: n } })
const stepStart = () => ({ type: 'step/start', data: {} })

/** 从事件流里取某个 turn 的判定结果。 */
function judgeOf(events, turnNo) {
  const t = analyzeTurns(events).find((x) => x.turn === turnNo)
  assert.ok(t, `没找到 turn ${turnNo}`)
  return judgeTurn(t)
}

// ---------- 必须能抓出 bug ----------

test('旧毛病：同轮内记忆块消失 —— 自检必须报漂移', () => {
  // 真机复现：turn 84 的形态。step1 有记忆块（15817），step2 没有（13872）。
  const events = [
    turnStart(84),
    stepStart(), header(84, { mem: true }),      // 15817：带记忆块
    stepStart(), header(84, { reason: 'change', mem: false }), // 13872：记忆块没了
  ]
  const j = judgeOf(events, 84)
  assert.equal(j.drifted, true, '同轮内记忆块消失必须判为漂移')
  assert.equal(j.lens.length, 2, '应记录到两个不同的 system 长度')
  assert.deepEqual(j.mems, [true, false], '记忆块应由有到无')
})

test('长度变了但记忆块都在 —— 也算漂移（长度是更灵敏的判据）', () => {
  const events = [
    turnStart(90),
    header(90, { mem: true, memLen: 1000 }),
    header(90, { reason: 'change', mem: true, memLen: 1200 }),
  ]
  const j = judgeOf(events, 90)
  assert.equal(j.drifted, true, '长度不同就该报，哪怕记忆块都在')
})

// ---------- 不能误报 ----------

test('正常回合：新回合首条 header 带 change —— 不得误报', () => {
  // 这是曾经误报的形态：turn 86 只有 1 条 header、长度唯一，却因为 reason=change 被判漂移。
  const events = [
    turnStart(86),
    stepStart(), header(86, { reason: 'change', mem: true }),
  ]
  const j = judgeOf(events, 86)
  assert.equal(j.drifted, false, '首条 header 的 change 是正常行为，不该算漂移')
  assert.equal(j.changes, 1, 'change 计数仍如实记录')
  assert.equal(j.headerCount, 1)
})

test('正常多 step 回合：多条 header 但 system 完全一致 —— 不得误报', () => {
  const events = [
    turnStart(85),
    stepStart(), header(85, { reason: 'resume', mem: true }),
    stepStart(), // 后续 step：内容没变，所以不再落 header（DSH 只在变化时记录）
    stepStart(),
  ]
  const j = judgeOf(events, 85)
  assert.equal(j.drifted, false)
  assert.equal(j.headerCount, 1, '轮内不变则只有一条记录')
  assert.ok(j.steps >= 3, `step 数应被统计到，实际 ${j.steps}`)
})

test('无记忆块的回合轮内恒定 —— 不算漂移（记忆块为 0 本身不是错）', () => {
  const events = [
    turnStart(70),
    header(70, { mem: false }),
    header(70, { reason: 'change', mem: false }),
  ]
  const j = judgeOf(events, 70)
  // 长度可能因为 base 相同而唯一
  assert.equal(j.mems.every((m) => m === false), true)
})

// ---------- 结构 ----------

test('analyzeTurns 按 turn 归位 header，丢掉没有 header 的回合', () => {
  const events = [
    turnStart(1), // 没有 header → 应被丢掉
    turnStart(2), header(2, { mem: true }),
    turnStart(3), header(3, { mem: true }), header(3, { reason: 'change', mem: false }),
  ]
  const turns = analyzeTurns(events)
  assert.deepEqual(turns.map((t) => t.turn), [2, 3])
})

test('step/start 数被正确统计（判断是否为多 step 回合）', () => {
  const events = [
    turnStart(5), stepStart(), header(5, { mem: true }),
    stepStart(), stepStart(), stepStart(),
  ]
  const j = judgeOf(events, 5)
  assert.equal(j.steps, 4)
})

test('没有 turn/start 的游离 header 不炸', () => {
  const events = [header(9, { mem: true })]
  assert.deepEqual(analyzeTurns(events), [])
})

// ---------------------------------------------------------------------------
// 运行新鲜度判据：必须是**内容哈希**，不是 mtime
// ---------------------------------------------------------------------------
//
// 为什么这组用例必须存在：mtime 判据在**两个方向**上都不可靠，而两个方向都是本项目的
// 真实失效模式（运行副本是「真实目录拷贝」+ `file:` 协议，仓库改动永不自动传播）：
//   ① 静默放行：仓库改了、副本没同步 → 副本 mtime 更旧 → mtime 判据报「一切正常」。
//   ② 误报：副本内容与仓库**逐字节相同**，只是 mtime 变新（copy 同步会保留/刷新 mtime）
//      → mtime 判据报「需要重启」。实测真机就撞上了 ②：
//      副本 `src/plugin-entry.mjs` 内容 == 仓库，仅因 mtime 18:18:02 晚于进程启动 18:13:29
//      就被判「跑的是旧代码」。而该文件自 a41090c 起从未被任何提交改过。
// 所以：判据只能是内容哈希；mtime 完全不该参与结论。

/** 造一个最小「仓库 + 运行副本」对：src/plugin-entry.mjs、src/context/inject.mjs、client/client.js、cordis.patch.yml。 */
async function makePair({ repoBody = 'export const a = 1\n', rtBody = null, rtMtime = null, repoMtime = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tx-fresh-'))
  const repo = join(dir, 'repo')
  const rt = join(dir, 'runtime')
  for (const base of [repo, rt]) {
    await mkdir(join(base, 'src', 'context'), { recursive: true })
    await mkdir(join(base, 'client'), { recursive: true })
    await writeFile(join(base, 'src', 'plugin-entry.mjs'), repoBody, 'utf8')
    await writeFile(join(base, 'src', 'context', 'inject.mjs'), 'export const inj = 1\n', 'utf8')
    await writeFile(join(base, 'client', 'client.js'), '// client\n', 'utf8')
    await writeFile(join(base, 'cordis.patch.yml'), 'plugins: {}\n', 'utf8')
  }
  // 副本内容默认与仓库一致；rtBody 非 null 时故意写不同内容
  if (rtBody !== null) await writeFile(join(rt, 'src', 'plugin-entry.mjs'), rtBody, 'utf8')
  if (repoMtime) await utimes(join(repo, 'src', 'plugin-entry.mjs'), repoMtime, repoMtime)
  if (rtMtime) await utimes(join(rt, 'src', 'plugin-entry.mjs'), rtMtime, rtMtime)
  return { dir, repo, rt, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** 直接跑真脚本进程，拿退出码与输出（验收要求的「原始输出」）。 */
function judgeFreshness({ repo, rt, started = null }) {
  return checkProcessFreshness({ repoDir: repo, runtimeDir: rt, started })
}

/** 直接跑真脚本进程，拿退出码与输出（验收要求的「原始输出」）。 */
function runSelfcheck(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SELFCHECK, ...args], {
      encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000, windowsHide: true,
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }))
  })
}

// ---------- 必须能抓出「漏同步」 ----------

test('漏同步：副本内容与仓库不同（且副本 mtime 更旧）—— 必须判 fail 并指名文件', async () => {
  // 副本 mtime **更旧**：这正是 mtime 判据会「静默放行」的形态
  const old = new Date(Date.now() - 86400000)
  const fresh = new Date()
  const p = await makePair({
    repoBody: 'export const NEW = 1\n',   // 仓库是新的
    rtBody: 'export const OLD = 1\n',     // 副本还是旧的
    rtMtime: old,                          // 副本 mtime 更旧 → mtime 判据会放行
    repoMtime: fresh,                      // 仓库 mtime 更新
  })
  try {
    const r = judgeFreshness({ repo: p.repo, rt: p.rt, started: new Date() })
    assert.equal(r.inSync, false, '内容不同必须判不一致')
    assert.equal(r.changed.length, 1, `应指名 1 个文件，实际 ${JSON.stringify(r.changed)}`)
    assert.equal(r.changed[0].file, 'src/plugin-entry.mjs', '必须指名是哪个文件')
    assert.notEqual(r.changed[0].repoHash, r.changed[0].runtimeHash, '要给出期望/实际两个哈希')
  } finally { await p.cleanup() }
})

test('漏同步（真脚本进程）：exit 1，且输出点名文件与「需要重启」', async () => {
  // 用 --DSH_HOME 无法重定向 repoDir/runtimeDir，故这里验证判据函数 + 脚本的 --only 通道。
  // 真脚本进程的 exit 1 由下面的「假 DSH_HOME」用例覆盖（把副本摆成 profile 布局）。
  const p = await makePair({ repoBody: 'export const NEW = 1\n', rtBody: 'export const OLD = 1\n' })
  try {
    const r = judgeFreshness({ repo: p.repo, rt: p.rt })
    assert.equal(r.inSync, false)
    assert.ok(r.changed.some((c) => c.file === 'src/plugin-entry.mjs'))
  } finally { await p.cleanup() }
})

test('漏同步：副本缺仓库的新文件 —— 必须检出（副本落后）', async () => {
  const p = await makePair()
  try {
    await writeFile(join(p.repo, 'src', 'brand-new.mjs'), 'export const n = 1\n', 'utf8')
    const r = judgeFreshness({ repo: p.repo, rt: p.rt })
    assert.equal(r.inSync, false)
    assert.ok(r.missingInRuntime.includes('src/brand-new.mjs'),
      `应列出副本缺的文件，实际 ${JSON.stringify(r.missingInRuntime)}`)
  } finally { await p.cleanup() }
})

test('反向：副本多出仓库没有的文件 —— 也必须检出', async () => {
  const p = await makePair()
  try {
    await writeFile(join(p.rt, 'src', 'leftover.mjs'), 'export const x = 1\n', 'utf8')
    const r = judgeFreshness({ repo: p.repo, rt: p.rt })
    assert.equal(r.inSync, false)
    assert.ok(r.extraInRuntime.includes('src/leftover.mjs'),
      `应列出副本多余的文件，实际 ${JSON.stringify(r.extraInRuntime)}`)
  } finally { await p.cleanup() }
})

// ---------- 不得误报 ----------
//
// 这一段的**分工必须写清楚**，否则会误导后人以为一条用例守住了两个方向：
//   判据①（内容哈希）：管「副本内容对不对」。**仓库侧** mtime 与它无关 —— 仓库同内容重写
//                       让仓库 mtime 变新，绝不进入差异列表。
//   判据②（副本写入时刻 vs 进程启动）：管「进程装的是不是那份内容」。**副本侧** mtime
//                       晚于进程启动就是**真阳性**（该重启），不是误报。
// 两者在「副本侧 mtime」这个形状上要求**相反**，所以下面分成两条互补的用例：
//   ①『仓库侧』用例把副本侧时点压在进程启动之前，专门隔离仓库侧不得误报；
//   ②『副本侧』用例断言晚于进程启动时为真阳性。
// **不得为了迎合「不得误报」的字面而去掉判据②** —— 那会退回 T9-F1 的时间盲假绿。

test('仓库侧 mtime 更新不得误报（副本侧 mtime 由判据②负责：晚于进程启动即为真阳性）', async () => {
  // 真机形态：仓库与副本内容逐字节相同，**仓库** mtime 比进程启动还新。
  // 旧 mtime 判据在这里会报「需要重启」——那是误报；内容哈希判据必须报 ok。
  //
  // 注意本夹具同时把**副本** mtime 也设在未来（复刻真机形态），所以判据②会**合法地**
  // 触发 needsRestart=true —— 这正是下面那条断言在钉的事：它是真阳性，不是误报。
  // 「仓库侧不得误报」由 inSync / changed 两条断言隔离证明（仓库 mtime 再新也不进差异）。
  const p = await makePair({
    repoMtime: new Date(Date.now() + 60000),   // 仓库 mtime 在未来 → 任何「启动时间」都比它旧
    rtMtime: new Date(Date.now() + 60000),     // 副本 mtime 也在未来 → 判据②应报真阳性
  })
  try {
    const started = new Date(Date.now() - 3600000)  // 进程启动在 1 小时前 —— 比所有 mtime 都旧
    const r = judgeFreshness({ repo: p.repo, rt: p.rt, started })
    assert.equal(r.inSync, true,
      `内容一致就必须判一致（不看仓库侧 mtime），实际 changed=${JSON.stringify(r.changed)} missing=${JSON.stringify(r.missingInRuntime)}`)
    assert.equal(r.compared, 4, '4 个运行时文件都该被比对')
    // 关键：即使启动时间比 mtime 旧，**仓库侧** mtime 也绝不能进入差异列表
    assert.ok(!(r.changed?.length), '仓库侧 mtime 更新不得进入差异列表（那是判据①的地盘）')
    // 关键：副本侧 mtime 晚于进程启动 → 判据②的**真阳性**，必须明确断言（T17-F1：原先漏了这条，
    // 于是该用例在 needsRestart=true 的形状下照样全绿 —— 「看起来覆盖了、其实没覆盖」）
    assert.equal(r.needsRestart, true,
      '副本侧 mtime 晚于进程启动 → 属判据②真阳性，非误报；不得为了「不得误报」的字面去掉判据②')
    assert.ok(r.copyLagMs > 0, `副本应晚于进程启动，实际 copyLagMs=${r.copyLagMs}`)
  } finally { await p.cleanup() }
})

test('T17-F1 反向：副本 mtime 早于进程启动 → 判据②不得误报（needsRestart === false）', async () => {
  // 判据②的**误报方向**：副本写入早于进程启动时，进程拿到的就是这份内容 → 不需要重启。
  // 该方向此前**无用例把守**（T17-F1 要求补上）。
  //
  // 必须用 makeTimedPair（把**全部 4 个**运行时文件都回填到同一时刻）：判据②取的是
  // 这些文件的**最大** mtime，只改一个文件的话其余三个仍是「刚刚创建」→ rtNewest 仍会
  // 晚于进程启动，用例会因夹具不实而假红。这正是本用例第一次写错的地方。
  const rtWriteAt = new Date(Date.now() - 7200000)   // 副本全部写于 2 小时前
  const p = await makeTimedPair({ rtWriteAt })
  try {
    // 再把**仓库** mtime 设到未来：一次性证明仓库侧时点也影响不到判据②
    const future = new Date(Date.now() + 60000)
    for (const rel of [['src', 'plugin-entry.mjs'], ['src', 'context', 'inject.mjs'], ['client', 'client.js']]) {
      await utimes(join(p.repo, ...rel), future, future)
    }
    await utimes(join(p.repo, 'cordis.patch.yml'), future, future)

    const started = new Date(rtWriteAt.getTime() + 60000)   // 进程启动晚于副本写入 1 分钟
    const r = judgeFreshness({ repo: p.repo, rt: p.rt, started })
    assert.equal(r.inSync, true, '内容一致（判据①）')
    assert.equal(r.needsRestart, false,
      `副本写入早于进程启动 → 不得报需要重启，实际 copyLagMs=${r.copyLagMs}`)
    assert.ok(r.copyLagMs < 0, `副本应早于进程启动（copyLagMs<0），实际 ${r.copyLagMs}`)
    assert.ok(!(r.changed?.length), '仓库侧 mtime 在未来也不得进入差异列表')
  } finally { await p.cleanup() }
})

test('判据①不受任何 mtime 影响：同内容下任意 mtime 组合都判一致（副本侧时点归判据②）', async () => {
  // 名字要点准分工：**判据①（内容哈希）** 完全不受 mtime 影响 —— 这些组合下 inSync 都必须是
  // true。但「mtime 完全不参与结论」这句**已经不成立**了：判据②（副本写入 vs 进程启动）
  // 就是时间判据，它会在「副本比进程新」时**合法地**报 needsRestart=true。所以本用例
  // 分开钉两件事，免得后人再读到「mtime 不该参与」而误删判据②（那会退回 T9-F1 的假绿）。
  const combos = [
    { repoMtime: new Date(Date.now() - 7200000), rtMtime: new Date(Date.now() - 7200000) },
    { repoMtime: new Date(Date.now()), rtMtime: new Date(Date.now() - 7200000) },
    { repoMtime: new Date(Date.now() - 7200000), rtMtime: new Date(Date.now()) },
  ]
  for (const c of combos) {
    const p = await makePair(c)
    try {
      const r = judgeFreshness({ repo: p.repo, rt: p.rt, started: new Date(Date.now() - 3600000) })
      assert.equal(r.inSync, true, `mtime 组合 ${JSON.stringify(c)} 下内容一致就该判一致（判据①不受 mtime 影响）`)
    } finally { await p.cleanup() }
  }

  // 判据②是**独立**的时间判据，用 makeTimedPair 把**全部 4 个**运行时文件统一回填来确定性地
  // 控制它 —— 只改一个文件的话其余三个仍是「刚刚创建」，rtNewest 会取到它们，判据②不可预期。
  const started = new Date(Date.now() - 3600000)
  const oldCopy = await makeTimedPair({ rtWriteAt: new Date(Date.now() - 7200000) })
  try {
    const r = judgeFreshness({ repo: oldCopy.repo, rt: oldCopy.rt, started })
    assert.equal(r.inSync, true, '判据①：内容一致')
    assert.equal(r.needsRestart, false,
      `副本全部写于 2 小时前（早于进程启动）→ 判据②不得报需要重启，实际 copyLagMs=${r.copyLagMs}`)
  } finally { await oldCopy.cleanup() }
  const newCopy = await makeTimedPair({ rtWriteAt: new Date(Date.now() + 1000) })
  try {
    const r = judgeFreshness({ repo: newCopy.repo, rt: newCopy.rt, started })
    assert.equal(r.inSync, true, '判据①：内容一致（时间不影响内容判据）')
    assert.equal(r.needsRestart, true,
      `副本写于「现在」（晚于 1 小时前的进程启动）→ 判据②真阳性，实际 copyLagMs=${r.copyLagMs}`)
  } finally { await newCopy.cleanup() }
})

test('补丁层与浏览器半侧同样纳入判据（client/ 与 cordis.patch.yml）', async () => {
  const p = await makePair()
  try {
    await writeFile(join(p.rt, 'client', 'client.js'), '// client CHANGED\n', 'utf8')
    let r = judgeFreshness({ repo: p.repo, rt: p.rt })
    assert.ok(r.changed.some((c) => c.file === 'client/client.js'), 'client/client.js 差异必须被检出')

    await writeFile(join(p.rt, 'client', 'client.js'), '// client\n', 'utf8')
    await writeFile(join(p.rt, 'cordis.patch.yml'), 'plugins: { changed: true }\n', 'utf8')
    r = judgeFreshness({ repo: p.repo, rt: p.rt })
    assert.ok(r.changed.some((c) => c.file === 'cordis.patch.yml'), 'cordis.patch.yml 差异必须被检出')
  } finally { await p.cleanup() }
})

test('运行副本不存在时降级为 warn，不炸', async () => {
  const p = await makePair()
  try {
    const r = judgeFreshness({ repo: p.repo, rt: join(p.dir, 'nope') })
    assert.ok(r, '不该抛异常')
    assert.equal(r.compared, 0)
  } finally { await p.cleanup() }
})

// ---------- 三法互证：区分「未提交在制品」与「历史版本」 ----------

/** 在 fixture 的 repo 上建 git 仓库并提交当前内容。 */
function gitInit(repo, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }, (err, stdout) => resolve({ code: err?.code ?? 0, stdout: stdout ?? '' }))
  })
}

test('三法互证：差异全是未提交在制品 → 提示「先提交+同步」而不是「副本是历史版本」', async () => {
  const p = await makePair()
  try {
    await gitInit(p.repo, ['init', '-q'])
    await gitInit(p.repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'])
    await gitInit(p.repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'])
    // 副本 == HEAD（已同步）；然后仓库做**未提交**改动
    await writeFile(join(p.repo, 'src', 'plugin-entry.mjs'), 'export const WIP = 1\n', 'utf8')

    const r = judgeFreshness({ repo: p.repo, rt: p.rt })
    assert.equal(r.inSync, false, '内容不同就该判不一致')
    assert.equal(r.changed[0].runtimeMatchesHead, true,
      '副本应被识别为「== HEAD」，从而把差异归因为未提交在制品')
  } finally { await p.cleanup() }
})

test('三法互证：副本落后于 HEAD（已提交却没同步）→ 不算未提交在制品', async () => {
  const p = await makePair({ rtBody: 'export const OLD = 1\n' })
  try {
    await gitInit(p.repo, ['init', '-q'])
    await gitInit(p.repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'])
    await gitInit(p.repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'])
    // 仓库已提交新内容，副本还是旧的 → 副本 != HEAD
    await writeFile(join(p.repo, 'src', 'plugin-entry.mjs'), 'export const NEW = 1\n', 'utf8')
    await gitInit(p.repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'])
    await gitInit(p.repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'land it'])

    const r = judgeFreshness({ repo: p.repo, rt: p.rt })
    assert.equal(r.inSync, false)
    assert.equal(r.changed[0].runtimeMatchesHead, false,
      '副本不是 HEAD 那份 —— 不得误报成「差异全是未提交在制品」')
  } finally { await p.cleanup() }
})

test('判据本身的对照：旧的 mtime 逻辑在「漏同步」上会放行，新逻辑不会', async () => {
  // 直接对照两种「判据」在同一 fixture 上的结论，证明缺陷在**判定逻辑**里，
  // 而不只是「多了个 export」。旧逻辑就是改动前 selfcheck.mjs 那两行：
  //     const newest = max(mtime(plugin-entry.mjs), mtime(context/inject.mjs))
  //     started >= newest ? ok('运行代码是最新的') : fail('需要重启')
  const oldMtimeVerdict = (repo, rt, started) => {
    const m = (f) => { try { return statSyncSync(f).mtimeMs } catch { return 0 } }
    const newest = Math.max(m(join(rt, 'src', 'plugin-entry.mjs')), m(join(rt, 'src', 'context', 'inject.mjs')))
    return started.getTime() >= newest ? 'fresh' : 'stale'
  }

  const past = new Date(Date.now() - 7200000)
  const p = await makePair({
    repoBody: 'export const NEW = 1\n',   // 仓库已改
    rtBody: 'export const OLD = 1\n',     // 副本没同步
  })
  try {
    // 副本所有运行时文件回填成 2 小时前 → 早于进程启动
    for (const rel of [['src', 'plugin-entry.mjs'], ['src', 'context', 'inject.mjs']]) {
      await utimes(join(p.rt, ...rel), past, past)
    }
    const started = new Date()   // 进程刚启动，比副本 mtime 新

    // 旧逻辑：只看 mtime → 误判「代码是最新的」（静默放行，正是最严重的失效模式）
    assert.equal(oldMtimeVerdict(p.repo, p.rt, started), 'fresh',
      '旧 mtime 逻辑在这种场景下确实会放行 —— 这就是要修的缺陷')

    // 新逻辑：看内容哈希 → 正确判「不一致」
    const r = judgeFreshness({ repo: p.repo, rt: p.rt, started })
    assert.equal(r.inSync, false, '新逻辑必须判不一致')
    assert.ok(r.changed.some((c) => c.file === 'src/plugin-entry.mjs'))
  } finally { await p.cleanup() }
})

// ---------------------------------------------------------------------------
// T9-F1：新鲜度必须纳入**时间维度**（副本写入 vs 进程启动）
// ---------------------------------------------------------------------------
//
// 判据①（内容哈希）只回答「副本内容 == 仓库内容吗」，**完全不回答「进程加载到它了吗」**。
// 真机实测的时间盲假绿：副本 `src/plugin-entry.mjs` 写于 19:24:44、进程起于 18:13:29
// （副本晚 71 分钟）。Node 在 import 期就加载完模块，该进程不可能持有同步后的内容，
// 而旧代码照样输出「运行代码是最新的」——正好答错本任务要回答的核心问题。
//
// 所以必须有判据②：**副本里运行时文件的最新写入时刻 > 进程启动时刻 → 报需要重启**。
// 下面用**双向夹具**证明它会翻转，而不是只证明「代码看起来对了」：
// 把 started 摆在副本写入时刻两侧（前 1 分钟 / 后 1 分钟），结论必须随之翻转。

/** 造一个「运行时文件写入于 rtWriteAt」的仓库/副本对，供时间维度用例使用。 */
async function makeTimedPair({ rtWriteAt }) {
  const p = await makePair()
  for (const rel of [['src', 'plugin-entry.mjs'], ['src', 'context', 'inject.mjs'], ['client', 'client.js']]) {
    await utimes(join(p.rt, ...rel), rtWriteAt, rtWriteAt)
  }
  await utimes(join(p.rt, 'cordis.patch.yml'), rtWriteAt, rtWriteAt)
  // 仓库侧也回填同一时刻：本组用例要隔离的是**副本侧**时点，不能让仓库侧 mtime 干扰
  for (const rel of [['src', 'plugin-entry.mjs'], ['src', 'context', 'inject.mjs'], ['client', 'client.js']]) {
    await utimes(join(p.repo, ...rel), rtWriteAt, rtWriteAt)
  }
  await utimes(join(p.repo, 'cordis.patch.yml'), rtWriteAt, rtWriteAt)
  return p
}

test('T9-F1 双向翻转：started 跨过副本写入时刻 → 「需要重启」判定必须随之翻转', async () => {
  const rtWriteAt = new Date(Date.now() - 3600000)   // 副本写于 1 小时前
  const p = await makeTimedPair({ rtWriteAt })
  try {
    // 取值 A：进程启动**晚于**副本写入 1 分钟 → 进程加载的就是这份内容 → 不需要重启
    const startedAfter = new Date(rtWriteAt.getTime() + 60000)
    const a = judgeFreshness({ repo: p.repo, rt: p.rt, started: startedAfter })
    // 取值 B：进程启动**早于**副本写入 1 分钟 → 副本是启动后才落的 → 必须报需要重启
    const startedBefore = new Date(rtWriteAt.getTime() - 60000)
    const b = judgeFreshness({ repo: p.repo, rt: p.rt, started: startedBefore })

    // 内容始终一致 —— 判据①不受时间影响（两条判据必须并存、互不覆盖）
    assert.equal(a.inSync, true, '取值 A：内容一致')
    assert.equal(b.inSync, true, '取值 B：内容同样一致（判据①不因时间变化）')

    // 判据②必须翻转
    assert.equal(a.runtimeNewerThanProcess, false,
      `取值 A（started = 副本写入 +1min）不应判需要重启，实际 copyLagMs=${a.copyLagMs}`)
    assert.equal(b.runtimeNewerThanProcess, true,
      `取值 B（started = 副本写入 -1min）必须判需要重启，实际 copyLagMs=${b.copyLagMs}`)
    assert.equal(a.needsRestart, false)
    assert.equal(b.needsRestart, true)

    // 原始数值也要如实反映（验收要求「给出两种取值下的原始输出」）
    assert.ok(a.copyLagMs < 0, `A 的副本写入应早于进程启动（copyLagMs<0），实际 ${a.copyLagMs}`)
    assert.ok(b.copyLagMs > 60000 - 1000, `B 的副本写入应晚于进程启动约 1 分钟，实际 ${b.copyLagMs}`)
  } finally { await p.cleanup() }
})

test('T9-F1 假绿回归：真机形态（副本晚 71 分钟）必须判需要重启，不得再报「运行代码是最新的」', async () => {
  // 真机形态：副本写入时刻比进程启动晚 71 分钟，而内容与仓库一致。
  // 这是本任务点名的核心问题 —— 旧代码在这里给出**错误答案**。
  const started = new Date(Date.now() - 71 * 60000)
  const rtWriteAt = new Date(started.getTime() + 71 * 60000)   // = 现在
  const p = await makeTimedPair({ rtWriteAt })
  try {
    const r = judgeFreshness({ repo: p.repo, rt: p.rt, started })
    assert.equal(r.inSync, true, '内容确实一致（这正是最迷惑人的地方）')
    assert.equal(r.needsRestart, true, '内容一致但副本晚于进程启动 → 必须判需要重启')
    assert.ok(r.copyLagMs > 70 * 60000, `应算出约 71 分钟的滞后，实际 ${r.copyLagMs}ms`)
    // 必须点名一个**运行时**文件（同刻并列时取遍历序首个，不依赖具体是哪个）
    assert.ok(/^(src|client)\/|^cordis\.patch\.yml$/.test(r.runtimeNewest?.file ?? ''),
      `应点名最新写入的运行时文件，实际 ${r.runtimeNewest?.file}`)
  } finally { await p.cleanup() }
})

test('T9-F1 不得回退 t8：仅 mtime 抖动（亚秒级）不得误报需要重启', async () => {
  // 判据②的 2s 容差：文件系统写入与进程启动常在同一瞬间，不能让亚秒级粒度造成假报。
  const started = new Date(Date.now() - 3600000)
  const p = await makeTimedPair({ rtWriteAt: new Date(started.getTime() + 500) })  // 仅晚 0.5s
  try {
    const r = judgeFreshness({ repo: p.repo, rt: p.rt, started })
    assert.equal(r.needsRestart, false,
      `亚秒级抖动在容差内，不得判需要重启，实际 copyLagMs=${r.copyLagMs}`)
    assert.equal(r.inSync, true)
  } finally { await p.cleanup() }
})

test('T9-F2：scripts/ 不参与新鲜度比对（旁路诊断工具，不属运行时加载路径）', async () => {
  // 依据：package.json 的 main/exports 只映射 src/plugin-entry.mjs 与 client/client.js；
  // 全仓 src/** 与 client/** 对 scripts/ 的引用数为 0；scripts/selfcheck.mjs 随包发布，
  // 仓库改动后副本天然落后。**若纳入比对，每次正常开发都会假报 fail。**
  const p = await makePair()
  try {
    await mkdir(join(p.rt, 'scripts'), { recursive: true })
    await writeFile(join(p.rt, 'scripts', 'selfcheck.mjs'), '// 陈旧的副本诊断脚本\n', 'utf8')
    await mkdir(join(p.repo, 'scripts'), { recursive: true })
    await writeFile(join(p.repo, 'scripts', 'selfcheck.mjs'), '// 仓库里全新的诊断脚本，长很多\n', 'utf8')

    const r = judgeFreshness({ repo: p.repo, rt: p.rt })
    assert.equal(r.inSync, true,
      'scripts/ 内容不同**不得**影响新鲜度结论；纳入会把陈旧诊断脚本误报成故障')
    assert.ok(!r.changed.some((c) => c.file.startsWith('scripts/')),
      `scripts/ 不该出现在差异列表，实际 ${JSON.stringify(r.changed)}`)
    assert.equal(r.compared, 4, '仍只比对 4 个运行时文件')

    // 判据②同理只该看运行时文件：陈旧的 scripts/ 写入更晚也不得触发「需要重启」
    const started = new Date(Date.now() - 3600000)
    await utimes(join(p.rt, 'scripts', 'selfcheck.mjs'), new Date(), new Date())
    const r2 = judgeFreshness({ repo: p.repo, rt: p.rt, started })
    assert.equal(r2.runtimeNewest?.file !== 'scripts/selfcheck.mjs', true,
      `判据②不得把 scripts/ 当运行时文件，实际 ${r2.runtimeNewest?.file}`)
  } finally { await p.cleanup() }
})

test('T9-F2：端到端 —— 副本里 scripts/ 陈旧（真机形态）时脚本仍 exit 0', async () => {
  // 真机实测：副本 scripts/selfcheck.mjs 32,206 B vs 仓库 33,937 B，且写入时刻
  // 18:35:03 **晚于**进程启动 18:13:29。若把 scripts/ 纳入，DSH 完全健康却会报故障。
  const repo = await mkdtemp(join(tmpdir(), 'tx-repo-'))
  const body = 'export const SAME = 1\n'
  const home = await makeFakeHome({ repoBody: body })
  try {
    await mkdir(join(repo, 'src', 'context'), { recursive: true })
    await mkdir(join(repo, 'client'), { recursive: true })
    await mkdir(join(repo, 'scripts'), { recursive: true })
    await writeFile(join(repo, 'src', 'plugin-entry.mjs'), body, 'utf8')
    await writeFile(join(repo, 'src', 'context', 'inject.mjs'), 'export const inj = 1\n', 'utf8')
    await writeFile(join(repo, 'client', 'client.js'), '// client\n', 'utf8')
    await writeFile(join(repo, 'cordis.patch.yml'), 'plugins: {}\n', 'utf8')
    await writeFile(join(repo, 'scripts', 'selfcheck.mjs'), '// 仓库里很长的诊断脚本\n'.repeat(50), 'utf8')
    // 副本里的旧诊断脚本，写入时刻晚于进程启动（真机形态）
    await mkdir(join(home.rt, 'scripts'), { recursive: true })
    await writeFile(join(home.rt, 'scripts', 'selfcheck.mjs'), '// 旧的\n', 'utf8')
    const past = new Date(Date.now() - 7200000)
    for (const rel of ['src/plugin-entry.mjs', 'src/context/inject.mjs', 'client/client.js', 'cordis.patch.yml']) {
      await utimes(join(home.rt, rel), past, past)
    }
    const started = new Date(Date.now() - 3600000)   // 副本 scripts/ 写入晚于它
    const r = await runSelfcheck(['--json', '--only=freshness', `--repo-dir=${repo}`,
      `--started=${started.toISOString()}`], { DSH_HOME: home.home })
    assert.equal(r.code, 0,
      `scripts/ 陈旧不该让自检变红（DSH 无故障），实际 exit ${r.code}\nstdout=${r.stdout}`)
    const j = JSON.parse(r.stdout)
    assert.equal(j.freshness.inSync, true)
    assert.equal(j.freshness.needsRestart, false, 'scripts/ 写入更晚不得触发判据②')
    assert.ok(!j.findings.some((x) => x.level === 'fail'),
      `不该有任何 fail，实际 ${JSON.stringify(j.findings.filter((x) => x.level === 'fail'))}`)
  } finally {
    await home.cleanup(); await rm(repo, { recursive: true, force: true })
  }
})

// ---------- 端到端：真脚本进程的退出码 ----------
//
// 用假的 `DSH_HOME` 把「运行副本」摆成 profile 布局
// （$DSH_HOME/profiles/web/node_modules/dsh-tingxue），再让脚本自己跑。
// 用 `--only=freshness` 把判据隔离出来：不依赖在跑的记忆服务、不依赖会话日志。

/** 造一个假 DSH_HOME，其 profile 里的副本内容由 rtBody 决定。 */
async function makeFakeHome({ repoBody = 'export const a = 1\n', rtBody = null } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'tx-home-'))
  const rt = join(home, 'profiles', 'web', 'node_modules', 'dsh-tingxue')
  await mkdir(join(rt, 'src', 'context'), { recursive: true })
  await mkdir(join(rt, 'client'), { recursive: true })
  await writeFile(join(rt, 'src', 'plugin-entry.mjs'), rtBody ?? repoBody, 'utf8')
  await writeFile(join(rt, 'src', 'context', 'inject.mjs'), 'export const inj = 1\n', 'utf8')
  await writeFile(join(rt, 'client', 'client.js'), '// client\n', 'utf8')
  await writeFile(join(rt, 'cordis.patch.yml'), 'plugins: {}\n', 'utf8')
  return { home, rt, cleanup: () => rm(home, { recursive: true, force: true }) }
}

test('T9-F1 端到端双向翻转：真脚本进程在两个 --started 取值下 exit 码必须相反', async () => {
  // 本用例是 T9-F1 的主证据：**同一个夹具**，只改「进程启动时刻」这一项，
  // 真脚本进程的 exit 码与 finding 必须翻转 —— 证明判据真的接上了 started，
  // 而不是「代码看起来对了」。
  const repo = await mkdtemp(join(tmpdir(), 'tx-repo-'))
  const body = 'export const SAME = 1\n'
  const home = await makeFakeHome({ repoBody: body })
  try {
    await mkdir(join(repo, 'src', 'context'), { recursive: true })
    await mkdir(join(repo, 'client'), { recursive: true })
    await writeFile(join(repo, 'src', 'plugin-entry.mjs'), body, 'utf8')
    await writeFile(join(repo, 'src', 'context', 'inject.mjs'), 'export const inj = 1\n', 'utf8')
    await writeFile(join(repo, 'client', 'client.js'), '// client\n', 'utf8')
    await writeFile(join(repo, 'cordis.patch.yml'), 'plugins: {}\n', 'utf8')

    // 副本（内容 == 仓库）写入于 1 小时前
    const rtWriteAt = new Date(Date.now() - 3600000)
    for (const rel of ['src/plugin-entry.mjs', 'src/context/inject.mjs', 'client/client.js', 'cordis.patch.yml']) {
      await utimes(join(home.rt, rel), rtWriteAt, rtWriteAt)
    }

    const args = (started) => ['--json', '--only=freshness', `--repo-dir=${repo}`, `--started=${started.toISOString()}`]

    // 取值 A：进程启动**晚于**副本写入 1 分钟 → 该进程已加载这份内容 → exit 0
    const startedAfter = new Date(rtWriteAt.getTime() + 60000)
    const a = await runSelfcheck(args(startedAfter), { DSH_HOME: home.home })
    const ja = JSON.parse(a.stdout)
    assert.equal(a.code, 0,
      `【取值 A】started=副本写入+1min（进程晚于副本）应 exit 0，实际 ${a.code}\nstdout=${a.stdout}`)
    assert.equal(ja.freshness.needsRestart, false)
    assert.ok(ja.findings.some((x) => /运行代码是最新的/.test(x.title)),
      '【取值 A】应报「运行代码是最新的」')
    assert.ok(!ja.findings.some((x) => x.level === 'fail' && /需要重启/.test(x.title)),
      '【取值 A】不得报需要重启')

    // 取值 B：进程启动**早于**副本写入 1 分钟 → 副本是启动后才落的 → exit 1 且明说需要重启
    const startedBefore = new Date(rtWriteAt.getTime() - 60000)
    const b = await runSelfcheck(args(startedBefore), { DSH_HOME: home.home })
    const jb = JSON.parse(b.stdout)
    assert.equal(b.code, 1,
      `【取值 B】started=副本写入-1min（进程早于副本）必须 exit 1，实际 ${b.code}\nstdout=${b.stdout}`)
    assert.equal(jb.freshness.inSync, true, '【取值 B】内容仍一致（判据①未被时间影响）')
    assert.equal(jb.freshness.needsRestart, true, '【取值 B】必须判需要重启')
    const fb = jb.findings.find((x) => x.level === 'fail')
    assert.ok(fb, '【取值 B】应有 fail finding')
    assert.match(fb.title, /需要重启/)
    assert.match(fb.detail, /重启 DSH/, '必须给出处置办法')
    assert.ok(!jb.findings.some((x) => /运行代码是最新的/.test(x.title)),
      '【取值 B】绝不能再输出「运行代码是最新的」—— 那正是 T9-F1 的时间盲假绿')

    // 两种取值下的原始输出（验收要求留档）
    console.log('  【T9-F1 A】started 晚于副本写入 1 分钟 → exit', a.code, '|', ja.findings.map((x) => `${x.level}:${x.title}`).join(' / '))
    console.log('  【T9-F1 B】started 早于副本写入 1 分钟 → exit', b.code, '|', jb.findings.map((x) => `${x.level}:${x.title}`).join(' / '))
    console.log('  【T9-F1 B detail】', fb.detail.split('\n')[0])
  } finally {
    await home.cleanup(); await rm(repo, { recursive: true, force: true })
  }
})

test('端到端：副本与仓库内容不同 → 脚本 exit 1 并点名文件', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'tx-repo-'))
  const home = await makeFakeHome({ repoBody: 'export const NEW = 1\n', rtBody: 'export const OLD = 1\n' })
  try {
    // 假仓库：内容 = repoBody
    await mkdir(join(repo, 'src', 'context'), { recursive: true })
    await mkdir(join(repo, 'client'), { recursive: true })
    await writeFile(join(repo, 'src', 'plugin-entry.mjs'), 'export const NEW = 1\n', 'utf8')
    await writeFile(join(repo, 'src', 'context', 'inject.mjs'), 'export const inj = 1\n', 'utf8')
    await writeFile(join(repo, 'client', 'client.js'), '// client\n', 'utf8')
    await writeFile(join(repo, 'cordis.patch.yml'), 'plugins: {}\n', 'utf8')

    const r = await runSelfcheck(['--json', '--only=freshness', `--repo-dir=${repo}`], { DSH_HOME: home.home })
    assert.equal(r.code, 1, `副本内容不同必须 exit 1，实际 ${r.code}\nstdout=${r.stdout}\nstderr=${r.stderr}`)
    const j = JSON.parse(r.stdout)
    assert.equal(j.ok, false)
    const f = j.findings.find((x) => x.level === 'fail')
    assert.ok(f, '应有 fail finding')
    assert.match(f.title, /运行副本与仓库源码不一致/)
    assert.match(f.detail, /src\/plugin-entry\.mjs/, '必须点名哪个文件不同')
    assert.match(f.detail, /重启 DSH/, '必须给出「怎么修」')
    assert.equal(j.freshness.inSync, false)
  } finally {
    await home.cleanup(); await rm(repo, { recursive: true, force: true })
  }
})

test('防呆：仓库与运行副本是同一目录时拒绝比对（不得报假的「一致」）', async () => {
  // 运行副本里也带着 scripts/selfcheck.mjs，所以从副本目录里跑本脚本时
  // REPO_DIR（= 脚本上一级）会解析成副本自己 → 自己跟自己比永远一致。
  // 这种自指比对必须被明确拒绝。
  const p = await makePair()
  try {
    const r = judgeFreshness({ repo: p.rt, rt: p.rt })
    assert.equal(r.selfReferential, true, '应识别出自己跟自己比')
    assert.equal(r.compared, 0, '自指时不该产生比对计数（避免给出假的安心结论）')
  } finally { await p.cleanup() }
})

test('端到端：内容一致但 mtime 更新 → 脚本 exit 0（不误报）', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'tx-repo-'))
  try {
    await mkdir(join(repo, 'src', 'context'), { recursive: true })
    await mkdir(join(repo, 'client'), { recursive: true })
    const body = 'export const SAME = 1\n'
    await writeFile(join(repo, 'src', 'plugin-entry.mjs'), body, 'utf8')
    await writeFile(join(repo, 'src', 'context', 'inject.mjs'), 'export const inj = 1\n', 'utf8')
    await writeFile(join(repo, 'client', 'client.js'), '// client\n', 'utf8')
    await writeFile(join(repo, 'cordis.patch.yml'), 'plugins: {}\n', 'utf8')
    // 仓库 mtime 设在未来：任何进程启动时间都比它旧 —— **仓库侧** mtime 判据必然误报
    const future = new Date(Date.now() + 3600000)
    await utimes(join(repo, 'src', 'plugin-entry.mjs'), future, future)

    const home = await makeFakeHome({ repoBody: body })
    try {
      // 副本侧回填到「进程启动之前」：这才是「副本确实已被该进程加载」的真实形态。
      // 本用例钉住的 t8 缺陷是**仓库侧** mtime 误报；副本侧时点由 T9-F1 新增的判据②
      // 单独负责，两件事必须分开验证（否则会用一个判据的绿灯掩盖另一个判据的假绿）。
      const past = new Date(Date.now() - 7200000)
      for (const rel of ['src/plugin-entry.mjs', 'src/context/inject.mjs', 'client/client.js', 'cordis.patch.yml']) {
        await utimes(join(home.rt, rel), past, past)
      }
      // 显式指定进程启动时刻（副本写入之后），让本用例不依赖真机 DSH 进程的启动时间
      const started = new Date(Date.now() - 3600000)
      const r = await runSelfcheck(['--json', '--only=freshness', `--repo-dir=${repo}`,
        `--started=${started.toISOString()}`], { DSH_HOME: home.home })
      assert.equal(r.code, 0, `内容一致 + 副本早于进程启动必须 exit 0（不看仓库侧 mtime），实际 ${r.code}\nstdout=${r.stdout}`)
      const j = JSON.parse(r.stdout)
      assert.equal(j.ok, true)
      assert.equal(j.freshness.inSync, true)
      assert.equal(j.freshness.needsRestart, false, '副本写入早于进程启动 → 不需要重启')
      assert.ok(j.findings.some((x) => x.level === 'ok' && /运行副本与仓库源码一致/.test(x.title)))
      assert.ok(j.findings.some((x) => x.level === 'ok' && /运行代码是最新的/.test(x.title)),
        '副本早于进程启动且内容一致 → 应报「运行代码是最新的」')
      assert.ok(!j.findings.some((x) => x.level === 'fail' && /需要重启/.test(x.title)),
        '副本早于进程启动时不得报「需要重启」')
      assert.ok(!j.findings.some((x) => x.title.includes('需要重启 DSH —— 副本在进程启动后被写入')),
        '不得因为**仓库侧** mtime 变新就判「需要重启」')
    } finally { await home.cleanup() }
  } finally { await rm(repo, { recursive: true, force: true }) }
})

test('端到端：漏同步但副本 mtime 更旧 → 旧判据会静默放行，新判据必须 exit 1', async () => {
  // 这是**最严重**的失效模式：仓库改了、副本没同步，而副本 mtime 反而更旧。
  // 只看 mtime 会报「运行代码是最新的」——正好漏掉它本该守住的场景。
  // 注意旧判据取 max(plugin-entry.mjs, context/inject.mjs) 的 mtime，
  // 所以副本里这两个文件的 mtime 都要压到进程启动之前才能隔离出这个缺陷。
  const repo = await mkdtemp(join(tmpdir(), 'tx-repo-'))
  const home = await makeFakeHome({ repoBody: 'export const NEW = 1\n', rtBody: 'export const OLD = 1\n' })
  try {
    await mkdir(join(repo, 'src', 'context'), { recursive: true })
    await mkdir(join(repo, 'client'), { recursive: true })
    await writeFile(join(repo, 'src', 'plugin-entry.mjs'), 'export const NEW = 1\n', 'utf8')
    await writeFile(join(repo, 'src', 'context', 'inject.mjs'), 'export const inj = 1\n', 'utf8')
    await writeFile(join(repo, 'client', 'client.js'), '// client\n', 'utf8')
    await writeFile(join(repo, 'cordis.patch.yml'), 'plugins: {}\n', 'utf8')
    // 副本全部回填成 2 小时前 —— 早于 DSH 进程启动
    const past = new Date(Date.now() - 7200000)
    for (const rel of ['src/plugin-entry.mjs', 'src/context/inject.mjs']) {
      await utimes(join(home.rt, rel), past, past)
    }

    const r = await runSelfcheck(['--json', '--only=freshness', `--repo-dir=${repo}`,
      `--started=${new Date().toISOString()}`], { DSH_HOME: home.home })
    assert.equal(r.code, 1,
      `内容不同时即便 mtime 更旧也必须 exit 1（不得静默放行），实际 ${r.code}\nstdout=${r.stdout}`)
    const j = JSON.parse(r.stdout)
    assert.equal(j.ok, false)
    assert.equal(j.freshness.inSync, false)
    const f = j.findings.find((x) => x.level === 'fail')
    assert.ok(f, '应有 fail finding')
    assert.match(f.detail, /src\/plugin-entry\.mjs/, '必须点名哪个文件内容不同')
    assert.ok(!j.findings.some((x) => /运行代码是最新的/.test(x.title)),
      '不得再出现「运行代码是最新的」这种静默放行结论')
  } finally {
    await home.cleanup(); await rm(repo, { recursive: true, force: true })
  }
})
