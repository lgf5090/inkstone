/**
 * The wall pane: the queue as a field of covers you can push around with a finger.
 *
 * The heading stays still and names what is playing, with the line being sung and the one after it.
 * Under it, every queue cover is a real button on one oversized plane; pressing one plays that
 * track. The geometry is pure (`wall-layout.ts`) and the pointer handling is isolated in
 * `use-wall-drag.ts`; this file only measures the pane, decides which slice of a long queue to mount,
 * and paints the result.
 */
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react'
import { musicArtistNames } from '@shared/music/format'
import type { MusicQueue } from '../player/queue'
import type { MusicTrack } from '@shared/music/model'
import { Empty } from '../../../components/feedback'
import { Cover } from '../components/Cover'
import { musicText } from '../components/labels'
import { useActiveLyricLine, useLyricOffset, useTrackLyrics } from '../components/LyricPanel'
import { useMusicPlayer, selectCurrentTrack } from '../store/player'
import { WALL_TILE, cell, layWall, visibleRange } from './wall-layout'
import { usePrefersReducedMotion, useWallDrag } from './use-wall-drag'
import './wall.css'

interface PaneSize {
  width: number
  height: number
  top: number
}

export function WallPane(): ReactElement {
  const current = useMusicPlayer(selectCurrentTrack)
  const queue = useMusicPlayer((state) => state.queue)
  if (!current) {
    return (
      <Empty
        art="notes"
        title={musicText('music.queue.empty')}
        description={musicText('music.queue.empty_hint')}
      />
    )
  }
  return <WallBoard queue={queue} current={current} />
}

function WallBoard({ queue, current }: { queue: MusicQueue; current: MusicTrack }): ReactElement {
  const viewportRef = useRef<HTMLDivElement>(null)
  const planeRef = useRef<HTMLUListElement>(null)
  const headRef = useRef<HTMLElement>(null)
  const [size, setSize] = useState<PaneSize>({ width: 0, height: 0, top: 0 })
  const playTrack = useMusicPlayer((state) => state.playTrack)
  const positionMs = useMusicPlayer((state) => state.positionMs)
  const playing = useMusicPlayer((state) => state.status === 'playing')
  const reducedMotion = usePrefersReducedMotion()

  // The pane is the measuring stick: its box decides how wide the wall is drawn, and the heading's
  // own height is the part of that box covers must stay out of. A lyric loading in and making the
  // heading taller re-measures through the same observer.
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = (): void => {
      const rect = viewport.getBoundingClientRect()
      const top = headRef.current?.offsetHeight ?? 0
      setSize((previous) => (
        previous.width === rect.width && previous.height === rect.height && previous.top === top
          ? previous
          : { width: rect.width, height: rect.height, top }
      ))
    }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(viewport)
    if (headRef.current) observer?.observe(headRef.current)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  const range = useMemo(
    () => visibleRange(queue.tracks.length, queue.index),
    [queue.index, queue.tracks.length],
  )
  const tracks = useMemo(
    () => queue.tracks.slice(range.start, range.end),
    [queue.tracks, range.end, range.start],
  )
  const layout = useMemo(
    () => layWall(tracks.length, size.width, size.height, size.top),
    [size.height, size.top, size.width, tracks.length],
  )
  const currentCell = Math.max(0, queue.index - range.start)

  useWallDrag({
    viewportRef,
    planeRef,
    layout,
    width: size.width,
    height: size.height,
    top: size.top,
    foot: 0,
    centreIndex: currentCell,
    reducedMotion,
  })

  const lyrics = useTrackLyrics(current)
  const [lyricOffset] = useLyricOffset(current)
  const activeLine = useActiveLyricLine(lyrics.lines, positionMs, lyricOffset, playing)
  const lineIndex = activeLine >= 0 ? activeLine : 0
  const currentLyric = lyrics.lines[lineIndex]?.fullText ?? ''
  const nextLyric = lyrics.lines[lineIndex + 1]?.fullText ?? ''
  const lyricMessage = lyrics.status === 'loading'
    ? musicText('music.lyrics.loading')
    : lyrics.status === 'error'
      ? musicText('music.lyrics.error')
      : musicText('music.lyrics.empty')

  return (
    <div
      ref={viewportRef}
      className="music-wall"
      style={{ '--music-wall-tile': `${WALL_TILE}px` } as CSSProperties}
    >
      <header ref={headRef} className="music-wall__head">
        <Cover
          trackId={current.id}
          src={current.coverUrl || undefined}
          version={current.updatedAt}
          size="lg"
          radius="md"
          alt=""
          className="music-wall__head-cover"
        />
        <div className="music-wall__head-text">
          <p className="music-wall__eyebrow">{musicText('music.wall.title')}</p>
          <h2 className="music-wall__title" title={current.title}>{current.title}</h2>
          <p className="music-wall__artist">{musicArtistNames(current)}</p>
          <div className="music-wall__lyric">
            {currentLyric ? (
              <p className="music-wall__lyric-line music-wall__lyric-line--current">{currentLyric}</p>
            ) : (
              <p className="music-wall__lyric-line music-wall__lyric-line--empty">{lyricMessage}</p>
            )}
            {currentLyric && nextLyric && (
              <p className="music-wall__lyric-line music-wall__lyric-line--next">{nextLyric}</p>
            )}
          </div>
        </div>
      </header>

      <ul
        ref={planeRef}
        className="music-wall__plane"
        aria-label={musicText('music.wall.title')}
      >
        {tracks.map((track, index) => {
          const at = cell(layout, index)
          const active = range.start + index === queue.index
          return (
            <li
              key={track.id}
              className="music-wall__cell"
              style={{ left: at.x, top: at.y }}
            >
              <button
                type="button"
                className="music-wall__tile"
                aria-label={`${musicText('music.wall.title')}: ${track.title}`}
                aria-current={active ? 'true' : undefined}
                onClick={() => { void playTrack(track) }}
              >
                <Cover
                  trackId={track.id}
                  src={track.coverUrl || undefined}
                  version={track.updatedAt}
                  size="lg"
                  radius="md"
                  alt=""
                  className="music-wall__cover"
                />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
