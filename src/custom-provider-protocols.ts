/**
 * 「自定义供应商」框架的 wire 协议层：请求构造 + SSE 消费 + 错误归类。
 *
 * ## 三种协议的统一入口
 *
 * - {@link buildCustomRequest}：`(config, options, deps) → { url, headers, body }`；
 * - {@link consumeCustomResponse}：`(api, response, options, deps) → AsyncIterable<StreamChunk>`。
 *
 * ## 共用前置归一化（重要）
 *
 * 三种协议**共用同一份消息序列化前端**：`openai-compat.ts` 的
 * `serializeMessages`。它内部先跑 `message-shape.ts` 的
 * `normalizeHarnessMessages`（把 0.1.7 的一等 `role:'tool'` 消息降级为包裹块、
 * 剥离 `developer`），再做工具配对剔除、内嵌图片提升、正文清洗。
 *
 * ⚠️ 因此本文件**不重写第二份 Chat Completions 序列化器**：
 * - `openai-completions` 直接把 `serializeMessages` 的产物作为 `messages`；
 * - `openai-responses` / `anthropic-messages` 把同一份 OpenAI chat wire 作为
 *   **中性中间表示**，再投影成各自的 `input` / `messages` 形状。
 *
 * 这样三种协议的工具/工具结果形状、孤儿调用剔除、图片降级行为完全一致，
 * 不会出现「改了一处、另一处漂移」。
 *
 * ## 图片策略（不假装支持）
 *
 * 仅当模型显式声明 `attachment === true` **且** 接线层注入了 `readImage`
 * 时，才解析附件字节并下发真实图片：
 * - `openai-completions` / `openai-responses`：`image_url` data URL；
 * - `anthropic-messages`：`source: { type:'base64', ... }`。
 *
 * 其余情况一律传**空 Map** 给 `serializeMessages` —— 它会把每个图片块明确
 * 降级为文本占位 `[image unavailable]`，而不是静默丢弃，也不会把图片能力
 * 写进 `inputModalities`。绝不在拿不到字节时声称支持图片。
 *
 * ## 三种协议的能力与限制（逐条）
 *
 * ### 1. `openai-completions`（默认）
 * - `POST {baseURL}/chat/completions`，`Authorization: Bearer <key>`；
 * - 工具声明 → `tools[].function.{name,description,parameters}`；
 * - `stream:true` 时附带 `stream_options.include_usage`（部分严格兼容服务端
 *   可能拒收该扩展字段，属已知限制）；
 * - `reasoningEffort` 透传为非标准扩展 `reasoning_effort`（尽力而为，上游可忽略/拒收）；
 * - SSE 直接复用 `consumeOpenAiSse`（含 usage / finish_reason / 分片合并 / 截断判定）。
 *
 * ### 2. `openai-responses`
 * - `POST {baseURL}/responses`；
 * - system/developer → 顶层 `instructions`；其余消息 → `input` 项；
 * - **工具调用**：assistant 的 `tool_calls` 拆成顶层 `{type:'function_call',
 *   call_id,name,arguments}` 项；工具结果拆成 `{type:'function_call_output',
 *   call_id,output}` 项（不是塞进 message content）；
 * - **推理档位**：`reasoningEffort` → `reasoning.effort`，原值透传（合法档位由
 *   上游判定）；历史里的 `reasoning_content` **不回传**（Responses 的历史推理项
 *   需要服务端加密内容，本框架无等价物，故丢弃，与网关侧同口径）；
 * - **已知限制**：Responses 没有 `stop` 字段，`options.stop` 不映射；非 data URL
 *   的内联图片按 `input_image.image_url` 下发，是否被上游接受取决于服务端；
 * - SSE 消费 `response.output_text.delta` / `response.reasoning_*_delta` /
 *   `response.function_call_arguments.delta|done` / `response.completed` /
 *   `response.incomplete` / `response.failed` / `error`。
 *
 * ### 3. `anthropic-messages`
 * - `POST {baseURL}/messages`，头 `x-api-key` + `anthropic-version: 2023-06-01`；
 * - system/developer → 顶层 `system`；其余消息 → `messages`；
 * - **工具调用**：assistant 的 `tool_calls` → `content[].tool_use`
 *   （`input` 是**对象**，由 JSON 字符串解析；残缺 JSON 用哨兵对象保留，
 *   不补 `{}` 以免伪造出合法外观）；工具结果合并进紧随其后的 `role:'user'`
 *   的 `tool_result` 块（Anthropic 没有独立的 `tool` 角色）；
 * - 工具声明 → `tools[].{name,description,input_schema}`（扁平）；
 * - `max_tokens` 必填：`options.maxTokens ?? model.maxTokens ?? 4096`；
 * - **已知限制**：Anthropic 没有推理档位旋钮，`reasoningEffort` 不映射；
 *   历史里 assistant 的 `reasoning_content` 丢弃（thinking 块需签名，不可回放）；
 * - SSE 消费 `content_block_start` / `content_block_delta`（`text_delta` /
 *   `thinking_delta` / `input_json_delta`）/ `message_delta` / `message_stop` /
 *   `error`，**没有** `data: [DONE]`。
 *
 * ## 错误路径（不静默丢轮）
 *
 * - 非 2xx：读体 → {@link classifyCustomHttpError} 归类 → 抛 `LlmError`，
 *   额度/欠类一律**字面量 `'QUOTA_EXCEEDED'`**（不能用 `httpErrorCode(401)`
 *   得到的 `AUTH`，那会让客户端把服务端原文吞掉）；
 * - 200 + 非 `text/event-stream`：显式抛 `SERVER`（常见于风控拦截页）；
 * - 流内 `error` / `response.failed`：显式抛 `LlmError`，带上游文案；
 * - 全程零内容块：抛 `EMPTY_RESPONSE`，不静默以 `stop` 结束；
 * - 三类 SSE 都按「usage 在 finish 之前、finish 之后不发任何 chunk」的契约收尾。
 *
 * @module src/custom-provider-protocols.ts
 */

import { LlmError, ToolCallId, attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  collectImages,
  consumeOpenAiSse,
  contentToText,
  errorDetail,
  errorDetailForClassify,
  httpErrorCode,
  serializeMessages,
} from './openai-compat.js'
import {
  CUSTOM_PROVIDER_APIS,
  DEFAULT_CUSTOM_PROVIDER_API,
  type CustomProviderApi,
  type CustomProviderConfig,
  type CustomProviderModel,
} from './custom-provider-types.js'

// ───────────────────────────── 依赖注入形状 ─────────────────────────────

/** 可注入的 fetch（便于单测离线）。缺省用全局 `fetch`。 */
export interface CustomFetchInit {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export type CustomFetcher = (url: string, init: CustomFetchInit) => Promise<Response>

/** 把 harness 图片附件引用解析为字节；返回 undefined 表示该图不可解析。 */
export type CustomImageReader = (
  ref: unknown,
) => Promise<{ mediaType: string; data: Uint8Array } | undefined>

/** 三种协议共用的可注入依赖。 */
export interface CustomProviderDeps {
  fetcher?: CustomFetcher
  /** 图片字节解析器；不注入时图片一律降级为文本。 */
  readImage?: CustomImageReader
  warn?: (message: string) => void
  /** `consumeOpenAiSse` 的首 token 空闲超时（毫秒）。 */
  firstTokenTimeoutMs?: number
  /** `consumeOpenAiSse` 的 chunk 间空闲超时（毫秒）。 */
  chunkTimeoutMs?: number
}

/** 工具 schema 的最小形状（`GenerateOptions.tools` 可结构化赋值）。 */
export interface CustomToolSchema {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

/** `buildCustomRequest` 的消息入参（`GenerateOptions.messages` 可结构化赋值）。 */
export interface CustomCallMessage {
  role: string
  content: unknown
}

/** `buildCustomRequest` 的调用入参。 */
export interface CustomCallOptions {
  model: string
  messages: readonly CustomCallMessage[]
  /** 一次性调用的系统提示；循环构建的请求把它放在 `messages[0]`，此处为 undefined。 */
  system?: string
  tools?: readonly CustomToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
  reasoningEffort?: string
  signal?: AbortSignal
  /**
   * 是否流式。缺省 `true`；`testCustomProvider` 用 `false` 做最小探活。
   */
  stream?: boolean
}

/** `buildCustomRequest` 的产物。`body` 是已序列化的 JSON 文本，可直接喂给 fetch。 */
export interface CustomRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/** `consumeCustomResponse` 的选项。 */
export interface CustomConsumeOptions {
  signal?: AbortSignal
  label?: string
  maxTokens?: number
}

// ───────────────────────────── 常量与工具 ─────────────────────────────

const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 120_000
const DEFAULT_CHUNK_TIMEOUT_MS = 60_000
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096

/** 上游不接受该图片形态时的显式降级文本（绝不静默丢图）。 */
const IMAGE_DEGRADED_TEXT = '[image content omitted: upstream does not accept this image form]'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const defaultFetcher: CustomFetcher = (url, init) => fetch(url, init)

/**
 * 解析并校验 baseURL。
 *
 * 拒绝：非 http(s) 协议、畸形 URL、空 host、带用户名/密码、带 query/hash。
 * ⚠️ **不做通配地址判断**：不设主机白名单/黑名单、不特判 localhost 或内网，
 * 地址是否可达交给网络层；本函数只保证「是一个结构合法的 http(s) 绝对地址」。
 */
export function parseCustomBaseURL(baseURL: unknown): URL | undefined {
  if (typeof baseURL !== 'string') return undefined
  const trimmed = baseURL.trim()
  if (trimmed.length === 0) return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.hostname.length === 0) return undefined
  if (parsed.username !== '' || parsed.password !== '') return undefined
  if (parsed.search !== '' || parsed.hash !== '') return undefined
  return parsed
}

/**
 * 把 baseURL 与协议路径拼成完整 URL。
 *
 * ⚠️ 用**字符串拼接**而不是 `new URL(path, base)`：后者会把
 * `https://host/v1` 当成可丢弃的路径段，解析出 `https://host/chat/completions`，
 * 丢掉用户配置的 `/v1` 前缀。此处保留完整 pathname。
 */
export function joinCustomUrl(baseURL: string, path: string): string {
  const parsed = parseCustomBaseURL(baseURL)
  if (parsed === undefined) {
    throw new LlmError(
      `custom-provider: baseURL 非法（必须是无 query/hash、无凭据的 http(s) 绝对地址）`,
      'INVALID_REQUEST',
    )
  }
  const root = parsed.toString().replace(/\/+$/, '')
  const cleanPath = path.replace(/^\/+/, '')
  return `${root}/${cleanPath}`
}

/**
 * 三种协议共用的鉴权头（单一判据，供 `buildCustomRequest` 与
 * `fetchRemoteModels` 复用，避免两处各写一份 Bearer / x-api-key 分支）。
 */
export function customAuthHeaders(config: CustomProviderConfig): Record<string, string> {
  const base: Record<string, string> = {
    ...attributionHeaders(),
    accept: 'application/json',
    'content-type': 'application/json',
  }
  if (config.api === 'anthropic-messages') {
    return {
      ...base,
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    }
  }
  return { ...base, authorization: `Bearer ${config.apiKey}` }
}

/**
 * 把上游错误归类为 harness 错误码。
 *
 * ⚠️ **额度/欠费语义必须跨状态码优先命中，并产出字面量 `'QUOTA_EXCEEDED'`**：
 * 不少网关在额度耗尽时回 401/403，而 `httpErrorCode(401)` = `'AUTH'`；
 * 客户端对 `AUTH` / `QUOTA` / `ACCOUNT_QUOTA` 会丢弃适配器写的 message、
 * 换成固定文案，服务端原文（去哪充值、哪把 Key 欠费）就再也到不了用户眼前。
 *
 * 分类输入走 `errorDetailForClassify`（**排除** `detail` 腿），与
 * `openai-compat.ts` 的既有分类口径逐字节一致，避免展示层加字段翻转分类。
 */
const QUOTA_RE = /insufficient[_ ]?quota|quota[_ ]?(?:exceeded|exhausted)|out of (?:quota|credits|balance)|insufficient (?:balance|credit|funds)|billing|hard[_ ]?limit|payment required|额度|余额|欠费|用量已?用尽|资源包|付费/
const RATE_RE = /rate[_ ]?limit|too many requests|throttl|请求(?:过于)?频繁|限流|并发(?:过|超)/
const CONTEXT_RE = /context[_ ]?(?:window|length)|prompt is too long|maximum context|上下文(?:超限|过长)|超长|too long/

export function classifyCustomHttpError(status: number, body: string): string {
  return classifyCustomErrorText(errorDetailForClassify(body), httpErrorCode(status))
}

/**
 * 从一段错误文本归类（HTTP 错误体与 SSE 错误帧共用同一判据）。
 *
 * ⚠️ 额度语义跨来源优先命中并产出字面量 `'QUOTA_EXCEEDED'`：上游既可能在
 * HTTP 401/403 里、也可能在流内 `error` / `response.failed` 事件里报额度耗尽，
 * 两条路径都必须避开 `AUTH`（会把服务端原文吞掉）与 `SERVER`（误导成上游故障）。
 *
 * @param text - 已提取的可读错误文本。
 * @param fallback - 文本未命中任何语义时采用的码（通常来自状态码或事件类型）。
 */
export function classifyCustomErrorText(text: string, fallback: string): string {
  const haystack = text.toLowerCase()
  if (QUOTA_RE.test(haystack)) return 'QUOTA_EXCEEDED'
  if (CONTEXT_RE.test(haystack)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (RATE_RE.test(haystack)) return 'RATE_LIMIT'
  return fallback
}

// ───────────────────────────── 消息投影 ─────────────────────────────

type WireMessage = Record<string, unknown>

/**
 * 解析图片字节为 `attachmentId → data URL`。
 *
 * 单张失败只跳过该 id（下游 `serializeMessages` 会把它降级为文本占位），
 * 不让一张坏图打断整轮请求。`readImage` 未注入时返回空 Map（全局降级）。
 */
async function resolveImageUrls(
  messages: readonly CustomCallMessage[],
  deps: CustomProviderDeps,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (deps.readImage === undefined) return out
  const refs = new Map<string, unknown>()
  for (const message of messages) {
    if (Array.isArray(message.content)) collectImages(message.content, refs)
  }
  for (const [id, ref] of refs) {
    try {
      const image = await deps.readImage(ref)
      if (image === undefined) continue
      const bytes = image.data instanceof Uint8Array ? image.data : new Uint8Array(image.data)
      const base64 = Buffer.from(bytes).toString('base64')
      out.set(id, `data:${image.mediaType};base64,${base64}`)
    } catch {
      // 单图解析失败：留空 id，由序列化器降级为文本占位。
    }
  }
  return out
}

function toOpenAiTools(tools: readonly CustomToolSchema[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description !== undefined && tool.description.length > 0
        ? { description: tool.description }
        : {}),
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }))
}

function toResponsesTools(tools: readonly CustomToolSchema[]): Array<Record<string, unknown>> {
  // Responses 的 function 工具是**扁平**的：name / parameters 直接挂在项上，
  // 没有 Chat Completions 的 `function` 包装层。
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    ...(tool.description !== undefined && tool.description.length > 0
      ? { description: tool.description }
      : {}),
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  }))
}

function toAnthropicTools(tools: readonly CustomToolSchema[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined && tool.description.length > 0
      ? { description: tool.description }
      : {}),
    input_schema: tool.parameters ?? { type: 'object', properties: {} },
  }))
}

/**
 * 把 tool_use 的 `arguments`（JSON 字符串）解析成 Anthropic 要的**对象**。
 *
 * ⚠️ 残缺/非法 JSON **不补 `{}`**：伪造合法外观会让 harness 直接执行一个
 * 参数为空的调用。改用哨兵对象保留原文，让上层按 schema 错误重试。
 */
function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw
  if (typeof raw !== 'string') return {}
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isRecord(parsed) ? parsed : { __customUnparsableArguments: trimmed }
  } catch {
    return { __customUnparsableArguments: trimmed }
  }
}

/** Anthropic `image` 块：仅接受 data URL 或 http(s) URL，否则返回 undefined。 */
function toAnthropicImage(url: string): Record<string, unknown> | undefined {
  const data = /^data:([^;]+);base64,(.*)$/.exec(url)
  if (data !== null) {
    const rawType = data[1] ?? 'image/png'
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: rawType === 'image/*' ? 'image/jpeg' : rawType,
        data: data[2] ?? '',
      },
    }
  }
  if (/^https?:\/\//.test(url)) {
    return { type: 'image', source: { type: 'url', url } }
  }
  return undefined
}

/** OpenAI chat wire → Responses `instructions` + `input` 项。 */
function wireToResponsesInput(wire: readonly WireMessage[]): {
  instructions?: string
  input: Array<Record<string, unknown>>
} {
  const systemTexts: string[] = []
  const input: Array<Record<string, unknown>> = []

  for (const message of wire) {
    const role = typeof message.role === 'string' ? message.role : ''
    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content)
      if (text.length > 0) systemTexts.push(text)
      continue
    }
    if (role === 'tool') {
      const callId = nonEmptyString(message.tool_call_id)
      if (callId === undefined) continue
      input.push({
        type: 'function_call_output',
        call_id: callId,
        output: contentToText(message.content),
      })
      continue
    }
    if (role === 'assistant') {
      const text = contentToText(message.content)
      if (text.length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        })
      }
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      for (const rawCall of calls) {
        if (!isRecord(rawCall)) continue
        const fn = isRecord(rawCall.function) ? rawCall.function : undefined
        const name = nonEmptyString(fn?.name)
        if (name === undefined) continue
        const callId = nonEmptyString(rawCall.id) ?? `call_${input.length}`
        const args = typeof fn?.arguments === 'string' ? fn.arguments : '{}'
        input.push({ type: 'function_call', call_id: callId, name, arguments: args })
      }
      continue
    }
    // user（content 可能是字符串或多模态 parts 数组）
    const content = message.content
    if (typeof content === 'string') {
      if (content.length > 0) input.push({ type: 'message', role: 'user', content })
      continue
    }
    if (!Array.isArray(content)) continue
    const parts: Array<Record<string, unknown>> = []
    for (const rawPart of content) {
      if (!isRecord(rawPart)) continue
      if (rawPart.type === 'text' && typeof rawPart.text === 'string') {
        if (rawPart.text.length > 0) parts.push({ type: 'input_text', text: rawPart.text })
        continue
      }
      if (rawPart.type === 'image_url') {
        const imageUrl = isRecord(rawPart.image_url)
          ? nonEmptyString(rawPart.image_url.url)
          : undefined
        if (imageUrl !== undefined) {
          parts.push({ type: 'input_image', image_url: imageUrl })
        } else {
          parts.push({ type: 'input_text', text: IMAGE_DEGRADED_TEXT })
        }
        continue
      }
      // 未知 part：尽力取文本，不静默丢内容。
      const fallback = contentToText([rawPart])
      if (fallback.length > 0) parts.push({ type: 'input_text', text: fallback })
    }
    if (parts.length > 0) input.push({ type: 'message', role: 'user', content: parts })
  }

  return {
    ...(systemTexts.length > 0 ? { instructions: systemTexts.join('\n\n') } : {}),
    input,
  }
}

/** OpenAI chat wire → Anthropic 顶层 `system` + `messages`。 */
function wireToAnthropic(wire: readonly WireMessage[]): {
  system?: string
  messages: Array<Record<string, unknown>>
} {
  const systemTexts: string[] = []
  const messages: Array<Record<string, unknown>> = []

  const pushToolResult = (block: Record<string, unknown>): void => {
    const last = messages[messages.length - 1]
    if (last !== undefined && last.role === 'user' && Array.isArray(last.content)) {
      ;(last.content as Array<Record<string, unknown>>).push(block)
      return
    }
    messages.push({ role: 'user', content: [block] })
  }

  for (const message of wire) {
    const role = typeof message.role === 'string' ? message.role : ''
    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content)
      if (text.length > 0) systemTexts.push(text)
      continue
    }
    if (role === 'tool') {
      const toolUseId = nonEmptyString(message.tool_call_id)
      if (toolUseId === undefined) continue
      pushToolResult({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: contentToText(message.content),
      })
      continue
    }
    if (role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = []
      const text = contentToText(message.content)
      if (text.length > 0) blocks.push({ type: 'text', text })
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      for (const rawCall of calls) {
        if (!isRecord(rawCall)) continue
        const fn = isRecord(rawCall.function) ? rawCall.function : undefined
        const name = nonEmptyString(fn?.name)
        if (name === undefined) continue
        blocks.push({
          type: 'tool_use',
          id: nonEmptyString(rawCall.id) ?? `call_${messages.length}_${blocks.length}`,
          name,
          input: parseToolArguments(fn?.arguments),
        })
      }
      if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks })
      continue
    }
    const content = message.content
    if (typeof content === 'string') {
      if (content.length > 0) messages.push({ role: 'user', content })
      continue
    }
    if (!Array.isArray(content)) continue
    const blocks: Array<Record<string, unknown>> = []
    for (const rawPart of content) {
      if (!isRecord(rawPart)) continue
      if (rawPart.type === 'text' && typeof rawPart.text === 'string') {
        if (rawPart.text.length > 0) blocks.push({ type: 'text', text: rawPart.text })
        continue
      }
      if (rawPart.type === 'image_url') {
        const imageUrl = isRecord(rawPart.image_url)
          ? nonEmptyString(rawPart.image_url.url)
          : undefined
        const image = imageUrl !== undefined ? toAnthropicImage(imageUrl) : undefined
        if (image !== undefined) blocks.push(image)
        else blocks.push({ type: 'text', text: IMAGE_DEGRADED_TEXT })
        continue
      }
      const fallback = contentToText([rawPart])
      if (fallback.length > 0) blocks.push({ type: 'text', text: fallback })
    }
    if (blocks.length > 0) messages.push({ role: 'user', content: blocks })
  }

  return {
    ...(systemTexts.length > 0 ? { system: systemTexts.join('\n\n') } : {}),
    messages,
  }
}

// ───────────────────────────── 请求构造 ─────────────────────────────

function protocolPath(api: CustomProviderApi): string {
  if (api === 'openai-completions') return 'chat/completions'
  if (api === 'openai-responses') return 'responses'
  return 'messages'
}

/**
 * 统一构造三种协议的请求。
 *
 * ⚠️ 异步是为了解析图片字节（`deps.readImage`）；无图片/未注入解析器时
 * 仍同步返回（等价于 `Promise.resolve`），调用方一律 `await` 即可。
 */
export async function buildCustomRequest(
  config: CustomProviderConfig,
  options: CustomCallOptions,
  deps: CustomProviderDeps = {},
): Promise<CustomRequest> {
  const api = config.api ?? DEFAULT_CUSTOM_PROVIDER_API
  if (!CUSTOM_PROVIDER_APIS.includes(api)) {
    throw new LlmError(`custom-provider: 未知接口类型 "${String(api)}"`, 'INVALID_REQUEST')
  }
  if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
    throw new LlmError(
      `custom-provider: 供应商 "${config.id}" 未配置 API Key`,
      'MISSING_CREDENTIAL',
    )
  }
  if (typeof options.model !== 'string' || options.model.length === 0) {
    throw new LlmError('custom-provider: 请求缺少 model', 'INVALID_REQUEST')
  }

  const url = joinCustomUrl(config.baseURL, protocolPath(api))
  const streaming = options.stream !== false
  const headers: Record<string, string> = {
    ...customAuthHeaders(config),
    // 非流式探活要 JSON；流式请求要事件流。
    accept: streaming ? 'text/event-stream' : 'application/json',
  }

  // 共用前置归一化 + 序列化：三种协议同一份 wire。
  const allMessages: readonly CustomCallMessage[] = options.system !== undefined
    && options.system.length > 0
    ? [{ role: 'system', content: options.system }, ...options.messages]
    : options.messages

  const model: CustomProviderModel | undefined = config.models.find(
    (entry) => entry.id === options.model,
  )
  // 只有显式声明图片能力且注入了字节解析器时才下发真实图片；否则空 Map → 文本降级。
  const allowImages = model?.attachment === true && deps.readImage !== undefined
  const imageUrls = allowImages
    ? await resolveImageUrls(allMessages, deps)
    : new Map<string, string>()
  const wire = serializeMessages(allMessages, imageUrls) as WireMessage[]

  const tools = options.tools ?? []
  const body: Record<string, unknown> = {}

  if (api === 'openai-completions') {
    body.model = options.model
    body.messages = wire
    body.stream = streaming
    if (streaming) body.stream_options = { include_usage: true }
    if (tools.length > 0) body.tools = toOpenAiTools(tools)
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.stop !== undefined && options.stop.length > 0) body.stop = options.stop
    // 非标准扩展：部分兼容服务端会忽略或拒收 reasoning_effort。
    if (options.reasoningEffort !== undefined) body.reasoning_effort = options.reasoningEffort
  } else if (api === 'openai-responses') {
    const { instructions, input } = wireToResponsesInput(wire)
    body.model = options.model
    body.input = input
    if (instructions !== undefined) body.instructions = instructions
    body.stream = streaming
    if (tools.length > 0) body.tools = toResponsesTools(tools)
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens
    if (options.reasoningEffort !== undefined) {
      body.reasoning = { effort: options.reasoningEffort }
    }
    // Responses 无 stop 字段：`options.stop` 刻意不映射。
  } else {
    const { system, messages } = wireToAnthropic(wire)
    body.model = options.model
    body.max_tokens = options.maxTokens
      ?? model?.maxTokens
      ?? DEFAULT_ANTHROPIC_MAX_TOKENS
    if (system !== undefined) body.system = system
    body.messages = messages
    body.stream = streaming
    if (tools.length > 0) body.tools = toAnthropicTools(tools)
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.stop !== undefined && options.stop.length > 0) {
      body.stop_sequences = options.stop
    }
    // Anthropic 无推理档位旋钮：reasoningEffort 刻意不映射。
  }

  return { url, headers, body: JSON.stringify(body) }
}

// ───────────────────────────── SSE 解帧 ─────────────────────────────

interface SseFrame {
  event: string
  data: string
}

/** 找最早的空行分隔符（兼容 LF 与 CRLF）。 */
function frameBoundary(buffer: string): { start: number; end: number } | undefined {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return undefined
  if (crlf === -1) return { start: lf, end: lf + 2 }
  if (lf === -1) return { start: crlf, end: crlf + 4 }
  return crlf < lf ? { start: crlf, end: crlf + 4 } : { start: lf, end: lf + 2 }
}

function parseFrame(raw: string, carry: { event: string; data: string[] }): SseFrame | undefined {
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) carry.event = line.slice(6).trim()
    else if (line.startsWith('data:')) carry.data.push(line.slice(5).trimStart())
  }
  if (carry.data.length === 0 && carry.event === '') return undefined
  const frame: SseFrame = { event: carry.event, data: carry.data.join('\n') }
  carry.event = ''
  carry.data = []
  return frame
}

/**
 * 消费一条 SSE 响应体，产出 `{event, data}` 帧。
 *
 * ⚠️ AbortSignal：abort 时主动 `reader.cancel()` —— 裸 `reader.read()` 在
 * 「连接建立但不吐数据」时不会自行被 abort 唤醒，必须取消底层流才能退出。
 */
async function* iterateSse(response: Response, signal?: AbortSignal): AsyncIterable<SseFrame> {
  const body = response.body
  if (body === null) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const carry = { event: '', data: [] as string[] }
  let buffer = ''
  const onAbort = (): void => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      if (signal?.aborted === true) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const boundary = frameBoundary(buffer)
        if (boundary === undefined) break
        const raw = buffer.slice(0, boundary.start)
        buffer = buffer.slice(boundary.end)
        const frame = parseFrame(raw, carry)
        if (frame !== undefined) yield frame
      }
    }
    const tail = parseFrame(buffer, carry)
    if (tail !== undefined) yield tail
  } finally {
    signal?.removeEventListener('abort', onAbort)
    try { await reader.cancel() } catch { /* 流已关闭 */ }
    reader.releaseLock()
  }
}

// ───────────────────────────── 块累积器 ─────────────────────────────

type BlockKind = 'text' | 'reasoning' | 'tool-call'

interface SinkBlock {
  index: number
  kind: BlockKind
  text: string
  callId: string
  name: string
  args: string
  started: boolean
}

/**
 * 两种自消费协议共用的块累积器。
 *
 * DSH 的 `block-end` 携带**完整内容**（不是结束标记），故正文/思考/工具参数
 * 必须先缓冲、收尾统一发 `block-end`；`*-delta` 只是增量预览。与
 * `consumeOpenAiSse` 的 `blocks[]` 同构。
 */
function createSink() {
  const blocks = new Map<number, SinkBlock>()
  const order: number[] = []
  const ensure = (index: number, kind: BlockKind): SinkBlock => {
    const existing = blocks.get(index)
    if (existing !== undefined) return existing
    const block: SinkBlock = {
      index,
      kind,
      text: '',
      callId: `call_${index}`,
      name: '',
      args: '',
      started: false,
    }
    blocks.set(index, block)
    order.push(index)
    return block
  }
  const startChunk = (block: SinkBlock): StreamChunk | undefined => {
    if (block.started) return undefined
    block.started = true
    return { type: 'block-start', index: block.index, blockType: block.kind }
  }
  const hasToolCalls = (): boolean =>
    [...blocks.values()].some((b) => b.kind === 'tool-call' && b.name.length > 0)
  const finishChunks = (): StreamChunk[] => {
    const out: StreamChunk[] = []
    for (const index of order) {
      const block = blocks.get(index)
      if (block === undefined) continue
      let content: StreamChunk | undefined
      if (block.kind === 'text') {
        if (block.text === '') continue
        content = { type: 'block-end', index, block: { type: 'text', text: block.text } }
      } else if (block.kind === 'reasoning') {
        if (block.text.trim() === '') continue
        content = { type: 'block-end', index, block: { type: 'reasoning', text: block.text } }
      } else {
        if (block.name === '') continue
        // 残缺参数保持原样交给 harness 判定；仅「完全空」补成合法 JSON。
        const args = block.args.trim() === '' ? '{}' : block.args
        content = {
          type: 'block-end',
          index,
          block: {
            type: 'tool-call',
            id: ToolCallId(block.callId),
            name: block.name,
            arguments: args,
          },
        }
      }
      if (!block.started) {
        out.push({ type: 'block-start', index, blockType: block.kind })
        block.started = true
      }
      out.push(content)
    }
    return out
  }
  return { ensure, startChunk, hasToolCalls, finishChunks }
}

function responsesUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined
  const inputTotal = asFiniteNumber(raw.input_tokens)
  const output = asFiniteNumber(raw.output_tokens)
  if (inputTotal === undefined && output === undefined) return undefined
  const cached = asFiniteNumber(isRecord(raw.input_tokens_details)
    ? raw.input_tokens_details.cached_tokens
    : undefined)
  const reasoning = asFiniteNumber(isRecord(raw.output_tokens_details)
    ? raw.output_tokens_details.reasoning_tokens
    : undefined)
  const cacheRead = cached !== undefined && cached > 0 ? cached : 0
  const usage: TokenUsage = {
    inputTokens: Math.max(0, (inputTotal ?? 0) - cacheRead),
    outputTokens: output ?? 0,
  }
  const total = asFiniteNumber(raw.total_tokens)
  if (total !== undefined) usage.totalTokens = total
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead
  if (reasoning !== undefined && reasoning > 0) usage.reasoningTokens = reasoning
  return usage
}

// ───────────────────────────── 协议 SSE 消费 ─────────────────────────────

async function* consumeResponsesSse(
  response: Response,
  opts: { label: string; signal?: AbortSignal },
): AsyncIterable<StreamChunk> {
  const sink = createSink()
  const itemToIndex = new Map<string, number>()
  let usage: TokenUsage | undefined
  let finishKind: 'stop' | 'tool-calls' | 'max-tokens' = 'stop'
  let incompleteReason: string | undefined
  let sawContent = false

  const indexOf = (payload: Record<string, unknown>): number => {
    const direct = asFiniteNumber(payload.output_index)
    if (direct !== undefined && Number.isInteger(direct) && direct >= 0) return direct
    const itemId = nonEmptyString(payload.item_id)
    if (itemId !== undefined) {
      const mapped = itemToIndex.get(itemId)
      if (mapped !== undefined) return mapped
    }
    return 0
  }

  for await (const frame of iterateSse(response, opts.signal)) {
    if (frame.data === '' || frame.data === '[DONE]') continue
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(frame.data) as Record<string, unknown>
    } catch {
      continue // ping / 注释帧
    }
    const type = nonEmptyString(payload.type) ?? frame.event

    if (type === 'error' || type === 'response.failed') {
      const err = isRecord(payload.error)
        ? payload.error
        : isRecord(payload.response) && isRecord(payload.response.error)
          ? payload.response.error
          : undefined
      const message = err !== undefined && typeof err.message === 'string'
        ? err.message
        : frame.data.slice(0, 300)
      const code = classifyCustomErrorText(
        message,
        err !== undefined && typeof err.code === 'string' && /rate|overload/i.test(err.code)
          ? 'RATE_LIMIT'
          : 'SERVER',
      )
      throw new LlmError(`${opts.label}: 上游返回错误事件 — ${message}`, code)
    }

    if (type === 'response.output_item.added') {
      const index = indexOf(payload)
      const item = isRecord(payload.item) ? payload.item : undefined
      if (item !== undefined) {
        const itemId = nonEmptyString(item.id)
        if (itemId !== undefined) itemToIndex.set(itemId, index)
        const itemType = nonEmptyString(item.type)
        if (itemType === 'function_call') {
          const block = sink.ensure(index, 'tool-call')
          const callId = nonEmptyString(item.call_id)
          const name = nonEmptyString(item.name)
          if (callId !== undefined) block.callId = callId
          if (name !== undefined) block.name = name
        } else if (itemType === 'reasoning') {
          sink.ensure(index, 'reasoning')
        } else {
          sink.ensure(index, 'text')
        }
      } else {
        sink.ensure(index, 'text')
      }
      continue
    }

    if (type === 'response.output_text.delta') {
      const delta = nonEmptyString(payload.delta)
      if (delta === undefined) continue
      const block = sink.ensure(indexOf(payload), 'text')
      const start = sink.startChunk(block)
      if (start !== undefined) yield start
      block.text += delta
      sawContent = true
      yield { type: 'text-delta', index: block.index, text: delta }
      continue
    }

    if (type === 'response.reasoning_summary_text.delta'
      || type === 'response.reasoning_text.delta') {
      const delta = nonEmptyString(payload.delta)
      if (delta === undefined) continue
      const block = sink.ensure(indexOf(payload), 'reasoning')
      const start = sink.startChunk(block)
      if (start !== undefined) yield start
      block.text += delta
      sawContent = true
      yield { type: 'reasoning-delta', index: block.index, text: delta }
      continue
    }

    if (type === 'response.function_call_arguments.delta') {
      const fragment = typeof payload.delta === 'string' ? payload.delta : ''
      const block = sink.ensure(indexOf(payload), 'tool-call')
      if (block.name === '') {
        const name = nonEmptyString(payload.name)
        if (name !== undefined) block.name = name
      }
      const start = sink.startChunk(block)
      if (start !== undefined) yield start
      block.args += fragment
      if (fragment !== '') sawContent = true
      yield {
        type: 'tool-call-delta',
        index: block.index,
        id: ToolCallId(block.callId),
        ...(block.name !== '' ? { name: block.name } : {}),
        argumentsDelta: fragment,
      }
      continue
    }

    if (type === 'response.function_call_arguments.done') {
      const block = sink.ensure(indexOf(payload), 'tool-call')
      if (block.name === '') {
        const name = nonEmptyString(payload.name)
        if (name !== undefined) block.name = name
      }
      // 只有 `done`、没有 `delta` 的上游：把完整参数补发一次，避免内容丢失。
      if (block.args === '' && typeof payload.arguments === 'string'
        && payload.arguments.length > 0) {
        block.args = payload.arguments
        sawContent = true
        const start = sink.startChunk(block)
        if (start !== undefined) yield start
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId),
          ...(block.name !== '' ? { name: block.name } : {}),
          argumentsDelta: payload.arguments,
        }
      }
      continue
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      if (isRecord(payload.response)) {
        const parsed = responsesUsage(payload.response.usage)
        if (parsed !== undefined) usage = parsed
        if (type === 'response.incomplete') {
          finishKind = 'max-tokens'
          const details = isRecord(payload.response.incomplete_details)
            ? payload.response.incomplete_details
            : undefined
          incompleteReason = details !== undefined
            ? nonEmptyString(details.reason)
            : undefined
        }
      }
      if (type === 'response.completed') break
      continue
    }
    // 其余事件（created / in_progress / *.done / content_part.*）不即时产出。
  }

  const ends = sink.finishChunks()
  for (const chunk of ends) yield chunk
  if (ends.length === 0 && !sawContent) {
    throw new LlmError(
      `${opts.label}: 上游未产出任何内容块${incompleteReason !== undefined ? `（${incompleteReason}）` : '（空响应）'}`,
      'EMPTY_RESPONSE',
    )
  }
  if (usage !== undefined) yield { type: 'usage', usage }
  const reason: { kind: 'stop' | 'tool-calls' | 'max-tokens' } = finishKind === 'max-tokens'
    ? { kind: 'max-tokens' }
    : sink.hasToolCalls()
      ? { kind: 'tool-calls' }
      : { kind: 'stop' }
  yield { type: 'finish', reason }
}

async function* consumeAnthropicSse(
  response: Response,
  opts: { label: string; signal?: AbortSignal },
): AsyncIterable<StreamChunk> {
  const sink = createSink()
  const toolMeta = new Map<number, { id: string; name: string }>()
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let cacheReadTokens: number | undefined
  let cacheWriteTokens: number | undefined
  let stopReason: string | undefined
  let sawContent = false

  const collectUsage = (raw: unknown): void => {
    if (!isRecord(raw)) return
    const read = (value: unknown): number | undefined => {
      const num = asFiniteNumber(value)
      return num !== undefined && num >= 0 ? num : undefined
    }
    inputTokens = read(raw.input_tokens) ?? inputTokens
    outputTokens = read(raw.output_tokens) ?? outputTokens
    cacheReadTokens = read(raw.cache_read_input_tokens) ?? cacheReadTokens
    cacheWriteTokens = read(raw.cache_creation_input_tokens) ?? cacheWriteTokens
  }

  for await (const frame of iterateSse(response, opts.signal)) {
    if (frame.data === '' || frame.data === '[DONE]') continue
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(frame.data) as Record<string, unknown>
    } catch {
      continue
    }
    const type = nonEmptyString(payload.type) ?? frame.event

    if (type === 'error') {
      const err = isRecord(payload.error) ? payload.error : undefined
      const message = err !== undefined && typeof err.message === 'string'
        ? err.message
        : frame.data.slice(0, 300)
      const errType = err !== undefined ? nonEmptyString(err.type) : undefined
      throw new LlmError(
        `${opts.label}: 上游返回错误事件 — ${message}`,
        classifyCustomErrorText(message, errType === 'overloaded_error' ? 'RATE_LIMIT' : 'SERVER'),
      )
    }

    const rawIndex = asFiniteNumber(payload.index)
    const index = rawIndex !== undefined && Number.isInteger(rawIndex) && rawIndex >= 0
      ? rawIndex
      : 0

    if (type === 'message_start') {
      if (isRecord(payload.message)) collectUsage(payload.message.usage)
      continue
    }

    if (type === 'content_block_start') {
      const block = isRecord(payload.content_block) ? payload.content_block : undefined
      const blockType = block !== undefined ? nonEmptyString(block.type) : undefined
      if (blockType === 'tool_use') {
        const id = block !== undefined ? nonEmptyString(block.id) : undefined
        const name = block !== undefined ? nonEmptyString(block.name) : undefined
        toolMeta.set(index, { id: id ?? `call_${index}`, name: name ?? '' })
        // tool-call 的 block-start 延后到名字/参数可用时再发，避免空工具块。
      } else if (blockType === 'thinking' || blockType === 'redacted_thinking') {
        const acc = sink.ensure(index, 'reasoning')
        const start = sink.startChunk(acc)
        if (start !== undefined) yield start
      } else {
        const acc = sink.ensure(index, 'text')
        const start = sink.startChunk(acc)
        if (start !== undefined) yield start
      }
      continue
    }

    if (type === 'content_block_delta') {
      const delta = isRecord(payload.delta) ? payload.delta : undefined
      if (delta === undefined) continue
      const deltaType = nonEmptyString(delta.type)
      if (deltaType === 'text_delta' && typeof delta.text === 'string') {
        const text = delta.text
        if (text === '') continue
        const block = sink.ensure(index, 'text')
        const start = sink.startChunk(block)
        if (start !== undefined) yield start
        block.text += text
        sawContent = true
        yield { type: 'text-delta', index: block.index, text }
        continue
      }
      if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
        const text = delta.thinking
        if (text === '') continue
        const block = sink.ensure(index, 'reasoning')
        const start = sink.startChunk(block)
        if (start !== undefined) yield start
        block.text += text
        sawContent = true
        yield { type: 'reasoning-delta', index: block.index, text }
        continue
      }
      if (deltaType === 'input_json_delta') {
        const fragment = typeof delta.partial_json === 'string' ? delta.partial_json : ''
        const block = sink.ensure(index, 'tool-call')
        const meta = toolMeta.get(index)
        if (meta !== undefined) {
          block.callId = meta.id
          if (block.name === '') block.name = meta.name
        }
        const start = sink.startChunk(block)
        if (start !== undefined) yield start
        block.args += fragment
        if (fragment !== '') sawContent = true
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId),
          ...(block.name !== '' ? { name: block.name } : {}),
          argumentsDelta: fragment,
        }
      }
      continue
    }

    if (type === 'message_delta') {
      collectUsage(payload.usage)
      if (isRecord(payload.delta)) {
        const reason = nonEmptyString(payload.delta.stop_reason)
        if (reason !== undefined) stopReason = reason
      }
      continue
    }

    if (type === 'message_stop') break
    // content_block_stop / ping：收尾统一发 block-end。
  }

  const ends = sink.finishChunks()
  for (const chunk of ends) yield chunk
  if (ends.length === 0 && !sawContent) {
    throw new LlmError(`${opts.label}: 模型返回了空响应（无任何内容帧）`, 'EMPTY_RESPONSE')
  }

  if (inputTokens !== undefined || outputTokens !== undefined
    || cacheReadTokens !== undefined || cacheWriteTokens !== undefined) {
    const usage: TokenUsage = {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
    }
    if (inputTokens !== undefined && outputTokens !== undefined) {
      usage.totalTokens = inputTokens + outputTokens
        + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
    }
    if (cacheReadTokens !== undefined && cacheReadTokens > 0) {
      usage.cacheReadTokens = cacheReadTokens
    }
    if (cacheWriteTokens !== undefined && cacheWriteTokens > 0) {
      usage.cacheWriteTokens = cacheWriteTokens
    }
    yield { type: 'usage', usage }
  }

  const reason: { kind: 'stop' | 'tool-calls' | 'max-tokens' } = stopReason === 'max_tokens'
    ? { kind: 'max-tokens' }
    : stopReason === 'tool_use' || sink.hasToolCalls()
      ? { kind: 'tool-calls' }
      : { kind: 'stop' }
  yield { type: 'finish', reason }
}

// ───────────────────────────── 统一响应入口 ─────────────────────────────

/**
 * 统一消费三种协议的响应，产出 `StreamChunk`。
 *
 * 先做**三种协议共用**的错误闸门（HTTP 状态 / content-type），再分发到各自的
 * SSE 消费器。`openai-completions` 直接复用 `consumeOpenAiSse`。
 */
export async function* consumeCustomResponse(
  api: CustomProviderApi,
  response: Response,
  options: CustomConsumeOptions = {},
  deps: CustomProviderDeps = {},
): AsyncIterable<StreamChunk> {
  const label = options.label ?? 'custom-provider'

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const code = classifyCustomHttpError(response.status, text)
    const display = errorDetail(text).slice(0, 300)
    throw new LlmError(
      `${label}: HTTP ${response.status} — ${display.length > 0 ? display : '(空响应体)'}`,
      code,
      { status: response.status },
    )
  }

  // 200 + 非事件流：常见形态是网关风控拦截页 / 登录墙。显式报错，不能喂给
  // SSE 解帧器（那样只会得到「没有任何 data: 帧」的二手诊断）。
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    const peek = await response.text().catch(() => '')
    throw new LlmError(
      `${label}: 上游未返回事件流（content-type: ${contentType || '(空)'}）——`
      + `通常是被风控拦截或上游返回了非流式 JSON。`
      + `${peek === '' ? '' : ` 服务端原文：${peek.slice(0, 200)}`}`,
      'SERVER',
      { status: response.status },
    )
  }
  if (response.body === null) {
    throw new LlmError(`${label}: 响应体为空`, 'EMPTY_RESPONSE')
  }

  const consumerOpts = {
    label,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  }

  if (api === 'openai-completions') {
    yield* consumeOpenAiSse(
      response,
      options.signal !== undefined ? { signal: options.signal } : {},
      {
        label,
        firstTokenTimeoutMs: deps.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
        chunkTimeoutMs: deps.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS,
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      },
    )
    return
  }
  if (api === 'openai-responses') {
    yield* consumeResponsesSse(response, consumerOpts)
    return
  }
  yield* consumeAnthropicSse(response, consumerOpts)
}

/** 供接线层复用的缺省 fetch（与 `CustomProviderDeps.fetcher` 同型）。 */
export function resolveFetcher(deps: CustomProviderDeps): CustomFetcher {
  return deps.fetcher ?? defaultFetcher
}
