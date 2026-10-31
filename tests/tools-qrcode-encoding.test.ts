import { describe, expect, it } from 'vitest'
import { encodeQrData } from '../src/client/features/tools/qrcode/store'

const state = {
  textContent: '',
  urlContent: '',
  wifiContent: { ssid: '', password: '', encryption: 'WPA' as const, hidden: false },
  vcardContent: {},
  emailContent: {},
  phoneContent: {},
}

const withUrl = (urlContent: string) => encodeQrData('url', { ...state, urlContent } as never)
const withEmail = (emailContent: object) => encodeQrData('email', { ...state, emailContent } as never)
const withPhone = (phoneContent: object) => encodeQrData('phone', { ...state, phoneContent } as never)
const withWifi = (wifiContent: object) => encodeQrData('wifi', { ...state, wifiContent } as never)
const withVcard = (vcardContent: object) => encodeQrData('vcard', { ...state, vcardContent } as never)

describe('QR payload encoders', () => {
  it('normalises a URL into a form readers do not truncate', () => {
    expect(withUrl('')).toBe('')
    expect(withUrl('example.com/a b')).toBe('https://example.com/a%20b')
    expect(withUrl('https://example.com/docs/q1')).toBe('https://example.com/docs/q1')
    expect(withUrl('例え.jp/x')).toBe('https://xn--r8jz45g.jp/x')
    expect(withUrl('mailto:hi@example.com')).toBe('mailto:hi@example.com')
  })

  it('keeps a mailto address literal and spells spaces as %20', () => {
    expect(
      withEmail({ to: 'a.b+c@example.com', subject: '你好 & 谢谢', body: 'line1\nline2' })
    ).toBe(
      'mailto:a.b+c@example.com?subject=%E4%BD%A0%E5%A5%BD%20%26%20%E8%B0%A2%E8%B0%A2&body=line1%0Aline2'
    )
    expect(withEmail({ to: 'a@b.com' })).toBe('mailto:a@b.com')
    expect(withEmail({ to: '' })).toBe('')
  })

  it('does not let a line break forge extra fields anywhere', () => {
    expect(withEmail({ to: 'a@b.com\r\nX-Smuggled: 1' })).toBe('mailto:a@b.comX-Smuggled:1')
    expect(withVcard({ lastName: 'A\r\nEND:VCARD\r\nFAKE:X', mobile: '1' })).toContain(
      'FN:A END\\:VCARD FAKE\\:X'
    )
    expect(withWifi({ ssid: 'a\nb', password: 'p', encryption: 'WPA' })).toBe(
      'WIFI:S:a b;T:WPA;P:p;H:false;;'
    )
    expect(withPhone({ phone: '13800000000', message: 'a\r\nb' })).toBe('smsto:13800000000:a b')
  })

  it('escapes the separators that would split a vCard field', () => {
    const card = withVcard({
      firstName: 'Lee',
      lastName: 'Chen',
      phone: '010-1',
      organization: 'ACME, Inc: Lab',
      address: 'Floor 2; Block B',
    })
    expect(card).toContain('FN:Chen Lee')
    expect(card).toContain('ORG:ACME\\, Inc\\: Lab')
    expect(card).toContain('ADR;TYPE=WORK:;;Floor 2\\; Block B;;;;')
    expect(card).toContain('TEL;TYPE=WORK,VOICE:010-1')
    expect(card.split('\n').filter((l) => l.startsWith('ADR')).length).toBe(1)
  })

  it('signs a Han card without a space and everyone else with one', () => {
    expect(withVcard({ firstName: '小明', lastName: '李' })).toContain('FN:李小明')
    expect(withVcard({ firstName: 'Lee', lastName: 'Chen' })).toContain('FN:Chen Lee')
    expect(withVcard({ lastName: 'Chen' })).toContain('FN:Chen')
    expect(withVcard({})).toBe('')
  })

  it('keeps the Wi-Fi escaping that protects SSIDs with punctuation', () => {
    expect(
      withWifi({ ssid: 'my,net;work', password: 'p:a"ss', encryption: 'WPA', hidden: true })
    ).toBe('WIFI:S:my\\,net\\;work;T:WPA;P:p\\:a\\"ss;H:true;;')
    expect(withWifi({ ssid: 'open', encryption: 'none' })).toBe('WIFI:S:open;T:nopass;P:;H:false;;')
    expect(withWifi({ ssid: '   ' })).toBe('')
  })

  it('falls back to a dial request when there is no message', () => {
    expect(withPhone({ phone: '13800000000' })).toBe('tel:13800000000')
    expect(withPhone({ phone: '', message: 'hi' })).toBe('')
  })
})
