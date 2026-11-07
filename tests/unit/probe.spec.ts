/**
 * OpenCode 连通性探活的行为级守卫。
 *
 * 全部通过注入的 bridge 替身驱动，不 spawn 进程、不发网络请求。
 * 判据打在产出的 ProbeResult 与传给 turn() 的入参上，失败一律返回 ok:false。
 */

import { describe, expect, it } from 'vitest'
import {
  probeModel,
  probeProvider,
  type OpencodeBridgeLike,
  type ProbeDeps,
} from '../../src/probe.js'

interface BridgeOptions {
  ensureError?: Error
  turnError?: Error
}

/** 记录每次 turn() 收到的 model；可让 ensure() 或 turn() 抛出根因错误。 */
function bridgeStub(seen: string[], options: BridgeOptions = {}): OpencodeBridgeLike {
  return {
    async ensure() {
      if (options.ensureError) throw options.ensureError
      return 'http://127.0.0.1:1'
    },
    async turn(input) {
      seen.push(input.model)
      if (options.turnError) throw options.turnError
      return { text: 'pong', usage: null, raw: {} }
    },
  }
}

/** 严格递增的注入时钟：相邻两次调用之差恒为 step。 */
function clock(step: number): () => number {
  let current = 0
  return () => (current += step)
}

function deps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return { now: () => 0, ...overrides }
}

describe('连通性探活', () => {
  it('opencode 单模型把指定 model 传进 turn，并回显模型与状态', async () => {
    const seen: string[] = []
    const result = await probeModel('opencode', 'free-a', deps({
      opencodeBridge: bridgeStub(seen),
    }))
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.model).toBe('free-a')
    expect(typeof result.message).toBe('string')
    expect(seen).toEqual(['free-a'])
  })

  it('供应商级取目录第一个模型，并在文案里标出该模型', async () => {
    const seen: string[] = []
    const result = await probeProvider('opencode', deps({
      opencodeBridge: bridgeStub(seen),
      opencodeModelIds: async () => ['free-b', 'free-c'],
    }))
    expect(result.ok).toBe(true)
    expect(result.model).toBe('free-b')
    expect(result.message).toContain('供应商级（free-b）')
    expect(seen).toEqual(['free-b'])
  })

  it('非 opencode provider 明确失败，且不会触碰 bridge', async () => {
    const seen: string[] = []
    const modelResult = await probeModel('modelscope', 'free-a', deps({
      opencodeBridge: bridgeStub(seen),
    }))
    expect(modelResult.ok).toBe(false)
    expect(modelResult.message).toContain('仅支持 opencode')
    expect(seen).toHaveLength(0)

    const providerResult = await probeProvider('ghost', deps({
      opencodeModelIds: async () => ['free-a'],
    }))
    expect(providerResult.ok).toBe(false)
    expect(providerResult.message).toContain('仅支持 opencode')
  })

  it('空 model 明确失败，且不会触碰 bridge', async () => {
    const seen: string[] = []
    const empty = await probeModel('opencode', '', deps({ opencodeBridge: bridgeStub(seen) }))
    expect(empty.ok).toBe(false)
    expect(empty.message).toContain('缺少模型 id')

    const blank = await probeModel('opencode', '   ', deps({ opencodeBridge: bridgeStub(seen) }))
    expect(blank.ok).toBe(false)
    expect(seen).toHaveLength(0)
  })

  it('缺少 bridge 明确失败', async () => {
    const result = await probeModel('opencode', 'free-a', deps())
    expect(result.ok).toBe(false)
    expect(result.message).toContain('桥不可用')
  })

  it('ensure() 抛错时返回 ok:false 且 message 含根因', async () => {
    const seen: string[] = []
    const result = await probeModel('opencode', 'free-a', deps({
      opencodeBridge: bridgeStub(seen, { ensureError: new Error('ensure boom') }),
    }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('ensure boom')
    expect(seen).toHaveLength(0)
  })

  it('turn() 抛错时返回 ok:false 且 message 含根因', async () => {
    const seen: string[] = []
    const result = await probeModel('opencode', 'free-a', deps({
      opencodeBridge: bridgeStub(seen, { turnError: new Error('turn boom') }),
    }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('turn boom')
    expect(seen).toEqual(['free-a'])
  })

  it('elapsedMs 由注入的 now 决定', async () => {
    const result = await probeModel('opencode', 'free-a', deps({
      now: clock(42),
      opencodeBridge: bridgeStub([]),
    }))
    expect(result.elapsedMs).toBe(42)
  })

  it('供应商级目录为空时明确失败', async () => {
    const result = await probeProvider('opencode', deps({
      opencodeModelIds: async () => [],
    }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('没有可用于测试')
  })

  it('供应商级目录读取抛错时保留根因', async () => {
    const result = await probeProvider('opencode', deps({
      opencodeModelIds: async () => { throw new Error('catalog down') },
    }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('catalog down')
  })

  it('各类失败都返回结果而不抛异常', async () => {
    await expect(probeModel('ghost', '', deps())).resolves.toMatchObject({ ok: false })
    await expect(probeProvider('', deps())).resolves.toMatchObject({ ok: false })
    await expect(probeModel('opencode', 'free-a', deps({
      opencodeBridge: bridgeStub([], { ensureError: new Error('x') }),
    }))).resolves.toMatchObject({ ok: false })
  })
})
