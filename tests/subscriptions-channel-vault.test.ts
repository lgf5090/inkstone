// @vitest-environment node
/**
 * Whether the credential vault would actually accept what the channel forms produce.
 *
 * Every notification channel's configuration is stored as one ciphertext, so the vault's own field policy
 * is on the save path of all ten of them. The channel routes' tests cannot see a mismatch, because they
 * run against a vault double that encrypts anything — which is exactly how `channel:` came to be missing
 * from the accepted scopes while every other scope was listed, and how the field whitelist that guards
 * *backup* credentials was the one judging channel bundles. Both rejections surfaced as "the vault binding
 * is missing", which is a sentence that points at the deployment rather than at this file.
 *
 * So this builds a configuration for every declared channel out of the channel definition itself and asks
 * the real predicate. Adding a channel with a field name the vault would refuse fails here, not on a
 * reader's save press.
 */
import { describe, expect, it } from 'vitest'
import { CHANNEL_DEFINITIONS } from '@shared/subscriptions/channels'
import type { ChannelField } from '@shared/subscriptions/channels'
import { isCredentialRecord, isScope } from '../src/worker/durable/credential-vault'

const ROW_ID = '0123456789abcdefghjkmnpqrs'

/** A value of the type the settings screen would actually send for this field. */
function sampleValue(field: ChannelField): string | boolean {
  switch (field.type) {
    case 'switch': return true
    case 'select': return field.options[0]!.value
    case 'json': return '{}'
    case 'url': return 'https://example.com/hook'
    case 'email': return 'reader@example.com'
    default: return 'a-value-of-some-length'
  }
}

function configOf(definition: typeof CHANNEL_DEFINITIONS[number]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (const field of definition.fields) out[field.key] = sampleValue(field)
  return out
}

describe('the vault against the channel forms', () => {
  it('accepts a scope for every channel row id', () => {
    expect(isScope(`channel:${ROW_ID}`)).toBe(true)
  })

  it('accepts the configuration every declared channel produces', () => {
    for (const definition of CHANNEL_DEFINITIONS) {
      const config = configOf(definition)
      if (Object.keys(config).length === 0) continue
      expect(isCredentialRecord(`channel:${ROW_ID}`, config), `${definition.kind} cannot be saved`).toBe(true)
    }
  })

  it('accepts the switch fields as booleans, which is what the form reads back', () => {
    expect(isCredentialRecord(`channel:${ROW_ID}`, { webhook: 'https://qyapi.example.com/x', atAll: true })).toBe(true)
    expect(isCredentialRecord(`channel:${ROW_ID}`, { server: 'https://api.day.app', deviceKey: 'k', isArchive: false })).toBe(true)
  })

  it('still bounds the bundle: field names, count, empties and sizes', () => {
    const scope = `channel:${ROW_ID}`
    expect(isCredentialRecord(scope, {})).toBe(false)
    expect(isCredentialRecord(scope, { '': 'x' })).toBe(false)
    expect(isCredentialRecord(scope, { '1leading-digit': 'x' })).toBe(false)
    expect(isCredentialRecord(scope, { 'has a space': 'x' })).toBe(false)
    expect(isCredentialRecord(scope, { botToken: '' })).toBe(false)
    expect(isCredentialRecord(scope, { count: 42 })).toBe(false)
    expect(isCredentialRecord(scope, { url: 'y'.repeat(5000) })).toBe(false)
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`field${index}`, 'x']))
    expect(isCredentialRecord(scope, many)).toBe(false)
  })

  it('keeps the other scopes as strict as they were', () => {
    // A boolean is a channel's switch, not a backup password or an assistant key.
    expect(isCredentialRecord(`backup:${ROW_ID}`, { password: 'p' })).toBe(true)
    expect(isCredentialRecord(`backup:${ROW_ID}`, { password: true })).toBe(false)
    expect(isCredentialRecord(`backup:${ROW_ID}`, { botToken: 'x' })).toBe(false)
    expect(isCredentialRecord(`ai:${ROW_ID}`, { apiKey: 'sk-test' })).toBe(true)
    expect(isCredentialRecord(`ai:${ROW_ID}`, { apiKey: 'sk-test', chatId: '42' })).toBe(false)
    expect(isCredentialRecord(`totp:${ROW_ID}`, { secret: 'A'.repeat(32) })).toBe(true)
    expect(isScope(`weird:${ROW_ID}`)).toBe(false)
    expect(isScope(`channel:${ROW_ID.slice(0, 25)}`)).toBe(false)
  })
})
