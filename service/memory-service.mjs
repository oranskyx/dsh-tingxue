// dsh-tingxue service/memory-service.mjs
// 独立记忆服务入口（trunk）：不由 DSH 拉起，开机自启（nssm Windows 服务）。
// 独占 LanceDB（唯一写者），对 DSH 插件与 AstrBot 提供同一套 HTTP API。
//
// 启动：
//   node service/memory-service.mjs
// 配置：
//   service/config.json（可被环境变量覆盖；配置文件不含任何密钥）
// 密钥与端点（面板可在 PUT /config 里改）：
//   <dataDir>/secrets.json（不进 git，仅当前用户可读）
//   → 环境变量 STA1N_API_KEY
//   → ~/.dsh/.credentials.yaml 的 refs.STA1N_API_KEY
//   端点：secrets.json 的 apiBaseUrl > config.json 的 apiBaseUrl/baseURL > 后端默认

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMemoryStore } from '../src/memory/store.mjs'
import { createGraphService } from '../src/graph/index.mjs'
import { createModelAdapter } from '../src/models/index.mjs'
import { createMemoryService } from '../src/memory-service/index.mjs'
import { readSecrets, secretsFilePath } from '../src/memory-service/secrets.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const DEFAULTS = Object.freeze({
  dataDir: resolve(repoRoot, '..', '.dsh-tingxue-data'),
  profilePath: join(repoRoot, '听雪档案.txt'),
  memoryServiceHost: '127.0.0.1',
  memoryServicePort: 8766,
  graphDashboardHost: '127.0.0.1',
  graphDashboardPort: 8765,
  memoriesIdentity: 'user',
  modelBackend: 'sta1n',
  embeddingModel: 'gemini-embedding-2',
  embeddingDimensions: 3072,
  llmModel: 'gemini-3.1-flash-lite',
  credentialsPath: join(homedir(), '.dsh', '.credentials.yaml'),
})

function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] [tingxue-memory] ${message}`
  if (level === 'error') console.error(line)
  else console.log(line)
}

const logger = {
  info: (m) => log('info', m),
  warn: (m) => log('warn', m),
  error: (m) => log('error', m),
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`无法读取配置 ${path}: ${error.message}`)
  }
}

/** 从 DSH 凭据文件里取出 refs.<name> 的值；只做最小解析，不载入整库。 */
async function readCredential(path, name) {
  try {
    const text = await readFile(path, 'utf8')
    const refsAt = text.search(/^refs:\s*$/m)
    if (refsAt < 0) return ''
    const rest = text.slice(refsAt).split(/\r?\n/).slice(1)
    for (const line of rest) {
      if (/^\S/.test(line)) break // 离开 refs 段
      const match = new RegExp(`^\\s+${name}:\\s*(.+?)\\s*$`).exec(line)
      if (match) return match[1]
    }
    return ''
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

const configPath = process.env.TINGXUE_SERVICE_CONFIG
  ? resolve(process.env.TINGXUE_SERVICE_CONFIG)
  : join(here, 'config.json')
const fileConfig = await readJson(configPath)
const config = {
  ...DEFAULTS,
  ...fileConfig,
  ...(process.env.TINGXUE_DATA_DIR ? { dataDir: process.env.TINGXUE_DATA_DIR } : {}),
  ...(process.env.TINGXUE_PROFILE_PATH ? { profilePath: process.env.TINGXUE_PROFILE_PATH } : {}),
  ...(process.env.TINGXUE_MEMORY_HOST ? { memoryServiceHost: process.env.TINGXUE_MEMORY_HOST } : {}),
  ...(process.env.TINGXUE_MEMORY_PORT ? { memoryServicePort: Number(process.env.TINGXUE_MEMORY_PORT) } : {}),
  ...(process.env.TINGXUE_GRAPH_HOST ? { graphDashboardHost: process.env.TINGXUE_GRAPH_HOST } : {}),
  ...(process.env.TINGXUE_GRAPH_PORT ? { graphDashboardPort: Number(process.env.TINGXUE_GRAPH_PORT) } : {}),
}

/**
 * 读 <dataDir>/secrets.json。每次模型请求/配置查询都会调用：
 * 文件很小（两个字段），换来的是「面板改完 API 配置立即生效」。
 * 文件损坏时只告警并回退，不让健康检查跟着 500。
 */
async function readSecretsSafe() {
  try {
    return await readSecrets(config.dataDir)
  } catch (error) {
    logger.warn(`读取密钥文件失败（回退环境变量/凭据文件）: ${error.message}`)
    return {}
  }
}

const credentialFromFile = await readCredential(config.credentialsPath, 'STA1N_API_KEY')
const startupSecrets = await readSecretsSafe()

/**
 * 启动时的 API Key 解析。优先级即契约：
 *   <dataDir>/secrets.json  >  STA1N_API_KEY 环境变量  >  .credentials.yaml
 * 另外保留 config.json 的 apiKey 作为最后兼容回退（正常配置不应写它）。
 * 只返回来源名，值不写日志。
 */
function startupApiKey() {
  if (startupSecrets.apiKey) return { key: startupSecrets.apiKey, source: 'secrets' }
  const fromEnv = String(process.env.STA1N_API_KEY ?? '').trim()
  if (fromEnv) return { key: fromEnv, source: 'env' }
  if (credentialFromFile) return { key: credentialFromFile, source: 'credentials' }
  const fromConfig = String(config.apiKey ?? '').trim()
  if (fromConfig) return { key: fromConfig, source: 'config' }
  return { key: '', source: 'none' }
}

const startupKey = startupApiKey()
// 端点：secrets.json > config.json(apiBaseUrl/baseURL) > 后端默认（空串）。
const startupBaseUrl = String(
  startupSecrets.apiBaseUrl || config.apiBaseUrl || config.baseURL || '',
).trim()

/** 每次模型调用重新解析 key（secrets → env → credentials → config）。 */
async function resolveRuntimeApiKey() {
  const secrets = await readSecretsSafe()
  if (secrets.apiKey) return secrets.apiKey
  const fromEnv = String(process.env.STA1N_API_KEY ?? '').trim()
  if (fromEnv) return fromEnv
  const fromCredentials = await readCredential(config.credentialsPath, 'STA1N_API_KEY')
  if (fromCredentials) return fromCredentials
  return String(config.apiKey ?? '').trim()
}

/** GET /config 用：只回 {present, source}，绝不回值。 */
async function resolveApiKeyInfo() {
  if ((await readSecretsSafe()).apiKey) return { present: true, source: 'secrets' }
  const fromEnv = String(process.env.STA1N_API_KEY ?? '').trim()
  if (fromEnv) return { present: true, source: 'env' }
  const fromCredentials = await readCredential(config.credentialsPath, 'STA1N_API_KEY')
  if (fromCredentials) return { present: true, source: 'credentials' }
  if (String(config.apiKey ?? '').trim()) return { present: true, source: 'config' }
  return { present: false, source: 'none' }
}

/** 每次模型调用重新解析端点（secrets → config → 后端默认）。 */
async function resolveRuntimeApiBaseUrl() {
  const secrets = await readSecretsSafe()
  if (secrets.apiBaseUrl) return secrets.apiBaseUrl
  return String(config.apiBaseUrl ?? config.baseURL ?? '').trim()
}

logger.info(`配置：${configPath}`)
logger.info(`数据目录：${config.dataDir}`)
logger.info(`人格档案：${config.profilePath}`)
logger.info(`API 配置落盘：${secretsFilePath(config.dataDir)}（不进 git，仅当前用户可读）`)
logger.info(`模型端点：${startupBaseUrl || '(后端默认)'}`)
logger.info(`API Key 来源：${startupKey.source}`)

if (!startupKey.key && config.modelBackend === 'sta1n') {
  logger.warn('未解析到 API Key（secrets.json / 环境变量 / 凭据文件都没有）；检索/写入会失败，健康检查仍可用')
}

// 面板 GET /config 的脱敏视图：只列白名单字段，绝不含 apiKey/凭据路径。
const configView = {
  dataDir: config.dataDir,
  profilePath: config.profilePath,
  memoryServiceHost: config.memoryServiceHost,
  memoryServicePort: config.memoryServicePort,
  graphDashboardHost: config.graphDashboardHost,
  graphDashboardPort: config.graphDashboardPort,
  memoriesIdentity: config.memoriesIdentity,
  modelBackend: config.modelBackend,
  embeddingModel: config.embeddingModel,
  embeddingDimensions: config.embeddingDimensions,
  llmModel: config.llmModel,
  apiBaseUrl: startupBaseUrl,
}

const model = createModelAdapter({
  modelBackend: config.modelBackend,
  embeddingModel: config.embeddingModel,
  llmModel: config.llmModel,
  baseURL: startupBaseUrl || undefined,
  apiKey: startupKey.key || undefined,
  embeddingDimensions: config.embeddingDimensions,
}, {
  logger,
  getApiKey: resolveRuntimeApiKey,
  getBaseURL: resolveRuntimeApiBaseUrl,
})

const store = await createMemoryStore(
  { dataDir: config.dataDir, dimensions: config.embeddingDimensions, embeddingModel: config.embeddingModel },
  { logger },
)
const graph = createGraphService(store, model, { logger })

const service = createMemoryService(
  {
    store,
    model,
    graph,
    profilePath: config.profilePath,
    logger,
    dataDir: config.dataDir,
    configPath,
    configView,
    apiKeyPresent: Boolean(startupKey.key),
    resolveApiKeyInfo,
    resolveApiBaseUrl: resolveRuntimeApiBaseUrl,
    uiDir: join(here, 'ui'),
  },
  {
    memoryServiceHost: config.memoryServiceHost,
    memoryServicePort: config.memoryServicePort,
    memoriesIdentity: config.memoriesIdentity,
    graphDashboardHost: config.graphDashboardHost,
    graphDashboardPort: config.graphDashboardPort,
  },
)

const url = await service.start()
if (!url) {
  logger.error('记忆服务启动失败')
  process.exit(1)
}
logger.info(`记忆服务已就绪：${url}`)
if (service.graphUrl) logger.info(`图谱 UI：${service.graphUrl}/graph`)

let stopping = false
async function shutdown(signal) {
  if (stopping) return
  stopping = true
  logger.info(`收到 ${signal}，正在停止…`)
  try { await service.stop() } catch (error) { logger.warn(`停止失败：${error.message}`) }
  try { model.dispose?.() } catch { /* 忽略 */ }
  try { await store.close?.() } catch { /* 忽略 */ }
  process.exit(0)
}
process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
