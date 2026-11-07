/**
 * OpenCode Zen 免费模型适配器 —— **唯一路由 = 本机 bridge**。
 *
 * ## 设计
 *
 * 插件不配 Key、不构造推理请求、不做匿名认证；`stream()` 把宿主请求拍成一段
 * 文本交给 {@link OpencodeBridge.turn}，由本机真实 `opencode serve` 代发。
 * 宿主工具通过 system 里的 HOST TOOLS 文本协议（{@link toolProtocolOf}）声明，
 * 模型以 `{kind:'tool'|'final',...}` JSON 应答（{@link parseProtocol}）。
 *
 * 模型目录由 `opencode-discovery.ts` 的双源发现提供（只列免费模型），
 * `manualModels` / `disabledModels` 经 `buildModelSet` 应用。
 *
 * ## ⚠️ 包装适配器包的是 `prepareCall` 返回的 `stream`
 *
 * `llm-register-compat.ts` 的记账与失效剔除包装显式拦截 `prepareCall` 返回的
 * `call.stream`（生产路径 `adapterStream` 只调它，从不调顶层 `stream`）。
 * 因此本适配器的 `prepareCall` 必须返回 `stream: (o) => this.stream(o)`，
 * 且 `stream` 内不得依赖 `this` 落在 Proxy 上的隐式绑定。
 *
 * ## ⚠️ 错误码
 *
 * 额度类错误对外用**字面量** `'QUOTA_EXCEEDED'`（不用 harness 的
 * `QUOTA_EXCEEDED_CODE`，其字面值是 `'QUOTA'`，会让客户端丢掉 message）；
 * 免费档/升级类拒绝一律避开 `'AUTH'` 码（同样会连 message 一起吞掉），
 * 改用 `'PERMISSION_DENIED'`。
 *
 * @module src/opencode-adapter.ts
 */

import { randomUUID } from 'node:crypto'
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import {
  OpencodeBridge,
  parseProtocol,
  toolProtocolOf,
  transcriptOf,
  type OpencodeBridgeOptions,
  type OpencodeTurnResult,
  type ProtocolTool,
  type TranscriptMessage,
} from './opencode-bridge.js'
import {
  buildModelSet,
  discoverOpencodeModels,
  serveableModels,
  type DiscoverOpencodeModelsOptions,
  type OpencodeManualModel,
  type OpencodeModelRecord,
  type OpencodeServeModel,
} from './opencode-discovery.js'
import { OPENCODE, OPENCODE_FALLBACK_MODELS } from './opencode-product.js'
import { registerAdapterIdempotent, type AdapterRegisterTarget } from './llm-register-compat.js'

/** 思考档位（仅 `reasoning === true` 的模型声明，供选择器与请求校验）。 */
const REASONING_EFFORTS: readonly { id: string; name: string }[] = [
  { id: 'off', name: '关闭' },
  { id: 'low', name: '轻量思考' },
  { id: 'high', name: '深度思考' },
  { id: 'max', name: '极限思考' },
]

/** 适配器构造选项。 */
export interface OpencodeAdapterOptions {
  /** 直接注入已构造的 bridge（便于单测，不 fork 真实进程）。 */
  bridge?: OpencodeBridge
  /** 未注入 bridge 时构造它所用的选项。 */
  bridgeOptions?: OpencodeBridgeOptions
  /** 目录发现选项（缓存路径可注入）。 */
  discovery?: DiscoverOpencodeModelsOptions
  /** 直接注入目录快照（跳过网络发现，便于单测/嵌入）。 */
  catalog?: readonly OpencodeModelRecord[]
  /** 手动添加的模型。 */
  manualModels?: readonly OpencodeManualModel[]
  /** 停用的模型 id。 */
  disabledModels?: readonly string[]
  /** 是否把弃用条目也纳入承接集合。 */
  includeDeprecated?: boolean
  /** 诊断日志。 */
  warn?: (message: string) => void
}

/** 一次 `bridge.turn` 失败到 DSH 错误码的映射结果。 */
function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) {
    const status = error.failure?.status
    const retryAfterMs = error.failure?.providerRetryAfterMs
    const facts = {
      ...(status !== undefined ? { status } : {}),
      ...(retryAfterMs !== undefined ? { providerRetryAfterMs: retryAfterMs } : {}),
    }
    // ⚠️ 额度错误码必须字面量 'QUOTA_EXCEEDED'，不能用 harness 常量。
    if (error.code === 'RATE_LIMITED') {
      return new LlmError(error.message, 'QUOTA_EXCEEDED', facts)
    }
    // ⚠️ 避开 AUTH 码（客户端会连 message 一起吞掉）。
    if (error.code === 'FREE_TIER_REFUSED' || error.code === 'UPGRADE_REQUIRED') {
      return new LlmError(error.message, 'PERMISSION_DENIED', facts)
    }
    return error
  }
  return new LlmError(
    `opencode: ${error instanceof Error ? error.message : String(error)}`,
    'SERVER',
  )
}

/** 计算 usage chunk（用量形状来自客户端，宽松归一）。 */
function usageOf(result: OpencodeTurnResult): TokenUsage {
  const input = Number(result.usage?.input ?? 0)
  const output = Number(result.usage?.output ?? 0)
  return {
    inputTokens: Number.isFinite(input) && input > 0 ? Math.trunc(input) : 0,
    outputTokens: Number.isFinite(output) && output > 0 ? Math.trunc(output) : 0,
  }
}

/** 把一段文本摊成标准 `text` 块序列。 */
async function* textChunks(text: string, index: number): AsyncIterable<StreamChunk> {
  if (text.length === 0) return
  yield { type: 'block-start', index, blockType: 'text' }
  yield { type: 'text-delta', index, text }
  yield { type: 'block-end', index, block: { type: 'text', text } }
}

export class OpencodeAdapter extends LlmAdapter {
  /** 最近一次成功解析出的目录快照（仅供同步 `listAllModels()` 读取）。 */
  private lastCatalog?: readonly OpencodeModelRecord[]
  /** 懒启动并复用的 bridge 实例。 */
  private bridgeInstance?: OpencodeBridge

  constructor(private readonly options: OpencodeAdapterOptions) {
    super()
  }

  /** 运行期注入目录快照（宿主完成双源同步后调用，语义同参考实现的 `setModels`）。 */
  setCatalog(records: readonly OpencodeModelRecord[]): void {
    this.lastCatalog = records
    this.options.catalog = records
  }

  /** 取当前承接的模型集（目录 + 手动条目 − 停用条目 − 不在供/弃用）。 */
  private async serveModels(): Promise<readonly OpencodeServeModel[]> {
    let catalog: readonly OpencodeModelRecord[]
    if (this.options.catalog !== undefined) {
      catalog = this.options.catalog
    } else {
      const result = await discoverOpencodeModels(this.options.discovery)
      if (result.error !== undefined) this.options.warn?.(`opencode: 目录发现降级 —— ${result.error}`)
      catalog = result.catalog
    }
    this.lastCatalog = catalog
    const live = serveableModels(catalog, { includeDeprecated: this.options.includeDeprecated === true })
    return buildModelSet(live, this.options.manualModels, this.options.disabledModels, {
      ...(this.options.discovery?.defaultContextWindow === undefined
        ? {}
        : { defaultContextWindow: this.options.discovery.defaultContextWindow }),
    })
  }

  /** 后台预热一次目录；失败静默（兜底表已保证 UI 可用）。 */
  private async warmCatalog(): Promise<void> {
    try {
      await this.serveModels()
    } catch {
      // 兜底表已保证可用。
    }
  }

  /** 懒启动 bridge（不主动 `ensure`，`turn()` 内部会确保就绪）。 */
  private bridge(): OpencodeBridge {
    if (this.options.bridge !== undefined) {
      this.bridgeInstance ??= this.options.bridge
      return this.bridgeInstance
    }
    this.bridgeInstance ??= new OpencodeBridge({
      ...(this.options.bridgeOptions ?? {}),
      log: this.options.bridgeOptions?.log ?? ((message) => this.options.warn?.(message)),
    })
    return this.bridgeInstance
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : OPENCODE.id
    return { id, name: OPENCODE.displayName }
  }

  /**
   * 完整目录（**同步**返回数组）。
   *
   * ⚠️ 绝不能写成 async：`jet-hub-rpc.ts` 的 `ModelCatalogSource` 是同步的且
   * 消费者不 await（`catalog = [...all]`），返回 Promise 会抛
   * `TypeError: all is not iterable`。故读上一轮缓存，缓存为空用兜底表并顺手预热。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const snapshot = this.lastCatalog
    if (snapshot !== undefined && snapshot.length > 0) {
      return snapshot.map((m) => ({ id: m.id, name: m.name }))
    }
    void this.warmCatalog()
    return OPENCODE_FALLBACK_MODELS.map((m) => ({ id: m.id, name: m.name }))
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.serveModels()
    return models.map((m) => ({
      provider: OPENCODE.id,
      id: m.id,
      name: m.name,
      ...(m.description.length > 0 ? { description: m.description } : {}),
      // 桥是纯文本通路：宿主工具走文本协议，图片不直接上行。
      inputModalities: ['text'] as const,
    }))
  }

  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const models = await this.serveModels()
    const found = models.find((m) => m.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: found?.name ?? model,
      ...(found !== undefined && found.description.length > 0
        ? { description: found.description }
        : {}),
      inputModalities: ['text'] as const,
    }
    if (found !== undefined && found.contextWindow > 0) {
      resolved.context = { contextWindow: found.contextWindow }
    }
    if (found !== undefined && found.maxTokens > 0) {
      resolved.defaultMaxTokens = found.maxTokens
    }
    // 只有推理模型声明档位：声明后显式指定档位才不会被网关以
    // UNSUPPORTED_REASONING_EFFORT 拒在门外。
    if (found?.reasoning === true) {
      resolved.reasoning = {
        efforts: REASONING_EFFORTS.map((effort) => ({
          id: ReasoningEffortId(effort.id),
          name: effort.name,
        })),
      }
    }
    return resolved
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return { model: await this.resolveModel(provider, model, signal), stream: (o) => this.stream(o) }
  }

  /**
   * 唯一路由：`bridge.turn()`。
   *
   * 把宿主 `system` + HOST TOOLS 协议作为正文的 system 段，把 `messages`
   * 序列化成 transcript；拿到文本答案后解析协议并转成 `StreamChunk` 序列。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) {
      throw new LlmError('opencode: 请求已被取消', 'ABORTED')
    }
    const bridge = this.bridge()
    const protocol = toolProtocolOf(options.tools as readonly ProtocolTool[] | undefined)
    const system = [options.system, protocol]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n\n')
    const prompt = transcriptOf(options.messages as unknown as readonly TranscriptMessage[])

    let result: OpencodeTurnResult
    try {
      result = await bridge.turn({
        model: options.model,
        system,
        ...(prompt.length > 0 ? { prompt } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      throw toLlmError(error)
    }
    if (options.signal?.aborted) {
      throw new LlmError('opencode: 请求已被取消', 'ABORTED')
    }

    const usage = usageOf(result)
    let index = 0

    // 工具模式下模型应答一个协议对象；解析失败不算失败，把原文当正文发出去，
    // 让宿主看到模型到底说了什么，也好过静默丢掉一整轮。
    const call = protocol.length > 0 ? parseProtocol(result.text) : null
    if (call?.kind === 'tool' && typeof call.name === 'string' && call.name.length > 0) {
      const id = ToolCallId(randomUUID())
      const args = JSON.stringify(call.args ?? {})
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const finalText = call?.kind === 'final' && typeof call.text === 'string' && call.text.length > 0
      ? call.text
      : result.text
    yield* textChunks(finalText, index)
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** 注册目标的最小形状（llm 服务本身）。 */
type LlmRegistrationTarget = Pick<AdapterRegisterTarget, 'registerAdapter'>

/**
 * 把传入值归一到 llm 注册目标。
 *
 * 既接受直接传入的 llm 服务（`ctx.llm`，带 `registerAdapter`），也接受整个
 * Cordis `Context`（读 `ctx.llm`）—— 仓库里两种调用形态都存在。
 */
function resolveRegisterTarget(llm: LlmRegistrationTarget | Context): AdapterRegisterTarget {
  if (typeof (llm as LlmRegistrationTarget).registerAdapter === 'function') {
    return llm as AdapterRegisterTarget
  }
  return (llm as Context).llm as unknown as AdapterRegisterTarget
}

/** 在 `ctx.llm`（或 llm 服务）上幂等注册 `['opencode']` 路由。 */
export function registerOpencodeLlm(
  llm: LlmRegistrationTarget | Context,
  options: OpencodeAdapterOptions,
): OpencodeAdapter {
  const adapter = new OpencodeAdapter(options)
  registerAdapterIdempotent(resolveRegisterTarget(llm), ['opencode'], adapter)
  return adapter
}
