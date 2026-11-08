// dsh-tingxue src/memory/store.mjs
// LanceDB 记忆存储：本地文件即库，零服务器。
// 四张表：
//   memories  —— 记忆条目（向量检索主表）：text + embedding + metadata(场景/身份/时间/来源)
//   entities  —— 实体节点：name + type + summary + embedding
//   relations —— 关系边（三元组）：source → target + relation + 时间窗口
//   latest    —— 最新信息（最近文件摘要/待办，有界）
//
// 同库单一向量模型、维度一致（铁律）。换模型需全量重嵌入。
// 基于 @lancedb/lancedb 0.37 API：query().nearestTo().where().limit().toArray()

import * as lancedb from '@lancedb/lancedb'
import { Field, FixedSizeList, Float32, Utf8, Int64, Schema } from 'apache-arrow'
import { randomUUID } from 'node:crypto'

/**
 * 创建 LanceDB 记忆存储。
 * @param {object} config - { dataDir, dimensions, embeddingModel }
 * @param {object} deps - { logger }
 */
export async function createMemoryStore(config, deps = {}) {
  const logger = deps.logger
  const warn = (m) => { try { logger?.warn?.('[dsh-tingxue/memory]', m) } catch {} }
  const dataDir = config.dataDir
  const dimensions = config.dimensions

  if (!dataDir) throw new Error('dsh-tingxue: dataDir 未配置')
  if (!dimensions) throw new Error('dsh-tingxue: dimensions 未配置（需先确定向量模型维度）')

  const db = await lancedb.connect(dataDir)

  /** 建表（不存在则建）。 */
  async function ensureTable(name, fields) {
    try {
      const exists = await db.tableNames()
      if (exists.includes(name)) return await db.openTable(name)
    } catch { /* 首次建表 */ }
    return await db.createEmptyTable(name, new Schema(fields))
  }

  const vecField = (name, nullable = true) =>
    new Field(name, new FixedSizeList(dimensions, new Field('item', new Float32())), nullable)

  // ---- 表结构 ----
  const memories = await ensureTable('memories', [
    new Field('id', new Utf8(), false),
    new Field('text', new Utf8(), true),
    vecField('vector', false),
    new Field('scene', new Utf8(), true),
    new Field('identity', new Utf8(), true),
    new Field('source', new Utf8(), true),
    new Field('createdAt', new Int64(), true),
    new Field('entityIds', new Utf8(), true), // 逗号分隔的实体 id 列表（避免 list 类型序列化问题）
  ])

  const entities = await ensureTable('entities', [
    new Field('id', new Utf8(), false),
    new Field('name', new Utf8(), true),
    new Field('type', new Utf8(), true),
    new Field('summary', new Utf8(), true),
    vecField('vector', true),
    new Field('createdAt', new Int64(), true),
  ])

  const relations = await ensureTable('relations', [
    new Field('id', new Utf8(), false),
    new Field('sourceId', new Utf8(), true),
    new Field('targetId', new Utf8(), true),
    new Field('relation', new Utf8(), true),
    new Field('validFrom', new Int64(), true),
    new Field('validTo', new Int64(), true),
    new Field('source', new Utf8(), true),
  ])

  const latest = await ensureTable('latest', [
    new Field('id', new Utf8(), false),
    new Field('kind', new Utf8(), true),
    new Field('text', new Utf8(), true),
    new Field('createdAt', new Int64(), true),
  ])

  // ---- 行规整（BigInt → Number）----
  //
  // LanceDB 的 INT64 列读出来是 **BigInt**，而 `JSON.stringify(BigInt)` 抛
  // `TypeError: Do not know how to serialize a BigInt`。任何裸返回原始行的函数
  // 一旦被放进 HTTP 响应，就会让 `sendJson` 在已 `writeHead(200)` 之后失败、
  // `res.end()` 永不执行 → 客户端永久挂住（实测 /memory/expand 180s 不返回）。
  // 因此所有对外返回的实体/关系/最新信息都必须过这里。
  const normalizeEntity = (row) => row === undefined || row === null ? null : ({
    id: row.id, name: row.name, type: row.type, summary: row.summary,
    createdAt: Number(row.createdAt ?? 0),
  })

  // ---- 记忆条目 ----
  async function addMemory({ text, vector, scene = 'chat', identity = 'user', source = 'chat', entityIds = [] }) {
    const id = randomUUID()
    await memories.add([{
      id, text, vector,
      scene, identity, source,
      createdAt: Date.now(),
      entityIds: (entityIds ?? []).join(','),
    }])
    return id
  }

  /**
   * 语义检索记忆（按当前输入）。
   *
   * **必须按 identity 过滤**（t13 修复）：写入时就分了人（addMemory 的 identity），
   * 读出时若不过滤，一旦有第二个来源接入，任何一次检索都会返回**混合记忆**。
   * 实测（LanceDB 真实库）：owner 的 `user` 记忆与另一来源的 `qq:999` 记忆会被一起返回。
   *
   * 默认值取 `'user'`——与 addMemory 的默认 identity 一致，因此**单用户场景行为不变**：
   * 既有的无 identity 写入的库仍能被搜到；扫描旧库时不需要数据迁移。
   * 需要检索别的来源时显式传 identity（例如按 QQ 号分人）。
   *
   * @param {number[]} vector
   * @param {{limit?: number, scene?: string, identity?: string|null}} [opts]
   *   identity 传 `null` 表示不过滤（仅用于诊断/管理场景，勿用于面向用户的检索）。
   */
  async function searchMemories(vector, { limit = 8, scene, identity = 'user' } = {}) {
    let q = memories.query().nearestTo(vector)
    // identity 过滤先于 limit（实测：where().limit() 是先过滤再取前 N 条）
    if (identity !== null && identity !== undefined && String(identity) !== '') {
      q = q.where(`identity = '${sqlStr(identity)}'`)
    }
    if (scene) q = q.where(`scene = '${sqlStr(scene)}'`)
    const rows = await q.limit(limit).toArray()
    return rows.map((r) => ({
      id: r.id, text: r.text, scene: r.scene, identity: r.identity,
      source: r.source, createdAt: Number(r.createdAt ?? 0),
      entityIds: String(r.entityIds ?? '').split(',').filter(Boolean),
      distance: r._distance,
    }))
  }

  /** SQL 字面量转义：identity/scene 会进 where 子句，单引号必须转义（否则可被注入）。 */
  function sqlStr(value) {
    return String(value).replace(/'/g, "''")
  }

  /** 按精确 ID 删除记忆（用户主动删除）。 */
  async function deleteMemory(id) {
    await memories.delete(`id = '${id}'`)
  }

  // ---- 实体 ----
  async function upsertEntity({ id, name, type, summary, vector }) {
    const existing = await entities.query().where(`id = '${id}'`).toArray()
    if (existing.length > 0) {
      await entities.update({
        where: `id = '${id}'`,
        values: { name, type, summary, vector, createdAt: Date.now() },
      })
      return id
    }
    await entities.add([{ id, name, type, summary, vector, createdAt: Date.now() }])
    return id
  }

  /**
   * 按 id 取实体。
   * **必须规整 Int64 字段**：LanceDB 的 `createdAt` 读出来是 BigInt，
   * `JSON.stringify(BigInt)` 会抛 TypeError（详见 relationsOf 的注释）。
   */
  async function getEntity(id) {
    const rows = await entities.query().where(`id = '${id}'`).toArray()
    return normalizeEntity(rows[0])
  }

  /** 按名称精确查实体（实体链接用）。 */
  async function findEntityByName(name) {
    const rows = await entities.query().where(`name = '${name}'`).toArray()
    return normalizeEntity(rows[0])
  }

  /**
   * 语义检索实体（实体链接候选）。
   * distance 是 LanceDB 的 `_distance`（f32，本来就不是 Int64），但显式转 Number
   * 与其它函数保持一致：任何裸透传的字段将来都可能变成 BigInt 类隐患。
   */
  async function searchEntities(vector, { limit = 5 } = {}) {
    const rows = await entities.query().nearestTo(vector).limit(limit).toArray()
    return rows.map((r) => ({
      id: r.id, name: r.name, type: r.type, summary: r.summary,
      distance: Number(r._distance ?? 0),
    }))
  }

  /** 列出全部实体（图谱 UI 用）。 */
  async function listAllEntities({ limit = 500 } = {}) {
    const rows = await entities.query().limit(limit).toArray()
    return rows.map((r) => ({
      id: r.id, name: r.name, type: r.type, summary: r.summary,
      createdAt: Number(r.createdAt ?? 0),
    }))
  }

  /** 列出全部关系（图谱 UI 用）。 */
  async function listAllRelations({ limit = 2000 } = {}) {
    const rows = await relations.query().limit(limit).toArray()
    return rows.map((r) => ({
      id: r.id, sourceId: r.sourceId, targetId: r.targetId,
      relation: r.relation, validFrom: Number(r.validFrom ?? 0),
      validTo: Number(r.validTo ?? 0), source: r.source,
    }))
  }

  // ---- 关系 ----
  async function addRelation({ sourceId, targetId, relation, source = 'chat' }) {
    const id = randomUUID()
    await relations.add([{
      id, sourceId, targetId, relation,
      validFrom: Date.now(), validTo: 0, source,
    }])
    return id
  }

  /**
   * 查询某实体的所有关系（图遍历）。
   *
   * **必须把 BigInt 转成 Number**：LanceDB 的 INT64 列读出来是 BigInt，
   * 而 `JSON.stringify(BigInt)` 会抛 `TypeError: Do not know how to serialize a BigInt`。
   * 调用链 `/memory/expand` → `sendJson` 一旦遇到它就会「已 writeHead 200、res.end 从未执行」，
   * 在 `sendJson` 的 catch 里被静默吞掉，客户端**永久挂住**（实测 180s 不返回）。
   * `listAllRelations` 一直有 `Number()` 转换，本函数漏了——这是两条路径唯一的差别。
   */
  async function relationsOf(entityId) {
    const rows = await relations.query()
      .where(`(sourceId = '${entityId}' OR targetId = '${entityId}') AND validTo = 0`)
      .toArray()
    return rows.map((r) => ({
      id: r.id, sourceId: r.sourceId, targetId: r.targetId,
      relation: r.relation, validFrom: Number(r.validFrom ?? 0),
      validTo: Number(r.validTo ?? 0), source: r.source,
    }))
  }

  // ---- 最新信息 ----
  async function addLatest({ kind, text }) {
    const id = randomUUID()
    await latest.add([{ id, kind, text, createdAt: Date.now() }])
    return id
  }

  /** 取最新信息（有界，按时间倒序）。 */
  async function listLatest({ limit = 5 } = {}) {
    const rows = await latest.query().toArray()
    // createdAt 是 Int64 → BigInt，必须转 Number 才能 JSON 序列化。
    return rows
      .map((r) => ({ id: r.id, kind: r.kind, text: r.text, createdAt: Number(r.createdAt ?? 0) }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  }

  // ==================================================================
  // 管理 API 扩展（service/API.md §2-§5）
  //
  // 设计约束：
  //  - **只增不改**：上面已有函数与导出保持原签名/行为，现有调用方零改动。
  //  - 所有对外返回的行都必须过 Number()（Int64 → BigInt 不能进 JSON）。
  //  - 只有带 `WithVector` / `Raw` 的函数会返回 vector；供回收站/恢复用，
  //    对外 HTTP 响应绝不能直接透出（服务层负责剔除）。
  //  - 分页统一 `{ items, total }`，由服务层决定 limit/offset 上限。
  // ==================================================================

  /** FixedSizeList 读回来是 arrow Vector，恢复/回写时必须转成普通数组。 */
  const plainVector = (value) => (value == null ? [] : Array.from(value))

  /** 管理视图的实体行（不含向量）。 */
  const normalizeManagedEntity = (row) => ({
    id: row.id,
    name: row.name ?? '',
    type: row.type ?? 'concept',
    summary: row.summary ?? '',
    createdAt: Number(row.createdAt ?? 0),
  })

  /** 含向量的实体行（回收站/近邻计算用；不要直接进 HTTP 响应）。 */
  const normalizeEntityWithVector = (row) => ({
    ...normalizeManagedEntity(row),
    vector: plainVector(row.vector),
  })

  const normalizeManagedMemory = (row) => ({
    id: row.id,
    text: row.text ?? '',
    scene: row.scene ?? '',
    identity: row.identity ?? '',
    source: row.source ?? '',
    createdAt: Number(row.createdAt ?? 0),
    entityIds: String(row.entityIds ?? '').split(',').filter(Boolean),
  })

  const normalizeMemoryWithVector = (row) => ({
    ...normalizeManagedMemory(row),
    vector: plainVector(row.vector),
  })

  const normalizeManagedRelation = (row) => ({
    id: row.id,
    sourceId: row.sourceId ?? '',
    targetId: row.targetId ?? '',
    relation: row.relation ?? '',
    validFrom: Number(row.validFrom ?? 0),
    validTo: Number(row.validTo ?? 0),
    source: row.source ?? '',
  })

  /** 记忆的 entityIds 是逗号串；用 SQL 预筛后由调用方按数组精确校验。 */
  function memoryEntityMembershipFilter(entityId) {
    const eid = sqlStr(entityId)
    return `(entityIds = '${eid}' OR entityIds LIKE '${eid},%'`
      + ` OR entityIds LIKE '%,${eid}' OR entityIds LIKE '%,${eid},%')`
  }

  // ---- 实体（管理） ----

  /** 分页列出实体：q 对 name/summary 做大小写不敏感子串匹配，type 精确。 */
  async function listEntitiesPaged({ q = '', type = '', limit = 50, offset = 0 } = {}) {
    const conditions = []
    if (q) {
      const pattern = `%${sqlStr(String(q).toLowerCase())}%`
      conditions.push(`(lower(name) LIKE '${pattern}' OR lower(summary) LIKE '${pattern}')`)
    }
    if (type) conditions.push(`type = '${sqlStr(type)}'`)
    const filter = conditions.length > 0 ? conditions.join(' AND ') : undefined
    const total = await entities.countRows(filter)
    let query = entities.query()
    if (filter) query = query.where(filter)
    const rows = await query.limit(limit).offset(offset).toArray()
    return { items: rows.map(normalizeManagedEntity), total }
  }

  /** 同名（大小写不敏感）同类型查重：新建/改名冲突用。 */
  async function findEntityByNameAndType({ name, type }) {
    const wanted = String(name ?? '').trim().toLowerCase()
    if (!wanted) return null
    const rows = await entities.query()
      .where(`lower(name) = '${sqlStr(wanted)}'`)
      .toArray()
    const wantedType = String(type ?? 'concept')
    return rows
      .map(normalizeManagedEntity)
      .find((row) => (row.type || 'concept') === wantedType) ?? null
  }

  /** 按 id 取实体（含向量；仅回收站/近邻/恢复内部使用）。 */
  async function getEntityWithVector(id) {
    const rows = await entities.query().where(`id = '${sqlStr(id)}'`).toArray()
    return rows[0] ? normalizeEntityWithVector(rows[0]) : null
  }

  /** 直接插入实体行（恢复/新建用；vector 必须是 number[]）。 */
  async function insertEntityRaw({ id, name, type, summary, vector, createdAt }) {
    await entities.add([{
      id,
      name: name ?? '',
      type: type ?? 'concept',
      summary: summary ?? '',
      vector: plainVector(vector),
      createdAt: Number(createdAt ?? Date.now()),
    }])
  }

  /** 更新实体字段（只写传入的字段；vector 需调用方已算好）。 */
  async function updateEntityFields(id, values = {}) {
    const patch = {}
    for (const key of ['name', 'type', 'summary']) {
      if (values[key] !== undefined) patch[key] = values[key]
    }
    if (values.vector !== undefined) patch.vector = plainVector(values.vector)
    if (Object.keys(patch).length === 0) return
    await entities.update({ where: `id = '${sqlStr(id)}'`, values: patch })
  }

  /** 删除实体，返回被删的原始行（含向量，供回收站）。 */
  async function deleteEntityRow(id) {
    const row = await getEntityWithVector(id)
    if (!row) return null
    await entities.delete(`id = '${sqlStr(id)}'`)
    return row
  }

  /** 按 id 批量取实体（关系列表的 sourceName/targetName 用）。 */
  async function getEntitiesByIds(ids = []) {
    const list = [...new Set((ids ?? []).filter(Boolean))].slice(0, 500)
    if (list.length === 0) return []
    const or = list.map((id) => `id = '${sqlStr(id)}'`).join(' OR ')
    const rows = await entities.query().where(or).toArray()
    return rows.map(normalizeManagedEntity)
  }

  // ---- 关系（管理） ----

  /** 某实体的全部关系（管理详情用，含已结束）。 */
  async function relationsOfEntity(entityId, { includeEnded = true } = {}) {
    let query = relations.query()
      .where(`(sourceId = '${sqlStr(entityId)}' OR targetId = '${sqlStr(entityId)}')`)
    if (!includeEnded) query = query.where('validTo = 0')
    const rows = await query.toArray()
    return rows.map(normalizeManagedRelation)
  }

  async function getRelationRow(id) {
    const rows = await relations.query().where(`id = '${sqlStr(id)}'`).toArray()
    return rows[0] ? normalizeManagedRelation(rows[0]) : null
  }

  /**
   * 分页列出关系，并附带 sourceName/targetName。
   * q 匹配关系词或两端实体名（大小写不敏感）；includeEnded=false 只留 validTo=0。
   *
   * 实体名连接量级与图谱同阶（数百~数千），在内存里做名字过滤比让 SQL
   * 做多表 join 更简单可靠；关系表本身无 vector，全量读出成本很低。
   */
  async function listRelationsPaged({ q = '', includeEnded = false, limit = 50, offset = 0 } = {}) {
    let query = relations.query()
    if (!includeEnded) query = query.where('validTo = 0')
    const rows = await query.limit(20000).toArray()
    const nameById = new Map(
      (await entities.query().select(['id', 'name']).limit(20000).toArray())
        .map((row) => [row.id, row.name ?? '']),
    )
    const mapped = rows.map((row) => ({
      ...normalizeManagedRelation(row),
      sourceName: nameById.get(row.sourceId) ?? '',
      targetName: nameById.get(row.targetId) ?? '',
    }))
    const needle = String(q ?? '').trim().toLowerCase()
    const filtered = needle
      ? mapped.filter((row) => [row.relation, row.sourceName, row.targetName]
        .some((value) => String(value ?? '').toLowerCase().includes(needle)))
      : mapped
    return { items: filtered.slice(offset, offset + limit), total: filtered.length }
  }

  /** 同三元组查重（合并关系去重用）。 */
  async function findRelationByTriple({ sourceId, targetId, relation, activeOnly = true }) {
    let query = relations.query().where(
      `sourceId = '${sqlStr(sourceId)}' AND targetId = '${sqlStr(targetId)}'`
      + ` AND relation = '${sqlStr(relation)}'`,
    )
    if (activeOnly) query = query.where('validTo = 0')
    const rows = await query.toArray()
    return rows[0] ? normalizeManagedRelation(rows[0]) : null
  }

  async function insertRelationRaw({ id, sourceId, targetId, relation, validFrom, validTo, source }) {
    await relations.add([{
      id,
      sourceId,
      targetId,
      relation,
      validFrom: Number(validFrom ?? Date.now()),
      validTo: Number(validTo ?? 0),
      source: source ?? 'manage',
    }])
  }

  async function updateRelationFields(id, values = {}) {
    const patch = {}
    for (const key of ['sourceId', 'targetId', 'relation', 'source']) {
      if (values[key] !== undefined) patch[key] = values[key]
    }
    if (values.validTo !== undefined) patch.validTo = Number(values.validTo)
    if (Object.keys(patch).length === 0) return
    await relations.update({ where: `id = '${sqlStr(id)}'`, values: patch })
  }

  /** 删除关系，返回被删行（供回收站）。 */
  async function deleteRelationRow(id) {
    const row = await getRelationRow(id)
    if (!row) return null
    await relations.delete(`id = '${sqlStr(id)}'`)
    return row
  }

  /** 删除某实体的全部关系（级联删实体用），返回被删行。 */
  async function deleteRelationsForEntity(entityId) {
    const matched = await relationsOfEntity(entityId, { includeEnded: true })
    if (matched.length > 0) {
      await relations.delete(
        `(sourceId = '${sqlStr(entityId)}' OR targetId = '${sqlStr(entityId)}')`,
      )
    }
    // matched 已由 relationsOfEntity 规整为 Number，可安全进入 JSON 响应/回收站。
    return matched
  }

  // ---- 记忆（管理） ----

  /** 分页列出记忆；identity 传 '*' 表示不按身份过滤（诊断用途）。 */
  async function listMemoriesPaged({ q = '', scene = '', identity, limit = 50, offset = 0 } = {}) {
    const conditions = []
    if (q) conditions.push(`lower(text) LIKE '%${sqlStr(String(q).toLowerCase())}%'`)
    if (scene) conditions.push(`scene = '${sqlStr(scene)}'`)
    if (identity && identity !== '*') conditions.push(`identity = '${sqlStr(identity)}'`)
    const filter = conditions.length > 0 ? conditions.join(' AND ') : undefined
    const total = await memories.countRows(filter)
    let query = memories.query()
    if (filter) query = query.where(filter)
    const rows = await query.limit(limit).offset(offset).toArray()
    return { items: rows.map(normalizeManagedMemory), total }
  }

  /** 按 id 取记忆（含向量；管理详情/PATCH 重嵌入/回收站用）。 */
  async function getMemoryWithVector(id) {
    const rows = await memories.query().where(`id = '${sqlStr(id)}'`).toArray()
    return rows[0] ? normalizeMemoryWithVector(rows[0]) : null
  }

  async function insertMemoryRaw({ id, text, vector, scene, identity, source, createdAt, entityIds }) {
    await memories.add([{
      id,
      text: text ?? '',
      vector: plainVector(vector),
      scene: scene ?? 'chat',
      identity: identity ?? 'user',
      source: source ?? 'manage',
      createdAt: Number(createdAt ?? Date.now()),
      entityIds: Array.isArray(entityIds) ? entityIds.join(',') : String(entityIds ?? ''),
    }])
  }

  async function updateMemoryFields(id, values = {}) {
    const patch = {}
    if (values.text !== undefined) patch.text = values.text
    if (values.scene !== undefined) patch.scene = values.scene
    if (values.source !== undefined) patch.source = values.source
    if (values.vector !== undefined) patch.vector = plainVector(values.vector)
    if (values.entityIds !== undefined) {
      patch.entityIds = Array.isArray(values.entityIds)
        ? values.entityIds.join(',')
        : String(values.entityIds)
    }
    if (Object.keys(patch).length === 0) return
    await memories.update({ where: `id = '${sqlStr(id)}'`, values: patch })
  }

  /** 删除记忆，返回被删行（含向量，供回收站）。 */
  async function deleteMemoryRow(id) {
    const row = await getMemoryWithVector(id)
    if (!row) return null
    await memories.delete(`id = '${sqlStr(id)}'`)
    return row
  }

  /** entityIds 含某实体的记忆（详情最多 50 条 / 级联更新用大 limit）。 */
  async function memoriesByEntityId(entityId, { limit = 50 } = {}) {
    const rows = await memories.query()
      .where(memoryEntityMembershipFilter(entityId))
      .limit(limit)
      .toArray()
    return rows
      .map(normalizeManagedMemory)
      .filter((row) => row.entityIds.includes(entityId))
  }

  async function countMemoriesByEntityId(entityId) {
    return memories.countRows(memoryEntityMembershipFilter(entityId))
  }

  /** 统计用：任意表行数（可选 SQL 过滤）。 */
  async function countTableRows(tableName, filter) {
    const tables = { memories, entities, relations, latest }
    const table = tables[tableName]
    if (!table) throw new Error(`未知数据表: ${tableName}`)
    return table.countRows(filter)
  }

  return {
    db,
    // 供上层（管理 API/回收站/审计）定位数据目录；只读元信息，不改变任何行为。
    dataDir,
    dimensions,
    addMemory, searchMemories, deleteMemory,
    upsertEntity, getEntity, findEntityByName, searchEntities, listAllEntities,
    addRelation, relationsOf, listAllRelations,
    addLatest, listLatest,
    // 管理 API 扩展（只增不改）
    listEntitiesPaged, findEntityByNameAndType, getEntityWithVector,
    insertEntityRaw, updateEntityFields, deleteEntityRow, getEntitiesByIds,
    relationsOfEntity, getRelationRow, listRelationsPaged, findRelationByTriple,
    insertRelationRaw, updateRelationFields, deleteRelationRow, deleteRelationsForEntity,
    listMemoriesPaged, getMemoryWithVector, insertMemoryRaw, updateMemoryFields,
    deleteMemoryRow, memoriesByEntityId, countMemoriesByEntityId, countTableRows,
    async close() { await db.close() },
  }
}
