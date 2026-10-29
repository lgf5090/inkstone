/**
 * The comment body as the reader is allowed to see it.
 *
 * A comment's `textDisplay` is HTML written by a stranger, so it never reaches the DOM as given:
 * the allowlist below keeps the formatting the comment editor offers and drops every element that
 * can act (`script`, `style`, `img`, `iframe`, event-handler attributes). Links are forced into a
 * new tab with `noopener noreferrer nofollow` so a comment cannot navigate this tab or vouch for
 * its own destination.
 */
import DOMPurify from 'dompurify'
import type { YouTubeComment } from '@shared/youtube/model'

const ALLOWED_TAGS = ['a', 'br', 'b', 'i', 'em', 'strong', 'span']
const ALLOWED_ATTR = ['href']
const LINK_REL = 'noopener noreferrer nofollow'

/**
 * Sanitized comment markup. Fails closed when there is no DOM to sanitize against, because handing
 * the raw string back would be worse than showing nothing.
 */
export function sanitizeCommentHtml(html: string): string {
  if (typeof window === 'undefined') return ''

  const clean = DOMPurify.sanitize(html ?? '', {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
  })

  const template = document.createElement('template')
  template.innerHTML = clean
  for (const link of Array.from(template.content.querySelectorAll('a'))) {
    const href = link.getAttribute('href')
    if (href === null || !isSafeHref(href)) link.removeAttribute('href')
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', LINK_REL)
  }
  return template.innerHTML
}

/**
 * The body to draw, or `null` when the sanitized markup carries no readable text — an empty
 * comment, a `<br>`-only body or one that was nothing but a stripped tag. The caller then falls
 * back to `textOriginal` as a plain text node.
 */
export function renderCommentBody(
  comment: Pick<YouTubeComment, 'textDisplay'>,
): { html: string } | null {
  const html = sanitizeCommentHtml(comment.textDisplay ?? '')
  if (!html.trim()) return null

  const template = document.createElement('template')
  template.innerHTML = html
  const text = (template.content.textContent ?? '').replace(/\u00a0/g, ' ').trim()
  return text ? { html } : null
}

function isSafeHref(value: string): boolean {
  return /^(https?:|mailto:)/i.test(value.trim())
}
