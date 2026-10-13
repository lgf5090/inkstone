/**
 * What an article carries besides text: an episode to play, a video to open.
 *
 * The reference reader embeds YouTube and Bilibili players. This app does not: its document policy
 * allows no third-party frames at all (`frame-src 'none'`), and an embedded player is a page of
 * somebody else's JavaScript running inside the notebook — a price worth not paying for a preview
 * thumbnail. So a video entry gets a card that names the host and opens it, which is also what a
 * phone reader wants.
 *
 * Podcast enclosures are a different case: they are audio files, and they come through the same
 * relay as pictures, which is why they play here at all.
 */
import { safeHttpUrl } from '@shared/rss/model'
import { platformOf } from '@shared/rss/platform'
import type { MessageKey } from '@shared/locales/en-US'

export interface VideoLink {
  host: string
  url: string
}

export function videoLinkOf(value: string | null | undefined): VideoLink | null {
  const url = safeHttpUrl(value ?? '')
  if (!url || url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    const id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(shorts|live|embed)\/([A-Za-z0-9_-]{11})/.exec(url.pathname)?.[2]
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? { host: 'YouTube', url: `https://www.youtube.com/watch?v=${id}` } : null
  }
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0]
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? { host: 'YouTube', url: `https://www.youtube.com/watch?v=${id}` } : null
  }
  if (host === 'bilibili.com' || host === 'm.bilibili.com') {
    return /^\/video\/BV[0-9A-Za-z]{10}\/?$/.test(url.pathname) ? { host: 'bilibili', url: url.href } : null
  }
  if (host === 'player.bilibili.com') return null
  return null
}

/** An enclosure a reader can play. Plain HTTP is refused: the page is https, and the browser would block it. */
export function playableAudio(url: string | null | undefined): string {
  const safe = safeHttpUrl(url ?? '')
  return safe?.protocol === 'https:' ? safe.href : ''
}

/**
 * The one word that tells a reader what they are about to open, or nothing for a plain article.
 *
 * The address answers first — a YouTube video is labelled by the platform a reader already knows,
 * and the word would be the same either way — and what is left is the two kinds worth deciding about
 * before opening: something to play, and something to watch. A null here is the common case, so the
 * row shows no badge at all rather than a word that says "article".
 */
export function articleBadge(entry: { audioUrl: string, link: string }): MessageKey | null {
  const platform = platformOf(entry.link)
  if (platform !== 'web') return `rss.platform_${platform}` as MessageKey
  if (playableAudio(entry.audioUrl)) return 'rss.kind_podcast'
  if (videoLinkOf(entry.link)) return 'rss.kind_video'
  return null
}
