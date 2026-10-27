/**
 * The comments pane of Now Playing. It is replaced by the comments slice; this file exists so the
 * shell's pane registry is complete while the slices are built in parallel.
 */
import type { ReactElement } from 'react'
import { musicText } from '../components/labels'

export function CommentsPane(): ReactElement {
  return (
    <div className="music-np__pane-body music-np__empty">
      <p className="music-np__empty-title">{musicText('music.comments.title')}</p>
      <p className="music-np__empty-hint">{musicText('music.nowplaying.empty')}</p>
    </div>
  )
}
