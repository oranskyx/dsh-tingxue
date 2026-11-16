// 人格段必须排在 DSH 全部工具段之后、人格后缀之前。
//
// 2026-11-16：原先 ORDER_PERSONA = 900，而 DSH 的 SECTION_ORDERS 里
//   900  是 FILE_REFERENCE（撞值，先后未定义）
//   1000-3100 是全部 TOOL_* / MCP_SERVERS 段
// 于是改一次人格档案，后面一千多行工具定义的 prompt 缓存全部失效。
// 现在放在 10150（WEB_SURFACE 10100 与 DEPLOYMENT_PERSONA_SUFFIX 10200 之间）。
//
// 这个测试盯住三件事：
//   1. 高于所有工具段（> 3100）
//   2. 低于人格后缀（< 10200），否则会被后缀盖住语义
//   3. 不等于 FILE_REFERENCE 的 900（撞值）

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/im-bot/index.mjs', import.meta.url), 'utf8')

// DSH 侧的事实（来自 app.asar 的 SECTION_ORDERS），写成常量便于对照：
const DSH = {
  FILE_REFERENCE: 900,
  LAST_TOOL_SECTION: 3100, // MCP_SERVERS
  PERSONA_SUFFIX: 10200,
}

function readOrder() {
  const match = source.match(/const ORDER_PERSONA = (\d+);/)
  assert.ok(match, '找不到 ORDER_PERSONA 常量')
  return Number(match[1])
}

test('ORDER_PERSONA 在全部工具段之后（改档案不冲掉工具定义的缓存）', () => {
  const order = readOrder()
  assert.ok(
    order > DSH.LAST_TOOL_SECTION,
    `ORDER_PERSONA=${order} 没有排在工具段（最大 ${DSH.LAST_TOOL_SECTION}）之后`,
  )
})

test('ORDER_PERSONA 在人格后缀之前', () => {
  const order = readOrder()
  assert.ok(
    order < DSH.PERSONA_SUFFIX,
    `ORDER_PERSONA=${order} 超过了 DEPLOYMENT_PERSONA_SUFFIX(${DSH.PERSONA_SUFFIX})`,
  )
})

test('ORDER_PERSONA 不与 DSH 的 FILE_REFERENCE 撞值', () => {
  const order = readOrder()
  assert.notEqual(order, DSH.FILE_REFERENCE, 'ORDER_PERSONA 又撞回 FILE_REFERENCE 的 900 了')
})

test('ORDER_PERSONA 只在一处出现（section 与 context 不会各写一份）', () => {
  const hits = source.match(/ORDER_PERSONA/g) ?? []
  // 1 处定义 + 2 处使用（section、status 里各一次），超过说明有第二份来源
  assert.ok(hits.length <= 4, `ORDER_PERSONA 出现了 ${hits.length} 次，可能有多份定义`)
})
