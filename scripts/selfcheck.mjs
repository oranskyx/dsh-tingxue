#!/usr/bin/env node
// dsh-tingxue scripts/selfcheck.mjs
//
// 听雪运行状态自检 —— 一条命令看清「重启后有没有退回旧毛病」。
//
// 设计约束：
//  - **零成本**：绝不调用 /memory/search 之类会触发 embedding 的端点（那是要花钱的）。
//    只读本地文件 + 打 /health、/profile 这类纯本地端点。
//  - **只读**：不写记忆库、不改任何配置（用户硬约束）。
//  - **可脚本化**：有问题时 exit 1，全绿 exit 0。
//
// 核心判据（§17.15）：
//   request/header 只在 system 内容**变化时**才落一条新记录。所以
//   「同一轮内出现几条 header」= 该轮 system 变动了几次。
//   同轮应始终 change 0 —— 若某轮 change >= 1 且长度在「带记忆块/不带记忆块」间跳，
//   就是注入又出问题了（记忆块在同一轮里消失）。
//
// 用法：
//   node scripts/selfcheck.mjs              # 人类可读
//   node scripts/selfcheck.mjs --json       # 机器可读
//   node scripts/selfcheck.mjs --full       # 解全部日志帧（默认只解尾部 2000 帧，快）
//   node scripts/selfcheck.mjs --data-dir <path>

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { join, dirname, relative, sep, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ARGS = process.argv.slice(2)
const AS_JSON = ARGS.includes('--json')
const FULL = ARGS.includes('--full')
const argVal = (name) => {
  // 同时支持 `--name value` 与 `--name=value`：脚本既被人手敲，也被测试拼参数。
  const eq = ARGS.find((a) => a.startsWith(`${name}=`))
  if (eq) return eq.slice(name.length + 1)
  const i = ARGS.indexOf(name)
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : undefined
}
/** `--only=freshness,injection`：只跑指定检查（测试用来把判据隔离出来，不依赖在跑的服务）。 */
const ONLY = (() => {
  const raw = argVal('--only')
  if (!raw) return null
  const set = new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean))
  return set.size ? set : null
})()
const wants = (k) => !ONLY || ONLY.has(k)
/**
 * `--started=<ISO 时刻 | epoch 毫秒>`：覆盖「DSH 进程启动时刻」。
 * 默认从监听 3080 的进程反查（真机行为不变）。存在的理由是**可证伪**：
 * 新鲜度的第二条判据（副本写入是否晚于进程启动）只有在能把 started 摆到
 * 副本写入时刻两侧时才能证明它会翻转 —— 测试与人工诊断都需要这个旋钮。
 */
const STARTED_ARG = (() => {
  const raw = argVal('--started')
  if (!raw) return undefined
  const t = String(raw).trim()
  const n = Number(t)
  // 纯数字按 epoch 毫秒解释，其余按日期串解释
  const d = (t !== '' && Number.isFinite(n)) ? new Date(n) : new Date(t)
  return Number.isNaN(d.getTime()) ? undefined : d
})()

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const MEMORY_PORT = 8766
const DASH_PORT = 8765
const WEB_PORT = 3080
const PLUGIN_NAME = 'dsh-tingxue'

/** 仓库根 = 本脚本所在目录的上一级（scripts/ → 仓库根）。 */
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_DIR = argVal('--repo-dir') ?? join(HERE, '..')

const findings = []   // { level: 'ok'|'warn'|'fail', title, detail }
const ok = (title, detail = '') => findings.push({ level: 'ok', title, detail })
const warn = (title, detail = '') => findings.push({ level: 'warn', title, detail })
const fail = (title, detail = '') => findings.push({ level: 'fail', title, detail })

// ---------- 工具 ----------

/** 在 DSH 会话目录里找某个 sessionId 的日志文件。
 *  注意：state.json 里存的是 `session-<uuid>`（自带 session- 前缀），而目录名就是它本身，
 *  所以要先剥掉前缀再加回去，否则会拼成 `session-session-<uuid>`。 */
function findSessionLog(sessionId) {
  const root = join(DSH_HOME, 'sessions')
  if (!existsSync(root)) return null
  const bare = String(sessionId).replace(/^session-/, '')
  const dirName = `session-${bare}`
  for (const d of readdirSync(root)) {
    const p = join(root, d, dirName, 'session.jsonl.zstd')
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 解 DSH 会话日志（拼接式 zstd 多帧）。
 * @param {string} file
 * @param {number|null} tailFrames - 只解尾部这么多帧；null = 全部
 */
function loadEvents(file, tailFrames = 2000) {
  const raw = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= raw.length; i++) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) starts.push(i)
  }
  const from = tailFrames !== null && starts.length > tailFrames ? starts.length - tailFrames : 0
  const truncated = from > 0
  let jsonl = ''
  for (let k = from; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : raw.length
    try { jsonl += zstdDecompressSync(raw.subarray(starts[k], end)).toString('utf8') } catch { /* 半帧，跳过 */ }
  }
  const events = []
  for (const line of jsonl.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { events.push(JSON.parse(t)) } catch { /* 截断的残行 */ }
  }
  return { events, totalFrames: starts.length, fromFrame: from, truncated }
}

/** 按 turn 归位 request/header，统计每个回合的 system 变动次数。 */
function analyzeTurns(events) {
  const MEM = '\u3010\u76f8\u5173\u8bb0\u5fc6\u3011'
  const PROF = '\u3010\u8eab\u4efd\u4e0e\u5916\u89c2\u3011'
  const turns = []
  let cur = null
  for (const e of events) {
    if (e.type === 'turn/start') {
      cur = { turn: e.data?.turn, headers: [], steps: 0, startedAt: e.time }
      turns.push(cur)
    } else if (e.type === 'step/start') {
      if (cur) cur.steps++
    } else if (e.type === 'request/header') {
      if (!cur) continue
      const sys = e.data?.header?.system ?? ''
      cur.headers.push({
        reason: e.data?.reason,
        sysLen: sys.length,
        time: e.time,
        tools: e.data?.header?.tools?.length ?? 0,
        mem: sys.includes(MEM),
        prof: sys.includes(PROF),
      })
    }
  }
  // 首帧可能截断，丢掉第一个不完整的回合
  return turns.filter((t) => t.headers.length > 0)
}

/**
 * 判定一个回合。
 *
 * 关键：**不能用「有 change 记录」当漂移判据**。新回合的第一条 header 天然带
 * reason="change"（相对上一轮的 system 变了，比如新一轮检索出了不同记忆），
 * 那是正常行为。真正的 bug 特征只有一个：
 *   **同一轮内 system 长度出现了多个值** —— 也就是记忆块在轮中途消失
 *   （实测 15817 → 13872，掉的正是记忆块）。
 * 记忆块的有无也一并纳入，双重确认。
 */
function judgeTurn(t) {
  const lens = [...new Set(t.headers.map((h) => h.sysLen))]
  const mems = [...new Set(t.headers.map((h) => h.mem))]
  const changes = t.headers.filter((h) => h.reason === 'change').length
  const drifted = lens.length > 1 || mems.length > 1
  return {
    turn: t.turn,
    steps: t.steps,
    headerCount: t.headers.length,
    changes,
    lens,
    mems,
    sysLen: t.headers[t.headers.length - 1].sysLen,
    firstAt: t.headers[0].time,
    constant: lens.length === 1,
    drifted,
  }
}

/** 找监听某端口的进程启动时间（best-effort，失败返回 null）。 */
function listenerStartTime(port) {
  try {
    const ps = [
      `$c = netstat -ano -p TCP | Select-String ':${port}' | Select-String 'LISTENING' | Select-Object -First 1`,
      'if ($c) {',
      `  $p = ($c.ToString().Trim() -split '\\s+')[-1]`,
      '  try { (Get-Process -Id $p).StartTime.ToString("o") } catch { }',
      '}',
    ].join('; ')
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    }).trim()
    return out ? new Date(out) : null
  } catch {
    return null
  }
}

/** 从 profile 补丁里取配置项（只做简单键匹配，不引入 YAML 依赖）。 */
function readProfileConfig() {
  const p = join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')
  if (!existsSync(p)) return {}
  const text = readFileSync(p, 'utf8')
  const get = (k) => {
    const m = text.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm'))
    if (!m) return undefined
    return m[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return { dataDir: get('dataDir'), profilePath: get('profilePath'), llmModel: get('llmModel'), embeddingModel: get('embeddingModel'), path: p }
}

/** 定位 dataDir（--data-dir 优先，其次 profile 补丁，最后常见默认）。 */
function resolveDataDir() {
  const explicit = argVal('--data-dir')
  if (explicit) return explicit
  const cfg = readProfileConfig()
  if (cfg.dataDir) return cfg.dataDir
  for (const c of [join(process.cwd(), '.dsh-tingxue-data'), join(process.cwd(), '.dsh-tingxue')]) {
    if (existsSync(join(c, 'state.json'))) return c
  }
  return null
}

// ---------- 各项检查 ----------

/** 该路径是否「进程启动时会加载」——决定它算不算新鲜度判据的一部分。 */
const RUNTIME_DIRS = ['src', 'client']
const RUNTIME_SINGLE = ['cordis.patch.yml']

/** 递归列出目录下所有文件的相对路径（POSIX 分隔符，排序稳定）。 */
function walkRel(dir, base = dir, acc = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walkRel(p, base, acc)
    else if (e.isFile()) acc.push(relative(base, p).split(sep).join('/'))
  }
  return acc
}

/** 文件内容的 sha256（读不到返回 null）。 */
function sha256File(file) {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex') } catch { return null }
}

/** git 的 blob 对象哈希（= sha1("blob <len>\0" + content)）。与 `git hash-object` 逐字节一致。 */
function gitBlobHash(file) {
  try {
    const buf = readFileSync(file)
    return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
  } catch { return null }
}

/** HEAD 里该路径的 blob 哈希（不是 git 仓库/文件未跟踪/无 HEAD 时返回 null）。 */
function headBlobHash(repoDir, rel) {
  try {
    const out = execFileSync('git', ['-C', repoDir, 'rev-parse', `HEAD:${rel}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, windowsHide: true,
    }).trim()
    return out || null
  } catch { return null }
}

/** 仓库是不是可用 git 工作树。 */
function isGitRepo(repoDir) {
  try {
    execFileSync('git', ['-C', repoDir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, windowsHide: true,
    })
    return true
  } catch { return false }
}

/**
 * 运行新鲜度判定：**内容哈希 + 副本写入时刻**（两条判据并存，互不覆盖）。
 *
 * 背景：profile 用 `file:` 协议 + `nodeLinker: hoisted`，运行副本是**真实目录拷贝**
 * （不是 junction），改仓库永不自动传播。所以「要不要重启 DSH」由两件事共同决定：
 * 副本内容对不对（判据①），以及**进程是不是在副本最后一次写入之后启动的**（判据②）。
 *
 * ── 判据①（t8 成果，内容哈希；不得回退）──────────────────────────────
 * 只看内容，不看 mtime，因为纯 mtime 判据在**两个方向**上都实测失效：
 *   a) 静默放行：仓库改了、副本没同步 → 副本 mtime 反而更旧 → mtime 判据报「一切正常」。
 *      这恰是它本该守住的场景（最严重的失效模式）。
 *   b) 误报（**仓库侧**）：仓库文件同内容重写会让**仓库** mtime 变新；实测副本
 *      `src/plugin-entry.mjs` 内容与仓库逐字节相同、`git log a41090c..HEAD -- <file>`
 *      无输出，仅因 mtime 晚于进程启动就被判「需要重启」—— 纯误报。
 *   结论：**仓库侧** mtime 绝不参与判定；这一半必须保住。
 *
 * ── 判据②（本次修复；副本写入时刻 vs 进程启动）────────────────────────
 * 判据①只回答「副本内容 == 仓库内容吗」，**完全不回答「进程有没有加载到它」**。
 * 于是出现「时间盲假绿」（T9-F1）：副本 `src/plugin-entry.mjs` 写于 19:24:44、
 * 进程起于 18:13:29（副本晚 71 分钟）——Node 在 import 期就加载完了模块，该进程
 * **不可能**持有同步后的内容，而旧代码照样输出「运行代码是最新的」。真机复现见下。
 *   所以：**副本里运行时文件的最后写入时刻 > 进程启动时刻 → 必须报「需要重启」**。
 * 这一条与判据①不冲突：判据①管「内容对不对」，判据②管「进程装的是不是那份内容」。
 * 特别注意 ②用的是**副本侧**写入时刻，与 a/b 两个失效模式（仓库侧 mtime）无关，
 * 所以它不会把判据①好不容易修好的「同内容重写不误报」重新引入。
 *
 * 三法互证（`git rev-parse HEAD:<path>`）：能区分「副本 == HEAD（未提交在制品还没同步）」
 * 与「副本 == 工作树但工作树未提交」，给出更准确的处置建议。两个方向都检：
 * 副本落后于仓库（漏同步）**与**副本有多余文件。
 *
 * ── T9-F2：为什么 `scripts/` **不**纳入新鲜度比对 ──────────────────────
 * 结论：`scripts/` 不属于运行时加载路径，**不该**纳入。依据（三条都是可复核的事实）：
 *   1. `package.json` 的 `main` = `src/plugin-entry.mjs`、`exports` 只映射
 *      `.` → `src/plugin-entry.mjs` 与 `./client` → `client/client.js`；`scripts/`
 *      不在任何入口映射里，宿主 import 不到它。
 *   2. 全仓 `src/**` 与 `client/**` 对 `scripts/` 的引用数为 **0**（grep 可复核）：
 *      没有任何运行时模块 import 它。它是**旁路诊断工具**，只被人手 `node scripts/...` 跑。
 *   3. 运行副本里的 `scripts/selfcheck.mjs` 是**随包发布的副本**（`package.json`
 *      `files` 含 `scripts/selfcheck.mjs`），本仓库改动后天然会落后（真机实测：
 *      副本 32,206 B vs 仓库 33,937 B）。**若纳入比对，每一次正常开发都会因为
 *      「副本里的诊断脚本不是最新的」而报 fail，而运行中的 DSH 一点问题都没有** ——
 *      这正是制造假警报。
 *   判据②同理只该看**运行时文件**（`src/`、`client/`、`cordis.patch.yml`）：进程只加载
 *   这些；拿 `scripts/` 的写入时刻去比进程启动时刻同样会假报「需要重启」。
 *   （真机实测 `scripts/selfcheck.mjs` 副本写入 18:35:03，晚于进程启动 18:13:29 —— 若把它
 *   算进判据②，会在 DSH 完全健康时报需要重启。）
 *
 * 只读零成本：只 stat/readFile + 可选的 `git rev-parse`，不写文件、不发网络请求。
 */
function checkProcessFreshness(opts = {}) {
  const rtDir = opts.runtimeDir ?? join(DSH_HOME, 'profiles', 'web', 'node_modules', PLUGIN_NAME)
  const started = opts.started !== undefined ? opts.started : listenerStartTime(WEB_PORT)
  const repoDir = opts.repoDir ?? REPO_DIR

  const rtProbe = join(rtDir, 'src', 'plugin-entry.mjs')
  const repoProbe = join(repoDir, 'src', 'plugin-entry.mjs')
  if (!existsSync(rtProbe)) {
    warn('运行时副本', `没找到 ${rtProbe}；无法判断加载的是哪份代码`)
    return { started, mode: 'hash', runtimeDir: rtDir, repoDir, compared: 0 }
  }
  if (!existsSync(repoProbe)) {
    warn('运行时副本', `没找到仓库源码 ${repoProbe}（可用 --repo-dir 指定仓库根）；无法比对`)
    return { started, mode: 'hash', runtimeDir: rtDir, repoDir, compared: 0 }
  }
  // 防呆：运行副本里也带着 scripts/selfcheck.mjs，所以从副本目录里跑本脚本时
  // `REPO_DIR`（= 脚本上一级）会解析成**副本自己** → 自己跟自己比，永远「一致」，
  // 给出假的安心结论。这种自指比对必须明确拒绝，而不是报绿。
  try {
    if (resolve(rtDir) === resolve(repoDir)) {
      warn('仓库与运行副本是同一个目录',
        `${repoDir} 既是仓库又被当成运行副本 —— 自己跟自己比永远一致，结论无意义。` +
        `请用 --repo-dir 指定真实仓库根（从副本里跑本脚本时尤其要注意）`)
      return { started, mode: 'hash', runtimeDir: rtDir, repoDir, compared: 0, selfReferential: true }
    }
  } catch { /* resolve 失败则跳过该防呆 */ }

  // ---- 逐文件内容哈希比对（两个方向）----
  const missingInRuntime = []   // 仓库有、副本没有 → 副本落后
  const changed = []            // 两边都有但内容不同
  const extraInRuntime = []     // 副本有、仓库没有 → 副本多余
  const headMismatch = []       // 副本 != HEAD（说明副本装的是历史版本，或在制品没同步）
  const canGit = isGitRepo(repoDir)
  let compared = 0

  for (const relDir of RUNTIME_DIRS) {
    const a = join(rtDir, relDir)
    const b = join(repoDir, relDir)
    if (!existsSync(b)) continue
    if (!existsSync(a)) { missingInRuntime.push(`${relDir}/`); continue }
    const rtSet = new Set(walkRel(a))
    const repoSet = new Set(walkRel(b))
    for (const rel of repoSet) {
      const full = `${relDir}/${rel}`
      if (!rtSet.has(rel)) { missingInRuntime.push(full); continue }
      compared++
      const hr = sha256File(join(b, rel))       // b = 仓库（期望）
      const ht = sha256File(join(a, rel))       // a = 运行副本（实际）
      if (hr !== ht) {
        const head = canGit ? headBlobHash(repoDir, full) : null
        // runtimeMatchesHead=true 表示「副本是 HEAD 那份，差异来自仓库的未提交在制品」
        changed.push({
          file: full, repoHash: hr, runtimeHash: ht,
          runtimeMatchesHead: head !== null && gitBlobHash(join(a, rel)) === head,
        })
      }
    }
    for (const rel of rtSet) if (!repoSet.has(rel)) extraInRuntime.push(`${relDir}/${rel}`)
  }

  for (const rel of RUNTIME_SINGLE) {
    const a = join(rtDir, rel)
    const b = join(repoDir, rel)
    if (!existsSync(b)) { if (existsSync(a)) extraInRuntime.push(rel); continue }
    if (!existsSync(a)) { missingInRuntime.push(rel); continue }
    compared++
    const hr = sha256File(b)
    const ht = sha256File(a)
    if (hr !== ht) {
      const head = canGit ? headBlobHash(repoDir, rel) : null
      changed.push({
        file: rel, repoHash: hr, runtimeHash: ht,
        runtimeMatchesHead: head !== null && gitBlobHash(a) === head,
      })
    }
  }

  // 三法互证：副本内容是否等于 HEAD（能区分「未提交在制品」与「历史版本」）
  if (canGit) {
    for (const rel of [...RUNTIME_DIRS.flatMap((d) => {
      const b = join(repoDir, d)
      return existsSync(b) ? walkRel(b).map((r) => `${d}/${r}`) : []
    }), ...RUNTIME_SINGLE]) {
      const head = headBlobHash(repoDir, rel)
      if (head === null) continue               // 未跟踪/不在 HEAD：跳过
      const rtH = gitBlobHash(join(rtDir, rel))
      if (rtH !== null && rtH !== head) headMismatch.push(rel)
    }
  }

  // ---- 判据②：运行副本里「运行时文件」的最新写入时刻 ----
  //
  // 只看运行时加载路径（src/、client/、cordis.patch.yml）——**不含 scripts/**（理由见上方 T9-F2）。
  // 进程只加载这些文件，所以只有它们的写入时刻能决定「进程装的是不是这份内容」。
  const rtNewest = (() => {
    let best = null
    const rels = RUNTIME_DIRS.flatMap((d) => {
      const a = join(rtDir, d)
      return existsSync(a) ? walkRel(a).map((r) => `${d}/${r}`) : []
    }).concat(RUNTIME_SINGLE)
    for (const rel of rels) {
      try {
        const st = statSync(join(rtDir, rel))
        if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) {
          best = { file: rel, mtimeMs: st.mtimeMs, mtime: st.mtime }
        }
      } catch { /* 读不到就跳过该文件 */ }
    }
    return best
  })()

  // 副本写入 vs 进程启动。留 2s 容差吸收文件系统时间戳粒度（NTFS/FAT 与时钟抖动），
  // 避免亚秒级粒度造成假报；真正的「同步后才写」至少差秒级，真机实测差 71 分钟。
  const MTIME_SLACK_MS = 2000
  const copyLagMs = (started && rtNewest) ? (rtNewest.mtimeMs - started.getTime()) : null
  const runtimeNewerThanProcess = copyLagMs !== null && copyLagMs > MTIME_SLACK_MS

  const short = (h) => (h ? h.slice(0, 12) : '(读不到)')
  const brief = (a, n = 5) => `${a.slice(0, n).join('、')}${a.length > n ? `…（共 ${a.length} 个）` : ''}`
  const fmt = (d) => (d ? d.toLocaleString('zh-CN', { hour12: false }) : '未知')
  const fmtMin = (ms) => `${Math.round(ms / 60000)} 分钟`

  const inSync = missingInRuntime.length === 0 && changed.length === 0 && extraInRuntime.length === 0

  // ---- 判定 ----
  if (inSync) {
    ok('运行副本与仓库源码一致（内容哈希）',
      `${compared} 个文件哈希全等；改仓库仍需「同步副本 + 重启 DSH」才生效`)
    if (!started) {
      warn('进程启动时间未知', '拿不到监听 3080 的进程启动时间（netstat/Get-Process 不可用）。请人工确认：DSH 是否在源码改动之后重启')
    } else if (runtimeNewerThanProcess) {
      // 判据②命中：内容一致但进程不可能加载到它 —— 这正是 T9-F1 的时间盲假绿。
      fail('需要重启 DSH —— 副本在进程启动后被写入',
        `副本最新写入的是 ${rtNewest.file}：${fmt(rtNewest.mtime)}；` +
        `而 DSH 进程启动于 ${fmt(started)} —— 副本晚 ${fmtMin(copyLagMs)}。` +
        `Node 在 import 期就加载完了模块，所以该进程**装的仍是写入前的那份内容**；` +
        `副本内容虽与仓库一致，也必须**重启 DSH** 才真正生效。` +
        `（自检本身只读，不会替你重启）`)
    } else {
      ok('运行代码是最新的',
        `DSH 启动 ${fmt(started)}；副本最新写入 ${fmt(rtNewest?.mtime)} 早于进程启动；` +
        `且副本内容 == 仓库工作树（不看仓库侧 mtime，故同内容重写不误报）`)
    }
  } else {
    const parts = []
    if (missingInRuntime.length) parts.push(`副本缺 ${missingInRuntime.length} 个文件：${brief(missingInRuntime)}`)
    if (changed.length) parts.push(`${changed.length} 个文件内容不同：${brief(changed.map((c) => c.file))}`)
    if (extraInRuntime.length) parts.push(`副本多 ${extraInRuntime.length} 个文件：${brief(extraInRuntime)}`)
    const detail = []
    for (const c of changed.slice(0, 5)) {
      detail.push(`  ${c.file}：期望(repo)=${short(c.repoHash)} 实际(copy)=${short(c.runtimeHash)}`)
    }
    const fix = `运行副本是**真实目录拷贝**（profile 用 file: 协议 + nodeLinker: hoisted），改仓库不会自动生效。` +
      `修法：把仓库 ${changed.length + missingInRuntime.length > 0 ? '相应文件' : '目录'} 覆盖同步到 ${rtDir}，然后**重启 DSH** 才生效。` +
      `（自检本身只读，不会替你同步）`
    fail('运行副本与仓库源码不一致 —— 跑的是旧代码',
      `${parts.join('；')}\n${detail.join('\n')}\n${fix}`)
    // 判据②与判据①并存：内容不一致时若副本还比进程新，追加一条独立的时点提醒。
    // 两条判据各自出结论，绝不互相覆盖（内容问题 → fail 已给出；时点问题 → 这里补 warn）。
    if (runtimeNewerThanProcess) {
      warn('副本写在进程启动之后（内容也不一致）',
        `${rtNewest.file} 写入于 ${fmt(rtNewest.mtime)}，晚于 DSH 启动 ${fmt(started)} ${fmtMin(copyLagMs)}；` +
        `同步副本后**必须重启 DSH**，否则进程仍持有旧模块`)
    }
    // 三法互证：给出更准确的处置建议
    if (canGit && headMismatch.length > 0) {
      const allUncommitted = changed.length > 0 && changed.every((c) => c.runtimeMatchesHead)
      if (allUncommitted) {
        warn('差异全是未提交的在制品',
          `${brief(changed.map((c) => c.file))}：运行副本 == HEAD，差异**全部**来自仓库的未提交改动；` +
          `**要生效必须先提交 + 同步副本 + 重启 DSH**（已提交的那份与副本是自洽的，交付态没坏）`)
      } else {
        warn('副本内容 != HEAD',
          `${brief(headMismatch)}；副本装的可能不是当前提交版本，建议重新同步（仓库 → 副本 → 重启 DSH）`)
      }
    } else if (!canGit) {
      warn('无法用 git 三法互证', `${repoDir} 不是 git 工作树，无法区分「未提交在制品」与「历史版本」；按保守一律判不一致`)
    }
  }

  return {
    started,
    mode: 'hash',
    runtimeDir: rtDir,
    repoDir,
    compared,
    inSync,
    // 判据②（副本写入 vs 进程启动）的可见结果 —— 验收要求「必须随之翻转」可被直接断言
    runtimeNewest: rtNewest ? { file: rtNewest.file, mtime: rtNewest.mtime.toISOString() } : null,
    runtimeNewestMs: rtNewest ? rtNewest.mtimeMs : null,
    startedMs: started ? started.getTime() : null,
    copyLagMs,
    mtimeSlackMs: MTIME_SLACK_MS,
    runtimeNewerThanProcess,
    needsRestart: runtimeNewerThanProcess,
    missingInRuntime: missingInRuntime.slice(0, 20),
    changed: changed.map((c) => ({ file: c.file, repoHash: short(c.repoHash), runtimeHash: short(c.runtimeHash), runtimeMatchesHead: c.runtimeMatchesHead })),
    extraInRuntime: extraInRuntime.slice(0, 20),
    headMismatch: headMismatch.slice(0, 20),
  }
}

function checkSlidingWindow(dataDir) {
  if (!dataDir) { warn('滑动窗口', '找不到 dataDir（可用 --data-dir 指定）'); return null }
  const f = join(dataDir, 'state.json')
  if (!existsSync(f)) { warn('滑动窗口', `没有 ${f}`); return null }
  let s
  try { s = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { fail('滑动窗口', `state.json 解析失败：${e.message}`); return null }

  const rr = Array.isArray(s.recentRounds) ? s.recentRounds : []
  let chars = 0
  for (const r of rr) chars += (r.user?.length ?? 0) + (r.assistant?.length ?? 0)
  const latest = Array.isArray(s.latestInfo) ? s.latestInfo.length : 0

  ok('滑动窗口', `${rr.length} 轮 / ${chars} 字符；latestInfo ${latest} 条；mode=${s.mode}`)

  // 上限体检：maxStored 默认 max(recentN*3, 50)
  if (rr.length > 60) warn('滑动窗口轮数偏多', `${rr.length} 轮，超出预期上限 50；检查 maxStoredRounds / recentRounds 配置`)
  if (s.mode === 'agent') {
    warn('mode = agent', `agentSessionId=${s.agentSessionId}；聊天上下文注入在 agent 模式下是关的。若 QQ 并未绑到该隔离会话，应 /agentstop`)
  }
  return s
}

function checkBinding(state, dataDir) {
  const nf = join(DSH_HOME, 'dsh-notifier', 'state.json')
  if (!existsSync(nf)) { warn('QQ 绑定', `没有 ${nf}`); return null }
  let ns
  try { ns = JSON.parse(readFileSync(nf, 'utf8')) } catch (e) { warn('QQ 绑定', `解析失败：${e.message}`); return null }
  const store = ns?.store ?? ns
  const binds = Object.entries(store ?? {}).filter(([k]) => k.startsWith('bind:'))
  if (binds.length === 0) { warn('QQ 绑定', '没有任何 bind: 键'); return null }

  const chat = state?.chatSessionId
  const agent = state?.agentSessionId
  for (const [k, v] of binds) {
    if (agent && v === agent) {
      ok('QQ 绑定', `${k} → 隔离会话（agent 模式生效，与 state 一致）`)
    } else if (chat && v === chat) {
      ok('QQ 绑定', `${k} → 聊天会话（与 state.chatSessionId 一致）`)
    } else {
      warn('QQ 绑定指向未知会话', `${k} → ${String(v).slice(0, 30)}…（state 里 chat/agent 都对不上）`)
    }
  }
  return binds
}

async function checkEndpoints(dataDir) {
  // 记忆服务：只打 /health（纯本地，不触发 embedding）
  try {
    const r = await fetch(`http://127.0.0.1:${MEMORY_PORT}/health`, { signal: AbortSignal.timeout(5000) })
    const j = await r.json().catch(() => null)
    if (r.ok && j?.ok) ok('记忆服务 8766', `ok / service=${j.service}`)
    else fail('记忆服务 8766', `HTTP ${r.status}，body=${JSON.stringify(j)}`)
  } catch (e) {
    fail('记忆服务 8766', `连不上：${e.message}`)
  }

  // /profile 只读人格文件，同样零成本
  try {
    const r = await fetch(`http://127.0.0.1:${MEMORY_PORT}/profile`, { signal: AbortSignal.timeout(8000) })
    const j = await r.json().catch(() => null)
    if (r.ok && j?.ok) ok('人格档案可达', `${String(j.profile ?? '').length} 字符`)
    else warn('人格档案', `HTTP ${r.status} ${JSON.stringify(j)?.slice(0, 120)}`)
  } catch (e) {
    warn('人格档案', `读取失败：${e.message}`)
  }

  // 图谱面板
  try {
    const r = await fetch(`http://127.0.0.1:${DASH_PORT}/`, { signal: AbortSignal.timeout(5000) })
    if (r.ok) ok('图谱面板 8765', `HTTP ${r.status}`)
    else warn('图谱面板 8765', `HTTP ${r.status}`)
  } catch (e) {
    warn('图谱面板 8765', `连不上：${e.message}`)
  }

  // 模型目录路由：POST 带坏 key 只验「路由在不在」，不耗真实模型调用
  // （空 body → 400 即证明路由已注册；405 说明还是 SPA 兜底 = 没重启）
  try {
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}/dsh-tingxue/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${WEB_PORT}` },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(20000),
    })
    const j = await r.json().catch(() => null)
    if (r.status === 405 || r.status === 404) {
      fail('模型目录路由未注册', `HTTP ${r.status} —— 被 GUI 的 SPA 兜底接管，说明 DSH 没在加路由之后重启`)
    } else if (r.status === 400) {
      ok('模型目录路由已注册', 'HTTP 400（空 body 被正常拒绝，证明路由在）')
    } else if (r.ok && j?.ok === false) {
      ok('模型目录路由已注册', `HTTP 200 且 ok:false（${j.error ?? '上游拒绝'}）——路由在，凭据或网络另说`)
    } else if (r.ok && j?.ok === true) {
      ok('模型目录路由已注册', `HTTP 200，${j.models?.length ?? '?'} 个模型`)
    } else {
      warn('模型目录路由', `HTTP ${r.status} ${JSON.stringify(j)?.slice(0, 120)}`)
    }
  } catch (e) {
    fail('模型目录路由', `请求失败：${e.message}`)
  }
}

function checkInjection(state, dataDir, procStart) {
  const sid = state?.chatSessionId
  if (!sid) { warn('注入健康', 'state 里没有 chatSessionId，跳过'); return null }
  const log = findSessionLog(sid)
  if (!log) { warn('注入健康', `找不到会话日志（chatSessionId=${sid}）`); return null }

  const { events, totalFrames, fromFrame } = loadEvents(log, FULL ? null : 2000)
  const turns = analyzeTurns(events)
  if (turns.length === 0) { warn('注入健康', '日志里没有可用回合'); return null }

  const judged = turns.map(judgeTurn)

  // 只把**本次 DSH 启动之后**的回合当作现行判据：
  // 源码修复前的历史回合（如 turn 83/84）本来就该是漂移的，算进来只会误报。
  const afterBoot = procStart
    ? judged.filter((t) => t.firstAt && new Date(t.firstAt).getTime() >= procStart.getTime())
    : judged
  const scope = afterBoot.length ? afterBoot : judged
  const scopeNote = afterBoot.length
    ? (procStart ? `本次启动(${procStart.toLocaleTimeString('zh-CN', { hour12: false })})之后` : '')
    : '（拿不到启动时间，改用最近 6 轮）'
  // scopeNote 为「本次启动(...)之后」/「（拿不到启动时间，改用最近 6 轮）」/ 空串。
  // 空串出现在「有启动后的回合、但拿不到启动时间」的分支，此时给一句可读的兜底，
  // 否则输出会长成「的 1 轮全部只有…」这种断头句。
  const recent = afterBoot.length ? afterBoot : judged.slice(-6)
  const scopeText = scopeNote || `本次窗口（${recent.length} 轮）`
  const drifted = recent.filter((t) => t.drifted)
  // 判别力（复核 finding F3）：漂移判据是「同一轮内 system 长度出现多个值」，而长度是从
  // 该轮的 headers 去重来的 —— **只有 headerCount >= 2 的回合才可能观察到轮内漂移**。
  // 若窗口内全是单表头回合，drifted 必然为 0：那是「没能力看见」，不是「没问题」。
  // 这种绿灯是最危险的假绿灯（把无判别力当成修复有效的证据），所以必须单独计数并降级。
  const observable = recent.filter((t) => t.headerCount >= 2)

  if (drifted.length > 0) {
    fail('注入在同轮内变动（记忆块会消失）',
      `${scopeText}的 ${recent.length} 轮里有 ${drifted.length} 轮 system 轮内变动：` +
      drifted.map((t) => `turn ${t.turn}(${t.lens.join('→')})`).join('、'))
  } else if (observable.length === 0) {
    warn('注入轮内恒定（本次窗口无判别力）',
      `${scopeText}的 ${recent.length} 轮**全部只有 1 个 request/header**（headerCount 均 < 2），` +
      `单表头回合不可能观察到轮内漂移 —— 故本次 0 漂移**不能**作为「修复有效」的证据。` +
      `请在一个多 step（每 step 各发一次 header）的回合之后重跑，或改用更长的 --full 窗口。`)
  } else {
    const lens = [...new Set(observable.map((t) => t.sysLen))]
    ok('注入轮内恒定',
      `${scopeText}具备观测能力的 ${observable.length}/${recent.length} 轮（headerCount ≥ 2）均无轮内变动；` +
      `system 长度 ${lens.join(' / ')}`)
  }

  return {
    log, totalFrames, fromFrame,
    procStart: procStart ? procStart.toISOString() : null,
    scopeCount: scope.length,
    recent: recent.map((t) => ({
      turn: t.turn, steps: t.steps, headerCount: t.headerCount,
      changes: t.changes, lens: t.lens,
      mems: t.mems.map((m) => (m ? 'Y' : '-')),
      sysLen: t.sysLen, drifted: t.drifted,
      observable: t.headerCount >= 2,
    })),
    driftedInScope: drifted.length,
    // 具备观测能力（headerCount >= 2）的回合数；为 0 时上面那条判定已降级为 warn
    observableTurns: observable.length,
    observableTurnsInScope: observable.map((t) => t.turn),
    turnsTotal: judged.length,
    lastSysLen: judged[judged.length - 1]?.sysLen,
    // 历史遗留（修复前的回合），仅供参考，不作为判定
    historicalDrift: judged.filter((t) => t.drifted && !recent.includes(t)).length,
  }
}

function checkNoDuplicateDshPrompt(events) {
  // 找最后一条 header，扫危险信号（这是「没把 DSH 本体一大坨塞进去」的判据）
  let last = null
  for (const e of events) if (e.type === 'request/header') last = e.data?.header
  if (!last?.system) return null
  const s = last.system
  const idLine = 'You are an AI agent powered by DeepSeek Harness.'
  const signals = {
    dshIdentityCount: s.split(idLine).length - 1,
    toolsTag: s.split('<tools>').length - 1,
    availableTools: s.split('Available tools').length - 1,
    functionCalls: s.split('function_calls').length - 1,
    recentRoundsBlock: s.split('\u3010\u6700\u8fd1\u5bf9\u8bdd\u3011').length - 1,
    latestInfoBlock: s.split('\u3010\u6700\u65b0\u4fe1\u606f\u3011').length - 1,
    personaBlock: s.split('\u3010\u8eab\u4efd\u4e0e\u5916\u89c2\u3011').length - 1,
    systemLen: s.length,
    toolCount: last.tools?.length ?? 0,
  }
  const bad = []
  if (signals.dshIdentityCount !== 1) bad.push(`DSH 身份行出现 ${signals.dshIdentityCount} 次（应为 1）`)
  if (signals.toolsTag > 0) bad.push(`<tools> 出现 ${signals.toolsTag} 次`)
  if (signals.availableTools > 0) bad.push(`Available tools 出现 ${signals.availableTools} 次`)
  if (signals.functionCalls > 0) bad.push(`function_calls 出现 ${signals.functionCalls} 次`)
  if (signals.recentRoundsBlock > 0) bad.push('【最近对话】仍在注入（[3] 应默认关闭）')

  if (bad.length === 0) {
    ok('无重复/累赘上下文',
      `${signals.systemLen} 字符 · ${signals.toolCount} 工具 · 人格块${signals.personaBlock ? '在' : '不在'} · 身份行 1 次`)
  } else {
    fail('上下文里有可疑内容', bad.join('；'))
  }
  return signals
}

// ---------- 主流程 ----------

async function main() {
  const dataDir = resolveDataDir()
  const cfg = readProfileConfig()

  // freshness = 运行副本新鲜度（内容哈希）；injection = 同轮漂移判定。
  // `--only=` 让测试能把这两条判据单独跑出来，不依赖在跑的服务/日志。
  const proc = wants('freshness') ? checkProcessFreshness(STARTED_ARG !== undefined ? { started: STARTED_ARG } : {}) : null
  const state = wants('injection') ? checkSlidingWindow(dataDir) : null
  if (wants('binding')) checkBinding(state, dataDir)
  if (wants('endpoints')) await checkEndpoints(dataDir)

  const inj = wants('injection') ? checkInjection(state, dataDir, proc?.started ?? null) : null
  if (inj?.log) {
    const { events } = loadEvents(inj.log, FULL ? null : 2000)
    checkNoDuplicateDshPrompt(events)
  }

  // ---------- 输出 ----------
  const fails = findings.filter((f) => f.level === 'fail')
  const warns = findings.filter((f) => f.level === 'warn')

  if (AS_JSON) {
    console.log(JSON.stringify({
      ok: fails.length === 0,
      dataDir, profile: cfg.path, config: cfg,
      findings, freshness: proc, injection: inj,
      summary: { fail: fails.length, warn: warns.length, ok: findings.length - fails.length - warns.length },
    }, null, 2))
  } else {
    const icon = { ok: '✓', warn: '!', fail: '✗' }
    console.log('')
    console.log('  听雪自检')
    console.log('  ' + '─'.repeat(56))
    for (const f of findings) {
      console.log(`  ${icon[f.level]} ${f.title}`)
      if (f.detail) console.log(`      ${f.detail}`)
    }
    if (inj?.recent?.length) {
      console.log('')
      console.log('  本进程启动后的回合（system 轮内变动 = 注入出问题）')
      console.log('  ' + '─'.repeat(56))
      console.log('   turn  steps  header  change  记忆块  system 长度          判定')
      for (const t of inj.recent) {
        const judge = t.drifted ? '轮内变动 ✗' : '恒定 ✓'
        const lens = t.lens.length === 1 ? String(t.lens[0]) : t.lens.join(' → ')
        console.log(`   ${String(t.turn).padStart(4)}  ${String(t.steps).padStart(5)}  ${String(t.headerCount).padStart(6)}  ${String(t.changes).padStart(6)}  ${t.mems.join(' ').padEnd(6)}  ${lens.padEnd(20)}${judge}`)
      }
      if (inj.historicalDrift > 0) {
        console.log('')
        console.log(`  （另有 ${inj.historicalDrift} 个修复前的历史回合存在同类变动，已排除在判定之外）`)
      }
    }
    console.log('')
    console.log('  ' + '─'.repeat(56))
    const verdict = fails.length === 0
      ? (warns.length === 0 ? '全部正常' : `正常（${warns.length} 项提示）`)
      : `${fails.length} 项失败${warns.length ? ` / ${warns.length} 项提示` : ''}`
    console.log(`  结论：${verdict}`)
    if (fails.length) {
      console.log('')
      console.log('  需要处理的：')
      for (const f of fails) console.log(`    ✗ ${f.title} —— ${f.detail}`)
    }
    console.log('')
  }

  process.exit(fails.length === 0 ? 0 : 1)
}

// 作为脚本直接运行才执行主流程；被 import（测试用）时只暴露纯函数。
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
  main().catch((e) => {
    console.error('自检崩溃：', e?.stack ?? e)
    process.exit(2)
  })
}

export {
  analyzeTurns, judgeTurn, loadEvents, findSessionLog,
  // 新鲜度判据（内容哈希）——测试直接驱动，不必依赖真机 profile
  checkProcessFreshness, sha256File, gitBlobHash, headBlobHash, walkRel, isGitRepo,
  RUNTIME_DIRS, RUNTIME_SINGLE, PLUGIN_NAME,
}
