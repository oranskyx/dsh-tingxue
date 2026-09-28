// dsh-tingxue test/install-check.test.mjs
//
// 安装安全流程的回归测试。
//
// 为什么需要它：一个**永远 exit 0** 的校验脚本毫无价值。这里要证明的是
//   ① 健康环境真的 exit 0；
//   ② 每一条「装完静默失效」的形态真的会让它 exit 1，且给出可执行的修复指引；
//   ③ 自动回滚真的把环境还原（关键文件哈希前后一致），而不是口头承诺；
//   ④ 它**不写活 profile**、**不把凭据写进仓库**、**输出里不回显凭据**。
//
// 全程只碰临时目录（mkdtemp）；活 profile 一次都不写。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  scanWorkspaceYaml, readProfileConfig, collectSecretLiterals, isLiveProfilePath,
  // 核心回归用例集（单一权威实现：脚本的 --self-test 与这里共用同一批）
  registerCoreCases, registerLiveCases, makeCaseContext,
} from '../scripts/install-check.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRIPT = join(REPO, 'scripts', 'install-check.mjs')
// 注：活 profile 路径**由脚本内部的 LIVE_PROFILES 决定**（`registerLiveCases` 用的是它）。
// 这里刻意不另设一个「活 profile 常量」—— 曾经有过一个，结果它既不参与判定，
// 又让人误以为改它就能改变真机回归的行为（我就在此踩过一次：指着假 profile 跑，
// 却因为改错了地方而报「全部通过」）。要改活 profile 目标，改脚本，别改这里。

/** 造一个假凭据（刻意不是任何真实值），用来测「不回显 / 不落仓库」。 */
const FAKE_SECRET = 'FAKE-SECRET-PROBE-VALUE-0123456789'

// ---------- 夹具 ----------

/**
 * 建一套「健康」的临时环境：迷你插件仓库 + 迷你 profile。
 * @returns {Promise<{root: string, repo: string, profile: string, cleanup: () => Promise<void>}>}
 */
async function makeHealthy() {
  const root = await mkdtemp(join(tmpdir(), 'tx-installcheck-'))
  const repo = join(root, 'repo')
  const profile = join(root, 'profile')

  await mkdir(join(repo, 'src'), { recursive: true })
  await mkdir(join(profile, 'node_modules', 'dsh-notifier', 'src', 'inbound'), { recursive: true })
  await mkdir(join(profile, 'node_modules', 'dsh-tingxue', 'src'), { recursive: true })
  await mkdir(join(profile, 'patches'), { recursive: true })

  // 仓库：声明 dsh.bundle + files 白名单 + src 一个文件
  await writeFile(join(repo, 'package.json'), JSON.stringify({
    name: 'dsh-tingxue', version: '0.1.0', type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    files: ['src', 'client', 'scripts/selfcheck.mjs', 'scripts/install-check.mjs', 'examples', 'cordis.patch.yml', 'README.md', 'LICENSE'],
  }, null, 2), 'utf8')
  await writeFile(join(repo, 'cordis.patch.yml'), '- insert: []\n', 'utf8')
  await writeFile(join(repo, 'README.md'), '# 听雪\n', 'utf8')
  await writeFile(join(repo, 'src', 'plugin-entry.mjs'), 'export const a = 1\n', 'utf8')

  // 运行副本：与仓库 src 逐字节一致（健康）
  await writeFile(join(profile, 'node_modules', 'dsh-tingxue', 'src', 'plugin-entry.mjs'), 'export const a = 1\n', 'utf8')
  await writeFile(join(profile, 'node_modules', 'dsh-tingxue', 'package.json'),
    JSON.stringify({ name: 'dsh-tingxue', version: '0.1.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2), 'utf8')
  await writeFile(join(profile, 'node_modules', 'dsh-tingxue', 'cordis.patch.yml'), '- insert: []\n', 'utf8')

  // profile：bundles 列出插件 + notifier 钉死 0.9.0
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dependencies: { 'dsh-notifier': '0.9.0', 'dsh-tingxue': 'file:../repo' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-notifier', 'dsh-tingxue'] } },
  }, null, 2), 'utf8')

  // 补丁接线 + 补丁文件 + 已生效标记
  await writeFile(join(profile, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\n\npatchedDependencies:\n  dsh-notifier: patches/dsh-notifier.patch\n', 'utf8')
  await writeFile(join(profile, 'patches', 'dsh-notifier.patch'), '--- a\n+++ b\n', 'utf8')
  await writeFile(join(profile, 'node_modules', 'dsh-notifier', 'package.json'),
    JSON.stringify({ name: 'dsh-notifier', version: '0.9.0' }, null, 2), 'utf8')
  await writeFile(join(profile, 'node_modules', 'dsh-notifier', 'src', 'inbound', '_qq-segment.mjs'), 'export {}\n', 'utf8')
  await writeFile(join(profile, 'node_modules', 'dsh-notifier', 'src', 'inbound', 'message.mjs'),
    'export function parseQQFileAttachments() {}\n', 'utf8')

  // profile 补丁：appSecret 是**假值**，用来测 C7 与「不回显」
  await writeFile(join(profile, 'cordis.patch.yml'),
    `- id: dsh-notifier\n  config:\n    inbound:\n      qq:\n        appSecret: "${FAKE_SECRET}"\n`, 'utf8')

  return {
    root, repo, profile,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

/** 跑一次 install-check，拿到 { code, stdout, stderr }（不抛）。 */
function runCheck(env, args = []) {
  const argv = [SCRIPT, '--repo-dir', env.repo, '--profile-dir', env.profile, '--no-pack', ...args]
  try {
    const stdout = execFileSync(process.execPath, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsHide: true, env: { ...process.env } })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    return { code: e.status ?? -1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }
  }
}

const json = (r) => JSON.parse(r.stdout)

/** 跑一条 git 命令（夹具里造「已提交 vs 未提交」两种形态）。 */
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, windowsHide: true })
}

/** 抓一个目录树的哈希快照（用于证明「只读」与「回滚还原」）。 */
async function snapshot(dir) {
  const acc = {}
  async function walk(d, rel = '') {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(p, r)
      else acc[r] = (await readFile(p)).toString('base64')
    }
  }
  await walk(dir)
  return acc
}

// ---------- 纯函数 ----------

test('scanWorkspaceYaml：认顶层键与 patchedDependencies 一层键值，忽略注释', () => {
  const { topKeys, patched } = scanWorkspaceYaml([
    'packages:',
    '  - .',
    '',
    '# patchedDependencies: 这行是注释，不该被当成键',
    'nodeLinker: hoisted',
    'patchedDependencies:',
    '  dsh-notifier: patches/dsh-notifier.patch',
    "  'some-pkg': 'patches/some.patch'",
  ].join('\n'))
  assert.deepEqual(topKeys, ['packages', 'nodeLinker', 'patchedDependencies'])
  assert.deepEqual(patched, { 'dsh-notifier': 'patches/dsh-notifier.patch', 'some-pkg': 'patches/some.patch' })
})

test('scanWorkspaceYaml：没有 patchedDependencies 时返回空对象（而不是抛）', () => {
  assert.deepEqual(scanWorkspaceYaml('packages:\n  - .\n').patched, {})
})

test('readProfileConfig：从 profile 补丁里取 dataDir / profilePath，剥掉引号', () => {
  const cfg = readProfileConfig([
    '  config:',
    "    profilePath: 'D:\\x\\听雪档案.txt'",
    "    dataDir: 'D:\\x\\data'",
  ].join('\n'))
  assert.equal(cfg.profilePath, 'D:\\x\\听雪档案.txt')
  assert.equal(cfg.dataDir, 'D:\\x\\data')
})

test('collectSecretLiterals：只认 key 行且长度 >= 8，绝不把整个文件当凭据', () => {
  const got = collectSecretLiterals([
    'appSecret: "short"',              // 太短 → 忽略
    'appSecret: "a-long-enough-secret"',
    'apiKey: "another-long-value-here"',
    '  description: "这不是凭据键"',     // 键名不匹配 → 忽略
  ].join('\n'))
  assert.deepEqual(got.sort(), ['a-long-enough-secret', 'another-long-value-here'])
})

test('isLiveProfilePath：活 profile 树（整棵 ~/.dsh/profiles/）里的路径必须被拦下', () => {
  const live = join(tmpdir(), 'fake-dsh-home', 'profiles')
  assert.equal(isLiveProfilePath(join(live, 'web', 'package.json'), live), true)
  assert.equal(isLiveProfilePath(join(live, 'web'), live), true)
  // 整个 profiles 根下的任何 profile 都是活状态
  assert.equal(isLiveProfilePath(join(live, 'web-backup', 'x'), live), true)
  assert.equal(isLiveProfilePath(live, live), true)
  // 根外面的临时目录才是可写的
  assert.equal(isLiveProfilePath(join(tmpdir(), 'tx-installcheck-xxx', 'profile'), live), false)
  assert.equal(isLiveProfilePath(join(tmpdir(), 'fake-dsh-home', 'profiles-backup', 'x'), live), false)
  assert.equal(isLiveProfilePath(join(tmpdir(), 'fake-dsh-home', 'cordis.patch.yml'), live), false)
})

// ---------- 健康环境必须 exit 0 ----------

test('健康环境：自动校验 exit 0，且无 fail', async () => {
  const env = await makeHealthy()
  try {
    const r = runCheck(env, ['--json'])
    assert.equal(r.code, 0, `健康环境应 exit 0，实际 ${r.code}\n${r.stdout}\n${r.stderr}`)
    const p = json(r)
    assert.equal(p.ok, true)
    assert.equal(p.summary.fail, 0, JSON.stringify(p.findings.filter((f) => f.level === 'fail'), null, 2))
    // 关键项都得是 ok（不是「跳过了所以没报错」）
    const ids = p.findings.filter((f) => f.level === 'ok').map((f) => f.id)
    for (const need of ['C1', 'C1-files', 'C2', 'C3', 'C4', 'C4-applied', 'C5', 'C6-secret', 'C6-write']) {
      assert.ok(ids.includes(need), `${need} 未出现在 ok 列表里：${ids.join(', ')}`)
    }
  } finally { await env.cleanup() }
})

// ---------- 已知会静默失效的形态，必须 exit 1 ----------

test('坏环境 ①：profile 未把插件列进 dsh.profile.bundles → exit 1（这就是「已安装，未生效」）', async () => {
  const env = await makeHealthy()
  try {
    const pkg = JSON.parse(await readFile(join(env.profile, 'package.json'), 'utf8'))
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== 'dsh-tingxue')
    await writeFile(join(env.profile, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')

    const r = runCheck(env, ['--json'])
    assert.equal(r.code, 1, '应 exit 1')
    const p = json(r)
    const f = p.findings.find((x) => x.id === 'C2')
    assert.equal(f.level, 'fail')
    assert.match(f.title, /已安装，未生效/)
    // 指引必须可执行：给出要补的名字
    assert.match(f.detail, /dsh-tingxue/)
    assert.ok(p.fixesAvailable.some((x) => x.id === 'C2'), '应给出可自动修复项')
  } finally { await env.cleanup() }
})

test('坏环境 ②：dsh-notifier 声明成 ^0.9.0（不是钉死）→ exit 1', async () => {
  const env = await makeHealthy()
  try {
    const pkg = JSON.parse(await readFile(join(env.profile, 'package.json'), 'utf8'))
    pkg.dependencies['dsh-notifier'] = '^0.9.0'
    await writeFile(join(env.profile, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')

    const r = runCheck(env, ['--json'])
    assert.equal(r.code, 1)
    const f = json(r).findings.find((x) => x.id === 'C3')
    assert.equal(f.level, 'fail')
    assert.match(f.detail, /\^0\.9\.0/)
    assert.match(f.detail, /行号 hunk/)
  } finally { await env.cleanup() }
})

test('C3 严重度按「现在是不是真的坏了」分级：无 lock 判 fail，有 lock 判 warn（地雷不是当下的火）', async () => {
  const env = await makeHealthy()
  try {
    const pkg = JSON.parse(await readFile(join(env.profile, 'package.json'), 'utf8'))
    pkg.dependencies['dsh-notifier'] = '^0.9.0'
    await writeFile(join(env.profile, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')

    // ① 没有 lock 把它钉住 → 下一次 pnpm install 就会踩上 → fail
    const noLock = json(runCheck(env, ['--json'])).findings.find((x) => x.id === 'C3')
    assert.equal(noLock.level, 'fail', '没有任何 lock 挡住时必须判 fail')
    assert.match(noLock.detail, /没有任何 lock 把它钉住/)
    assert.ok(!/pnpm-lock/.test(noLock.detail.replace(/没有任何 lock/, '')), '没有 lock 文件时不该声称 lock 挡住了')

    // ② 有 lock 且确实钉住 0.9.0 → 今天不会炸 → warn，且必须点出触发条件
    await writeFile(join(env.profile, 'pnpm-lock.yaml'), 'packages:\n\nsnapshots:\n  dsh-notifier@0.9.0:\n    resolution: {integrity: sha512-x}\n', 'utf8')
    const withLock = json(runCheck(env, ['--json'])).findings.find((x) => x.id === 'C3')
    assert.equal(withLock.level, 'warn', 'lock 已挡住时应降级为 warn —— 长期留一条红会训练出「忽略它」')
    assert.match(withLock.detail, /pnpm-lock\.yaml 目前把它钉在 0\.9\.0/)
    assert.match(withLock.detail, /换机器 \/ 删 lock \/ pnpm update/)
    // 但仍要给出可执行的修复项（warn 不等于不管）
    assert.ok(json(runCheck(env, ['--json'])).fixesAvailable.some((x) => x.id === 'C3'))
  } finally { await env.cleanup() }
})

test('C3 最硬的一档：已安装版本不是 0.9.0 → fail（这一刻补丁上下文就错位了）', async () => {
  const env = await makeHealthy()
  try {
    // 声明已经钉死，但装进来的却是别的版本 —— lock 也挡不住
    await writeFile(join(env.profile, 'pnpm-lock.yaml'), 'packages:\n\nsnapshots:\n  dsh-notifier@0.9.0:\n    resolution: {integrity: sha512-x}\n', 'utf8')
    await writeFile(join(env.profile, 'node_modules', 'dsh-notifier', 'package.json'),
      JSON.stringify({ name: 'dsh-notifier', version: '0.12.0' }, null, 2), 'utf8')
    const f = json(runCheck(env, ['--json'])).findings.find((x) => x.id === 'C3')
    assert.equal(f.level, 'fail')
    assert.match(f.title, /0\.12\.0/)
    assert.match(f.detail, /当下的火/)
  } finally { await env.cleanup() }
})

test('坏环境 ③：已安装的 notifier 版本不是 0.9.0 → exit 1（补丁上下文必然错位）', async () => {
  const env = await makeHealthy()
  try {
    await writeFile(join(env.profile, 'node_modules', 'dsh-notifier', 'package.json'),
      JSON.stringify({ name: 'dsh-notifier', version: '0.12.0' }, null, 2), 'utf8')
    const r = runCheck(env, ['--json'])
    assert.equal(r.code, 1)
    const f = json(r).findings.find((x) => x.id === 'C3')
    assert.equal(f.level, 'fail')
    assert.match(f.title, /0\.12\.0/)
  } finally { await env.cleanup() }
})

test('坏环境 ④：补丁没接线到 pnpm-workspace.yaml 的 patchedDependencies → exit 1', async () => {
  const env = await makeHealthy()
  try {
    await writeFile(join(env.profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8')
    const r = runCheck(env, ['--json'])
    assert.equal(r.code, 1)
    const f = json(r).findings.find((x) => x.id === 'C4')
    assert.equal(f.level, 'fail')
    assert.match(f.title, /patchedDependencies/)
    assert.match(f.detail, /pnpm install/, '必须告诉用户接完要再跑 pnpm install')
  } finally { await env.cleanup() }
})

test('坏环境 ⑤：补丁声明放错位置（写进 package.json 而非 pnpm-workspace.yaml）→ 有明确提示', async () => {
  const env = await makeHealthy()
  try {
    await writeFile(join(env.profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8')
    const pkg = JSON.parse(await readFile(join(env.profile, 'package.json'), 'utf8'))
    pkg.patchedDependencies = { 'dsh-notifier': 'patches/dsh-notifier.patch' }
    await writeFile(join(env.profile, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')

    const r = runCheck(env, ['--json'])
    assert.equal(r.code, 1, '放错位置仍应失败（pnpm 不认 package.json 里的声明）')
    const f = json(r).findings.find((x) => x.id === 'C4-loc')
    assert.equal(f.level, 'warn')
    assert.match(f.detail, /只认 pnpm-workspace\.yaml/)
  } finally { await env.cleanup() }
})

test('坏环境 ⑥：补丁文件在磁盘上但没生效（缺标记文件）→ exit 1', async () => {
  const env = await makeHealthy()
  try {
    await rm(join(env.profile, 'node_modules', 'dsh-notifier', 'src', 'inbound', '_qq-segment.mjs'))
    // message.mjs 也拿掉补丁标记函数
    await writeFile(join(env.profile, 'node_modules', 'dsh-notifier', 'src', 'inbound', 'message.mjs'),
      'export function plain() {}\n', 'utf8')
    const r = runCheck(env, ['--json'])
    assert.equal(r.code, 1)
    const f = json(r).findings.find((x) => x.id === 'C4-applied')
    assert.equal(f.level, 'fail')
    assert.match(f.detail, /_qq-segment\.mjs/)
    assert.match(f.detail, /parseQQFileAttachments/)
  } finally { await env.cleanup() }
})

test('坏环境 ⑦：运行副本与仓库源码不一致 → exit 1（最隐蔽的失效模式：改仓库不生效）', async () => {
  const env = await makeHealthy()
  try {
    // 夹具不是 git 仓库 → 无法区分「未提交在制品」，按**保守**处理：一律 fail
    await writeFile(join(env.profile, 'node_modules', 'dsh-tingxue', 'src', 'plugin-entry.mjs'),
      'export const a = 999\n', 'utf8')   // 仓库改了但没同步
    const r = runCheck(env, ['--json'])
    assert.equal(r.code, 1)
    const f = json(r).findings.find((x) => x.id === 'C5')
    assert.equal(f.level, 'fail')
    assert.match(f.detail, /plugin-entry\.mjs/)
    assert.match(f.detail, /重启 DSH/)
    // 反向：完全一致时必须 ok（证明不是恒红）
    await writeFile(join(env.profile, 'node_modules', 'dsh-tingxue', 'src', 'plugin-entry.mjs'),
      'export const a = 1\n', 'utf8')
    const r2 = runCheck(env, ['--json'])
    assert.equal(r2.code, 0, '同步之后必须回到 exit 0')
  } finally { await env.cleanup() }
})

test('C5 分级：差异全是未提交的在制品 → warn（交付态没坏），不是 fail', async () => {
  const env = await makeHealthy()
  try {
    git(env.repo, ['init', '-q'])
    git(env.repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'])
    git(env.repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'])
    // 运行副本 == HEAD（同步过）；然后仓库里做**未提交**的改动
    await writeFile(join(env.repo, 'src', 'plugin-entry.mjs'), 'export const a = 2 // WIP\n', 'utf8')

    const r = runCheck(env, ['--json'])
    const f = json(r).findings.find((x) => x.id === 'C5')
    assert.equal(f.level, 'warn', `未提交在制品应降级为 warn，实际 ${f.level}：${f.detail}`)
    assert.match(f.title, /未提交的在制品/)
    assert.match(f.detail, /要生效必须先同步/)
    assert.equal(r.code, 0, '交付态自洽时不该整体判红')

    // 但一旦这份改动被**提交**（成为交付态）而运行副本还是旧的 → 必须升级为 fail
    git(env.repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'])
    git(env.repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'land it'])
    const f2 = json(runCheck(env, ['--json'])).findings.find((x) => x.id === 'C5')
    assert.equal(f2.level, 'fail', '已提交却没同步必须判 fail')
  } finally { await env.cleanup() }
})

test('坏环境 ⑧：运行副本缺仓库的新文件 → exit 1 并点名缺哪个文件', async () => {
  const env = await makeHealthy()
  try {
    await writeFile(join(env.repo, 'src', 'brand-new.mjs'), 'export const n = 1\n', 'utf8')
    const r = runCheck(env, ['--json'])
    assert.equal(r.code, 1)
    const f = json(r).findings.find((x) => x.id === 'C5')
    assert.match(f.detail, /brand-new\.mjs/)
  } finally { await env.cleanup() }
})

test('C5 也盯 client/ 与 cordis.patch.yml（浏览器半侧同样「启动时加载」）', async () => {
  const env = await makeHealthy()
  try {
    // ① client/client.js 不一致
    await mkdir(join(env.repo, 'client'), { recursive: true })
    await mkdir(join(env.profile, 'node_modules', 'dsh-tingxue', 'client'), { recursive: true })
    await writeFile(join(env.repo, 'client', 'client.js'), '// new\n', 'utf8')
    await writeFile(join(env.profile, 'node_modules', 'dsh-tingxue', 'client', 'client.js'), '// old\n', 'utf8')
    let f = json(runCheck(env, ['--json'])).findings.find((x) => x.id === 'C5')
    assert.equal(f.level, 'fail')
    assert.match(f.detail, /client\/client\.js/)

    // ② 补丁层不一致
    await writeFile(join(env.profile, 'node_modules', 'dsh-tingxue', 'client', 'client.js'), '// new\n', 'utf8')
    await writeFile(join(env.profile, 'node_modules', 'dsh-tingxue', 'cordis.patch.yml'), '- insert:\n  - id: stale\n', 'utf8')
    f = json(runCheck(env, ['--json'])).findings.find((x) => x.id === 'C5')
    assert.equal(f.level, 'fail')
    assert.match(f.detail, /cordis\.patch\.yml/)
  } finally { await env.cleanup() }
})

test('C5 只比对 manifest 的运行时字段：仓库 URL 这类元数据差异不得点红', async () => {
  const env = await makeHealthy()
  try {
    // 运行副本是旧仓库地址（改名前的形态）——与运行无关，不该判 fail
    const rtPkg = JSON.parse(await readFile(join(env.profile, 'node_modules', 'dsh-tingxue', 'package.json'), 'utf8').catch(() => '{}'))
    const repoPkg = JSON.parse(await readFile(join(env.repo, 'package.json'), 'utf8'))
    await writeFile(join(env.profile, 'node_modules', 'dsh-tingxue', 'package.json'),
      JSON.stringify({ ...repoPkg, repository: { type: 'git', url: 'git+https://github.com/old-name/dsh-tingxue.git' }, homepage: 'https://github.com/old-name/dsh-tingxue#readme' }, null, 2), 'utf8')
    const f = json(runCheck(env, ['--json'])).findings.find((x) => x.id === 'C5')
    assert.notEqual(f.level, 'fail', `仓库 URL 差异不该判 fail，实际 detail=${f.detail}`)

    // 但真正的运行时字段（dependencies）一改就必须点红
    const rt = JSON.parse(await readFile(join(env.profile, 'node_modules', 'dsh-tingxue', 'package.json'), 'utf8'))
    rt.dependencies = { 'apache-arrow': '17.0.0' }
    await writeFile(join(env.profile, 'node_modules', 'dsh-tingxue', 'package.json'), JSON.stringify(rt, null, 2), 'utf8')
    const f2 = json(runCheck(env, ['--json'])).findings.find((x) => x.id === 'C5')
    assert.equal(f2.level, 'fail')
    assert.match(f2.detail, /package\.json\(dependencies\)/)
  } finally { await env.cleanup() }
})

// ---------- 自动回滚（必须实测，不能只写在注释里） ----------

test('自动回滚：修复后复检仍不过 → 整批还原，关键文件哈希前后一致', async () => {
  const env = await makeHealthy()
  try {
    // 制造「接线缺失 + 补丁文件不存在」：修好接线，但补丁文件本来就没有 → 复检仍失败 → 必须回滚
    await writeFile(join(env.profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8')
    await rm(join(env.profile, 'patches', 'dsh-notifier.patch'))

    const before = {
      ws: await readFile(join(env.profile, 'pnpm-workspace.yaml')),
      wsHash: await stat(join(env.profile, 'pnpm-workspace.yaml')).then((s) => s.size),
    }
    const snapBefore = await snapshot(env.profile)

    const r = runCheck(env, ['--json', '--fix'])
    assert.equal(r.code, 1, '复检不过时必须整体 exit 1')
    const p = json(r)
    const rep = p.fixReport
    assert.ok(rep, '应给出 fixReport')
    assert.equal(rep.attempted, true, '应真的尝试了修复')
    assert.ok(rep.applied.includes('C4'), `应应用 C4 修复，实际 ${JSON.stringify(rep.applied)}`)
    assert.equal(rep.rolledBack, true, '复检失败必须回滚')
    assert.ok(rep.recheck.some((x) => /C4/.test(x)), `复检应报 C4 仍失败：${JSON.stringify(rep.recheck)}`)

    // 回滚的硬证据：文件逐字节回到动手前
    const after = await readFile(join(env.profile, 'pnpm-workspace.yaml'))
    assert.deepEqual(after, before.ws, 'pnpm-workspace.yaml 必须逐字节还原')
    const snapAfter = await snapshot(env.profile)
    assert.deepEqual(snapAfter, snapBefore, '整个 profile 树必须回到失败前状态')
  } finally { await env.cleanup() }
})

test('自动回滚：修复后复检通过 → 不还原，且给出前后哈希', async () => {
  const env = await makeHealthy()
  try {
    // 只缺接线，补丁文件在 → 修完就通过
    await writeFile(join(env.profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8')
    const r = runCheck(env, ['--json', '--fix'])
    const p = json(r)
    assert.equal(p.ok, true, `修完应全绿，实际 fail=${p.summary.fail}`)
    const rep = p.fixReport
    assert.equal(rep.attempted, true)
    assert.equal(rep.rolledBack, false, '复检通过不该回滚')
    assert.ok(rep.applied.includes('C4'))
    // 修复结果落地：文件里真的出现了接线
    const ws = await readFile(join(env.profile, 'pnpm-workspace.yaml'), 'utf8')
    assert.match(ws, /patchedDependencies:/)
    assert.match(ws, /dsh-notifier: patches\/dsh-notifier\.patch/)
    // 前后哈希都在报告里
    assert.ok(rep.files.every((f) => f.hashAfter && f.hashBefore !== undefined))
  } finally { await env.cleanup() }
})

test('默认（不加 --fix）绝不写文件：整个 profile 树逐字节不变', async () => {
  const env = await makeHealthy()
  try {
    await writeFile(join(env.profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8')  // 有可修项
    const pkg = JSON.parse(await readFile(join(env.profile, 'package.json'), 'utf8'))
    pkg.dependencies['dsh-notifier'] = '^0.9.0'
    await writeFile(join(env.profile, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')

    const before = await snapshot(env.profile)
    const r = runCheck(env, ['--json'])
    assert.equal(r.code, 1, '有 fail 就该 exit 1')
    const p = json(r)
    assert.equal(p.fixReport.attempted, false)
    assert.equal(p.fixReport.reason.includes('未加 --fix'), true)
    assert.ok(p.fixesAvailable.length >= 2, `应列出可修项，实际 ${JSON.stringify(p.fixesAvailable)}`)
    const after = await snapshot(env.profile)
    assert.deepEqual(after, before, '校验模式绝不许写任何文件')
  } finally { await env.cleanup() }
})

// ---------- 安全底线：活 profile 只读 ----------

test('--fix 遇到活 profile 一律拒写（除非显式 --allow-live-profile）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tx-livecheck-'))
  try {
    const home = join(root, '.dsh')
    const profile = join(home, 'profiles', 'web')
    const repo = join(root, 'repo')
    await mkdir(join(repo, 'src'), { recursive: true })
    await mkdir(profile, { recursive: true })
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      name: 'dsh-tingxue', version: '0.1.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } }, files: ['src', 'cordis.patch.yml'],
    }, null, 2), 'utf8')
    await writeFile(join(repo, 'cordis.patch.yml'), '- insert: []\n', 'utf8')

    // 活 profile：缺 bundles 名单（= 可修项，但落在活状态里，必须拒绝写）
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true,
      dependencies: { 'dsh-tingxue': 'file:../../../repo' },
      dsh: { profile: { bundles: [] } },
    }, null, 2), 'utf8')
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: dsh-notifier\n  config:\n    inbound:\n      qq:\n        appSecret: "${FAKE_SECRET}"\n`, 'utf8')

    const before = await snapshot(profile)
    const argv = [SCRIPT, '--repo-dir', repo, '--profile-dir', profile, '--no-pack', '--fix', '--json']
    let out
    try {
      out = execFileSync(process.execPath, argv, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsHide: true,
        env: { ...process.env, DSH_HOME: home },
      })
    } catch (e) { out = String(e.stdout ?? '') }

    const p = JSON.parse(out)
    assert.equal(p.fixReport.attempted, false, '活 profile 上的可修项不得被写入')
    assert.match(p.fixReport.reason, /活 profile/)
    assert.ok(p.fixReport.skipped.includes('C2'), `应记录被跳过的活状态项：${JSON.stringify(p.fixReport)}`)

    const after = await snapshot(profile)
    assert.deepEqual(after, before, '活 profile 必须逐字节不变')
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ---------- 凭据：不回显、不落仓库 ----------

test('凭据不回显：--json 输出里绝不出现 profile 中的凭据明文（只报数量与文件）', async () => {
  const env = await makeHealthy()
  try {
    const r = runCheck(env, ['--json'])
    assert.ok(!r.stdout.includes(FAKE_SECRET), '标准输出里出现了凭据明文')
    assert.ok(!r.stderr.includes(FAKE_SECRET), '标准错误里出现了凭据明文')
    const p = json(r)
    const f = p.findings.find((x) => x.id === 'C7')
    assert.equal(f.level, 'warn', '应识别出「风险面在仓库外」并告警')
    assert.match(f.detail, /cordis\.patch\.yml/)
    assert.match(f.detail, /1 处/, '只报处数，不报值')
    assert.ok(!JSON.stringify(p).includes(FAKE_SECRET), '整个 JSON 里都不得有凭据明文')
  } finally { await env.cleanup() }
})

test('凭据落仓库即报警：仓库文件里出现活配置的凭据 → C6-secret 判 fail', async () => {
  const env = await makeHealthy()
  try {
    await writeFile(join(env.repo, 'README.md'), `# 听雪\n\n误拷进来的配置：appSecret: "${FAKE_SECRET}"\n`, 'utf8')
    const r = runCheck(env, ['--json'])
    assert.equal(r.code, 1)
    const f = json(r).findings.find((x) => x.id === 'C6-secret')
    assert.equal(f.level, 'fail')
    assert.match(f.detail, /README\.md/)
    // 依然不回显值
    assert.ok(!r.stdout.includes(FAKE_SECRET))
  } finally { await env.cleanup() }
})

// ---------- npm 打包：files 才是权威 ----------

test('npm pack 清单体检：.gitignore 拦不住打包，未列入 files 的新脚本不会进包', async () => {
  const files = packFileList()
  assert.ok(files.includes('scripts/selfcheck.mjs'), 'selfcheck.mjs 应在包里')
  assert.ok(!files.includes('test/install-check.test.mjs'), '测试文件不该进包')
  assert.ok(!files.includes('_profile-patch-backup.yml'), '带凭据的本机备份不该进包')
  assert.ok(!files.some((f) => f.endsWith('.patch')), '补丁不该进包')
  // 关键事实：本任务新增的 install-check.mjs 未被 package.json 的 files 收录 → 不进包
  assert.equal(files.includes('scripts/install-check.mjs'), false,
    'package.json 的 files 白名单未收录 install-check.mjs；若被收录请同步更新本断言与 README')
  // 且仓库里确实存在它（证明是「白名单挡住的」而不是「文件不存在」）
  assert.ok(existsSync(join(REPO, 'scripts', 'install-check.mjs')))
})

test('仓库目录不是 profile：脚本拒绝瞎跑（exit 2），不给出假的结论', () => {
  const argv = [SCRIPT, '--repo-dir', REPO, '--profile-dir', REPO, '--no-pack']
  let code = 0
  let stderr = ''
  try { execFileSync(process.execPath, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsHide: true }) } catch (e) { code = e.status ?? -1; stderr = String(e.stderr ?? '') }
  assert.equal(code, 2, `应 exit 2（拒绝瞎跑），实际 ${code}`)
  assert.match(stderr, /不是 profile|同一个目录/)
})

/** 跑一次真实 npm pack --dry-run --json 取文件清单（走 node，绕开 Windows 的 npm.cmd EINVAL）。 */
function packFileList() {
  const { npmCliPath } = { npmCliPath: () => findNpmCli() }
  const cli = npmCliPath()
  assert.ok(cli, '找不到 npm CLI')
  const out = execFileSync(process.execPath, [cli, 'pack', '--dry-run', '--json'], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000, windowsHide: true,
  })
  const parsed = JSON.parse(out)
  const meta = Array.isArray(parsed) ? parsed[0] : parsed
  return meta.files.map((f) => f.path)
}
function findNpmCli() {
  const cands = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const c of cands) if (existsSync(c)) return c
  return null
}

test('readProfileConfig 拿到的 dataDir 会出现在 JSON 里（供排障），但不含凭据', async () => {
  const env = await makeHealthy()
  try {
    const r = runCheck(env, ['--json'])
    const p = json(r)
    assert.equal(p.config.dataDir, undefined, '本夹具的补丁里没有 dataDir')
    assert.equal(p.mode, 'check')
    assert.equal(p.profileDir, env.profile)
  } finally { await env.cleanup() }
})

// ============================================================================
// 核心回归用例集：**与 `--self-test` 跑的是同一批用例，只有一处实现**
// ============================================================================
//
// 为什么要把它们搬进来（而不继续只活在 `--self-test` 里）：
// 这些用例证明的是「修复动作改写真实 YAML 时会不会写坏」——恰恰是本任务的核心风险。
// 但在此之前，它们**只在 `--self-test` 里**，于是把 `wirePatchedDependency` 改回字符串
// 追加、或用 `else if` 把 C3 的已装版本检查挂掉，**标准 verify 命令仍然全绿**：
// 回归没有落在标准套件里，就等于没有保护。现在两者共用同一实现，消灭双份漂移。
//
// 注册方式：`registerCoreCases` 接受一个 `t(name, fn)` 注册器。这里把 `node:test` 的
// `test` 包一层，使其签名与 `--self-test` 收集器一致；用例里的断言失败会原样抛出，
// 由 node:test 记为失败。
//
// 夹具目录由一个**顶层临时目录**提供，进程退出时统一清理（用例在 node:test 下是异步
// 注册并执行的，不能在建完就删）。全程只碰 tmpdir，绝不写活 profile。

const CORE_TMP = await mkdtemp(join(tmpdir(), 'tx-corecases-'))
process.on('exit', () => { try { rmSync(CORE_TMP, { recursive: true, force: true }) } catch { /* 尽力而为 */ } })

/** 用例上下文（`eq`/`assert`/`tmp`），与 `--self-test` 用的是同一套。 */
const ctx = makeCaseContext(CORE_TMP)
/** 登记到的核心用例名（供下面的「接线自检」断言用）。 */
const coreCaseNames = []
{
  /** 与 `--self-test` 的收集器同签名：`t(name, fn)`。 */
  const t = (name, fn) => { coreCaseNames.push(name); test(`核心回归｜${name}`, fn) }
  registerCoreCases({ t, ...ctx })
}

// 接线自检：证明「核心用例集确实被登记进来了」，而不是某个改动让它静默变成 0 条。
// 没有这条，`registerCoreCases` 若被误改成空函数，套件会**照样全绿**（少 31 条用例），
// 而这正是本任务要消灭的那类缺陷（回归没落地却看起来有保护）。
//
// 【为什么是**具名清单**而不是 `length >= 25`】—— 2026-09-26 复核 F4
// `>= 25` 是个**下界**，防不住「削条」：实测把 31 条悄悄砍到 25 条、且保留下面那 5 个
// 关键字时，标准命令与 `--self-test` **全都照样全绿**（被砍掉的 6 条含 C9 若干格）。
// 具名比对则「删掉其中任何一条都会红」；新增用例不会误报（本断言只要求清单里的仍在）。
//
// 【清单自身也须把守】若清单被删空，下面的过滤会**空转通过**（空数组永远没有 missing）
// —— 那又是一次「恒真断言」。故先断言清单长度与去重后长度，把清单自己也变成可证伪的。
//
// 【维护】新增核心用例时**不必**改这里（新增不触发本断言）；仅当**有意删除/改名**
// 某条核心用例时才同步修改清单 —— 那次修改本身就是一次需要被复核的动作。
const GOLDEN_CORE_NAMES = [
  'scanWorkspaceYaml 检出重复顶级键',
  'scanWorkspaceYaml 无重复时不误报',
  'validateWorkspaceYaml 对重复顶级键判不通过',
  'validateWorkspaceYaml 检出 Tab 缩进',
  'validateWorkspaceYaml 检出同级没对齐',
  'validateWorkspaceYaml 检出 flow 括号不闭合',
  'validateWorkspaceYaml 对健康文件判通过',
  '验收1.3(a) 修复保留他包条目，产物可被解析',
  '修复在 patchedDependencies 缺失时会新建该映射',
  '修复在 patchedDependencies 为空值时也成立',
  '无法安全解析时拒绝修复（不硬拼）—— 重复顶级键',
  '无法安全解析时拒绝修复 —— patchedDependencies 不是映射',
  '无法安全解析时拒绝修复 —— Tab 缩进',
  '验收1.3(b) 修复产物能被 pnpm install 接受',
  '验收1.3(b) 负向对照：坏 YAML（重复顶级键）必须被 pnpm 判出来',
  'C3 矩阵① spec=0.9.0 instVer=0.9.0 → ok',
  'C3 矩阵② spec=0.9.0 instVer=0.12.0 → fail（旧 else if 会漏判这一格）',
  'C3 矩阵③ spec=^0.9.0 instVer=0.9.0 无 lock → fail',
  'C3 矩阵④ spec=^0.9.0 instVer=0.9.0 有 lock → warn（README L131）',
  'C3 两轴都错 → 两条都报（不互相掩盖）',
  'C3 两轴都错且有 lock → fail + warn 并存',
  'C3 未装 notifier 时按声明判，不谎报已安装',
  'C4-ws 模板含 nodeLinker: hoisted 且结构自校验通过',
  'C9 对健康 profile 补丁判 ok',
  'C9 对缩进坏掉的 profile 补丁判 fail（整个 profile 起不来）',
  'C9 对同一个 id 出现多条补丁项判 ok（cordis 的正常语义，不许误报）',
  'C9 对同一个映射里重复的键判 fail（真结构错误）',
  'C9 顶层不是数组判 fail（拷错文件）',
  'C9 抓到「缩进异常的悬挂行」（本机真实事故形态）',
  'C9 抓到「悬挂的裸值行」（既非键值对也非序列项）',
  'C9 对「缩进正确的未知键」判 ok（未知键不是错误，只有结构错才是）',
]
const GOLDEN_CORE_COUNT_LITERAL = 31

test('接线自检：核心用例集已登记且逐条在册（防空跑 + 防削条）', () => {
  // （1）清单自身的把守：不许被删空、不许被截短、不许有重复 —— 否则下面的比对会退化成恒真。
  //
  // 【为什么需要**两条**、且下界是硬编码数字】
  // 2026-09-26 变异实验逐个试出来的：
  //   · 「清空清单」若只靠下面那条 `assert.equal(…, GOLDEN_CORE_COUNT_LITERAL)` 把守，
  //     那么**把常量也改成 0**（`0 === 0`）就让本断言整条空转全绿 —— 把守被绕过；
  //   · 所以下界写成**硬编码 25**（不经任何可改变量）。即便有人把常量一起改小，
  //     清单被清空时 `0 >= 25` 必假 → 仍会红；
  //   · 而「截短」（例如 31 → 28，常量也跟着改）不会被下界抓到，**只能靠等值判据**。
  // 两条各管一头，缺一条就留一个绕过口子。（这本身就是「两个可变量互相印证 = 没有约束」。）
  assert.ok(GOLDEN_CORE_NAMES.length >= 25,
    `黄金清单只剩 ${GOLDEN_CORE_NAMES.length} 条 —— 清单被清空或大幅截短了，缺失比对会因此失去意义`)
  assert.equal(GOLDEN_CORE_NAMES.length, GOLDEN_CORE_COUNT_LITERAL,
    `黄金清单应为 ${GOLDEN_CORE_COUNT_LITERAL} 条，实际 ${GOLDEN_CORE_NAMES.length} 条 —— 清单被截短过？`)
  assert.equal(new Set(GOLDEN_CORE_NAMES).size, GOLDEN_CORE_NAMES.length,
    '黄金清单里存在重复项，会使缺失比对失去意义')

  // （2）逐条在册：**删掉其中任何一条都会红**（这是 `>= 25` 挡不住的）
  const missing = GOLDEN_CORE_NAMES.filter((n) => !coreCaseNames.includes(n))
  assert.deepEqual(missing, [],
    `以下核心回归用例未被登记（是被删了、改名了，还是 registerCoreCases 被改坏了？）：\n  - ${missing.join('\n  - ')}`)

  // （3）名字里必须含本任务的关键回归，避免「清单够但不是那批」（与逐条在册互补）
  for (const key of ['验收1.3(a)', '验收1.3(b)', 'C3 矩阵', '重复顶级键', 'C9']) {
    assert.ok(coreCaseNames.some((n) => n.includes(key)),
      `核心用例里缺少关键回归「${key}」；实际登记：${coreCaseNames.join(' / ')}`)
  }
})

// 真机回归（依赖本机活 profile 的实际内容）：这里作为**环境提示**，不通过时只 warn。
// 理由与 `--self-test` 一致：它判的是「这台机器现在健不健康」，不是「脚本逻辑对不对」；
// 把它算作套件失败，会让 CI / 无 profile 环境的套件无故变红。
test('核心回归｜真机：活 profile 结构可解析（环境提示，不通过只 warn）', (t) => {
  const issues = []
  const t2 = (name, fn) => { try { fn() } catch (e) { issues.push(`${name}：${e?.message ?? e}`) } }
  registerLiveCases({ t: t2, eq: ctx.eq, assert: ctx.assert })
  if (issues.length > 0) {
    // 只警告，不让套件失败：它判的是「这台机器现在健不健康」，不是「脚本逻辑对不对」。
    console.warn('  ⚠ 活 profile 环境提示（不计入套件失败）：\n    ' + issues.join('\n    '))
  }
  t.diagnostic(`活 profile 真机回归：${issues.length === 0 ? '全部通过' : issues.length + ' 条提示'}`)
})
