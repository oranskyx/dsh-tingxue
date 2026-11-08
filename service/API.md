# 听雪记忆服务 · 管理 API v1（实现契约）

> 本文是服务端、图谱 UI、DSH 客户端三方共用的**唯一接口契约**。改接口先改本文。
> 服务进程：`node service/memory-service.mjs`；数据目录：`D:\oransky\Desktop\oransky\dsh\.dsh-tingxue-data`。
> 单写者：只有本服务进程打开 LanceDB；所有写操作走 `enqueueWrite` 串行。
> 只监听 loopback。**任何响应都不得包含 API Key、凭据或原始向量**。

## 0. 通用

- Base：`http://127.0.0.1:8766`（唯一端口；8765 的网页面板已删除）。
- 请求/响应：`application/json; charset=utf-8`。
- 成功：`{ ok: true, ... }`；失败：`{ ok: false, error: string, code?: string }`，HTTP 4xx/5xx。
- 分页：`limit`（默认 50，最大 500）、`offset`（默认 0）；列表响应带 `total`（可用就带）。
- 身份：服务端权威 `memoriesIdentity`（默认 `user`）；管理读接口可传 `identity=*` 查看全部（只读诊断用途），写接口不接受客户端 identity。
- 时间：毫秒时间戳（number）。`validTo = 0` 表示关系仍然有效。
- 并发：写操作进入写队列；读操作并行。
- CORS：允许本机 loopback 来源的 GET/POST/PATCH/DELETE/OPTIONS。

## 1. 现有端点（保持不变）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok,service,port}` |
| GET | `/profile` | `{ok,profile}` |
| POST | `/memory` | 写一条记忆，body `{text,scene?,source?}`；`scene=selftest` 跳过图谱抽取 |
| GET | `/memory/search?q=&limit=&scene=` | 语义检索（服务端 identity） |
| DELETE | `/memory?id=` | 按 id 删除一条记忆（已加，管理/自检用） |
| GET | `/memory/entities` | 全部实体 `{ok,entities}`（兼容旧客户端，保留） |
| GET | `/memory/relations` | 全部关系 `{ok,relations}`（兼容旧客户端，保留） |
| GET | `/memory/expand?entityId=&depth=` | 图扩展 |
| GET | `/memory/entities` 带 `q/type/limit/offset` | 见 §2（新增分页/过滤） |

## 2. 实体管理

### GET `/memory/entities?q=&type=&limit=&offset=`
- `q`：name/summary 子串（大小写不敏感）；`type`：精确类型。
- 响应：`{ok:true, entities:[{id,name,type,summary,createdAt}], total}`。
- 不带 `q/type/limit/offset` 时保持旧行为（返回前 1500 条、`{ok,entities}`），避免破坏 AstrBot。

### GET `/memory/entities/:id`
响应：
```json
{ "ok": true,
  "entity": {"id","name","type","summary","createdAt"},
  "relations": [{"id","sourceId","targetId","relation","validFrom","validTo","source","direction":"out|in","otherId","otherName"}],
  "memories": [{"id","text","scene","createdAt"}],
  "neighbors": [{"id","name","type","summary","distance"}],
  "counts": {"relations": 0, "memories": 0}
}
```
- `relations`：包含 `validTo=0` 与已结束的（`direction` 由 id 判定；`otherId/otherName` 为对端实体）。
- `memories`：`entityIds` 含该 id 的记忆（最多 50 条）。
- `neighbors`：用该实体向量做 `searchEntities` 的近邻（最多 5 条，排除自己）。

### POST `/memory/entities`
body：`{name, type, summary?}`；`name` 必填，`type` 默认 `'concept'`。
- 若同名同类型已存在：返回 409 `{ok:false,code:'entity-exists',entity}`。
- 向量：`embed([name + (summary ? '：'+summary : '')])`。
- 响应：`{ok:true, entity}`。

### PATCH `/memory/entities/:id`
body：`{name?, type?, summary?}`（至少一项）。
- 改 `name` 或 `summary` 时重嵌入；改名冲突 → 409。
- 响应：`{ok:true, entity}`。

### DELETE `/memory/entities/:id`
- 级联：删除所有 `sourceId=id OR targetId=id` 的关系（统计 `relationsDeleted`）。
- 摘引用：扫描 `memories.entityIds` 含该 id 的行，更新为去掉该 id（统计 `memoriesUpdated`）。
- 把被删实体（含向量）、关系行写入回收站。
- 响应：`{ok:true, deleted:true, relationsDeleted, memoriesUpdated}`。

### POST `/memory/entities/merge`
body：`{keepId, mergeId}`（两者都必须存在，不能相同）。
- 关系：把 `mergeId` 的 source/target 改到 `keepId`（重复关系去重）。
- 记忆：把 `mergeId` 从 `entityIds` 替换为 `keepId`。
- 删除 `mergeId`（进回收站）。
- 响应：`{ok:true, keep, merged, relationsMoved, memoriesUpdated}`。

## 3. 关系管理

### GET `/memory/relations?q=&includeEnded=&limit=&offset=`
- `q`：关系词/实体名子串；`includeEnded=true` 包含 `validTo>0`。
- 响应：`{ok:true, relations:[{id,sourceId,targetId,relation,validFrom,validTo,source,sourceName,targetName}], total}`。

### POST `/memory/relations`
body：`{sourceId, targetId, relation}`；两个实体必须存在；不能自环 → 400。
- 响应：`{ok:true, relation}`。

### PATCH `/memory/relations/:id`
body：`{relation?, validTo?, sourceId?, targetId?}`；改两端需实体存在。
- 响应：`{ok:true, relation}`。

### DELETE `/memory/relations/:id`
- 进回收站；响应 `{ok:true, deleted:true}`。

## 4. 记忆管理

### GET `/memory/memories?q=&scene=&limit=&offset=`
- `q`：正文子串（不走向量，管理用途）；`scene`：精确。
- 响应：`{ok:true, memories:[{id,text,scene,identity,source,createdAt,entityIds}], total}`。

### GET `/memory/memories/:id`
- 响应：`{ok:true, memory, entities:[{id,name,type}]}`。

### PATCH `/memory/memories/:id`
body：`{text?, scene?}`；改 `text` 时重嵌入。
- 响应：`{ok:true, memory}`。

### DELETE `/memory/memories/:id`
- 进回收站；响应 `{ok:true, deleted:true}`。

### POST `/memory/memories/:id/reextract`
- 重新跑 `graph.ingest(text)`（异步，返回 `{ok:true, async:true}`）。

## 5. 统计 / 回收站 / 审计

### GET `/memory/stats`
```json
{"ok":true,"memories":972,"entities":434,"relations":380,"activeRelations":380,"trash":0}
```

### GET `/memory/trash?limit=`
- 读 `<dataDir>/manage-trash.jsonl`，倒序；`{ok:true, items:[{trashId,kind:'entity|relation|memory',deletedAt,row}]}`。
- `row` 对 entity/memory 含 `vector`（恢复需要）；UI 展示时不要渲染向量。

### POST `/memory/trash/:trashId/restore`
- 按行恢复；id 已存在 → 409 `{code:'restore-conflict'}`。
- 恢复后从回收站移除该行（重写 JSONL）。
- 响应：`{ok:true, kind, id}`。

### GET `/memory/audit?limit=`
- 读 `<dataDir>/manage-audit.jsonl`；`{ok:true, items:[{at,op,kind,id,detail}]}`（不含向量/密钥）。

## 6. 配置（面板代理）

配置分两处落盘：

| 文件 | 内容 | 进 git |
| --- | --- | --- |
| `service/config.json` | 非机密配置（端口、模型名、路径等） | 是 |
| `<dataDir>/secrets.json` | `apiKey`、`apiBaseUrl` | **否**（数据目录不在仓库内；且 `.gitignore` 排除 `secrets.json`） |

`secrets.json` 的文件权限会收紧到仅当前用户可读（Windows 用
`icacls <file> /inheritance:r /grant:r <当前用户>:F`；其它平台 `chmod 0600`）。
收紧失败不阻塞保存，只在响应里给 `warning`。

若 `secrets.json` 本身损坏（非法 JSON），`PUT /config` 会返回 500 而**不会覆盖**它
（避免静默丢掉已有 key）；按提示修复或删除该文件后重试。`GET /config` 遇到坏文件
不会 500，只按「没有 secrets 覆盖」回退。

### GET `/config`
- 返回**脱敏**配置：
  ```json
  {
    "ok": true,
    "config": {
      "dataDir": "...", "profilePath": "...", "memoryServiceHost": "127.0.0.1",
      "memoryServicePort": 8766, "memoriesIdentity": "user",
      "modelBackend": "sta1n", "embeddingModel": "gemini-embedding-2",
      "embeddingDimensions": 3072, "llmModel": "gemini-3.1-flash-lite",
      "apiBaseUrl": "https://cdn.sta1n.cn/v1"
    },
    "hasApiKey": true,
    "apiKeySource": "secrets"
  }
  ```
- `apiBaseUrl` 是当前**有效**端点（`secrets.json` > `config.json` > 后端默认），可以回显。
- `apiKey` **永远不回显**，连片段/掩码都没有：只有 `hasApiKey:boolean` 和
  `apiKeySource`（`secrets|env|credentials|config|none`，仅表示解析来源）。
- 日志、审计、错误消息一律不含 key 原文；模型错误文本若回显了 key，会先替换为 `***`。

### PUT `/config`
body：以下字段的任意子集（未知字段忽略）。

**非机密字段**（写 `service/config.json`，保留未知字段）：
`dataDir / profilePath / memoryServiceHost / memoryServicePort / memoriesIdentity / modelBackend / embeddingModel /
embeddingDimensions / llmModel`，行为与之前一致。

**API 字段**（写 `<dataDir>/secrets.json`，**即时生效**，无需重启）：
- `apiBaseUrl`（string）：OpenAI 兼容 base URL，必须 `http/https`；尾部斜杠会被去掉
  （`.../v1/` ≡ `.../v1`）。传空串表示**清除覆盖**，回落后端默认端点。
- `apiKey`（string）：密钥本体。传空串表示**清除**，回退环境变量/凭据文件。
- 生效优先级：
  - apiKey：`secrets.json` > 环境变量 `STA1N_API_KEY` > `~/.dsh/.credentials.yaml` 的 `refs.STA1N_API_KEY`
  - apiBaseUrl：`secrets.json` > `config.json` 的 `apiBaseUrl/baseURL` > 后端默认
  - embedding 与 LLM（`/embeddings` 与 `/chat/completions`）共用同一份解析结果。

响应：
```json
{
  "ok": true,
  "restartRequired": false,
  "api": { "persisted": true, "file": "<dataDir>/secrets.json", "cleared": false, "fields": ["apiKey"] }
}
```
- `api.fields` 只列字段名；`api.file` 是落盘路径；**响应里没有 key 值**。
- 只有非机密字段里需要重启的项（端口/模型/identity 等）才置 `restartRequired:true`。
- 权限收紧失败时多一个 `warning` 字段。
- 面板展示 `restartRequired` 提示。

### 反向判据（配置真的被用上）
把 `secrets.json` 的 key 改错或把 `apiBaseUrl` 指向不存在的地址 → 重启 →
`GET /memory/search` 必须报错；改回正确值 → 重启 → 搜索恢复。
仅「GET 回读一致」不构成配置生效的证据。

## 7. 图谱 UI 与静态资源

- UI 读取 query `?api=`（默认 `/api`）、`?theme=light|dark|auto`（默认 auto）；资源路径必须是**相对路径**（`./app.js`），以便 DSH 反代。
- DSH 侧反代契约（由插件实现）：
  - `/dsh-tingxue/memory/*` → `http://127.0.0.1:8766/*`
  - iframe src：`/dsh-tingxue/graph/?api=/dsh-tingxue/memory&theme=auto`

## 8. 回收站/审计文件格式

`<dataDir>/manage-trash.jsonl` 每行：
```json
{"trashId":"uuid","kind":"entity|relation|memory","deletedAt":1690000000000,"row":{...}}
```
`<dataDir>/manage-audit.jsonl` 每行：
```json
{"at":1690000000000,"op":"entity.delete","kind":"entity","id":"...","detail":"..."}
```
- 只追加；恢复时重写回收站文件。
- 单文件超过 20 MB 时滚动为 `.1`（v1 可不做，但记录 TODO）。

## 9. 删除语义（已确认）

- 删实体：级联删关系 + 从记忆 `entityIds` 摘除；实体与关系进回收站；记忆正文保留。
- 删关系：直接进回收站。
- 删记忆：进回收站。
- 合并实体：关系/记忆引用迁到保留方；被合并方进回收站。
- 所有管理写操作记审计。

## 10. 验收

- `node --check` 所有改动文件通过。
- 管理 API 测试用**临时 dataDir + 假模型**，不写真实库；覆盖：实体 CRUD/冲突、关系 CRUD/自环、记忆 PATCH 重嵌入、删实体级联+摘引用、合并、回收站恢复、审计、分页/过滤。
- 真实库只做只读验收（stats/entities/relations/profile）。
- 服务重启后回收站/审计仍在（文件持久化）。
