/**
 * OpenCode provider 的静态产品常量、编译期兜底模型表与错误分类。
 *
 * ## 定位
 *
 * 本模块只保存**不随网络变化**的常量与纯函数：
 * - 产品标识常量（供既有接线层显示与路由使用）；
 * - 一份**编译期**兜底免费模型表（仅在双源目录都不可达时使用）；
 * - 把本机 `opencode serve` 返回的 provider 错误对象归类为稳定错误码的纯函数。
 *
 * 本模块不读取配置、不发网络请求、不引用任何即将移除的直连时代模块。
 * 运行期模型目录由 `opencode-discovery.ts` 负责；对话代发由
 * `opencode-bridge.ts` 负责。
 *
 * @module src/opencode-product.ts
 */

/** 产品配置常量（供显示、路由、既有接线层读取，不参与推理请求构造）。 */
export interface OpencodeProduct {
  readonly id: 'opencode'
  readonly displayName: string
  readonly baseUrl: string
  readonly chatPath: string
  readonly modelsPath: string
  readonly chatHeaderTimeoutMs: number
  readonly chatChunkTimeoutMs: number
  readonly anonymousKey: string
  readonly defaultUserAgent: string
  readonly modelsDevUrl: string
  readonly modelsDevTtlMs: number
}

/**
 * 产品常量。
 *
 * 字段被 `index.ts` / `jet-hub-rpc.ts` / `backup.ts` 等既有接线层按名字读取，
 * 故保持形状稳定；其中与直连推理相关的地址字段仅作显示/兼容用途，新的
 * bridge-only 通路不会使用它们。
 */
export const OPENCODE: OpencodeProduct = {
  id: 'opencode',
  displayName: 'OpenCode',
  baseUrl: 'https://opencode.ai/inference',
  chatPath: '/v1/chat/completions',
  modelsPath: '/v1/models',
  chatHeaderTimeoutMs: 60_000,
  chatChunkTimeoutMs: 120_000,
  anonymousKey: 'public',
  defaultUserAgent: 'opencode/latest/2.1.1/cli',
  modelsDevUrl: 'https://models.dev/api.json',
  modelsDevTtlMs: 60 * 60 * 1000,
}

/** 编译期兜底表的采集日期（仅作文档标注，运行期不参与判定）。 */
export const OPENCODE_FALLBACK_DATE = '2026-11-07'

/** 兜底免费模型条目。 */
export interface OpencodeFallbackModel {
  readonly id: string
  readonly name: string
  readonly contextWindow: number
  readonly maxTokens: number
}

/**
 * 编译期兜底免费模型表。
 *
 * ⚠️ **仅在 Zen 目录与权威目录双源都不可达时使用**（冷启动且磁盘缓存为空）。
 * 它是保守下限，只保留长期稳定在供的免费文本模型；一旦任一远端源恢复，
 * 运行期目录（`discoverOpencodeModels`）即取代它。字段刻意保守：不声明
 *  reasoning / 图片能力，避免向未知上游下发它不接受的请求参数。
 *
 * 采集日期见 {@link OPENCODE_FALLBACK_DATE}。
 */
export const OPENCODE_FALLBACK_MODELS: readonly OpencodeFallbackModel[] = [
  { id: 'big-pickle', name: 'Big Pickle', contextWindow: 200_000, maxTokens: 8192 },
  { id: 'space-bunny-free', name: 'Space Bunny Free', contextWindow: 200_000, maxTokens: 8192 },
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', contextWindow: 200_000, maxTokens: 8192 },
  { id: 'glm-5.3-flash-free', name: 'GLM-5.3-Flash Free', contextWindow: 200_000, maxTokens: 8192 },
]

/** 本机桥返回的 provider 错误被归类后的稳定错误码。 */
export type OpencodeBridgeErrorCode =
  | 'RATE_LIMITED'
  | 'FREE_TIER_REFUSED'
  | 'UPGRADE_REQUIRED'
  | 'PROVIDER_ERROR'

/** `classifyOpencodeError` 的结构化输出。 */
export interface OpencodeClassifiedError {
  readonly code: OpencodeBridgeErrorCode
  /** 面向调用方的可读描述（不裸传 JSON）。 */
  readonly message: string
  /** 归一化后的 HTTP 状态（无则 0）。 */
  readonly status: number
  /** 服务端要求的等待时长（毫秒）；仅限流类产出。 */
  readonly retryAfterMs?: number
  /** 上游响应体截断片段（诊断用）。 */
  readonly detail?: string
}

/** 从任意对象里取一个有限正数（否则返回 undefined）。 */
function positiveNumber(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** 从 header 容器里读 `retry-after`（秒 → 毫秒）。 */
function retryAfterFromHeaders(headers: unknown): number | undefined {
  if (headers === null || typeof headers !== 'object') return undefined
  const bag = headers as Record<string, unknown>
  const getter = (bag as { get?: unknown }).get
  let raw: unknown
  if (typeof getter === 'function') {
    try {
      raw = (getter as (name: string) => unknown).call(bag, 'retry-after')
    } catch {
      raw = undefined
    }
  } else {
    raw = bag['retry-after'] ?? bag['Retry-After']
  }
  const seconds = positiveNumber(raw)
  return seconds === undefined ? undefined : Math.floor(seconds * 1000)
}

/** 把响应体片段截成诊断字符串。 */
function shortDetail(body: unknown): string | undefined {
  if (typeof body !== 'string' || body.trim().length === 0) return undefined
  return body.slice(0, 500)
}

/**
 * 把本机 `opencode serve` 的 provider 错误对象归类。
 *
 * ## 分类优先级（顺序即语义）
 *
 * | 判据 | 错误码 |
 * |---|---|
 * | `type === 'provider.free-limit'` 或 `status === 429` | `RATE_LIMITED` |
 * | `type === 'provider.upgrade'` 或 `status === 426` | `UPGRADE_REQUIRED` |
 * | `type === 'provider.auth'` 或 `status` 401/403 | `FREE_TIER_REFUSED` |
 * | 其余 | `PROVIDER_ERROR` |
 *
 * ⚠️ 免费档的失败**不体现在 HTTP 状态上**：`session.prompt` 返回 200，
 * 失败写在 idle 消息的 `error` 里。因此分类以错误对象里的 `type` / `status`
 * 为准，而不是 fetch 层看到的状态码。
 *
 * `retryAfterMs` 的取值顺序：`Retry-After` 响应头（秒，换算为毫秒）→
 * 错误体里的 `retryAfterMs`（毫秒）→ 缺省不产出。**0 不是合法等待值**。
 *
 * @param error provider 错误对象（形状宽松，来自不可信的本地客户端响应）。
 */
export function classifyOpencodeError(error: unknown): OpencodeClassifiedError {
  const obj: Record<string, unknown> = error !== null && typeof error === 'object'
    ? error as Record<string, unknown>
    : {}

  const type = typeof obj.type === 'string' ? obj.type : ''
  const rawStatus = Number(obj.status ?? obj.statusCode)
  // ⚠️ `LlmError` 只接受 100–599 的 HTTP 状态；越界值一律当「没有状态」，
  // 否则构造错误时反而会因校验抛异常、盖住真实原因。
  const status = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus
    : 0
  const response = obj.response !== null && typeof obj.response === 'object'
    ? obj.response as Record<string, unknown>
    : undefined
  const message = typeof obj.message === 'string' && obj.message.trim().length > 0
    ? obj.message
    : 'OpenCode 客户端返回错误'

  const headerMs = retryAfterFromHeaders(obj.headers)
  const bodyMs = positiveNumber(obj.retryAfterMs)
  const candidateMs = headerMs ?? (bodyMs === undefined ? undefined : Math.floor(bodyMs))
  // ⚠️ 0 不是合法等待值（LlmError 要求正数有限）；取整后为 0 就当缺失。
  const retryAfterMs = candidateMs !== undefined && candidateMs > 0 ? candidateMs : undefined
  const detail = shortDetail(response?.body ?? obj.body)

  let code: OpencodeBridgeErrorCode
  if (type === 'provider.free-limit' || status === 429) {
    code = 'RATE_LIMITED'
  } else if (type === 'provider.upgrade' || status === 426) {
    code = 'UPGRADE_REQUIRED'
  } else if (type === 'provider.auth' || status === 401 || status === 403) {
    code = 'FREE_TIER_REFUSED'
  } else {
    code = 'PROVIDER_ERROR'
  }

  return {
    code,
    message,
    status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(detail === undefined ? {} : { detail }),
  }
}
