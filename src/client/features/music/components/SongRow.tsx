/**
 * One track in a list, a compact stack or a card grid.
 *
 * The row is a `<li>` holding a real `<button>`: the button is the press target that starts the
 * track, and the favourite and overflow controls are its siblings rather than children, so the row
 * never nests one control inside another. A right-click on the row opens the same menu at the
 * pointer; the overflow button opens it under itself.
 *
 * Enter and Space are handled explicitly because the tests drive keydown directly and because the row
 * must start playback even when a future variant is not a native button; the default action is
 * cancelled so the browser does not fire the click a second time.
 */
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import { AudioLines, Heart, ListPlus, MoreHorizontal } from 'lucide-react'
import { formatDuration, musicArtistNames } from '@shared/music/format'
import type { MusicTrack } from '@shared/music/model'
import { cn } from '../../../lib/cn'
import { IconButton } from '../../../components/primitives'
import { Menu, Tooltip, useContextMenu, type MenuItem } from '../../../components/overlay'
import { useMusicLibrary } from '../store/library'
import { useMusicPlayer } from '../store/player'
import { Cover } from './Cover'
import { musicText } from './labels'

export type SongRowVariant = 'list' | 'compact' | 'card'

export interface SongRowProps {
  track: MusicTrack
  /** Zero-based position in the list the row was rendered from. */
  index?: number
  variant?: SongRowVariant
  /** The track the player is pointed at, whether or not it is sounding. */
  active?: boolean
  /** The player is loading or sounding this track, which the state cell shows. */
  playing?: boolean
  /** A row a page cannot offer right now, with the sentence that explains why. */
  disabledReason?: string
  /** Extra or replacement menu rows. Omitted means the built-in "play next" row. */
  menuItems?: MenuItem[]
  onPlay: (track: MusicTrack) => void
  className?: string
}

export function SongRow({
  track,
  index,
  variant = 'list',
  active = false,
  playing = false,
  disabledReason,
  menuItems,
  onPlay,
  className,
}: SongRowProps): ReactElement {
  const favorite = useMusicLibrary((state) => state.favorites.some((entry) => entry.id === track.id))
  const toggleFavorite = useMusicLibrary((state) => state.toggleFavorite)
  const context = useContextMenu()
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)

  const items = menuItems ?? [
    {
      id: 'play-next',
      label: musicText('music.song.play_next'),
      icon: <ListPlus size={14} />,
      onSelect: () => {
        useMusicPlayer.getState().addNext(track)
      },
    },
  ]
  const hasMenu = items.length > 0
  const menuOpen = moreOpen || context.point !== null

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    if (event.repeat) return
    // Both keys are the button's own activation; cancelling the default keeps the browser from
    // firing the click a second time after this handler (Enter on keydown, Space on keyup).
    event.preventDefault()
    if (!disabledReason) onPlay(track)
  }

  const rowButton = (
    <button
      type="button"
      className="music-row__main"
      aria-disabled={disabledReason ? true : undefined}
      onClick={() => {
        if (!disabledReason) onPlay(track)
      }}
      onKeyDown={onKeyDown}
    >
      <span
        className={cn('music-row__state', active && 'music-row__state--active')}
        aria-hidden="true"
      >
        {active ? (
          <AudioLines size={14} className={playing ? undefined : 'opacity-50'} />
        ) : index === undefined ? (
          '-'
        ) : (
          index + 1
        )}
      </span>
      <Cover trackId={track.id} size="sm" radius="sm" />
      <span className="music-row__text">
        <span className="music-row__title">{track.title}</span>
        <span className="music-row__meta">{musicArtistNames(track)}</span>
      </span>
      <span className="music-row__album">{track.album}</span>
      <span className="music-row__duration">{formatDuration(track.durationMs)}</span>
    </button>
  )

  return (
    <li
      className={cn(
        'music-row',
        `music-row--${variant}`,
        active && 'music-row--active',
        disabledReason && 'music-row--disabled',
        className,
      )}
      onContextMenu={hasMenu ? context.onContextMenu : undefined}
    >
      {disabledReason ? <Tooltip label={disabledReason}>{rowButton}</Tooltip> : rowButton}

      <div className="music-row__actions">
        <IconButton
          label={musicText(favorite ? 'music.song.unfavorite' : 'music.song.favorite')}
          size="xs"
          active={favorite}
          onClick={() => {
            void toggleFavorite(track)
          }}
        >
          <Heart size={14} className={favorite ? 'fill-current' : undefined} />
        </IconButton>
        {hasMenu && (
          <IconButton
            ref={moreRef}
            label={musicText('music.song.more')}
            size="xs"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMoreOpen(true)}
          >
            <MoreHorizontal size={15} />
          </IconButton>
        )}
      </div>

      {hasMenu && (
        <Menu
          anchor={context.point ?? moreRef}
          open={menuOpen}
          onClose={() => {
            setMoreOpen(false)
            context.close()
          }}
          items={items}
          align="end"
          width={200}
          label={musicText('music.song.menu')}
        />
      )}
    </li>
  )
}
