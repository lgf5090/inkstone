import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n, setLocale } from '../src/client/lib/i18n'
import {
  buildMirrorDownloadUrl,
  extractGistId,
  formatDate,
  formatFileSize,
  formatNumber,
  formatRelativeDate,
  inferLanguage,
} from '../src/client/features/development/github/lib/format'
import { getLanguageColor } from '../src/client/features/development/github/lib/format'

beforeAll(async () => {
  await initI18n()
  setLocale('en-US')
})

describe('GitHub format helpers', () => {
  it('formats counts compactly', () => {
    expect(formatNumber(999)).toBe('999')
    expect(formatNumber(1000)).toBe('1K')
    expect(formatNumber(1200)).toBe('1.2K')
    expect(formatNumber(1_000_000)).toBe('1M')
    expect(formatNumber(1_250_000)).toBe('1.3M')
    expect(formatNumber(Number.NaN)).toBe('0')
  })

  it('reuses the shared byte formatter', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
  })

  it('renders an ISO instant as relative time', () => {
    const now = Date.parse('2026-10-28T12:00:00.000Z')
    expect(formatRelativeDate('2026-10-26T12:00:00.000Z', now)).toBe('2 days ago')
    expect(formatDate('2026-10-26T12:00:00.000Z', now)).toBe('2 days ago')
    expect(formatRelativeDate('', now)).toBe('')
    expect(formatRelativeDate('not-a-date', now)).toBe('')
  })

  it('infers a language from an extension', () => {
    expect(inferLanguage('main.ts')).toBe('TypeScript')
    expect(inferLanguage('App.TSX')).toBe('TypeScript')
    expect(inferLanguage('Dockerfile')).toBe('Dockerfile')
    expect(inferLanguage('notes.txt')).toBe('Text')
    expect(inferLanguage('LICENSE')).toBe('Text')
  })

  it('extracts gist ids from URLs and bare values', () => {
    const id = '1234567890abcdef1234567890abcdef'
    expect(extractGistId(`https://gist.github.com/octocat/${id}`)).toBe(id)
    expect(extractGistId(`https://gist.github.com/octocat/${id}/raw/readme.md`)).toBe(id)
    expect(extractGistId(`gist.github.com/octocat/${id}?file=a`)).toBe(id)
    expect(extractGistId(id.toUpperCase())).toBe(id)
    expect(extractGistId('deadbeef')).toBe('deadbeef')
    expect(extractGistId('not-a-gist')).toBeNull()
    expect(extractGistId('gist.github.com/octocat/short')).toBeNull()
  })

  it('builds a validated mirror download URL', () => {
    const original = 'https://github.com/acme/repo/archive/refs/tags/v1.zip'
    expect(buildMirrorDownloadUrl('https://gh-proxy.com/', original)).toBe(`https://gh-proxy.com/${original}`)
    expect(buildMirrorDownloadUrl('https://gh-proxy.com/base', original)).toBe(`https://gh-proxy.com/base/${original}`)
    expect(buildMirrorDownloadUrl('javascript:alert(1)', original)).toBe('')
    expect(buildMirrorDownloadUrl('https://user:pass@gh-proxy.com', original)).toBe('')
    expect(buildMirrorDownloadUrl('https://gh-proxy.com', 'javascript:alert(1)')).toBe('')
    expect(buildMirrorDownloadUrl('https://gh-proxy.com', 'not a url')).toBe('')
  })

  it('re-exports language colors for the detail pane', () => {
    expect(getLanguageColor('TypeScript')).toBe('#3178c6')
  })
})
