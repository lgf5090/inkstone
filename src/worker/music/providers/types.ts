/**
 * The seam between the music store/routes and a content provider.
 *
 * A provider answers with the app's own vocabulary (`shared/music`), never with an upstream payload.
 * Provider ids stay strings so numeric song ids and string program ids share one shape, and every
 * summary id is the provider's own id: the store assigns local row ids only when it persists a track.
 */
import type {
  MusicAccount,
  MusicFmMode,
  MusicProviderId,
  MusicSearchType,
  MusicTrack,
} from '../../../shared/music/model'
import type {
  MusicAccountStatus,
  MusicAlbumDetail,
  MusicAlbumSummary,
  MusicArtistDetail,
  MusicArtistEventPage,
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
  MusicUserProfile,
} from '../../../shared/music/api'
import type { MusicCommentPage } from '../../../shared/music/comments'

export interface MusicPageQuery {
  limit: number
  offset: number
}

/** A page whose next request is addressed by the upstream's own cursor rather than an offset. */
export interface MusicCursorPage<T> extends MusicPage<T> {
  cursor: number
}

export interface MusicSearchQuery extends MusicPageQuery {
  type: MusicSearchType
  keywords: string
}

export interface MusicSuggestionKeywords {
  keywords: string[]
}

export interface MusicCommentQuery {
  thread: string
  offset: number
  limit: number
}

export interface MusicCommentLike {
  thread: string
  commentId: string
  liked: boolean
}

export interface MusicHeartModeQuery {
  songId: string
  startSongId: string
  playlistId: string
}

export interface MusicHotSearchItem {
  keyword: string
  score: number
}

export interface MusicHotSearch {
  defaultKeyword: string
  items: MusicHotSearchItem[]
}

export interface MusicPlaylistQuery extends MusicPageQuery {
  /** `recommended` is the home feed; `hot` and `highquality` are the square. */
  kind: 'recommended' | 'hot' | 'highquality'
  category?: string
  order?: 'hot' | 'new'
  /** The high-quality square pages by the previous page's `updateTime` instead of an offset. */
  before?: number
}

export interface MusicPlaylistCategory {
  name: string
  hot: boolean
}

export interface MusicAlbumQuery extends MusicPageQuery {
  kind: 'new' | 'newest'
  area?: 'ALL' | 'ZH' | 'EA' | 'KR' | 'JP'
}

export interface MusicArtistQuery {
  id: string
  albumLimit: number
  albumOffset: number
  songLimit: number
}

export interface MusicMvQuery extends MusicPageQuery {
  area?: string
  type?: string
  order?: string
}

export interface MusicMvSource {
  url: string
  expiresAt: number
  resolution: number
  size: number | null
}

export interface MusicRadioCategory {
  id: string
  name: string
}

export interface MusicRadioListQuery extends MusicPageQuery {
  categoryId?: string
  toplistType?: 'new' | 'hot'
}

export interface MusicStreamSource {
  url: string
  /** Epoch milliseconds after which the upstream refuses this URL. */
  expiresAt: number
  format: string
  bitrate: number | null
  size: number | null
  quality: string
  /** The level the provider actually served, which may be below the one asked for. */
  level: string
  /** ReplayGain in dB; 0 when the provider did not measure it. */
  gain: number
  /** The loudest sample, 1 at full scale; 0 when unknown. */
  peak: number
  /** A trial clip: the player must say so instead of presenting it as the full track. */
  freeTrial: boolean
}

export interface MusicQrChallenge {
  key: string
  /** The URL the client draws as a QR code; no image is generated server-side. */
  url: string
  expiresAt: number
}

export type MusicQrStatus = 'waiting' | 'scanned' | 'confirmed' | 'expired'

export interface MusicQrPollResult {
  status: MusicQrStatus
  message: string
  /** Only set on `confirmed`, and only so the caller can store it encrypted. */
  cookie: string
  account: MusicAccount | null
}

export interface MusicLoginSession {
  account: MusicAccount
  cookie: string
}

export interface MusicSessionState {
  account: MusicAccount | null
  hasSession: boolean
}

/**
 * A provider failure the route layer can translate. `status` mirrors HTTP intent; `body` keeps the
 * upstream payload so a route can log what actually happened instead of a generic message.
 */
export class MusicProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'MusicProviderError'
  }
}

/** The smallest stable surface every content provider offers. */
export interface MusicProvider {
  readonly id: MusicProviderId

  search(query: MusicSearchQuery): Promise<MusicSearchResult>
  searchHot(): Promise<MusicHotSearch>
  suggest(keywords: string): Promise<MusicSuggestionKeywords>

  home(): Promise<MusicHome>
  dailyTracks(): Promise<MusicTrack[]>
  personalFm(mode: MusicFmMode): Promise<MusicTrack[]>
  fmTrash(providerId: string): Promise<void>

  comments(query: MusicCommentQuery): Promise<MusicCommentPage>
  likeComment(input: MusicCommentLike): Promise<void>

  songDetail(providerIds: string[]): Promise<MusicTrack[]>

  playlists(query: MusicPlaylistQuery): Promise<MusicCursorPage<MusicPlaylistSummary>>
  playlistCategories(): Promise<MusicPlaylistCategory[]>
  playlist(providerId: string, page: MusicPageQuery): Promise<MusicPlaylistDetail>

  albums(query: MusicAlbumQuery): Promise<MusicPage<MusicAlbumSummary>>
  album(providerId: string): Promise<MusicAlbumDetail>

  artist(query: MusicArtistQuery): Promise<MusicArtistDetail>
  artistSongs(providerId: string, order: 'hot' | 'time', page: MusicPageQuery): Promise<MusicTrack[]>
  artistFollow(providerId: string, follow: boolean): Promise<void>
  artistEvents(providerId: string, before: number | null, limit: number): Promise<MusicArtistEventPage>
  artistsTop(page: MusicPageQuery): Promise<MusicPage<MusicArtistSummary>>
  toplists(): Promise<MusicToplistSummary[]>

  mvList(query: MusicMvQuery): Promise<MusicPage<MusicMvSummary>>
  mvDetail(providerId: string): Promise<MusicMvDetail>
  mvUrl(providerId: string): Promise<MusicMvSource>

  radioCategories(): Promise<MusicRadioCategory[]>
  radioRecommend(): Promise<MusicRadioSummary[]>
  radioToday(): Promise<MusicTrack[]>
  radioHot(query: MusicRadioListQuery): Promise<MusicPage<MusicRadioSummary>>
  radioSubscriptions(page: MusicPageQuery): Promise<MusicPage<MusicRadioSummary>>
  radio(providerId: string, page: MusicPageQuery): Promise<MusicRadioDetail>
  radioSubscribe(providerId: string, subscribe: boolean): Promise<void>
  heartMode(query: MusicHeartModeQuery): Promise<MusicTrack[]>
  /** The listener's liked-songs playlist id, or an empty string when it is not visible. */
  likedPlaylistId(): Promise<string>

  lyrics(providerId: string): Promise<MusicLyricPayload>
  stream(providerId: string, quality: string): Promise<MusicStreamSource>
  downloadUrl(providerId: string, quality: string): Promise<MusicStreamSource>

  accountStatus(): Promise<MusicAccountStatus>
  userProfile(uid: string): Promise<MusicUserProfile>
  loginQrKey(): Promise<MusicQrChallenge>
  loginQrPoll(key: string): Promise<MusicQrPollResult>
  loginCookie(cookie: string): Promise<MusicLoginSession>
  logout(): Promise<void>
  /** The cookie the provider is currently using, for the caller to encrypt and store. */
  currentCookie(): string
}
