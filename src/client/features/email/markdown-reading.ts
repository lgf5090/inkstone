import { decodeEmailEntities } from '@shared/email/format'

const RICH_TAG = /<(?:a|strong|b|em|i|u|s|del|img|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|pre|code|blockquote|hr|mark|details|summary|input|video|audio|svg|figure|picture)\b/i
const BLOCK_BREAK = /<\/(?:div|p|li|tr|h[1-6]|blockquote|pre|table|ul|ol)>|<br\s*\/?>/gi

function htmlLines(html: string): string {
  return decodeEmailEntities(
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(BLOCK_BREAK, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function emailMarkdownSource(body: string): string | null {
  if (!body.trim()) return null
  if (!/<[a-z][\s\S]*>/i.test(body)) return body.trim()
  if (RICH_TAG.test(body)) return null
  return htmlLines(body) || null
}

export function looksLikeMarkdown(source: string): boolean {
  const lines = source.split('\n')
  const listLines = lines.filter((line) => /^ {0,3}(?:[-*+]|\d+\.)\s+\S/.test(line)
    && !/^ {0,3}[-*+]\s+\[[ xX]\]\s+/.test(line)).length
  const kinds = [
    /^ {0,3}#{1,6}\s+\S/m.test(source),
    /^ {0,3}```/m.test(source),
    /^ {0,3}>\s+\[![A-Za-z]+\]/m.test(source),
    /^ {0,3}[-*+]\s+\[[ xX]\]\s+/m.test(source),
    /^ {0,3}\|.*\|\s*$/m.test(source),
    /^ {0,3}(?:---|\*\*\*)\s*$/m.test(source),
    /^ {0,3}>\s+\S/m.test(source),
    listLines >= 2,
  ]
  return kinds.filter(Boolean).length >= 2
}
