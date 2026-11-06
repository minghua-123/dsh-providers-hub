import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  discoverOpencodeLocalService, generateViaOpencodeLocalService, isLocalService,
} from '../../src/opencode-local-bridge.js'

/**
 * 本机官方客户端桥的单测。
 *
 * ⚠️ 这里**不碰真网络**：`fetch` 全量替身。真机链路的证据在
 * `src/opencode-local-bridge.ts` 文件头的实测表里（2026-11-06，本机 2.2.5）。
 */

const fetchSpy = vi.fn()

let dir: string

beforeEach(async () => {
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
  dir = await mkdtemp(join(tmpdir(), 'opencode-bridge-'))
  process.env.DSH_OPENCODE_SERVICE_JSON = join(dir, 'service.json')
})

afterEach(async () => {
  vi.unstubAllGlobals()
  delete process.env.DSH_OPENCODE_SERVICE_JSON
  await rm(dir, { recursive: true, force: true })
})

/** 写一份 `service.json`。 */
async function writeService(payload: unknown): Promise<void> {
  await writeFile(join(dir, 'service.json'), JSON.stringify(payload), 'utf8')
}

/** 只读一次就丢的 `Response` 替身。 */
function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

describe('discoverOpencodeLocalService', () => {
  it('服务文件不存在时返回原因，而不是抛错', async () => {
    const result = await discoverOpencodeLocalService()
    expect(isLocalService(result)).toBe(false)
    expect(isLocalService(result) ? '' : result.reason).toContain('service.json')
  })

  it('口令可用的服务返回 url/password/version', async () => {
    await writeService({ url: 'http://127.0.0.1:28894', password: 'pw', version: '2.2.5' })
    fetchSpy.mockResolvedValueOnce(reply(200, { version: '2.2.5' }))
    const result = await discoverOpencodeLocalService()
    expect(isLocalService(result)).toBe(true)
    if (!isLocalService(result)) return
    expect(result.url).toBe('http://127.0.0.1:28894')
    // ⚠️ 鉴权必须是 `Basic base64("opencode:<pw>")`；`Bearer` 与 `:pw`/`pw:` 官方都回 401。
    expect(fetchSpy.mock.calls[0][1].headers.authorization).toBe(
      `Basic ${Buffer.from('opencode:pw').toString('base64')}`,
    )
  })

  it('口令失效（401）时不算可用 —— 残留的 service.json 不能骗过探测', async () => {
    await writeService({ url: 'http://127.0.0.1:28894', password: 'stale' })
    fetchSpy.mockResolvedValueOnce(reply(401, {}))
    const result = await discoverOpencodeLocalService()
    expect(isLocalService(result)).toBe(false)
    expect(isLocalService(result) ? '' : result.reason).toContain('401')
  })

  it('缺 url/password 的文件被跳过', async () => {
    await writeService({ url: 'http://127.0.0.1:28894' })
    const result = await discoverOpencodeLocalService()
    expect(isLocalService(result)).toBe(false)
  })
})

describe('generateViaOpencodeLocalService', () => {
  const service = { url: 'http://127.0.0.1:28894', password: 'pw' }

  it('走「建会话 → 会话内瞬态生成 → 删会话」，返回 data.text', async () => {
    fetchSpy
      .mockResolvedValueOnce(reply(200, { data: { id: 'ses_test' } }))
      .mockResolvedValueOnce(reply(200, { data: { text: 'pong' } }))
      .mockResolvedValueOnce(reply(204, {}))

    const text = await generateViaOpencodeLocalService({ service, model: 'pulse-alpha-free', prompt: 'hi' })
    expect(text).toBe('pong')

    const [createCall, generateCall, deleteCall] = fetchSpy.mock.calls
    expect(createCall[0]).toBe('http://127.0.0.1:28894/api/session')
    expect(JSON.parse(createCall[1].body)).toEqual({ model: { id: 'pulse-alpha-free', providerID: 'opencode' } })
    // ⚠️ generate 的入参只有 `prompt` 一个字段（openapi 实测，additionalProperties:false）。
    expect(generateCall[0]).toBe('http://127.0.0.1:28894/api/session/ses_test/generate')
    expect(JSON.parse(generateCall[1].body)).toEqual({ prompt: 'hi' })
    expect(deleteCall[0]).toBe('http://127.0.0.1:28894/api/session/ses_test')
    expect(deleteCall[1].method).toBe('DELETE')
  })

  it('建会话失败时抛出，且不再发后续请求', async () => {
    fetchSpy.mockResolvedValueOnce(reply(429, { error: 'nope' }))
    await expect(
      generateViaOpencodeLocalService({ service, model: 'pulse-alpha-free', prompt: 'hi' }),
    ).rejects.toThrow(/建会话失败/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('生成失败时抛出（调用方据此回退到原始 429）', async () => {
    fetchSpy
      .mockResolvedValueOnce(reply(200, { data: { id: 'ses_test' } }))
      .mockResolvedValueOnce(reply(500, 'boom'))
      .mockResolvedValueOnce(reply(204, {}))
    await expect(
      generateViaOpencodeLocalService({ service, model: 'pulse-alpha-free', prompt: 'hi' }),
    ).rejects.toThrow(/生成失败/)
  })

  it('生成返回空文本时抛出，不把空回复当成成功', async () => {
    fetchSpy
      .mockResolvedValueOnce(reply(200, { data: { id: 'ses_test' } }))
      .mockResolvedValueOnce(reply(200, { data: { text: '' } }))
      .mockResolvedValueOnce(reply(204, {}))
    await expect(
      generateViaOpencodeLocalService({ service, model: 'pulse-alpha-free', prompt: 'hi' }),
    ).rejects.toThrow(/空文本/)
  })
})
