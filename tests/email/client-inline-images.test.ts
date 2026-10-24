// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { EmailAttachment } from '@shared/email/model'
import { EmailFrame } from '../../src/client/features/email/EmailFrame'
import { emailMarkdownToHtml } from '../../src/client/features/email/email-markdown'
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
