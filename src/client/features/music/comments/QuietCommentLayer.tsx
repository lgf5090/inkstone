/**
 * The hot comment a quiet stretch of a song shows over the lyric surfaces.
 *
 * The caller supplies the lyric lines it already has and whether that request has settled; the layer
 * reads the playhead, the track and the hot-comments preference from their stores, so mounting it is
 * the whole integration. It draws nothing when the preference is off, when the track is not a song,
 * or when no quiet is long enough, which is why it can stay mounted for the whole surface's life.
 */
import { useMemo, type ReactElement } from 'react'
import type { LyricLine } from '@shared/music/lyrics'
import { cn } from '../../../lib/cn'
import { useRelativeTime } from '../../../lib/hooks'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { useMusicSettings } from '../store/settings'
import { useMusicUi } from '../store/ui'
import { musicText } from '../components/labels'
import { RemoteAvatar } from '../pages/parts/P2MediaCard'
import { commentAvatarUrl } from './comment-display'
import { useHotComments } from './use-comments'
import { quietCommentAt, quietsFor } from './quiet-comments'
import './comments.css'

const NO_LINES: readonly LyricLine[] = []

export interface QuietCommentLayerProps {
  /** The lines the lyric surface has parsed; omitted means the track has no lyric to avoid covering. */
  lines?: readonly LyricLine[]
  /** False while the lyric request is in flight, so its silence is not read as an instrumental. */
  loaded?: boolean
  className?: string
}

export function QuietCommentLayer({
  lines = NO_LINES,
  loaded = true,
  className,
}: QuietCommentLayerProps): ReactElement | null {
  const enabled = useMusicSettings((state) => state.local.hotComments)
  const track = useMusicPlayer(selectCurrentTrack)
  const positionMs = useMusicPlayer((state) => state.positionMs)
  const engineDurationMs = useMusicPlayer((state) => state.durationMs)
  const hot = useHotComments(track?.id, enabled)

  const durationMs = engineDurationMs || track?.durationMs || 0
  const quiets = useMemo(
    () => (track?.kind === 'song' ? quietsFor(lines, durationMs, { loaded }) : []),
    [track?.kind, lines, durationMs, loaded],
  )
  const current = useMemo(
    () => quietCommentAt(quiets, hot, positionMs),
    [quiets, hot, positionMs],
  )
  const comment = current.comment

  if (!enabled || !comment) return null
  const avatar = commentAvatarUrl(comment.avatarUrl)

  return (
    <aside className={cn('music-quiet-comment', className)} aria-label={musicText('music.comments.quiet_label')} data-comment-id={comment.id}>
      <RemoteAvatar src={avatar} name={comment.nickname} size={30} />
      <div className="music-quiet-comment__body">
        <p className="music-quiet-comment__meta">
          <span className="music-quiet-comment__author">{comment.nickname}</span>
          <QuietTime createdAt={comment.createdAt} />
        </p>
        <blockquote className="music-quiet-comment__content">{comment.content}</blockquote>
        <button
          type="button"
          className="music-quiet-comment__open"
          onClick={() => useMusicUi.getState().setNowPlayingTab('comments')}
        >
          {musicText('music.comments.open')}
        </button>
      </div>
    </aside>
  )
}

function QuietTime({ createdAt }: { createdAt: number }): ReactElement {
  const when = useRelativeTime(createdAt)
  return <span className="music-quiet-comment__time">{when}</span>
}
