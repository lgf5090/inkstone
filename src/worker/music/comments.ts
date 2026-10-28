/**
 * The upstream comment thread a stored track belongs to.
 *
 * Only Netease tracks have threads; an episode's comments belong to the programme, not to the audio
 * file it streams from, so an episode without its programme id cannot be resolved.
 */
import type { MusicTrack } from '../../shared/music/model'

export function commentThread(track: Pick<MusicTrack, 'provider' | 'kind' | 'providerId' | 'programId'>): string | null {
  if (track.provider !== 'netease') return null
  if (track.kind === 'podcast') {
    return track.programId ? `A_DJ_1_${track.programId}` : null
  }
  return track.providerId ? `R_SO_4_${track.providerId}` : null
}
