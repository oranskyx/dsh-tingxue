// dsh-tingxue src/memory-service/secrets.mjs
//
// 面板可配置的 API 凭据（apiKey / apiBaseUrl）落盘模块。
//
// 为什么单独一个文件：`service/config.json` 是仓库里被 git 跟踪的配置文件，
// 绝不能承载密钥。运行时凭据写进数据目录 `<dataDir>/secrets.json`：该目录
// 不在仓库内，`.gitignore` 里也排除了 `.dsh-tingxue-data/`；本模块再给
// secrets.json 收紧 ACL，做到 Windows 上仅当前用户可读（icacls）。
//
// 文件格式：
//   { "apiKey": "sk-...", "apiBaseUrl": "https://cdn.sta1n.cn/v1" }
//
// 语义：
//   - apiBaseUrl 缺省 / 空串 = 不覆盖，用模型后端默认端点。
//   - apiKey 缺省 / 空串 = 清除（回退环境变量 STA1N_API_KEY → .credentials.yaml）。
//
// 安全约定（改代码时不要破坏）：
//   - 本模块抛出的错误消息只允许出现**路径**，绝不出现字段值。
//   - 读取失败（ENOENT 除外）必须显式报错，不能静默当成空配置：静默会把
//     「读不到已有 key」变成「用别的 key 覆盖」，属于凭据事故。
//   - 写盘走临时文件 + rename，避免进程中途退出留下半截 JSON。

import { spawnSync } from 'node:child_process'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const SECRETS_FILENAME = 'secrets.json'

/** secrets.json 允许的字段（其余字段读时忽略、写时保留）。 */
const SECRET_FIELDS = ['apiKey', 'apiBaseUrl']

/**
 * 数据目录下的 secrets.json 绝对路径；dataDir 未知时返回 ''。
 * @param {string} dataDir
 * @returns {string}
 */
export function secretsFilePath(dataDir) {
  const dir = String(dataDir ?? '').trim()
  if (!dir) return ''
  return join(dir, SECRETS_FILENAME)
}

/**
 * 读取 secrets.json。
 * @param {string} dataDir
 * @returns {Promise<{apiKey?: string, apiBaseUrl?: string}>} 只返回非空字段
 */
export async function readSecrets(dataDir) {
  const path = secretsFilePath(dataDir)
  if (!path) return {}
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`无法读取密钥文件 ${path}: ${error.message}`)
  }
  if (!text.trim()) return {}
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`密钥文件不是合法 JSON: ${path}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {}
  const out = {}
  for (const key of SECRET_FIELDS) {
    const value = typeof data[key] === 'string' ? data[key].trim() : ''
    if (value) out[key] = value
  }
  return out
}

/**
 * 收紧 secrets.json 的权限：Windows 用 icacls 去掉继承、只授予当前用户；
 * 其它平台 chmod 0600。
 *
 * 失败不抛（只返回 warning）：权限收紧是加固项，不能让「面板保存 API 配置」
 * 这类主功能因 ACL 操作失败而整体失败。调用方应把 warning 透出给用户。
 *
 * @param {string} path
 * @returns {Promise<{ok: boolean, warning?: string}>}
 */
export async function hardenSecretsFile(path) {
  if (!path) return { ok: false, warning: '密钥文件路径为空，无法收紧权限' }
  if (process.platform !== 'win32') {
    try {
      await chmod(path, 0o600)
      return { ok: true }
    } catch (error) {
      return { ok: false, warning: `chmod 0600 失败: ${error.message}` }
    }
  }
  const user = String(process.env.USERNAME ?? '').trim()
  if (!user) return { ok: false, warning: '无法确定当前用户名，密钥文件权限未收紧' }
  const domain = String(process.env.USERDOMAIN ?? '').trim()
  const account = domain ? `${domain}\\${user}` : user
  // /inheritance:r 移除继承的 ACE；/grant:r 替换该账户的授予为「完全控制」。
  // 结果：只有当前用户 + SYSTEM/管理员组之外没有任何继承权限。
  const result = spawnSync(
    'icacls',
    [path, '/inheritance:r', '/grant:r', `${account}:F`],
    { windowsHide: true, encoding: 'utf8' },
  )
  if (result.error) {
    return { ok: false, warning: `icacls 调用失败（密钥文件权限未收紧）: ${result.error.message}` }
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? '').trim().slice(0, 200)
    return { ok: false, warning: `icacls 返回 ${result.status}（密钥文件权限未收紧）${detail ? `: ${detail}` : ''}` }
  }
  return { ok: true }
}

/**
 * 合并写入 secrets.json。
 *
 * patch 里的 `null` / `undefined` / 空串表示**删除该字段**；删除后没有剩余
 * 字段则移除整个文件（不留 `{}` 空壳）。
 *
 * @param {string} dataDir
 * @param {Record<string, string|null|undefined>} patch
 * @returns {Promise<{path: string, removed: boolean, permission: {ok: boolean, warning?: string}}>}
 */
export async function writeSecrets(dataDir, patch) {
  const path = secretsFilePath(dataDir)
  if (!path) throw new Error('数据目录未知，无法保存密钥')

  // 先读旧值：既保留未提交字段（未来扩展），也在文件损坏时**报错而不是覆盖**。
  const current = await readSecrets(dataDir)
  const next = { ...current }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null || value === undefined || value === '') delete next[key]
    else next[key] = String(value)
  }

  if (Object.keys(next).length === 0) {
    await rm(path, { force: true })
    return { path, removed: true, permission: { ok: true } }
  }

  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.tmp-${process.pid}`
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  // 先给临时文件收紧权限，再 rename：rename 保留源文件 ACL。
  const permission = await hardenSecretsFile(tempPath)
  await rename(tempPath, path)
  // Windows 上 rename 可能带上临时名相关 ACE，落位后再收紧一次（幂等）。
  const finalPermission = await hardenSecretsFile(path)
  return {
    path,
    removed: false,
    permission: finalPermission.ok ? permission : finalPermission,
  }
}
