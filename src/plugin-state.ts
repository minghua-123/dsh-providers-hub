/**
 * 插件运行期状态。
 *
 * 配置形状由 `Config`（schemastery）声明，运行期读写统一走本模块：
 * 启动时优先读上一次落盘的文档，冷启动才用宿主下发的 Config 初值；
 * 每次变更原子写盘并通知监听者（重新注册自定义供应商路由、更新魔搭凭据）。
 *
 * ⚠️ 明文 API Key 只落在本插件自有状态文档与宿主进程内存里，不写日志、
 * 不进会话历史；设置页读到的是 `maskCustomProvider()` 的打码结果。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveJetHubHome } from './jet-hub-store.js'
import { normalizeCustomProviders, upsertCustomProvider, removeCustomProvider } from './custom-provider-store.js'
import type { CustomProviderConfig } from './custom-provider-types.js'

/** 状态文档形状。 */
export interface LiteState {
  customProviders: CustomProviderConfig[]
  opencodeDisabledModels: string[]
  opencodeIncludeDeprecated: boolean
  modelscopeApiKey: string
}

const STATE_FILE = 'lite-state.json'

function emptyState(): LiteState {
  return {
    customProviders: [],
    opencodeDisabledModels: [],
    opencodeIncludeDeprecated: false,
    modelscopeApiKey: '',
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
  const section = value.customProviders
  // Config 里的形状是 { customProviders: { providers: [...] } }；
  // 磁盘文档直接存 providers 数组。两种都接受，避免两套判据。
  const providersRaw = Array.isArray(section)
    ? section
    : (section && typeof section === 'object' && 'providers' in section
      ? (section as Record<string, unknown>).providers
      : value.providers)
  return {
    customProviders: normalizeCustomProviders(providersRaw),
    opencodeDisabledModels: stringList(value.opencodeDisabledModels),
    opencodeIncludeDeprecated: value.opencodeIncludeDeprecated === true,
    modelscopeApiKey: typeof value.modelscopeApiKey === 'string' ? value.modelscopeApiKey : '',
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
      customProviders: [...this.data.customProviders],
      opencodeDisabledModels: [...this.data.opencodeDisabledModels],
      opencodeIncludeDeprecated: this.data.opencodeIncludeDeprecated,
      modelscopeApiKey: this.data.modelscopeApiKey,
    }
  }

  /** 状态文档路径（供目录发现缓存等复用同一目录）。 */
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

  upsertProvider(config: CustomProviderConfig, log?: (message: string) => void): LiteState {
    return this.update({ customProviders: upsertCustomProvider(this.data.customProviders, config) }, log)
  }

  removeProvider(id: string, log?: (message: string) => void): LiteState {
    return this.update({ customProviders: removeCustomProvider(this.data.customProviders, id) }, log)
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
