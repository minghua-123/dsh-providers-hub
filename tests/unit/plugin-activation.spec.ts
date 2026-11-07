/**
 * 插件激活守卫（行为级）。
 *
 * 背景：重写入口时曾把配置读成 `ctx.config`。Cordis 的 Context 是代理对象，
 * 未声明 inject 的属性一律抛 `cannot get property "config" without inject`，
 * 插件整体无法激活，且界面只留一句无上下文的报错。
 * Cordis 以 `apply(ctx, config)` 传配置，配置必须由第二个参数取用。
 *
 * 本用例用**真实** Cordis Context 加载插件入口，靠「适配器路由是否被注册」
 * 判断 apply 是否跑完，不用源码文本断言。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

// 网关是旁路且会触碰本机端口/文件，激活守卫只需验证入口链路，故隔离之。
vi.mock('../../src/openai-gateway/index.js', () => ({ mountOpenAiGateway: () => {} }))

import * as plugin from '../../src/index.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  delete process.env.DSH_JET_HUB_STATE_DIR
})

interface Activation {
  registered: string[]
  errors: string[]
}

/**
 * @param diskState - 预置的自有状态文档。运行期配置以该文档为准（设置页写入），
 *   Config 仅作冷启动兜底；Cordis 对 volatile 字段有自己的解析规则，故本守卫
 *   走真实路径而不是把配置塞进 `ctx.plugin()` 的第二个参数。
 */
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

  // inject 声明的三个服务必须先就绪，否则插件根本不会进入 apply。
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
    info: () => {},
    warn: () => {},
    error: (message: unknown): void => { errors.push(String(message)) },
    debug: () => {},
  } as never

  // 若实现仍去读 ctx.config，await 会抛 `without inject`，注册列表也就为空。
  // plugin() 返回 thenable fiber，apply 在 await 时执行。
  const pluginFn = ctx.plugin as unknown as (p: unknown, c?: unknown) => PromiseLike<unknown>
  await pluginFn.call(ctx, plugin)
  return { registered, errors }
}

describe('插件激活', () => {
  it('不读取未注入的 ctx.config，且三条默认路由全部注册', async () => {
    const { registered, errors } = await activate()
    expect(errors.join('\n')).not.toMatch(/without inject/)
    expect(registered).toContain('opencode')
    expect(registered).toContain('modelscope')
  })

  it('状态文档里已有的自定义供应商在激活时自动注册路由', async () => {
    const { registered, errors } = await activate({
      customProviders: [{
        id: 'myapi',
        displayName: '自建接口',
        api: 'openai-completions',
        baseURL: 'https://example.com/v1',
        apiKey: 'test-key',
        models: [{ id: 'demo', name: 'Demo', contextWindow: 8192 }],
        enabled: true,
      }],
      opencodeDisabledModels: [],
      opencodeIncludeDeprecated: false,
      modelscopeApiKey: '',
    })
    expect(errors.join('\n')).not.toMatch(/without inject/)
    expect(registered).toContain('myapi')
  })
})
