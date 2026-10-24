import { describe, expect, it } from 'vitest'
import { EMAIL_LEGACY_SIGNATURE_ID, normalizeEmailSignatures } from '../../src/shared/email/model'

describe('email signature normalization', () => {
  it('turns a legacy signature into the first signature entry', () => {
    const result = normalizeEmailSignatures({
      signature: { enabled: true, text: 'Ada Lovelace' },
    })
    expect(result).toEqual({
      signatures: [{
        id: EMAIL_LEGACY_SIGNATURE_ID,
        name: '',
        text: 'Ada Lovelace',
        enabled: true,
      }],
      defaultId: EMAIL_LEGACY_SIGNATURE_ID,
    })
  })

  it('keeps a disabled legacy signature but ignores an empty one', () => {
    expect(normalizeEmailSignatures({ signature: { enabled: false, text: 'Ada' } })).toEqual({
      signatures: [{
        id: EMAIL_LEGACY_SIGNATURE_ID,
        name: '',
        text: 'Ada',
        enabled: false,
      }],
      defaultId: EMAIL_LEGACY_SIGNATURE_ID,
    })
    expect(normalizeEmailSignatures({ signature: { enabled: true, text: '   ' } })).toEqual({
      signatures: [],
      defaultId: null,
    })
  })

  it('keeps a saved signature list and its chosen default', () => {
    const result = normalizeEmailSignatures({
      signatures: [
        { id: 'work', name: 'Work', text: 'Ada at work', enabled: true },
        { id: 'personal', name: 'Personal', text: 'Ada at home' },
      ],
      defaultSignatureId: 'personal',
    })
    expect(result.signatures).toEqual([
      { id: 'work', name: 'Work', text: 'Ada at work', enabled: true },
      { id: 'personal', name: 'Personal', text: 'Ada at home', enabled: true },
    ])
    expect(result.defaultId).toBe('personal')
  })

  it('falls back to the first enabled signature when the default is missing or disabled', () => {
    expect(normalizeEmailSignatures({
      signatures: [
        { id: 'work', name: 'Work', text: 'Ada at work', enabled: false },
        { id: 'personal', name: 'Personal', text: 'Ada at home', enabled: true },
      ],
      defaultSignatureId: 'missing',
    }).defaultId).toBe('personal')
    expect(normalizeEmailSignatures({
      signatures: [
        { id: 'work', name: 'Work', text: 'Ada at work', enabled: false },
        { id: 'personal', name: 'Personal', text: 'Ada at home', enabled: true },
      ],
      defaultSignatureId: 'work',
    }).defaultId).toBe('personal')
  })

  it('prefers the saved list over a leftover legacy signature', () => {
    const result = normalizeEmailSignatures({
      signature: { enabled: true, text: 'Old signature' },
      signatures: [],
      defaultSignatureId: 'work',
    })
    expect(result).toEqual({ signatures: [], defaultId: null })
  })
})
