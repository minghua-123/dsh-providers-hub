/**
 * 插件宿主入口（0.3.2 极简版）。
 *
 * 只承接一条渠道：`opencode` —— 自 spawn 本机 OpenCode 官方客户端，
 * 经 `session.prompt` + 自定义 agent 承接 Zen 免费档模型。插件不配 Key、
 * 不构造推理 HTTP 请求、不维护账号池；本机客户端自身的登录态决定额度档位。
 *
 * 魔搭、自定义供应商框架、本机 OpenAI 兼容网关及其专属协议层已整体移除。
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { registerOpencodeLlm } from './opencode-adapter.js'
import type { OpencodeModelRecord } from './opencode-discovery.js'
import { PluginState, type LiteState } from './plugin-state.js'
import type { ProbeDeps } from './probe.js'
import { registerJetHubRpc } from './jet-hub-rpc.js'
import { suppressAutoSettingsPage } from './settings-compat.js'

/** profile 条目 id 是稳定锚点，与包名无关，不得改动。 */
export const name = 'codearts-auth'
export const inject = ['credentials', 'commands', 'llm']

/**
 * 配置形状（schemastery）。运行期状态由 `PluginState` 统一读写：
 * 宿主下发的初值仅在冷启动时使用，之后以插件自有状态文档为准。
 */
export const Config = Schema.object({
  opencodeDisabledModels: Schema.array(Schema.string()).default([]).volatile(),
  opencodeIncludeDeprecated: Schema.boolean().default(false).volatile(),
})

/**
 * Cordis 以 `apply(ctx, config)` 调用插件。配置必须由**第二个参数**取用：
 * `ctx.config` 不是已注入的服务，直接读会让 Context 代理抛
 * `cannot get property "config" without inject`，整个插件无法激活。
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

  // disabledModels / includeDeprecated 用**可变引用**传入，状态变更时就地替换内容，
  // 适配器每次读到的都是最新集合。
  const disabledModels: string[] = [...initial.opencodeDisabledModels]
  let includeDeprecated = initial.opencodeIncludeDeprecated
  const opencodeAdapter = registerOpencodeLlm(ctx, {
    discovery,
    disabledModels,
    get includeDeprecated(): boolean { return includeDeprecated },
    warn,
  })

  /** 状态变更 → 同步到适配器。由 RPC 在每次写盘后显式调用。 */
  const applyState = (next: LiteState): void => {
    disabledModels.splice(0, disabledModels.length, ...next.opencodeDisabledModels)
    includeDeprecated = next.opencodeIncludeDeprecated
  }

  /** 每次探活重新取依赖，确保读到的是最新的承接模型集合。 */
  const probeDeps = (): ProbeDeps => ({
    opencodeBridge: opencodeAdapter.bridgeHandle(),
    opencodeModelIds: () => opencodeAdapter.listServeableModelIds(),
  })

  registerJetHubRpc(ctx, {
    state,
    discovery,
    applyState,
    warn,
    probes: probeDeps,
    onCatalog: (rows: readonly OpencodeModelRecord[]): void => {
      opencodeAdapter.setCatalog(rows)
    },
  })
}
