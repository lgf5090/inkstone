import { describe, expect, it } from 'vitest'
import { emailUnsubscribeAction } from '../../src/shared/email/unsubscribe'

describe('email unsubscribe headers', () => {
  it('reads HTTPS one-click unsubscribe', () => {
    expect(emailUnsubscribeAction([
      { key: 'List-Unsubscribe', value: '<https://example.com/unsubscribe?id=1>' },
      { key: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
    ])).toEqual({ url: 'https://example.com/unsubscribe?id=1', oneClick: true })
  })

  it('reads mailto unsubscribe and rejects unsafe schemes', () => {
    expect(emailUnsubscribeAction([{ key: 'list-unsubscribe', value: '<mailto:unsubscribe@example.com>' }]))
      .toEqual({ email: 'unsubscribe@example.com', oneClick: false })
    expect(emailUnsubscribeAction([{ key: 'List-Unsubscribe', value: '<javascript:alert(1)>' }])).toBeNull()
  })

  it('prefers HTTPS across multiple addresses and strips a mailto query', () => {
    expect(emailUnsubscribeAction([{
      key: 'List-Unsubscribe',
      value: '<mailto:unsubscribe%40example.com?subject=unsubscribe>, <https://example.com/remove>',
    }])).toEqual({ url: 'https://example.com/remove', oneClick: false })
    expect(emailUnsubscribeAction([{
      key: 'List-Unsubscribe',
      value: '<mailto:unsubscribe%40example.com?subject=unsubscribe>',
    }])).toEqual({ email: 'unsubscribe@example.com', oneClick: false })
  })

  it('rejects malformed URLs and mailboxes', () => {
    expect(emailUnsubscribeAction([{ key: 'List-Unsubscribe', value: '<https://>' }])).toBeNull()
    expect(emailUnsubscribeAction([{ key: 'List-Unsubscribe', value: '<mailto:not-an-address>' }])).toBeNull()
    expect(emailUnsubscribeAction([{ key: 'List-Unsubscribe', value: '<mailto:%E0%A4%A>' }])).toBeNull()
  })
})
