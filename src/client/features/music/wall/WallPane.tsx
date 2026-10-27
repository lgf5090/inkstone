/**
 * The wall pane of Now Playing. It is replaced by the wall slice; this file exists so the shell's pane
 * registry is complete while the slices are built in parallel.
 */
import type { ReactElement } from 'react'
import { musicText } from '../components/labels'

export function WallPane(): ReactElement {
  return (
    <div className="music-np__pane-body music-np__empty">
      <p className="music-np__empty-title">{musicText('music.wall.title')}</p>
      <p className="music-np__empty-hint">{musicText('music.nowplaying.empty')}</p>
    </div>
  )
}
