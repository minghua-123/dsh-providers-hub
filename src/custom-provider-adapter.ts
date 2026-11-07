/**
 * 「自定义供应商」框架的 `LlmAdapter` 实现与路由注册。
 *
 * ## 真实调用链（按 dsh-llm 0.2.1-rc.2）
 *
 * `LlmRuntime` 的派发路径是：
 *
 * ```
 * adapterStream(provider, model, options)
 *   → adapter.prepareCall(provider, model, signal)
 *   → PreparedAdapterCall.stream(options)      ← 生产环境只走这里
 * ```
 *
 * ⚠️ 顶层 `adapter.stream(options)` **从不被生产路径直接调用**（它是
 * `LlmAdapter` 的抽象方法，必须实现，但只在少数工具/单测里被直接驱动）。
 * 故 `prepareCall` 返回的 `stream` 与顶层 `stream` 共用同一个
 * {@link CustomProviderAdapter.streamWith}，口径不分叉。
 *
 * 目录侧：`listModels(provider)` 供模型选择器；`listAllModels()` 是给
 * `jet-hub-rpc.ts` 的 `ModelCatalogSource` 用的**同步**全量目录（必须是同步
 * 数组，返回 Promise 会让 `catalog = [...all]` 抛 `TypeError`）。
 *
 * ## 为什么不用 `createModelCatalog` 共享骨架
 *
 * 骨架（`model-catalog.ts`）的黑名单 / 关闭意图 / 模态回填都依赖
 * `AccountPool`（`disabledModelsFor` / `providerClosedFor`）。自定义供应商
 * 的凭据直接存在配置里、没有账号池，传 `{}` 会让那些判据静默 no-op —— 与其
 * 接一个空壳，不如让目录直接由配置派生：更短、可纯函数单测、无隐式门控。
 *
 * ## 重复调用的注册语义
 *
 * {@link registerCustomProviders} 会在模块级 `WeakMap` 里按 `llm` 保存
 * 「id → { adapter, handle }」注册表，支持被反复调用（配置热更新）：
 *
 * - **移除的实例**：调用 `registerAdapter` 返回的 `AdapterRegistrationHandle`
 *   （可调用的 disposer，`registerAdapterIdempotent` 原样透传）**注销旧路由**，
 *   再从注册表删除；
 * - **保留的实例**：**不重新注册**，而是 `adapter.setConfig(...)` 替换内部
 *   配置。原因是 `registerAdapter` 是 all-or-nothing 且对同名路由抛
 *   `DUPLICATE_ADAPTER`；重新注册既会撞重复，又会在插件 fiber 重启竞态里
 *   与旧 dispose 赛跑。保留同一个适配器实例、就地换配置，等价于「同一条
 *   路由、新一代配置」，且天然满足 `prepareCall` 的「一代绑定」要求；
 * - **新增的实例**：走 `registerAdapterIdempotent`（幂等 + Token 记账 +
 *   失效模型剔除包装），注册 `['<id>']` 单条路由。
 *
 * ⚠️ **宿主无注销 API 的情形**：`registerAdapterIdempotent` 撞上「已注册」
 * 竞态分支时返回 `undefined`（没有 handle）。此时该路由归上一轮 fiber 所有，
 * 本轮拿不到 disposer，故**不能**注销它 —— 只能依赖幂等语义保留旧路由，
 * 并用 `setConfig` 把配置写回本轮新建的适配器（见下方 `handle === undefined`
 * 分支的注释）。这类路由最终由拥有它的 fiber 在 dispose 时回收。
 *
 * @module src/custom-provider-adapter.ts
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  registerAdapterIdempotent,
  type AdapterRegisterTarget,
} from './llm-register-compat.js'
import {
  type CustomProviderApi,
  type CustomProviderConfig,
  type CustomProviderModel,
} from './custom-provider-types.js'
import {
  buildCustomRequest,
  consumeCustomResponse,
  resolveFetcher,
  type CustomCallOptions,
  type CustomProviderDeps,
} from './custom-provider-protocols.js'
import { normalizeCustomProviders } from './custom-provider-store.js'

// ───────────────────────────── 纯函数（便于单测） ─────────────────────────────

/**
 * 单个模型的 `LlmModelInfo`。
 *
 * ⚠️ 未知 model id 也返回一个**保守**条目（`inputModalities: ['text']`）：
 * dsh-llm 允许目录外的 id 参与路由，但「未知」不能当成「支持图片」上报，
 * 否则宿主会把图片投影成上游不接受的形态。
 */
export function modelInfoFor(
  config: CustomProviderConfig,
  modelId: string,
  provider: string = config.id,
): LlmModelInfo {
  const model = config.models.find((entry) => entry.id === modelId)
  return {
    provider,
    id: modelId,
    name: model !== undefined && model.name.length > 0 ? model.name : modelId,
    inputModalities: model?.attachment === true
      ? (['text', 'image'] as const)
      : (['text'] as const),
  }
}

/** 全部配置模型 → `LlmModelInfo[]`（顺序即配置顺序）。 */
export function modelInfosFor(
  config: CustomProviderConfig,
  provider: string = config.id,
): readonly LlmModelInfo[] {
  return config.models.map((model) => modelInfoFor(config, model.id, provider))
}

/**
 * `resolveModel` 的纯函数版本。
 *
 * - 窗口未知（`0`）**不声明** `context`：0 会让自动压缩抛出
 *   `TargetPressureConfigError`（与 modelscope 同口径）；
 * - `reasoning` 档位只在配置里显式给出且非空时声明，避免空选择器；
 * - ⚠️ **刻意不声明 `defaultMaxTokens`**：它会被宿主填进每次请求，等于替用户
 *   决定输出上限。`model.maxTokens` 只在协议层用作 anthropic 必填
 *   `max_tokens` 的兜底（见 `custom-provider-protocols.ts`）。
 */
export function resolvedModelInfoFor(
  config: CustomProviderConfig,
  modelId: string,
  provider: string = config.id,
): LlmResolvedModelInfo {
  const resolved: LlmResolvedModelInfo = modelInfoFor(config, modelId, provider)
  const model: CustomProviderModel | undefined = config.models.find(
    (entry) => entry.id === modelId,
  )
  if (model === undefined) return resolved
  if (Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0) {
    resolved.context = { contextWindow: model.contextWindow }
  }
  if (model.reasoning !== undefined && model.reasoning.length > 0) {
    resolved.reasoning = {
      efforts: model.reasoning.map((effort) => ({
        id: ReasoningEffortId(effort),
        name: effort,
      })),
    }
  }
  return resolved
}

// ───────────────────────────── 适配器 ─────────────────────────────

/** `registerCustomProviders` / 适配器共用的依赖。 */
export interface CustomProviderRegisterDeps extends CustomProviderDeps {
  /** 透传 `registerAdapterIdempotent` 的失效模型剔除开关。 */
  pruning?: { enabled?: boolean }
}

/** 判断是否为取消/超时类错误（避免被误归类成 TRANSPORT / SERVER）。 */
function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; code?: unknown }
  return candidate.name === 'AbortError' || candidate.code === 'ABORTED'
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown error'
}

export class CustomProviderAdapter extends LlmAdapter {
  private config: CustomProviderConfig
  private deps: CustomProviderRegisterDeps

  constructor(config: CustomProviderConfig, deps: CustomProviderRegisterDeps = {}) {
    super()
    this.config = config
    this.deps = deps
  }

  /**
   * 就地替换内部配置（重复注册/热更新用），保持同一个适配器实例与路由身份。
   * `prepareCall` 会在每次派发时捕获当时的配置快照，故新旧两代不会串味。
   */
  setConfig(config: CustomProviderConfig, deps: CustomProviderRegisterDeps): void {
    this.config = config
    this.deps = deps
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.config.id
    const name = this.config.displayName.trim().length > 0 ? this.config.displayName : id
    // `registerAdapter.prepareRoutes()` 要求 id 严格等于 provider 且 name 非空。
    return { id, name }
  }

  /**
   * 同步全量目录（Jet Hub 的 `ModelCatalogSource` 契约）。
   * ⚠️ 绝不可写成 async。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    return this.config.models.map((model) => ({
      id: model.id,
      name: model.name.length > 0 ? model.name : model.id,
    }))
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return modelInfosFor(this.config, provider)
  }

  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return resolvedModelInfoFor(this.config, model, provider)
  }

  async prepareCall(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    // 捕获这一代的配置与依赖：设置变更发生在准备与派发之间时，不会把
    // 一代的能力/端点与另一代混用。
    const config = this.config
    const deps = this.deps
    return {
      model: resolvedModelInfoFor(config, model, provider),
      stream: (options: GenerateOptions) => this.streamWith(config, deps, options),
    }
  }

  /** 顶层 stream（生产路径经 `prepareCall().stream` 进来，两者共用实现）。 */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamWith(this.config, this.deps, options)
  }

  private async *streamWith(
    config: CustomProviderConfig,
    deps: CustomProviderRegisterDeps,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    const label = `custom:${config.id}`
    const callOptions: CustomCallOptions = {
      model: options.model,
      messages: options.messages,
      ...(options.system !== undefined ? { system: options.system } : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.stop !== undefined ? { stop: options.stop } : {}),
      ...(options.reasoningEffort !== undefined
        ? { reasoningEffort: String(options.reasoningEffort) }
        : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }

    const request = await buildCustomRequest(config, callOptions, deps)
    let response: Response
    try {
      response = await resolveFetcher(deps)(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })
    } catch (error) {
      // 取消必须原样抛出：把它包成 TRANSPORT 会让宿主继续重试一个已取消的请求。
      if (isAbortError(error, options.signal)) throw error
      throw new LlmError(
        `${label}: 请求发送失败 — ${safeErrorMessage(error)}`,
        'TRANSPORT',
      )
    }

    yield* consumeCustomResponse(
      config.api as CustomProviderApi,
      response,
      {
        label,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      },
      deps,
    )
  }
}

// ───────────────────────────── 注册 ─────────────────────────────

interface Registration {
  adapter: CustomProviderAdapter
  /**
   * `registerAdapter` 返回的 `AdapterRegistrationHandle`：本身是可调用的
   * disposer，并带 `.replace()`。撞重复竞态时为 undefined（见模块头）。
   */
  handle: unknown
}

/** 按 `llm` 分表的模块级注册表（重复调用共享，跨 fiber 重启仍保留）。 */
const registries = new WeakMap<object, Map<string, Registration>>()

function disposeHandle(handle: unknown, id: string, warn?: (message: string) => void): void {
  if (typeof handle !== 'function') {
    warn?.(
      `[custom-provider] 路由 "${id}" 没有可用的注销句柄（重复注册竞态保留的旧路由）；`
      + '该路由将在拥有它的插件 fiber 退出时回收',
    )
    return
  }
  try {
    ;(handle as () => void)()
  } catch (error) {
    warn?.(`[custom-provider] 注销路由 "${id}" 失败: ${safeErrorMessage(error)}`)
  }
}

/**
 * 为每个 enabled 的自定义供应商注册 `['<id>']` 路由，返回 `id → adapter`。
 *
 * 可重复调用：先注销不再需要的旧路由，保留的实例就地替换配置，新增的
 * 实例走幂等注册。详见模块头「重复调用的注册语义」。
 */
export function registerCustomProviders(
  llm: AdapterRegisterTarget,
  configs: readonly CustomProviderConfig[],
  deps: CustomProviderRegisterDeps = {},
): Map<string, LlmAdapter> {
  let registry = registries.get(llm)
  if (registry === undefined) {
    registry = new Map<string, Registration>()
    registries.set(llm, registry)
  }

  // 归一化会过滤非法 id / 畸形 baseURL，并去重；只有 enabled 的进入目标集。
  const normalized = normalizeCustomProviders(configs)
  const desired = new Map<string, CustomProviderConfig>()
  for (const config of normalized) {
    if (config.enabled) desired.set(config.id, config)
  }
  for (const config of configs) {
    if (config.enabled && !desired.has(config.id)) {
      deps.warn?.(`[custom-provider] 跳过非法配置 "${config.id}"（id 保留/不合规或 baseURL 非法）`)
    }
  }

  // 1) 注销不再需要的旧路由（宿主有注销 API 时）。
  for (const [id, registration] of registry) {
    if (!desired.has(id)) {
      disposeHandle(registration.handle, id, deps.warn)
      registry.delete(id)
    }
  }

  // 2) 保留的实例：幂等语义 + 替换内部配置（不重新注册，避开 DUPLICATE_ADAPTER）。
  //    新增的实例：注册单条路由。
  for (const [id, config] of desired) {
    const existing = registry.get(id)
    if (existing !== undefined) {
      existing.adapter.setConfig(config, deps)
      continue
    }
    const adapter = new CustomProviderAdapter(config, deps)
    const handle = registerAdapterIdempotent(llm, [id], adapter, deps.warn, deps.pruning)
    if (handle === undefined) {
      // 撞「已注册」竞态：没有本轮 handle，无法在将来注销这条路由。
      // 依赖 registerAdapterIdempotent 的幂等语义保留旧路由；把新配置写回
      // 本轮适配器，使其至少与当前设置一致。该路由归上一轮 fiber 所有。
      deps.warn?.(
        `[custom-provider] 路由 "${id}" 已由上一轮注册持有（无注销句柄），`
        + '已按幂等语义保留旧路由并更新本轮配置',
      )
    }
    registry.set(id, { adapter, handle })
  }

  const result = new Map<string, LlmAdapter>()
  for (const [id, registration] of registry) result.set(id, registration.adapter)
  return result
}
