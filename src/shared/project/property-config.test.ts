import { describe, expect, it } from 'vitest'
import { parseProjectPropertyConfig, serializeProjectPropertyConfig } from './property-config'

describe('property config parsing', () => {
  it('keeps a relation target board and the multiple flag, dropping unknown keys', () => {
    const parsed = parseProjectPropertyConfig(JSON.stringify({ targetBoardId: 'b1', multiple: true, surprise: 'drop' }))
    expect(parsed).toEqual({ targetBoardId: 'b1', multiple: true })
  })

  it('answers undefined for an empty, malformed or non-object config', () => {
    expect(parseProjectPropertyConfig('{}')).toBeUndefined()
    expect(parseProjectPropertyConfig('[]')).toBeUndefined()
    expect(parseProjectPropertyConfig('not json')).toBeUndefined()
    expect(parseProjectPropertyConfig(null)).toBeUndefined()
  })

  it('round-trips the settings it kept', () => {
    const config = { targetBoardId: 'b1', multiple: true }
    expect(parseProjectPropertyConfig(serializeProjectPropertyConfig(config))).toEqual(config)
  })

  it('keeps a valid rollup config', () => {
    const id = `p${'1'.repeat(26)}`
    const config = { rollup: { relationPropertyId: id, targetPropertyId: id, aggregation: 'avg' as const } }
    expect(parseProjectPropertyConfig(serializeProjectPropertyConfig(config))).toEqual(config)
  })

  it('rejects a rollup with an unknown aggregation or an invalid id', () => {
    const id = `p${'1'.repeat(26)}`
    expect(parseProjectPropertyConfig(JSON.stringify({ rollup: { relationPropertyId: id, targetPropertyId: id, aggregation: 'median' } }))).toBeUndefined()
    expect(parseProjectPropertyConfig(JSON.stringify({ rollup: { relationPropertyId: '../bad', targetPropertyId: id, aggregation: 'sum' } }))).toBeUndefined()
  })
})
