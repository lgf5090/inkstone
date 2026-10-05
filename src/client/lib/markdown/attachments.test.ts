import { describe, expect, it } from 'vitest'
import type { Attachment } from '@shared/types'
import {
  applyEmbedSize,
  attachmentFileName,
  isAttachmentTarget,
  parseEmbedSize,
  renderAttachmentEmbed,
  splitAltSize,
} from './attachments'

const file = (over: Partial<Attachment>): Attachment => ({
  id: 'a'.repeat(26),
  noteId: null,
  filename: 'photo.png',
  mime: 'image/png',
  size: 1200,
  width: 900,
  height: 600,
  url: `/api/files/${'a'.repeat(26)}`,
  createdAt: 1,
  ...over,
})

function embedBox(raw: string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'note-embed loading'
  box.setAttribute('aria-busy', 'true')
  box.innerHTML = `<span class="note-embed-head" data-wikilink="${raw}" role="link" tabindex="0">${raw}</span><div class="note-embed-body" aria-busy="true">loading</div>`
  return box
}

describe('attachment targets', () => {
  it('recognises asset names, including paths', () => {
    expect(isAttachmentTarget('photo.png')).toBe(true)
    expect(isAttachmentTarget('assets/Clip.MP4')).toBe(true)
    expect(isAttachmentTarget('My Note')).toBe(false)
    expect(isAttachmentTarget('')).toBe(false)
    expect(attachmentFileName('assets/sub/photo.png')).toBe('photo.png')
  })

  it('reads the Obsidian size suffix from embeds and alt text', () => {
    expect(parseEmbedSize('600')).toEqual({ width: 600, height: null })
    expect(parseEmbedSize('300x200')).toEqual({ width: 300, height: 200 })
    expect(parseEmbedSize('Writing')).toBeNull()
    expect(splitAltSize('Sunset|640x480')).toEqual({ alt: 'Sunset', size: { width: 640, height: 480 } })
    expect(splitAltSize('a|b|200')).toEqual({ alt: 'a|b', size: { width: 200, height: null } })
    expect(splitAltSize('plain alt').size).toBeNull()
    expect(splitAltSize('weird|cat').size).toBeNull()
  })

  it('paints an image embed with its size and no leftover note link', () => {
    const box = embedBox('photo.png|600x400')
    renderAttachmentEmbed(box, file({}), parseEmbedSize('600x400'))
    const img = box.querySelector('img')!
    expect(img.getAttribute('width')).toBe('600')
    expect(img.getAttribute('height')).toBe('400')
    expect(img.getAttribute('alt')).toBe('photo.png')
    expect(box.querySelector('.note-embed-head')!.textContent).toBe('photo.png')
    expect(box.querySelector('.note-embed-head')!.hasAttribute('data-wikilink')).toBe(false)
    expect(box.className).toContain('ready')
    expect(box.getAttribute('aria-busy')).toBeNull()
    expect(box.textContent).not.toContain('loading')
  })

  it('links a non-image attachment instead of embedding a frame the CSP forbids', () => {
    const box = embedBox('doc.pdf')
    renderAttachmentEmbed(box, file({ filename: 'doc.pdf', mime: 'application/pdf' }), null)
    expect(box.querySelector('img')).toBeNull()
    const link = box.querySelector<HTMLAnchorElement>('a.attachment-open')!
    expect(link.getAttribute('download')).toBe('doc.pdf')
    expect(box.querySelector('iframe, object, embed')).toBeNull()
  })

  it('applies nothing when there is no size', () => {
    const img = document.createElement('img')
    applyEmbedSize(img, null)
    expect(img.hasAttribute('width')).toBe(false)
  })
})
