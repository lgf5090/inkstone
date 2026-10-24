/**
 * One playback entry point for every page.
 *
 * Pages never touch the audio element or the queue arithmetic; they hand the list they rendered and
 * the row the reader pressed to the player store. Keeping that call here means "play this row in this
 * list" means the same thing on a home shelf, a search result and a detail page.
 */
import type { MusicTrack } from '@shared/music/model'
import { useMusicPlayer } from '../../store/player'

export function playTracks(queue: readonly MusicTrack[], track?: MusicTrack): void {
  const selected = track ?? queue[0]
  if (!selected) return
  void useMusicPlayer.getState().playTrack(selected, { queue })
}
