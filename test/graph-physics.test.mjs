// 图谱物理：斥力可以限预算，弹簧和积分不能。
//
// 2026-11-08 的 bug：simulate() 把同一个 activeCount 传给了 applySprings 和
// integrate，而 activeCount 是按视口面积算的斥力预算。面板 iframe（900×520）
// 只算出 374，于是第 375~402 个节点既没有斥力、也没有弹簧、连向心力和阻尼都
// 不施加——它们原地冻结、彼此重叠，表现成「有些点根本不动」，而网页版全屏
// 因为预算（1382）大于节点数，一切正常，所以只在面板里复现。
//
// 这个测试不跑 canvas（跑不了），而是对源码做结构性断言：三个函数必须各自
// 独立——斥力受预算约束，弹簧与积分必须全量。改回旧写法会立刻变红。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../service/ui/graph-engine.js', import.meta.url), 'utf8')

function bodyOf(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start > 0, `找不到 ${name}`)
  let depth = 0
  let i = source.indexOf('{', start)
  const from = i
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(from, i + 1)
    }
  }
  throw new Error(`${name} 花括号不闭合`)
}

test('applySprings 不再接受 activeCount 截断', () => {
  assert.match(source, /function applySprings\(\)\s*\{/, 'applySprings 必须无参数')
  const body = bodyOf('applySprings')
  assert.doesNotMatch(body, /activeCount/, 'applySprings 里不该再出现 activeCount')
})

test('integrate 全量积分，不再接受 activeCount', () => {
  assert.match(source, /function integrate\(\)\s*\{/, 'integrate 必须无参数')
  const body = bodyOf('integrate')
  assert.doesNotMatch(body, /activeCount/, 'integrate 里不该再出现 activeCount')
  assert.match(body, /i < nodes\.length/, 'integrate 必须遍历全部节点')
})

test('simulate 分开调用：斥力限预算，弹簧/积分全量', () => {
  const body = bodyOf('simulate')
  assert.match(body, /applyRepulsion\(count\)/, '斥力仍然按 count 进入（内部再限预算）')
  assert.match(body, /applySprings\(\)/, 'applySprings 必须无参调用')
  assert.match(body, /integrate\(\)/, 'integrate 必须无参调用')
})

test('斥力预算在面板视口下也能覆盖 402 个实体', () => {
  const body = bodyOf('applyRepulsion')
  const match = body.match(/Math\.max\((\d+),\s*Math\.floor\(\(size\.w \|\| 900\) \* \(size\.h \|\| 600\) \* ([0-9.]+)\)\)/)
  assert.ok(match, '找不到斥力预算公式')
  const floor = Number(match[1])
  const ratio = Number(match[2])
  const nodes = 402
  // 面板里常见的几档 iframe 视口
  for (const [w, h] of [[1920, 900], [900, 520], [820, 460], [700, 400]]) {
    const budget = Math.max(floor, Math.floor(w * h * ratio))
    assert.ok(
      Math.min(nodes, budget) >= nodes,
      `${w}×${h} 下预算只有 ${budget}，覆盖不了 ${nodes} 个节点（下限 ${floor}、系数 ${ratio}）`,
    )
  }
})
