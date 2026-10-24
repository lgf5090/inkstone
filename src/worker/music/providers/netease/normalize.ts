/**
 * Upstream payloads to the app's vocabulary.
 *
 * Nothing here throws or reaches the network: a missing field becomes a safe empty value, and a
 * malformed item is dropped only when it has neither an id nor a name. Provider ids stay strings;
 * a provider result uses that id as its `id` too, because no local row exists yet.
 */
import type {
  MusicAccount,
  MusicArtist,
  MusicLyric,
  MusicSearchType,
  MusicTrack,
  MusicTrackKind,
} from '../../../../shared/music/model'
import type {
  MusicAlbumDetail,
  MusicAlbumSummary,
  MusicArtistDetail,
  MusicArtistSummary,
  MusicLyricPayload,
  MusicMvDetail,
  MusicMvSummary,
  MusicPage,
  MusicPlaylistDetail,
  MusicPlaylistSummary,
  MusicRadioDetail,
  MusicRadioSummary,
  MusicSearchResult,
  MusicToplistSummary,
} from '../../../../shared/music/api'
import type {
  MusicHotSearchItem,
  MusicMvSource,
  MusicPlaylistCategory,
  MusicRadioCategory,
  MusicStreamSource,
} from '../types'

type Raw = Record<string, unknown>

function record(value: unknown): Raw {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function pickText(source: Raw, ...keys: string[]): string {
  for (const key of keys) {
    const value = text(source[key])
    if (value) return value
  }
  return ''
}

function pickNumber(source: Raw, ...keys: string[]): number {
  for (const key of keys) {
    const value = count(source[key])
    if (value > 0) return value
  }
  return 0
}

function positiveOrNull(value: number): number | null {
  return value > 0 ? value : null
}

function epoch(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value) return 0
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeArtists(source: Raw): MusicArtist[] {
  const candidates = list(source.ar).length
    ? list(source.ar)
    : list(source.artists).length
      ? list(source.artists)
      : source.artist
        ? [source.artist]
        : []
  return candidates
    .map((item) => {
      const raw = record(item)
      return { id: text(raw.id), name: pickText(raw, 'name') }
    })
    .filter((artist) => artist.id !== '' || artist.name !== '')
}

function albumFields(source: Raw): { name: string; id: string; coverUrl: string } {
  const album = Object.keys(record(source.al)).length ? record(source.al) : record(source.album)
  const name = pickText(album, 'name') || (typeof source.album === 'string' ? source.album : '')
  return {
    name,
    id: text(album.id),
    coverUrl: pickText(album, 'picUrl', 'blurPicUrl'),
  }
}

export function normalizeTrack(input: unknown, kind: MusicTrackKind = 'song'): MusicTrack {
  const outer = record(input)
  const inner = record(outer.song)
  const source = Object.keys(inner).length ? inner : outer
  const album = albumFields(source)
  const high = record(source.h)
  const bitrate = pickNumber(high, 'br') || pickNumber(record(source.hMusic), 'bitrate')
  const size = pickNumber(high, 'size') || pickNumber(record(source.hMusic), 'size')
  const providerId = pickText(source, 'id') || pickText(outer, 'id')
  return {
    id: providerId,
    provider: 'netease',
    providerId,
    kind,
    title: pickText(source, 'name', 'title'),
    artists: normalizeArtists(source),
    album: album.name,
    albumId: album.id,
    coverUrl: album.coverUrl || pickText(outer, 'picUrl', 'coverUrl'),
    coverKey: '',
    durationMs:
      pickNumber(source, 'dt', 'duration') ||
      pickNumber(outer, 'duration') ||
      pickNumber(record(source.hMusic), 'playTime'),
    format: pickText(high, 'extension') || pickText(record(source.hMusic), 'extension'),
    bitrate: positiveOrNull(bitrate),
    size: positiveOrNull(size),
    sha256: '',
    r2Key: null,
    source: 'netease',
    sourceQuality: '',
    createdAt: 0,
    updatedAt: 0,
  }
}

/** A radio program is a podcast track keyed by its `mainSong`, which is what the stream endpoint wants. */
export function normalizeProgram(input: unknown): MusicTrack {
  const program = record(input)
  const mainSong = record(program.mainSong)
  const radio = record(program.radio)
  const providerId = pickText(mainSong, 'id') || pickText(program, 'id')
  const radioId = text(radio.id)
  return {
    id: providerId,
    provider: 'netease',
    providerId,
    kind: 'podcast',
    title: pickText(mainSong, 'name') || pickText(program, 'name'),
    artists: radioId || radio.name ? [{ id: radioId, name: pickText(radio, 'name') }] : [],
    album: pickText(radio, 'name'),
    albumId: radioId,
    coverUrl: pickText(program, 'coverUrl', 'cover'),
    coverKey: '',
    durationMs: pickNumber(mainSong, 'duration', 'dt'),
    format: '',
    bitrate: null,
    size: null,
    sha256: '',
    r2Key: null,
    source: 'netease',
    sourceQuality: '',
    createdAt: 0,
    updatedAt: 0,
  }
}

export function normalizePlaylistSummary(input: unknown): MusicPlaylistSummary {
  const raw = record(input)
  const id = text(raw.id)
  const creator = record(raw.creator)
  return {
    id,
    provider: 'netease',
    providerId: id,
    name: pickText(raw, 'name'),
    description: pickText(raw, 'description', 'copywriter'),
    coverUrl: pickText(raw, 'coverImgUrl', 'picUrl'),
    trackCount: pickNumber(raw, 'trackCount', 'trackNumber'),
    creator: pickText(creator, 'nickname') || undefined,
  }
}

export function normalizeAlbumSummary(input: unknown): MusicAlbumSummary {
  const raw = record(input)
  const artists = list(raw.artists)
    .map((item) => pickText(record(item), 'name'))
    .filter(Boolean)
  if (artists.length === 0) {
    const single = pickText(record(raw.artist), 'name')
    if (single) artists.push(single)
  }
  return {
    id: text(raw.id),
    name: pickText(raw, 'name'),
    coverUrl: pickText(raw, 'picUrl', 'blurPicUrl'),
    artists,
    publishTime: epoch(raw.publishTime),
    trackCount: pickNumber(raw, 'size', 'trackCount'),
  }
}

export function normalizeArtistSummary(input: unknown): MusicArtistSummary {
  const raw = record(input)
  return {
    id: text(raw.id),
    name: pickText(raw, 'name'),
    coverUrl: pickText(raw, 'picUrl', 'img1v1Url', 'cover', 'avatar'),
    albumCount: pickNumber(raw, 'albumSize', 'albumCount'),
    followCount: pickNumber(raw, 'fansCount', 'followCount'),
  }
}

export function normalizeMvSummary(input: unknown): MusicMvSummary {
  const raw = record(input)
  const firstArtist = list(raw.artists)[0]
  return {
    id: text(raw.id),
    name: pickText(raw, 'name', 'title'),
    coverUrl: pickText(raw, 'cover', 'picUrl'),
    artist: pickText(raw, 'artistName') || pickText(record(firstArtist), 'name'),
    durationMs: pickNumber(raw, 'duration', 'dt'),
    playCount: pickNumber(raw, 'playCount', 'plays'),
  }
}

export function normalizeRadioSummary(input: unknown): MusicRadioSummary {
  const raw = record(input)
  return {
    id: text(raw.id),
    name: pickText(raw, 'name'),
    coverUrl: pickText(raw, 'picUrl', 'coverUrl'),
    description: pickText(raw, 'desc', 'description'),
    programCount: pickNumber(raw, 'programCount'),
    subscriberCount: pickNumber(raw, 'subCount', 'subscriberCount'),
  }
}

export function normalizeToplistSummary(input: unknown): MusicToplistSummary {
  const raw = record(input)
  return {
    id: text(raw.id),
    name: pickText(raw, 'name'),
    coverUrl: pickText(raw, 'coverImgUrl', 'picUrl'),
    description: pickText(raw, 'description', 'copywriter'),
    trackCount: pickNumber(raw, 'trackCount'),
  }
}

function pageHasMore(more: unknown, total: number, offset: number, loaded: number): boolean {
  if (more === true) return true
  return total > 0 && offset + loaded < total
}

export function normalizeSearch(
  input: unknown,
  type: MusicSearchType,
  limit: number,
  offset: number,
): MusicSearchResult {
  const root = record(input)
  const result = record(root.result)
  const empty: MusicSearchResult = {
    type,
    tracks: [],
    albums: [],
    playlists: [],
    mvs: [],
    radios: [],
    total: 0,
    hasMore: false,
  }
  if (type === 'song') {
    const items = list(result.songs)
    empty.tracks = items.map((item) => normalizeTrack(item))
    empty.total = pickNumber(result, 'songCount') || empty.tracks.length
  } else if (type === 'album') {
    const items = list(result.albums)
    empty.albums = items.map(normalizeAlbumSummary)
    empty.total = pickNumber(result, 'albumCount') || empty.albums.length
  } else if (type === 'playlist') {
    const items = list(result.playlists)
    empty.playlists = items.map(normalizePlaylistSummary)
    empty.total = pickNumber(result, 'playlistCount') || empty.playlists.length
  } else if (type === 'mv') {
    const items = list(result.mvs)
    empty.mvs = items.map(normalizeMvSummary)
    empty.total = pickNumber(result, 'mvCount') || empty.mvs.length
  } else {
    const items = list(result.djRadios)
    empty.radios = items.map(normalizeRadioSummary)
    empty.total = pickNumber(result, 'djRadiosCount') || empty.radios.length
  }
  const loaded =
    empty.tracks.length + empty.albums.length + empty.playlists.length + empty.mvs.length + empty.radios.length
  empty.hasMore = (result.more === true || loaded >= limit) && pageHasMore(result.more, empty.total, offset, loaded)
  return empty
}

export function normalizePlaylistDetail(input: unknown): MusicPlaylistDetail {
  const root = record(input)
  const playlist = record(root.playlist)
  const tracks = list(playlist.tracks).map((item) => normalizeTrack(item))
  const total = pickNumber(playlist, 'trackCount') || tracks.length
  return {
    playlist: normalizePlaylistSummary(playlist),
    tracks,
    total,
    hasMore: tracks.length < total,
  }
}

export function normalizeAlbumDetail(input: unknown): MusicAlbumDetail {
  const root = record(input)
  const album = record(root.album)
  const tracks = list(root.songs).map((item) => normalizeTrack(item))
  const total = pickNumber(album, 'size') || tracks.length
  return {
    album: normalizeAlbumSummary(album),
    description: pickText(album, 'description', 'briefDesc'),
    tracks,
    total,
    hasMore: tracks.length < total,
  }
}

function artistFromDetail(input: unknown): Raw {
  const root = record(input)
  const data = record(root.data)
  if (Object.keys(record(data.artist)).length) return record(data.artist)
  return Object.keys(record(root.artist)).length ? record(root.artist) : root
}

export function normalizeArtistDetail(
  detail: unknown,
  songs: unknown,
  albums: unknown,
  albumTotal: number,
): MusicArtistDetail {
  const root = record(detail)
  const data = record(root.data)
  const artist = artistFromDetail(detail)
  const albumRoot = record(albums)
  const albumItems = list(albumRoot.hotAlbums).length ? list(albumRoot.hotAlbums) : list(albumRoot.albums)
  return {
    artist: normalizeArtistSummary(artist),
    description: pickText(artist, 'briefDesc') || pickText(data, 'description'),
    hotTracks: list(record(songs).songs).map((item) => normalizeTrack(item)),
    albums: albumItems.map(normalizeAlbumSummary),
    albumTotal: albumTotal || pickNumber(albumRoot, 'total') || albumItems.length,
    albumHasMore: albumItems.length < (albumTotal || pickNumber(albumRoot, 'total') || albumItems.length),
  }
}

export function normalizeMvDetail(input: unknown): MusicMvDetail {
  const root = record(input)
  const data = Object.keys(record(root.data)).length ? record(root.data) : root
  return {
    mv: normalizeMvSummary(data),
    description: pickText(data, 'desc', 'description', 'briefDesc'),
    publishTime: epoch(data.publishTime),
  }
}

export function normalizeRadioDetail(input: unknown, programs: unknown, offset: number): MusicRadioDetail {
  const root = record(input)
  const radio = Object.keys(record(root.data)).length ? record(root.data) : root
  const programRoot = record(programs)
  const items = list(programRoot.programs).map(normalizeProgram)
  const total = pickNumber(programRoot, 'count') || pickNumber(radio, 'programCount') || items.length
  return {
    radio: normalizeRadioSummary(radio),
    programs: items,
    total,
    hasMore: offset + items.length < total,
  }
}

export function normalizeLyric(input: unknown, trackKey: string): MusicLyricPayload {
  const root = record(input)
  const lrc = lyricText(root.lrc)
  const tlyric = lyricText(root.tlyric)
  const yrc = lyricText(root.yrc)
  const lyric: MusicLyric = {
    trackKey,
    source: 'netease',
    lrc,
    tlyric,
    yrc,
    fetchedAt: Date.now(),
  }
  return {
    lyric: lrc || tlyric || yrc ? lyric : null,
    hasTranslation: tlyric !== '',
    hasWordByWord: yrc !== '',
  }
}

function lyricText(value: unknown): string {
  if (typeof value === 'string') return value
  return pickText(record(value), 'lyric')
}

export function normalizeAccount(input: unknown): MusicAccount | null {
  const root = record(input)
  const data = record(root.data)
  const profile = Object.keys(record(root.profile)).length ? record(root.profile) : record(data.profile)
  const account = record(root.account)
  const accountId = pickText(profile, 'userId') || pickText(account, 'id')
  const nickname = pickText(profile, 'nickname')
  if (!accountId && !nickname) return null
  return {
    provider: 'netease',
    accountId,
    nickname,
    avatarUrl: pickText(profile, 'avatarUrl'),
    status: 'connected',
    updatedAt: Date.now(),
  }
}

export function normalizeStreamSource(input: unknown, quality: string): MusicStreamSource | null {
  const item = record(list(record(input).data)[0])
  const url = pickText(item, 'url')
  if (!url) return null
  const expirySeconds = pickNumber(item, 'expi')
  return {
    url,
    expiresAt: Date.now() + (expirySeconds > 0 ? expirySeconds * 1000 : 20 * 60 * 1000),
    format: pickText(item, 'type'),
    bitrate: positiveOrNull(pickNumber(item, 'br')),
    size: positiveOrNull(pickNumber(item, 'size')),
    quality,
    freeTrial: Object.keys(record(item.freeTrialInfo)).length > 0,
  }
}

export function normalizeMvSource(input: unknown): MusicMvSource | null {
  const item = record(record(input).data)
  const url = pickText(item, 'url')
  if (!url) return null
  const expirySeconds = pickNumber(item, 'expi')
  return {
    url,
    expiresAt: Date.now() + (expirySeconds > 0 ? expirySeconds * 1000 : 20 * 60 * 1000),
    resolution: pickNumber(item, 'r'),
    size: positiveOrNull(pickNumber(item, 'size')),
  }
}

export function normalizePlaylistCategories(input: unknown): MusicPlaylistCategory[] {
  const root = record(input)
  return list(root.sub)
    .map((item) => {
      const raw = record(item)
      return { name: pickText(raw, 'name'), hot: raw.hot === true }
    })
    .filter((category) => category.name !== '')
}

export function normalizeRadioCategories(input: unknown): MusicRadioCategory[] {
  const root = record(input)
  return list(root.categories)
    .map((item) => {
      const raw = record(item)
      return { id: text(raw.id), name: pickText(raw, 'name') }
    })
    .filter((category) => category.id !== '' || category.name !== '')
}

export function normalizeHotSearchItems(input: unknown): MusicHotSearchItem[] {
  const root = record(input)
  return list(root.data)
    .map((item) => {
      const raw = record(item)
      return { keyword: pickText(raw, 'searchWord', 'keyword'), score: pickNumber(raw, 'score') }
    })
    .filter((item) => item.keyword !== '')
}

export function normalizeDefaultKeyword(input: unknown): string {
  const data = record(record(input).data)
  return pickText(data, 'realkeyword', 'showKeyword')
}

export function normalizePage<T>(items: T[], total: number, offset: number): MusicPage<T> {
  return { items, total, hasMore: offset + items.length < total }
}
