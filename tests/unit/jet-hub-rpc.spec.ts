import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { PluginState } from '../../src/plugin-state.js'
import { maskApiKey } from '../../src/custom-provider-store.js'
import type { CustomProviderConfig } from '../../src/custom-provider-types.js'
import type { LiteState } from '../../src/plugin-state.js'

interface RegisteredRoute {
  path: string
  fetch: (request: Request) => Promise<Response>
}

function harness() {
  const routes: RegisteredRoute[] = []
  const connection = {
    fetch: { register: (route: RegisteredRoute): void => { routes.push(route) } },
  }
  const ctx = {
    inject: (_deps: string[], fn: (injected: unknown) => void): void => { fn({ connection }) },
    logger: { warn: (): void => {} },
    get: (): undefined => undefined,
    config: {},
  }
  // 每个用例独占一个状态目录：PluginState 会把路径固定在构造时，
  // 之后即使复用同一个临时根也不会互相读到对方写下的配置。
  const previous = process.env.DSH_JET_HUB_STATE_DIR
  process.env.DSH_JET_HUB_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-rpc-spec-'))
  const state = new PluginState(ctx as never, {})
  if (previous === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
  else process.env.DSH_JET_HUB_STATE_DIR = previous
  const applied: LiteState[] = []
  registerJetHubRpc(ctx as never, {
    state,
    discovery: {},
    applyState: (next): void => { applied.push(next) },
    onCatalog: (): void => {},
    warn: (): void => {},
  })
  return { route: routes[0], state, applied }
}

async function invoke(route: RegisteredRoute, method: string, payload: Record<string, unknown> = {}, envelope?: Record<string, unknown>) {
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
  return (await response.json()) as { type: string; rpcId: string; result: { ok: boolean; value?: unknown; error?: { code: string; message: string } } }
}

const config: CustomProviderConfig = {
  id: 'myapi',
  displayName: '我的供应商',
  api: 'openai-completions',
  baseURL: 'https://example.com/v1',
  apiKey: 'sk-secret-123',
  models: [{ id: 'model-a', name: 'Model A', contextWindow: 8192 }],
  enabled: true,
}

describe('Jet Hub RPC 端点', () => {
  it('注册在 /api/jet-hub', () => {
    expect(harness().route.path).toBe('/api/jet-hub')
  })

  it('未知方法返回 ok:false 并带错误码，不把失败包成成功', async () => {
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

  it('state.get 返回掩码配置，绝不回显明文 Key', async () => {
    const { route, state } = harness()
    state.upsertProvider(config)
    const response = await invoke(route, 'state.get')
    expect(response.result.ok).toBe(true)
    const value = response.result.value as { customProviders: Array<{ apiKeyMasked: string }> }
    expect(value.customProviders).toHaveLength(1)
    expect(JSON.stringify(value)).not.toContain('sk-secret-123')
  })

  it('编辑态回传掩码时保留原 Key 与模型列表，不把掩码写成真凭据', async () => {
    const { route, state, applied } = harness()
    const saved = await invoke(route, 'custom.upsert', { config })
    expect(saved.result.ok).toBe(true)
    expect(state.snapshot().customProviders[0].apiKey).toBe('sk-secret-123')

    const edited = await invoke(route, 'custom.upsert', {
      config: { ...config, displayName: '改名', apiKey: maskApiKey(config.apiKey), models: [] },
    })
    expect(edited.result.ok).toBe(true)
    const stored = state.snapshot().customProviders[0]
    expect(stored.displayName).toBe('改名')
    expect(stored.apiKey).toBe('sk-secret-123')
    expect(stored.models).toHaveLength(1)
    expect(applied.length).toBe(2)
    expect(JSON.stringify(edited.result.value)).not.toContain('sk-secret-123')
  })

  it('非法配置返回可读错误，不写状态', async () => {
    const { route, state } = harness()
    const response = await invoke(route, 'custom.upsert', { config: { ...config, id: 'opencode' } })
    expect(response.result.ok).toBe(false)
    expect(response.result.error?.message).toContain('配置非法')
    expect(state.snapshot().customProviders).toHaveLength(0)
  })

  it('模型启停写入状态并触发接线层同步', async () => {
    const { route, state, applied } = harness()
    const response = await invoke(route, 'opencode.setDisabled', { disabledModels: ['free-a'] })
    expect(response.result.ok).toBe(true)
    expect(state.snapshot().opencodeDisabledModels).toEqual(['free-a'])
    expect(applied).toHaveLength(1)
  })
})
