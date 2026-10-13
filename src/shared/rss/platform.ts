/**
 * Where an article's address says it came from.
 *
 * The reader never picks a platform and no feed declares one: the address already says it, and a
 * second answer typed by hand is one more thing to get wrong. The table is the reference reader's —
 * the four hosts its Chinese-language library actually turns up — and an address that is not one of
 * them is an article, which is what the overwhelming majority are.
 */
import type { RssEntry } from './model'

export type LinkPlatform = 'youtube' | 'bilibili' | 'wechat' | 'web'

export const PLATFORMS: LinkPlatform[] = ['youtube', 'bilibili', 'wechat', 'web']

export function platformOf(link: string | null | undefined): LinkPlatform {
  let host = ''
  try {
    host = new URL(link || '').hostname.toLowerCase()
  }
  catch {
    return 'web'
  }
  const is = (domain: string): boolean => host === domain || host.endsWith(`.${domain}`)
  if (is('youtube.com') || is('youtu.be')) return 'youtube'
  if (is('bilibili.com') || is('b23.tv')) return 'bilibili'
  if (host === 'mp.weixin.qq.com') return 'wechat'
  return 'web'
}

/** A channel filter: everything, or one platform's articles. */
export function filterByPlatform(entries: RssEntry[], platform: LinkPlatform | 'all'): RssEntry[] {
  if (platform === 'all') return entries
  return entries.filter(entry => platformOf(entry.link) === platform)
}

/** How many of a list of articles belong to each platform, for the filter's own counts. */
export function platformCounts(entries: RssEntry[]): Map<LinkPlatform, number> {
  const out = new Map<LinkPlatform, number>()
  for (const entry of entries) {
    const platform = platformOf(entry.link)
    out.set(platform, (out.get(platform) ?? 0) + 1)
  }
  return out
}
