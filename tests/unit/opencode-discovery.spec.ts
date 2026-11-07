import { describe, expect, it } from 'vitest'
import {
  mergeCatalog,
  serveableModels,
  describeCatalog,
  buildModelSet,
} from '../../src/opencode-discovery.js'
import { composePrompt, parseProtocol, transcriptOf } from '../../src/opencode-bridge.js'

const catalog = {
  opencode: {
    models: {
      free: {
        id: 'free-a', name: 'Free A',
        cost: { input: 0, output: 0 },
        limit: { context: 200000, output: 8192 },
        reasoning: true, tool_call: true,
      },
      paid: {
        id: 'paid-a', name: 'Paid A',
        cost: { input: 1, output: 2 },
        limit: { context: 128000 },
      },
      retired: {
        id: 'retired-free', name: 'Retired',
        cost: { input: 0, output: 0 },
        status: 'deprecated',
      },
      missingCost: { id: 'no-cost', name: 'No Cost', limit: { context: 1000 } },
    },
  },
}

describe('opencode 双源目录', () => {
  it('只收 cost 全 0 的免费模型，cost 缺失不算免费', () => {
    const rows = mergeCatalog(catalog, ['free-a', 'paid-a', 'retired-free'])
    const ids = rows.map((row) => row.id)
    expect(ids).toContain('free-a')
    expect(ids).toContain('retired-free')
    expect(ids).not.toContain('paid-a')
    expect(ids).not.toContain('no-cost')
  })

  it('Zen 只决定 available，不删除已被上游下架的条目', () => {
    const rows = mergeCatalog(catalog, ['free-a'])
    expect(rows.find((row) => row.id === 'free-a')?.available).toBe(true)
    expect(rows.find((row) => row.id === 'retired-free')?.available).toBe(false)
  })

  it('Zen 在供但目录未收录的 -free 模型仍纳入，字段保守', () => {
    const rows = mergeCatalog(catalog, ['free-a', 'brand-new-free'])
    const fresh = rows.find((row) => row.id === 'brand-new-free')
    expect(fresh?.source).toBe('zen')
    expect(fresh?.reasoning).toBe(false)
    expect(fresh?.maxTokens).toBeGreaterThan(0)
  })

  it('Zen 不可达时冷启动按「全部在供」处理，不把目录清空', () => {
    const rows = mergeCatalog(catalog, undefined, { assumeAvailable: true })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.available)).toBe(true)
  })

  it('默认过滤下架与弃用；显式开关才放开弃用，但下架仍不可承接', () => {
    const rows = mergeCatalog(catalog, ['free-a'])
    expect(serveableModels(rows).map((row) => row.id)).toEqual(['free-a'])
    const withDeprecated = serveableModels(rows, { includeDeprecated: true })
    expect(withDeprecated.map((row) => row.id)).toEqual(['free-a'])
  })

  it('disabledModels 在最后一次应用，且手动模型不被上游状态过滤', () => {
    const rows = mergeCatalog(catalog, ['free-a'])
    const set = buildModelSet(rows, [{ id: 'manual-a', name: 'Manual' }], ['free-a'])
    expect(set.map((row) => row.id)).toEqual(['manual-a'])
  })

  it('设置页行标明停用与下架原因，不静默丢条目', () => {
    const rows = mergeCatalog(catalog, ['free-a'])
    const described = describeCatalog(rows, [], ['free-a'], { includeDeprecated: true })
    const free = described.find((row) => row.id === 'free-a')
    expect(free?.disabled).toBe(true)
    const retired = described.find((row) => row.id === 'retired-free')
    expect(retired?.unavailable).toBe(true)
    expect(retired?.reason.length).toBeGreaterThan(0)
  })
})

describe('opencode 桥的文本协议', () => {
  it('system 与对话都并入 prompt 正文（v2 session 无可覆写 system 字段）', () => {
    const text = composePrompt({ system: '规则', prompt: '你好' })
    expect(text).toContain('# System instructions')
    expect(text).toContain('规则')
    expect(text).toContain('你好')
  })

  it('从散文里截取工具协议 JSON，解析失败返回 null', () => {
    expect(parseProtocol('好的\n{"kind":"final","text":"答案"}')?.kind).toBe('final')
    expect(parseProtocol('完全没有 JSON')).toBeNull()
  })

  it('工具结果按 role:tool 转录', () => {
    const text = transcriptOf([
      { role: 'user', content: '问' },
      { role: 'tool', content: '结果' },
    ])
    expect(text).toContain('结果')
  })
})
