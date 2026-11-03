import { describe, expect, it } from 'vitest'
import { normalizeConversationSettings, unknownConversationSettingKeys } from '../src/shared/assistant'

describe('conversation settings', () => {
  it('keeps the known fields and drops the rest', () => {
    expect(normalizeConversationSettings({
      modelId: 'm_123',
      temperature: 0.7,
      topP: 0.9,
      webSearch: false,
      maxContext: 32_000,
      nonsense: true,
    })).toEqual({ modelId: 'm_123', temperature: 0.7, topP: 0.9, webSearch: false, maxContext: 32_000 })
  })

  it('treats an out-of-range or malformed value as inherit rather than zero', () => {
    expect(normalizeConversationSettings({ temperature: 4, topP: -1, maxContext: 12 })).toEqual({})
    expect(normalizeConversationSettings({ modelId: '../other', webSearch: 'yes' })).toEqual({})
  })

  it('preserves an explicit clear', () => {
    expect(normalizeConversationSettings({ temperature: null, topP: null, maxContext: null, modelId: null }))
      .toEqual({ temperature: null, topP: null, maxContext: null, modelId: null })
  })

  it('names an unknown key so the route can refuse it', () => {
    expect(unknownConversationSettingKeys({ temperature: 0.2, temprature: 0.2 })).toEqual(['temprature'])
    expect(unknownConversationSettingKeys(null)).toEqual([])
    expect(unknownConversationSettingKeys([1, 2])).toEqual([])
  })
})
