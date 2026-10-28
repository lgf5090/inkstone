/**
 * Comments on a track or a podcast episode, as the provider served them.
 *
 * The worker resolves which upstream thread a track owns; the browser never sends one. `liked` is the
 * signed-in listener's own state and stays false for an anonymous read. Nothing here is persisted.
 */
export interface MusicComment {
  id: string
  userId: string
  nickname: string
  avatarUrl: string
  content: string
  createdAt: number
  likedCount: number
  liked: boolean
  ipLocation: string
  replyTo?: { nickname: string; content: string }
}

export interface MusicCommentPage {
  hot: MusicComment[]
  latest: MusicComment[]
  total: number
  hasMore: boolean
}
