/**
 * 渠道清单：本插件只承接 OpenCode 免费档桥一条渠道。
 *
 * 魔搭、自定义供应商、本机 OpenAI 兼容网关及其专属协议层已于 0.3.2 整体移除。
 * 本文件零 import：宿主侧与浏览器侧共用，不得引入运行时依赖或 `node:*`。
 */

export interface ProviderDescriptor {
  id: string
  label: string
  displayName: string
  logoClass: string
  /** 是否为可承接请求的真实渠道。 */
  channel: boolean
  credits: {
    balance: boolean
    dailyCheckin: boolean
  }
  settingsNamespace?: string
}

export const PROVIDER_REGISTRY: readonly ProviderDescriptor[] = Object.freeze([
  Object.freeze({
    id: 'opencode',
    label: 'OpenCode',
    displayName: 'OpenCode 免费档',
    logoClass: 'opencode',
    channel: true,
    credits: Object.freeze({ balance: false, dailyCheckin: false }),
  }),
])

/** 按 id 查描述符。 */
export function descriptorOf(id: string): ProviderDescriptor | undefined {
  return PROVIDER_REGISTRY.find((entry) => entry.id === id)
}

/** 积分能力表（设置页用），从清单派生，不另写一份字面量。 */
export function creditCapabilitiesOf(): Readonly<Record<string, { balance: boolean; dailyCheckin: boolean }>> {
  const result: Record<string, { balance: boolean; dailyCheckin: boolean }> = {}
  for (const entry of PROVIDER_REGISTRY) result[entry.id] = entry.credits
  return Object.freeze(result)
}

/** 真实渠道 id 列表（不含虚拟分组）。 */
export function channelIds(): string[] {
  return PROVIDER_REGISTRY.filter((entry) => entry.channel).map((entry) => entry.id)
}
