// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { EmailAttachment } from '@shared/email/model'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { EmailFrame } from '../../src/client/features/email/EmailFrame'

const inlineImage: EmailAttachment = {
  id: 'a1',
  filename: 'logo.png',
  mime: 'image/png',
  size: 128,
  width: 16,
  height: 16,
  contentId: 'logo@example.com',
  disposition: 'inline',
  url: '/api/email/files/a1',
  createdAt: '2026-10-24T00:00:00.000Z',
}

let view: RenderedElement | null = null

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  document.documentElement.dataset.theme = 'light'
})

function documentOf(): string {
  const frame = document.querySelector<HTMLIFrameElement>('iframe')
  if (!frame) throw new Error('no email frame')
  return frame.getAttribute('srcdoc') ?? ''
}

describe('the email reading frame', () => {
  it('uses the note reading measure, typography and light palette', () => {
    document.documentElement.dataset.theme = 'light'
    view = renderElement(createElement(EmailFrame, {
      body: '<p>Hello there</p>',
      attachments: [],
      subject: 'Hello',
    }))
    const doc = documentOf()
    expect(doc).toContain('class="email-reading"')
    expect(doc).toContain('max-width:72ch')
    expect(doc).toContain('font-size:16px')
    expect(doc).toContain('line-height:1.65')
    expect(doc).toContain('color-scheme:light')
    expect(doc).toContain('background:#ffffff')
    expect(doc).toContain("script-src 'none'")
    expect(document.querySelector('iframe')!.getAttribute('sandbox')).not.toContain('allow-scripts')
  })

  it('follows the dark theme instead of forcing a white page', () => {
    document.documentElement.dataset.theme = 'dark'
    view = renderElement(createElement(EmailFrame, {
      body: '<p>Hello there</p>',
      attachments: [],
      subject: 'Hello',
    }))
    const doc = documentOf()
    expect(doc).toContain('color-scheme:dark')
    expect(doc).toContain('background:#1b1d1f')
  })

  it('rewrites cid images to the attachment URL', () => {
    view = renderElement(createElement(EmailFrame, {
      body: '<p>Logo</p><img src="cid:logo@example.com" alt="Logo">',
      attachments: [inlineImage],
      subject: 'Logo',
    }))
    expect(documentOf()).toContain('src="/api/email/files/a1"')
  })
})
