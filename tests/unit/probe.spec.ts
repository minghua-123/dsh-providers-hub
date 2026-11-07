/**
 * 连通性探活与魔搭逐模型启停的行为级守卫。
 *
 * 判据一律打在「真实产出的请求体 / 结果对象」上，不用源码文本断言：
 * 单模型测试必须把指定 id 写进请求，失败不得返回 ok:true，停用集合
 * 只影响显示列表而不得把条目从全量目录里抹掉。
 */

import { describe, expect, it } from 'vitest'
import { ModelscopeAdapter } from '../../src/modelscope-adapter.js'
import { probeModel, probeProvider, type ProbeDeps } from '../../src/probe.js'
import type { CustomFetcher } from '../../src/custom-provider-protocols.js'
import type { CustomProviderConfig } from '../../src/custom-provider-types.js'
import type { OpencodeTurnInput, OpencodeTurnResult } from '../../src/opencode-bridge.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function capture(calls: Array<{ url: string; body: Record<string, unknown> }>, response: Response): CustomFetcher {
  return (async (url: string, init: { body?: unknown }) => {
    let body: Record<string, unknown> = {}
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body) as Record<string, unknown> } catch { body = {} }
    }
    calls.push({ url, body })
    return response
  }) as CustomFetcher
}

const customConfig: CustomProviderConfig = {
  id: 'myapi',
  displayName: '自建接口',
  api: 'openai-completions',
  baseURL: 'https://example.com/v1',
  apiKey: 'sk-test',
  models: [
    { id: 'model-a', name: 'A', contextWindow: 8192 },
    { id: 'model-b', name: 'B', contextWindow: 8192 },
  ],
  enabled: true,
}

function bridgeStub(seen: OpencodeTurnInput[], fail = false) {
  return {
    ensure: async (): Promise<string> => 'http://127.0.0.1:1',
    turn: async (input: OpencodeTurnInput): Promise<OpencodeTurnResult> => {
      seen.push(input)
      if (fail) throw new Error('bridge down')
      return { text: 'pong', usage: null, raw: {} }
    },
  }
}

function deps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    modelscopeApiKey: 'ms-test-key',
    customProviders: [customConfig],
    now: () => 1000,
    ...overrides,
  }
}

describe('连通性探活', () => {
  it('魔搭单模型测试把指定模型写进请求体，并回显模型与耗时', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const result = await probeModel(
      'modelscope',
      'deepseek-ai/DeepSeek-V3',
      deps({ fetcher: capture(calls, jsonResponse(200, { choices: [{ message: { content: 'pong' } }] })) }),
    )
    expect(result.ok).toBe(true)
    expect(result.model).toBe('deepseek-ai/DeepSeek-V3')
    expect(result.status).toBe(200)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].body.model).toBe('deepseek-ai/DeepSeek-V3')
    expect(calls[0].body.stream).toBe(false)
  })

  it('魔搭上游失败返回 ok:false 且带上状态码，绝不包成成功', async () => {
    const result = await probeModel(
      'modelscope',
      'model-x',
      deps({ fetcher: capture([], jsonResponse(500, { error: { message: 'upstream down' } })) }),
    )
    expect(result.ok).toBe(false)
    expect(result.status).toBe(500)
    expect(result.message).toContain('HTTP 500')
  })

  it('未配置魔搭 Key 时明确失败且不发任何请求', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const result = await probeModel(
      'modelscope',
      'model-x',
      deps({ modelscopeApiKey: '', fetcher: capture(calls, jsonResponse(200, {})) }),
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('未配置')
    expect(calls).toHaveLength(0)
  })

  it('自定义供应商单模型测试用指定模型，而不是配置里的第一个', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const result = await probeModel(
      'myapi',
      'model-b',
      deps({ fetcher: capture(calls, jsonResponse(200, { choices: [] })) }),
    )
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].body.model).toBe('model-b')
    expect(String(calls[0].url)).toContain('/chat/completions')
  })

  it('供应商级测试自动取第一个可用模型，并在文案里标出模型', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const result = await probeProvider(
      'myapi',
      deps({ fetcher: capture(calls, jsonResponse(200, { choices: [] })) }),
    )
    expect(result.ok).toBe(true)
    expect(result.message).toContain('供应商级（model-a）')
    expect(calls[0].body.model).toBe('model-a')
  })

  it('opencode 单模型测试走客户端桥并把模型传进 turn', async () => {
    const seen: OpencodeTurnInput[] = []
    const result = await probeModel(
      'opencode',
      'free-a',
      deps({ opencodeBridge: bridgeStub(seen) }),
    )
    expect(result.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0].model).toBe('free-a')
  })

  it('opencode 供应商级测试取目录里的第一个承接模型', async () => {
    const seen: OpencodeTurnInput[] = []
    const result = await probeProvider('opencode', deps({
      opencodeBridge: bridgeStub(seen),
      opencodeModelIds: async () => ['free-b', 'free-c'],
    }))
    expect(result.ok).toBe(true)
    expect(seen[0].model).toBe('free-b')
  })

  it('桥异常时返回 ok:false 并保留根因文案', async () => {
    const result = await probeModel('opencode', 'free-a', deps({
      opencodeBridge: bridgeStub([], true),
    }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('bridge down')
  })

  it('未知供应商与空模型都明确失败', async () => {
    expect((await probeModel('ghost', 'x', deps())).ok).toBe(false)
    expect((await probeModel('myapi', '', deps())).ok).toBe(false)
    expect((await probeProvider('', deps())).ok).toBe(false)
  })
})

describe('魔搭逐模型启停', () => {
  it('停用只过滤 listModels，全量目录仍保留该条并带 disabled 标记', async () => {
    // apiKey 为空时目录走编译期兜底表，不发网络，测试可完全离线。
    const adapter = new ModelscopeAdapter({ apiKey: '' })
    const full = await adapter.listModels('modelscope')
    expect(full.length).toBeGreaterThan(0)
    const first = full[0].id

    adapter.setDisabledModels([first])
    const filtered = await adapter.listModels('modelscope')
    expect(filtered.some((entry) => entry.id === first)).toBe(false)
    expect(filtered).toHaveLength(full.length - 1)

    const rows = await adapter.catalogRows()
    expect(rows.find((row) => row.id === first)?.disabled).toBe(true)
    expect(await adapter.enabledModelIds()).not.toContain(first)
    // 全量同步目录是「判某个 id 在不在目录里」的另一条腿，不能被停用集合污染。
    expect(adapter.listAllModels().some((entry) => entry.id === first)).toBe(true)
  })

  it('重新启用后模型回到显示列表', async () => {
    const adapter = new ModelscopeAdapter({ apiKey: '' })
    const first = (await adapter.listModels('modelscope'))[0].id
    adapter.setDisabledModels([first])
    adapter.setDisabledModels([])
    expect((await adapter.listModels('modelscope')).some((entry) => entry.id === first)).toBe(true)
  })
})
