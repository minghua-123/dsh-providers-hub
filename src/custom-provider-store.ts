/**
 * 「自定义供应商」框架的配置存储、归一化、掩码与连通性/目录探活。
 *
 * 配置只存在**插件自身的 schemastery 配置**里：本文件不写
 * `llm-pi-ai.providers`，也不注册 `settings.models.provider-card` 槽。
 * `CustomProvidersSchema` 是设置页描述用的 schema；运行时的校验/归一化统一
 * 走 {@link normalizeCustomProviders}（读写两侧同一份判据，避免漂移）。
 *
 * ## 密钥纪律
 *
 * - 明文 `apiKey` 只在 `CustomProviderConfig` 内流动（请求头由协议层构造）；
 * - 回传 UI 走 {@link maskCustomProvider} / `CustomProviderRuntime`，**不含明文 key**；
 * - 探活结果里的服务端原文会先经 `scrubSecret` 擦掉可能回显的 key；
 * - 本文件不落盘、不写日志；`deps.warn` 只接收不含密钥的诊断文案。
 *
 * @module src/custom-provider-store.ts
 */

import Schema from '@deepseek-ai/schemastery'
import { errorDetailForClassify } from './openai-compat.js'
import {
  CUSTOM_PROVIDER_APIS,
  DEFAULT_CUSTOM_PROVIDER_API,
  isValidCustomProviderId,
  type CustomProviderApi,
  type CustomProviderConfig,
  type CustomProviderModel,
  type CustomProviderRuntime,
} from './custom-provider-types.js'
import {
  buildCustomRequest,
  classifyCustomHttpError,
  customAuthHeaders,
  joinCustomUrl,
  parseCustomBaseURL,
  resolveFetcher,
  type CustomProviderDeps,
} from './custom-provider-protocols.js'

// ───────────────────────────── schemastery schema ─────────────────────────────

const CustomProviderModelSchema = Schema.object({
  id: Schema.string(),
  name: Schema.string(),
  contextWindow: Schema.number().default(0),
  // 可选字段刻意不加 .default()：缺键保持 undefined，由 normalize 统一裁决。
  maxTokens: Schema.number(),
  reasoning: Schema.array(Schema.string()),
  attachment: Schema.boolean(),
})

const CustomProviderEntrySchema = Schema.object({
  id: Schema.string(),
  displayName: Schema.string(),
  // 用 Schema.string() 而非 union：取值合法性由 normalize 在读写两侧判，
  // schema 只负责类型（与 jet-hub-store.ts 的既有约定一致）。
  api: Schema.string().default(DEFAULT_CUSTOM_PROVIDER_API),
  baseURL: Schema.string(),
  apiKey: Schema.string().default(''),
  models: Schema.array(CustomProviderModelSchema).default([]),
  enabled: Schema.boolean().default(true),
})

/**
 * 插件配置节根形状：`{ providers: CustomProviderConfig[] }`。
 *
 * ⚠️ 一个数组字段的 object schema（而非裸数组），便于后续在同一节里追加
 * 其它键而不破坏已保存的配置。
 */
export const CustomProvidersSchema = Schema.object({
  providers: Schema.array(CustomProviderEntrySchema).default([]),
})

// ───────────────────────────── 归一化 ─────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

function normalizeModel(raw: unknown): CustomProviderModel | undefined {
  if (!isRecord(raw)) return undefined
  const id = safeString(raw.id).trim()
  if (id.length === 0) return undefined
  const nameRaw = safeString(raw.name).trim()
  const contextWindow = positiveInt(raw.contextWindow) ?? 0
  const model: CustomProviderModel = {
    id,
    name: nameRaw.length > 0 ? nameRaw : id,
    contextWindow,
  }
  const maxTokens = positiveInt(raw.maxTokens)
  if (maxTokens !== undefined) model.maxTokens = maxTokens
  if (Array.isArray(raw.reasoning)) {
    const efforts = raw.reasoning
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim())
    if (efforts.length > 0) model.reasoning = efforts
  }
  if (raw.attachment === true) model.attachment = true
  return model
}

/**
 * 单条配置的校验+规范化。返回 undefined 表示该条应被过滤掉。
 *
 * 过滤条件（与 `isValidCustomProviderId` / `parseCustomBaseURL` 共用判据）：
 * - id 不合 `^[a-z][a-z0-9]*$` 或撞保留 id；
 * - baseURL 非结构合法的 http(s) 绝对地址。
 */
function normalizeOne(raw: unknown): CustomProviderConfig | undefined {
  if (!isRecord(raw)) return undefined
  const id = safeString(raw.id).trim()
  if (!isValidCustomProviderId(id)) return undefined
  const parsedURL = parseCustomBaseURL(raw.baseURL)
  if (parsedURL === undefined) return undefined

  const displayName = safeString(raw.displayName).trim()
  const apiRaw = safeString(raw.api).trim()
  const api: CustomProviderApi = (CUSTOM_PROVIDER_APIS as readonly string[]).includes(apiRaw)
    ? (apiRaw as CustomProviderApi)
    : DEFAULT_CUSTOM_PROVIDER_API

  const models: CustomProviderModel[] = []
  const seenModels = new Set<string>()
  if (Array.isArray(raw.models)) {
    for (const entry of raw.models) {
      const model = normalizeModel(entry)
      if (model === undefined || seenModels.has(model.id)) continue
      seenModels.add(model.id)
      models.push(model)
    }
  }

  return {
    id,
    displayName: displayName.length > 0 ? displayName : id,
    api,
    // toString() 归一化大小写与末尾斜杠，但保留用户配置的路径前缀（如 /v1）。
    baseURL: parsedURL.toString().replace(/\/+$/, ''),
    // ⚠️ 密钥不做 trim/大小写改写：它是外部粘贴的凭据，静默改写会造出一把
    // 「看起来像但其实是另一把」的 Key。
    apiKey: safeString(raw.apiKey),
    models,
    // 缺键 / 非布尔值一律按启用；只有显式 false 才算停用。
    enabled: raw.enabled !== false,
  }
}

/**
 * 校验并规范化整份配置：去重、过滤非法 id / 畸形 baseURL、补齐缺省字段。
 *
 * 同时接受两种入参形状（兼容「整节对象」与「直接给数组」的调用方）：
 * `{ providers: [...] }` 或 `[...]`。其它形状返回空数组。
 */
export function normalizeCustomProviders(raw: unknown): CustomProviderConfig[] {
  let list: unknown[] = []
  if (Array.isArray(raw)) {
    list = raw
  } else if (isRecord(raw) && Array.isArray(raw.providers)) {
    list = raw.providers
  }
  const out: CustomProviderConfig[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    const config = normalizeOne(entry)
    if (config === undefined || seen.has(config.id)) continue
    seen.add(config.id)
    out.push(config)
  }
  return out
}

/** 新增或替换同 id 的配置（纯函数，返回新数组，不改入参）。 */
export function upsertCustomProvider(
  list: readonly CustomProviderConfig[],
  config: CustomProviderConfig,
): CustomProviderConfig[] {
  const normalized = normalizeOne(config)
  if (normalized === undefined) {
    throw new Error(
      `custom-provider: 配置非法（id 必须满足 ^[a-z][a-z0-9]*$、不撞保留 id，且 baseURL 为合法的 http(s) 地址）`,
    )
  }
  const out = list.filter((entry) => entry.id !== normalized.id)
  out.push(normalized)
  return out
}

/** 按 id 删除配置（纯函数）。 */
export function removeCustomProvider(
  list: readonly CustomProviderConfig[],
  id: string,
): CustomProviderConfig[] {
  return list.filter((entry) => entry.id !== id)
}

/** 密钥打码：`sk-abc...wxyz` → `sk-****wxyz`；短 key 全掩盖。 */
export function maskApiKey(key: string): string {
  if (key.length === 0) return ''
  if (key.length <= 8) return '********'
  return `${key.slice(0, 3)}****${key.slice(-4)}`
}

/**
 * 回传 UI 的运行时元数据（**不含明文 key**）。
 *
 * ⚠️ 保存时的往返语义：UI 拿到的 `apiKeyMasked` 不能写回配置。若用户未改动
 * 密钥，接线层应保留原值（例如把掩码串识别为「不变」），再调用
 * `upsertCustomProvider` 落盘。
 */
export function maskCustomProvider(
  list: readonly CustomProviderConfig[],
): CustomProviderRuntime[] {
  return normalizeCustomProviders(list).map((config) => ({
    id: config.id,
    displayName: config.displayName,
    api: config.api,
    baseURL: config.baseURL,
    enabled: config.enabled,
    modelCount: config.models.length,
    models: config.models.map((model) => ({ id: model.id, name: model.name })),
    apiKeyMasked: maskApiKey(config.apiKey),
    hasApiKey: config.apiKey.length > 0,
  }))
}

// ───────────────────────────── 探活与目录拉取 ─────────────────────────────

/** 把可能回显在错误体/异常里的明文 key 擦掉。 */
function scrubSecret(text: string, key: string): string {
  return key.length > 0 ? text.split(key).join('****') : text
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown error'
}

export interface CustomProviderTestResult {
  ok: boolean
  /** HTTP 状态码；请求根本没发出去时为 0。 */
  status: number
  /** 面向用户的明确文案，已擦除明文 key。 */
  message: string
}

/**
 * 真实发一次**最小** chat 请求验证连通性。
 *
 * - 未指定 modelId 时取配置里的第一个模型（无模型时用占位 id），
 *   单条 `ping` 用户消息、`maxTokens: 16`、`stream: false`，尽量少耗额度；
 *   `modelId` 由「单模型测试」传入，供应商级测试留空；
 * - `fetcher` 可注入便于单测；
 * - 不落盘、不写日志；服务端原文与异常信息都先经 `scrubSecret` 擦除 key。
 */
export async function testCustomProvider(
  config: CustomProviderConfig,
  deps: CustomProviderDeps = {},
  modelId?: string,
): Promise<CustomProviderTestResult> {
  const scrub = (text: string): string => scrubSecret(text, config.apiKey)
  try {
    const model = modelId?.trim() || config.models[0]?.id || 'custom-model'
    const request = await buildCustomRequest(
      config,
      {
        model,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 16,
        stream: false,
      },
      deps,
    )
    const response = await resolveFetcher(deps)(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    })
    if (response.ok) {
      return { ok: true, status: response.status, message: '连通性验证通过' }
    }
    const text = await response.text().catch(() => '')
    const code = classifyCustomHttpError(response.status, text)
    const detail = errorDetailForClassify(text).slice(0, 200)
    return {
      ok: false,
      status: response.status,
      message: scrub(
        `HTTP ${response.status}（${code}）：${detail.length > 0 ? detail : '(空响应体)'}`,
      ),
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: scrub(`请求失败：${safeErrorMessage(error)}`),
    }
  }
}

/**
 * 解析 OpenAI 兼容的 `GET /models` 响应体（`{ data: [{ id, ... }] }`）。
 *
 * 失败（形状不对 / 空目录）抛**明确**错误，由 `fetchRemoteModels` 转成结果对象，
 * 绝不静默吞掉返回一个空列表。
 */
export function parseRemoteModels(body: unknown): CustomProviderModel[] {
  const data = isRecord(body) ? body.data : undefined
  if (!Array.isArray(data)) {
    throw new Error('上游 /models 响应缺少 data 数组（非 OpenAI 兼容形态）')
  }
  const out: CustomProviderModel[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    if (!isRecord(raw)) continue
    const id = safeString(raw.id).trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const name = safeString(raw.name).trim()
    const model: CustomProviderModel = {
      id,
      name: name.length > 0 ? name : id,
      contextWindow: positiveInt(raw.context_window) ?? 0,
    }
    const maxTokens = positiveInt(raw.max_tokens) ?? positiveInt(raw.max_output_tokens)
    if (maxTokens !== undefined) model.maxTokens = maxTokens
    out.push(model)
  }
  if (out.length === 0) {
    throw new Error('上游 /models 未返回任何可用模型 id')
  }
  return out
}

export interface CustomRemoteModelsResult {
  ok: boolean
  status: number
  models: CustomProviderModel[]
  /** 失败时的明确原因（已擦除明文 key）。 */
  error?: string
}

/**
 * 拉 `{baseURL}/models`（OpenAI 兼容形态），供设置页「自动拉取模型」按钮用。
 *
 * - 三种协议共用 `customAuthHeaders`（Bearer / x-api-key 单一判据）；
 * - ⚠️ **已知限制**：`openai-responses` / `anthropic-messages` 的上游未必实现
 *   `/models`；此时会返回明确的 HTTP 错误，而不是静默给一个空列表；
 * - `fetcher` 可注入便于单测；失败一律返回 `{ ok:false, error }`，不抛给 UI。
 */
export async function fetchRemoteModels(
  config: CustomProviderConfig,
  deps: CustomProviderDeps = {},
): Promise<CustomRemoteModelsResult> {
  const scrub = (text: string): string => scrubSecret(text, config.apiKey)
  try {
    const url = joinCustomUrl(config.baseURL, 'models')
    const response = await resolveFetcher(deps)(url, {
      method: 'GET',
      headers: { ...customAuthHeaders(config), accept: 'application/json' },
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const code = classifyCustomHttpError(response.status, text)
      const detail = errorDetailForClassify(text).slice(0, 200)
      return {
        ok: false,
        status: response.status,
        models: [],
        error: scrub(
          `HTTP ${response.status}（${code}）：${detail.length > 0 ? detail : '(空响应体)'}`,
        ),
      }
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return {
        ok: false,
        status: response.status,
        models: [],
        error: '上游 /models 返回的不是合法 JSON',
      }
    }
    const models = parseRemoteModels(payload)
    return { ok: true, status: response.status, models }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      models: [],
      error: scrub(`拉取模型目录失败：${safeErrorMessage(error)}`),
    }
  }
}
