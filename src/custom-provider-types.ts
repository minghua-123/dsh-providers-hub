/**
 * 「自定义供应商」框架的数据形状与 id 约束。
 *
 * 本文件只描述**数据**，不含任何 I/O：
 * - 配置由插件自身的 schemastery 配置承载（见 `custom-provider-store.ts`），
 *   不写入 `llm-pi-ai.providers`，也不注册 `settings.models.provider-card` 槽；
 * - 每个配置实例在 `ctx.llm` 上注册一条 `['<id>']` 路由
 *   （见 `custom-provider-adapter.ts` 的 `registerCustomProviders`）。
 *
 * ## id 约束（宿主路由要求）
 *
 * 宿主 `LlmRuntime.registerAdapter()` 用 provider 字符串作路由键并校验非空，
 * 但本框架额外收紧为 `^[a-z][a-z0-9]*$`：
 * - 不含连字符 / 大写 / 下划线 / 空格，避免与各设置页、URL 片段、
 *   `provider.toUpperCase()` 一类既有调用点的假设冲突；
 * - 三个保留 id 不可占用：`opencode` / `modelscope` / `aggregate`
 *   （分别对应独立官方实现与聚合路由，重复注册会被宿主以
 *   `DUPLICATE_ADAPTER` 拒绝）。
 *
 * 魔搭 modelscope 保留为独立官方实现，不并入本框架的数据形状。
 *
 * @module src/custom-provider-types.ts
 */

/** 三种兼容的上游 wire 协议。默认 OpenAI Chat Completions。 */
export type CustomProviderApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'

/** 全部合法协议值（顺序稳定，供 schema/UI/校验共用，避免多处硬编码）。 */
export const CUSTOM_PROVIDER_APIS: readonly CustomProviderApi[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
] as const

/** 缺省协议：OpenAI Chat Completions。 */
export const DEFAULT_CUSTOM_PROVIDER_API: CustomProviderApi = 'openai-completions'

/**
 * 保留的 provider id。
 *
 * ⚠️ 这些路由由仓库内独立的官方/聚合适配器持有，自定义供应商不得占用，
 * 否则 `registerAdapter` 会以 `DUPLICATE_ADAPTER` 拒绝整批注册。
 */
export const RESERVED_PROVIDER_IDS: readonly string[] = [
  'opencode',
  'modelscope',
  'aggregate',
] as const

/** 宿主可接受的自定义 provider id 形态：小写字母开头，后接小写字母或数字。 */
export const CUSTOM_PROVIDER_ID_PATTERN: RegExp = /^[a-z][a-z0-9]*$/

/**
 * 校验一个自定义 provider id。
 *
 * 判据是「形状 + 保留字」两条，**不做大小写/字符的静默改写** —— 把
 * `My-Provider` 悄悄改成 `myprovider` 会让用户在设置页看到的 id 与实际
 * 路由不一致，属于会漂移的隐式归一化。
 */
export function isValidCustomProviderId(id: unknown): id is string {
  return typeof id === 'string'
    && CUSTOM_PROVIDER_ID_PATTERN.test(id)
    && !RESERVED_PROVIDER_IDS.includes(id)
}

/** 一个自定义模型的能力描述（全部由用户在设置页填写）。 */
export interface CustomProviderModel {
  /** 上游接受的模型 id（原样下发，不做改写）。 */
  id: string
  /** 选择器里的显示名。 */
  name: string
  /** 上下文窗口（token）；`0` 表示未知，不下发给宿主以免触发错误的自动压缩阈值。 */
  contextWindow: number
  /** 单次输出上限；仅作为 anthropic 必填 `max_tokens` 的兜底，不声明为宿主默认上限。 */
  maxTokens?: number
  /**
   * 推理档位 id 列表（如 `['low', 'medium', 'high']`）。
   *
   * 提供且非空时 `resolveModel` 暴露档位选择器；缺省/空数组表示不声明推理能力。
   * 档位值经 `ReasoningEffortId` 品牌化后原样下发，是否合法由上游决定。
   */
  reasoning?: readonly string[]
  /** 是否声明支持图片输入；为 `true` 时 `inputModalities` 才包含 `image`。 */
  attachment?: boolean
}

/** 一个自定义供应商实例的完整配置（含明文 apiKey，仅存在于插件配置内）。 */
export interface CustomProviderConfig {
  /** 路由 id，必须满足 {@link isValidCustomProviderId}。 */
  id: string
  /** 宿主 `providerInfo()` 与选择器里的显示名。 */
  displayName: string
  api: CustomProviderApi
  /** 上游根地址，例如 `https://api.example.com/v1`；只允许 http(s) 绝对地址。 */
  baseURL: string
  /** 明文密钥。绝不进入 {@link CustomProviderRuntime}、日志或错误消息。 */
  apiKey: string
  models: readonly CustomProviderModel[]
  /** 仅 `enabled === true` 的实例会被注册路由。 */
  enabled: boolean
}

/**
 * 回传 UI 的运行时元数据。
 *
 * ⚠️ **不含明文 key**：`apiKeyMasked` 是打码后的展示串，`hasApiKey` 只回答
 * 「有没有配置」。设置页回显用本形状；保存时若用户未改动密钥，应由接线层
 * 用「保留原值」语义处理，不能把打码串写回配置。
 */
export interface CustomProviderRuntime {
  id: string
  displayName: string
  api: CustomProviderApi
  baseURL: string
  enabled: boolean
  modelCount: number
  models: readonly { id: string; name: string }[]
  apiKeyMasked: string
  hasApiKey: boolean
}
