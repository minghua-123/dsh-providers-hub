/**
 * Jet Hub 管理 RPC（精简版）。
 *
 * 宿主通过 `connection.fetch.register('/api/jet-hub')` 暴露单一 POST 端点，
 * 客户端经 `connection.rpc.call('/api', 'jet-hub', { method, payload })` 调用。
 * 只保留精简版设置页需要的方法；未知方法一律返回 `ok:false`，绝不把失败
 * 包成成功响应。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LiteState, PluginState } from './plugin-state.js'
import { PROVIDER_REGISTRY } from './provider-registry.js'
import {
  describeCatalog,
  discoverOpencodeModels,
  type DiscoverOpencodeModelsOptions,
  type OpencodeModelRecord,
} from './opencode-discovery.js'
import {
  fetchRemoteModels,
  maskApiKey,
  maskCustomProvider,
  normalizeCustomProviders,
  testCustomProvider,
} from './custom-provider-store.js'
import { readAccountStatus } from './opencode-account.js'
import { probeModel, probeProvider, type ProbeDeps } from './probe.js'
import {
  applyGatewayDesiredState,
  gatewayAddress,
  gatewayApiKey,
  gatewayDesiredEnabled,
  gatewayLastError,
  isGatewayRunning,
  setGatewayDesiredEnabled,
} from './openai-gateway/runtime.js'

export const JET_HUB_API_PATH = '/api/jet-hub'
const JET_HUB_ENDPOINT = 'jet-hub'

export interface JetHubRpcDeps {
  state: PluginState
  /** 目录刷新后把最新快照回填给 opencode 适配器。 */
  onCatalog: (rows: readonly OpencodeModelRecord[]) => void
  /** 状态变更后同步到各适配器（重新注册自定义供应商、更新魔搭 Key、模型启停）。 */
  applyState: (state: LiteState) => void
  /** 目录发现选项（缓存路径由接线层注入）。 */
  discovery: DiscoverOpencodeModelsOptions
  warn: (message: string) => void
  /** 每次探活都重新取一份依赖，确保读到的是最新 Key / 最新自定义供应商配置。 */
  probes: () => ProbeDeps
  /** 魔搭全量目录行（含 disabled 标记）；启停只影响 listModels 的显示列表。 */
  modelscopeCatalog: () => Promise<readonly { id: string; name: string; disabled: boolean }[]>
}

interface RpcCall {
  method: string
  payload: Record<string, unknown>
}

function reply(rpcId: string, result: unknown): Response {
  return Response.json({ type: 'server-response', rpcId, result })
}

function ok(value: unknown): { ok: true; value: unknown } {
  return { ok: true, value }
}

function fail(code: string, message: string): { ok: false; error: { code: string; message: string; details: Record<string, never> } } {
  return { ok: false, error: { code, message, details: {} } }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** 注册管理端点。connection 缺席的 headless profile 只记一条日志，不影响推理。 */
export function registerJetHubRpc(ctx: Context, deps: JetHubRpcDeps): void {
  ctx.inject(['connection'], (injected) => {
    const connection = (injected as unknown as { connection?: unknown }).connection
      ?? (ctx as unknown as { connection?: unknown }).connection
      ?? safeGet(ctx, 'connection')
    if (!connection || typeof (connection as { fetch?: { register?: unknown } }).fetch?.register !== 'function') {
      deps.warn('[jet-hub] connection.fetch 不可用，管理端点未注册')
      return
    }

    const handle = async (call: RpcCall): Promise<unknown> => {
      const { state } = deps
      const payload = call.payload

      /**
       * 设置页回传的是打码结果。编辑态里留空或原样带回掩码串都表示「保留原值」，
       * 绝不能把掩码串写成真 Key；模型列表同理，空列表表示沿用已有条目。
       */
      const resolveConfig = (): Record<string, unknown> => {
        const raw = { ...asRecord(payload.config) }
        const existing = state.snapshot().customProviders.find((item) => item.id === asString(raw.id))
        if (existing !== undefined) {
          const key = asString(raw.apiKey)
          if (key.length === 0 || key.includes('****')) raw.apiKey = existing.apiKey
          if (!Array.isArray(raw.models) || raw.models.length === 0) raw.models = existing.models
        }
        return raw
      }

      switch (call.method) {
        case 'provider.status':
          return ok({
            providers: PROVIDER_REGISTRY.map((entry) => ({
              id: entry.id,
              label: entry.label,
              displayName: entry.displayName,
              channel: entry.channel,
              credits: entry.credits,
            })),
          })

        case 'state.get':
          return ok({
            customProviders: maskCustomProvider(state.snapshot().customProviders),
            opencodeDisabledModels: state.snapshot().opencodeDisabledModels,
            opencodeIncludeDeprecated: state.snapshot().opencodeIncludeDeprecated,
            modelscopeKeyMasked: maskApiKey(state.snapshot().modelscopeApiKey),
            modelscopeDisabledModels: state.snapshot().modelscopeDisabledModels,
          })

        case 'opencode.catalog': {
          const result = await discoverOpencodeModels(deps.discovery)
          const snapshot = state.snapshot()
          const rows = describeCatalog(
            result.catalog,
            [],
            snapshot.opencodeDisabledModels,
            { includeDeprecated: snapshot.opencodeIncludeDeprecated },
          )
          deps.onCatalog(result.catalog)
          return ok({
            rows,
            syncedAt: result.syncedAt,
            reason: result.reason,
            assumeAvailable: result.assumeAvailable,
            error: result.error,
            includeDeprecated: snapshot.opencodeIncludeDeprecated,
          })
        }

        case 'opencode.sync': {
          const result = await discoverOpencodeModels({ ...deps.discovery, force: true })
          deps.onCatalog(result.catalog)
          return ok({ syncedAt: result.syncedAt, reason: result.reason, error: result.error })
        }

        case 'opencode.setDisabled': {
          const ids = Array.isArray(payload.disabledModels)
            ? payload.disabledModels.filter((item): item is string => typeof item === 'string')
            : []
          const next = state.update({ opencodeDisabledModels: ids }, deps.warn)
          deps.applyState(next)
          return ok({ disabledModels: next.opencodeDisabledModels })
        }

        case 'opencode.setIncludeDeprecated': {
          const next = state.update({ opencodeIncludeDeprecated: payload.enabled === true }, deps.warn)
          deps.applyState(next)
          return ok({ includeDeprecated: next.opencodeIncludeDeprecated })
        }

        case 'opencode.account':
          return ok(readAccountStatus())

        case 'custom.list':
          return ok({ providers: maskCustomProvider(state.snapshot().customProviders) })

        case 'custom.upsert': {
          const normalized = normalizeCustomProviders([resolveConfig()])
          if (normalized.length !== 1) {
            return fail('jet-hub/invalid-config', '自定义供应商配置非法：id 需为小写字母开头的字母数字串、不得占用保留 id，baseURL 需为合法的 http(s) 地址')
          }
          const next = state.upsertProvider(normalized[0], deps.warn)
          deps.applyState(next)
          return ok({ providers: maskCustomProvider(next.customProviders) })
        }

        case 'custom.remove': {
          const id = asString(payload.id)
          if (id.length === 0) return fail('jet-hub/invalid-config', '缺少要删除的供应商 id')
          const next = state.removeProvider(id, deps.warn)
          deps.applyState(next)
          return ok({ providers: maskCustomProvider(next.customProviders) })
        }

        case 'custom.test': {
          const candidates = normalizeCustomProviders([resolveConfig()])
          if (candidates.length !== 1) return fail('jet-hub/invalid-config', '待测试的供应商配置非法')
          return ok(await testCustomProvider(candidates[0]))
        }

        case 'custom.fetchModels': {
          const candidates = normalizeCustomProviders([resolveConfig()])
          if (candidates.length !== 1) return fail('jet-hub/invalid-config', '待拉取目录的供应商配置非法')
          return ok(await fetchRemoteModels(candidates[0]))
        }

        case 'modelscope.status': {
          const key = state.snapshot().modelscopeApiKey
          return ok({ configured: key.length > 0, keyMasked: maskApiKey(key) })
        }

        case 'modelscope.setApiKey': {
          const next = state.update({ modelscopeApiKey: asString(payload.apiKey) }, deps.warn)
          deps.applyState(next)
          return ok({ configured: next.modelscopeApiKey.length > 0 })
        }

        case 'modelscope.catalog':
          return ok({ rows: await deps.modelscopeCatalog() })

        case 'modelscope.setDisabled': {
          const ids = Array.isArray(payload.disabledModels)
            ? payload.disabledModels.filter((item): item is string => typeof item === 'string')
            : []
          const next = state.update({ modelscopeDisabledModels: ids }, deps.warn)
          deps.applyState(next)
          return ok({ disabledModels: next.modelscopeDisabledModels })
        }

        case 'probe.provider': {
          const provider = asString(payload.provider)
          if (provider.length === 0) return fail('jet-hub/invalid-config', '缺少供应商 id')
          return ok(await probeProvider(provider, deps.probes()))
        }

        case 'probe.model': {
          const provider = asString(payload.provider)
          const model = asString(payload.model)
          if (provider.length === 0 || model.length === 0) {
            return fail('jet-hub/invalid-config', '缺少供应商 id 或模型 id')
          }
          return ok(await probeModel(provider, model, deps.probes()))
        }

        case 'gateway.status': {
          const address = gatewayAddress()
          const key = gatewayApiKey()
          return ok({
            desired: gatewayDesiredEnabled(),
            running: isGatewayRunning(),
            address,
            apiKeyMasked: maskApiKey(typeof key?.value === 'string' ? key.value : ''),
            lastError: gatewayLastError(),
          })
        }

        case 'gateway.setEnabled': {
          setGatewayDesiredEnabled(payload.enabled !== false)
          await applyGatewayDesiredState()
          return ok({ desired: gatewayDesiredEnabled(), running: isGatewayRunning() })
        }

        default:
          return fail('jet-hub/unknown-method', `未知的管理端点：${call.method}`)
      }
    }

    ;(connection as { fetch: { register: (route: unknown) => void } }).fetch.register({
      path: JET_HUB_API_PATH,
      methods: ['POST'],
      requestBody: 'buffered' as const,
      async fetch(request: Request): Promise<Response> {
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
        const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
        if (contentType !== 'application/json') return new Response('content type must be application/json', { status: 415 })

        let message: Record<string, unknown>
        try {
          message = await request.json() as Record<string, unknown>
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
        const call = asRecord(message.payload)
        if (
          message.type !== 'client-request'
          || message.method !== JET_HUB_ENDPOINT
          || typeof call.method !== 'string'
        ) {
          return reply(rpcId, fail('gateway/bad-request', 'Invalid Jet Hub management request.'))
        }
        try {
          const result = await handle({ method: call.method, payload: asRecord(call.payload) })
          return reply(rpcId, result)
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          deps.warn(`[jet-hub] ${call.method} 失败: ${text}`)
          return reply(rpcId, fail(
            (error as NodeJS.ErrnoException)?.code ?? 'jet-hub/handler-failed',
            text,
          ))
        }
      },
    })
  })
}

function safeGet(ctx: Context, key: string): unknown {
  const getter = (ctx as unknown as { get?: (name: string) => unknown }).get
  return typeof getter === 'function' ? getter.call(ctx, key) : undefined
}
