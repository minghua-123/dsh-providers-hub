/**
 * 渠道清单：本插件「有哪些渠道、各自有什么能力」的唯一真相源。
 *
 * 精简版只保留三类入口：
 * - `opencode`：本机 OpenCode 官方客户端桥，只承接 Zen 免费档模型；
 * - `modelscope`：魔搭社区官方接入（静态 API Key + OpenAI 兼容）；
 * - `custom`：自定义供应商分组。它本身不注册路由，实际路由是用户在设置页
 *   新增的每个实例（id 形如 `^[a-z][a-z0-9]*$`），见 `custom-provider-*.ts`。
 *
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
  Object.freeze({
    id: 'modelscope',
    label: '魔搭社区',
    displayName: '魔搭社区（官方接入）',
    logoClass: 'modelscope',
    channel: true,
    credits: Object.freeze({ balance: true, dailyCheckin: false }),
  }),
  Object.freeze({
    id: 'custom',
    label: '自定义供应商',
    displayName: '自定义供应商',
    logoClass: 'custom',
    channel: false,
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
