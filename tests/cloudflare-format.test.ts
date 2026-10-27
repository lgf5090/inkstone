// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { percentLabel } from '../src/client/features/cloudflare/lib/format'
import { cfErrorDetail, cfErrorText } from '../src/client/features/cloudflare/api/client'
import { ApiError } from '../src/client/lib/api'

describe('percentLabel', () => {
  it('keeps a used-but-small allowance distinguishable from an unused one', () => {
    expect(percentLabel(0, 10_000)).toBe('0%')
    expect(percentLabel(489, 100_000)).toBe('<1%')
    expect(percentLabel(5_000, 10_000)).toBe('50%')
    expect(percentLabel(20_000, 10_000)).toBe('100%')
    expect(percentLabel(5, 0)).toBe('0%')
  })
})

describe('the cloudflare error text', () => {
  it('shows the localised line for the code and keeps the server sentence as detail', () => {
    const failure = new ApiError(502, 'cloudflare_upstream', 'Cloudflare could not complete the request', undefined, 'unknown field "requests"')
    expect(cfErrorText(failure)).not.toContain('unknown field')
    expect(cfErrorDetail(failure)).toBe('unknown field "requests"')
  })

  it('has no detail line for a failure that is not the transfer’s refusal', () => {
    expect(cfErrorDetail(new Error('plain'))).toBe('')
    expect(cfErrorText(new Error('plain'))).toBe('plain')
    expect(cfErrorText('a string')).toBe('a string')
  })
})
