import { describe, expect, it } from 'vitest'
import {
  PROVIDER_REGISTRY,
  channelIds,
  creditCapabilitiesOf,
  descriptorOf,
} from '../../src/provider-registry.js'

describe('0.3.2 渠道清单', () => {
  it('清单只保留一条 opencode 渠道，且为真实渠道', () => {
    expect(PROVIDER_REGISTRY).toHaveLength(1)
    expect(PROVIDER_REGISTRY[0].id).toBe('opencode')
    expect(PROVIDER_REGISTRY[0].channel).toBe(true)
    expect(new Set(PROVIDER_REGISTRY.map((entry) => entry.id)).size).toBe(1)
  })

  it('channelIds() 只返回 opencode', () => {
    expect(channelIds()).toEqual(['opencode'])
  })

  it('已移除的渠道 id 查不到描述符', () => {
    expect(descriptorOf('modelscope')).toBeUndefined()
    expect(descriptorOf('custom')).toBeUndefined()
    expect(descriptorOf('')).toBeUndefined()
  })

  it('积分能力表只有 opencode 且从清单派生', () => {
    const table = creditCapabilitiesOf()
    expect(Object.keys(table)).toEqual(['opencode'])
    expect(table.opencode).toEqual({ balance: false, dailyCheckin: false })
  })

  it('清单、描述符与积分能力表均不可变', () => {
    expect(Object.isFrozen(PROVIDER_REGISTRY)).toBe(true)
    const descriptor = PROVIDER_REGISTRY[0]
    expect(Object.isFrozen(descriptor)).toBe(true)
    expect(Object.isFrozen(descriptor.credits)).toBe(true)
    expect(Object.isFrozen(creditCapabilitiesOf())).toBe(true)
  })

  it('channelIds() 返回派生副本，改写不影响清单', () => {
    const ids = channelIds()
    ids.push('ghost')
    expect(channelIds()).toEqual(['opencode'])
    expect(PROVIDER_REGISTRY).toHaveLength(1)
  })
})
