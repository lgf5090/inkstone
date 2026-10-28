/**
 * The lyric surface inside Now Playing. It is the existing lyric panel until the parity pass replaces
 * its renderer; keeping the wrapper means the shell does not import a component another slice owns.
 */
import type { ReactElement } from 'react'
import { LyricPanel } from '../components/LyricPanel'

export function LyricsPane(): ReactElement {
  return <LyricPanel variant="embedded" className="music-np__lyrics-pane" />
}
