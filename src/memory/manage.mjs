// dsh-tingxue src/memory/manage.mjs
// 管理 API 的业务层（service/API.md §2-§5）：实体/关系/记忆 CRUD、合并、
// 统计、回收站（<dataDir>/manage-trash.jsonl）与审计（manage-audit.jsonl）。
//
// 分层约定：
//  - 本模块只管业务与文件持久化，不碰 node:http；路由与响应格式在
//    src/memory-service/index.mjs。
//  - 所有写操作都通过注入的 enqueueWrite 串行执行（LanceDB 单写者）。
//  - 抛出 ManageError 表达 4xx（status/code），其余异常由路由当成 500。
//  - 审计/回收站写入失败不阻断主操作，但要记日志（可观测）。
//
// 回收站/审计文件格式见 API.md §8。20 MB 滚动（.1）v1 未实现（TODO）。

import { randomUUID } from 'node:crypto'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 管理 API 的可预期错误：带 HTTP 状态码与可选 code/额外字段。 */
export class ManageError extends Error {
  constructor(status, message, { code, payload } = {}) {
    super(message)
    this.name = 'ManageError'
    this.status = status
    if (code) this.code = code
    this.payload = payload ?? {}
  }
}

const badRequest = (message, code) => new ManageError(400, message, { code })
const notFound = (message, code) => new ManageError(404, message, { code })

// ---- 回收站 / 审计文件（JSONL） ----

/**
 * 创建回收站 + 审计文件读写器。
 *
 * 回收站写入为 append（O(1)），恢复时整文件重写（条目量小）。
 * 所有 JSON 行里的时间戳都已是 Number（store 已规整 BigInt），
 * 否则 JSON.stringify 会抛 TypeError。
 */
export function createManageFiles({ dataDir, logger } = {}) {
  const warn = (m) => { try { logger?.warn?.('[dsh-tingxue/manage]', m) } catch {} }
  // dataDir 缺失时不在构造期抛错（现有 memory-service 单测不配置 dataDir 也要能启动）；
  // 真正落到回收站/审计读写时才明确报错。
  const requireDataDir = () => {
    if (!dataDir) throw new Error('管理功能未配置 dataDir（回收站/审计不可用）')
    return dataDir
  }
  const trashPath = dataDir ? join(dataDir, 'manage-trash.jsonl') : ''
  const auditPath = dataDir ? join(dataDir, 'manage-audit.jsonl') : ''

  async function readLines(path) {
    requireDataDir()
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const rows = []
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch (error) {
        warn(`跳过损坏的 JSONL 行（${path}）: ${error.message}`)
      }
    }
    return rows
  }

  async function appendTrash(kind, row) {
    requireDataDir()
    const entry = { trashId: randomUUID(), kind, deletedAt: Date.now(), row }
    try {
      await appendFile(trashPath, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (error) {
      warn(`写回收站失败: ${error.message}`)
      throw error
    }
    return entry
  }

  /** 倒序（最新删除在前）读回收站。 */
  async function listTrash({ limit = 50 } = {}) {
    const entries = await readLines(trashPath)
    return { items: entries.slice().reverse().slice(0, limit), total: entries.length }
  }

  async function countTrash() {
    return (await readLines(trashPath)).length
  }

  async function getTrash(trashId) {
    return (await readLines(trashPath)).find((entry) => entry.trashId === trashId) ?? null
  }

  /** 从回收站移除一条（整文件重写）。返回被移除的条目或 null。 */
  async function removeTrash(trashId) {
    const entries = await readLines(trashPath)
    const index = entries.findIndex((entry) => entry.trashId === trashId)
    if (index < 0) return null
    const [removed] = entries.splice(index, 1)
    try {
      await writeFile(trashPath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8')
    } catch (error) {
      warn(`重写回收站失败: ${error.message}`)
      throw error
    }
    return removed
  }

  async function appendAudit({ op, kind, id, detail }) {
    requireDataDir()
    const entry = { at: Date.now(), op, kind, id, detail: detail ?? '' }
    try {
      await appendFile(auditPath, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (error) {
      // 审计失败不能反过来让管理操作失败，但必须留下痕迹。
      warn(`写审计失败: ${error.message}`)
      return null
    }
    return entry
  }

  /** 倒序（最新在前）读审计。 */
  async function listAudit({ limit = 50 } = {}) {
    const entries = await readLines(auditPath)
    return { items: entries.slice().reverse().slice(0, limit), total: entries.length }
  }

  return { trashPath, auditPath, appendTrash, listTrash, countTrash, getTrash, removeTrash, appendAudit, listAudit }
}

// ---- 管理业务 ----

/**
 * 创建管理业务对象。
 * @param {object} deps
 * @param {object} deps.store - createMemoryStore 的返回值
 * @param {object} deps.model - { embed }
 * @param {object} deps.graph - { ingest }
 * @param {string} deps.dataDir - 回收站/审计文件所在目录
 * @param {Function} deps.enqueueWrite - 写队列
 * @param {string} deps.defaultIdentity - 管理列表读取的默认身份
 * @param {object} [deps.logger]
 */
export function createMemoryManagement(deps = {}) {
  const { store, model, graph, dataDir, defaultIdentity = 'user', logger } = deps
  const enqueueWrite = typeof deps.enqueueWrite === 'function' ? deps.enqueueWrite : (fn) => fn()
  const files = createManageFiles({ dataDir, logger })
  const warn = (m) => { try { logger?.warn?.('[dsh-tingxue/manage]', m) } catch {} }

  function requireStore() {
    if (!store) throw new Error('记忆服务未就绪')
  }

  async function audit(op, kind, id, detail) {
    await files.appendAudit({ op, kind, id, detail })
  }

  const entityText = (name, summary) => (summary ? `${name}：${summary}` : name)

  // ---- 实体 ----

  async function listEntities({ q = '', type = '', limit = 50, offset = 0 } = {}) {
    requireStore()
    const { items, total } = await store.listEntitiesPaged({ q, type, limit, offset })
    return { entities: items, total }
  }

  async function getEntityDetail(id) {
    requireStore()
    const raw = await store.getEntityWithVector(id)
    if (!raw) throw notFound('实体不存在', 'entity-not-found')
    const { vector, ...entity } = raw

    const rels = await store.relationsOfEntity(id, { includeEnded: true })
    const otherIds = [...new Set(rels.map((rel) => (rel.sourceId === id ? rel.targetId : rel.sourceId)))]
    const others = new Map((await store.getEntitiesByIds(otherIds)).map((row) => [row.id, row]))
    const relations = rels.map((rel) => {
      const direction = rel.sourceId === id ? 'out' : 'in'
      const otherId = direction === 'out' ? rel.targetId : rel.sourceId
      return {
        ...rel,
        direction,
        otherId,
        otherName: others.get(otherId)?.name ?? '',
      }
    })

    const memories = await store.memoriesByEntityId(id, { limit: 50 })
    const memoriesTotal = await store.countMemoriesByEntityId(id)

    let neighbors = []
    if (Array.isArray(vector) && vector.length > 0) {
      try {
        const hits = await store.searchEntities(vector, { limit: 6 })
        neighbors = hits
          .filter((hit) => hit.id !== id)
          .slice(0, 5)
          .map((hit) => ({
            id: hit.id, name: hit.name ?? '', type: hit.type ?? 'concept',
            summary: hit.summary ?? '', distance: Number(hit.distance ?? 0),
          }))
      } catch (error) {
        warn(`实体近邻检索失败: ${error.message}`)
      }
    }

    return {
      entity,
      relations,
      memories: memories.map((row) => ({
        id: row.id, text: row.text, scene: row.scene, createdAt: row.createdAt,
      })),
      neighbors,
      counts: { relations: relations.length, memories: memoriesTotal },
    }
  }

  async function createEntity({ name, type, summary } = {}) {
    requireStore()
    const cleanName = String(name ?? '').trim()
    if (!cleanName) throw badRequest('name 必填', 'invalid-name')
    const cleanType = String(type ?? '').trim() || 'concept'
    const cleanSummary = summary === undefined || summary === null ? '' : String(summary)

    if (!model) throw new Error('模型未就绪')
    const vectors = await model.embed([entityText(cleanName, cleanSummary)])
    const id = randomUUID()
    await enqueueWrite(async () => {
      // 查重放在写队列里：并发两个同名创建不会都通过检查再各插一行。
      const existing = await store.findEntityByNameAndType({ name: cleanName, type: cleanType })
      if (existing) {
        throw new ManageError(409, '同名同类型实体已存在', {
          code: 'entity-exists', payload: { entity: existing },
        })
      }
      await store.insertEntityRaw({
        id, name: cleanName, type: cleanType, summary: cleanSummary,
        vector: vectors[0], createdAt: Date.now(),
      })
      await audit('entity.create', 'entity', id, `${cleanName} (${cleanType})`)
    })
    const entity = await store.getEntityWithVector(id)
    return { entity: stripVector(entity) }
  }

  async function updateEntity(id, patch = {}) {
    requireStore()
    const current = await store.getEntityWithVector(id)
    if (!current) throw notFound('实体不存在', 'entity-not-found')

    const next = {}
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key)
    if (has('name')) {
      const name = String(patch.name ?? '').trim()
      if (!name) throw badRequest('name 不能为空', 'invalid-name')
      next.name = name
    }
    if (has('type')) {
      const type = String(patch.type ?? '').trim() || 'concept'
      next.type = type
    }
    if (has('summary')) next.summary = patch.summary === null ? '' : String(patch.summary ?? '')
    if (Object.keys(next).length === 0) throw badRequest('至少提供 name/type/summary 之一', 'no-fields')

    const name = next.name ?? current.name
    const type = next.type ?? current.type
    const summary = next.summary ?? current.summary

    const reembed = next.name !== undefined || next.summary !== undefined
    let vectors = null
    if (reembed) {
      if (!model) throw new Error('模型未就绪')
      vectors = await model.embed([entityText(name, summary)])
    }

    await enqueueWrite(async () => {
      // 改名冲突检查放在写队列内，避免并发 PATCH 同时通过检查。
      if (next.name !== undefined && next.name.toLowerCase() !== String(current.name).toLowerCase()) {
        const clash = await store.findEntityByNameAndType({ name, type })
        if (clash && clash.id !== id) {
          throw new ManageError(409, '同名同类型实体已存在', {
            code: 'entity-exists', payload: { entity: clash },
          })
        }
      }
      await store.updateEntityFields(id, {
        ...next,
        ...(vectors ? { vector: vectors[0] } : {}),
      })
      await audit('entity.update', 'entity', id, Object.keys(next).join(','))
    })
    const entity = await store.getEntityWithVector(id)
    return { entity: stripVector(entity) }
  }

  async function deleteEntity(id) {
    requireStore()
    const raw = await store.getEntityWithVector(id)
    if (!raw) throw notFound('实体不存在', 'entity-not-found')

    const result = await enqueueWrite(async () => {
      // 1) 级联关系：先查再删，把每条关系写入回收站。
      const relations = await store.deleteRelationsForEntity(id)
      for (const relation of relations) {
        await files.appendTrash('relation', relation)
      }
      // 2) 从记忆 entityIds 中摘掉该 id（记忆正文保留）。
      const memories = await store.memoriesByEntityId(id, { limit: 100000 })
      let memoriesUpdated = 0
      for (const memory of memories) {
        const nextIds = memory.entityIds.filter((entityId) => entityId !== id)
        if (nextIds.length === memory.entityIds.length) continue
        await store.updateMemoryFields(memory.id, { entityIds: nextIds })
        memoriesUpdated++
      }
      // 3) 实体本身：进回收站后删除。
      const deleted = await store.deleteEntityRow(id)
      if (deleted) await files.appendTrash('entity', deleted)
      await audit(
        'entity.delete', 'entity', id,
        `relationsDeleted=${relations.length} memoriesUpdated=${memoriesUpdated}`,
      )
      return { relationsDeleted: relations.length, memoriesUpdated }
    })

    return { deleted: true, ...result }
  }

  async function mergeEntities({ keepId, mergeId } = {}) {
    requireStore()
    if (!keepId || !mergeId) throw badRequest('keepId 与 mergeId 必填', 'missing-ids')
    if (String(keepId) === String(mergeId)) throw badRequest('keepId 与 mergeId 不能相同', 'same-id')
    const keep = await store.getEntityWithVector(keepId)
    if (!keep) throw badRequest('keepId 对应的实体不存在', 'entity-not-found')
    const merged = await store.getEntityWithVector(mergeId)
    if (!merged) throw badRequest('mergeId 对应的实体不存在', 'entity-not-found')

    const result = await enqueueWrite(async () => {
      // 1) 关系迁移：mergeId 的两端改到 keepId；自环/重复关系去重删除。
      const relations = await store.relationsOfEntity(mergeId, { includeEnded: true })
      let relationsMoved = 0
      let relationsRemoved = 0
      for (const relation of relations) {
        const sourceId = relation.sourceId === mergeId ? keepId : relation.sourceId
        const targetId = relation.targetId === mergeId ? keepId : relation.targetId
        if (sourceId === targetId) {
          await store.deleteRelationRow(relation.id)
          await files.appendTrash('relation', relation)
          relationsRemoved++
          continue
        }
        const duplicate = await store.findRelationByTriple({
          sourceId, targetId, relation: relation.relation,
        })
        if (duplicate && duplicate.id !== relation.id) {
          await store.deleteRelationRow(relation.id)
          await files.appendTrash('relation', relation)
          relationsRemoved++
          continue
        }
        await store.updateRelationFields(relation.id, { sourceId, targetId })
        relationsMoved++
      }

      // 2) 记忆引用迁移：entityIds 里的 mergeId 替换为 keepId（去重保序）。
      const memories = await store.memoriesByEntityId(mergeId, { limit: 100000 })
      let memoriesUpdated = 0
      for (const memory of memories) {
        const nextIds = []
        for (const entityId of memory.entityIds) {
          const mapped = entityId === mergeId ? keepId : entityId
          if (!nextIds.includes(mapped)) nextIds.push(mapped)
        }
        if (nextIds.length === memory.entityIds.length
          && nextIds.every((entityId, index) => entityId === memory.entityIds[index])) {
          continue
        }
        await store.updateMemoryFields(memory.id, { entityIds: nextIds })
        memoriesUpdated++
      }

      // 3) 被合并实体进回收站并删除。
      const deleted = await store.deleteEntityRow(mergeId)
      if (deleted) await files.appendTrash('entity', deleted)
      await audit(
        'entity.merge', 'entity', mergeId,
        `into=${keepId} relationsMoved=${relationsMoved} relationsRemoved=${relationsRemoved}`,
      )
      return { relationsMoved, relationsRemoved, memoriesUpdated }
    })

    return {
      keep: stripVector(keep),
      merged: stripVector(merged),
      relationsMoved: result.relationsMoved,
      memoriesUpdated: result.memoriesUpdated,
    }
  }

  // ---- 关系 ----

  async function listRelations({ q = '', includeEnded = false, limit = 50, offset = 0 } = {}) {
    requireStore()
    const { items, total } = await store.listRelationsPaged({ q, includeEnded, limit, offset })
    return { relations: items, total }
  }

  async function getRelation(id) {
    requireStore()
    const relation = await store.getRelationRow(id)
    if (!relation) throw notFound('关系不存在', 'relation-not-found')
    return { relation }
  }

  async function createRelation({ sourceId, targetId, relation, source } = {}) {
    requireStore()
    const cleanSource = String(sourceId ?? '').trim()
    const cleanTarget = String(targetId ?? '').trim()
    const cleanRelation = String(relation ?? '').trim()
    if (!cleanSource || !cleanTarget) throw badRequest('sourceId 与 targetId 必填', 'missing-ids')
    if (!cleanRelation) throw badRequest('relation 必填', 'invalid-relation')
    if (cleanSource === cleanTarget) throw badRequest('不允许自环关系', 'self-loop')
    const [sourceEntity, targetEntity] = await Promise.all([
      store.getEntityWithVector(cleanSource), store.getEntityWithVector(cleanTarget),
    ])
    if (!sourceEntity || !targetEntity) {
      throw badRequest('关系两端的实体必须存在', 'entity-not-found')
    }

    const id = await enqueueWrite(async () => {
      const relationId = await store.addRelation({
        sourceId: cleanSource, targetId: cleanTarget, relation: cleanRelation,
        source: String(source ?? '').trim() || 'manage',
      })
      await audit('relation.create', 'relation', relationId,
        `${cleanSource} -[${cleanRelation}]-> ${cleanTarget}`)
      return relationId
    })
    const created = await store.getRelationRow(id)
    return { relation: created }
  }

  async function updateRelation(id, patch = {}) {
    requireStore()
    const current = await store.getRelationRow(id)
    if (!current) throw notFound('关系不存在', 'relation-not-found')

    const next = {}
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key)
    if (has('relation')) {
      const relation = String(patch.relation ?? '').trim()
      if (!relation) throw badRequest('relation 不能为空', 'invalid-relation')
      next.relation = relation
    }
    if (has('sourceId')) {
      const sourceId = String(patch.sourceId ?? '').trim()
      if (!sourceId) throw badRequest('sourceId 不能为空', 'missing-ids')
      const entity = await store.getEntityWithVector(sourceId)
      if (!entity) throw badRequest('sourceId 对应的实体不存在', 'entity-not-found')
      next.sourceId = sourceId
    }
    if (has('targetId')) {
      const targetId = String(patch.targetId ?? '').trim()
      if (!targetId) throw badRequest('targetId 不能为空', 'missing-ids')
      const entity = await store.getEntityWithVector(targetId)
      if (!entity) throw badRequest('targetId 对应的实体不存在', 'entity-not-found')
      next.targetId = targetId
    }
    if (has('validTo')) {
      const validTo = Number(patch.validTo)
      if (!Number.isFinite(validTo) || validTo < 0) {
        throw badRequest('validTo 必须是非负数（0 表示仍有效）', 'invalid-valid-to')
      }
      next.validTo = validTo
    }
    if (Object.keys(next).length === 0) {
      throw badRequest('至少提供 relation/validTo/sourceId/targetId 之一', 'no-fields')
    }
    const sourceId = next.sourceId ?? current.sourceId
    const targetId = next.targetId ?? current.targetId
    if (sourceId === targetId) throw badRequest('不允许自环关系', 'self-loop')

    await enqueueWrite(async () => {
      await store.updateRelationFields(id, next)
      await audit('relation.update', 'relation', id, Object.keys(next).join(','))
    })
    const relation = await store.getRelationRow(id)
    return { relation }
  }

  async function deleteRelation(id) {
    requireStore()
    const relation = await store.getRelationRow(id)
    if (!relation) throw notFound('关系不存在', 'relation-not-found')
    await enqueueWrite(async () => {
      const deleted = await store.deleteRelationRow(id)
      if (deleted) await files.appendTrash('relation', deleted)
      await audit('relation.delete', 'relation', id, `${relation.relation}`)
    })
    return { deleted: true }
  }

  // ---- 记忆 ----

  async function listMemories({ q = '', scene = '', identity, limit = 50, offset = 0 } = {}) {
    requireStore()
    const effectiveIdentity = identity === undefined || identity === null || identity === ''
      ? defaultIdentity
      : String(identity)
    const { items, total } = await store.listMemoriesPaged({
      q, scene, identity: effectiveIdentity, limit, offset,
    })
    return { memories: items, total }
  }

  async function getMemoryDetail(id) {
    requireStore()
    const memory = await store.getMemoryWithVector(id)
    if (!memory) throw notFound('记忆不存在', 'memory-not-found')
    const entities = await store.getEntitiesByIds(memory.entityIds)
    return {
      memory: {
        id: memory.id, text: memory.text, scene: memory.scene, identity: memory.identity,
        source: memory.source, createdAt: memory.createdAt, entityIds: memory.entityIds,
      },
      entities: entities.map((row) => ({ id: row.id, name: row.name, type: row.type })),
    }
  }

  async function updateMemory(id, patch = {}) {
    requireStore()
    const current = await store.getMemoryWithVector(id)
    if (!current) throw notFound('记忆不存在', 'memory-not-found')

    const next = {}
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key)
    if (has('text')) {
      const text = String(patch.text ?? '').trim()
      if (!text) throw badRequest('text 不能为空', 'invalid-text')
      next.text = text
    }
    if (has('scene')) next.scene = String(patch.scene ?? '').trim() || 'chat'
    if (Object.keys(next).length === 0) throw badRequest('至少提供 text/scene 之一', 'no-fields')

    let vectors = null
    if (next.text !== undefined) {
      if (!model) throw new Error('模型未就绪')
      vectors = await model.embed([next.text])
    }

    await enqueueWrite(async () => {
      await store.updateMemoryFields(id, {
        ...next,
        ...(vectors ? { vector: vectors[0] } : {}),
      })
      await audit('memory.update', 'memory', id, Object.keys(next).join(','))
    })
    const memory = await store.getMemoryWithVector(id)
    return {
      memory: {
        id: memory.id, text: memory.text, scene: memory.scene, identity: memory.identity,
        source: memory.source, createdAt: memory.createdAt, entityIds: memory.entityIds,
      },
    }
  }

  async function deleteMemory(id) {
    requireStore()
    const memory = await store.getMemoryWithVector(id)
    if (!memory) throw notFound('记忆不存在', 'memory-not-found')
    await enqueueWrite(async () => {
      const deleted = await store.deleteMemoryRow(id)
      if (deleted) await files.appendTrash('memory', deleted)
      await audit('memory.delete', 'memory', id, `scene=${memory.scene}`)
    })
    return { deleted: true }
  }

  /** 重新抽取实体/关系：异步执行，响应先回（图抽取是慢模型调用）。 */
  async function reextractMemory(id) {
    requireStore()
    const memory = await store.getMemoryWithVector(id)
    if (!memory) throw notFound('记忆不存在', 'memory-not-found')
    if (!graph) throw new Error('图谱服务未就绪')
    const text = memory.text
    const source = memory.source || 'chat'
    // 先返回，后台排队抽取；失败只记日志，不影响已返回的响应。
    enqueueWrite(async () => {
      try {
        await graph.ingest(text, { source })
        await audit('memory.reextract', 'memory', id, `source=${source}`)
      } catch (error) {
        warn(`重新抽取失败: ${error.message}`)
        await audit('memory.reextract.failed', 'memory', id, error.message)
      }
    }).catch(() => {})
    return { async: true, memoryId: id }
  }

  // ---- 统计 ----

  async function stats() {
    requireStore()
    const [memoriesCount, entitiesCount, relationsCount, activeRelations] = await Promise.all([
      store.countTableRows('memories'),
      store.countTableRows('entities'),
      store.countTableRows('relations'),
      store.countTableRows('relations', 'validTo = 0'),
    ])
    const trash = await files.countTrash()
    return {
      memories: Number(memoriesCount),
      entities: Number(entitiesCount),
      relations: Number(relationsCount),
      activeRelations: Number(activeRelations),
      trash: Number(trash),
    }
  }

  // ---- 回收站 ----

  async function listTrash({ limit = 50 } = {}) {
    return files.listTrash({ limit })
  }

  async function restoreTrash(trashId) {
    requireStore()
    const entry = await files.getTrash(trashId)
    if (!entry) throw notFound('回收站条目不存在', 'trash-not-found')
    const { kind, row } = entry
    if (!row || !row.id) throw badRequest('回收站条目缺少 row.id', 'invalid-trash-entry')

    const result = await enqueueWrite(async () => {
      if (kind === 'entity') {
        if (await store.getEntityWithVector(row.id)) {
          throw new ManageError(409, '同 id 实体已存在，无法恢复', { code: 'restore-conflict' })
        }
        await store.insertEntityRaw(row)
      } else if (kind === 'relation') {
        if (await store.getRelationRow(row.id)) {
          throw new ManageError(409, '同 id 关系已存在，无法恢复', { code: 'restore-conflict' })
        }
        await store.insertRelationRaw(row)
      } else if (kind === 'memory') {
        if (await store.getMemoryWithVector(row.id)) {
          throw new ManageError(409, '同 id 记忆已存在，无法恢复', { code: 'restore-conflict' })
        }
        await store.insertMemoryRaw(row)
      } else {
        throw badRequest(`未知回收站类型: ${kind}`, 'invalid-trash-kind')
      }
      await files.removeTrash(trashId)
      await audit('trash.restore', kind, row.id, `trashId=${trashId}`)
      return { kind, id: row.id }
    })
    return result
  }

  async function listAudit({ limit = 50 } = {}) {
    return files.listAudit({ limit })
  }

  return {
    files,
    listEntities, getEntityDetail, createEntity, updateEntity, deleteEntity, mergeEntities,
    listRelations, getRelation, createRelation, updateRelation, deleteRelation,
    listMemories, getMemoryDetail, updateMemory, deleteMemory, reextractMemory,
    stats,
    listTrash, restoreTrash, listAudit,
  }
}

/** 去掉内部向量字段（对外响应绝不含原始向量）。 */
function stripVector(entity) {
  if (!entity) return entity
  const { vector, ...rest } = entity
  return rest
}
