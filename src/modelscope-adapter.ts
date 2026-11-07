/**
 * ModelScope（魔搭）LLM 适配器：标准 OpenAI 兼容协议的精简独立实现。
 *
 * - 协议：`POST {baseURL}/chat/completions`，`Authorization: Bearer <apiKey>`，
 *   请求体经 `buildModelscopePayload` 构造，工具按 `{type:'function', function:{…}}`
 *   包装。凭据为静态 API Key，由 `options.apiKey` 或 `setApiKey()` 注入，无 OAuth、
 *   无 refresh、无账号池。
 * - 目录：`GET {baseURL}/models` 可用时采信远端 id；窗口、模态、思考档在远端
 *   未给出时回落到 `MODELSCOPE_FALLBACK_MODELS`，并按日期快照 id 做前缀匹配。
 *   目录按 apiKey 分键缓存 5 分钟，失败静默回落到兜底表。
 * - 复用：消息序列化、图片引用收集、SSE 解帧、错误码映射与分类文本提取统一
 *   走 `openai-compat.ts`，本文件不另写序列化或解帧逻辑。
 * - 错误：语义分类沿用 `classifyModelscopeError`，按「类别 → 动作」表直接产出
 *   错误码与文案；额度类固定产出字面量 `'QUOTA_EXCEEDED'`，并避开会吞掉
 *   服务端原文的 `AUTH` 码。
 *
 * @module src/modelscope-adapter.ts
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import {
  MODELSCOPE,
  MODELSCOPE_FALLBACK_MODELS,
  classifyModelscopeError,
  findModelscopeFallback,
  type ModelscopeErrorKind,
  type ModelscopeProduct,
} from './modelscope-product.js'
import {
  modelscopeChatUrl,
  modelscopeHeaders,
  modelscopeModelsUrl,
  normalizeModelscopeModelId,
} from './modelscope.js'
import { buildModelscopePayload } from './modelscope-messages.js'
import {
  collectImages,
  consumeOpenAiSse,
  errorDetailForClassify,
  httpErrorCode,
  serializeMessages,
} from './openai-compat.js'
import {
  registerAdapterIdempotent,
  type AdapterRegisterTarget,
} from './llm-register-compat.js'

/** 目录条目（远端与兜底共用的输出形状）。 */
export interface ModelscopeCatalogEntry {
  id: string
  name: string
  contextWindow: number
  supportsImage: boolean
  efforts?: readonly string[]
}

/** 远端目录拉取（可注入离线实现）。 */
export type ModelscopeCatalogFetcher = (
  apiKey: string,
  signal?: AbortSignal,
) => Promise<Response>

/** 目录缓存 TTL（5 分钟）。 */
const DEFAULT_CATALOG_TTL_MS = 300_000

/**
 * 目录缓存按 apiKey 分键：不同 Key 可见的模型集合可能不同，共用一份缓存会让
 * 后注入的 Key 复用上一份结果。
 */
const catalogCache = new Map<string, { at: number; entries: readonly ModelscopeCatalogEntry[] }>()

/** 清空目录缓存（刷新目录与隔离用）。 */
export function clearModelscopeCatalogCache(): void {
  catalogCache.clear()
}

interface RawRemoteModel {
  id?: unknown
  name?: unknown
  context_window?: unknown
  limit?: { context?: unknown }
  modalities?: { input?: unknown }
}

/** 兜底表 → 目录条目。 */
function fallbackEntries(): readonly ModelscopeCatalogEntry[] {
  return MODELSCOPE_FALLBACK_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    supportsImage: m.supportsImage,
    ...m.efforts === undefined ? {} : { efforts: m.efforts },
  }))
}

/**
 * 解析 `GET /models` 的响应体。
 *
 * 远端常只下发 id 等基础字段，窗口、模态、思考档拿不到时一律回落到兜底表：
 * `contextWindow` 是自动压缩阈值的输入，未知时不编造数字（以 0 作哨兵）；
 * 图片能力只在远端明确列出或兜底表明确登记时才置真，未知按不支持处理。
 * id 可能带日期快照后缀，故兜底查询走 `findModelscopeFallback` 而非精确匹配。
 */
export function parseModelscopeCatalog(body: unknown): ModelscopeCatalogEntry[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const entries: ModelscopeCatalogEntry[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as RawRemoteModel
    const id = typeof record.id === 'string' ? normalizeModelscopeModelId(record.id) : ''
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const fallback = findModelscopeFallback(id)
    const name = typeof record.name === 'string' && record.name.trim().length > 0
      ? record.name.trim()
      : fallback?.name ?? id
    const remoteCtx = typeof record.context_window === 'number'
      ? record.context_window
      : typeof record.limit?.context === 'number' ? record.limit.context : 0
    const contextWindow = Number.isSafeInteger(remoteCtx) && remoteCtx > 0
      ? remoteCtx
      : fallback?.contextWindow ?? 0
    const remoteModalities = Array.isArray(record.modalities?.input)
      ? record.modalities.input.filter((v): v is string => typeof v === 'string')
      : undefined
    const supportsImage = remoteModalities === undefined
      ? fallback?.supportsImage ?? false
      : remoteModalities.includes('image')
    entries.push({
      id,
      name,
      contextWindow,
      supportsImage,
      ...fallback?.efforts === undefined ? {} : { efforts: fallback.efforts },
    })
  }
  return entries
}

/** 拉取远端目录，失败回退兜底表；命中 TTL 缓存时直接返回。 */
export async function loadModelscopeCatalog(
  fetchCatalog: ModelscopeCatalogFetcher,
  apiKey: string,
  ttlMs: number = DEFAULT_CATALOG_TTL_MS,
  signal?: AbortSignal,
): Promise<readonly ModelscopeCatalogEntry[]> {
  const cached = catalogCache.get(apiKey)
  if (cached !== undefined && ttlMs > 0 && Date.now() - cached.at < ttlMs) return cached.entries
  let entries: readonly ModelscopeCatalogEntry[]
  try {
    const response = await fetchCatalog(apiKey, signal)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const parsed = parseModelscopeCatalog(await response.json())
    if (parsed.length === 0) throw new Error('空目录')
    entries = parsed
  } catch {
    entries = fallbackEntries()
  }
  catalogCache.set(apiKey, { at: Date.now(), entries })
  return entries
}

/** 未注入远端拉取器时使用的默认实现，自带超时。 */
function defaultRemoteCatalog(product: ModelscopeProduct): ModelscopeCatalogFetcher {
  return (apiKey, signal) => fetch(modelscopeModelsUrl(product), {
    headers: modelscopeHeaders(apiKey, 'application/json'),
    signal: signal ?? AbortSignal.timeout(product.catalogTimeoutMs),
  })
}

export interface ModelscopeAdapterOptions {
  /** 静态 API Key；也可在注册后用 `setApiKey()` 注入。 */
  apiKey?: string
  /** 诊断日志。 */
  warn?: (message: string) => void
  /**
   * 附件字节读取。未注入时带图请求降级为文本占位，且目录不声明图片模态。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string }>
  /** 远端目录拉取；未注入时走带超时的默认实现。 */
  fetchRemoteCatalog?: ModelscopeCatalogFetcher
  /** 产品配置；默认 {@link MODELSCOPE}。 */
  product?: ModelscopeProduct
}

/** 取消/超时判据，避免把 AbortError 包成 TRANSPORT。 */
function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; code?: unknown }
  return candidate.name === 'AbortError' || candidate.code === 'ABORTED'
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/**
 * 「类别 → 错误码」表。
 *
 * 额度类必须使用字面量 `'QUOTA_EXCEEDED'`：harness 的额度常量取值为 `'QUOTA'`，
 * 客户端会丢弃适配器写入的 message 换成固定文案；`AUTH` 同样会吞掉服务端
 * 原文，故认证与兜底分支都避开它。5xx 等其余类别沿用 `httpErrorCode` 的产出。
 */
function errorCodeFor(kind: ModelscopeErrorKind, status: number): string {
  switch (kind) {
    case 'quota': return 'QUOTA_EXCEEDED'
    case 'rate_limit': return 'RATE_LIMIT'
    case 'invalid_request': return 'BAD_REQUEST'
    case 'context_window': return 'CONTEXT_WINDOW_EXCEEDED'
    case 'auth': return 'BAD_REQUEST'
    default: {
      const code = httpErrorCode(status)
      return code === 'AUTH' ? 'SERVER' : code
    }
  }
}

export class ModelscopeAdapter extends LlmAdapter {
  private readonly product: ModelscopeProduct
  private readonly options: ModelscopeAdapterOptions
  private apiKey: string
  /** 最近一次目录结果，供必须同步的 `listAllModels()` 读取。 */
  private lastCatalog?: readonly ModelscopeCatalogEntry[]

  constructor(options: ModelscopeAdapterOptions) {
    super()
    this.options = options
    this.product = options.product ?? MODELSCOPE
    this.apiKey = (options.apiKey ?? '').trim()
  }

  /** 注入/替换静态 API Key；一并丢弃本实例的同步目录快照。 */
  setApiKey(key: string): void {
    this.apiKey = key.trim()
    this.lastCatalog = undefined
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 同步全量目录（Jet Hub 的 `ModelCatalogSource` 契约）。
   *
   * 绝不可写成 async：消费者不 await，返回 Promise 会抛 `TypeError`。此处读
   * 上一轮缓存；缓存为空时返回兜底表并触发一次后台预热，下次调用即可拿到远端。
   */
  listAllModels(): readonly { id: string; name: string; isFree?: boolean }[] {
    const remote = this.lastCatalog
    if (remote !== undefined && remote.length > 0) {
      return remote.map((m) => ({ id: m.id, name: m.name }))
    }
    void this.warmCatalog()
    return MODELSCOPE_FALLBACK_MODELS.map((m) => ({ id: m.id, name: m.name }))
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const all = await this.catalog()
    return all.map((m) => this.toLlmModelInfo(m, provider))
  }

  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const id = normalizeModelscopeModelId(model)
    const all = await this.catalog()
    const entry = all.find((m) => m.id === id)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id,
      name: entry?.name ?? id,
      inputModalities: this.supportsImage(entry)
        ? (['text', 'image'] as const)
        : (['text'] as const),
    }
    // 窗口未知不编造：0 是「不知道」哨兵，下发会让自动压缩阈值计算报错。
    const contextWindow = entry?.contextWindow ?? 0
    if (contextWindow > 0) resolved.context = { contextWindow }
    // 档位为空时不声明 reasoning，避免出现无档位的空选择器。
    const efforts = entry?.efforts ?? []
    if (efforts.length > 0) {
      resolved.reasoning = {
        efforts: efforts.map((effort) => ({
          id: ReasoningEffortId(effort),
          name: effort === 'none' ? '关闭' : effort,
        })),
      }
    }
    // 刻意不声明 defaultMaxTokens：声明等于替用户决定每轮输出上限。
    return resolved
  }

  /** 包装层调的是 `call.stream`，故此处返回箭头绑定的 `stream`。 */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return { model: await this.resolveModel(provider, model, signal), stream: (o) => this.stream(o) }
  }

  /** 顶层 stream；生产路径经 `prepareCall().stream` 进来，两者共用一次请求实现。 */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamOnce(options)
  }

  /** 当前生效目录（远端优先，失败回退兜底）；TTL 缓存由 `loadModelscopeCatalog` 承担。 */
  private async catalog(): Promise<readonly ModelscopeCatalogEntry[]> {
    if (this.apiKey.length === 0) return fallbackEntries()
    const fetchCatalog = this.options.fetchRemoteCatalog ?? defaultRemoteCatalog(this.product)
    const entries = await loadModelscopeCatalog(fetchCatalog, this.apiKey)
    this.lastCatalog = entries
    return entries
  }

  private async warmCatalog(): Promise<void> {
    try { await this.catalog() } catch { /* 兜底表已保证目录可用 */ }
  }

  /**
   * 是否声明图片模态。只有目录明确登记支持图片、且附件读取服务已注入时才为真，
   * 避免在图片会被降级为文本占位的情况下仍对外声明视觉能力。
   */
  private supportsImage(entry: ModelscopeCatalogEntry | undefined): boolean {
    return entry?.supportsImage === true && this.options.readImage !== undefined
  }

  private toLlmModelInfo(m: ModelscopeCatalogEntry, provider: string): LlmModelInfo {
    return {
      provider,
      id: m.id,
      name: m.name,
      inputModalities: this.supportsImage(m)
        ? (['text', 'image'] as const)
        : (['text'] as const),
    }
  }

  /**
   * 解析消息里的图片附件为 data URL。
   *
   * 未注入 `readImage` 时返回空 Map 而非 undefined：序列化层据此把图片降级为
   * `[image unavailable]` 文本占位，既不静默丢图、也不谎报已读取字节。单张读取
   * 失败只跳过该 id，其余图片照常处理。
   */
  private async resolveImageUrls(
    messages: readonly { content: unknown }[],
  ): Promise<ReadonlyMap<string, string> | undefined> {
    const refs = new Map<string, unknown>()
    for (const message of messages) {
      if (Array.isArray(message.content)) collectImages(message.content, refs)
    }
    if (refs.size === 0) return undefined
    const readImage = this.options.readImage
    if (readImage === undefined) {
      this.options.warn?.('modelscope: 检测到图片输入，但未注入附件读取服务；图片将降级为文本占位')
      return new Map<string, string>()
    }
    const out = new Map<string, string>()
    for (const [id, ref] of refs) {
      try {
        const image = await readImage(ref)
        out.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      } catch {
        // 单张失败跳过，由序列化层补齐占位文本。
      }
    }
    return out
  }

  /** 单次请求：构造载荷、发起 POST、按类别处理 HTTP 失败、消费 SSE。 */
  private async *streamOnce(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.apiKey.length === 0) {
      throw new LlmError(
        'modelscope: 未配置 API Key，请在设置里填入访问令牌后重试',
        'MISSING_CREDENTIAL',
      )
    }
    const imageUrls = await this.resolveImageUrls(options.messages)
    const messages = serializeMessages(
      options.messages as readonly { role: string; content: unknown }[],
      imageUrls,
    )
    const payload = buildModelscopePayload({
      model: normalizeModelscopeModelId(options.model),
      messages,
      ...options.system !== undefined && options.system.length > 0 ? { system: options.system } : {},
      ...options.tools !== undefined ? { tools: options.tools } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
      ...options.reasoningEffort !== undefined
        ? { reasoningEffort: String(options.reasoningEffort) }
        : {},
    })

    let response: Response
    try {
      response = await fetch(modelscopeChatUrl(this.product), {
        method: 'POST',
        headers: modelscopeHeaders(this.apiKey, 'text/event-stream'),
        body: JSON.stringify(payload),
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error
      // 网络层失败保留原始原因，不伪装成额度或服务端错误。
      throw new LlmError(`modelscope: 请求发送失败 — ${safeErrorMessage(error)}`, 'TRANSPORT')
    }

    if (!response.ok) {
      // body 只能读一次，分类语义在响应体里，必须先读再分类。
      const text = await response.text().catch(() => '')
      throw this.httpFailure(response.status, text, response.headers)
    }
    // 风控页可能以 HTTP 200 + text/html 返回；交给 SSE 解帧会表现为空响应。
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      const peek = await response.text().catch(() => '')
      throw new LlmError(
        `modelscope: 上游未返回事件流（content-type: ${contentType || '(空)'}）。`
        + `${peek === '' ? '' : ` 服务端原文：${peek.slice(0, 200)}`}`,
        'SERVER',
        { status: response.status },
      )
    }
    yield* consumeOpenAiSse(
      response,
      options.signal !== undefined ? { signal: options.signal } : {},
      {
        label: 'modelscope',
        firstTokenTimeoutMs: this.product.chatHeaderTimeoutMs,
        chunkTimeoutMs: this.product.chunkTimeoutMs,
        ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
      },
    )
  }

  /**
   * 把一次失败的 HTTP 响应按语义映射为带明确文案的 `LlmError`。
   *
   * 分类输入走 `errorDetailForClassify`（排除展示专用的 detail 腿，避免加长
   * 输入翻转分类）；额度与限流给出冷却指引，400/422 直接判 BAD_REQUEST，
   * 5xx/其它保留服务端原文与原始状态码。
   */
  private httpFailure(status: number, body: string, headers: Headers): LlmError {
    const detail = errorDetailForClassify(body)
    const retryAfter = headers.get('retry-after')
    const info = classifyModelscopeError(
      status,
      detail,
      retryAfter === null ? undefined : { 'retry-after': retryAfter },
    )
    const cooldown = info.retryAfterMs !== undefined
      ? `服务端建议等待约 ${Math.ceil(info.retryAfterMs / 1000)} 秒后再试`
      : '请稍后再试'
    let message: string
    switch (info.kind) {
      case 'quota':
        message = `额度已用尽或达到当日调用上限，请更换 API Key 或等待额度重置；${cooldown}`
        break
      case 'rate_limit':
        message = `请求被限流，${cooldown}`
        break
      case 'invalid_request':
        message = '请求被上游拒绝（请求体形状或参数不合法）'
        break
      case 'context_window':
        message = '上下文超出模型上限'
        break
      case 'auth':
        message = 'API Key 无效或无权访问该模型，请检查或更换 API Key'
        break
      default:
        message = '上游请求失败'
    }
    return new LlmError(
      `modelscope: ${message}。服务端原文：${info.detail}`,
      errorCodeFor(info.kind, status),
      { status },
    )
  }
}

/** 从 ctx 或 llm 服务解析出注册目标。 */
function resolveRegisterTarget(llm: AdapterRegisterTarget | Context): AdapterRegisterTarget {
  const candidate = llm as AdapterRegisterTarget
  if (typeof candidate.registerAdapter === 'function') return candidate
  return (llm as Context).llm as unknown as AdapterRegisterTarget
}

/** 在 `ctx.llm` 上幂等注册 modelscope 单条路由。 */
export function registerModelscopeLlm(
  llm: AdapterRegisterTarget | Context,
  options: ModelscopeAdapterOptions,
): ModelscopeAdapter {
  const adapter = new ModelscopeAdapter(options)
  registerAdapterIdempotent(resolveRegisterTarget(llm), ['modelscope'], adapter, options.warn)
  return adapter
}
