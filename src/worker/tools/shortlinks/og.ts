/**
 * Open Graph preview helpers for social crawlers: parse stored overrides, read a target page's
 * head with the same SSRF/timeout rules as the title sniff, and render an escaped page.
 */

import type { OgPreview } from '@shared/tools/shortlinks/types'
import { escapeHtml } from '../../lib/encoding'

export const OG_TITLE_LIMIT = 120
export const OG_DESCRIPTION_LIMIT = 200

const SOCIAL_CRAWLER = /(facebookexternalhit|facebookcatalog|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|whatsapp|pinterest|redditbot|embedly|skypeuri|quora link preview|vkshare)/i

export function isSocialCrawler(userAgent: string): boolean {
  return SOCIAL_CRAWLER.test(userAgent)
}

export function parseOgPreview(raw: unknown): OgPreview | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const object = value as Record<string, unknown>
    const preview: OgPreview = {}
    if (typeof object.title === 'string' && object.title.trim()) preview.title = object.title.trim().slice(0, OG_TITLE_LIMIT)
    if (typeof object.description === 'string' && object.description.trim()) {
      preview.description = object.description.trim().slice(0, OG_DESCRIPTION_LIMIT)
    }
    if (typeof object.image === 'string' && object.image.trim()) preview.image = object.image.trim()
    return Object.keys(preview).length > 0 ? preview : null
  } catch {
    return null
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)
  if (!match) return null
  return decodeEntities((match[2] ?? match[3] ?? '').trim())
}

function metaTags(html: string): Map<string, string> {
  const found = new Map<string, string>()
  const tags = html.match(/<meta\s+[^>]+>/gi) ?? []
  for (const tag of tags) {
    const key = (attribute(tag, 'property') ?? attribute(tag, 'name') ?? '').toLowerCase()
    const content = attribute(tag, 'content')
    if (!key || !content) continue
    if (!found.has(key)) found.set(key, content)
  }
  return found
}

function absoluteImage(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value, baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/** Reads OG/Twitter/title/description tags out of an already-fetched head. */
export function extractPageMetadata(
  html: string,
  baseUrl: string,
): { title: string | null; description: string | null; image: string | null } {
  const meta = metaTags(html)
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = meta.get('og:title') ?? meta.get('twitter:title') ?? (titleTag ? decodeEntities(titleTag[1]) : null)
  const description = meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description') ?? null
  const image = absoluteImage(meta.get('og:image') ?? meta.get('twitter:image'), baseUrl) ?? null
  return {
    title: title ? title.replace(/\s+/g, ' ').trim().slice(0, OG_TITLE_LIMIT) : null,
    description: description ? description.replace(/\s+/g, ' ').trim().slice(0, OG_DESCRIPTION_LIMIT) : null,
    image,
  }
}

export function renderOgPage(input: {
  title: string
  description: string | null
  image: string | null
  shortUrl: string
  target: string
  locale: 'en-US' | 'zh-CN'
}): string {
  const title = input.title.slice(0, OG_TITLE_LIMIT)
  const description = input.description?.slice(0, OG_DESCRIPTION_LIMIT)
  const image = absoluteImage(input.image ?? undefined, input.shortUrl)
  return `<!DOCTYPE html>
<html lang="${input.locale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  ${description ? `<meta property="og:description" content="${escapeHtml(description)}" />` : ''}
  ${image ? `<meta property="og:image" content="${escapeHtml(image)}" />` : ''}
  <meta property="og:url" content="${escapeHtml(input.shortUrl)}" />
  <meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  ${description ? `<meta name="twitter:description" content="${escapeHtml(description)}" />` : ''}
  ${image ? `<meta name="twitter:image" content="${escapeHtml(image)}" />` : ''}
  <meta http-equiv="refresh" content="0;url=${escapeHtml(input.target)}" />
</head>
<body>
  <p>${escapeHtml(title)}</p>
  <p><a href="${escapeHtml(input.target)}">${escapeHtml(input.target)}</a></p>
</body>
</html>`
}
