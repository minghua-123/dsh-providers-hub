/**
 * Jet Hub 客户端插件（精简版）。
 *
 * 只注册两处槽位：
 * 1. `main` / `sidebar.panellist` / `settings.section` —— 由 `panel-entry.js`
 *    按「面板入口」偏好互斥注册，渲染同一个 `JetHubPage`；
 * 2. `plugins.bundle.config`（keyed，key = 包名）—— 插件详情页的常驻设置卡片，
 *    是把入口从「仅侧栏」改回「仅设置页」的唯一路径。
 *
 * ⚠️ 刻意不注册 `settings.models.provider-card`：该 keyed 槽按 `settingsNs`
 * 精确查表并只保留一个 winner，会与同样扩展 pi-ai 家族的第三方插件互斥。
 * ⚠️ 用量徽标槽已随多渠道积分体系一并移除。
 */

export const name = 'jet-hub-client'
export const inject = ['slots', 'connection']

import { callManagementRpc, unwrapRpcResult } from '../management-rpc.mjs'
import { installJetHubStyles } from './jet-hub-styles.js'
import { JET_HUB_RPC_CHANNEL } from './jet-hub.js'
import { withErrorBoundary } from './error-boundary.js'
import { registerJetHubPanelEntries } from './panel-entry.js'
import { JetHubPanelEntryCard } from './settings-card.js'

/** 模块级常量：每次渲染新建组件类型会让 React 卸载重挂整棵子树。 */
const JetHubPanelEntryCardGuarded = withErrorBoundary(JetHubPanelEntryCard, { label: '插件详情页卡片' })

export function apply(ctx) {
  ctx.effect(() => installJetHubStyles(), 'jet-hub: install styles')

  const rpcCall = async (endpoint, payload, signal) => {
    const raw = await callManagementRpc(ctx.connection, JET_HUB_RPC_CHANNEL, endpoint, payload, signal)
    return unwrapRpcResult(raw)
  }

  registerJetHubPanelEntries(ctx, rpcCall)

  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    // key 必须等于包名，否则整段卡片不渲染且无任何报错。
    key: 'dsh-providers-hub-lite',
    inject: () => ({ rpcCall }),
  }, JetHubPanelEntryCardGuarded))
}
