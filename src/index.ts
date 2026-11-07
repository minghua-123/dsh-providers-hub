/**
 * 插件宿主入口（精简版）。
 *
 * 只注册三条腿：
 * 1. `opencode` —— 本机官方客户端桥，只承接 Zen 免费档模型；
 * 2. `modelscope` —— 魔搭社区官方接入（静态 API Key + OpenAI 兼容）；
 * 3. 自定义供应商 —— 用户在设置页新增的每个实例各占一条路由，
 *    支持 OpenAI Chat Completions（默认）/ OpenAI Responses / Anthropic Messages。
 *
 * 其余多渠道账号池、签到、积分、聚合路由、供应商专属反代已整体移除。
 * 本机 OpenAI 兼容网关保留：它按 `llm.listProviders()` 动态枚举，无需清单。
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { registerOpencodeLlm } from './opencode-adapter.js'
import type { OpencodeModelRecord } from './opencode-discovery.js'
import { registerModelscopeLlm } from './modelscope-adapter.js'
import { registerCustomProviders } from './custom-provider-adapter.js'
import { CustomProvidersSchema } from './custom-provider-store.js'
import type { CustomProviderRegisterDeps } from './custom-provider-adapter.js'
import type { AdapterRegisterTarget } from './llm-register-compat.js'
import { PluginState, type LiteState } from './plugin-state.js'
import type { ProbeDeps } from './probe.js'
import { registerJetHubRpc } from './jet-hub-rpc.js'
import { mountOpenAiGateway } from './openai-gateway/index.js'
import { suppressAutoSettingsPage } from './settings-compat.js'

/** profile 条目 id 是稳定锚点，与包名无关，不得改动。 */
export const name = 'codearts-auth'
export const inject = ['credentials', 'commands', 'llm']

/**
 * 配置形状（schemastery）。运行期状态由 `PluginState` 统一读写：
 * 宿主下发的初值仅在冷启动时使用，之后以插件自有状态文档为准。
 */
export const Config = Schema.object({
  providers: Schema.dict(Schema.any()).default({}).volatile(),
  customProviders: CustomProvidersSchema.default({ providers: [] }).volatile(),
  opencodeDisabledModels: Schema.array(Schema.string()).default([]).volatile(),
  opencodeIncludeDeprecated: Schema.boolean().default(false).volatile(),
  modelscopeApiKey: Schema.string().default('').volatile(),
  modelscopeDisabledModels: Schema.array(Schema.string()).default([]).volatile(),
})

/**
 * Cordis 以 `apply(ctx, config)` 调用插件（`runtime.callback(this.ctx, this.config)`）。
 * 配置必须由**第二个参数**取用：`ctx.config` 不是已注入的服务，直接读会让
 * Context 代理抛 `cannot get property "config" without inject`，整个插件无法激活。
 */
export function apply(ctx: Context, config?: unknown): void {
  suppressAutoSettingsPage(ctx)

  const warn = (message: string): void => { ctx.logger?.warn?.(message) }
  const state = new PluginState(ctx, config)
  const initial = state.snapshot()

  // 目录缓存与状态文档落在同一个 DSH home 下，避免两个目录各自漂移。
  const homeDir = state.homeDir()
  const discovery = {
    ...(homeDir === undefined ? {} : { cachePath: join(homeDir, 'opencode-zen-catalog.json') }),
  }

  // opencode：只列免费模型。disabledModels / includeDeprecated 用**可变引用**传入，
  // 状态变更时就地替换内容，适配器每次读到的都是最新集合。
  const disabledModels: string[] = [...initial.opencodeDisabledModels]
  let includeDeprecated = initial.opencodeIncludeDeprecated
  const opencodeAdapter = registerOpencodeLlm(ctx, {
    discovery,
    disabledModels,
    get includeDeprecated(): boolean { return includeDeprecated },
    warn,
  })

  const modelscopeAdapter = registerModelscopeLlm(ctx, {
    apiKey: initial.modelscopeApiKey,
    warn,
    readImage: makeReadImage(ctx),
  })
  modelscopeAdapter.setDisabledModels(initial.modelscopeDisabledModels)

  const llm = ctx.llm as unknown as AdapterRegisterTarget
  const customDeps: CustomProviderRegisterDeps = { warn }
  registerCustomProviders(llm, initial.customProviders, customDeps)

  /** 状态变更 → 同步到三条腿。由 RPC 在每次写盘后显式调用。 */
  const applyState = (next: LiteState): void => {
    disabledModels.splice(0, disabledModels.length, ...next.opencodeDisabledModels)
    includeDeprecated = next.opencodeIncludeDeprecated
    modelscopeAdapter.setApiKey(next.modelscopeApiKey)
    modelscopeAdapter.setDisabledModels(next.modelscopeDisabledModels)
    registerCustomProviders(llm, next.customProviders, customDeps)
  }

  /** 每次探活重新取依赖：Key、模型启停与自定义供应商配置都可能是刚改过的。 */
  const probeDeps = (): ProbeDeps => {
    const snapshot = state.snapshot()
    return {
      modelscopeApiKey: snapshot.modelscopeApiKey,
      modelscopeModelIds: () => modelscopeAdapter.enabledModelIds(),
      opencodeBridge: opencodeAdapter.bridgeHandle(),
      opencodeModelIds: () => opencodeAdapter.listServeableModelIds(),
      customProviders: snapshot.customProviders,
    }
  }

  registerJetHubRpc(ctx, {
    state,
    discovery,
    applyState,
    warn,
    probes: probeDeps,
    modelscopeCatalog: () => modelscopeAdapter.catalogRows(),
    onCatalog: (rows: readonly OpencodeModelRecord[]): void => {
      opencodeAdapter.setCatalog(rows)
    },
  })

  // 网关是旁路：内部已自行降级，不传账号池（精简版没有账号池）。
  mountOpenAiGateway(ctx)
}

/**
 * 图片附件桥接：把持久化图片读成原始字节供适配器内联。
 * 附件服务缺失时返回 undefined，适配器据此明确降级为文本，不谎报图片能力。
 */
function makeReadImage(ctx: Context) {
  return async (attachment: unknown): Promise<{ data: Uint8Array; mediaType: string }> => {
    const service = (ctx as unknown as {
      get?: (name: string) => unknown
    }).get?.call(ctx, 'attachments') as {
      read?: (value: unknown) => Promise<{ data: Uint8Array; mediaType: string }>
    } | undefined
    if (typeof service?.read !== 'function') {
      throw new Error('未装载附件服务，无法读取图片')
    }
    return service.read(attachment)
  }
}
