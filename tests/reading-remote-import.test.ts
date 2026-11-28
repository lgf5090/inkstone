import { describe, expect, it } from 'vitest'
import { parseRemoteBookUrl } from '../src/client/features/reading/engine/remote-import'

describe('remote book links', () => {
  it('keeps a supported WebDAV filename and normalized URL', () => {
    expect(parseRemoteBookUrl(' https://webdav.example/books/My%20Book.EPUB ')).toEqual({
      url: 'https://webdav.example/books/My%20Book.EPUB',
      filename: 'My Book.EPUB',
      extension: 'epub',
    })
  })

  it('rejects credentials, non-web schemes, and unsupported files', () => {
    for (const value of ['file:///tmp/book.epub', 'https://user:pass@webdav.example/book.epub', 'https://webdav.example/book.exe']) {
      expect(() => parseRemoteBookUrl(value)).toThrow()
    }
  })
})
