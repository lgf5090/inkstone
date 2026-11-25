import { describe, expect, it, vi } from 'vitest'
import { privateAttachmentId } from '../../lib/private-attachment-url'
import { resolveEncryptedPreviewAttachments } from './preview-encrypted-attachments'

const ID = '00000000000000000000000001'

describe('encrypted preview attachments', () => {
  it('accepts only same-origin private attachment URLs', () => {
    expect(privateAttachmentId(`/api/files/${ID}?v=1`)).toBe(ID)
    expect(privateAttachmentId(`${window.location.origin}/api/files/${ID}`)).toBe(ID)
    expect(privateAttachmentId(`https://example.com/api/files/${ID}`)).toBeNull()
    expect(privateAttachmentId('/api/files/not-an-id')).toBeNull()
    expect(privateAttachmentId('blob:existing')).toBeNull()
  })

  it('rewrites media and download links before they enter the live preview', async () => {
    const root = document.createElement('div')
    root.innerHTML = `<img src="/api/files/${ID}"><a href="/api/files/${ID}">download</a><img src="https://example.com/remote.png">`
    const resolve = vi.fn().mockResolvedValue({ url: 'blob:decrypted', filename: 'photo.png', mime: 'image/png' })
    await resolveEncryptedPreviewAttachments(root, resolve, 'Unavailable')
    expect(root.querySelector('img')?.getAttribute('src')).toBe('blob:decrypted')
    expect(root.querySelector('a')?.getAttribute('href')).toBe('blob:decrypted')
    expect(root.querySelector('a')?.getAttribute('download')).toBe('photo.png')
    expect(root.querySelectorAll('img')[1]?.getAttribute('src')).toBe('https://example.com/remote.png')
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('removes failed media URLs and leaves an accessible explanation', async () => {
    const root = document.createElement('div')
    root.innerHTML = `<img src="/api/files/${ID}"><a href="/api/files/${ID}">download</a>`
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await resolveEncryptedPreviewAttachments(root, vi.fn().mockRejectedValue(new Error('locked')), 'Unavailable')
    expect(root.querySelector('[src^="/api/files/"]')).toBeNull()
    expect(root.querySelector('[href^="/api/files/"]')).toBeNull()
    expect(root.querySelector('.attachment-decrypt-error')?.textContent).toBe('Unavailable')
    expect(root.querySelector('a')?.getAttribute('aria-disabled')).toBe('true')
  })
})
