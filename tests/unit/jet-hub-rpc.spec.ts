/**
 * Jet Hub 管理端点的行为级守卫。
 *
 * 每个用例独占一个临时状态目录，并在结束后恢复 DSH_JET_HUB_STATE_DIR，
 * 避免用例之间经由状态文档互相污染。端点用同步 inject 替身注册，不依赖宿主。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { PluginState, type LiteState } from '../../src/plugin-state.js'
import type { OpencodeBridgeLike, ProbeDeps } from '../../src/probe.js'

interface RegisteredRoute {
  path: string
  fetch: (request: Request) => Promise<Response>
}

interface RpcEnvelope {
  type: string
  rpcId: string
  result: {
    ok: boolean
    value?: unknown
    error?: { code: string; message: string }
  }
}

interface Harness {
  route: RegisteredRoute
  state: PluginState
  applied: LiteState[]
  bridgeCalls: string[]
  warnings: string[]
  probesCalls: () => number
  dir: string
}

const originalStateDir = process.env.DSH_JET_HUB_STATE_DIR
const tempDirs: string[] = []

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
  else process.env.DSH_JET_HUB_STATE_DIR = originalStateDir
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function useStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-spec-'))
  tempDirs.push(dir)
  process.env.DSH_JET_HUB_STATE_DIR = dir
  return dir
}

function harness(options: { preseed?: Record<string, unknown> } = {}): Harness {
  const dir = useStateDir()
  if (options.preseed !== undefined) {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(join(dir, 'jet-hub', 'lite-state.json'), JSON.stringify(options.preseed), 'utf8')
  }

  const routes: RegisteredRoute[] = []
  const connection = {
    fetch: { register: (route: RegisteredRoute): void => { routes.push(route) } },
  }
  const warnings: string[] = []
  const ctx = {
    inject: (_deps: string[], fn: (injected: unknown) => void): void => { fn({ connection }) },
    logger: { warn: (message: string): void => { warnings.push(message) } },
    get: (): undefined => undefined,
  }

  const state = new PluginState(ctx as never, {})
  const applied: LiteState[] = []
  const bridgeCalls: string[] = []
  let probesCalls = 0
  const bridge: OpencodeBridgeLike = {
    async ensure() { return 'http://127.0.0.1:1' },
    async turn(input) {
      bridgeCalls.push(input.model)
      return { text: 'pong', usage: null, raw: {} }
    },
  }

  registerJetHubRpc(ctx as never, {
    state,
    discovery: {},
    applyState: (next): void => { applied.push(next) },
    onCatalog: (): void => {},
    warn: (message: string): void => { warnings.push(message) },
    probes: (): ProbeDeps => {
      probesCalls += 1
      return {
        opencodeBridge: bridge,
        opencodeModelIds: async () => ['free-first'],
      }
    },
  })

  return {
    route: routes[0],
    state,
    applied,
    bridgeCalls,
    warnings,
    probesCalls: () => probesCalls,
    dir,
  }
}

async function invoke(
  route: RegisteredRoute,
  method: string,
  payload: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
): Promise<RpcEnvelope> {
  const body = {
    type: 'client-request',
    rpcId: 'r1',
    method: 'jet-hub',
    payload: { method, payload },
    ...envelope,
  }
  const request = new Request('http://127.0.0.1/api/jet-hub', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await route.fetch(request)
  return (await response.json()) as RpcEnvelope
}

describe('Jet Hub RPC 端点', () => {
  it('注册在 /api/jet-hub', () => {
    expect(JET_HUB_API_PATH).toBe('/api/jet-hub')
    expect(harness().route.path).toBe('/api/jet-hub')
  })

  it('未知方法返回 ok:false 并带 unknown-method 错误码', async () => {
    const { route } = harness()
    const response = await invoke(route, 'no.such.method')
    expect(response.result.ok).toBe(false)
    expect(response.result.error?.code).toBe('jet-hub/unknown-method')
    expect(response.result.value).toBeUndefined()
  })

  it('畸形信封返回 bad-request，不进入方法分派', async () => {
    const { route } = harness()
    const response = await invoke(route, 'state.get', {}, { method: 'other-endpoint' })
    expect(response.result.ok).toBe(false)
    expect(response.result.error?.code).toBe('gateway/bad-request')
  })

  it('provider.status 只暴露 opencode 一条渠道', async () => {
    const { route } = harness()
    const response = await invoke(route, 'provider.status')
    expect(response.result.ok).toBe(true)
    const value = response.result.value as { providers: Array<{ id: string; channel: boolean }> }
    expect(value.providers).toHaveLength(1)
    expect(value.providers[0].id).toBe('opencode')
    expect(value.providers[0].channel).toBe(true)
  })

  it('state.get 返回默认空状态', async () => {
    const { route } = harness()
    const response = await invoke(route, 'state.get')
    expect(response.result.ok).toBe(true)
    expect(response.result.value).toEqual({
      opencodeDisabledModels: [],
      opencodeIncludeDeprecated: false,
    })
  })

  it('opencode.setDisabled 写状态并触发 applyState', async () => {
    const { route, state, applied, dir } = harness()
    const response = await invoke(route, 'opencode.setDisabled', {
      disabledModels: ['free-a', 'free-b'],
    })
    expect(response.result.ok).toBe(true)
    const value = response.result.value as { disabledModels: string[] }
    expect(value.disabledModels).toEqual(['free-a', 'free-b'])
    expect(state.snapshot().opencodeDisabledModels).toEqual(['free-a', 'free-b'])
    expect(applied).toHaveLength(1)
    expect(applied[0].opencodeDisabledModels).toEqual(['free-a', 'free-b'])
    const onDisk = JSON.parse(readFileSync(join(dir, 'jet-hub', 'lite-state.json'), 'utf8')) as {
      opencodeDisabledModels: string[]
    }
    expect(onDisk.opencodeDisabledModels).toEqual(['free-a', 'free-b'])
  })

  it('opencode.setIncludeDeprecated 写状态并触发 applyState', async () => {
    const { route, state, applied, dir } = harness()
    const response = await invoke(route, 'opencode.setIncludeDeprecated', { enabled: true })
    expect(response.result.ok).toBe(true)
    const value = response.result.value as { includeDeprecated: boolean }
    expect(value.includeDeprecated).toBe(true)
    expect(state.snapshot().opencodeIncludeDeprecated).toBe(true)
    expect(applied).toHaveLength(1)
    expect(applied[0].opencodeIncludeDeprecated).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(dir, 'jet-hub', 'lite-state.json'), 'utf8')) as {
      opencodeIncludeDeprecated: boolean
    }
    expect(onDisk.opencodeIncludeDeprecated).toBe(true)
  })

  it('预置状态文档可经 snapshot 与 state.get 读回，且旧字段被忽略', async () => {
    const preseed = {
      opencodeDisabledModels: ['free-x', 'free-y'],
      opencodeIncludeDeprecated: true,
      customProviders: [{ id: 'legacy' }],
      modelscopeApiKey: 'legacy-key',
    }
    const { state, route } = harness({ preseed })
    const snapshot = state.snapshot()
    expect(snapshot.opencodeDisabledModels).toEqual(['free-x', 'free-y'])
    expect(snapshot.opencodeIncludeDeprecated).toBe(true)
    expect(Object.keys(snapshot).sort()).toEqual([
      'opencodeDisabledModels',
      'opencodeIncludeDeprecated',
    ])

    const response = await invoke(route, 'state.get')
    expect(response.result.ok).toBe(true)
    expect(response.result.value).toEqual({
      opencodeDisabledModels: ['free-x', 'free-y'],
      opencodeIncludeDeprecated: true,
    })
  })

  it('probe.model 正常时 value.ok 为真，且 bridge 收到指定模型', async () => {
    const { route, bridgeCalls } = harness()
    const response = await invoke(route, 'probe.model', {
      provider: 'opencode',
      model: 'free-target',
    })
    expect(response.result.ok).toBe(true)
    const value = response.result.value as { ok: boolean; model: string }
    expect(value.ok).toBe(true)
    expect(value.model).toBe('free-target')
    expect(bridgeCalls).toEqual(['free-target'])
  })

  it('probe.provider 正常时走供应商级并把结果包在 value 里', async () => {
    const { route, bridgeCalls } = harness()
    const response = await invoke(route, 'probe.provider', { provider: 'opencode' })
    expect(response.result.ok).toBe(true)
    const value = response.result.value as { ok: boolean; model: string; message: string }
    expect(value.ok).toBe(true)
    expect(value.model).toBe('free-first')
    expect(value.message).toContain('供应商级（free-first）')
    expect(bridgeCalls).toEqual(['free-first'])
  })

  it('probe.model 的业务失败包在 value 里，而非 RPC 失败', async () => {
    const { route, bridgeCalls } = harness()
    const response = await invoke(route, 'probe.model', {
      provider: 'ghost',
      model: 'm-x',
    })
    expect(response.result.ok).toBe(true)
    expect(response.result.error).toBeUndefined()
    const value = response.result.value as { ok: boolean; message: string }
    expect(value.ok).toBe(false)
    expect(value.message).toContain('仅支持 opencode')
    expect(bridgeCalls).toHaveLength(0)
  })

  it('probe.model 缺参数返回 invalid-config 且不取探活依赖', async () => {
    const { route, bridgeCalls, probesCalls } = harness()
    const response = await invoke(route, 'probe.model', { provider: 'opencode' })
    expect(response.result.ok).toBe(false)
    expect(response.result.error?.code).toBe('jet-hub/invalid-config')
    expect(probesCalls()).toBe(0)
    expect(bridgeCalls).toHaveLength(0)
  })

  it('probe.provider 缺参数返回 invalid-config 且不发请求', async () => {
    const { route, bridgeCalls, probesCalls } = harness()
    const response = await invoke(route, 'probe.provider', {})
    expect(response.result.ok).toBe(false)
    expect(response.result.error?.code).toBe('jet-hub/invalid-config')
    expect(response.result.error?.message).toContain('供应商 id')
    expect(probesCalls()).toBe(0)
    expect(bridgeCalls).toHaveLength(0)
  })
})
