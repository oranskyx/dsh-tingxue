#!/usr/bin/env node
// dsh-tingxue scripts/install-check.mjs
//
// 安装安全流程 —— 一条命令把「装完没生效」和「装坏了」都变成可机检的断言，
// 并在校验失败时**自动回滚**到动手前的状态。
//
// 为什么需要它（README §安装 里那几处手工步骤，漏了就是**静默失效**）：
//   1. profile 的 `dsh.profile.bundles` 没列上插件 → cordis 报
//      「已安装，未生效：未声明 dsh.bundle，已作为普通依赖安装」。插件在，功能不在。
//   2. `dsh-notifier` 没钉死 0.9.0 → 补丁带**行号 hunk**，版本一升上下文就移位，
//      `pnpm install` 直接失败。
//   3. 补丁没接线到 `pnpm-workspace.yaml` 的 `patchedDependencies`（注意：补丁声明
//      **不在** profile 的 package.json 里，放错位置等于没接线）→ 补丁文件在磁盘上
//      也不会被应用，必须再 `pnpm install`。
//   4. 运行副本 `profiles/web/node_modules/dsh-tingxue` 是**真实目录拷贝不是
//      junction**（profile 用 `file:` 协议 + `nodeLinker: hoisted`）→ **改仓库不会
//      自动生效**。这是本项目最隐蔽的失效模式。
//
// 三条硬纪律：
//   - **只读活状态**：活 profile（`~/.dsh/profiles/*`）只读。要「制造坏环境」必须走
//     **临时副本**（`--profile-dir`）；`--fix` 默认拒绝写入活 profile，除非显式给
//     `--allow-live-profile`。
//   - **自动回滚**：`--fix` 动手前逐文件备份原始字节与 SHA256；任一条修复后复检仍
//     不过，**整批回滚**并复验哈希。
//   - **凭据不得进入仓库**：跑完 `git status --porcelain` 必须为空，产物里不得出现活
//     配置里的凭据明文。脚本对凭据**只比对、不回显**。
//
// 用法：
//   node scripts/install-check.mjs                       # 校验活 profile（只读）
//   node scripts/install-check.mjs --json                # 机器可读
//   node scripts/install-check.mjs --profile-dir <path>  # 校验指定 profile（临时副本）
//   node scripts/install-check.mjs --repo-dir <path>     # 指定插件仓库
//   node scripts/install-check.mjs --no-pack             # 跳过 npm pack 体检（离线/沙箱友好）
//   node scripts/install-check.mjs --expect-clean-git    # 工作区不干净即判失败
//   node scripts/install-check.mjs --fix --profile-dir <临时副本>    # 修复 + 失败自动回滚
//   node scripts/install-check.mjs --self-test           # 跑核心回归（与 test/ 套件同一批用例）
//   node scripts/install-check.mjs --self-test --live    # 额外把活 profile 当硬门禁（仍只读）
//
// exit：0 全绿 / 1 有 fail / 2 脚本自身崩溃。
//
// C1-C9：
//   C1 / C1-files 插件自身声明 dsh.bundle + files 白名单
//   C2            插件在 profile 的 dsh.profile.bundles 名单里
//   C3            dsh-notifier 声明钉死 0.9.0 **且**已装版本也是 0.9.0（两条轴独立判定）
//   C4 / C4-loc  补丁接线在 pnpm-workspace.yaml 的 patchedDependencies（不在 profile 的 package.json）
//   C4-applied    补丁真的生效（_qq-segment.mjs + parseQQFileAttachments）
//   C5 / C5-link 运行副本与仓库逐字节一致；且副本是真实目录拷贝不是 junction
//   C6           仓库里无活配置凭据明文、工作区干净、本脚本只读
//   C7           活 profile 里的明文凭据（风险面在仓库外）
//   C8 / C8-ship npm pack 清单无泄漏
//   C9           profile 的 cordis.patch.yml **结构上真的能解析** —— 这一条不是「某功能不生效」，
//                而是「整个 profile 起不来」，严重度最高。

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, rmSync, lstatSync, mkdtempSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, dirname, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))

const ARGS = process.argv.slice(2)
const AS_JSON = ARGS.includes('--json')
const DO_FIX = ARGS.includes('--fix')
const NO_PACK = ARGS.includes('--no-pack')
const EXPECT_CLEAN_GIT = ARGS.includes('--expect-clean-git')
const ALLOW_LIVE = ARGS.includes('--allow-live-profile')
const argVal = (name) => {
  const i = ARGS.indexOf(name)
  return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : undefined
}

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const LIVE_PROFILES = join(DSH_HOME, 'profiles')
const DEFAULT_PROFILE_DIR = join(LIVE_PROFILES, 'web')
const NOTIFIER_PIN = '0.9.0'
const PLUGIN_NAME = 'dsh-tingxue'
const PATCH_REL = 'patches/dsh-notifier.patch'

const findings = []
const ok = (id, title, detail = '') => findings.push({ id, level: 'ok', title, detail })
const warn = (id, title, detail = '') => findings.push({ id, level: 'warn', title, detail })
const fail = (id, title, detail = '') => findings.push({ id, level: 'fail', title, detail })

// ---------- 纯函数（导出供测试直接调用） ----------

function readJson(file) {
  try { return { value: JSON.parse(readFileSync(file, 'utf8')), error: null } } catch (e) { return { value: null, error: e } }
}

/**
 * 最小 YAML 扫描：只认顶层键与 `patchedDependencies:` 下的一层键值。
 * 刻意不引 YAML 依赖 —— 这个脚本要在「什么都没装」的环境里也能跑。
 *
 * `topKeys` 保持**去重后的**顺序（供报告展示），同时额外返回
 * `duplicateTopKeys` —— 同一个顶级键出现两次的形态正是真实踩过的坑：
 * YAML 规范下后一份会静默覆盖前一份，配置看着改了、实际没生效。
 * @param {string} text
 * @returns {{ topKeys: string[], patched: Record<string,string>, duplicateTopKeys: string[] }}
 */
function scanWorkspaceYaml(text) {
  const topKeys = []
  const patched = {}
  const seenTop = new Set()
  const duplicateTopKeys = []
  let inPatched = false
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || raw.trim() === '') continue
    const top = raw.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (top) {
      if (seenTop.has(top[1])) { if (!duplicateTopKeys.includes(top[1])) duplicateTopKeys.push(top[1]) } else { seenTop.add(top[1]); topKeys.push(top[1]) }
      inPatched = top[1] === 'patchedDependencies'
      continue
    }
    if (inPatched) {
      const m = raw.match(/^\s+([^\s:#]+):\s*(.+?)\s*$/)
      if (m) patched[m[1].replace(/^['"]|['"]$/g, '')] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
  return { topKeys, patched, duplicateTopKeys }
}

/** 从 profile 补丁 yml 里取配置项（简单键匹配，不引 YAML 依赖）。 */
function readProfileConfig(text) {
  const get = (k) => {
    const m = text.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm'))
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : undefined
  }
  return { dataDir: get('dataDir'), profilePath: get('profilePath') }
}

/**
 * 收集配置文本里所有「不应进仓库」的凭据字面量。
 * **只返回字面量用于比对，调用方负责永不打印它们。**
 * @param {string} text
 * @returns {string[]}
 */
function collectSecretLiterals(text) {
  const out = new Set()
  const re = /^\s*(appSecret|app_secret|apiKey|api_key|accessToken|access_token|token|secret|password)\s*:\s*["']?([^"'\s#]+)["']?\s*$/gim
  let m
  while ((m = re.exec(text)) !== null) if (m[2] && m[2].length >= 8) out.add(m[2])
  return [...out]
}

// ---------- 迷你 YAML 子集：解析 / 序列化（零依赖） ----------
//
// 为什么不用现成 YAML 库：本脚本的定位是「装完的第一条命令」，要在**什么都还没装**
// 的环境里跑得起来。引 `js-yaml` 会让它在干净环境里直接 ERR_MODULE_NOT_FOUND ——
// 一个「装不上依赖就跑不了的自检」是自相矛盾的。
//
// 覆盖 `pnpm-workspace.yaml` 与 `cordis.patch.yml` 实际用到的子集：
//   块映射 / 块序列 / 二者互相嵌套 / 标量原样保留（含引号与 flow `[...]`）。
// 注释与空行作为「前置琐碎内容」挂在紧邻的 token 上，重新序列化时原样吐回。
//
// 关键：**结构性问题必须报错，不能猜**。以下三种一律视为不合法：
//   ① 缩进里出现 Tab（YAML 明确禁止）；
//   ② 子级缩进没有比父级深，或同级没对齐；
//   ③ flow 集合的括号不闭合。
// 重复键**不抛**而是收集进 `duplicates` —— 那正是本项目真实踩过的形态
// （同一个顶级键写两遍，后一份静默覆盖前一份，配置看起来"改了却没生效"），
// 调用方需要把它**报红**而不是让解析中断。

/** 结构性 YAML 错误：不合法就是不合法，不接受"尽力猜"。 */
class YamlStructureError extends Error {}

/** 空行或整行注释：不参与解析，只作为前置琐碎内容保留。 */
function isYamlTrivia(line) {
  return line.trim() === '' || /^\s*#/.test(line)
}

/** 剥掉成对的引号（顶层键名与标量值都可能带引号）。 */
function unquote(s) {
  return String(s).replace(/^['"]|['"]$/g, '')
}

/** flow 集合括号闭合检查（只对以 `[` / `{` 开头的标量做，且尊重引号）。 */
function checkFlowBalance(raw, lineNo) {
  const s = raw.trim()
  if (!/^[[{]/.test(s)) return
  let depth = 0
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote !== null) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') { depth--; if (depth < 0) throw new YamlStructureError(`第 ${lineNo} 行：flow 集合括号不闭合（多了一个 ] 或 }）`) }
  }
  if (depth !== 0) throw new YamlStructureError(`第 ${lineNo} 行：flow 集合括号不闭合（少了一个 ] 或 }）`)
}

/**
 * 切成 token：丢掉空行/注释/文档标记，但把刚丢掉的那一段挂到下一个 token 的
 * `leading` 上，序列化时按原顺序吐回。
 */
function tokenizeYamlSubset(text) {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const tokens = []
  let pending = []
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    if (isYamlTrivia(line) || /^\s*---\s*$/.test(line) || /^\s*\.\.\.\s*$/.test(line)) { pending.push(line); continue }
    const lead = line.match(/^[ \t]*/)[0]
    if (lead.includes('\t')) throw new YamlStructureError(`第 ${n + 1} 行：缩进里出现 Tab（YAML 禁止用 Tab 缩进；请改成空格）`)
    tokens.push({ line: n + 1, indent: lead.length, text: line.slice(lead.length), leading: pending })
    pending = []
  }
  return { tokens, trailing: pending }
}

const YAML_KEY_RE = /^([^:\s][^:]*?):(?:\s+(.*))?$/
const YAML_SEQ_RE = /^-(\s|$)/

/**
 * 解析 YAML 子集，返回 `{ doc, duplicates, trailing }`。
 * `duplicates` 里的 `level === 'top'` 就是「同一个顶级键出现了两次以上」。
 * @throws {YamlStructureError} 结构性错误
 */
function parseYamlSubset(text) {
  const { tokens, trailing } = tokenizeYamlSubset(text)
  const duplicates = []
  let pos = 0

  const recordDup = (key, scope, line) => {
    duplicates.push({ key, scope, level: scope === 'root' ? 'top' : 'nested', path: scope === 'root' ? key : `${scope}.${key}`, line })
  }

  function parseMap(indent, scope, seen = new Set()) {
    const node = { kind: 'map', entries: [] }
    while (pos < tokens.length) {
      const t = tokens[pos]
      if (t.indent < indent) break
      if (t.indent > indent) throw new YamlStructureError(`第 ${t.line} 行：缩进深度 ${t.indent}，但同一层级的键在 ${indent}（同级必须对齐）`)
      if (YAML_SEQ_RE.test(t.text)) break
      const m = t.text.match(YAML_KEY_RE)
      if (m === null) throw new YamlStructureError(`第 ${t.line} 行：既不是键值对也不是序列项 —— ${JSON.stringify(t.text.slice(0, 40))}`)
      const key = m[1]
      const rest = m[2]
      if (seen.has(key)) recordDup(key, scope, t.line)
      seen.add(key)
      pos++
      let value
      if (rest === undefined || rest.trim() === '') {
        value = (pos < tokens.length && tokens[pos].indent > indent)
          ? parseNode(indent + 1, scope === 'root' ? key : `${scope}.${key}`)
          : { kind: 'null' }
      } else {
        const raw = rest.trim()
        checkFlowBalance(raw, t.line)
        value = { kind: 'scalar', raw }
      }
      node.entries.push({ key, value, leading: t.leading })
    }
    return node
  }

  function parseSeq(indent, scope) {
    const node = { kind: 'seq', items: [] }
    while (pos < tokens.length) {
      const t = tokens[pos]
      if (t.indent < indent) break
      if (t.indent > indent) throw new YamlStructureError(`第 ${t.line} 行：序列项缩进 ${t.indent}，但同级项在 ${indent}（同级必须对齐）`)
      if (!YAML_SEQ_RE.test(t.text)) break
      const rest = t.text.replace(/^-\s*/, '').trim()
      pos++
      let value
      if (rest === '') {
        value = (pos < tokens.length && tokens[pos].indent > indent) ? parseNode(indent + 1, scope) : { kind: 'null' }
      } else {
        const km = rest.match(YAML_KEY_RE)
        if (km === null) {
          checkFlowBalance(rest, t.line)
          value = { kind: 'scalar', raw: rest }
        } else {
          // 序列项内联映射：第一对键值就在 `- ` 这行，后续键在更深的缩进上
          const seen = new Set()
          const key = km[1]
          seen.add(key)
          const inlineRest = km[2]
          let v1
          if (inlineRest === undefined || inlineRest.trim() === '') {
            v1 = (pos < tokens.length && tokens[pos].indent > indent) ? parseNode(indent + 1, scope) : { kind: 'null' }
          } else {
            checkFlowBalance(inlineRest.trim(), t.line)
            v1 = { kind: 'scalar', raw: inlineRest.trim() }
          }
          const entries = [{ key, value: v1, leading: t.leading }]
          if (pos < tokens.length && tokens[pos].indent > indent) {
            const more = parseMap(tokens[pos].indent, scope, seen)
            for (const e of more.entries) entries.push(e)
          }
          value = { kind: 'map', entries }
        }
      }
      node.items.push({ value, leading: t.leading })
    }
    return node
  }

  function parseNode(minIndent, scope) {
    const t = tokens[pos]
    if (t === undefined || t.indent < minIndent) return { kind: 'null' }
    return YAML_SEQ_RE.test(t.text) ? parseSeq(t.indent, scope) : parseMap(t.indent, scope)
  }

  const doc = parseNode(0, 'root')
  return { doc, duplicates, trailing }
}

/** 把解析出来的树吐回文本（注释与空行按原位置保留）。 */
function emitYamlSubset(doc, trailing = []) {
  const out = []
  const trivia = (leading) => { for (const l of leading) out.push(l) }

  const emitMap = (node, indent) => {
    const pad = ' '.repeat(indent)
    for (const e of node.entries) {
      trivia(e.leading)
      if (e.value.kind === 'map') {
        if (e.value.entries.length === 0) { out.push(`${pad}${e.key}: {}`); continue }
        out.push(`${pad}${e.key}:`)
        emitMap(e.value, indent + 2)
      } else if (e.value.kind === 'seq') {
        if (e.value.items.length === 0) { out.push(`${pad}${e.key}: []`); continue }
        out.push(`${pad}${e.key}:`)
        emitSeq(e.value, indent + 2)
      } else if (e.value.kind === 'null') {
        out.push(`${pad}${e.key}:`)
      } else {
        out.push(`${pad}${e.key}: ${e.value.raw}`)
      }
    }
  }

  const emitSeq = (node, indent) => {
    const pad = ' '.repeat(indent)
    for (const it of node.items) {
      const v = it.value
      if (v.kind === 'scalar') { trivia(it.leading); out.push(`${pad}- ${v.raw}`); continue }
      if (v.kind !== 'map' || v.entries.length === 0) {
        trivia(it.leading)
        out.push(`${pad}-`)
        if (v.kind === 'seq' || v.kind === 'map') (v.kind === 'seq' ? emitSeq : emitMap)(v, indent + 2)
        continue
      }
      const first = v.entries[0]
      trivia(it.leading)
      if (first.value.kind === 'map' || first.value.kind === 'seq') {
        out.push(`${pad}- ${first.key}:`)
        ;(first.value.kind === 'seq' ? emitSeq : emitMap)(first.value, indent + 4)
      } else if (first.value.kind === 'null') {
        out.push(`${pad}- ${first.key}:`)
      } else {
        out.push(`${pad}- ${first.key}: ${first.value.raw}`)
      }
      emitMap({ kind: 'map', entries: v.entries.slice(1) }, indent + 2)
    }
  }

  if (doc.kind === 'seq') emitSeq(doc, 0)
  else if (doc.kind === 'map') emitMap(doc, 0)
  else if (doc.kind === 'scalar') out.push(doc.raw)
  trivia(trailing)
  return out.join('\n') + '\n'
}

/**
 * 结构校验（比正则严格）：能否解析 + 顶层是不是映射 + **有没有重复的顶级键**。
 * 修复后就是用它来决定「算不算修好了」，而不是再跑一遍正则。
 * @returns {{ok: boolean, error?: string, topKeys?: string[], duplicates?: Array}}
 */
function validateWorkspaceYaml(text) {
  let parsed
  try { parsed = parseYamlSubset(text) } catch (e) { return { ok: false, error: e.message } }
  if (parsed.doc.kind !== 'map') return { ok: false, error: `顶层不是映射（是 ${parsed.doc.kind}）` }
  const top = parsed.duplicates.filter((d) => d.level === 'top')
  if (top.length > 0) return { ok: false, error: `存在重复的顶级键：${top.map((d) => d.key).join('、')}` }
  return { ok: true, topKeys: parsed.doc.entries.map((e) => e.key), duplicates: parsed.duplicates }
}

/**
 * **解析 → 改映射 → 重新序列化**（不是字符串追加）。
 * 在既有的 `patchedDependencies` 映射里插入/更新 `name` 键，其余内容（含注释、
 * 别的包条目、别的顶级键）原样保留。
 *
 * 任何无法安全解析或安全改写的形态都返回 `ok:false` —— 调用方据此**拒绝修复并判 fail**。
 * 硬拼字符串的后果是「脚本报修复成功、配置却是坏的」，那比不修更糟。
 * @returns {{ok: boolean, text?: string, error?: string}}
 */
function wirePatchedDependency(text, name, rel) {
  let parsed
  try { parsed = parseYamlSubset(text) } catch (e) { return { ok: false, error: `解析失败：${e.message}` } }

  const topDups = parsed.duplicates.filter((d) => d.level === 'top')
  if (topDups.length > 0) {
    return { ok: false, error: `存在重复的顶级键（${topDups.map((d) => d.key).join('、')}）—— 重复键会静默覆盖前一份，必须先人工合并` }
  }
  const doc = parsed.doc
  if (doc.kind !== 'map') return { ok: false, error: `顶层不是映射（是 ${doc.kind}）` }

  const scalar = (v) => ({ kind: 'scalar', raw: v })
  const entry = doc.entries.find((e) => e.key === 'patchedDependencies')
  if (entry === undefined) {
    doc.entries.push({
      key: 'patchedDependencies', leading: [],
      value: { kind: 'map', entries: [{ key: name, value: scalar(rel), leading: [] }] },
    })
  } else if (entry.value.kind === 'map') {
    const hit = entry.value.entries.find((e) => e.key === name)
    if (hit === undefined) entry.value.entries.push({ key: name, value: scalar(rel), leading: [] })
    else hit.value = scalar(rel)
  } else if (entry.value.kind === 'null') {
    entry.value = { kind: 'map', entries: [{ key: name, value: scalar(rel), leading: [] }] }
  } else {
    return { ok: false, error: `patchedDependencies 不是映射（是 ${entry.value.kind}），拒绝改写` }
  }

  const out = emitYamlSubset(doc, parsed.trailing)
  // 写完立刻用同一套结构校验复验一遍：产物自己得先站得住，才谈得上交给 pnpm。
  const v = validateWorkspaceYaml(out)
  if (!v.ok) return { ok: false, error: `改写后的产物结构校验未通过：${v.error}` }
  return { ok: true, text: out }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 递归列相对路径（跳过 node_modules/.git/.cache），用于运行副本一致性对比。 */
function walk(dir, base = dir, acc = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', '.git', '.cache', 'artifacts'].includes(e.name)) continue
      walk(p, base, acc)
    } else if (e.isFile()) {
      acc.push(p.slice(base.length).replace(/\\/g, '/').replace(/^\//, ''))
    }
  }
  return acc.sort()
}

/** 找 npm CLI 的 js 入口：Windows 上 npm.cmd 无法被 execFile 直接 spawn（EINVAL）。 */
function npmCliPath() {
  const cands = [
    process.env.npm_execpath && /npm[\\/]bin[\\/]npm-cli\.js$/.test(process.env.npm_execpath) ? process.env.npm_execpath : null,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  for (const c of cands) if (existsSync(c)) return c
  return null
}

/**
 * 找 pnpm 的 js 入口（`.mjs`）。同理：Windows 上 `pnpm.CMD` 不能被 execFile 直接
 * spawn（EINVAL），必须走 node + js 入口。
 *
 * 用途只有一个：`--self-test` 里验证「修复产物能被 pnpm 真正解析接受」。
 * 主校验流程**绝不调用 pnpm** —— 那是会改变环境的动作，交回使用者的手。
 */
function pnpmCliPath() {
  const cands = [
    process.env.pnpm_execpath && /\.(mjs|cjs|js)$/.test(process.env.pnpm_execpath) ? process.env.pnpm_execpath : null,
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs') : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'pnpm', 'pnpm.mjs') : null,
    join(dirname(process.execPath), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
  ].filter(Boolean)
  for (const c of cands) if (existsSync(c)) return c
  // 退路：pnpm 在 PATH 上但入口是 .CMD（Windows）→ 交给 shell 解析
  return null
}

/**
 * 跑一次 pnpm，返回 `{ ok, code, out, error }`。
 *
 * 【两个必须记住的 Windows 事实，这里都踩过】
 * 1. **必须 `node <pnpm.mjs>`，不能直接 spawn 那个 .mjs**。直接 spawn 会得到
 *    `EFTYPE`（`.mjs` 不是可执行映像），而不是一个有输出的失败。
 * 2. 因此**绝不能让调用方用「输出里没有坏关键字」当判据**：spawn 失败时
 *    输出是空串，`!/坏关键字/.test('')` 恒为真 —— 断言就成了恒真的（和 R2-F1 同类）。
 *    所以这里把「到底跑起来了没有」显式返回给调用方去断言。
 */
function runPnpm(args, cwd, timeout = 240000) {
  const pnpm = pnpmCliPath()
  if (pnpm === null) return { ok: false, code: null, out: '', error: 'PATH 上找不到 pnpm 的 js 入口' }
  try {
    const out = execFileSync(process.execPath, [pnpm, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, windowsHide: true,
    })
    return { ok: true, code: 0, out, error: null }
  } catch (e) {
    // EFTYPE / ENOENT 这类是 spawn 层失败：不是「pnpm 拒绝了这个产物」，必须区分开
    const spawnFailed = e.status === null || e.status === undefined
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    return {
      ok: false,
      code: spawnFailed ? null : e.status,
      out,
      error: spawnFailed ? `pnpm 进程没能启动：${e.code ?? ''} ${e.message}` : null,
    }
  }
}

/** 一个路径是否落在活 profile 树里（= 必须只读的地方）。 */
function isLiveProfilePath(p, liveRoot = LIVE_PROFILES) {
  const a = resolve(p).toLowerCase()
  const b = resolve(liveRoot).toLowerCase()
  return a === b || a.startsWith(b + '\\') || a.startsWith(b + '/')
}

// ---------- 各项检查 ----------

/** C1：插件仓库自身必须声明 dsh.bundle，且有 files 白名单。 */
function checkRepoSelf(ctx) {
  const f = join(ctx.repoDir, 'package.json')
  if (!existsSync(f)) { fail('C1', '插件仓库 package.json 缺失', f); return }
  const { value: pkg, error } = readJson(f)
  if (error) { fail('C1', '插件仓库 package.json 无法解析', error.message); return }
  const declared = pkg?.dsh?.bundle?.patch
  if (declared === undefined) {
    fail('C1', `插件未声明 dsh.bundle`, 'profile 会把它当普通依赖装进来 → 已安装，未生效')
  } else if (!existsSync(join(ctx.repoDir, declared))) {
    fail('C1', 'dsh.bundle.patch 指向的文件不存在', declared)
  } else {
    ok('C1', '插件声明了 dsh.bundle', `patch=${declared}`)
  }
  if (!Array.isArray(pkg?.files) || pkg.files.length === 0) {
    fail('C1-files', 'package.json 缺 files 白名单', '.gitignore 拦不住 npm 打包，files 才是权威')
  } else {
    ok('C1-files', 'files 白名单已声明', `${pkg.files.length} 项：${pkg.files.join(' / ')}`)
  }
}

/** C2：profile 的 dsh.profile.bundles 必须列上插件 —— 漏了就是「已安装，未生效」。 */
function checkBundleListed(ctx) {
  const f = join(ctx.profileDir, 'package.json')
  if (!existsSync(f)) { fail('C2', 'profile package.json 缺失', f); return }
  const { value: pkg, error } = readJson(f)
  if (error) { fail('C2', 'profile package.json 无法解析', error.message); return }
  const bundles = pkg?.dsh?.profile?.bundles
  const deps = pkg?.dependencies ?? {}
  if (!Array.isArray(bundles)) {
    fail('C2', 'profile 没有 dsh.profile.bundles', '插件无法成为 patch 层，等于没装')
    return
  }
  if (!(ctx.pluginName in deps)) warn('C2-dep', `profile 依赖里没有 ${ctx.pluginName}`, '还没装；先 add 再跑本脚本')
  if (bundles.includes(ctx.pluginName)) {
    ok('C2', '插件已在 dsh.profile.bundles 名单里', `bundles 共 ${bundles.length} 项`)
    return
  }
  fail('C2', '插件不在 dsh.profile.bundles 名单里 —— 会得到「已安装，未生效」',
    `bundles=[${bundles.join(', ')}]；需补 "${ctx.pluginName}"`)
  ctx.fixes.push({
    id: 'C2', file: f, describe: `把 ${ctx.pluginName} 追加进 dsh.profile.bundles`,
    apply() {
      const cur = JSON.parse(readFileSync(f, 'utf8'))
      const prof = cur.dsh?.profile ?? {}
      cur.dsh = { ...(cur.dsh ?? {}), profile: { ...prof, bundles: [...(prof.bundles ?? []), ctx.pluginName] } }
      writeFileSync(f, JSON.stringify(cur, null, 2) + '\n', 'utf8')
    },
  })
}

/**
 * C3：dsh-notifier 必须钉死 0.9.0。
 * 补丁是**行号 hunk**（`patches/dsh-notifier.patch` 26 KB，含上下文行），版本一升
 * 上下文必然移位 → `pnpm install` 直接失败。
 *
 * 严重度是按「**现在是不是真的坏了**」分级的，不是按「声明好不好看」：
 *   - 已安装的版本不是 0.9.0            → **fail**：补丁上下文此刻就错位，功能真的不在。
 *   - 声明没钉死 且 没有 lock 把它钉住   → **fail**：下一次 `pnpm install` 就会踩上。
 *   - 声明没钉死 但 lock 已钉在 0.9.0    → **warn**：今天不会炸，是**地雷**不是当下的火；
 *     换机器 / 删 lock / `pnpm update` 才会踩上。措辞里必须写清这一点。
 * 分级的理由是：把「lock 已经挡住的潜在问题」判成 fail，会在健康机器上长期留一条红，
 * 最后训练出「这条红忽略掉」——那比不检查更糟。
 */
function checkNotifierPin(ctx) {
  const f = join(ctx.profileDir, 'package.json')
  if (!existsSync(f)) return
  const { value: pkg } = readJson(f)
  const spec = pkg?.dependencies?.['dsh-notifier']
  if (spec === undefined) { warn('C3', 'profile 未依赖 dsh-notifier', '不用 QQ 通道可忽略；要用则必须先装并钉版本'); return }

  const instManifest = join(ctx.profileDir, 'node_modules', 'dsh-notifier', 'package.json')
  const instVer = existsSync(instManifest) ? readJson(instManifest).value?.version : undefined
  const lockFile = join(ctx.profileDir, 'pnpm-lock.yaml')
  let lockPins = false
  if (existsSync(lockFile)) {
    try { lockPins = /^\s{2}dsh-notifier@0\.9\.0:/m.test(readFileSync(lockFile, 'utf8')) } catch { /* 忽略 */ }
  }
  const lockNote = lockPins
    ? '；pnpm-lock.yaml 目前把它钉在 0.9.0，所以本机今天不会立刻炸 —— 换机器 / 删 lock / pnpm update 才会踩上'
    : ''

  const addPinFix = () => ctx.fixes.push({
    id: 'C3', file: f, describe: `把 dsh-notifier 的依赖声明改成 ${NOTIFIER_PIN}（不是 ^${NOTIFIER_PIN}）`,
    apply() {
      const cur = JSON.parse(readFileSync(f, 'utf8'))
      cur.dependencies = { ...cur.dependencies, 'dsh-notifier': NOTIFIER_PIN }
      writeFileSync(f, JSON.stringify(cur, null, 2) + '\n', 'utf8')
    },
  })

  // 【两条轴独立判定，不再用 else if 串起来】
  //
  // 旧写法把「已安装版本」挂在 `else if` 上，于是**只要声明已经钉死就永远不检查装进来的
  // 实际版本** —— 而那恰恰是最危险的一格：声明写着 0.9.0，node_modules 里却是 0.12.0，
  // 补丁的行号上下文此刻就错位了，却被判成 ok。两条轴回答的是不同问题：
  //   - 轴 A（instVer）：「现在这一刻坏没坏」—— 装了 ≠ 0.9.0 就是当下的火，与声明无关。
  //   - 轴 B（spec）  ：「未来会不会坏」  —— 没钉死是地雷，有 lock 挡住就降级为 warn。
  // 因此先判 A 再判 B，两者都错就两条都报。
  const instWrong = instVer !== undefined && instVer !== NOTIFIER_PIN

  if (instWrong) {
    fail('C3', `已安装的 dsh-notifier 是 ${instVer}，不是 ${NOTIFIER_PIN}`, '补丁上下文此刻就错位了 —— 这就是当下的火，不是地雷；声明再怎么钉死也救不了已经装错的那一份')
  }

  if (spec !== NOTIFIER_PIN) {
    if (lockPins) {
      warn('C3', `dsh-notifier 声明成 "${spec}"（未钉死 ${NOTIFIER_PIN}），但 lock 暂时挡住了`, `补丁带行号 hunk，升级后 pnpm 会直接失败${lockNote}`)
    } else {
      fail('C3', `dsh-notifier 没有钉死 ${NOTIFIER_PIN}`, `当前声明 "${spec}"；补丁带行号 hunk，升级后 pnpm 会直接失败，且没有任何 lock 把它钉住`)
    }
    addPinFix()
  }

  if (!instWrong && spec === NOTIFIER_PIN) {
    ok('C3', `dsh-notifier 钉在 ${NOTIFIER_PIN}`, instVer ? `已安装 ${instVer}` : '（尚未落到 node_modules）')
  }
  if (!instWrong && instVer === undefined && spec !== NOTIFIER_PIN) {
    // 没装就没有「当下的火」，但地雷仍需上面的 warn/fail 说明；这里不额外报 ok。
  }
}

/** C4：补丁接线（pnpm-workspace.yaml 的 patchedDependencies）+ 是否真的生效。 */
function checkPatchWiring(ctx) {
  const wsFile = join(ctx.profileDir, 'pnpm-workspace.yaml')
  const pkgFile = join(ctx.profileDir, 'package.json')

  // 「补丁声明在哪」本身是一条坑：它不在 profile 的 package.json 里。
  if (existsSync(pkgFile) && /patchedDependencies/.test(readFileSync(pkgFile, 'utf8'))) {
    warn('C4-loc', 'patchedDependencies 出现在 profile 的 package.json 里', 'pnpm 只认 pnpm-workspace.yaml；放错位置等于没接线')
  }

  if (!existsSync(wsFile)) {
    fail('C4', 'profile 没有 pnpm-workspace.yaml', '补丁无处可接线 → 补丁文件在磁盘上也不会生效')
    // 创建时必须写**与文档一致的完整工作区配置**。旧版只写
    // `packages` + `patchedDependencies`，漏掉 `nodeLinker: hoisted` —— 而 profile 的
    // 运行副本是「真实目录拷贝」这件事**正依赖 hoisted**；照旧版创建会得到一个
    // 结构上"接线成功"、实际布局语义不对的工作区。
    const scaffold = [
      'packages:',
      '  - .',
      '',
      '# 下面这条不是可选项：profile 的运行副本靠 hoisted 布局才是真实目录拷贝。',
      'nodeLinker: hoisted',
      '',
      'patchedDependencies:',
      `  dsh-notifier: ${PATCH_REL}`,
      '',
    ].join('\n')
    const built = validateWorkspaceYaml(scaffold)
    if (!built.ok) {
      // 连自己生成的模板都过不了结构校验 → 绝不写盘，只给人工指引
      ctx.fixes.push({
        id: 'C4-ws', file: wsFile, manual: true,
        describe: '（不能自动创建）请手工创建 pnpm-workspace.yaml：见 README §安装 的工作区配置片段',
        apply() { throw new Error('C4-ws 模板自校验未通过，拒绝写入') },
      })
    } else {
      ctx.fixes.push({
        id: 'C4-ws', file: wsFile,
        describe: `创建 pnpm-workspace.yaml（含 nodeLinker: hoisted）并把 dsh-notifier 接线到 ${PATCH_REL}`,
        apply() { writeFileSync(wsFile, scaffold, 'utf8') },
      })
    }
  } else {
    const wsText = readFileSync(wsFile, 'utf8')
    const scan = scanWorkspaceYaml(wsText)

    // 重复的顶级键：YAML 后一份静默覆盖前一份。这正是「配置明明改了却没生效」的成因，
    // 且下面那条「已接线」的正则判定会被它骗过去 —— 所以必须单独报红。
    if (scan.duplicateTopKeys.length > 0) {
      const dup = scan.duplicateTopKeys.join('、')
      const bad = scan.duplicateTopKeys.includes('patchedDependencies')
      const msg = `顶级键 ${dup} 出现了两次以上；YAML 会用后一份静默覆盖前一份，配置看起来改了却不生效`
      if (bad) fail('C4', `pnpm-workspace.yaml 有重复的顶级键（${dup}）`, msg)
      else warn('C4-dup', `pnpm-workspace.yaml 有重复的顶级键（${dup}）`, msg)
    }

    const declaredPatch = scan.patched['dsh-notifier']
    if (declaredPatch === undefined) {
      fail('C4', 'pnpm-workspace.yaml 的 patchedDependencies 没接线 dsh-notifier', '接完必须再 pnpm install 才生效')
      // 【不再字符串追加】解析 → 在既有映射里插入/更新 → 重新序列化。
      const wired = wirePatchedDependency(wsText, 'dsh-notifier', PATCH_REL)
      if (!wired.ok) {
        // 无法安全解析/改写 → **拒绝修复**，并把原因说清楚（硬拼会写出坏配置还报成功）
        warn('C4-manual', '不能自动接线：这个 pnpm-workspace.yaml 无法安全解析改写', `${wired.error} —— 请手工在 patchedDependencies 下加一行 dsh-notifier: ${PATCH_REL}`)
      } else {
        ctx.fixes.push({
          id: 'C4', file: wsFile,
          describe: `解析后在 patchedDependencies 映射里插入 dsh-notifier: ${PATCH_REL}（重新序列化，不硬拼）`,
          apply() {
            const cur = readFileSync(wsFile, 'utf8')
            const r = wirePatchedDependency(cur, 'dsh-notifier', PATCH_REL)
            if (!r.ok) throw new Error(`C4 改写失败：${r.error}`)
            // 写盘前最后一道：产物必须过结构校验，且必须真的带上接线。
            const v = validateWorkspaceYaml(r.text)
            if (!v.ok) throw new Error(`C4 产物结构校验未通过：${v.error}`)
            if (scanWorkspaceYaml(r.text).patched['dsh-notifier'] === undefined) throw new Error('C4 产物里没有接线 dsh-notifier')
            writeFileSync(wsFile, r.text, 'utf8')
          },
        })
      }
    } else if (!existsSync(join(ctx.profileDir, declaredPatch))) {
      fail('C4', 'patchedDependencies 指向的补丁文件不存在', `${declaredPatch} 不在 ${ctx.profileDir}`)
    } else {
      ok('C4', '补丁已接线', `patchedDependencies.dsh-notifier = ${declaredPatch}（${statSync(join(ctx.profileDir, declaredPatch)).size} B）`)
    }
  }

  // 是否**真的生效**：看安装产物里的补丁标记。没有 node_modules 时无从判断（不算失败）。
  const notifierDir = join(ctx.profileDir, 'node_modules', 'dsh-notifier')
  if (!existsSync(notifierDir)) {
    warn('C4-applied', 'dsh-notifier 尚未落到 node_modules', '装完补丁才能验证生效；此时无从判断')
    return
  }
  const markerSeg = join(notifierDir, 'src', 'inbound', '_qq-segment.mjs')
  const markerMsg = join(notifierDir, 'src', 'inbound', 'message.mjs')
  const segOk = existsSync(markerSeg)
  const fileOk = existsSync(markerMsg) && readFileSync(markerMsg, 'utf8').includes('parseQQFileAttachments')
  if (segOk && fileOk) {
    ok('C4-applied', '补丁确实生效了', '_qq-segment.mjs 在，且 message.mjs 含 parseQQFileAttachments')
  } else {
    const missing = [!segOk && '_qq-segment.mjs 不存在', !fileOk && 'message.mjs 里搜不到 parseQQFileAttachments'].filter(Boolean)
    fail('C4-applied', '补丁没有生效（文件在磁盘上但没被应用）', `${missing.join('；')} —— 接线后必须再跑一次 pnpm install`)
  }
}

/**
 * C9：profile 的 `cordis.patch.yml` 是不是**结构上能解析**。
 *
 * 为什么单列这一条：C1-C8 判的都是「某个功能会不会静默失效」，而这一条判的是
 * 「**整个 profile 起不起得来**」。`cordis.patch.yml` 是 cordis 加载 profile 时
 * 第一个读的文件，它一旦解析不了，不是某个插件不生效，而是**DSH 直接起不来** ——
 * 严重度高于其余任何一条。
 *
 * 结构性错误（Tab 缩进、同级没对齐、括号不闭合、重复顶级键）在这个迷你解析器里
 * 一律能定位到行号。真正的 YAML 库能查出更多语义问题，但**零依赖**是这个脚本的
 * 硬约束（它要在「什么都没装」的环境里跑），所以这里覆盖的是真实会踩的那几类。
 *
 * 用 `readProfileConfig` 的正则会话读不出这类问题：正则只会「找不到键就当没配」，
 * 于是坏文件被静默放过 —— 那正是本任务要消灭的形态。
 */
function checkProfileYaml(ctx) {
  const file = join(ctx.profileDir, 'cordis.patch.yml')
  if (!existsSync(file)) {
    warn('C9', 'profile 没有 cordis.patch.yml', '插件补丁无处生效；若本就无需补丁可忽略')
    return
  }
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) {
    fail('C9', 'profile 的 cordis.patch.yml 读不出来', String(e.message))
    return
  }

  let parsed
  try { parsed = parseYamlSubset(text) } catch (e) {
    fail('C9', 'profile 的 cordis.patch.yml 解析不了（整个 profile 起不来）',
      `${e.message} —— 这比任何单条功能失效都严重：DSH 加载 profile 时会直接失败`)
    return
  }

  // cordis 的 patch 文件是**补丁项数组**（每项 - id: xxx）。不是数组就是给错了文件。
  if (parsed.doc.kind !== 'seq') {
    fail('C9', 'profile 的 cordis.patch.yml 不是补丁项数组',
      `顶层解析出来是 ${parsed.doc.kind}，但 cordis 期待的是「- id: ...」的数组；请确认没有把别的文件拷成这个名字`)
    return
  }

  // 同一个映射里出现两次同名键 —— 这是真正的 YAML 结构性错误（后一份静默覆盖前一份）。
  //
  // 【刻意不检查「同一个 id 在数组里出现两次」】：那**不是**错误。cordis 的 patch 列表
  // 本身就是「对同一插件按顺序施加多条补丁操作」的语义（本机活配置里 dsh-tingxue 就
  // 既有带 config 的一项、又有一项只带 disabled）。把重复 id 判红，会在**健康的机器上
  // 长期挂一条红** —— 一条永远挂着的红等于没红，那比不检查更糟。所以只记进 detail
  // 作事实陈述，不作判定。
  if (parsed.duplicates.length > 0) {
    const d = parsed.duplicates.map((x) => `${x.path}（第 ${x.line} 行）`).join('、')
    fail('C9', 'profile 的 cordis.patch.yml 有重复的映射键',
      `${d} —— 同一个映射里同名键出现两次，后一份会静默覆盖前一份，配置看起来改了却不生效`)
    return
  }

  const ids = []
  for (const it of parsed.doc.items) {
    if (it.value.kind !== 'map') continue
    const idEntry = it.value.entries.find((e) => e.key === 'id')
    if (idEntry === undefined || idEntry.value.kind !== 'scalar') continue
    ids.push(unquote(idEntry.value.raw))
  }
  const repeats = ids.filter((id, i) => ids.indexOf(id) !== i)
  const repeatNote = repeats.length > 0
    ? `；其中 ${[...new Set(repeats)].join('、')} 有多条补丁项（cordis 按顺序施加，属正常语义）`
    : ''
  ok('C9', 'profile 的 cordis.patch.yml 结构可解析', `${ids.length} 个补丁项${repeatNote}`)
}

/** 取某个文件在 HEAD 里的内容（不存在或不是 git 仓库时返回 null）。 */
function headBlob(repoDir, rel) {
  try {
    return execFileSync('git', ['-C', repoDir, 'show', `HEAD:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  } catch { return null }
}

/** 仓库是不是一个可用的 git 工作树（决定能否做「已提交 vs 在制品」的分类）。 */
function isGitRepo(repoDir) {
  try {
    execFileSync('git', ['-C', repoDir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, windowsHide: true })
    return true
  } catch { return false }
}

/**
 * C5：运行副本与仓库源码是否一致。
 * 关键事实：profile 用 `file:` 协议 + `nodeLinker: hoisted`，运行副本是**真实目录拷贝
 * 不是 junction** → **改仓库不会自动生效**。这是本项目最隐蔽的失效模式。
 *
 * 比对范围不止 `src/`：`client/client.js`（浏览器半侧）与 `cordis.patch.yml` 同样是
 * 「进程/页面启动时加载」的，漏同步同样静默。
 *
 * 严重度按「**交付态是否自洽**」分级，避免在多人并行改代码时长期挂一条红：
 *   - 运行副本 == 仓库工作树                          → **ok**
 *   - 差异**全部**是未提交的在制品（运行副本 == HEAD）  → **warn**：已提交的那份与运行
 *     副本一致，交付态没坏；但在制品**要生效必须先同步 + 重启 DSH**。
 *   - 存在已提交却没同步的文件（或副本是杂的）          → **fail**：跑的就是旧代码。
 * 不是 git 仓库时无法区分，按**保守**处理（一律 fail）——宁可多报，不可漏报。
 */
function checkRuntimeCopy(ctx) {
  const rtDir = join(ctx.profileDir, 'node_modules', ctx.pluginName)
  if (!existsSync(rtDir)) { warn('C5', '运行副本不存在', `${rtDir}；插件还没装或装到别处`); return }
  let isLink = false
  try { isLink = lstatSync(rtDir).isSymbolicLink() } catch { /* 忽略 */ }
  if (!existsSync(join(rtDir, 'src')) || !existsSync(join(ctx.repoDir, 'src'))) {
    warn('C5', '运行副本或仓库缺 src/', join(rtDir, 'src'))
    return
  }

  const SINGLE = ['cordis.patch.yml']
  const changed = []   // 两边都有、内容不同（单文件用 rel 本身，manifest 带 (字段) 后缀）
  const missing = []   // 仓库有、运行副本没有
  let compared = 0

  for (const relDir of ['src', 'client']) {
    const a = join(rtDir, relDir)
    const b = join(ctx.repoDir, relDir)
    if (!existsSync(a) || !existsSync(b)) continue
    const aSet = new Set(walk(a))
    for (const f of walk(b)) {
      if (!aSet.has(f)) { missing.push(`${relDir}/${f}`); continue }
      compared++
      if (sha256(join(b, f)) !== sha256(join(a, f))) changed.push(`${relDir}/${f}`)
    }
  }
  // 补丁层：改它同样要同步 + 重启
  for (const rel of SINGLE) {
    const a = join(rtDir, rel)
    const b = join(ctx.repoDir, rel)
    if (!existsSync(a) || !existsSync(b)) continue
    compared++
    if (sha256(b) !== sha256(a)) changed.push(rel)
  }
  // manifest 只比对**影响运行时的字段** —— 整体比对会被仓库 URL、files 顺序这类
  // 与运行无关的元数据差异长期点红，最后训练出「这条红忽略掉」，反而失效。
  {
    const a = join(rtDir, 'package.json')
    const b = join(ctx.repoDir, 'package.json')
    if (existsSync(a) && existsSync(b)) {
      compared++
      const ra = readJson(b).value
      const rb = readJson(a).value
      const RT_FIELDS = ['version', 'main', 'exports', 'dsh', 'dependencies', 'peerDependencies', 'engines', 'type']
      const drift = RT_FIELDS.filter((k) => JSON.stringify(ra?.[k] ?? null) !== JSON.stringify(rb?.[k] ?? null))
      if (drift.length > 0) changed.push(`package.json(${drift.join('/')})`)
    }
  }

  const brief = (a, n = 4) => a.slice(0, n).join('、') + (a.length > n ? '…' : '')
  if (missing.length === 0 && changed.length === 0) {
    ok('C5', '运行副本与仓库源码一致', `${compared} 个文件哈希全等（${isLink ? '符号链接' : '真实目录拷贝'}）`)
    if (!isLink) warn('C5-link', LINK_NOTE_TITLE, LINK_NOTE_DETAIL)
    return
  }

  // 分类：差异是不是**全是未提交的在制品**（即运行副本 == HEAD）
  const uncommitted = []   // 运行副本内容 == HEAD 的那份
  const realDrift = changed.filter((rel) => {
    const bare = rel.replace(/\(.*\)$/, '')
    const rt = join(rtDir, bare)
    if (!existsSync(rt)) return true
    const head = headBlob(ctx.repoDir, bare)
    if (head === null) return true          // 不在 HEAD 里（工作树新增/改名）→ 按真漂移算
    try { const same = readFileSync(rt, 'utf8') === head; if (same) uncommitted.push(rel); return !same } catch { return true }
  })

  const newInWorktree = []   // 工作树新增、未提交
  const newCommitted = []    // 已提交、运行副本没有
  for (const rel of missing) {
    const head = headBlob(ctx.repoDir, rel)
    const rt = join(rtDir, rel)
    if (head === null && !existsSync(rt)) newInWorktree.push(rel)
    else newCommitted.push(rel)
  }
  if (!ctx.isGitRepo) { realDrift.push(...uncommitted.splice(0), ...newInWorktree.splice(0)) }

  if (realDrift.length === 0 && newCommitted.length === 0) {
    warn('C5', '运行副本与仓库源码不一致，但差异全是未提交的在制品',
      `${uncommitted.length} 个文件是未提交改动${uncommitted.length ? `（${brief(uncommitted)}）` : ''}` +
      `${newInWorktree.length ? `；另有 ${newInWorktree.length} 个是工作树新增（${brief(newInWorktree, 3)}）` : ''}` +
      ' —— 已提交的那份与运行副本一致，交付态没坏；但这些改动**要生效必须先同步到运行副本 + 重启 DSH**（浏览器端还要硬刷新）')
  } else {
    fail('C5', '运行副本与仓库源码不一致 —— 改仓库不会自动生效',
      [
        realDrift.length ? `${realDrift.length} 个已提交/杂散的文件内容不同（${brief(realDrift)}）` : '',
        newCommitted.length ? `${newCommitted.length} 个已提交的新文件运行副本里没有（${brief(newCommitted, 3)}）` : '',
        uncommitted.length ? `另有 ${uncommitted.length} 个未提交改动` : '',
      ].filter(Boolean).join('；') + ' —— 同步后必须重启 DSH（浏览器端还要硬刷新）')
  }
  if (!isLink) warn('C5-link', LINK_NOTE_TITLE, LINK_NOTE_DETAIL)
}
const LINK_NOTE_TITLE = '运行副本是真实目录拷贝（不是 junction）'
const LINK_NOTE_DETAIL = 'profile 用 file: 协议 + nodeLinker: hoisted；仓库改动不会穿透，必须手工同步'

/**
 * C6：安全底线 —— 仓库里不得出现活配置的凭据明文；工作区必须干净。
 * 扫**所有被 git 跟踪的文件**（不是一份手写清单）：漏一个文件就是漏一个泄漏面。
 */
function checkRepoHygiene(ctx) {
  let tracked = null
  try {
    tracked = execFileSync('git', ['-C', ctx.repoDir, 'ls-files'], { encoding: 'utf8', timeout: 30000, windowsHide: true })
      .split('\n').map((l) => l.trim()).filter(Boolean)
  } catch (e) {
    warn('C6-git', '拿不到 git ls-files，改用固定清单', String(e.message).slice(0, 120))
  }
  const probe = (tracked ?? [
    '_profile-patch-backup.yml', 'cordis.patch.yml', 'package.json',
    'README.md', 'CHANGELOG.md', 'SECURITY.md',
    'scripts/install-check.mjs', 'scripts/selfcheck.mjs', 'test/install-check.test.mjs',
  ]).filter((rel) => {
    const p = join(ctx.repoDir, rel)
    try { return existsSync(p) && statSync(p).isFile() && statSync(p).size < 2 * 1024 * 1024 } catch { return false }
  })

  const hitFiles = []
  for (const rel of probe) {
    let text
    try { text = readFileSync(join(ctx.repoDir, rel), 'utf8') } catch { continue }
    if (ctx.secretLiterals.some((s) => text.includes(s))) hitFiles.push(rel)
  }
  if (ctx.secretLiterals.length === 0) {
    warn('C6-secret', '活配置里没扫到可比对的凭据字面量', '无法做「凭据是否泄进仓库」的比对')
  } else if (hitFiles.length === 0) {
    ok('C6-secret', '仓库里未出现活配置的凭据明文', `比对 ${ctx.secretLiterals.length} 个凭据字面量 × ${probe.length} 个跟踪文件，命中 0`)
  } else {
    fail('C6-secret', '仓库文件里出现了活配置的凭据明文', `命中文件：${[...new Set(hitFiles)].join('、')}`)
  }

  let porcelain = null
  try {
    porcelain = execFileSync('git', ['-C', ctx.repoDir, 'status', '--porcelain'], { encoding: 'utf8', timeout: 30000, windowsHide: true })
  } catch (e) {
    warn('C6-git', '拿不到 git status', String(e.message).slice(0, 120))
  }
  if (porcelain !== null) {
    const lines = porcelain.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) ok('C6-git', 'git 工作区干净', 'git status --porcelain 为空')
    else if (EXPECT_CLEAN_GIT) fail('C6-git', '工作区不干净', `${lines.length} 项：${lines.slice(0, 5).join(' | ')}`)
    else warn('C6-git', '工作区有未提交变更', `${lines.length} 项（未开 --expect-clean-git，不判失败）`)
  }

  // 本脚本自己绝不许往仓库写：C6-write 由测试在调用前后比对哈希完成。
  ok('C6-write', '本脚本对仓库只读（校验模式）', '--fix 只写 --profile-dir 指定的目录，且默认拒绝写活 profile')
}

/** C7：真实风险面在仓库外 —— 活 profile 配置（含 QQ appSecret）必须被识别并告警。 */
function checkLiveProfileSecrets(ctx) {
  const live = [join(ctx.profileDir, 'cordis.patch.yml'), join(ctx.profileDir, 'pnpm-workspace.yaml')]
  const hits = []
  for (const p of live) {
    if (!existsSync(p)) continue
    const n = collectSecretLiterals(readFileSync(p, 'utf8')).length
    if (n > 0) hits.push(`${basename(p)}(${n} 处)`)
  }
  if (hits.length === 0) {
    ok('C7', 'profile 配置里没扫到明文凭据字面量', '仍不要把它拷进仓库')
  } else {
    warn('C7', 'profile 配置里存在明文凭据 —— 真实风险面在仓库外',
      `${hits.join('、')}；这些文件绝不可拷进仓库或随包发布（仓库内 cordis.patch.yml 的相应字段必须是空值）`)
    ctx.liveSecretFiles = hits
  }
}

/** C8：npm pack 清单体检 —— `.gitignore` 拦不住打包，`files` 才是权威。 */
function checkPackList(ctx) {
  const npmCli = npmCliPath()
  if (!npmCli) { warn('C8', '找不到 npm CLI，跳过 pack 体检', 'node_modules/npm/bin/npm-cli.js 不存在'); return }
  let out
  try {
    out = execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
      cwd: ctx.repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000, windowsHide: true,
    })
  } catch (e) {
    warn('C8', 'npm pack --dry-run 失败，跳过', String(e.stderr ?? e.message ?? '').slice(0, 200))
    return
  }
  let parsed
  try { parsed = JSON.parse(out) } catch { warn('C8', 'npm pack 输出不是 JSON，跳过'); return }
  const meta = Array.isArray(parsed) ? parsed[0] : parsed
  const files = (meta?.files ?? []).map((f) => f.path)
  ctx.packFiles = files

  const allowedScripts = new Set(['scripts/selfcheck.mjs', 'scripts/install-check.mjs'])
  const bad = []
  const docFiles = files.filter((p) => p.endsWith('.md') && !['README.md', 'LICENSE', 'examples/README.md'].includes(p))
  if (docFiles.length) bad.push(`内部文档进包：${docFiles.join('、')}`)
  const junk = files.filter((p) => /\.(patch|bak|log|png|jpg|jpeg|webp|tmp|orig)$/i.test(p))
  if (junk.length) bad.push(`补丁/备份/日志/截图进包：${junk.join('、')}`)
  const tests = files.filter((p) => p.startsWith('test/') || p.startsWith('.github/'))
  if (tests.length) bad.push(`测试或 CI 文件进包：${tests.join('、')}`)
  const strayScripts = files.filter((p) => p.startsWith('scripts/') && !allowedScripts.has(p))
  if (strayScripts.length) bad.push(`白名单外的脚本进包：${strayScripts.join('、')}`)

  const secretInPack = ctx.secretLiterals.filter((s) => files.some((rel) => {
    const p = join(ctx.repoDir, rel)
    try { return existsSync(p) && statSync(p).size < 1024 * 1024 && readFileSync(p, 'utf8').includes(s) } catch { return false }
  }))
  if (secretInPack.length) bad.push('包里出现活配置的凭据明文')

  if (bad.length === 0) {
    ok('C8', 'npm pack 清单无泄漏', `${files.length} 个文件 / ${(meta?.size / 1024).toFixed(1)} kB 压缩 / ${(meta?.unpackedSize / 1024).toFixed(1)} kB 解压`)
  } else {
    fail('C8', 'npm pack 清单有问题', `${bad.join('；')} —— .gitignore 拦不住打包，要改 package.json 的 files`)
  }

  // 这条是「本脚本自己是否随包发布」的事实陈述，不做成败判定：
  // package.json 不在本次任务的 inScope 内，故不自动改 files。
  const selfShipped = files.includes('scripts/install-check.mjs')
  if (selfShipped) ok('C8-ship', 'install-check.mjs 随包发布', 'package.json 的 files 已含它')
  else warn('C8-ship', 'install-check.mjs 不在 npm 包里', 'package.json 的 files 白名单未收录它（本次任务 inScope 不含 package.json，故未自动改）；仓库使用者可直接运行')

  return { files, meta }
}

// ---------- 备份 / 回滚 ----------

/** 动手前备份：逐文件记住「原本是否存在 + 原始字节 + SHA256」。 */
function backupFiles(files) {
  const backups = new Map()
  for (const f of files) {
    backups.set(f, existsSync(f)
      ? { existed: true, bytes: readFileSync(f), hash: sha256(f) }
      : { existed: false, bytes: null, hash: null })
  }
  return backups
}

/** 逐字节回滚；原本不存在的文件被删除。返回每项的哈希核对结果。 */
function rollback(backups) {
  const results = []
  for (const [f, b] of backups) {
    try {
      if (b.existed) writeFileSync(f, b.bytes)
      else if (existsSync(f)) rmSync(f, { force: true })
      const after = existsSync(f) ? sha256(f) : null
      results.push({ file: f, restored: after === b.hash, before: b.hash, after })
    } catch (e) {
      results.push({ file: f, restored: false, before: b.hash, after: null, error: String(e.message) })
    }
  }
  return results
}

// ---------- 主流程 ----------

async function main() {
  const profileDir = resolve(argVal('--profile-dir') ?? DEFAULT_PROFILE_DIR)
  const repoDir = resolve(argVal('--repo-dir') ?? join(HERE, '..'))

  if (!existsSync(join(profileDir, 'package.json'))) {
    console.error(`install-check: ${profileDir} 不是 profile 目录（没有 package.json）`)
    process.exit(2)
  }
  if (resolve(profileDir) === resolve(repoDir)) {
    console.error(`install-check: --profile-dir 与 --repo-dir 是同一个目录（${profileDir}）；`
      + '插件仓库不是 profile，拒绝在这种配置下给结论')
    process.exit(2)
  }

  const patchFile = join(profileDir, 'cordis.patch.yml')
  const patchText = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''

  const ctx = {
    profileDir, repoDir, pluginName: PLUGIN_NAME,
    config: readProfileConfig(patchText),
    fixes: [],
    // 凭据字面量只在内存里用于比对，**永不出现在输出里**。
    secretLiterals: collectSecretLiterals(patchText),
    liveSecretFiles: [], packFiles: null,
    isGitRepo: isGitRepo(repoDir),
  }
  mainCtx = ctx

  checkRepoSelf(ctx)
  checkBundleListed(ctx)
  checkNotifierPin(ctx)
  checkPatchWiring(ctx)
  checkProfileYaml(ctx)
  checkRuntimeCopy(ctx)
  checkRepoHygiene(ctx)
  checkLiveProfileSecrets(ctx)
  if (!NO_PACK) checkPackList(ctx)

  // ---------- 修复 + 自动回滚 ----------
  let fixReport = null
  if (DO_FIX) {
    const liveLocked = ctx.fixes.filter((fx) => !ALLOW_LIVE && isLiveProfilePath(fx.file))
    // 标了 manual 的项**没有可自动执行的改法**（例如该文件无法安全解析改写）：
    // 它们只作人工指引列出，绝不能被当成「尝试修复」，否则 apply 抛错会把整批回滚掉。
    const manualOnly = ctx.fixes.filter((fx) => fx.manual === true && !liveLocked.includes(fx))
    const todo = ctx.fixes.filter((fx) => !liveLocked.includes(fx) && fx.manual !== true)
    if (todo.length === 0) {
      fixReport = {
        attempted: false, applied: [], rolledBack: false,
        reason: liveLocked.length
          ? '所有可修项都位于活 profile，未给 --allow-live-profile，拒绝写入（活状态只读）'
          : manualOnly.length
            ? '仅有的人工项无法自动执行，见下方指引'
            : '没有可自动修复的项',
        skipped: liveLocked.map((f) => f.id),
        manual: manualOnly.map((f) => ({ id: f.id, file: f.file, describe: f.describe })),
      }
    } else {
      const backups = backupFiles([...new Set(todo.map((fx) => fx.file))])
      const applied = []
      const pristine = [...findings]   // 修复前的原始判定；回滚后原样恢复
      try {
        for (const fx of todo) { fx.apply(); applied.push(fx.id) }
        // 复检前先把「被修项的原始判定」撤掉，避免修复前的 fail 条目把结论钉死在失败上。
        const drop = new Set()
        for (const id of applied) for (const x of (GROUP_IDS[id] ?? [id])) drop.add(x)
        findings.length = 0
        findings.push(...pristine.filter((f) => !drop.has(f.id)))
        const mark = findings.length
        runRechecks(applied)
        const recheckFails = findings.slice(mark).filter((f) => f.level === 'fail')
        // 【严于正则的产物校验】复检靠的是 checkPatchWiring 里的正则扫描，而正则对
        // 「同一个顶级键写了两遍」「缩进乱了」「括号没闭合」这类结构性错误是瞎的 ——
        // 正则只会「找到那行就算接线成功」。所以回滚判定必须再加一道真解析：
        // 只要被改写过的 pnpm-workspace.yaml 结构上站不住，就按复检不过处理。
        for (const f of [...new Set(todo.map((fx) => fx.file))]) {
          if (basename(f) !== 'pnpm-workspace.yaml' || !existsSync(f)) continue
          const v = validateWorkspaceYaml(readFileSync(f, 'utf8'))
          if (!v.ok) {
            recheckFails.push({ id: 'C4', level: 'fail', title: '修复产物未通过结构校验', detail: v.error })
          } else if (v.duplicates?.some((d) => d.level === 'top')) {
            const dup = v.duplicates.filter((d) => d.level === 'top').map((d) => d.key).join('、')
            recheckFails.push({ id: 'C4', level: 'fail', title: `修复产物里有重复的顶级键（${dup}）`, detail: '重复键会静默覆盖，按修复失败处理' })
          }
        }
        if (recheckFails.length > 0) {
          const rb = rollback(backups)
          findings.length = 0
          findings.push(...pristine)   // 回滚后以「原始判定 + 回滚事实」为准
          fixReport = { attempted: true, applied, recheck: recheckFails.map((f) => `${f.id} ${f.title}`), rolledBack: true, files: rb }
        } else {
          fixReport = {
            attempted: true, applied, recheck: [], rolledBack: false,
            files: [...backups.keys()].map((f) => ({ file: f, existedBefore: backups.get(f).existed, hashBefore: backups.get(f).hash, hashAfter: sha256(f) })),
          }
        }
      } catch (e) {
        const rb = rollback(backups)
        findings.length = 0
        findings.push(...pristine)
        fixReport = { attempted: true, applied, error: String(e.message), rolledBack: true, files: rb }
      }
    }
  } else if (ctx.fixes.length > 0) {
    fixReport = {
      attempted: false, applied: [], rolledBack: false,
      reason: '未加 --fix（默认只校验，不写任何文件）',
      available: ctx.fixes.map((f) => ({ id: f.id, file: f.file, describe: f.describe })),
    }
  }

  // ---------- 输出 ----------
  const fails = findings.filter((f) => f.level === 'fail')
  const warns = findings.filter((f) => f.level === 'warn')
  const payload = {
    ok: fails.length === 0,
    mode: DO_FIX ? 'fix' : 'check',
    profileDir, repoDir,
    config: { dataDir: ctx.config.dataDir, profilePath: ctx.config.profilePath },
    findings,
    fixesAvailable: ctx.fixes.map((f) => ({ id: f.id, file: f.file, describe: f.describe })),
    fixReport,
    summary: { fail: fails.length, warn: warns.length, ok: findings.length - fails.length - warns.length },
  }

  if (AS_JSON) {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    const icon = { ok: '✓', warn: '!', fail: '✗' }
    console.log('\n  听雪安装自检')
    console.log('  ' + '─'.repeat(64))
    console.log(`  模式　：${payload.mode === 'fix' ? '校验 + 修复（失败自动回滚）' : '只校验（不写任何文件）'}`)
    console.log(`  profile：${profileDir}`)
    console.log(`  仓库　：${repoDir}`)
    console.log('  ' + '─'.repeat(64))
    for (const f of findings) {
      console.log(`  ${icon[f.level]} [${f.id}] ${f.title}`)
      if (f.detail) console.log(`      ${f.detail}`)
    }
    if (ctx.fixes.length > 0) {
      console.log('\n  可自动修复的项（加 --fix 执行，任一项复检不过则整批回滚）：')
      for (const fx of ctx.fixes) console.log(`    · [${fx.id}] ${fx.describe}`)
    }
    if (fixReport && fixReport.attempted) {
      console.log('\n  修复报告：')
      console.log(`    已应用：${fixReport.applied.join('、') || '（无）'}`)
      console.log(`    回滚  ：${fixReport.rolledBack ? '是 —— 复检未通过，已整批还原' : '否 —— 复检通过'}`)
      if (fixReport.recheck?.length) console.log(`    复检失败项：${fixReport.recheck.join('；')}`)
      for (const f of fixReport.files ?? []) {
        const tag = f.restored === undefined
          ? `before=${f.hashBefore ? f.hashBefore.slice(0, 12) : '(不存在)'} after=${f.hashAfter.slice(0, 12)}`
          : `${f.restored ? '还原哈希一致 ✓' : '还原失败 ✗'} before=${f.before ? f.before.slice(0, 12) : '(不存在)'} after=${f.after ? f.after.slice(0, 12) : '(已删除)'}`
        console.log(`      ${f.file}  ${tag}`)
      }
    } else if (fixReport) {
      console.log(`\n  修复：未执行 —— ${fixReport.reason}`)
    }
    console.log('\n  ' + '─'.repeat(64))
    console.log(`  结论：${fails.length === 0 ? (warns.length ? `通过（${warns.length} 项提示）` : '全部正常') : `${fails.length} 项失败${warns.length ? ` / ${warns.length} 项提示` : ''}`}`)
    if (fails.length) {
      console.log('\n  需要处理的：')
      for (const f of fails) console.log(`    ✗ [${f.id}] ${f.title} —— ${f.detail}`)
    }
    console.log('')
  }

  process.exit(fails.length === 0 ? 0 : 1)
}

/**
 * 每个 check 可能产出多条 finding；修复后复检时要连带撤掉同组的旧条目，
 * 否则「修复前的 fail」会一直挂在结果里，让修好的环境仍然 exit 1。
 */
const GROUP_IDS = {
  C1: ['C1', 'C1-files'],
  C2: ['C2', 'C2-dep'],
  C3: ['C3'],
  C4: ['C4', 'C4-loc', 'C4-applied', 'C4-ws', 'C4-dup', 'C4-manual'],
  'C4-ws': ['C4', 'C4-loc', 'C4-applied', 'C4-ws', 'C4-dup', 'C4-manual'],
  C5: ['C5', 'C5-link'],
  C6: ['C6-secret', 'C6-git', 'C6-write'],
  C7: ['C7'],
  C8: ['C8', 'C8-ship'],
  C9: ['C9'],
}

/** 修复后复检：只重跑「刚修过」的那几项，避免无关项（如 pack 体检）干扰回滚判定。 */
function runRechecks(appliedIds) {
  if (mainCtx === null) { fail('internal', '内部错误', '未初始化 ctx'); return }
  const ids = new Set(appliedIds)
  const bare = { ...mainCtx, fixes: [] }
  if (ids.has('C2')) checkBundleListed(bare)
  if (ids.has('C3')) checkNotifierPin(bare)
  if (ids.has('C4') || ids.has('C4-ws')) {
    checkPatchWiring(bare)
    // 接线改动会重写 pnpm-workspace.yaml —— 顺手复验 profile 补丁的结构没被带坏
    checkProfileYaml(bare)
  }
}
let mainCtx = null

/** 断言小工具，供用例集使用（`eq` 走 JSON 深比较）。 */
export function makeCaseContext(tmp) {
  const eq = (a, b, msg) => {
    const x = JSON.stringify(a); const y = JSON.stringify(b)
    if (x !== y) throw new Error(`${msg ?? '断言失败'}：期望 ${y}，实际 ${x}`)
  }
  const assert = (cond, msg) => { if (!cond) throw new Error(msg ?? '断言失败') }
  return { tmp, eq, assert }
}

/**
 * **与运行环境无关的核心回归用例集 —— 单一权威实现。**
 *
 * 为什么是「导出 + 共享」而不是各写一份：
 * 这些用例原先只活在 `--self-test` 里，于是 `test/install-check.test.mjs`（标准套件）
 * **覆盖不到它们** —— 就算把修复逻辑改坏，标准 verify 命令仍然是绿的。回归只有落在
 * 标准套件里才算真的保护；而 `--self-test` 的价值是「什么都没装的环境里也能跑」。
 * 两者要的本来就是**同一批用例**，所以只写一份、两处调用，消灭双份实现。
 *
 * 调用方传 `t(name, fn)` 注册器（`node:test` 传 `test`，`--self-test` 传收集器），
 * 以及 `makeCaseContext(tmp)` 的产物。`tmp` 是一个临时目录，用例内可随意建夹具；
 * **清理归调用方**（标准套件里用例在 node:test 下异步执行，这里删了会先失效）。
 *
 * **绝不触碰活 profile** —— 需要活 profile 的回归在下面的 `registerLiveCases`。
 */
export function registerCoreCases({ t, tmp, eq, assert }) {
  try {
    // ---------- 验收 1.2：重复顶级键必须被检出 ----------
    t('scanWorkspaceYaml 检出重复顶级键', () => {
      const s = scanWorkspaceYaml('packages:\n  - .\n\nnodeLinker: hoisted\n\nnodeLinker: hoisted\n')
      eq(s.duplicateTopKeys, ['nodeLinker'], '重复的 nodeLinker 应被检出')
      eq(s.topKeys, ['packages', 'nodeLinker'], 'topKeys 应去重')
    })
    t('scanWorkspaceYaml 无重复时不误报', () => {
      eq(scanWorkspaceYaml('packages:\n  - .\n\nnodeLinker: hoisted\n').duplicateTopKeys, [])
    })
    t('validateWorkspaceYaml 对重复顶级键判不通过', () => {
      const v = validateWorkspaceYaml('packages:\n  - .\npatchedDependencies:\n  a: 1\npatchedDependencies:\n  b: 2\n')
      eq(v.ok, false)
      assert(/重复的顶级键/.test(v.error), `应给出重复键原因，实际：${v.error}`)
    })

    // ---------- 验收 1.2：严于正则的结构校验 ----------
    t('validateWorkspaceYaml 检出 Tab 缩进', () => {
      const v = validateWorkspaceYaml('packages:\n\t- .\n')
      eq(v.ok, false)
      assert(/Tab/.test(v.error), `应点出 Tab，实际：${v.error}`)
    })
    t('validateWorkspaceYaml 检出同级没对齐', () => {
      const v = validateWorkspaceYaml('patchedDependencies:\n  a: 1\n   b: 2\n')
      eq(v.ok, false)
    })
    t('validateWorkspaceYaml 检出 flow 括号不闭合', () => {
      eq(validateWorkspaceYaml('packages: [a, b\n').ok, false)
    })
    t('validateWorkspaceYaml 对健康文件判通过', () => {
      const v = validateWorkspaceYaml('packages:\n  - .\n\nnodeLinker: hoisted\n\npatchedDependencies:\n  dsh-notifier: patches/dsh-notifier.patch\n')
      eq(v.ok, true)
    })

    // ---------- 验收 1.3(a)：已有 patchedDependencies 含他包 → 他包条目保留 ----------
    t('验收1.3(a) 修复保留他包条目，产物可被解析', () => {
      const before = [
        'packages:',
        '  - .',
        '',
        'nodeLinker: hoisted',
        'allowBuilds:',
        '  sharp: true',
        '',
        'patchedDependencies:',
        '  other-pkg: patches/other.patch',
        '',
      ].join('\n')
      const r = wirePatchedDependency(before, 'dsh-notifier', PATCH_REL)
      assert(r.ok, `改写在健康文件上必须成功：${r.error}`)
      // 他包条目保留
      const after = scanWorkspaceYaml(r.text)
      eq(after.patched['other-pkg'], 'patches/other.patch', 'other-pkg 条目必须原样保留')
      eq(after.patched['dsh-notifier'], PATCH_REL, 'dsh-notifier 必须被接上')
      // 别的顶级键与嵌套内容保留
      assert(after.topKeys.includes('nodeLinker'), 'nodeLinker 必须保留')
      assert(after.topKeys.includes('allowBuilds'), 'allowBuilds 必须保留')
      assert(/sharp: true/.test(r.text), 'allowBuilds 的子项必须保留')
      // 产物仍是标准 YAML 结构（用同一套解析器复验：无重复键、能解析）
      const v = validateWorkspaceYaml(r.text)
      eq(v.ok, true, `产物必须结构可解析：${v.error}`)
      // 且幂等：再跑一次不产生变化
      const again = wirePatchedDependency(r.text, 'dsh-notifier', PATCH_REL)
      eq(again.ok, true)
      eq(scanWorkspaceYaml(again.text).patched['dsh-notifier'], PATCH_REL)
    })

    t('修复在 patchedDependencies 缺失时会新建该映射', () => {
      const r = wirePatchedDependency('packages:\n  - .\n\nnodeLinker: hoisted\n', 'dsh-notifier', PATCH_REL)
      assert(r.ok, r.error)
      eq(scanWorkspaceYaml(r.text).patched['dsh-notifier'], PATCH_REL)
      eq(validateWorkspaceYaml(r.text).ok, true)
    })
    t('修复在 patchedDependencies 为空值时也成立', () => {
      const r = wirePatchedDependency('patchedDependencies:\n', 'dsh-notifier', PATCH_REL)
      assert(r.ok, r.error)
      eq(scanWorkspaceYaml(r.text).patched['dsh-notifier'], PATCH_REL)
    })
    t('无法安全解析时拒绝修复（不硬拼）—— 重复顶级键', () => {
      const r = wirePatchedDependency('nodeLinker: hoisted\nnodeLinker: hoisted\n', 'dsh-notifier', PATCH_REL)
      eq(r.ok, false, '重复键文件必须拒绝改写')
      assert(/重复的顶级键/.test(r.error), `原因应点出重复键：${r.error}`)
    })
    t('无法安全解析时拒绝修复 —— patchedDependencies 不是映射', () => {
      const r = wirePatchedDependency('patchedDependencies: [a, b]\n', 'dsh-notifier', PATCH_REL)
      eq(r.ok, false)
      assert(/不是映射/.test(r.error), `原因应点出不是映射：${r.error}`)
    })
    t('无法安全解析时拒绝修复 —— Tab 缩进', () => {
      eq(wirePatchedDependency('packages:\n\t- .\n', 'dsh-notifier', PATCH_REL).ok, false)
    })

    // ---------- 验收 1.3(b)：修复产物能被 pnpm install 接受 ----------
    t('验收1.3(b) 修复产物能被 pnpm install 接受', () => {
      if (pnpmCliPath() === null) throw new Error('找不到 pnpm，无法验证 pnpm install 接受性（本机应已装 pnpm）')
      const dir = join(tmp, 'pnpmaccept')
      mkdirSync(join(dir, 'patches'), { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p14', private: true, version: '0.0.0' }), 'utf8')
      writeFileSync(join(dir, 'patches', 'other.patch'), '--- a/x\n+++ b/x\n', 'utf8')
      writeFileSync(join(dir, 'patches', 'dsh-notifier.patch'), '--- a/y\n+++ b/y\n', 'utf8')
      const wired = wirePatchedDependency('packages:\n  - .\n\nnodeLinker: hoisted\n\npatchedDependencies:\n  other-pkg: patches/other.patch\n', 'dsh-notifier', PATCH_REL)
      assert(wired.ok, wired.error)
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), wired.text, 'utf8')

      // ① 先证明 pnpm **真的跑起来了**。这一步不能省：如果 pnpm 根本没启动（例如直接
      //    spawn .mjs 得到 EFTYPE），输出是空串，下面「输出里没有坏关键字」会**恒真**。
      const ver = runPnpm(['--version'], dir, 120000)
      assert(ver.ok && /\d+\.\d+/.test(ver.out),
        `pnpm 没能跑起来，1.3(b) 无法作证：${ver.error ?? ver.out.slice(0, 200)}`)

      const r = runPnpm(['install', '--ignore-scripts', '--lockfile-only', '--offline'], dir)
      assert(r.error === null, `pnpm 进程没能启动（产物接受性无法判定）：${r.error}`)

      // ② 再证明夹具**确实让 pnpm 读到了 patchedDependencies**：本夹具没有真实依赖，
      //    pnpm 必然以 ERR_PNPM_UNUSED_PATCH 收场。这既说明 YAML 被解析成功，
      //    也说明「空输出」不会混进来当通过。
      assert(/UNUSED_PATCH|patches were not used/i.test(r.out),
        `pnpm 没读到 patchedDependencies（输出为空或语义不符，说明这次判定不可信）：${r.out.slice(0, 400) || '(空输出)'}`)
      assert(/dsh-notifier|other-pkg/.test(r.out),
        `pnpm 的 UNUSED_PATCH 里没点名本次接线：${r.out.slice(0, 400)}`)

      // ③ 最后才是真正要排除的：解析类错误（这正是旧版字符串追加会踩的坑）。
      assert(!/duplicated mapping key|YAMLException|bad indentation|can not read a block mapping/i.test(r.out),
        `修复产物被 pnpm 当成坏 YAML 了：${r.out.slice(0, 400)}`)
    })

    // ---------- 验收 1.3(b) 的负向对照：坏 YAML 必须真的被判出来 ----------
    // 没有这一条，1.3(b) 就只是「跑了个绿」；有了它，才能证明上面那句断言**能红**。
    t('验收1.3(b) 负向对照：坏 YAML（重复顶级键）必须被 pnpm 判出来', () => {
      if (pnpmCliPath() === null) throw new Error('找不到 pnpm')
      const dir = join(tmp, 'pnpmreject')
      mkdirSync(join(dir, 'patches'), { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p14', private: true, version: '0.0.0' }), 'utf8')
      writeFileSync(join(dir, 'patches', 'other.patch'), '--- a/x\n+++ b/x\n', 'utf8')
      writeFileSync(join(dir, 'patches', 'dsh-notifier.patch'), '--- a/y\n+++ b/y\n', 'utf8')
      // 手工拼出旧版字符串追加会产出的形态：两个同名顶级键
      writeFileSync(join(dir, 'pnpm-workspace.yaml'),
        'packages:\n  - .\n\npatchedDependencies:\n  other-pkg: patches/other.patch\n\npatchedDependencies:\n  dsh-notifier: patches/dsh-notifier.patch\n', 'utf8')

      const r = runPnpm(['install', '--ignore-scripts', '--lockfile-only', '--offline'], dir)
      assert(r.error === null, `pnpm 进程没能启动：${r.error}`)
      assert(/duplicated mapping key|YAMLException/i.test(r.out),
        `坏 YAML 竟然没被 pnpm 判出来，说明 1.3(b) 的正向断言不可信：${r.out.slice(0, 400) || '(空输出)'}`)
    })

    // ---------- 验收 2：C3 四格矩阵 ----------
    const mkProfile = (name, spec, instVer, withLock) => {
      const d = join(tmp, name)
      mkdirSync(join(d, 'node_modules', 'dsh-notifier'), { recursive: true })
      writeFileSync(join(d, 'package.json'),
        JSON.stringify({ name: 'p', private: true, dependencies: { 'dsh-notifier': spec } }, null, 2), 'utf8')
      writeFileSync(join(d, 'node_modules', 'dsh-notifier', 'package.json'),
        JSON.stringify({ name: 'dsh-notifier', version: instVer }, null, 2), 'utf8')
      if (withLock) writeFileSync(join(d, 'pnpm-lock.yaml'), 'snapshots:\n  dsh-notifier@0.9.0:\n    resolution: {integrity: sha512-x}\n', 'utf8')
      return d
    }
    /** 直接调用 checkNotifierPin，取它产出的 C3 判定。 */
    const c3Of = (dir) => {
      const had = findings.length
      const ctx = { profileDir: dir, repoDir: dir, pluginName: PLUGIN_NAME, fixes: [], config: {}, secretLiterals: [], liveSecretFiles: [], isPackable: false, isGitRepo: false }
      checkNotifierPin(ctx)
      const got = findings.slice(had).filter((f) => f.id === 'C3')
      findings.length = had
      return { levels: got.map((f) => f.level), titles: got.map((f) => f.title), fixes: ctx.fixes.map((f) => f.id) }
    }

    // 四格：spec ∈ {0.9.0, ^0.9.0} × instVer ∈ {0.9.0, 0.12.0}
    t('C3 矩阵① spec=0.9.0 instVer=0.9.0 → ok', () => {
      eq(c3Of(mkProfile('c3-1', NOTIFIER_PIN, '0.9.0', false)).levels, ['ok'])
    })
    t('C3 矩阵② spec=0.9.0 instVer=0.12.0 → fail（旧 else if 会漏判这一格）', () => {
      const r = c3Of(mkProfile('c3-2', NOTIFIER_PIN, '0.12.0', true))
      eq(r.levels, ['fail'], '声明钉死但装错版本，必须判 fail')
      assert(/0\.12\.0/.test(r.titles[0]), `标题应点出实际版本：${r.titles[0]}`)
    })
    t('C3 矩阵③ spec=^0.9.0 instVer=0.9.0 无 lock → fail', () => {
      const r = c3Of(mkProfile('c3-3', '^0.9.0', '0.9.0', false))
      eq(r.levels, ['fail'])
      eq(r.fixes, ['C3'], '应给出钉死版本的修复项')
    })
    t('C3 矩阵④ spec=^0.9.0 instVer=0.9.0 有 lock → warn（README L131）', () => {
      const r = c3Of(mkProfile('c3-4', '^0.9.0', '0.9.0', true))
      eq(r.levels, ['warn'], 'README L131：有 lock 挡住是地雷不是当下的火')
      eq(r.fixes, ['C3'], 'warn 也要给修复项')
    })
    t('C3 两轴都错 → 两条都报（不互相掩盖）', () => {
      const r = c3Of(mkProfile('c3-5', '^0.9.0', '0.12.0', false))
      eq(r.levels.sort(), ['fail', 'fail'], '声明没钉死 + 装错版本，两条都该报')
      assert(r.titles.some((x) => /0\.12\.0/.test(x)), '应有一条点出已装版本')
      assert(r.titles.some((x) => /没有钉死/.test(x)), '应有一条点出没钉死')
    })
    t('C3 两轴都错且有 lock → fail + warn 并存', () => {
      const r = c3Of(mkProfile('c3-6', '^0.9.0', '0.12.0', true))
      eq(r.levels.sort(), ['fail', 'warn'], '装错是当下的火(fail)，没钉死被 lock 挡住是地雷(warn)')
    })
    t('C3 未装 notifier 时按声明判，不谎报已安装', () => {
      const d = join(tmp, 'c3-7')
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'p', private: true, dependencies: { 'dsh-notifier': NOTIFIER_PIN } }, null, 2), 'utf8')
      eq(c3Of(d).levels, ['ok'])
    })

    // ---------- 验收 3：C4-ws 写入完整工作区配置 ----------
    t('C4-ws 模板含 nodeLinker: hoisted 且结构自校验通过', () => {
      // 复刻 checkPatchWiring 的模板，验证它与文档一致、且能过结构校验
      const src = readFileSync(fileURLToPath(import.meta.url), 'utf8')
      assert(/C4-ws/.test(src) && /nodeLinker: hoisted/.test(src), 'C4-ws 必须写到 nodeLinker: hoisted')
      const scaffold = 'packages:\n  - .\n\nnodeLinker: hoisted\n\npatchedDependencies:\n  dsh-notifier: ' + PATCH_REL + '\n'
      eq(validateWorkspaceYaml(scaffold).ok, true)
      eq(scanWorkspaceYaml(scaffold).patched['dsh-notifier'], PATCH_REL)
    })

    // ---------- 验收 4：profile cordis.patch.yml 结构检查 ----------
    t('C9 对健康 profile 补丁判 ok', () => {
      const d = join(tmp, 'c9-ok')
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'cordis.patch.yml'), '- id: browser\n- id: dsh-notifier\n  config:\n    inbound:\n      qq:\n        appId: "1"\n', 'utf8')
      const had = findings.length
      checkProfileYaml({ profileDir: d })
      const got = findings.slice(had)
      findings.length = had
      eq(got.map((f) => f.level), ['ok'])
      assert(/2 个补丁项/.test(got[0].detail), `应报出补丁项数：${got[0].detail}`)
    })
    t('C9 对缩进坏掉的 profile 补丁判 fail（整个 profile 起不来）', () => {
      const d = join(tmp, 'c9-bad')
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'cordis.patch.yml'), '- id: dsh-notifier\n  config:\n     inbound:\n    qq:\n', 'utf8')
      const had = findings.length
      checkProfileYaml({ profileDir: d })
      const got = findings.slice(had)
      findings.length = had
      eq(got.map((f) => f.level), ['fail'])
    })
    t('C9 对同一个 id 出现多条补丁项判 ok（cordis 的正常语义，不许误报）', () => {
      const d = join(tmp, 'c9-rep')
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'cordis.patch.yml'), '- id: dsh-tingxue\n  config:\n    a: 1\n- id: dsh-tingxue\n  disabled: true\n', 'utf8')
      const had = findings.length
      checkProfileYaml({ profileDir: d })
      const got = findings.slice(had)
      findings.length = had
      eq(got.map((f) => f.level), ['ok'], '同 id 多条补丁项是正常语义，绝不能判红')
      assert(/2 个补丁项/.test(got[0].detail), got[0].detail)
    })
    t('C9 对同一个映射里重复的键判 fail（真结构错误）', () => {
      const d = join(tmp, 'c9-dupkey')
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'cordis.patch.yml'), '- id: dsh-tingxue\n  config:\n    a: 1\n    a: 2\n', 'utf8')
      const had = findings.length
      checkProfileYaml({ profileDir: d })
      const got = findings.slice(had)
      findings.length = had
      eq(got.map((f) => f.level), ['fail'], '同一映射里重复键必须判 fail')
      assert(/重复的映射键/.test(got[0].title), got[0].title)
    })
    t('C9 顶层不是数组判 fail（拷错文件）', () => {
      const d = join(tmp, 'c9-nonarray')
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'cordis.patch.yml'), 'packages:\n  - .\n', 'utf8')
      const had = findings.length
      checkProfileYaml({ profileDir: d })
      const got = findings.slice(had)
      findings.length = had
      eq(got.map((f) => f.level), ['fail'])
    })

    // ---------- C9 针对「本机真发生过的那次事故」的回归 ----------
    // 事故形态：清理残留时漏了一行，多出一个缩进不对的键 → 活配置成了非法 YAML，
    // 两个解析器都拒绝，**一重启 DSH 就起不来**，而当时工具链里没有任何东西能发现它。
    t('C9 抓到「缩进异常的悬挂行」（本机真实事故形态）', () => {
      const d = join(tmp, 'c9-dangling')
      mkdirSync(d, { recursive: true })
      // bogus 想跟 a、b 同级却没对齐（少一个空格）
      writeFileSync(join(d, 'cordis.patch.yml'), '- id: dsh-tingxue\n  config:\n    a: 1\n   bogus: true\n', 'utf8')
      const had = findings.length
      checkProfileYaml({ profileDir: d })
      const got = findings.slice(had)
      findings.length = had
      eq(got.map((f) => f.level), ['fail'], '缩进异常的悬挂行必须判 fail')
      assert(/缩进|对齐/.test(String(got[0].detail ?? '') + got[0].title), `错误信息应点明缩进问题：${got[0].detail}`)
    })

    t('C9 抓到「悬挂的裸值行」（既非键值对也非序列项）', () => {
      const d = join(tmp, 'c9-bare')
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'cordis.patch.yml'), '- id: dsh-tingxue\n  config: ok\n  dangling\n', 'utf8')
      const had = findings.length
      checkProfileYaml({ profileDir: d })
      const got = findings.slice(had)
      findings.length = had
      eq(got.map((f) => f.level), ['fail'], '悬挂裸值行必须判 fail')
    })

    // 关键边界：**「未知键」本身不是错误**，只有缩进/结构错才是。
    // 若把「不认识的键」判红，将来 cordis 加新字段就会在健康机器上挂红。
    t('C9 对「缩进正确的未知键」判 ok（未知键不是错误，只有结构错才是）', () => {
      const d = join(tmp, 'c9-unknown')
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'cordis.patch.yml'), '- id: dsh-tingxue\n  config:\n    a: 1\n    bogus: true\n', 'utf8')
      const had = findings.length
      checkProfileYaml({ profileDir: d })
      const got = findings.slice(had)
      findings.length = had
      eq(got.map((f) => f.level), ['ok'], '缩进正确的未知键是合法 YAML，不得误报')
    })
    // 核心用例集到此结束（不含真机回归）。清理归调用方 —— 见函数头说明。
  } catch (e) {
    // 用例集**注册**阶段就抛（而非某条用例失败）：说明是测试基建坏了，
    // 必须让调用方看得见，不能静默当「没注册用例」处理。
    throw new Error(`注册核心回归用例时出错：${e?.message ?? String(e)}`)
  }
}

/**
 * **真机回归**（依赖 `~/.dsh/profiles/web` 的实际内容）。
 *
 * 为什么与核心集分开、且默认不参与退出码：
 * 这两条判的不是「脚本逻辑对不对」，而是「**这台机器的活 profile 现在健不健康**」。
 * 混进 `--self-test` 的失败计数会造成两类误判：
 *   ① 在**别的机器 / CI / 无 profile 环境**上，自检会因为「找不到活 profile」而红 ——
 *      那是环境缺席，不是脚本坏了；
 *   ② 本机 profile 真被写坏时，自检会红 —— 那是**发现了活状态的问题**（应该报警，
 *      但用 warn 报、不改变「脚本自身逻辑是否可信」的退出码）。
 *
 * 故：默认以 **warn** 输出（不通过也不计入失败数）；要把它当硬门禁用
 * `--self-test --live`（此时按 fail 计入退出码）。`--live` 仍是只读，绝不写活 profile。
 */
export function registerLiveCases({ t, eq, assert }) {
  // ---------- 真机回归：活 profile 必须判 ok 且只读 ----------
  t('真机：活 profile 的 cordis.patch.yml 结构可解析（只读，不写）', () => {
    const live = join(LIVE_PROFILES, 'web')
    const f = join(live, 'cordis.patch.yml')
    if (!existsSync(f)) throw new Error('活 profile 补丁不存在，无法做真机回归')
    const before = sha256(f)
    const had = findings.length
    checkProfileYaml({ profileDir: live })
    const got = findings.slice(had)
    findings.length = had
    eq(got.map((x) => x.level), ['ok'], `活 profile 补丁应结构可解析：${JSON.stringify(got)}`)
    eq(sha256(f), before, 'C9 必须只读')
  })
  t('真机：活 pnpm-workspace.yaml 无重复顶级键且能真解析', () => {
    const f = join(LIVE_PROFILES, 'web', 'pnpm-workspace.yaml')
    if (!existsSync(f)) throw new Error('活 workspace.yaml 不存在，无法做真机回归')
    const text = readFileSync(f, 'utf8')
    eq(scanWorkspaceYaml(text).duplicateTopKeys, [], '活文件不该有重复顶级键')
    const v = validateWorkspaceYaml(text)
    eq(v.ok, true, `活 workspace.yaml 应结构可解析：${v.error}`)
  })
}

/**
 * 自带回归（`--self-test`）：**跑的就是 `test/install-check.test.mjs` 用的那批用例**，
 * 只有一处实现（`registerCoreCases`）。它的存在理由是「在什么都没装的环境里也能跑」——
 * 只需 Node，不需要 test runner、不需要 profile。
 *
 *     node scripts/install-check.mjs --self-test           # 核心回归（与套件同一批）
 *     node scripts/install-check.mjs --self-test --live    # 额外把活 profile 当硬门禁
 *
 * 全部夹具建在 `mkdtempSync(tmpdir())` 下，跑完即删；**绝不触碰活 profile**。
 * 退出码：0 全过（含「有 warn」）/ 1 有失败。
 */
function runSelfTest() {
  const coreCases = []
  const liveCases = []
  const mkCollector = (into) => (name, fn) => {
    try { fn(); into.push({ name, ok: true }) } catch (e) { into.push({ name, ok: false, error: e?.message ?? String(e) }) }
  }
  const tmp = mkdtempSync(join(tmpdir(), 'tx-selfcheck-'))
  const ctx = makeCaseContext(tmp)
  try {
    registerCoreCases({ t: mkCollector(coreCases), ...ctx })
    // 真机回归**总是跑**（只读、开销极小）：这样默认模式下也能把「本机 profile 健不健康」
    // 作为提示报出来，而不是假装没这回事。是否计入退出码见下方。
    registerLiveCases({ t: mkCollector(liveCases), ...ctx })
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  }

  const coreFailed = coreCases.filter((c) => !c.ok)
  const liveFailed = liveCases.filter((c) => !c.ok)
  const LIVE_IS_GATE = ARGS.includes('--live')

  for (const c of coreCases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : `\n      ${c.error}`}`)
  console.log('')
  console.log(`  核心回归（与 test/install-check.test.mjs 同一批）：${coreCases.length - coreFailed.length}/${coreCases.length} 通过`)
  console.log('')

  if (liveCases.length > 0) {
    for (const c of liveCases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : `\n      ${c.error}`}`)
    const label = LIVE_IS_GATE ? '真机回归（--live 硬门禁，计入退出码）' : '真机回归（环境提示，不计入退出码）'
    console.log(`  ${label}：${liveCases.length - liveFailed.length}/${liveCases.length} 通过`)
    if (liveFailed.length > 0 && !LIVE_IS_GATE) {
      console.log('  ⚠ 以上是**环境**信息，不是脚本逻辑坏了：可能是这台机器没有活 profile')
      console.log('    （CI / 别人克隆仓库的正常情形），也可能是本机 profile 真有问题。')
      console.log('    两种情况都不改变退出码 —— 零依赖自检在任何环境都该能跑绿。')
      console.log('    要把它当硬门禁请加 --live（仍只读，绝不写活 profile）。')
    }
    console.log('')
  }

  // 退出码语义（验收 2 的明确要求）：**只反映脚本自身逻辑**。
  //   默认         → 只看核心回归；活 profile 的问题只提示。
  //   --self-test --live → 两者都算，真机项变硬门禁。
  const gateFailed = LIVE_IS_GATE ? [...coreFailed, ...liveFailed] : coreFailed
  return gateFailed.length === 0 ? 0 : 1
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
  if (ARGS.includes('--self-test')) process.exit(runSelfTest())
  main().catch((e) => { console.error('install-check 崩溃：', e?.stack ?? e); process.exit(2) })
}

export {
  scanWorkspaceYaml, readProfileConfig, collectSecretLiterals, isLiveProfilePath,
  checkRepoSelf, checkBundleListed, checkNotifierPin, checkPatchWiring,
  checkRuntimeCopy, checkRepoHygiene, checkLiveProfileSecrets, checkPackList,
  backupFiles, rollback, npmCliPath, pnpmCliPath, runPnpm, walk, sha256, headBlob, isGitRepo, findings,
  // 新增：零依赖 YAML 子集解析/序列化与结构校验（t14）
  parseYamlSubset, emitYamlSubset, validateWorkspaceYaml, wirePatchedDependency,
  checkProfileYaml, YamlStructureError,
  // 核心回归用例集（registerCoreCases / registerLiveCases / makeCaseContext）在各自
  // 定义处直接 `export`，故不在此处重复列出。
}
