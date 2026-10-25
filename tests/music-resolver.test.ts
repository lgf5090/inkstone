// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveCustomSource } from '../src/worker/music/providers/custom/resolver'
import { createMusicSourceResolver } from '../src/worker/music/providers/source'
import { DEFAULT_MUSIC_SETTINGS, type MusicTrack } from '../src/shared/music/model'

const track: MusicTrack = {
  id: 't1',
  provider: 'netease',
  providerId: '42',
  kind: 'song',
  title: 'Song',
  artists: [{ id: '1', name: 'Artist' }],
  album: 'Album',
  albumId: '9',
  coverUrl: '',
  coverKey: '',
  durationMs: 1,
  format: 'mp3',
  bitrate: null,
  size: null,
  sha256: '',
  r2Key: null,
  source: 'netease',
  sourceQuality: 'exhigh',
  createdAt: 0,
  updatedAt: 0,
}

const config = {
  url: 'https://resolver.example.test/audio',
  method: 'GET' as const,
  params: { id: '{id}', quality: '{quality}' },
  responseUrlPath: 'data.url',
  qualityMapping: { exhigh: '320' },
}

afterEach(() => vi.unstubAllGlobals())

describe('custom HTTP resolver', () => {
  it('expands placeholders and reads a nested URL', async () => {
    let requested = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested = url
      return new Response(JSON.stringify({ data: { url: 'https://cdn.example.test/a.mp3' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))
    const source = await resolveCustomSource({ track, quality: 'exhigh', config })
    expect(requested).toContain('id=42')
    expect(requested).toContain('quality=320')
    expect(source.url).toBe('https://cdn.example.test/a.mp3')
    expect(source.format).toBe('mp3')
  })

  it('refuses a private resolver target before fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(resolveCustomSource({
      track,
      quality: 'exhigh',
      config: { ...config, url: 'http://127.0.0.1/resolve' },
    })).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a private URL returned by a public resolver', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ data: { url: 'http://169.254.169.254/latest' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    await expect(resolveCustomSource({ track, quality: 'exhigh', config })).rejects.toThrow()
  })

  it('reports a non-JSON answer instead of treating it as a URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 200 })))
    await expect(resolveCustomSource({ track, quality: 'exhigh', config })).rejects.toThrow('JSON')
  })

  it('is consulted when the account put custom first, and skipped when disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ data: { url: 'https://cdn.example.test/a.mp3' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    const customFirst = {
      ...DEFAULT_MUSIC_SETTINGS,
      customResolverEnabled: true,
      customResolverUrl: config.url,
      customResolverParams: config.params,
      customResolverResponsePath: config.responseUrlPath,
      customResolverQualityMap: config.qualityMapping,
      sourcePriority: ['custom', 'official'] as Array<'official' | 'custom'>,
    }
    const resolver = createMusicSourceResolver(track, customFirst)
    await expect(resolver.resolveCustom('exhigh')).resolves.toMatchObject({
      url: 'https://cdn.example.test/a.mp3',
    })
    expect(resolver.officialAllowed).toBe(true)

    const disabled = createMusicSourceResolver(track, {
      ...customFirst,
      customResolverEnabled: false,
      sourcePriority: ['custom'],
    })
    await expect(disabled.resolveCustom('exhigh')).resolves.toBeNull()
    expect(disabled.officialAllowed).toBe(true)
  })

  it('refuses an HTTP audio address even when the host is public', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ data: { url: 'http://cdn.example.test/a.mp3' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    await expect(resolveCustomSource({ track, quality: 'exhigh', config })).rejects.toThrow('HTTPS')
  })
})
