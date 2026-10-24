/**
 * The native Netease provider. Methods are thin: build an endpoint call, insist on a successful
 * envelope, hand the payload to `normalize.ts`. Pagination and composition (artist detail, radio
 * detail, home) live here because they span more than one endpoint.
 */
import type { MusicAccount, MusicSearchType, MusicTrack } from '../../../../shared/music/model'
import { musicTrackKey } from '../../../../shared/music/model'
import type {
  MusicAccountStatus,
  MusicAlbumDetail,
  MusicAlbumSummary,
  MusicArtistDetail,
  MusicArtistSummary,
  MusicHome,
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
import {
  MusicProviderError,
  type MusicAlbumQuery,
  type MusicArtistQuery,
  type MusicHotSearch,
  type MusicLoginSession,
  type MusicMvQuery,
  type MusicMvSource,
  type MusicPageQuery,
  type MusicPlaylistCategory,
  type MusicPlaylistQuery,
  type MusicProvider,
  type MusicQrChallenge,
  type MusicQrPollResult,
  type MusicRadioCategory,
  type MusicRadioListQuery,
  type MusicStreamSource,
} from '../types'
import { neteaseEndpoints, type NeteaseCall } from './endpoints'
import {
  normalizeAccount,
  normalizeAlbumDetail,
  normalizeAlbumSummary,
  normalizeArtistDetail,
  normalizeArtistSummary,
  normalizeDefaultKeyword,
  normalizeHotSearchItems,
  normalizeLyric,
  normalizeMvDetail,
  normalizeMvSource,
  normalizeMvSummary,
  normalizePage,
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
} from './normalize'
import { cookieToString, parseCookie, requestNetease, type NeteaseResponse } from './request'
import { NeteaseLogin, type NeteaseLoginRequest, type NeteaseLoginTransport } from './login'
import { ExternalNeteaseProvider } from './external'

export interface NeteaseProviderOptions {
  cookie?: string
  timeoutMs?: number
  retries?: number
}

const SEARCH_TYPES: Record<MusicSearchType, number> = {
  song: 1,
  album: 10,
  playlist: 1000,
  mv: 1004,
  radio: 1009,
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function number(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function messageOf(body: Record<string, unknown>, fallback: string): string {
  return text(body.msg) || text(body.message) || fallback
}

export class NeteaseProvider implements MusicProvider, NeteaseLoginTransport {
  readonly id = 'netease' as const
  private readonly cookies = new Map<string, string>()
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly login: NeteaseLogin

  constructor(options: NeteaseProviderOptions = {}) {
    for (const [name, value] of Object.entries(parseCookie(options.cookie))) {
      this.cookies.set(name, value)
    }
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.retries = options.retries ?? 1
    this.login = new NeteaseLogin(this)
  }

  currentCookie(): string {
    return cookieToString(Object.fromEntries(this.cookies))
  }

  private hasSession(): boolean {
    return this.cookies.has('MUSIC_U')
  }

  absorbCookie(cookie: string | string[]): void {
    const lines = Array.isArray(cookie) ? cookie : [cookie]
    for (const line of lines) {
      for (const part of line.split(';')) {
        const separator = part.indexOf('=')
        if (separator <= 0) continue
        const name = part.slice(0, separator).trim()
        const value = part.slice(separator + 1).trim()
        if (name) this.cookies.set(name, value)
      }
    }
  }

  resetCookie(): void {
    this.cookies.clear()
  }

  private async exchange(call: NeteaseCall): Promise<NeteaseResponse> {
    const response = await requestNetease(call.path, call.crypto, call.body, {
      cookie: this.currentCookie(),
      timeoutMs: this.timeoutMs,
      retries: this.retries,
    })
    if (response.cookie.length > 0) this.absorbCookie(response.cookie)
    return response
  }

  private errorFor(response: NeteaseResponse, code: number): MusicProviderError {
    const message = messageOf(response.body, `Netease answered ${code}`)
    if (response.error) return new MusicProviderError(502, 'network_error', response.error, response.body)
    if (code === 301 || code === -462) {
      return new MusicProviderError(401, 'auth_required', message, response.body)
    }
    if (code === 404) return new MusicProviderError(404, 'not_found', message, response.body)
    if (code >= 500 || response.status >= 500) {
      return new MusicProviderError(502, 'upstream_error', message, response.body)
    }
    return new MusicProviderError(400, 'upstream_error', message, response.body)
  }

  private async bodyOf(
    call: NeteaseCall,
    allowed: readonly number[] = [200],
  ): Promise<Record<string, unknown>> {
    const response = await this.exchange(call)
    const code = number(response.body.code, response.status)
    if (response.error) throw this.errorFor(response, code)
    if (!response.ok || !allowed.includes(code)) throw this.errorFor(response, code)
    return response.body
  }

  async request(input: NeteaseLoginRequest): Promise<Record<string, unknown>> {
    if (input.kind === 'qr-key') return this.bodyOf(neteaseEndpoints.loginQrKey())
    if (input.kind === 'qr-check') {
      return this.bodyOf(neteaseEndpoints.loginQrCheck(input.key), [800, 801, 802, 803])
    }
    return this.bodyOf(neteaseEndpoints.logout(), [200, 301])
  }

  async readAccount(): Promise<MusicAccount | null> {
    const response = await this.exchange(neteaseEndpoints.userAccount())
    const code = number(response.body.code, response.status)
    if (response.error) throw this.errorFor(response, code)
    if (code === 301) return null
    if (!response.ok || code >= 400) throw this.errorFor(response, code)
    return normalizeAccount(response.body)
  }

  async search(query: Parameters<MusicProvider['search']>[0]): Promise<MusicSearchResult> {
    const body = await this.bodyOf(
      neteaseEndpoints.search({
        keywords: query.keywords,
        type: SEARCH_TYPES[query.type],
        limit: query.limit,
        offset: query.offset,
      }),
    )
    return normalizeSearch(body, query.type, query.limit, query.offset)
  }

  async searchHot(): Promise<MusicHotSearch> {
    const [defaults, hot] = await Promise.all([
      this.bodyOf(neteaseEndpoints.searchDefault()),
      this.bodyOf(neteaseEndpoints.searchHot()),
    ])
    return {
      defaultKeyword: normalizeDefaultKeyword(defaults),
      items: normalizeHotSearchItems(hot),
    }
  }

  async suggest(keywords: string): Promise<{ keywords: string[] }> {
    const body = await this.bodyOf(neteaseEndpoints.searchSuggest(keywords))
    const result = record(body.result)
    const names = [
      ...list(result.songs).map((item) => text(record(item).name)),
      ...list(result.artists).map((item) => text(record(item).name)),
      ...list(result.albums).map((item) => text(record(item).name)),
    ]
    return { keywords: [...new Set(names.filter(Boolean))].slice(0, 10) }
  }

  async home(): Promise<MusicHome> {
    const [playlists, songs, artists, albums] = await Promise.all([
      this.bodyOf(neteaseEndpoints.personalizedPlaylists(12)),
      this.bodyOf(neteaseEndpoints.personalizedNewSongs(12)),
      this.bodyOf(neteaseEndpoints.topArtists({ limit: 12, offset: 0 })),
      this.bodyOf(neteaseEndpoints.albumNewest()),
    ])
    let dailyTracks: MusicTrack[] = []
    if (this.hasSession()) {
      try {
        dailyTracks = await this.dailyTracks()
      } catch (error) {
        // A public home feed must still render when the stored login has expired; the account
        // status endpoint is what marks it expired, so only the auth failure is absorbed here.
        if (!(error instanceof MusicProviderError) || error.code !== 'auth_required') throw error
        console.warn('[music] daily recommendations need a fresh Netease login:', error.message)
      }
    }
    return {
      dailyTracks,
      fmEnabled: this.hasSession(),
      recommendedPlaylists: list(record(playlists).result).map(normalizePlaylistSummary),
      hotArtists: list(record(artists).artists).map(normalizeArtistSummary),
      newAlbums: list(record(albums).albums).map(normalizeAlbumSummary),
      newTracks: list(record(songs).result).map((item) => normalizeTrack(item)),
    }
  }

  async dailyTracks(): Promise<MusicTrack[]> {
    const body = await this.bodyOf(neteaseEndpoints.recommendSongs())
    return list(record(body.data).dailySongs).map((item) => normalizeTrack(item))
  }

  async personalFm(): Promise<MusicTrack[]> {
    const body = await this.bodyOf(neteaseEndpoints.personalFm())
    return list(body.data).map((item) => normalizeTrack(item))
  }

  async fmTrash(providerId: string): Promise<void> {
    await this.bodyOf(neteaseEndpoints.fmTrash(providerId))
  }

  async songDetail(providerIds: string[]): Promise<MusicTrack[]> {
    if (providerIds.length === 0) return []
    const body = await this.bodyOf(neteaseEndpoints.songDetail(providerIds))
    return list(body.songs).map((item) => normalizeTrack(item))
  }

  async playlists(query: MusicPlaylistQuery): Promise<MusicPage<MusicPlaylistSummary>> {
    if (query.kind === 'recommended') {
      const body = await this.bodyOf(neteaseEndpoints.personalizedPlaylists(query.limit))
      const items = list(record(body).result).map(normalizePlaylistSummary)
      return normalizePage(items, items.length, query.offset)
    }
    const body =
      query.kind === 'highquality'
        ? await this.bodyOf(
            neteaseEndpoints.highqualityPlaylists({
              category: query.category,
              before: query.before,
              limit: query.limit,
              offset: query.offset,
            }),
          )
        : await this.bodyOf(
            neteaseEndpoints.topPlaylists({
              category: query.category,
              order: query.order,
              limit: query.limit,
              offset: query.offset,
            }),
          )
    const items = list(body.playlists).map(normalizePlaylistSummary)
    const total = number(body.total, items.length)
    return { items, total, hasMore: body.more === true || query.offset + items.length < total }
  }

  async playlistCategories(): Promise<MusicPlaylistCategory[]> {
    return normalizePlaylistCategories(await this.bodyOf(neteaseEndpoints.playlistCategories()))
  }

  async playlist(providerId: string, page: MusicPageQuery): Promise<MusicPlaylistDetail> {
    const detail = normalizePlaylistDetail(await this.bodyOf(neteaseEndpoints.playlistDetail(providerId)))
    const tracks = detail.tracks.slice(page.offset, page.offset + page.limit)
    return {
      playlist: detail.playlist,
      tracks,
      total: detail.total,
      hasMore: page.offset + tracks.length < detail.total,
    }
  }

  async albums(query: MusicAlbumQuery): Promise<MusicPage<MusicAlbumSummary>> {
    const body =
      query.kind === 'newest'
        ? await this.bodyOf(neteaseEndpoints.albumNewest())
        : await this.bodyOf(
            neteaseEndpoints.albumNew({
              area: query.area,
              limit: query.limit,
              offset: query.offset,
            }),
          )
    const items = list(body.albums).map(normalizeAlbumSummary)
    const total = number(body.total, items.length)
    return { items, total, hasMore: body.more === true || query.offset + items.length < total }
  }

  async album(providerId: string): Promise<MusicAlbumDetail> {
    return normalizeAlbumDetail(await this.bodyOf(neteaseEndpoints.album(providerId)))
  }

  async artist(query: MusicArtistQuery): Promise<MusicArtistDetail> {
    const [detail, songs, albums] = await Promise.all([
      this.bodyOf(neteaseEndpoints.artistDetail(query.id)),
      this.bodyOf(
        neteaseEndpoints.artistSongs({
          id: query.id,
          order: 'hot',
          limit: query.songLimit,
          offset: 0,
        }),
      ),
      this.bodyOf(
        neteaseEndpoints.artistAlbums(query.id, {
          limit: query.albumLimit,
          offset: query.albumOffset,
        }),
      ),
    ])
    return normalizeArtistDetail(detail, songs, albums, number(record(albums).total, 0))
  }

  async artistsTop(page: MusicPageQuery): Promise<MusicPage<MusicArtistSummary>> {
    const body = await this.bodyOf(neteaseEndpoints.topArtists(page))
    const items = list(body.artists).map(normalizeArtistSummary)
    const total = number(body.total, page.offset + items.length)
    return { items, total, hasMore: body.more === true || page.offset + items.length < total }
  }

  async toplists(): Promise<MusicToplistSummary[]> {
    const body = await this.bodyOf(neteaseEndpoints.toplist())
    return list(body.list).map(normalizeToplistSummary)
  }

  async mvList(query: MusicMvQuery): Promise<MusicPage<MusicMvSummary>> {
    const body = await this.bodyOf(
      neteaseEndpoints.mvAll({
        area: query.area,
        type: query.type,
        order: query.order,
        limit: query.limit,
        offset: query.offset,
      }),
    )
    const items = list(body.data).map(normalizeMvSummary)
    const total = number(body.count, items.length)
    return { items, total, hasMore: body.hasMore === true || query.offset + items.length < total }
  }

  async mvDetail(providerId: string): Promise<MusicMvDetail> {
    return normalizeMvDetail(await this.bodyOf(neteaseEndpoints.mvDetail(providerId)))
  }

  async mvUrl(providerId: string): Promise<MusicMvSource> {
    const source = normalizeMvSource(await this.bodyOf(neteaseEndpoints.mvUrl(providerId)))
    if (!source) throw new MusicProviderError(502, 'source_unavailable', 'Netease returned no MV URL')
    return source
  }

  async radioCategories(): Promise<MusicRadioCategory[]> {
    return normalizeRadioCategories(await this.bodyOf(neteaseEndpoints.djCategories()))
  }

  async radioRecommend(): Promise<MusicRadioSummary[]> {
    const body = await this.bodyOf(neteaseEndpoints.djRecommend())
    return list(body.djRadios).map(normalizeRadioSummary)
  }

  async radioToday(): Promise<MusicTrack[]> {
    const body = await this.bodyOf(neteaseEndpoints.djTodayPreferred())
    return list(body.data).map(normalizeProgram)
  }

  async radioHot(query: MusicRadioListQuery): Promise<MusicPage<MusicRadioSummary>> {
    const body = await this.bodyOf(
      neteaseEndpoints.djRadioHot({
        categoryId: query.categoryId ?? '',
        limit: query.limit,
        offset: query.offset,
      }),
    )
    const items = list(body.djRadios).map(normalizeRadioSummary)
    const total = number(body.count, items.length)
    return { items, total, hasMore: query.offset + items.length < total }
  }

  async radioSubscriptions(page: MusicPageQuery): Promise<MusicPage<MusicRadioSummary>> {
    const body = await this.bodyOf(neteaseEndpoints.djSublist(page))
    const items = list(body.djRadios).map(normalizeRadioSummary)
    const total = number(body.count, items.length)
    return { items, total, hasMore: page.offset + items.length < total }
  }

  async radio(providerId: string, page: MusicPageQuery): Promise<MusicRadioDetail> {
    const [detail, programs] = await Promise.all([
      this.bodyOf(neteaseEndpoints.djDetail(providerId)),
      this.bodyOf(
        neteaseEndpoints.djPrograms({
          radioId: providerId,
          limit: page.limit,
          offset: page.offset,
        }),
      ),
    ])
    return normalizeRadioDetail(detail, programs, page.offset)
  }

  async radioSubscribe(providerId: string, subscribe: boolean): Promise<void> {
    await this.bodyOf(neteaseEndpoints.djSubscribe(providerId, subscribe))
  }

  async lyrics(providerId: string): Promise<MusicLyricPayload> {
    const body = await this.bodyOf(neteaseEndpoints.lyric(providerId))
    return normalizeLyric(body, musicTrackKey('netease', providerId))
  }

  async stream(providerId: string, quality: string): Promise<MusicStreamSource> {
    const body = await this.bodyOf(
      neteaseEndpoints.songUrl({
        ids: [providerId],
        level: quality,
        encodeType: 'flac',
      }),
    )
    const source = normalizeStreamSource(body, quality)
    if (!source) {
      throw new MusicProviderError(
        502,
        'source_unavailable',
        'Netease returned no playable URL for this track and quality',
        body,
      )
    }
    return source
  }

  async downloadUrl(providerId: string, quality: string): Promise<MusicStreamSource> {
    const body = await this.bodyOf(
      neteaseEndpoints.songDownloadUrl({
        ids: [providerId],
        level: quality,
        encodeType: 'flac',
      }),
    )
    const source = normalizeStreamSource(body, quality)
    if (!source) {
      throw new MusicProviderError(
        502,
        'source_unavailable',
        'Netease returned no download URL for this track and quality',
        body,
      )
    }
    return source
  }

  async accountStatus(): Promise<MusicAccountStatus> {
    return this.login.status()
  }

  async loginQrKey(): Promise<MusicQrChallenge> {
    return this.login.createQr()
  }

  async loginQrPoll(key: string): Promise<MusicQrPollResult> {
    return this.login.pollQr(key)
  }

  async loginCookie(cookie: string): Promise<MusicLoginSession> {
    return this.login.connectCookie(cookie)
  }

  async logout(): Promise<void> {
    await this.login.logout()
  }
}

export interface CreateNeteaseProviderOptions extends NeteaseProviderOptions {
  /** When set, reads go through the self-hosted NCM API instead of the native client. */
  upstreamBaseUrl?: string
}

export function createNeteaseProvider(options: CreateNeteaseProviderOptions = {}): MusicProvider {
  if (options.upstreamBaseUrl) {
    return new ExternalNeteaseProvider({
      baseUrl: options.upstreamBaseUrl,
      cookie: options.cookie,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    })
  }
  return new NeteaseProvider(options)
}
