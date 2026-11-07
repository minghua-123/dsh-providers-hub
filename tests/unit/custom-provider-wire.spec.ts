import { describe, expect, it } from 'vitest'
import {
  buildCustomRequest,
  classifyCustomErrorText,
  classifyCustomHttpError,
  customAuthHeaders,
  parseCustomBaseURL,
} from '../../src/custom-provider-protocols.js'
import {
  maskApiKey,
  normalizeCustomProviders,
  parseRemoteModels,
  upsertCustomProvider,
} from '../../src/custom-provider-store.js'
import type { CustomProviderConfig } from '../../src/custom-provider-types.js'

function config(patch: Partial<CustomProviderConfig> = {}): CustomProviderConfig {
  return {
    id: 'myapi',
    displayName: '我的供应商',
    api: 'openai-completions',
    baseURL: 'https://example.com/v1',
    apiKey: 'sk-secret-123',
    models: [{ id: 'model-a', name: 'Model A', contextWindow: 8192 }],
    enabled: true,
    ...patch,
  }
}

const call = {
  model: 'model-a',
  messages: [{ role: 'user' as const, content: 'ping' }],
  maxTokens: 16,
  stream: false,
}

describe('自定义供应商：配置归一化', () => {
  it('过滤非法 id、保留 id 与畸形 baseURL，去重', () => {
    const rows = normalizeCustomProviders([
      config(),
      config({ id: 'myapi', displayName: '重复' }),
      config({ id: 'Bad-Id', baseURL: 'https://ok.example/v1' }),
      config({ id: 'opencode', baseURL: 'https://ok.example/v1' }),
      config({ id: 'nourl', baseURL: 'ftp://x/v1' }),
    ])
    expect(rows.map((row) => row.id)).toEqual(['myapi'])
  })

  it('缺省接口类型回落为 OpenAI Chat Completions', () => {
    const rows = normalizeCustomProviders([{ ...config(), api: 'not-a-protocol' as never }])
    expect(rows[0].api).toBe('openai-completions')
  })

  it('baseURL 归一化保留路径前缀并去掉尾斜杠', () => {
    const rows = normalizeCustomProviders([config({ baseURL: 'https://example.com/v1/' })])
    expect(rows[0].baseURL).toBe('https://example.com/v1')
    expect(parseCustomBaseURL('http://127.0.0.1:8080/v1')).toBeInstanceOf(URL)
    expect(parseCustomBaseURL('file:///tmp')).toBeUndefined()
  })

  it('upsert 按 id 替换而不追加，且不改写 API Key', () => {
    const next = upsertCustomProvider([config()], config({ displayName: '改名', apiKey: '  sk-keep  ' }))
    expect(next).toHaveLength(1)
    expect(next[0].displayName).toBe('改名')
    expect(next[0].apiKey).toBe('  sk-keep  ')
  })

  it('打码不回显明文', () => {
    expect(maskApiKey('sk-secret-123')).not.toContain('sk-secret-123')
    expect(maskApiKey('')).toBe('')
  })

  it('/models 解析拒绝空目录，不静默返回空列表', () => {
    expect(() => parseRemoteModels({ data: [] })).toThrow()
    expect(parseRemoteModels({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b', name: 'B' }] })).toHaveLength(2)
  })
})

describe('自定义供应商：三种 wire 协议', () => {
  it('openai-completions 打到 /chat/completions 并用 Bearer', async () => {
    const request = await buildCustomRequest(config(), call)
    expect(request.url).toBe('https://example.com/v1/chat/completions')
    expect(request.headers.authorization).toBe('Bearer sk-secret-123')
    const body = JSON.parse(request.body) as Record<string, unknown>
    expect(body.model).toBe('model-a')
    expect(body.stream).toBe(false)
  })

  it('openai-responses 打到 /responses 且 system 走 instructions', async () => {
    const request = await buildCustomRequest(config({ api: 'openai-responses' }), { ...call, system: '规则' })
    expect(request.url).toBe('https://example.com/v1/responses')
    const body = JSON.parse(request.body) as Record<string, unknown>
    expect(body.instructions).toBe('规则')
    expect(body.model).toBe('model-a')
  })

  it('anthropic-messages 打到 /messages 且带 x-api-key 与版本头', async () => {
    const request = await buildCustomRequest(config({ api: 'anthropic-messages' }), call)
    expect(request.url).toBe('https://example.com/v1/messages')
    expect(request.headers['x-api-key']).toBe('sk-secret-123')
    expect(request.headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(request.body) as Record<string, unknown>
    expect(body.max_tokens).toBeGreaterThan(0)
  })

  it('鉴权头按协议分道，不混用', () => {
    expect(customAuthHeaders(config()).authorization).toBe('Bearer sk-secret-123')
    expect(customAuthHeaders(config({ api: 'anthropic-messages' }))['x-api-key']).toBe('sk-secret-123')
    expect(customAuthHeaders(config({ api: 'anthropic-messages' })).authorization).toBeUndefined()
  })

  it('未知接口类型明确抛错，不静默回落', async () => {
    await expect(buildCustomRequest(config({ api: 'bogus' as never }), call)).rejects.toThrow()
  })
})

describe('自定义供应商：错误归类', () => {
  it('额度文案产出字面量 QUOTA_EXCEEDED，不用会被客户端替换的码', () => {
    expect(classifyCustomErrorText('out of credits', 'SERVER')).toBe('QUOTA_EXCEEDED')
    expect(classifyCustomHttpError(429, '{"error":{"message":"额度已用尽"}}')).toBe('QUOTA_EXCEEDED')
  })

  it('未命中的错误保留上游分类，不硬套额度', () => {
    expect(classifyCustomErrorText('connection reset', 'TRANSPORT')).toBe('TRANSPORT')
  })
})
