// @vitest-environment jsdom
/**
 * A comment body is stranger-written HTML, so these cases pin the allowlist and the link hardening
 * rather than any particular formatting: markup that can act is gone, the few tags the comment
 * editor writes survive, and every surviving link is forced into a new tab.
 */
import { describe, expect, it } from 'vitest'
import { renderCommentBody, sanitizeCommentHtml } from './comment-html'

describe('sanitizeCommentHtml', () => {
  it('removes scripts, styles and image payloads', () => {
    const html = sanitizeCommentHtml(
      '<p>hello<script>alert(1)</script><style>body{display:none}</style><img src="x" onerror="alert(2)"></p>',
    )
    const lower = html.toLowerCase()
    expect(lower).not.toContain('<script')
    expect(lower).not.toContain('<style')
    expect(lower).not.toContain('<img')
    expect(lower).not.toContain('onerror')
    expect(html).toContain('hello')
  })

  it('drops javascript: destinations and inline handlers', () => {
    const html = sanitizeCommentHtml(
      '<a href="javascript:alert(1)" onclick="alert(2)">click</a>',
    )
    const lower = html.toLowerCase()
    expect(lower).not.toContain('javascript:')
    expect(lower).not.toContain('onclick')
    expect(html).toContain('<a')
    expect(html).toContain('click')
  })

  it('keeps the formatting a comment is written with', () => {
    const html = sanitizeCommentHtml(
      '<b>bold</b><br><i>italic</i><strong>strong</strong><em>emphasis</em><a href="https://example.com">link</a>',
    )
    expect(html).toContain('<b>bold</b>')
    expect(html).toContain('<br>')
    expect(html).toContain('<i>italic</i>')
    expect(html).toContain('<strong>strong</strong>')
    expect(html).toContain('<em>emphasis</em>')
    expect(html).toContain('href="https://example.com"')
  })

  it('marks every surviving link as external and untrusted', () => {
    const host = document.createElement('div')
    host.innerHTML = sanitizeCommentHtml(
      '<a href="https://example.com/a">a</a><a href="http://example.com/b">b</a>',
    )
    const links = Array.from(host.querySelectorAll('a'))
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    }
  })

  it('removes iframes and svg payloads but keeps their text siblings', () => {
    const html = sanitizeCommentHtml(
      '<iframe src="https://evil.test"></iframe><svg onload="alert(1)"><circle /></svg><span>safe</span>',
    )
    const lower = html.toLowerCase()
    expect(lower).not.toContain('<iframe')
    expect(lower).not.toContain('<svg')
    expect(lower).not.toContain('onload')
    expect(html).toContain('<span>safe</span>')
  })
})

describe('renderCommentBody', () => {
  it('returns sanitized html when the body has text', () => {
    const body = renderCommentBody({ textDisplay: '<b>hi</b><script>alert(1)</script>' })
    expect(body).not.toBeNull()
    expect(body?.html).toContain('<b>hi</b>')
    expect(body?.html.toLowerCase()).not.toContain('<script')
  })

  it('returns null when the sanitized body has no text', () => {
    expect(renderCommentBody({ textDisplay: '' })).toBeNull()
    expect(renderCommentBody({ textDisplay: '<br>' })).toBeNull()
    expect(renderCommentBody({ textDisplay: '<script>alert(1)</script>' })).toBeNull()
    expect(renderCommentBody({ textDisplay: '<img src="x" onerror="alert(1)">' })).toBeNull()
  })
})
