/**
 * Jet Hub 管理 RPC（0.3.2 极简版）。
 *
 * 宿主通过 `connection.fetch.register('/api/jet-hub')` 暴露单一 POST 端点，
 * 客户端经 `connection.rpc.call('/api', 'jet-hub', { method, payload })` 调用。
 * 只保留 opencode 目录、逐模型启停、登录态与两级连通性测试；未知方法一律
 * 返回 `ok:false`，绝不把失败包成成功响应。
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
import { readAccountStatus } from './opencode-account.js'
import { probeModel, probeProvider, type ProbeDeps } from './probe.js'

export const JET_HUB_API_PATH = '/api/jet-hub'
const JET_HUB_ENDPOINT = 'jet-hub'

export interface JetHubRpcDeps {
  state: PluginState
  /** 目录刷新后把最新快照回填给 opencode 适配器。 */
  onCatalog: (rows: readonly OpencodeModelRecord[]) => void
  /** 状态变更后同步到适配器（逐模型启停、弃用显示开关）。 */
  applyState: (state: LiteState) => void
  /** 目录发现选项（缓存路径由接线层注入）。 */
  discovery: DiscoverOpencodeModelsOptions
  warn: (message: string) => void
  /** 每次探活都重新取一份依赖，确保用的是最新承接模型集合。 */
  probes: () => ProbeDeps
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
          return ok(state.snapshot())

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
