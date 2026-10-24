/**
 * Upstream endpoint table. Each builder only assembles the path and the body the reference module
 * sends; the response is normalized elsewhere.
 *
 * The reference package defaults to POST through either `eapi` or `weapi`; the crypto column here is
 * copied from the same modules. The few literals that are protocol vocabulary (an "all" category and
 * the MV tag keys) stay escaped so the source tree remains ASCII-only.
 */
import type { NeteaseCryptoMode } from './request'

export interface NeteaseCall {
  path: string
  crypto: NeteaseCryptoMode
  body: Record<string, unknown>
}

/** The upstream's own name for "no filter"; not interface copy. */
export const ALL_CATEGORIES = '\u5168\u90e8'
const MV_ORDER_HOT = '\u4e0a\u5347\u6700\u5feb'
const MV_TAG_AREA = '\u5730\u533a'
const MV_TAG_TYPE = '\u7c7b\u578b'
const MV_TAG_ORDER = '\u6392\u5e8f'

export interface NeteasePage {
  limit: number
  offset: number
}

export interface NeteaseSearchInput extends NeteasePage {
  keywords: string
  /** 1 song, 10 album, 1000 playlist, 1004 MV, 1009 radio. */
  type: number
}

export interface NeteaseSongUrlInput {
  ids: string[]
  level: string
  encodeType?: string
}

export interface NeteasePlaylistSquareInput extends NeteasePage {
  category?: string
  order?: 'hot' | 'new'
  before?: number
}

export interface NeteaseAlbumNewInput extends NeteasePage {
  area?: string
}

export interface NeteaseArtistSongsInput extends NeteasePage {
  id: string
  order?: 'hot' | 'time'
}

export interface NeteaseMvAllInput extends NeteasePage {
  area?: string
  type?: string
  order?: string
}

export interface NeteaseRadioHotInput extends NeteasePage {
  categoryId: string
}

export interface NeteaseRadioProgramsInput extends NeteasePage {
  radioId: string
  asc?: boolean
}

function call(path: string, crypto: NeteaseCryptoMode, body: Record<string, unknown>): NeteaseCall {
  return { path, crypto, body }
}

/** The URL endpoints take a JSON array of numbers, unlike the string ids the app carries. */
function numericIds(ids: string[]): string {
  return `[${ids
    .map((id) => {
      const numeric = Number(id)
      return Number.isFinite(numeric) ? numeric : JSON.stringify(id)
    })
    .join(',')}]`
}

export const neteaseEndpoints = {
  search: (input: NeteaseSearchInput) =>
    call('/api/cloudsearch/pc', 'eapi', {
      s: input.keywords,
      type: input.type,
      limit: input.limit,
      offset: input.offset,
      total: true,
    }),

  searchDefault: () => call('/api/search/defaultkeyword/get', 'eapi', {}),

  searchHot: () => call('/api/hotsearchlist/get', 'weapi', {}),

  searchSuggest: (keywords: string) =>
    call('/api/search/suggest/web', 'weapi', { s: keywords }),

  personalizedPlaylists: (limit: number) =>
    call('/api/personalized/playlist', 'weapi', { limit, total: true, n: 1000 }),

  personalizedNewSongs: (limit: number) =>
    call('/api/personalized/newsong', 'weapi', { type: 'recommend', limit, areaId: 0 }),

  personalFm: () => call('/api/v1/radio/get', 'weapi', {}),

  fmTrash: (providerId: string) =>
    call('/api/radio/trash/add', 'weapi', { songId: providerId, alg: 'RT', time: 25 }),

  recommendSongs: () => call('/api/v3/discovery/recommend/songs', 'weapi', {}),

  topPlaylists: (input: NeteasePlaylistSquareInput) =>
    call('/api/playlist/list', 'weapi', {
      cat: input.category || ALL_CATEGORIES,
      order: input.order || 'hot',
      limit: input.limit,
      offset: input.offset,
      total: true,
    }),

  highqualityPlaylists: (input: NeteasePlaylistSquareInput) =>
    call('/api/playlist/highquality/list', 'weapi', {
      cat: input.category || ALL_CATEGORIES,
      limit: input.limit,
      lasttime: input.before ?? 0,
      total: true,
    }),

  topArtists: (input: NeteasePage) =>
    call('/api/artist/top', 'weapi', { limit: input.limit, offset: input.offset, total: true }),

  toplist: () => call('/api/toplist', 'eapi', {}),

  userDetail: (uid: string) => call(`/api/v1/user/detail/${encodeURIComponent(uid)}`, 'weapi', {}),

  userPlaylists: (uid: string, limit: number, offset: number) =>
    call('/api/user/playlist', 'weapi', { uid, limit, offset }),

  songDetail: (ids: string[]) =>
    call('/api/v3/song/detail', 'weapi', {
      c: `[${ids
        .map((id) => {
          const numeric = Number(id)
          return `{"id":${Number.isFinite(numeric) ? numeric : JSON.stringify(id)}}`
        })
        .join(',')}]`,
    }),

  songUrl: (input: NeteaseSongUrlInput) => {
    const body: Record<string, unknown> = {
      ids: numericIds(input.ids),
      level: input.level,
      encodeType: input.encodeType || 'flac',
    }
    if (input.level === 'sky') body.immerseType = 'c51'
    return call('/api/song/enhance/player/url/v1', 'eapi', body)
  },

  songDownloadUrl: (input: NeteaseSongUrlInput) =>
    call('/api/song/enhance/download/url/v1', 'eapi', {
      id: numericIds(input.ids).slice(1, -1),
      level: input.level,
      immerseType: 'c51',
    }),

  lyric: (providerId: string) =>
    call('/api/song/lyric/v1', 'eapi', {
      id: providerId,
      cp: false,
      tv: 0,
      lv: 0,
      rv: 0,
      kv: 0,
      yv: 0,
      ytv: 0,
      yrv: 0,
    }),

  playlistDetail: (providerId: string) =>
    call('/api/v6/playlist/detail', 'eapi', { id: providerId, n: 100000, s: 8 }),

  playlistCategories: () => call('/api/playlist/catalogue', 'eapi', {}),

  album: (providerId: string) =>
    call(`/api/v1/album/${encodeURIComponent(providerId)}`, 'weapi', {}),

  albumNew: (input: NeteaseAlbumNewInput) =>
    call('/api/album/new', 'weapi', {
      limit: input.limit,
      offset: input.offset,
      total: true,
      area: input.area || 'ALL',
    }),

  albumNewest: () => call('/api/discovery/newAlbum', 'weapi', {}),

  artistDetail: (providerId: string) =>
    call('/api/artist/head/info/get', 'eapi', { id: providerId }),

  artistSongs: (input: NeteaseArtistSongsInput) =>
    call('/api/v1/artist/songs', 'eapi', {
      id: input.id,
      private_cloud: 'true',
      work_type: 1,
      order: input.order || 'hot',
      offset: input.offset,
      limit: input.limit,
    }),

  artistAlbums: (providerId: string, input: NeteasePage) =>
    call(`/api/artist/albums/${encodeURIComponent(providerId)}`, 'weapi', {
      limit: input.limit,
      offset: input.offset,
      total: true,
    }),

  mvAll: (input: NeteaseMvAllInput) =>
    call('/api/mv/all', 'eapi', {
      tags: JSON.stringify({
        [MV_TAG_AREA]: input.area || ALL_CATEGORIES,
        [MV_TAG_TYPE]: input.type || ALL_CATEGORIES,
        [MV_TAG_ORDER]: input.order || MV_ORDER_HOT,
      }),
      offset: input.offset,
      total: 'true',
      limit: input.limit,
    }),

  mvDetail: (providerId: string) =>
    call('/api/v1/mv/detail', 'weapi', { id: providerId }),

  mvUrl: (providerId: string, resolution = 1080) =>
    call('/api/song/enhance/play/mv/url', 'weapi', { id: providerId, r: resolution }),

  djSublist: (input: NeteasePage) =>
    call('/api/djradio/get/subed', 'weapi', {
      limit: input.limit,
      offset: input.offset,
      total: true,
    }),

  djDetail: (providerId: string) =>
    call('/api/djradio/v2/get', 'weapi', { id: providerId }),

  djPrograms: (input: NeteaseRadioProgramsInput) =>
    call('/api/dj/program/byradio', 'weapi', {
      radioId: input.radioId,
      limit: input.limit,
      offset: input.offset,
      asc: input.asc ?? false,
    }),

  djSubscribe: (providerId: string, subscribe: boolean) =>
    call(`/api/djradio/${subscribe ? 'sub' : 'unsub'}`, 'weapi', { id: providerId }),

  djTodayPreferred: (page = 0) =>
    call('/api/djradio/home/today/perfered', 'weapi', { page }),

  djRecommend: () => call('/api/djradio/recommend/v1', 'weapi', {}),

  djCategories: () => call('/api/djradio/category/get', 'weapi', {}),

  djRadioHot: (input: NeteaseRadioHotInput) =>
    call('/api/djradio/hot', 'weapi', {
      cateId: input.categoryId || '0',
      limit: input.limit,
      offset: input.offset,
    }),

  userAccount: () => call('/api/nuser/account/get', 'weapi', {}),

  loginQrKey: () => call('/api/login/qrcode/unikey', 'eapi', { type: 3 }),

  loginQrCheck: (key: string) =>
    call('/api/login/qrcode/client/login', 'eapi', { key, type: 3 }),

  logout: () => call('/api/logout', 'eapi', {}),
} as const

export type NeteaseEndpointName = keyof typeof neteaseEndpoints
