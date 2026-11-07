/**
 * 插件激活守卫（行为级）。
 *
 * 用真实 Cordis Context 加载入口，靠适配器路由是否被注册判断 apply 是否跑完，
 * 不使用源码文本断言。Context 是代理对象，未声明 inject 的属性读取会抛
 * `cannot get property "config" without inject`；配置须由 apply 的第二个参数取用。
 * 0.3.2 已移除 openai-gateway 目录，故不做该模块的 mock。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PluginState, type LiteState } from '../../src/plugin-state.js'
import * as plugin from '../../src/index.js'

const originalStateDir = process.env.DSH_JET_HUB_STATE_DIR
const tempDirs: string[] = []

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
  else process.env.DSH_JET_HUB_STATE_DIR = originalStateDir
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

interface Activation {
  registered: string[]
  errors: string[]
  state: LiteState
}

/** 预置状态文档后加载插件，返回注册路由、错误与激活后可读回的状态快照。 */
async function activate(diskState?: unknown): Promise<Activation> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-activation-spec-'))
  tempDirs.push(dir)
  process.env.DSH_JET_HUB_STATE_DIR = dir
  if (diskState !== undefined) {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(join(dir, 'jet-hub', 'lite-state.json'), JSON.stringify(diskState), 'utf8')
  }

  const registered: string[] = []
  const errors: string[] = []
  const ctx = new Context()

  ctx.provide('credentials', {})
  ctx.provide('commands', {})
  ctx.provide('llm', {
    registerAdapter: (providers: readonly string[]): unknown => {
      registered.push(...providers)
      return {}
    },
    listProviders: (): unknown[] => [],
  })
  ctx.logger = {
    info: (): void => {},
    warn: (): void => {},
    error: (message: unknown): void => { errors.push(String(message)) },
    debug: (): void => {},
  } as never

  // plugin() 返回 thenable fiber，apply 在 await 时执行。
  const pluginFn = ctx.plugin as unknown as (p: unknown, c?: unknown) => PromiseLike<unknown>
  await pluginFn.call(ctx, plugin)

  // 激活后再构造一次 PluginState，验证状态文档未被激活流程改写。
  const state = new PluginState(ctx, {})
  return { registered, errors, state: state.snapshot() }
}

describe('插件激活', () => {
  it('入口导出 name 与 inject 契约', () => {
    expect(plugin.name).toBe('codearts-auth')
    expect(plugin.inject).toEqual(['credentials', 'commands', 'llm'])
  })

  it('只注册 opencode 一条路由，且非 opencode 路由不存在', async () => {
    const { registered, errors } = await activate()
    expect(errors.join('\n')).not.toMatch(/without inject/)
    expect(registered).toEqual(['opencode'])
    for (const legacy of ['modelscope', 'custom', 'codearts', 'myapi']) {
      expect(registered).not.toContain(legacy)
    }
  })

  it('预置状态文档的禁用集合在激活后仍可读回，且不产生额外路由', async () => {
    const disabled = ['free-disabled-a', 'free-disabled-b']
    const { registered, errors, state } = await activate({
      opencodeDisabledModels: disabled,
      opencodeIncludeDeprecated: true,
      customProviders: [{ id: 'myapi', enabled: true }],
    })
    expect(errors.join('\n')).not.toMatch(/without inject/)
    expect(registered).toEqual(['opencode'])
    expect(state.opencodeDisabledModels).toEqual(disabled)
    expect(state.opencodeIncludeDeprecated).toBe(true)
  })
})
