#!/usr/bin/env node
/**
 * 跑全部测试：逐个文件 spawn，与 CI 的跑法一致。
 *
 * 为什么不用 `node --test <glob>`：
 *   · Windows 上 npm 用 cmd 执行脚本，通配符不会被 shell 展开；
 *   · 本项目里有一半测试文件是手写 runner（直接 console.log + exit code），
 *     不是 node:test 的 TAP 格式，混在 `--test` 的多进程池里输出会被误判。
 * 逐个 spawn 的好处是：一个文件崩了能立刻定位到文件名，且跨平台行为一致。
 *
 * 用法：node scripts/run-tests.mjs   （npm test）
 */
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TESTS = join(ROOT, 'test');

/** 递归找出所有 *.test.mjs（含 test/patches/ 这种子目录）。 */
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.test.mjs')) out.push(p);
  }
  return out;
}

const files = walk(TESTS).sort();
if (files.length === 0) {
  console.error('没找到任何测试文件（test/**/*.test.mjs）');
  process.exit(1);
}

let failed = 0;
const t0 = Date.now();
for (const f of files) {
  const rel = relative(ROOT, f);
  const started = Date.now();
  const r = spawnSync(process.execPath, [f], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ms = Date.now() - started;
  if (r.status === 0) {
    console.log(`  ok   ${rel}  (${ms}ms)`);
  } else {
    failed += 1;
    console.log(`  FAIL ${rel}  (${ms}ms, exit ${r.status})`);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    if (out) console.log(out.split('\n').slice(-25).map((l) => `       ${l}`).join('\n'));
  }
}

console.log(`\n${files.length - failed}/${files.length} 个测试文件通过，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(failed === 0 ? 0 : 1);
