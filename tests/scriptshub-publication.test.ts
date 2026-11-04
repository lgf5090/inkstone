import { describe, expect, it } from 'vitest'
import {
  contentTypeForFile,
  languageFor,
  languageFromFileName,
} from '../src/shared/scriptshub/languages'
import {
  contentDisposition,
  etagMatches,
  requestedRevision,
  scriptCacheControl,
  scriptEtag,
} from '../src/shared/scriptshub/publication'

describe('script language mapping', () => {
  it('maps the extensions a published script is named with', () => {
    expect(languageFromFileName('flatpak-setup.sh').id).toBe('shell')
    expect(languageFromFileName('cleanup.PY').id).toBe('python')
    expect(languageFromFileName('Dockerfile').id).toBe('dockerfile')
    expect(languageFromFileName('notes.md').id).toBe('markdown')
    expect(languageFromFileName('unknown.bin').id).toBe('text')
  })

  it('serves the content type the extension claims, and text/plain when it claims nothing', () => {
    expect(contentTypeForFile('flatpak-setup.sh')).toBe('text/x-shellscript; charset=utf-8')
    expect(contentTypeForFile('deploy.py')).toBe('text/x-python; charset=utf-8')
    expect(contentTypeForFile('manifest.json')).toBe('application/json; charset=utf-8')
    expect(contentTypeForFile('unknown.bin', 'shell')).toBe('text/x-shellscript; charset=utf-8')
    expect(contentTypeForFile('unknown.bin')).toBe('text/plain; charset=utf-8')
  })

  it('falls back to plain text for a language id this app does not own', () => {
    expect(languageFor('nonesuch').id).toBe('text')
    expect(languageFor('python').id).toBe('python')
  })
})

describe('conditional distribution headers', () => {
  it('treats the digest as a strong quoted validator', () => {
    const digest = 'a'.repeat(64)
    expect(scriptEtag(digest)).toBe(`"sha256:${digest}"`)
  })

  it('answers a weak tag, a list and * as the same validator', () => {
    const etag = '"sha256:abc"'
    expect(etagMatches('"other", W/"sha256:abc"', etag)).toBe(true)
    expect(etagMatches('*', etag)).toBe(true)
    expect(etagMatches('"other"', etag)).toBe(false)
    expect(etagMatches(null, etag)).toBe(false)
  })

  it('never caches a token-gated or paused response', () => {
    expect(scriptCacheControl('public', true)).toBe('public, max-age=60, must-revalidate')
    expect(scriptCacheControl('token', true)).toBe('private, no-store')
    expect(scriptCacheControl('public', false)).toBe('no-store')
  })

  it('builds a filename header that cannot be split by a quote or a newline', () => {
    expect(contentDisposition('flatpak-setup.sh')).toContain('filename="flatpak-setup.sh"')
    expect(contentDisposition('bad"name.sh')).not.toContain('bad"name')
    expect(contentDisposition('中文脚本.sh')).toContain("filename*=UTF-8''")
  })

  it('resolves a pinned version with the query taking precedence over the suffix', () => {
    expect(requestedRevision('3', 7)).toBe(3)
    expect(requestedRevision(null, 7)).toBe(7)
    expect(requestedRevision('0', null)).toBeNull()
    expect(requestedRevision('nope', null)).toBeNull()
    expect(requestedRevision(null, null)).toBeNull()
  })
})
