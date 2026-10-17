/**
 * The two numbers a model is known to be held to.
 *
 * `effectiveModelLimits` is what the model editor cuts its output ladder by and what its warning names, so
 * the difference between "nobody said" and "it is small" is the whole file: a ceiling invented here hides
 * presets the provider would have accepted, and a missing one leaves a 1M request to be refused upstream.
 * The account's own ceilings are deliberately absent from the result, which is what the last cases pin.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, effectiveModelLimits } from '../src/shared/assistant'

const known = (over: Parameters<typeof effectiveModelLimits>[0]) => effectiveModelLimits(over)

describe('effectiveModelLimits', () => {
  it('knows nothing when no source has spoken', () => {
    expect(known({ contextTokens: null })).toEqual({ contextWindow: null, maxOutput: null })
    // Not the account's numbers: `maxContextTokens` is a budget for what to send and the default output
    // answers only while the model's own field is empty, so neither may bound a model.
    expect(known({ contextTokens: null, vendorContextTokens: null, vendorMaxOutputTokens: null })).toEqual({
      contextWindow: null,
      maxOutput: null,
    })
    expect(DEFAULT_LIMITS.maxContextTokens).toBeLessThan(DEFAULT_LIMITS.maxOutputTokens)
  })

  it('takes the reader’s declared window when it is the only number there is', () => {
    expect(known({ contextTokens: 65_536 })).toEqual({ contextWindow: 65_536, maxOutput: 65_536 })
  })

  it('takes the vendor’s window when the reader never declared one', () => {
    expect(known({ contextTokens: null, vendorContextTokens: 128_000 })).toEqual({ contextWindow: 128_000, maxOutput: 128_000 })
  })

  it('holds the tighter of the two windows, whoever stated it', () => {
    // A reader who typed a million into the field is still answering to the vendor's 128K, which is the
    // number the provider will refuse above — the detection is what the warning is allowed to name.
    expect(known({ contextTokens: 1_048_576, vendorContextTokens: 128_000 }).contextWindow).toBe(128_000)
    expect(known({ contextTokens: 32_768, vendorContextTokens: 128_000 }).contextWindow).toBe(32_768)
  })

  it('lets a stated output ceiling be tighter than the window', () => {
    // The shape of the bug this exists for: a 128K window whose service stops the answer at 8K.
    expect(known({ contextTokens: 131_072, vendorMaxOutputTokens: 8192 })).toEqual({
      contextWindow: 131_072,
      maxOutput: 8192,
    })
  })

  it('never lets the window be read as an output ceiling the vendor stated', () => {
    // The two are different claims, and only the vendor's own number counts as the second one: a row whose
    // window is known but whose ceiling is not must still be able to answer to the window, not to a
    // smaller figure nobody published.
    expect(known({ contextTokens: null, vendorContextTokens: 8192 }).maxOutput).toBe(8192)
    expect(known({ contextTokens: null, vendorMaxOutputTokens: 262_144, vendorContextTokens: 65_536 }).maxOutput).toBe(65_536)
  })

  it('ignores a count that is not a number or not a size', () => {
    expect(known({ contextTokens: 0, vendorContextTokens: -1, vendorMaxOutputTokens: Number.NaN }).maxOutput).toBeNull()
  })
})
