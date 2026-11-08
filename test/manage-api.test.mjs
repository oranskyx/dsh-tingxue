// dsh-tingxue test/manage-api.test.mjs
// 管理 API 集成测试（service/API.md §2-§8）：
//  - 真实 LanceDB（**临时 dataDir**）+ 假模型（确定性向量）+ 假图谱。
//  - 不写真实库、不占用 8766（用 18766，占位服务用随机端口）。
//  - 覆盖：实体 CRUD/冲突、关系 CRUD/自环、记忆 PATCH 重嵌入、删实体级联+摘引用、
//    合并、回收站恢复（含 409 冲突）、审计、统计、分页/过滤、配置脱敏、
//    实体/关系/记忆/回收站/审计/配置、CORS、重启后文件持久化。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryStore } from '../src/memory/store.mjs'
import { createMemoryService } from '../src/memory-service/index.mjs'

const API_PORT = 18766
const API_KEY_MARKER = 'sk-live-should-never-leak'

const root = await mkdtemp(join(tmpdir(), 'tingxue-manage-test-'))
const dataDir = join(root, 'data')
const configPath = join(root, 'config.json')

/** 确定性 4 维向量：同样文本 → 同样向量。 */
function vectorOf(text) {
  const value = String(text ?? '')
  let hash = 2166136261
  for (const char of value) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return [
    (hash % 97) / 97,
    ((hash >>> 3) % 89) / 89,
    ((hash >>> 7) % 83) / 83,
    ((hash >>> 11) % 79) / 79,
  ]
}

const embedCalls = []
const ingestCalls = []

const fakeModel = {
  async embed(texts) {
    const list = Array.isArray(texts) ? texts : [texts]
    for (const text of list) embedCalls.push(text)
    return list.map(vectorOf)
  },
  async complete() {
    return JSON.stringify({ entities: [], relations: [] })
  },
}

const fakeGraph = {
  async ingest(text, { source } = {}) {
    ingestCalls.push({ text, source })
    return { entityIds: [], newEntities: 0, relationsAdded: 0 }
  },
}

const configView = {
  dataDir,
  profilePath: '',
  memoryServiceHost: '127.0.0.1',
  memoryServicePort: API_PORT,
  graphDashboardHost: '127.0.0.1',
  memoriesIdentity: 'user',
  modelBackend: 'fake',
  embeddingModel: 'fake-embedding',
  embeddingDimensions: 4,
  llmModel: 'initial-llm',
}

let store
let svc
let base

/** 发请求并解析 JSON（解析失败时保留 text 便于断言 BigInt 挂起类问题）。 */
async function call(path, { method = 'GET', body, target = base, origin } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (origin) headers.Origin = origin
  const response = await fetch(target + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 保留 text */ }
  return { status: response.status, json, text, headers: response.headers }
}

async function createEntity(name, type = 'concept', summary = '') {
  const result = await call('/memory/entities', { method: 'POST', body: { name, type, summary } })
  assert.equal(result.status, 200, `POST entity 失败: ${result.status} ${result.text}`)
  return result.json.entity
}

async function createRelation(sourceId, targetId, relation) {
  const result = await call('/memory/relations', {
    method: 'POST', body: { sourceId, targetId, relation },
  })
  assert.equal(result.status, 200, `POST relation 失败: ${result.status} ${result.text}`)
  return result.json.relation
}

before(async () => {
  await mkdir(dataDir, { recursive: true })
  // 配置文件里的未知字段必须在 PUT 后保留。
  await writeFile(configPath, `${JSON.stringify({ llmModel: 'initial-llm', customUnknown: 'keep-me' }, null, 2)}\n`)

  store = await createMemoryStore({ dataDir, dimensions: 4 })
  svc = createMemoryService(
    {
      store,
      model: fakeModel,
      graph: fakeGraph,
      profilePath: '',
      logger: { warn() {}, info() {} },
      dataDir,
      configPath,
      configView,
      apiKeyPresent: true,
    },
    {
      memoryServiceHost: '127.0.0.1',
      memoryServicePort: API_PORT,
      memoriesIdentity: 'user',
        },
  )
  base = await svc.start()
  assert.ok(base, '记忆 API 应启动成功')
})

after(async () => {
  try { await svc?.stop() } catch { /* 忽略 */ }
  try { await store?.close() } catch { /* 忽略 */ }
  await rm(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------- §1 基础

test('健康检查 + profile（旧端点保持）', async () => {
  const health = await call('/health')
  assert.equal(health.status, 200)
  assert.equal(health.json.ok, true)
  assert.equal(health.json.service, 'dsh-tingxue-memory')
  assert.equal(typeof health.json.port, 'number')

  const profile = await call('/profile')
  assert.equal(profile.status, 200)
  assert.equal(profile.json.ok, true)
  assert.equal(profile.json.profile, '')
})

// ---------------------------------------------------------------- §2 实体

test('实体：新建/409 冲突/默认类型/校验', async () => {
  const alice = await createEntity('Alice', 'person', '工程师')
  assert.ok(alice.id)
  assert.equal(alice.name, 'Alice')
  assert.equal(alice.type, 'person')
  assert.equal(typeof alice.createdAt, 'number', 'Int64 必须转 Number')
  assert.equal('vector' in alice, false, '响应绝不能包含向量')

  // 同名同类型 → 409 code entity-exists，并回带已有实体
  const duplicate = await call('/memory/entities', {
    method: 'POST', body: { name: 'Alice', type: 'person', summary: '另一个' },
  })
  assert.equal(duplicate.status, 409)
  assert.equal(duplicate.json.ok, false)
  assert.equal(duplicate.json.code, 'entity-exists')
  assert.equal(duplicate.json.entity.id, alice.id)

  // 同名不同类型允许
  const aliceConcept = await createEntity('Alice', 'concept', '同名不同类')
  assert.notEqual(aliceConcept.id, alice.id)

  // 大小写不同视为同名（大小写不敏感查重）
  const ciDuplicate = await call('/memory/entities', {
    method: 'POST', body: { name: 'alice', type: 'person' },
  })
  assert.equal(ciDuplicate.status, 409)

  // 默认类型 concept
  const bob = await createEntity('Bob')
  assert.equal(bob.type, 'concept')

  // name 必填
  const invalid = await call('/memory/entities', { method: 'POST', body: { name: '  ' } })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.json.ok, false)

  // 非法 JSON → 400（不是 500）
  const badJson = await fetch(`${base}/memory/entities`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json',
  })
  assert.equal(badJson.status, 400)
})

test('实体：列表分页/过滤 + 无参旧行为', async () => {
  const legacy = await call('/memory/entities')
  assert.equal(legacy.status, 200)
  assert.equal(legacy.json.ok, true)
  assert.ok(Array.isArray(legacy.json.entities))
  assert.equal(legacy.json.total, undefined, '无参时必须保持旧响应 {ok,entities}')

  const filtered = await call('/memory/entities?q=ali')
  assert.equal(filtered.status, 200)
  assert.equal(filtered.json.total, 2, 'Alice(personal) 与 Alice(concept) 共 2 条')
  assert.ok(filtered.json.entities.every((entity) => entity.name.toLowerCase().includes('ali')))

  const byType = await call('/memory/entities?type=person&limit=100')
  assert.ok(byType.json.total >= 1)
  assert.ok(byType.json.entities.every((entity) => entity.type === 'person'))

  const page = await call('/memory/entities?limit=1&offset=1')
  assert.equal(page.json.entities.length, 1)
  assert.equal(typeof page.json.total, 'number')
  assert.ok(page.json.total >= 2)
})

test('实体：详情含关系/关联记忆/向量近邻/计数', async () => {
  const center = await createEntity('DetailCenter', 'person', '中心人物')
  const other = await createEntity('DetailOther', 'thing', '关联物')
  const relation = await createRelation(center.id, other.id, 'detail-rel')

  // 直接挂一条含 entityIds 的记忆（管理读接口应能看到）
  const memoryId = await store.addMemory({
    text: 'DetailCenter 与 DetailOther 的关联记忆',
    vector: vectorOf('DetailCenter 与 DetailOther 的关联记忆'),
    scene: 'test',
    entityIds: [center.id],
  })

  const detail = await call(`/memory/entities/${center.id}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.json.ok, true)
  assert.equal(detail.json.entity.id, center.id)
  assert.equal('vector' in detail.json.entity, false)

  assert.equal(detail.json.relations.length, 1)
  const edge = detail.json.relations[0]
  assert.equal(edge.id, relation.id)
  assert.equal(edge.direction, 'out')
  assert.equal(edge.otherId, other.id)
  assert.equal(edge.otherName, 'DetailOther')

  assert.equal(detail.json.memories.length, 1)
  assert.equal(detail.json.memories[0].id, memoryId)
  assert.equal(detail.json.counts.relations, 1)
  assert.equal(detail.json.counts.memories, 1)

  assert.ok(Array.isArray(detail.json.neighbors))
  assert.ok(detail.json.neighbors.length <= 5)
  assert.ok(detail.json.neighbors.every((neighbor) => neighbor.id !== center.id))
  assert.equal(typeof detail.json.neighbors[0]?.distance, 'number')

  const missing = await call('/memory/entities/not-a-real-id')
  assert.equal(missing.status, 404)
})

test('实体：PATCH 改名/摘要重嵌入 + 冲突 + 校验', async () => {
  const target = await createEntity('PatchMe', 'concept', '旧摘要')
  const occupied = await createEntity('PatchOccupied', 'concept')

  const embedCountBefore = embedCalls.length
  const updated = await call(`/memory/entities/${target.id}`, {
    method: 'PATCH', body: { name: 'PatchRenamed', summary: '更新摘要' },
  })
  assert.equal(updated.status, 200, updated.text)
  assert.equal(updated.json.entity.name, 'PatchRenamed')
  assert.equal(updated.json.entity.summary, '更新摘要')
  assert.ok(embedCalls.length > embedCountBefore, '改名/摘要必须重嵌入')
  assert.ok(embedCalls.includes('PatchRenamed：更新摘要'),
    `重嵌入文本应为 name：summary，实际调用 ${JSON.stringify(embedCalls.slice(-3))}`)

  const conflict = await call(`/memory/entities/${target.id}`, {
    method: 'PATCH', body: { name: occupied.name },
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.json.code, 'entity-exists')

  const noFields = await call(`/memory/entities/${target.id}`, { method: 'PATCH', body: {} })
  assert.equal(noFields.status, 400)

  const nonexistent = await call('/memory/entities/nope', {
    method: 'PATCH', body: { name: 'x' },
  })
  assert.equal(nonexistent.status, 404)

  // 只改 type 不应重嵌入
  const embedCountBeforeType = embedCalls.length
  const typeOnly = await call(`/memory/entities/${target.id}`, {
    method: 'PATCH', body: { type: 'thing' },
  })
  assert.equal(typeOnly.status, 200)
  assert.equal(typeOnly.json.entity.type, 'thing')
  assert.equal(embedCalls.length, embedCountBeforeType, '只改 type 不应触发重嵌入')
})

// ---------------------------------------------------------------- §3 关系

test('关系：新建校验（自环/缺失）+ 列表含两端名 + PATCH + 删除进回收站', async () => {
  const a = await createEntity('RelA', 'person')
  const b = await createEntity('RelB', 'thing')
  const c = await createEntity('RelC', 'thing')

  const selfLoop = await call('/memory/relations', {
    method: 'POST', body: { sourceId: a.id, targetId: a.id, relation: 'self' },
  })
  assert.equal(selfLoop.status, 400)
  assert.equal(selfLoop.json.code, 'self-loop')

  const missing = await call('/memory/relations', {
    method: 'POST', body: { sourceId: a.id, targetId: 'nope', relation: 'x' },
  })
  assert.equal(missing.status, 400)

  const relation = await createRelation(a.id, b.id, 'rel-unique-1')
  assert.equal(relation.sourceId, a.id)
  assert.equal(relation.targetId, b.id)
  assert.equal(relation.validTo, 0)
  assert.equal(typeof relation.validFrom, 'number')

  const listed = await call('/memory/relations?q=rel-unique-1&includeEnded=true&limit=10')
  assert.equal(listed.status, 200)
  assert.equal(listed.json.total, 1)
  const item = listed.json.relations[0]
  assert.equal(item.sourceName, 'RelA')
  assert.equal(item.targetName, 'RelB')

  // 旧行为：无参返回数组（含 total），字段齐全（同样带两端名）
  const legacy = await call('/memory/relations')
  assert.equal(legacy.status, 200)
  assert.ok(Array.isArray(legacy.json.relations))
  assert.equal(typeof legacy.json.total, 'number')
  const legacyItem = legacy.json.relations.find((item) => item.id === relation.id)
  assert.ok(legacyItem)
  assert.equal(legacyItem.sourceName, 'RelA')
  assert.equal(legacyItem.targetName, 'RelB')

  // 把目标端改成 RelC，再把关系结束（validTo > 0）
  const moved = await call(`/memory/relations/${relation.id}`, {
    method: 'PATCH', body: { targetId: c.id, relation: 'rel-unique-1b' },
  })
  assert.equal(moved.status, 200, moved.text)
  assert.equal(moved.json.relation.targetId, c.id)
  assert.equal(moved.json.relation.relation, 'rel-unique-1b')

  const ended = await call(`/memory/relations/${relation.id}`, {
    method: 'PATCH', body: { validTo: 1690000000000 },
  })
  assert.equal(ended.status, 200)
  assert.equal(ended.json.relation.validTo, 1690000000000)

  // 默认（带 limit 参数）不包含已结束关系
  const activeOnly = await call('/memory/relations?q=rel-unique-1b&limit=10')
  assert.equal(activeOnly.json.total, 0, 'includeEnded 缺省应只返回有效关系')
  const withEnded = await call('/memory/relations?q=rel-unique-1b&includeEnded=true&limit=10')
  assert.equal(withEnded.json.total, 1)

  const deleted = await call(`/memory/relations/${relation.id}`, { method: 'DELETE' })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.json.deleted, true)
  const detail = await call(`/memory/relations/${relation.id}`)
  assert.equal(detail.status, 404)
})

// ---------------------------------------------------------------- §4 记忆

test('记忆：POST /memory → 列表 q/scene 过滤 → 详情 → PATCH 重嵌入 → 删除进回收站', async () => {
  const created = await call('/memory', {
    method: 'POST', body: { text: 'MemoryAlpha 喜欢喝咖啡', scene: 'manage-test' },
  })
  assert.equal(created.status, 200, created.text)
  const memoryId = created.json.memoryId
  assert.ok(memoryId)
  assert.equal(created.json.identity, 'user')

  const listed = await call('/memory/memories?q=MemoryAlpha&scene=manage-test&limit=10')
  assert.equal(listed.status, 200)
  assert.equal(listed.json.total, 1)
  const row = listed.json.memories[0]
  assert.equal(row.id, memoryId)
  assert.equal(row.scene, 'manage-test')
  assert.equal(row.identity, 'user')
  assert.ok(Array.isArray(row.entityIds))
  assert.equal(typeof row.createdAt, 'number')

  const detail = await call(`/memory/memories/${memoryId}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.json.memory.id, memoryId)
  assert.ok(Array.isArray(detail.json.entities))

  const embedCountBefore = embedCalls.length
  const updated = await call(`/memory/memories/${memoryId}`, {
    method: 'PATCH', body: { text: 'MemoryAlpha 现在改喝茶了' },
  })
  assert.equal(updated.status, 200, updated.text)
  assert.equal(updated.json.memory.text, 'MemoryAlpha 现在改喝茶了')
  assert.ok(embedCalls.length > embedCountBefore, 'PATCH text 必须重嵌入')
  assert.ok(embedCalls.includes('MemoryAlpha 现在改喝茶了'))

  const emptyText = await call(`/memory/memories/${memoryId}`, {
    method: 'PATCH', body: { text: '   ' },
  })
  assert.equal(emptyText.status, 400)

  // reextract 异步返回，后台真的调用 graph.ingest
  const reextract = await call(`/memory/memories/${memoryId}/reextract`, { method: 'POST' })
  assert.equal(reextract.status, 200)
  assert.equal(reextract.json.async, true)
  for (let i = 0; i < 100; i++) {
    if (ingestCalls.some((entry) => entry.text === 'MemoryAlpha 现在改喝茶了')) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(ingestCalls.some((entry) => entry.text === 'MemoryAlpha 现在改喝茶了'),
    'reextract 应在后台调用 graph.ingest')

  const deleted = await call(`/memory/memories/${memoryId}`, { method: 'DELETE' })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.json.deleted, true)

  const gone = await call(`/memory/memories/${memoryId}`)
  assert.equal(gone.status, 404)

  const trash = await call('/memory/trash?limit=50')
  const memoryTrash = trash.json.items.find((entry) => entry.kind === 'memory' && entry.row.id === memoryId)
  assert.ok(memoryTrash, '删除的记忆必须进回收站')
  assert.ok(Array.isArray(memoryTrash.row.vector) && memoryTrash.row.vector.length === 4,
    '回收站记忆行必须保留向量（恢复需要）')
})

// ---------------------------------------------------------------- §9 删除语义

test('删实体：级联删关系 + 从 memories.entityIds 摘引用 + 全部进回收站', async () => {
  const doomed = await createEntity('CascadeDoomed', 'person')
  const other = await createEntity('CascadeOther', 'thing')
  const third = await createEntity('CascadeThird', 'thing')
  await createRelation(doomed.id, other.id, 'cascade-rel-1')
  await createRelation(third.id, doomed.id, 'cascade-rel-2')

  const memoryId = await store.addMemory({
    text: '级联测试记忆',
    vector: vectorOf('级联测试记忆'),
    scene: 'test',
    entityIds: [doomed.id, other.id],
  })

  const deleted = await call(`/memory/entities/${doomed.id}`, { method: 'DELETE' })
  assert.equal(deleted.status, 200, deleted.text)
  assert.equal(deleted.json.deleted, true)
  assert.equal(deleted.json.relationsDeleted, 2)
  assert.equal(deleted.json.memoriesUpdated, 1)

  assert.equal((await call(`/memory/entities/${doomed.id}`)).status, 404)

  // 记忆正文保留，entityIds 摘掉被删实体
  const memoryDetail = await call(`/memory/memories/${memoryId}`)
  assert.equal(memoryDetail.status, 200)
  assert.deepEqual(memoryDetail.json.memory.entityIds, [other.id])

  // 回收站：最新在前 → 实体 + 两条关系
  const trash = await call('/memory/trash?limit=50')
  const entityEntry = trash.json.items.find(
    (entry) => entry.kind === 'entity' && entry.row.id === doomed.id,
  )
  assert.ok(entityEntry, '被删实体必须进回收站')
  assert.ok(Array.isArray(entityEntry.row.vector) && entityEntry.row.vector.length === 4)
  const relationEntries = trash.json.items.filter((entry) => entry.kind === 'relation')
  assert.ok(relationEntries.length >= 2, '级联删除的关系必须进回收站')
  const newest = trash.json.items[0]
  assert.equal(newest.kind, 'entity', '回收站倒序：实体在最后写入，应排最前')
})

test('合并实体：关系迁移 + 重复去重 + 记忆引用替换 + 被合并方进回收站', async () => {
  const keep = await createEntity('MergeKeep', 'person')
  const merge = await createEntity('MergeDoomed', 'person')
  const other = await createEntity('MergeOther', 'thing')

  await createRelation(keep.id, other.id, 'merge-dup')
  await createRelation(merge.id, other.id, 'merge-dup')   // 迁移后与上面重复 → 去重
  await createRelation(other.id, merge.id, 'merge-only')  // 迁移后保留

  const memoryA = await store.addMemory({
    text: '合并记忆 A', vector: vectorOf('合并记忆 A'), scene: 'test', entityIds: [merge.id],
  })
  const memoryB = await store.addMemory({
    text: '合并记忆 B', vector: vectorOf('合并记忆 B'), scene: 'test',
    entityIds: [keep.id, merge.id],
  })

  const merged = await call('/memory/entities/merge', {
    method: 'POST', body: { keepId: keep.id, mergeId: merge.id },
  })
  assert.equal(merged.status, 200, merged.text)
  assert.equal(merged.json.keep.id, keep.id)
  assert.equal(merged.json.merged.id, merge.id)
  assert.equal(merged.json.relationsMoved, 1, '仅 merge-only 需要迁移')
  assert.equal(merged.json.memoriesUpdated, 2)

  assert.equal((await call(`/memory/entities/${merge.id}`)).status, 404)
  assert.equal((await call(`/memory/entities/${keep.id}`)).status, 200)

  // 重复关系只剩一条；merge-only 迁到 keep
  const duplicates = await call('/memory/relations?q=merge-dup&includeEnded=true&limit=50')
  assert.equal(duplicates.json.total, 1, `重复关系应去重，实际 ${duplicates.json.total}`)
  const unique = await call('/memory/relations?q=merge-only&includeEnded=true&limit=50')
  assert.equal(unique.json.total, 1)
  assert.equal(unique.json.relations[0].sourceId, other.id)
  assert.equal(unique.json.relations[0].targetId, keep.id)

  const detailA = await call(`/memory/memories/${memoryA}`)
  assert.deepEqual(detailA.json.memory.entityIds, [keep.id])
  const detailB = await call(`/memory/memories/${memoryB}`)
  assert.deepEqual(detailB.json.memory.entityIds, [keep.id])

  const trash = await call('/memory/trash?limit=50')
  assert.ok(trash.json.items.some(
    (entry) => entry.kind === 'entity' && entry.row.id === merge.id,
  ), '被合并实体必须进回收站')

  // 校验：相同 id / 缺失实体
  const same = await call('/memory/entities/merge', {
    method: 'POST', body: { keepId: keep.id, mergeId: keep.id },
  })
  assert.equal(same.status, 400)
  const absent = await call('/memory/entities/merge', {
    method: 'POST', body: { keepId: keep.id, mergeId: 'nope' },
  })
  assert.equal(absent.status, 400)
})

// ---------------------------------------------------------------- §5 统计/回收站/审计

test('统计：memories/entities/relations/activeRelations/trash 均为 number', async () => {
  const stats = await call('/memory/stats')
  assert.equal(stats.status, 200)
  assert.equal(stats.json.ok, true)
  for (const key of ['memories', 'entities', 'relations', 'activeRelations', 'trash']) {
    assert.equal(typeof stats.json[key], 'number', `${key} 必须是 Number（不能是 BigInt）`)
    assert.ok(stats.json[key] >= 0)
  }
  assert.ok(stats.json.activeRelations <= stats.json.relations)
  assert.ok(stats.json.trash > 0, '测试已产生回收站条目')
})

test('回收站：倒序列表 + 恢复（从 JSONL 移除）+ 409 id 冲突 + 未知 404', async () => {
  const listed = await call('/memory/trash?limit=5')
  assert.equal(listed.status, 200)
  assert.ok(listed.json.items.length <= 5)
  assert.equal(typeof listed.json.total, 'number')
  for (const entry of listed.json.items) {
    assert.ok(entry.trashId)
    assert.ok(['entity', 'relation', 'memory'].includes(entry.kind))
    assert.equal(typeof entry.deletedAt, 'number')
    assert.ok(entry.row && typeof entry.row === 'object')
  }

  // 恢复被删实体
  const restoreMe = await createEntity('RestoreMe', 'concept', '待恢复')
  const deleted = await call(`/memory/entities/${restoreMe.id}`, { method: 'DELETE' })
  assert.equal(deleted.status, 200)
  const trashAfterDelete = await call('/memory/trash?limit=50')
  const entry = trashAfterDelete.json.items.find(
    (item) => item.kind === 'entity' && item.row.id === restoreMe.id,
  )
  assert.ok(entry)

  const restored = await call(`/memory/trash/${entry.trashId}/restore`, { method: 'POST' })
  assert.equal(restored.status, 200, restored.text)
  assert.equal(restored.json.kind, 'entity')
  assert.equal(restored.json.id, restoreMe.id)

  const afterRestore = await call(`/memory/entities/${restoreMe.id}`)
  assert.equal(afterRestore.status, 200)
  assert.equal(afterRestore.json.entity.name, 'RestoreMe')

  const trashAfterRestore = await call('/memory/trash?limit=50')
  assert.equal(trashAfterRestore.json.items.some((item) => item.trashId === entry.trashId), false,
    '恢复后该行必须从回收站移除')

  // 409：同 id 已存在时恢复必须冲突且不悄悄覆盖
  const conflictMe = await createEntity('RestoreConflict', 'concept')
  await call(`/memory/entities/${conflictMe.id}`, { method: 'DELETE' })
  const conflictTrash = await call('/memory/trash?limit=50')
  const conflictEntry = conflictTrash.json.items.find(
    (item) => item.kind === 'entity' && item.row.id === conflictMe.id,
  )
  assert.ok(conflictEntry)
  // 直接在库里重建同 id 行，模拟 id 冲突
  await store.insertEntityRaw({
    id: conflictMe.id, name: 'RestoreConflict', type: 'concept',
    summary: '占用 id', vector: vectorOf('占用 id'), createdAt: Date.now(),
  })
  const conflict = await call(`/memory/trash/${conflictEntry.trashId}/restore`, { method: 'POST' })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.json.code, 'restore-conflict')
  await store.deleteEntityRow(conflictMe.id)

  const unknown = await call('/memory/trash/not-a-trash-id/restore', { method: 'POST' })
  assert.equal(unknown.status, 404)
})

test('审计：只追加、倒序、不含向量', async () => {
  const audit = await call('/memory/audit?limit=100')
  assert.equal(audit.status, 200)
  assert.equal(audit.json.ok, true)
  assert.ok(audit.json.total > 0)
  assert.ok(audit.json.items.length <= 100)
  for (const item of audit.json.items) {
    assert.equal(typeof item.at, 'number')
    assert.equal(typeof item.op, 'string')
    assert.equal(typeof item.kind, 'string')
    assert.equal(typeof item.id, 'string')
    assert.ok(!('row' in item), '审计不含行数据')
    assert.ok(!JSON.stringify(item).includes('vector'), '审计绝不含向量')
  }
  const ops = audit.json.items.map((item) => item.op)
  for (const expected of ['entity.create', 'entity.delete', 'entity.merge', 'relation.create', 'memory.update']) {
    assert.ok(ops.includes(expected), `审计应记录 ${expected}，实际 ${ops.slice(0, 12).join(',')}`)
  }
  assert.ok(ops.includes('trash.restore'))
  // 倒序：at 递减
  for (let i = 1; i < audit.json.items.length; i++) {
    assert.ok(audit.json.items[i - 1].at >= audit.json.items[i].at, '审计应按时间倒序')
  }
})

// ---------------------------------------------------------------- §6 配置

test('配置：GET 脱敏（绝不回显 key）+ PUT 写文件/保留未知字段/restartRequired', async () => {
  const secretsPath = join(dataDir, 'secrets.json')
  const got = await call('/config')
  assert.equal(got.status, 200)
  assert.equal(got.json.ok, true)
  assert.equal(got.json.hasApiKey, true)
  assert.equal(got.json.config.dataDir, dataDir)
  assert.equal(got.json.config.memoryServicePort, API_PORT)
  assert.equal('apiKey' in got.json.config, false, '配置响应不得包含 apiKey')
  assert.equal(got.text.includes(API_KEY_MARKER), false, '响应文本不得泄露 key')
  assert.equal(typeof got.json.config.apiBaseUrl, 'string', 'apiBaseUrl 必须回显')

  const put = await call('/config', {
    method: 'PUT',
    body: {
      llmModel: 'updated-llm',
      apiKey: API_KEY_MARKER,        // 写入 secrets.json（绝不进 config.json）
      unknownField: 'ignored',       // 白名单外字段不落盘
    },
  })
  assert.equal(put.status, 200, put.text)
  assert.equal(put.json.restartRequired, true, 'llmModel 变更需重启')
  assert.equal(put.text.includes(API_KEY_MARKER), false, 'PUT 响应不得泄露 key')
  assert.deepEqual(put.json.api.fields, ['apiKey'])
  assert.equal(put.json.api.persisted, true)

  const saved = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(saved.llmModel, 'updated-llm')
  assert.equal(saved.customUnknown, 'keep-me', '配置文件的未知字段必须保留')
  assert.equal('apiKey' in saved, false, 'apiKey 绝不能写进配置文件')
  assert.equal(JSON.stringify(saved).includes(API_KEY_MARKER), false)
  assert.equal('unknownField' in saved, false)

  // 密钥真正落到 dataDir/secrets.json
  const secretsRaw = await readFile(secretsPath, 'utf8')
  assert.equal(JSON.parse(secretsRaw).apiKey, API_KEY_MARKER)
  assert.equal(secretsRaw.includes(API_KEY_MARKER), true)

  const gotAfter = await call('/config')
  assert.equal(gotAfter.json.config.llmModel, 'updated-llm')
  assert.equal(gotAfter.json.apiKeySource, 'secrets')
  assert.equal(gotAfter.text.includes(API_KEY_MARKER), false, 'GET 仍不得回显 key')

  // apiBaseUrl：写入 → 回读一致（尾部斜杠归一化）；API 字段即时生效不需重启
  const putBase = await call('/config', {
    method: 'PUT', body: { apiBaseUrl: 'https://example.invalid/v1/' },
  })
  assert.equal(putBase.status, 200, putBase.text)
  assert.equal(putBase.json.restartRequired, false, 'API 字段即时生效，不需要重启')
  assert.deepEqual(putBase.json.api.fields, ['apiBaseUrl'])
  assert.equal((await call('/config')).json.config.apiBaseUrl, 'https://example.invalid/v1')

  // 非法 apiBaseUrl 必须 400（且不覆盖已有值）
  assert.equal((await call('/config', {
    method: 'PUT', body: { apiBaseUrl: 'ftp://example.invalid/v1' },
  })).status, 400)
  assert.equal((await call('/config')).json.config.apiBaseUrl, 'https://example.invalid/v1')

  // 清空 apiBaseUrl：清除覆盖，回落（本测试 configView 未配置 → ''）
  const clearBase = await call('/config', { method: 'PUT', body: { apiBaseUrl: '' } })
  assert.equal(clearBase.status, 200)
  assert.equal(clearBase.json.api.cleared, false, 'secrets.json 还有 apiKey，文件不删')
  assert.equal((await call('/config')).json.config.apiBaseUrl, '')

  // 清空 apiKey：secrets.json 里的键消失（两键都空时文件本身被移除），GET 回退到启动快照
  assert.equal((await call('/config', { method: 'PUT', body: { apiKey: '' } })).status, 200)
  let secretsAfterClear = null
  try {
    secretsAfterClear = JSON.parse(await readFile(secretsPath, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  assert.equal(secretsAfterClear === null || !('apiKey' in secretsAfterClear), true)
  assert.equal((await call('/config')).json.apiKeySource, 'external')

  // 端口/身份变更重启生效
  const samePort = await call('/config', { method: 'PUT', body: { memoryServicePort: API_PORT } })
  assert.equal(samePort.status, 200)
  assert.equal(samePort.json.restartRequired, false)

  const sameDataDir = await call('/config', { method: 'PUT', body: { dataDir } })
  assert.equal(sameDataDir.json.restartRequired, false, '值未变化时不算重启')

  const dataDirChanged = await call('/config', {
    method: 'PUT', body: { dataDir: join(root, 'data-other') },
  })
  assert.equal(dataDirChanged.status, 200)
  assert.equal(dataDirChanged.json.restartRequired, true, 'dataDir 变更必须提示重启')

  // 改回来，避免影响后续重启持久化测试
  const dataDirBack = await call('/config', { method: 'PUT', body: { dataDir } })
  assert.equal(dataDirBack.json.restartRequired, true)

  await call('/config', { method: 'PUT', body: { memoriesIdentity: 'user' } })
  const identityChanged = await call('/config', {
    method: 'PUT', body: { memoriesIdentity: 'qq:other' },
  })
  assert.equal(identityChanged.json.restartRequired, true)
  await call('/config', { method: 'PUT', body: { memoriesIdentity: 'user' } })

  // 非法/无字段
  assert.equal((await call('/config', { method: 'PUT', body: {} })).status, 400)
  assert.equal((await call('/config', {
    method: 'PUT', body: { apiKey: 123 },
  })).status, 400)
  assert.equal((await call('/config', {
    method: 'PUT', body: { memoryServicePort: 70000 },
  })).status, 400)
})

test('插件模式兼容：deps 未传 dataDir 时回退 store.dataDir，管理写/回收站仍可用', async () => {
  // DSH 插件入口 plugin-entry.mjs 调用 createMemoryService 时只传 store/model/graph，
  // 因此 service 必须能从 store 上拿到 dataDir，否则回收站/审计会让所有管理写 500。
  assert.equal(store.dataDir, dataDir)
  const pluginMode = createMemoryService(
    {
      store,
      model: fakeModel,
      graph: fakeGraph,
      profilePath: '',
      logger: { warn() {}, info() {} },
    },
    {
      memoryServiceHost: '127.0.0.1',
      memoryServicePort: 0,
      memoriesIdentity: 'user',
    },
  )
  const pluginBase = await pluginMode.start()
  try {
    assert.ok(pluginBase)
    const created = await call('/memory/entities', {
      method: 'POST', body: { name: 'PluginModeEntity', type: 'concept' }, target: pluginBase,
    })
    assert.equal(created.status, 200, created.text)
    const deleted = await call(`/memory/entities/${created.json.entity.id}`, {
      method: 'DELETE', target: pluginBase,
    })
    assert.equal(deleted.status, 200, deleted.text)
    const trash = await call('/memory/trash?limit=10', { target: pluginBase })
    assert.ok(trash.json.items.some(
      (entry) => entry.kind === 'entity' && entry.row.id === created.json.entity.id,
    ), '插件模式下删除实体也必须能写回收站')
  } finally {
    await pluginMode.stop()
  }
})

test('重启后回收站/审计仍在（文件持久化）', async () => {
  const trashBefore = await call('/memory/trash?limit=1')
  const auditBefore = await call('/memory/audit?limit=1')
  assert.ok(trashBefore.json.total > 0)
  assert.ok(auditBefore.json.total > 0)

  await svc.stop()

  // 重启实例换端口：避免 undici 复用已关闭旧 server 的 keep-alive 连接（ECONNRESET），
  // 与「文件持久化」这个断言目标无关。
  const restarted = createMemoryService(
    {
      store,
      model: fakeModel,
      graph: fakeGraph,
      profilePath: '',
      logger: { warn() {}, info() {} },
      dataDir,
      configPath,
      configView,
      apiKeyPresent: true,
    },
    {
      memoryServiceHost: '127.0.0.1',
      memoryServicePort: API_PORT + 1,
      memoriesIdentity: 'user',
    },
  )
  const restartedBase = await restarted.start()
  assert.ok(restartedBase)
  try {
    const trash = await call('/memory/trash?limit=1', { target: restartedBase })
    const audit = await call('/memory/audit?limit=1', { target: restartedBase })
    assert.equal(trash.json.total, trashBefore.json.total, '重启后回收站条目数不变')
    assert.equal(audit.json.total, auditBefore.json.total, '重启后审计条目数不变')
    assert.equal(trash.json.items[0].trashId, trashBefore.json.items[0].trashId)
  } finally {
    await restarted.stop()
  }

  // after 钩子会再 stop 一次（幂等），这里把 svc 指回已停止的实例无副作用。
  svc = restarted
})
