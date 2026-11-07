/**
 * 插件运行期状态：只保留 OpenCode 免费档的逐模型启停与弃用显示开关。
 *
 * 配置形状由 `Config`（schemastery）声明；运行期以自有状态文档为准，
 * 冷启动才用宿主下发的 Config 初值。每次变更原子写盘并通知监听者。
 *
 * ⚠️ 状态文档沿用 `lite-state.json` 这个文件名：旧版本留下的多余字段会被
 * `coerce()` 忽略，升级不需要迁移或删文件。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveJetHubHome } from './jet-hub-store.js'

/** 状态文档形状。 */
export interface LiteState {
  opencodeDisabledModels: string[]
  opencodeIncludeDeprecated: boolean
}

const STATE_FILE = 'lite-state.json'

function emptyState(): LiteState {
  return {
    opencodeDisabledModels: [],
    opencodeIncludeDeprecated: false,
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/** 把任意来源（宿主 Config / 磁盘文档）收敛成合法状态。 */
function coerce(raw: unknown): LiteState {
  const base = emptyState()
  if (typeof raw !== 'object' || raw === null) return base
  const value = raw as Record<string, unknown>
  return {
    opencodeDisabledModels: stringList(value.opencodeDisabledModels),
    opencodeIncludeDeprecated: value.opencodeIncludeDeprecated === true,
  }
}

export class PluginState {
  private data: LiteState
  private readonly listeners = new Set<(state: LiteState) => void>()
  private readonly filePath: string | undefined

  constructor(ctx: Context, initialConfig?: unknown) {
    const home = resolveJetHubHome(ctx)
    this.filePath = home === undefined ? undefined : join(home, 'jet-hub', STATE_FILE)
    const disk = this.readFromDisk()
    this.data = disk ?? coerce(initialConfig)
  }

  /** 当前快照（浅拷贝，调用方不能就地改内部状态）。 */
  snapshot(): LiteState {
    return {
      opencodeDisabledModels: [...this.data.opencodeDisabledModels],
      opencodeIncludeDeprecated: this.data.opencodeIncludeDeprecated,
    }
  }

  /** 状态文档所在目录（供目录发现缓存复用同一目录）。 */
  homeDir(): string | undefined {
    return this.filePath === undefined ? undefined : dirname(this.filePath)
  }

  /** 局部更新：写盘 + 通知。写盘失败不阻断运行，但必须留下诊断。 */
  update(patch: Partial<LiteState>, log?: (message: string) => void): LiteState {
    this.data = { ...this.data, ...patch }
    this.writeToDisk(log)
    const snapshot = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        log?.(`[plugin-state] 状态变更监听失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return snapshot
  }

  subscribe(listener: (state: LiteState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private readFromDisk(): LiteState | undefined {
    if (this.filePath === undefined || !existsSync(this.filePath)) return undefined
    try {
      return coerce(JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown)
    } catch {
      // 文档损坏时回退到 Config 初值，绝不把一份半解析的状态当成真相。
      return undefined
    }
  }

  private writeToDisk(log?: (message: string) => void): void {
    if (this.filePath === undefined) return
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.filePath)
    } catch (error) {
      log?.(`[plugin-state] 状态文档写入失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
