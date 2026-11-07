/**
 * OpenCode 连通性探活：供应商级与单模型级。
 *
 * - 供应商级：取当前承接列表里的第一个免费档模型，发一次最小对话；
 * - 单模型级：把指定模型 id 传进 `bridge.turn()`，验证该模型确实可调用。
 *
 * 纪律：任何失败都返回 `ok:false`，**绝不把失败包成成功**；bridge / 目录 /
 * 时钟均可注入便于单测。测试会向本机 OpenCode 客户端发送一次最小请求，
 * 可能消耗免费档额度，故只由用户在设置页主动触发。
 */

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
  opencodeBridge?: OpencodeBridgeLike
  opencodeModelIds?: () => Promise<readonly string[]>
  now?: () => number
}

const PROBE_TIMEOUT_MS = 20_000

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

/** 只承接 opencode；传入其它 id 一律明确失败，不静默忽略。 */
function assertOpencode(providerId: string): string | undefined {
  return providerId === 'opencode' ? undefined : `仅支持 opencode 渠道，收到 ${providerId || '(空)'}`
}

/** 供应商级：自动挑一个可用模型发一次最小请求，并在文案里标出用的是哪个模型。 */
export async function probeProvider(providerId: string, deps: ProbeDeps): Promise<ProbeResult> {
  const started = deps.now?.() ?? Date.now()
  const rejected = assertOpencode(providerId)
  if (rejected !== undefined) return finish(false, 0, '', rejected, started, deps)

  let model: string | undefined
  try {
    model = (await deps.opencodeModelIds?.())?.[0]
  } catch (error) {
    return finish(false, 0, '', `目录读取失败：${errorText(error)}`, started, deps)
  }
  if (model === undefined || model.length === 0) {
    return finish(false, 0, '', '当前没有可用于测试的免费档模型', started, deps)
  }
  const result = await probeModel(providerId, model, deps)
  return { ...result, message: `供应商级（${model}）：${result.message}` }
}

/** 单模型级：把指定 model 传进真实 `turn()`，验证该模型确实可调用。 */
export async function probeModel(
  providerId: string,
  model: string,
  deps: ProbeDeps,
): Promise<ProbeResult> {
  const started = deps.now?.() ?? Date.now()
  const rejected = assertOpencode(providerId)
  if (rejected !== undefined) return finish(false, 0, model, rejected, started, deps)
  if (model.trim().length === 0) {
    return finish(false, 0, model, '缺少模型 id', started, deps)
  }

  const bridge = deps.opencodeBridge
  if (bridge === undefined) {
    return finish(false, 0, model, '本机 OpenCode 客户端桥不可用', started, deps)
  }
  try {
    await bridge.ensure()
    const result = await bridge.turn({
      model,
      system: '',
      prompt: 'ping',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const length = typeof result?.text === 'string' ? result.text.length : 0
    return finish(true, 200, model, `客户端桥已就绪，最小对话返回 ${length} 字符`, started, deps)
  } catch (error) {
    return finish(false, 0, model, `请求失败：${errorText(error)}`, started, deps)
  }
}
