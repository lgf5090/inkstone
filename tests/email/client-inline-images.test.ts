// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { EmailAttachment } from '@shared/email/model'
import { EmailFrame } from '../../src/client/features/email/EmailFrame'
import { emailMarkdownToHtml, sanitizeEmailHtml } from '../../src/client/features/email/email-markdown'
import { rewriteEmailCidSources } from '../../src/client/features/email/format'
import { renderElement } from '../../src/client/lib/test-render'

function attachment(overrides: Partial<EmailAttachment> = {}): EmailAttachment {
  return {
    id: 'att1',
    filename: 'photo.png',
    mime: 'image/png',
    size: 3,
    width: null,
    height: null,
    contentId: '<Photo-1@Inkstone>',
    disposition: 'inline',
    url: '/api/email/files/att1',
    createdAt: '2026-10-20T09:00:00.000Z',
    ...overrides,
  }
}

describe('cid image rewriting', () => {
  it('matches content ids case-insensitively, with angle brackets and percent encoding', () => {
    const html = [
      '<img src="cid:photo-1%40inkstone">',
      '<img src="CID:<Photo-1@Inkstone>">',
      '<p>cid:photo-1@inkstone</p>',
      '<img src="cid:missing">',
    ].join('')
    const rewritten = rewriteEmailCidSources(html, [attachment()])

    expect(rewritten).toContain('<img src="/api/email/files/att1">')
    expect(rewritten).toContain('<img src="/api/email/files/att1">')
    expect(rewritten).toContain('<p>cid:photo-1@inkstone</p>')
    expect(rewritten).toContain('<img src="cid:missing">')
    expect(rewritten.match(/\/api\/email\/files\/att1/g)).toHaveLength(2)
  })

  it('maps the cid shapes Gmail, Outlook, Apple Mail and QQ send', () => {
    const html = [
      '<img src="cid:ii_lz9x1abc@mail.gmail.com">',
      '<img src="cid:image001.png@01DA1234.56789ABC">',
      '<img src="cid:B4C1D2E3-0000-4000-8000-ABCDEF012345">',
      '<img src="cid:img001%40qq.com">',
    ].join('')
    const rewritten = rewriteEmailCidSources(html, [
      attachment({ id: 'gmail', contentId: '<ii_lz9x1abc@mail.gmail.com>', url: '/api/email/files/gmail' }),
      attachment({ id: 'outlook', contentId: '<image001.png@01DA1234.56789ABC>', url: '/api/email/files/outlook' }),
      attachment({ id: 'apple', contentId: '<B4C1D2E3-0000-4000-8000-ABCDEF012345>', url: '/api/email/files/apple' }),
      attachment({ id: 'qq', contentId: '<img001@qq.com>', disposition: 'attachment', url: '/api/email/files/qq' }),
    ])

    expect(rewritten).not.toContain('cid:')
    for (const source of ['gmail', 'outlook', 'apple', 'qq']) {
      expect(rewritten).toContain(`src="/api/email/files/${source}"`)
    }
  })

  it('keeps data and remote images that clients embed without a content id', () => {
    const html = [
      '<img src="data:image/png;base64,AAAA" alt="inline">',
      '<img src="https://images.example.com/photo.png" alt="remote">',
    ].join('')
    const sanitized = sanitizeEmailHtml(html)
    expect(sanitized).toContain('data:image/png;base64,AAAA')
    expect(sanitized).toContain('https://images.example.com/photo.png')
  })

  it('leaves markup untouched when no attachment carries a content id', () => {
    const html = '<img src="cid:photo-1">'
    expect(rewriteEmailCidSources(html, [attachment({ contentId: null })])).toBe(html)
  })

  it('keeps cid urls in the html that is saved and sent', () => {
    expect(emailMarkdownToHtml('![photo](cid:inline-1)')).toContain('src="cid:inline-1"')
  })

  it('rewrites the reading pane image and still sanitizes the frame', () => {
    const view = renderElement(createElement(EmailFrame, {
      body: '<p>Hello</p><img src="cid:photo-1%40inkstone" onerror="alert(1)"><script>alert(2)</script>',
      attachments: [attachment()],
      subject: 'Inline image',
    }))
    const frame = view.container.querySelector('iframe')
    expect(frame?.getAttribute('sandbox')).toBe('allow-same-origin allow-popups allow-popups-to-escape-sandbox')
    const document = frame?.getAttribute('srcdoc') ?? ''
    expect(document).toContain("script-src 'none'")
    expect(document).toContain('src="/api/email/files/att1"')
    expect(document).not.toContain('cid:')
    expect(document).not.toContain('alert(1)')
    expect(document).not.toContain('alert(2)')
    view.unmount()
  })
})
