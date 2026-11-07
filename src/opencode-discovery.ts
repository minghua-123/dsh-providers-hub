/**
 * OpenCode Zen 免费模型目录发现（双源合并 + 磁盘缓存）。
 *
 * ## 两个源，缺一不可
 *
 * - `https://opencode.ai/zen/v1/models`：返回**此刻在供**的模型 id 集合
 *   （`{ data: [{ id }] }`）。免费模型上下架频繁，只有 Zen 自己知道当前在供。
 * - `https://models.opencode.ai/api.json` 的 `opencode.models`：权威目录，
 *   给出免费判定（`cost.input === 0 && cost.output === 0`）、窗口、输出上限、
 *   reasoning / 工具 / 附件能力与弃用标记。不可达时回退 `models.dev/api.json`。
 *
 * 目录**只收录免费模型**，没有付费模型概念。Zen 的在供集合只决定
 * `available`，不决定成员资格：目录里免费但 Zen 已下架的条目保留为
 * `available: false`；Zen 在供但目录尚未收录、且 id 以 `-free` 结尾的也纳入。
 *
 * ## 失败策略
 *
 * - 任一源不可达时**沿用上次结论**（冷启动 `assumeAvailable`，见
 *   {@link discoverOpencodeModels}）；双源都不可达且磁盘缓存为空时才用
 *   编译期兜底表（在 {@link discoverOpencodeModels} 内合成，不在目录层硬编码）。
 * - 目录快照落盘，路径可注入（单测可指向临时文件或内存替身）。
 *
 * 本模块只发起**目录拉取**请求，绝不向 opencode.ai 发任何推理请求。
 *
 * @module src/opencode-discovery.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { OPENCODE_FALLBACK_MODELS } from './opencode-product.js'

/** Zen 在供模型端点根。 */
export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'
/** 权威目录。 */
export const CATALOG_URL = 'https://models.opencode.ai/api.json'
/** 权威目录不可达时的备用（同文档形状）。 */
export const CATALOG_FALLBACK_URL = 'https://models.dev/api.json'
/** 目录文档里 OpenCode provider 的键名。 */
export const PROVIDER_KEY = 'opencode'

/** 目录未给输出上限时的保守缺省。 */
const ASSUMED_OUTPUT_TOKENS = 8_192
/** 默认目录缓存文件名。 */
const DEFAULT_CACHE_FILE = 'opencode-zen-catalog.json'
/** 默认的单次目录拉取超时。 */
const DEFAULT_TIMEOUT_MS = 15_000
/** 目录发现的内存 TTL（默认 5 分钟）。 */
const DEFAULT_TTL_MS = 300_000

/** 归一后的模型目录记录。 */
export interface OpencodeModelRecord {
  id: string
  name: string
  description: string
  /** 上下文窗口（limit.context，缺省 200000）。 */
  contextWindow: number
  /** 单次输出上限（limit.output，缺省 8192）。 */
  maxTokens: number
  reasoning: boolean
  toolCall: boolean
  attachment: boolean
  deprecated: boolean
  /** 是否此刻在 Zen 在供集合里。 */
  available: boolean
  /** 记录来源：权威目录或 Zen 在供集合。 */
  source: 'catalog' | 'zen'
}

/** 手动添加的模型条目（形状宽松，来自配置）。 */
export interface OpencodeManualModel {
  id?: unknown
  name?: unknown
  contextWindow?: unknown
  [key: string]: unknown
}

/** `buildModelSet` 产出的适配器模型记录。 */
export interface OpencodeServeModel {
  id: string
  name: string
  description: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  toolCall: boolean
}

/** `describeCatalog` 产出的展示行。 */
export interface OpencodeCatalogRow {
  id: string
  name: string
  description: string
  source: 'catalog' | 'zen' | 'manual'
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  toolCall: boolean
  attachment: boolean
  disabled: boolean
  unavailable: boolean
  reason: string
}

/** 磁盘缓存文件里保存的形状。 */
export interface OpencodeCatalogCache {
  savedAt: number
  catalog: readonly OpencodeModelRecord[]
}

/** 把任意值收敛到 [min,max] 内的整数，否则用 fallback。 */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** limit 对象里取一个正数整数。 */
function limitNumber(limit: unknown, key: string, fallback: number): number {
  const bag = limit !== null && typeof limit === 'object' ? limit as Record<string, unknown> : {}
  const value = Number(bag[key])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** 免费判定：cost 缺失不算免费。 */
function isFree(entry: Record<string, unknown>): boolean {
  const cost = entry.cost
  if (cost === undefined || cost === null || typeof cost !== 'object') return false
  const bag = cost as Record<string, unknown>
  return Number(bag.input ?? 1) === 0 && Number(bag.output ?? 1) === 0
}

/** `fetchZenModelIds` / `fetchJson` 的可注入取数器（便于单测离线）。 */
export type ZenFetcher = (url: string, timeoutMs: number) => Promise<unknown>

/**
 * 拉取并解码一份 JSON 文档（带超时）。
 *
 * @throws Error 命名失败原因，供上层记录原文。
 */
export async function fetchJson(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(clampInt(timeoutMs, 1000, 120_000, DEFAULT_TIMEOUT_MS)),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
  return await response.json() as unknown
}

/**
 * 取「此刻在供」的 Zen 模型 id 集合。
 *
 * @param baseURL  Zen 根地址，默认 {@link ZEN_BASE_URL}。
 * @param timeoutMs 单次请求超时。
 * @param fetcher  可注入的 JSON 取数器（默认 {@link fetchJson}）。
 */
export async function fetchZenModelIds(
  baseURL: string = ZEN_BASE_URL,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  fetcher: ZenFetcher = fetchJson,
): Promise<Set<string>> {
  const url = `${String(baseURL).replace(/\/+$/, '')}/models`
  const payload = await fetcher(url, timeoutMs)
  const rows = payload !== null && typeof payload === 'object'
    ? (payload as { data?: unknown }).data
    : undefined
  if (!Array.isArray(rows)) return new Set<string>()
  const ids = new Set<string>()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = (row as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0) ids.add(id)
  }
  return ids
}

/** `mergeCatalog` 的选项。 */
export interface MergeCatalogOptions {
  /** 目录未给窗口时的缺省。 */
  defaultContextWindow?: number
  /** Zen 不可达且无上次结论时，把所有免费条目视为在供。 */
  assumeAvailable?: boolean
}

/**
 * 合并双源，产出归一化的免费模型目录。
 *
 * @param modelsDev 权威目录文档（`api.json` 解码后的对象）。
 * @param zenIds    Zen 此刻在供 id 集合；`undefined` 表示 Zen 不可达。
 * @param options   缺省窗口与 `assumeAvailable`。
 */
export function mergeCatalog(
  modelsDev: unknown,
  zenIds: Set<string> | readonly string[] | undefined,
  options: MergeCatalogOptions = {},
): OpencodeModelRecord[] {
  const fallbackContext = clampInt(options.defaultContextWindow, 1_000, 10_000_000, 200_000)
  const zenKnown = zenIds !== undefined && zenIds !== null
  const served: Set<string> = zenIds instanceof Set ? zenIds : new Set(zenIds ?? [])
  const assumeAvailable = options.assumeAvailable === true || !zenKnown
  const isServed = (id: string): boolean => assumeAvailable || served.has(id)

  const root = modelsDev !== null && typeof modelsDev === 'object'
    ? modelsDev as Record<string, unknown>
    : {}
  const block = root[PROVIDER_KEY]
  const table = block !== null && typeof block === 'object'
    ? (block as { models?: unknown }).models
    : undefined
  const records = new Map<string, OpencodeModelRecord>()

  if (table !== null && typeof table === 'object') {
    for (const raw of Object.values(table as Record<string, unknown>)) {
      if (raw === null || typeof raw !== 'object') continue
      const entry = raw as Record<string, unknown>
      if (!isFree(entry)) continue
      const id = typeof entry.id === 'string' ? entry.id.trim() : ''
      if (id === '') continue
      const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id
      records.set(id, {
        id,
        name,
        description: typeof entry.description === 'string' ? entry.description.slice(0, 400) : '',
        contextWindow: limitNumber(entry.limit, 'context', fallbackContext),
        maxTokens: limitNumber(entry.limit, 'output', ASSUMED_OUTPUT_TOKENS),
        reasoning: entry.reasoning === true,
        toolCall: entry.tool_call !== false,
        attachment: entry.attachment === true,
        deprecated: entry.status === 'deprecated',
        available: isServed(id),
        source: 'catalog',
      })
    }
  }

  // Zen 在供但目录尚未收录的 `-free` 模型：按 id 纳入，字段一律保守。
  for (const id of served) {
    if (records.has(id) || !id.endsWith('-free')) continue
    records.set(id, {
      id,
      name: id,
      description: 'OpenCode Zen 免费档（目录尚未收录）',
      contextWindow: fallbackContext,
      maxTokens: ASSUMED_OUTPUT_TOKENS,
      reasoning: false,
      toolCall: true,
      attachment: false,
      deprecated: false,
      available: true,
      source: 'zen',
    })
  }

  return [...records.values()].sort((a, b) => {
    if (a.deprecated !== b.deprecated) return a.deprecated ? 1 : -1
    return a.id.localeCompare(b.id)
  })
}

/** `serveableModels` 的选项。 */
export interface ServeableOptions {
  includeDeprecated?: boolean
}

/** 适配器实际承接的子集：在供且未弃用。 */
export function serveableModels(
  catalog: readonly OpencodeModelRecord[] | undefined,
  options: ServeableOptions = {},
): OpencodeModelRecord[] {
  const rows = Array.isArray(catalog) ? catalog : []
  return rows
    .filter((entry) => entry && entry.available !== false)
    .filter((entry) => options.includeDeprecated === true || entry.deprecated !== true)
}

/** `buildModelSet` / `describeCatalog` 的选项。 */
export interface ModelSetOptions {
  defaultContextWindow?: number
  defaultMaxTokens?: number
  includeDeprecated?: boolean
}

/**
 * 把目录与 `manualModels` / `disabledModels` 折成适配器模型集。
 *
 * 目录在前、手动条目置顶叠加；`available: false` / `unavailable: true`
 * 与停用列表都过滤掉。弃用判定由上游 `serveableModels` 完成，此处不再
 * 二次应用（避免覆盖 `includeDeprecated` 开关）。
 */
export function buildModelSet(
  catalog: readonly OpencodeModelRecord[] | readonly OpencodeCatalogRow[] | undefined,
  manual: readonly OpencodeManualModel[] | undefined,
  disabled: readonly string[] | undefined,
  options: ModelSetOptions = {},
): OpencodeServeModel[] {
  const off = new Set((Array.isArray(disabled) ? disabled : []).filter((id): id is string => typeof id === 'string'))
  const fallbackContext = clampInt(options.defaultContextWindow, 1_000, 10_000_000, 200_000)
  const fallbackMax = clampInt(options.defaultMaxTokens, 1_000, 10_000_000, 32_000)
  const seen = new Map<string, OpencodeServeModel>()

  for (const entry of Array.isArray(catalog) ? catalog : []) {
    const row = entry as Partial<OpencodeModelRecord & OpencodeCatalogRow>
    if (row === null || typeof row !== 'object' || typeof row.id !== 'string' || row.id === '') continue
    if (off.has(row.id) || seen.has(row.id)) continue
    if (row.available === false || row.unavailable === true) continue
    seen.set(row.id, {
      id: row.id,
      name: row.name || row.id,
      description: row.description || 'OpenCode Zen 免费档',
      contextWindow: clampInt(row.contextWindow, 1_000, 10_000_000, fallbackContext),
      maxTokens: clampInt(row.maxTokens, 1_000, 10_000_000, fallbackMax),
      reasoning: row.reasoning === true,
      toolCall: row.toolCall !== false,
    })
  }

  for (const entry of Array.isArray(manual) ? manual : []) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '' || off.has(id) || seen.has(id)) continue
    const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id
    seen.set(id, {
      id,
      name,
      description: '手动添加的 OpenCode Zen 模型',
      contextWindow: clampInt(entry.contextWindow, 1_000, 10_000_000, fallbackContext),
      maxTokens: fallbackMax,
      reasoning: true,
      toolCall: true,
    })
  }

  return [...seen.values()]
}

/**
 * 设置页展示行：每个目录条目都标注为何不可承接。
 *
 * 默认隐藏「弃用」与「Zen 已下架」两类；`includeDeprecated` 打开后都列出，
 * 但下架条目仍标 `unavailable`（可见不可调用）。
 */
export function describeCatalog(
  catalog: readonly OpencodeModelRecord[] | undefined,
  manual: readonly OpencodeManualModel[] | undefined,
  disabled: readonly string[] | undefined,
  options: ModelSetOptions = {},
): OpencodeCatalogRow[] {
  const off = new Set((Array.isArray(disabled) ? disabled : []).filter((id): id is string => typeof id === 'string'))
  const includeDeprecated = options.includeDeprecated === true
  const listed: OpencodeCatalogRow[] = []

  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id === '') continue
    if ((entry.deprecated === true || entry.available === false) && !includeDeprecated) continue
    const reason = entry.deprecated === true
      ? '目录标记为已弃用'
      : (entry.available === false ? 'Zen 已下架' : '')
    listed.push({
      id: entry.id,
      name: entry.name || entry.id,
      description: entry.description || '',
      source: entry.source === 'zen' ? 'zen' : 'catalog',
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      reasoning: entry.reasoning === true,
      toolCall: entry.toolCall !== false,
      attachment: entry.attachment === true,
      disabled: off.has(entry.id),
      unavailable: entry.available === false,
      reason,
    })
  }

  for (const entry of Array.isArray(manual) ? manual : []) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '') continue
    const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id
    listed.push({
      id,
      name,
      description: '手动添加的 OpenCode Zen 模型',
      source: 'manual',
      contextWindow: clampInt(entry.contextWindow, 1_000, 10_000_000, 200_000),
      maxTokens: 0,
      reasoning: true,
      toolCall: true,
      attachment: false,
      disabled: off.has(id),
      unavailable: false,
      reason: '',
    })
  }

  return listed
}

/** `discoverOpencodeModels` 的选项。 */
export interface DiscoverOpencodeModelsOptions {
  zenBaseUrl?: string
  catalogUrl?: string
  catalogFallbackUrl?: string
  timeoutMs?: number
  defaultContextWindow?: number
  /** 目录缓存落盘路径（可注入，便于单测）。 */
  cachePath?: string
  /** 注入的 JSON 取数器（便于单测离线）。 */
  fetchJson?: ZenFetcher
  /** 注入的缓存读（便于单测，不碰真实磁盘）。 */
  readCache?: (path: string) => unknown
  /** 注入的缓存写（便于单测，不碰真实磁盘）。 */
  writeCache?: (path: string, value: OpencodeCatalogCache) => void
  /** 跳过内存 TTL 强制刷新。 */
  force?: boolean
  /** 内存 TTL（毫秒）。 */
  ttlMs?: number
}

/** `discoverOpencodeModels` 的结果。 */
export interface OpencodeDiscoveryResult {
  catalog: readonly OpencodeModelRecord[]
  /** 结论的取得方式。 */
  reason: 'fresh' | 'partial-zen' | 'partial-catalog' | 'cache' | 'fallback'
  syncedAt: number
  /** 冷启动且 Zen 不可达时置 true。 */
  assumeAvailable: boolean
  /** 任一源失败的可读描述。 */
  error?: string
}

/** 默认缓存路径（本机用户缓存目录）。 */
function defaultCachePath(): string {
  const fromEnv = String(process.env.DSH_HOME ?? '').trim()
  const base = fromEnv !== '' ? join(fromEnv, 'cache') : join(homedir(), '.dsh', 'cache')
  return join(base, DEFAULT_CACHE_FILE)
}

/** 读磁盘缓存（尽力而为，读不到返回 undefined）。 */
function readDiskCache(path: string): OpencodeCatalogCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as OpencodeCatalogCache
    if (Array.isArray(parsed?.catalog)) return parsed
  } catch {
    // 缓存不存在/损坏是正常情况。
  }
  return undefined
}

/** 写磁盘缓存（失败绝不影响请求）。 */
function writeDiskCache(path: string, value: OpencodeCatalogCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8')
  } catch {
    // 缓存写不进去不能让目录发现失败。
  }
}

/** 判定任意值是否为合法的缓存文件形状。 */
function isCatalogCache(value: unknown): value is OpencodeCatalogCache {
  return value !== null && typeof value === 'object'
    && Array.isArray((value as OpencodeCatalogCache).catalog)
}

/** 进程内目录快照，按缓存路径分桶，避免不同注入路径互相污染。 */
const memory = new Map<string, { catalog: readonly OpencodeModelRecord[]; syncedAt: number }>()
/** 并发刷新共享同一个 Promise，按缓存路径分桶。 */
const inFlight = new Map<string, Promise<OpencodeDiscoveryResult>>()

/** 把编译期兜底表合成 zen 来源的目录记录（仅双源都不可达时使用）。 */
function fallbackCatalog(): OpencodeModelRecord[] {
  return OPENCODE_FALLBACK_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    description: '编译期兜底免费模型（双源目录均不可达）',
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    reasoning: false,
    toolCall: true,
    attachment: false,
    deprecated: false,
    available: true,
    source: 'zen' as const,
  }))
}

/**
 * orchestrate 双源目录发现，带磁盘缓存与「失败沿用上次结论」。
 *
 * 分支语义：
 * - 双源都成功 → `fresh`；
 * - Zen 成功、目录失败 → 沿用上次结论（`partial-catalog`）；
 * - 目录成功、Zen 失败 → 携带上次可用性重新合并（`partial-zen`）；
 * - 双源都失败 → 沿用上次结论（`cache`）；冷启动则用编译期兜底表（`fallback`）。
 *
 * 并发调用共享同一次刷新（按缓存路径分桶）。
 */
export async function discoverOpencodeModels(
  options: DiscoverOpencodeModelsOptions = {},
): Promise<OpencodeDiscoveryResult> {
  const cachePath = options.cachePath ?? defaultCachePath()
  const ttlMs = clampInt(options.ttlMs, 0, 86_400_000, DEFAULT_TTL_MS)

  const cached = memory.get(cachePath)
  if (!options.force && cached !== undefined && ttlMs > 0 && Date.now() - cached.syncedAt < ttlMs) {
    return { catalog: cached.catalog, reason: 'cache', syncedAt: cached.syncedAt, assumeAvailable: false }
  }

  const pending = inFlight.get(cachePath)
  if (pending !== undefined) return await pending

  const task = runDiscovery(options, cachePath).finally(() => { inFlight.delete(cachePath) })
  inFlight.set(cachePath, task)
  return await task
}

async function runDiscovery(
  options: DiscoverOpencodeModelsOptions,
  cachePath: string,
): Promise<OpencodeDiscoveryResult> {
  const timeoutMs = clampInt(options.timeoutMs, 1000, 120_000, DEFAULT_TIMEOUT_MS)
  const fetcher: ZenFetcher = options.fetchJson ?? fetchJson
  const readCache: (path: string) => unknown = options.readCache ?? readDiskCache
  const writeCache: (path: string, value: OpencodeCatalogCache) => void = options.writeCache ?? writeDiskCache
  const zenBaseUrl = options.zenBaseUrl ?? ZEN_BASE_URL
  const catalogUrl = options.catalogUrl ?? CATALOG_URL
  const catalogFallbackUrl = options.catalogFallbackUrl ?? CATALOG_FALLBACK_URL
  const defaultContextWindow = options.defaultContextWindow

  const diskRaw = readCache(cachePath)
  const disk = isCatalogCache(diskRaw) ? diskRaw : undefined
  const lastKnown = memory.get(cachePath)?.catalog ?? disk?.catalog ?? []

  const adopt = (
    catalog: readonly OpencodeModelRecord[],
    reason: OpencodeDiscoveryResult['reason'],
    assumeAvailable: boolean,
    error?: string,
  ): OpencodeDiscoveryResult => {
    const syncedAt = Date.now()
    memory.set(cachePath, { catalog, syncedAt })
    writeCache(cachePath, { savedAt: syncedAt, catalog })
    return {
      catalog,
      reason,
      syncedAt,
      assumeAvailable,
      ...(error === undefined ? {} : { error }),
    }
  }

  // 1) Zen 在供集合。
  let zenIds: Set<string> | undefined
  let zenError = ''
  try {
    zenIds = await fetchZenModelIds(zenBaseUrl, timeoutMs, fetcher)
  } catch (error) {
    zenError = error instanceof Error ? error.message : String(error)
  }

  // 2) 权威目录（含备用源回退）。
  let modelsDev: unknown
  let catalogError = ''
  try {
    modelsDev = await fetcher(catalogUrl, timeoutMs)
  } catch (error) {
    catalogError = error instanceof Error ? error.message : String(error)
    if (String(catalogUrl) !== String(catalogFallbackUrl)) {
      try {
        modelsDev = await fetcher(catalogFallbackUrl, timeoutMs)
        catalogError = ''
      } catch (fallbackError) {
        const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        catalogError += ` · 备用目录: ${detail}`
      }
    }
  }

  // 3) 双源都失败：沿用上次结论；冷启动用编译期兜底表。
  if (zenError !== '' && catalogError !== '') {
    const error = `Zen: ${zenError} · 目录: ${catalogError}`
    if (lastKnown.length > 0) {
      return {
        catalog: lastKnown,
        reason: 'cache',
        syncedAt: memory.get(cachePath)?.syncedAt ?? Date.now(),
        assumeAvailable: false,
        error,
      }
    }
    return adopt(fallbackCatalog(), 'fallback', true, error)
  }

  // 4) 只有目录成功：携带上次可用性；冷启动 assumeAvailable。
  if (zenIds === undefined) {
    const previous = new Set(
      lastKnown.filter((m) => m.available !== false).map((m) => m.id),
    )
    const coldStart = previous.size === 0
    const merged = mergeCatalog(modelsDev, previous, {
      ...(defaultContextWindow === undefined ? {} : { defaultContextWindow }),
      assumeAvailable: coldStart,
    })
    return adopt(merged, 'partial-zen', coldStart, `Zen 不可达（${zenError}）`)
  }

  // 5) 只有 Zen 成功：目录失败，沿用上次结论。
  if (modelsDev === undefined) {
    return {
      catalog: lastKnown,
      reason: 'partial-catalog',
      syncedAt: memory.get(cachePath)?.syncedAt ?? Date.now(),
      assumeAvailable: false,
      error: `目录: ${catalogError}`,
    }
  }

  // 6) 双源都成功。
  const merged = mergeCatalog(modelsDev, zenIds, {
    ...(defaultContextWindow === undefined ? {} : { defaultContextWindow }),
  })
  return adopt(merged, 'fresh', false)
}
