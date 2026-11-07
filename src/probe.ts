/**
 * 连通性探活：供应商级与单模型级。
 *
 * 三类 provider 共用同一套入口：
 * - `opencode`：本机客户端桥 `ensure()` + 一次最小 `turn()`；
 * - `modelscope`：官方 OpenAI 兼容端点发一次非流式最小 chat；
 * - 自定义供应商：复用 `testCustomProvider()`，指定模型时把该 id 写进请求体。
 *
 * 纪律：任何失败都返回 `ok:false`，**绝不把失败包成成功**；服务端原文与异常
 * 文案先擦掉可能回显的 API Key；fetcher / bridge / 时钟均可注入便于单测。
 */

import { modelscopeChatUrl, modelscopeHeaders } from './modelscope.js'
import { MODELSCOPE_FALLBACK_MODELS } from './modelscope-product.js'
import { errorDetailForClassify } from './openai-compat.js'
import {
  classifyCustomHttpError,
  type CustomFetcher,
} from './custom-provider-protocols.js'
import { testCustomProvider } from './custom-provider-store.js'
import type { CustomProviderConfig } from './custom-provider-types.js'
import type { OpencodeTurnInput, OpencodeTurnResult } from './opencode-bridge.js'

/** 探活结果。业务失败也走 `value.ok === false`，不抛给 RPC 层。 */
export interface ProbeResult {
  ok: boolean
  status: number
  model: string
  message: string
  elapsedMs: number
}

/** 桥的最小契约（真实 `OpencodeBridge` 与测试替身都满足）。 */
export interface OpencodeBridgeLike {
  ensure(): Promise<string>
  turn(input: OpencodeTurnInput): Promise<OpencodeTurnResult>
}

export interface ProbeDeps {
  modelscopeApiKey: string
  modelscopeModelIds?: () => Promise<readonly string[]>
  opencodeBridge?: OpencodeBridgeLike
  opencodeModelIds?: () => Promise<readonly string[]>
  customProviders: readonly CustomProviderConfig[]
  fetcher?: CustomFetcher
  now?: () => number
}

const PROBE_TIMEOUT_MS = 20_000

function scrub(text: string, key: string): string {
  return key.length > 0 ? text.split(key).join('****') : text
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function finish(
  ok: boolean,
  status: number,
  model: string,
  message: string,
  started: number,
  deps: ProbeDeps,
): ProbeResult {
  return {
    ok,
    status,
    model,
    message,
    elapsedMs: Math.max(0, (deps.now?.() ?? Date.now()) - started),
  }
}

/** 供应商级测试取「第一个可用模型」；没有模型时明确失败，不用占位 id 蒙混。 */
async function firstModelOf(providerId: string, deps: ProbeDeps): Promise<string | undefined> {
  if (providerId === 'modelscope') {
    const ids = deps.modelscopeModelIds
      ? await deps.modelscopeModelIds()
      : MODELSCOPE_FALLBACK_MODELS.map((entry) => entry.id)
    return ids[0]
  }
  if (providerId === 'opencode') {
    const ids = deps.opencodeModelIds ? await deps.opencodeModelIds() : []
    return ids[0]
  }
  return deps.customProviders.find((config) => config.id === providerId)?.models[0]?.id
}

/** 供应商级：自动挑一个可用模型发一次最小请求，并在文案里标出用的是哪个模型。 */
export async function probeProvider(providerId: string, deps: ProbeDeps): Promise<ProbeResult> {
  const started = deps.now?.() ?? Date.now()
  if (providerId.trim().length === 0) {
    return finish(false, 0, '', '缺少供应商 id', started, deps)
  }
  let model: string | undefined
  try {
    model = await firstModelOf(providerId, deps)
  } catch (error) {
    return finish(false, 0, '', `目录读取失败：${errorText(error)}`, started, deps)
  }
  if (model === undefined || model.length === 0) {
    return finish(false, 0, '', `供应商 ${providerId} 没有可用于测试的模型`, started, deps)
  }
  const result = await probeModel(providerId, model, deps)
  return { ...result, message: `供应商级（${model}）：${result.message}` }
}

/** 单模型级：把指定 model 写进真实请求，验证该模型确实可调用。 */
export async function probeModel(
  providerId: string,
  model: string,
  deps: ProbeDeps,
): Promise<ProbeResult> {
  const started = deps.now?.() ?? Date.now()
  if (providerId.trim().length === 0 || model.trim().length === 0) {
    return finish(false, 0, model, '缺少供应商 id 或模型 id', started, deps)
  }
  try {
    if (providerId === 'modelscope') return await probeModelscope(model, deps, started)
    if (providerId === 'opencode') return await probeOpencode(model, deps, started)

    const config = deps.customProviders.find((entry) => entry.id === providerId)
    if (config === undefined) {
      return finish(false, 0, model, `找不到自定义供应商 ${providerId}`, started, deps)
    }
    const result = await testCustomProvider(config, { fetcher: deps.fetcher }, model)
    return finish(
      result.ok,
      result.status,
      model,
      scrub(result.message, config.apiKey),
      started,
      deps,
    )
  } catch (error) {
    return finish(false, 0, model, `请求失败：${errorText(error)}`, started, deps)
  }
}

async function probeModelscope(
  model: string,
  deps: ProbeDeps,
  started: number,
): Promise<ProbeResult> {
  const key = deps.modelscopeApiKey.trim()
  if (key.length === 0) {
    return finish(false, 0, model, '魔搭 API Key 未配置，请先在设置页保存密钥', started, deps)
  }
  const fetcher: CustomFetcher = deps.fetcher ?? ((url, init) => fetch(url, init))
  const response = await fetcher(modelscopeChatUrl(), {
    method: 'POST',
    headers: modelscopeHeaders(key, 'application/json'),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16,
      stream: false,
    }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  if (response.ok) {
    return finish(true, response.status, model, '连通性验证通过', started, deps)
  }
  const code = classifyCustomHttpError(response.status, text)
  const detail = errorDetailForClassify(text).slice(0, 200)
  return finish(
    false,
    response.status,
    model,
    scrub(`HTTP ${response.status}（${code}）：${detail.length > 0 ? detail : '(空响应体)'}`, key),
    started,
    deps,
  )
}

async function probeOpencode(
  model: string,
  deps: ProbeDeps,
  started: number,
): Promise<ProbeResult> {
  const bridge = deps.opencodeBridge
  if (bridge === undefined) {
    return finish(false, 0, model, '本机 OpenCode 客户端桥不可用', started, deps)
  }
  await bridge.ensure()
  const result = await bridge.turn({
    model,
    system: '',
    prompt: 'ping',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  const length = typeof result?.text === 'string' ? result.text.length : 0
  return finish(true, 200, model, `客户端桥已就绪，最小对话返回 ${length} 字符`, started, deps)
}
