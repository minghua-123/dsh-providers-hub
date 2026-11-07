import { describe, expect, it } from 'vitest'
import {
  PROVIDER_REGISTRY,
  channelIds,
  creditCapabilitiesOf,
  descriptorOf,
} from '../../src/provider-registry.js'

describe('精简版渠道清单', () => {
  it('只保留三类入口，且 id 唯一', () => {
    const ids = PROVIDER_REGISTRY.map((entry) => entry.id)
    expect(ids).toEqual(['opencode', 'modelscope', 'custom'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('只有 opencode 与 modelscope 是真实渠道，custom 是虚拟分组', () => {
    expect(channelIds()).toEqual(['opencode', 'modelscope'])
    expect(descriptorOf('custom')?.channel).toBe(false)
    expect(descriptorOf('opencode')?.channel).toBe(true)
    expect(descriptorOf('not-exist')).toBeUndefined()
  })

  it('积分能力从清单派生，不出现第二份字面量', () => {
    const table = creditCapabilitiesOf()
    expect(Object.keys(table).sort()).toEqual(['custom', 'modelscope', 'opencode'])
    expect(table.modelscope.balance).toBe(true)
    expect(table.opencode.balance).toBe(false)
  })

  it('旧渠道 id 不再出现在清单里', () => {
    const ids = PROVIDER_REGISTRY.map((entry) => entry.id)
    for (const legacy of ['codearts', 'buddy', 'qoder', 'cline', 'zcode', 'aggregate', 'minimax']) {
      expect(ids).not.toContain(legacy)
    }
  })
})
