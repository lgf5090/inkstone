/**
 * The AI translation call, made only when the reader asks for it.
 *
 * Kept out of `musicApi` because it is not a music-provider read: it spends assistant quota and sends
 * the lyric to the reader's model provider, and a surface that renders lyrics should be able to see
 * that difference in the import it uses.
 */
import type { MusicAiTranslateLang, MusicAiTranslateResponse } from '@shared/music/lyrics-ai'
import { request } from '../../lib/api'
import { getLocale } from '../../lib/i18n'

/** The translation target the UI asks for: the reader's interface language, one of the two catalogs. */
export function defaultLyricTranslationLang(): Exclude<MusicAiTranslateLang, 'auto'> {
  return getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
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
