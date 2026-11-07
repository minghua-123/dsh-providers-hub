/**
 * 适配器幂等注册。
 *
 * 精简版不再叠加 Token 记账、失效模型剔除与图片作用域包装：那些层服务于
 * 已移除的多渠道账号池。保留函数名与签名，使三个适配器共用同一条注册路径，
 * 也让「重复注册」这一竞态只在一个地方处理。
 */

import type { Context } from '@deepseek-ai/cordis'

/** `ctx.llm` 的最小结构契约。 */
export interface AdapterRegisterTarget {
  registerAdapter(providers: readonly string[], adapter: unknown): unknown
}

/** 判定宿主抛出的「路由已注册」错误，只认可辨识的形态。 */
function isDuplicateRegistrationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /duplicate|already.*(registered|exists)|已注册|EEXIST/i.test(`${error.name} ${error.message}`)
}

/**
 * 幂等注册一个适配器。
 *
 * 返回宿主给出的注册句柄（可能是可注销对象）；撞「已注册」时返回 undefined
 * 并保留已有路由，绝不吞掉其它类型的异常。
 */
export function registerAdapterIdempotent(
  llm: AdapterRegisterTarget,
  providers: readonly string[],
  adapter: unknown,
  warn?: (message: string) => void,
  _pruning?: { enabled?: boolean },
): unknown {
  try {
    return llm.registerAdapter(providers, adapter)
  } catch (error) {
    if (!isDuplicateRegistrationError(error)) throw error
    warn?.(
      `[llm-register] 路由 ${providers.map((p) => `"${p}"`).join(', ')} 已注册，保留现有路由并跳过本次注册`,
    )
    return undefined
  }
}

/** 从 ctx 或 llm 服务取出注册目标。 */
export function registerTargetOf(llm: AdapterRegisterTarget | Context): AdapterRegisterTarget {
  const candidate = llm as AdapterRegisterTarget
  if (typeof candidate.registerAdapter === 'function') return candidate
  return (llm as Context).llm as unknown as AdapterRegisterTarget
}
