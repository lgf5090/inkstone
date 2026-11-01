import { describe, expect, it } from 'vitest'
import { summarizeQrPayload } from '../src/client/features/tools/qrcode/history/payload-summary'
import { encodeQrData } from '../src/client/features/tools/qrcode/store'

const blank: Parameters<typeof encodeQrData>[1] = {
  textContent: '',
  urlContent: '',
  wifiContent: { ssid: '', encryption: 'WPA' },
  vcardContent: { firstName: '', lastName: '' },
  emailContent: { to: '', subject: '', body: '' },
  phoneContent: { phone: '' },
}

describe('history payload summary', () => {
  it('prints the address of a link and plain text unchanged', () => {
    expect(summarizeQrPayload('url', 'https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(summarizeQrPayload('text', '  hello  ')).toBe('hello')
    expect(summarizeQrPayload('text', '   ')).toBe('')
  })

  it('names the network without reprinting the key', () => {
    const payload = encodeQrData('wifi', {
      ...blank,
      wifiContent: { ssid: 'Inkstone;Office', password: 'hunter45', encryption: 'WPA', hidden: false },
    })
    expect(payload).toContain('hunter45')
    const summary = summarizeQrPayload('wifi', payload)
    expect(summary).toBe('Inkstone;Office')
    expect(summary).not.toContain('hunter45')
  })

  it('shows the card holder rather than the whole vCard', () => {
    const payload = encodeQrData('vcard', {
      ...blank,
      vcardContent: { firstName: 'Ming', lastName: 'Li', mobile: '13800138000' },
    })
    expect(payload.split('\n').length).toBeGreaterThan(4)
    expect(summarizeQrPayload('vcard', payload)).toBe('Li Ming')
  })

  it('unwraps mailto and tel prefixes', () => {
    const mail = encodeQrData('email', {
      ...blank,
      emailContent: { to: 'a@b.test', subject: 'Hi there', body: '' },
    })
    expect(summarizeQrPayload('email', mail)).toBe('a@b.test')

    expect(summarizeQrPayload('phone', encodeQrData('phone', { ...blank, phoneContent: { phone: '+8613800138000' } }))).toBe(
      '+8613800138000'
    )
    const sms = encodeQrData('phone', {
      ...blank,
      phoneContent: { phone: '13800138000', message: 'a long drafted message' },
    })
    expect(summarizeQrPayload('phone', sms)).toBe('13800138000')
  })

  it('falls back to the payload when a protocol marker is missing', () => {
    expect(summarizeQrPayload('wifi', 'something else')).toBe('something else')
    expect(summarizeQrPayload('vcard', 'BEGIN:VCARD\nEND:VCARD')).toBe('BEGIN:VCARD\nEND:VCARD')
  })
})
