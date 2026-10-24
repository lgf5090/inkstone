/**
 * The AI translation call, made only when the reader asks for it.
 *
 * Kept out of `musicApi` because it is not a music-provider read: it spends assistant quota and sends
 * the lyric to the reader's model provider, and a surface that renders lyrics should be able to see
 * that difference in the import it uses.
 */
import type { MusicAiTranslateLang, MusicAiTranslateResponse } from '@shared/music/lyrics-ai'
import { request } from '../../lib/api'

/** The translation target the UI asks for: resolved from the lyric's own script by the worker. */
export function defaultLyricTranslationLang(): MusicAiTranslateLang {
  // The endpoint resolves `auto` from the lyric's own script. Picking the interface language here
  // would ask a Chinese lyric to be translated into Chinese on a Chinese screen.
  return 'auto'
}

export function translateTrackLyrics(
  trackId: string,
  targetLang: MusicAiTranslateLang,
  force = false,
): Promise<MusicAiTranslateResponse> {
  return request<MusicAiTranslateResponse>(
    `/api/music/library/lyrics/${encodeURIComponent(trackId)}/ai-translate`,
    { method: 'POST', body: { targetLang, force } },
  )
}
