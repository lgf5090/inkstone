// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ALL_CATEGORIES, neteaseEndpoints } from '../src/worker/music/providers/netease/endpoints'
import { ExternalNeteaseProvider } from '../src/worker/music/providers/netease/external'
import {
  normalizeAccount,
  normalizeAlbumDetail,
  normalizeAlbumSummary,
  normalizeArtistDetail,
  normalizeArtistEvents,
  normalizeArtistSummary,
  normalizeCommentPage,
  normalizeDefaultKeyword,
  normalizeHotSearchItems,
  normalizeLyric,
  normalizeMvDetail,
  normalizeMvSource,
  normalizeMvSummary,
  normalizePlaylistCategories,
  normalizePlaylistDetail,
  normalizePlaylistSummary,
  normalizeProgram,
  normalizeRadioCategories,
  normalizeRadioDetail,
  normalizeRadioSummary,
  normalizeSearch,
  normalizeStreamSource,
  normalizeToplistSummary,
  normalizeTrack,
} from '../src/worker/music/providers/netease/normalize'

describe('netease endpoint builders', () => {
  it('marks the search call as eapi and keeps the raw keyword', () => {
    const call = neteaseEndpoints.search({ keywords: 'hello', type: 1, limit: 30, offset: 60 })
    expect(call).toMatchObject({ path: '/api/cloudsearch/pc', crypto: 'eapi' })
    expect(call.body).toEqual({ s: 'hello', type: 1, limit: 30, offset: 60, total: true })
  })

  it('builds numeric song detail ids and a weapi marker', () => {
    const call = neteaseEndpoints.songDetail(['123', '456'])
    expect(call.crypto).toBe('weapi')
    expect(call.body.c).toBe('[{"id":123},{"id":456}]')
  })

  it('asks the lyric endpoint for all forms, including per-word YRC', () => {
    const call = neteaseEndpoints.lyric('185809')
    expect(call).toMatchObject({ path: '/api/song/lyric/v1', crypto: 'eapi' })
    expect(call.body).toMatchObject({ id: '185809', tv: -1, lv: -1, rv: -1, kv: -1, yv: -1, ytv: -1, yrv: -1 })
  })

  it('asks a playlist detail for no embedded songs by default and for a bounded fallback on request', () => {
    expect(neteaseEndpoints.playlistDetail('9').body.n).toBe(0)
    expect(neteaseEndpoints.playlistDetail('9', 5_000).body.n).toBe(5_000)
  })

  it('serializes song URL ids and adds the sky immersion tag only for sky', () => {
    expect(neteaseEndpoints.songUrl({ ids: ['1', '2'], level: 'exhigh' }).body).toEqual({
      ids: '[1,2]',
      level: 'exhigh',
      encodeType: 'flac',
    })
    expect(neteaseEndpoints.songUrl({ ids: ['1'], level: 'sky' }).body.immerseType).toBe('c51')
    expect(neteaseEndpoints.songDownloadUrl({ ids: ['1'], level: 'lossless', encodeType: 'aac' }).body).toEqual({
      id: '1',
      level: 'lossless',
      immerseType: 'c51',
    })
  })

  it('fills the upstream "all" category and the high-quality cursor', () => {
    const hot = neteaseEndpoints.topPlaylists({ limit: 30, offset: 60 })
    expect(hot.body.cat).toBe(ALL_CATEGORIES)
    expect(hot.body.order).toBe('hot')
    const quality = neteaseEndpoints.highqualityPlaylists({ limit: 20, offset: 0, before: 1234 })
    expect(quality.body.lasttime).toBe(1234)
  })

  it('encodes MV tags as the protocol expects', () => {
    const body = neteaseEndpoints.mvAll({ limit: 10, offset: 20, area: 'ZH' }).body
    expect(JSON.parse(String(body.tags))).toEqual({
      '\u5730\u533a': 'ZH',
      '\u7c7b\u578b': ALL_CATEGORIES,
      '\u6392\u5e8f': '\u4e0a\u5347\u6700\u5feb',
    })
    expect(body.total).toBe('true')
  })

  it('keeps radio paging and the QR login payload', () => {
    expect(neteaseEndpoints.djPrograms({ radioId: '9', limit: 30, offset: 60 }).body).toEqual({
      radioId: '9',
      limit: 30,
      offset: 60,
      asc: false,
    })
    expect(neteaseEndpoints.loginQrKey().body).toEqual({ type: 3 })
    expect(neteaseEndpoints.loginQrCheck('key-1').body).toEqual({ key: 'key-1', type: 3 })
  })

  it('encodes dynamic ids in album and artist paths', () => {
    expect(neteaseEndpoints.album('a/b').path).toBe('/api/v1/album/a%2Fb')
    expect(neteaseEndpoints.artistAlbums('42', { limit: 10, offset: 0 }).path).toBe('/api/artist/albums/42')
    expect(neteaseEndpoints.logout().crypto).toBe('eapi')
  })

  it('builds comment, follow, events, FM mode and heart-mode calls', () => {
    expect(neteaseEndpoints.comments({ thread: 'R_SO_4_42', offset: 30, limit: 30 })).toMatchObject({
      path: '/api/v1/resource/comments/R_SO_4_42',
      crypto: 'weapi',
      body: { offset: 30, limit: 30 },
    })
    expect(neteaseEndpoints.commentLike({ thread: 'A_DJ_1_7', commentId: '3', liked: true })).toMatchObject({
      path: '/api/v1/comment/like',
      crypto: 'eapi',
      body: { threadId: 'A_DJ_1_7', commentId: '3' },
    })
    expect(neteaseEndpoints.artistFollow('42', true).body).toEqual({ artistId: '42', artistIds: '[42]' })
    expect(neteaseEndpoints.artistEvents({ uid: '9', before: 100, limit: 20 }).body).toEqual({
      time: 100, limit: 20, getcounts: true, total: false,
    })
    expect(neteaseEndpoints.personalFm('FAMILIAR').body).toEqual({ mode: 'FAMILIAR', limit: 3 })
    expect(neteaseEndpoints.heartMode({ songId: '1', startSongId: '1', playlistId: '5' }).body).toMatchObject({
      songId: '1', startMusicId: '1', playlistId: '5', type: 'fromPlayOne', count: 1,
    })
  })
})

describe('netease normalization', () => {
  it('normalizes a search song with artists, album and bitrate metadata', () => {
    const track = normalizeTrack({
      id: 42,
      name: 'Song',
      ar: [{ id: 7, name: 'Artist' }],
      al: { id: 9, name: 'Album', picUrl: 'https://p1.music.126.net/a.jpg' },
      dt: 245000,
      h: { br: 320000, size: 9000, extension: 'mp3' },
    })
    expect(track).toMatchObject({
      id: '42',
      provider: 'netease',
      providerId: '42',
      kind: 'song',
      title: 'Song',
      artists: [{ id: '7', name: 'Artist' }],
      album: 'Album',
      albumId: '9',
      coverUrl: 'https://p1.music.126.net/a.jpg',
      durationMs: 245000,
      format: 'mp3',
      bitrate: 320000,
      size: 9000,
    })
  })

  it('unwraps the personalized new-song envelope and survives missing fields', () => {
    const track = normalizeTrack({
      picUrl: 'https://p1.music.126.net/b.jpg',
      song: { id: 5, name: 'Wrapped', artists: [{ id: 1, name: 'A' }], album: { id: 2, name: 'B' }, duration: 1000 },
    })
    expect(track.title).toBe('Wrapped')
    expect(track.coverUrl).toBe('https://p1.music.126.net/b.jpg')
    expect(track.album).toBe('B')
    const empty = normalizeTrack({})
    expect(empty).toMatchObject({ id: '', title: '', artists: [], durationMs: 0, bitrate: null, size: null })
  })

  it('normalizes a radio program as a podcast track keyed by its main song', () => {
    const track = normalizeProgram({
      id: 900,
      coverUrl: 'https://p1.music.126.net/c.jpg',
      mainSong: { id: 77, name: 'Episode', duration: 1800000 },
      radio: { id: 8, name: 'Show' },
    })
    expect(track).toMatchObject({
      id: '77',
      providerId: '77',
      kind: 'podcast',
      title: 'Episode',
      album: 'Show',
      albumId: '8',
      durationMs: 1800000,
      artists: [{ id: '8', name: 'Show' }],
    })
  })

  it('normalizes the summary shapes', () => {
    expect(
      normalizePlaylistSummary({
        id: 1,
        name: 'List',
        description: 'Desc',
        coverImgUrl: 'cover',
        trackCount: 12,
        creator: { nickname: 'Reader' },
      }),
    ).toEqual({
      id: '1',
      provider: 'netease',
      providerId: '1',
      name: 'List',
      description: 'Desc',
      coverUrl: 'cover',
      trackCount: 12,
      creator: 'Reader',
    })
    expect(
      normalizeAlbumSummary({ id: 2, name: 'Album', picUrl: 'p', artists: [{ name: 'A' }], publishTime: 100, size: 3 }),
    ).toEqual({ id: '2', name: 'Album', coverUrl: 'p', artists: ['A'], publishTime: 100, trackCount: 3 })
    expect(normalizeArtistSummary({ id: 3, name: 'A', picUrl: 'a', albumSize: 4, fansCount: 5 })).toEqual({
      id: '3',
      name: 'A',
      coverUrl: 'a',
      albumCount: 4,
      followCount: 5,
    })
    expect(
      normalizeMvSummary({ id: 4, name: 'MV', cover: 'm', artistName: 'A', duration: 60000, playCount: 8 }),
    ).toEqual({ id: '4', name: 'MV', coverUrl: 'm', artist: 'A', durationMs: 60000, playCount: 8 })
    expect(
      normalizeRadioSummary({ id: 5, name: 'Radio', picUrl: 'r', desc: 'D', programCount: 6, subCount: 7 }),
    ).toEqual({ id: '5', name: 'Radio', coverUrl: 'r', description: 'D', programCount: 6, subscriberCount: 7 })
    expect(normalizeToplistSummary({ id: 6, name: 'Top', coverImgUrl: 't', description: 'D', trackCount: 9 })).toEqual({
      id: '6',
      name: 'Top',
      coverUrl: 't',
      description: 'D',
      trackCount: 9,
    })
  })

  it('normalizes search results and reports the remaining pages', () => {
    const songPage = normalizeSearch(
      { result: { songs: [{ id: 1, name: 'S' }], songCount: 45, more: true } },
      'song',
      30,
      0,
    )
    expect(songPage.type).toBe('song')
    expect(songPage.tracks).toHaveLength(1)
    expect(songPage.total).toBe(45)
    expect(songPage.hasMore).toBe(true)
    expect(songPage.albums).toEqual([])

    const albumPage = normalizeSearch(
      { result: { albums: [{ id: 2, name: 'A' }], albumCount: 1 } },
      'album',
      30,
      0,
    )
    expect(albumPage.albums[0].name).toBe('A')
    expect(albumPage.hasMore).toBe(false)
  })

  it('normalizes playlist and album details with their tracks', () => {
    const playlist = normalizePlaylistDetail({
      playlist: { id: 1, name: 'P', trackCount: 2, tracks: [{ id: 10, name: 'One' }, { id: 11, name: 'Two' }] },
    })
    expect(playlist.playlist.name).toBe('P')
    expect(playlist.tracks.map((track) => track.title)).toEqual(['One', 'Two'])
    expect(playlist.total).toBe(2)
    expect(playlist.hasMore).toBe(false)

    const album = normalizeAlbumDetail({
      album: { id: 2, name: 'A', size: 2, description: 'D' },
      songs: [{ id: 20, name: 'One' }],
    })
    expect(album.album.name).toBe('A')
    expect(album.description).toBe('D')
    expect(album.tracks).toHaveLength(1)
    expect(album.hasMore).toBe(true)
  })

  it('normalizes artist detail from the head-info envelope', () => {
    const detail = normalizeArtistDetail(
      { data: { artist: { id: 1, name: 'Singer', briefDesc: 'Bio', albumSize: 2, fansCount: 3, followed: true, accountId: 88 } } },
      { songs: [{ id: 10, name: 'Hot' }] },
      { hotAlbums: [{ id: 2, name: 'First' }], total: 4 },
      4,
    )
    expect(detail.artist).toMatchObject({ id: '1', name: 'Singer', albumCount: 2, followCount: 3 })
    expect(detail.description).toBe('Bio')
    expect(detail.followed).toBe(true)
    expect(detail.accountId).toBe('88')
    expect(detail.hotTracks[0].title).toBe('Hot')
    expect(detail.albums).toHaveLength(1)
    expect(detail.albumTotal).toBe(4)
    expect(detail.albumHasMore).toBe(true)
  })

  it('normalizes comments, replies and the event feed', () => {
    const page = normalizeCommentPage({
      hotComments: [{
        commentId: 1,
        user: { userId: 2, nickname: 'N', avatarUrl: 'a' },
        content: 'hi',
        time: 10,
        likedCount: 3,
        liked: true,
        ipLocation: { location: 'Earth' },
        beReplied: [{ user: { nickname: 'R' }, content: 'reply' }],
      }],
      comments: [{ commentId: 2, user: { userId: 3, nickname: 'M' }, content: 'latest', time: 11 }],
      total: 1,
      more: false,
    }, 0)
    expect(page.hot[0]).toMatchObject({ id: '1', liked: true, ipLocation: 'Earth', replyTo: { nickname: 'R', content: 'reply' } })
    expect(page.latest[0].content).toBe('latest')
    expect(page.hasMore).toBe(false)

    const events = normalizeArtistEvents({
      events: [{
        id: 5,
        eventTime: 20,
        user: { nickname: 'Singer', avatarUrl: 'avatar' },
        pics: [{ squareUrl: 'pic' }],
        info: { likedCount: 2, commentCount: 4 },
        json: JSON.stringify({
          msg: 'hello',
          song: { id: 9, name: 'S', ar: [{ id: 1, name: 'A' }] },
          event: { user: { nickname: 'F' }, json: JSON.stringify({ msg: 'forwarded' }) },
        }),
      }],
      lasttime: 20,
      more: true,
    })
    expect(events.items[0]).toMatchObject({
      id: '5', authorName: 'Singer', content: 'hello', pictures: ['pic'], forwarded: 'F: forwarded',
    })
    expect(events.items[0].song?.title).toBe('S')
    expect(events.before).toBe(20)
  })

  it('normalizes MV detail and sources', () => {
    const detail = normalizeMvDetail({
      data: { id: 1, name: 'MV', cover: 'c', artistName: 'A', duration: 1000, playCount: 2, desc: 'D', publishTime: '2020-01-02' },
    })
    expect(detail.mv.name).toBe('MV')
    expect(detail.description).toBe('D')
    expect(detail.publishTime).toBe(Date.parse('2020-01-02'))

    const source = normalizeMvSource({ data: { url: 'https://v.music.126.net/a.mp4', expi: 60, r: 1080, size: 5 } })
    expect(source).toMatchObject({ url: 'https://v.music.126.net/a.mp4', resolution: 1080, size: 5 })
    expect(normalizeMvSource({ data: {} })).toBeNull()
  })

  it('normalizes radio details and their program page', () => {
    const detail = normalizeRadioDetail(
      { data: { id: 1, name: 'Radio', programCount: 40 } },
      { programs: [{ id: 2, mainSong: { id: 3, name: 'Ep' }, radio: { id: 1, name: 'Radio' } }], count: 40 },
      30,
    )
    expect(detail.radio.name).toBe('Radio')
    expect(detail.programs[0].title).toBe('Ep')
    expect(detail.total).toBe(40)
    expect(detail.hasMore).toBe(true)
  })

  it('normalizes lyrics, categories, hot searches and account profile', () => {
    const lyrics = normalizeLyric(
      { lrc: { lyric: '[00:00]Hi' }, tlyric: { lyric: '[00:00]Hey' }, yrc: { lyric: '[0,1]Hi' } },
      'netease:1',
    )
    expect(lyrics).toMatchObject({ hasTranslation: true, hasWordByWord: true })
    expect(lyrics.lyric).toMatchObject({ trackKey: 'netease:1', lrc: '[00:00]Hi', tlyric: '[00:00]Hey' })

    expect(normalizePlaylistCategories({ sub: [{ name: 'Pop', hot: true }, { name: '' }] })).toEqual([
      { name: 'Pop', hot: true },
    ])
    expect(normalizeRadioCategories({ categories: [{ id: 1, name: 'Talk' }] })).toEqual([{ id: '1', name: 'Talk' }])
    expect(normalizeHotSearchItems({ data: [{ searchWord: 'one', score: 20 }, { searchWord: '' }] })).toEqual([
      { keyword: 'one', score: 20 },
    ])
    expect(normalizeDefaultKeyword({ data: { realkeyword: 'real', showKeyword: 'show' } })).toBe('real')

    expect(
      normalizeAccount({ code: 200, profile: { userId: 9, nickname: 'N', avatarUrl: 'avatar' } }),
    ).toMatchObject({ provider: 'netease', accountId: '9', nickname: 'N', avatarUrl: 'avatar', status: 'connected' })
    expect(normalizeAccount({ code: 200 })).toBeNull()
  })

  it('normalizes stream sources and flags trial clips', () => {
    const source = normalizeStreamSource(
      {
        code: 200,
        data: [{ url: 'https://m701.music.126.net/a.mp3', expi: 1200, type: 'mp3', br: 320000, size: 4, freeTrialInfo: { start: 0 } }],
      },
      'exhigh',
    )
    expect(source).toMatchObject({
      url: 'https://m701.music.126.net/a.mp3',
      format: 'mp3',
      bitrate: 320000,
      size: 4,
      quality: 'exhigh',
      level: 'exhigh',
      gain: 0,
      peak: 0,
      freeTrial: true,
    })
    expect(source?.expiresAt).toBeGreaterThan(Date.now())
    expect(
      normalizeStreamSource({ data: { url: 'https://m701.music.126.net/b.flac', expi: 60, type: 'flac' } }, 'lossless'),
    ).toMatchObject({ url: 'https://m701.music.126.net/b.flac', format: 'flac' })
    expect(normalizeStreamSource({ data: [{ url: null }] }, 'exhigh')).toBeNull()
  })
})


describe('external upstream adapter', () => {
  it('maps a search to /cloudsearch and normalizes the answer', async () => {
    const calls: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input : typeof input === 'string' ? new URL(input) : new URL(input.url)
      calls.push(url)
      return new Response(
        JSON.stringify({
          code: 200,
          result: { songs: [{ id: 7, name: 'Remote', ar: [{ id: 1, name: 'A' }], dt: 1000 }], songCount: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    try {
      const provider = new ExternalNeteaseProvider({ baseUrl: 'https://ncm.example.com' })
      const result = await provider.search({ keywords: 'remote', type: 'song', limit: 10, offset: 0 })
      expect(calls[0].pathname).toBe('/cloudsearch')
      expect(calls[0].searchParams.get('keywords')).toBe('remote')
      expect(calls[0].searchParams.get('type')).toBe('1')
      expect(calls[0].searchParams.get('device')).toBe('web')
      expect(result.tracks[0]).toMatchObject({ providerId: '7', title: 'Remote', provider: 'netease' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects a non-HTTPS upstream at construction', () => {
    expect(() => new ExternalNeteaseProvider({ baseUrl: 'http://ncm.example.com' })).toThrow(
      'MUSIC_UPSTREAM_API must use HTTPS',
    )
  })
})
