/**
 * OpenCode 账户登录态入口的最小实现（**仅本机状态**）。
 *
 * ## 边界（硬约束）
 *
 * - 本模块**只读取/清理本机缓存目录里的状态文件**，不构造任何 OAuth URL、
 *   设备授权端点或令牌请求，也不发起任何网络交互。
 * - **token 不参与对话请求，登录态由本机客户端自身决定**。桥（
 *   `opencode-bridge.ts`）代发请求时不读取这里的 token；这里的状态仅用于
 *   设置页展示「是否曾在本机登记过账户」以及登录入口的开关。
 * - 另一个程序（OpenCode CLI）私有的 `auth.json` / `opencode.db` 不属于本模块
 *   的读写范围，本模块不触碰它们。
 *
 * 状态文件都落在本插件自己的缓存目录下，路径可注入以便单测隔离。
 *
 * @module src/opencode-account.ts
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 账户 token 快照文件名。 */
export const ACCOUNT_TOKEN_FILE = 'opencode-account-token.json'
/** 待轮询的设备授权状态文件名。 */
export const ACCOUNT_PENDING_FILE = 'opencode-account-pending.json'
/** 登录入口开关文件名。 */
export const ACCOUNT_ENABLED_FILE = 'opencode-account-enabled.json'

/** 账户登录态快照。 */
export interface OpencodeAccountStatus {
  /** 本机是否登记了未过期的账户 token（仅展示用，不参与对话请求）。 */
  loggedIn: boolean
  /** token 过期时间戳（毫秒）；0 表示未知/未登记。 */
  expiresAt: number
  /** 是否保存了 refresh token。 */
  hasRefresh: boolean
  /** 是否还有待完成的本地授权状态。 */
  pending: boolean
  /** 登录入口开关：关闭时入口不可用，且已存 token 不再算「已通过校验」。 */
  enabled: boolean
}

/** 账户状态读写的选项（路径与 IO 均可注入）。 */
export interface OpencodeAccountOptions {
  /** 缓存目录；缺省为本机用户缓存目录。 */
  dir?: string
  /** 注入的 JSON 读（便于单测，不碰真实磁盘）。 */
  readJson?: (path: string) => unknown
  /** 注入的 JSON 写（便于单测，不碰真实磁盘）。 */
  writeJson?: (path: string, value: unknown) => void
  /** 注入的文件删除（便于单测，不碰真实磁盘）。 */
  removeFile?: (path: string) => void
  /** 注入时钟（毫秒）；默认 `Date.now()`。 */
  now?: number
}

/** 默认缓存目录。 */
function defaultDir(): string {
  const fromEnv = String(process.env.DSH_HOME ?? '').trim()
  return fromEnv !== '' ? join(fromEnv, 'cache') : join(homedir(), '.dsh', 'cache')
}

/** 解析某个状态文件的绝对路径。 */
function fileFor(options: OpencodeAccountOptions, name: string): string {
  return join(options.dir ?? defaultDir(), name)
}

/** 默认 JSON 读（尽力而为，读不到返回 undefined）。 */
function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** 默认 JSON 写（失败绝不影响状态读取）。 */
function writeJsonFile(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8')
  } catch {
    // 缓存写不进去不能让状态查询失败。
  }
}

/** 默认文件删除（文件不存在是正常情况）。 */
function removeJsonFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // 已不存在。
  }
}

/** 把任意值当记录读一个字段。 */
function field(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined
  return (obj as Record<string, unknown>)[key]
}

/**
 * 读取本机账户登录态快照。
 *
 * 只读缓存目录里的三个状态文件，不做网络交互；`enabled` 缺省为 `true`
 * （开关文件缺失时视为开启）。
 */
export function readAccountStatus(options: OpencodeAccountOptions = {}): OpencodeAccountStatus {
  const readJson = options.readJson ?? readJsonFile
  const now = options.now ?? Date.now()

  const token = readJson(fileFor(options, ACCOUNT_TOKEN_FILE))
  const pending = readJson(fileFor(options, ACCOUNT_PENDING_FILE))
  const enabledRaw = readJson(fileFor(options, ACCOUNT_ENABLED_FILE))

  const accessToken = field(token, 'access_token')
  const refreshToken = field(token, 'refresh_token')
  const expiresRaw = Number(field(token, 'expires_at') ?? 0)
  const expiresAt = Number.isFinite(expiresRaw) && expiresRaw > 0 ? Math.trunc(expiresRaw) : 0

  const hasToken = typeof accessToken === 'string' && accessToken.length > 0
  // 没有过期时间时按「已登记」处理；有则必须晚于当前时刻。
  const loggedIn = hasToken && (expiresAt === 0 || expiresAt > now)
  const enabledValue = field(enabledRaw, 'enabled')
  // 开关文件本身也可能直接存一个布尔值。
  const enabled = typeof enabledValue === 'boolean'
    ? enabledValue
    : typeof enabledRaw === 'boolean' ? enabledRaw : true

  return {
    loggedIn,
    expiresAt,
    hasRefresh: typeof refreshToken === 'string' && refreshToken.length > 0,
    pending: pending !== null && typeof pending === 'object',
    enabled,
  }
}

/**
 * 清理本机账户登录态（登出）：删除 token 与待轮询状态文件。
 *
 * ⚠️ **开关（`enabled`）刻意保留**：关闭登录入口不应该等于删掉用户已登记的
 * 状态；重新打开后仍可显示。彻底清理由用户显式执行本函数完成。
 * token 不参与对话请求，故清理它也不会影响桥通路。
 */
export function clearAccountStatus(options: OpencodeAccountOptions = {}): void {
  const removeFile = options.removeFile ?? removeJsonFile
  removeFile(fileFor(options, ACCOUNT_TOKEN_FILE))
  removeFile(fileFor(options, ACCOUNT_PENDING_FILE))
}

/**
 * 设置登录入口开关（本机状态，纯本地写入，不涉及任何端点）。
 *
 * 关闭时入口不可用；已登记的 token 文件本身不删除，重新打开即可恢复。
 */
export function setAccountEnabled(enabled: boolean, options: OpencodeAccountOptions = {}): void {
  const writeJson = options.writeJson ?? writeJsonFile
  writeJson(fileFor(options, ACCOUNT_ENABLED_FILE), { enabled })
}
