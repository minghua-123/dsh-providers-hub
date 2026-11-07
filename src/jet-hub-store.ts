/**
 * 插件自有状态的落盘位置。
 *
 * 单渠道版不再维护多渠道账号池与黑名单文档；只保留「DSH home 解析」这一条
 * 被状态文档与目录缓存共用的判据，避免两处各自推断 home 造成目录分裂。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { readService } from './settings-compat.js'

/** 老契约下 settings 文档的命名空间（保留常量以兼容旧 profile）。 */
export const JET_HUB_NS = 'jet-hub'

/**
 * 解析 DSH home。优先级：显式环境变量 → profile home → `$DSH_HOME` → `~/.dsh`。
 *
 * ⚠️ 判据必须与网关、状态文档共用同一份：分叉会让密钥与状态写到不同目录。
 */
export function resolveJetHubHome(ctx: Context): string | undefined {
  const override = process.env.DSH_JET_HUB_STATE_DIR
  if (override !== undefined && override.trim().length > 0) return override.trim()
  const profileHome = (readService(ctx, 'profileContext') as { home?: unknown } | undefined)?.home
  if (typeof profileHome === 'string' && profileHome.length > 0) return profileHome
  const envHome = process.env.DSH_HOME
  if (envHome !== undefined && envHome.trim().length > 0) return envHome.trim()
  return join(homedir(), '.dsh')
}
