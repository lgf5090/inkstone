/**
 * Markdown as the assistant wrote it, rendered safely.
 *
 * The HTML is produced by markdown-it, sanitised by DOMPurify, and then given syntax colour by the
 * notebook's own Prism loader — the same highlighter the note preview uses. Code blocks carry a
 * language label and a copy button; both are ordinary DOM inside the sanitised fragment, with copy
 * handled by delegation because the fragment is not React's to own.
 *
 * Raw HTML is kept because a template README is documentation, not a prompt: a README that lays its
 * screenshots out with a `<table>` would otherwise show its markup as text. DOMPurify is the trust
 * boundary, and remote images are rewritten to the worker's image proxy because the page's own
 * `img-src` does not allow the documentation host.
 */
import { useEffect, useMemo, useRef } from 'react'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { highlightWithPrism } from '../../../lib/markdown/prism'

function createRenderer(): MarkdownIt {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: false })

  const defaultLinkOpen = md.renderer.rules.link_open
    ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))
  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    tokens[index]!.attrSet('target', '_blank')
    tokens[index]!.attrSet('rel', 'noopener noreferrer nofollow')
    return defaultLinkOpen(tokens, index, options, env, self)
  }

  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]!
    const language = (token.info.trim().split(/\s+/)[0] ?? '').replace(/[^\w-]/g, '')
    const escaped = md.utils.escapeHtml(token.content)
    return `<div class="cf-code" data-language="${language}">`
      + `<div class="cf-code-head"><span class="cf-code-lang">${language || 'text'}</span>`
      + `<button type="button" data-copy-code aria-label=""></button></div>`
      + `<pre><code class="language-${language}">${escaped}</code></pre></div>`
  }

  return md
}

export function MarkdownBody({
  source,
  className,
  empty,
}: {
  source: string
  className?: string
  /** What to draw when the source is empty; omitted leaves the box empty rather than inventing a line. */
  empty?: string
}) {
  const container = useRef<HTMLDivElement>(null)
  const renderer = useMemo(createRenderer, [])
  const html = useMemo(() => {
    if (!source.trim()) return ''
    return DOMPurify.sanitize(renderer.render(source), {
      FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style', 'srcset'],
    })
  }, [renderer, source])

  useEffect(() => {
    const root = container.current
    if (!root) return
    let cancelled = false
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-copy-code]')) {
      button.textContent = t('common.copy')
      button.setAttribute('aria-label', t('common.copy'))
    }
    for (const image of root.querySelectorAll<HTMLImageElement>('img[src]')) {
      const src = image.getAttribute('src') ?? ''
      if (!/^https?:\/\//i.test(src)) continue
      image.setAttribute('src', `/api/cloudflare/store/image?url=${encodeURIComponent(src)}`)
    }
    const blocks = [...root.querySelectorAll<HTMLElement>('pre code[class*="language-"]')]
    for (const block of blocks) {
      const language = /language-([\w-]+)/.exec(block.className)?.[1] ?? ''
      if (!language) continue
      void highlightWithPrism(block.textContent ?? '', language)
        .then((result) => {
          if (!cancelled && result) block.innerHTML = result.html
        })
        .catch((error: unknown) => {
          console.warn('[inkstone] Markdown highlighting failed:', error)
        })
    }
    return () => { cancelled = true }
  }, [html])

  if (!html) {
    return empty ? <p className={cn('text-[length:var(--text-12)] text-[var(--text-tertiary)]', className)}>{empty}</p> : null
  }

  return (
    <div
      ref={container}
      className={cn('cf-markdown', className)}
      onClick={(event) => {
        const button = (event.target as HTMLElement).closest('[data-copy-code]')
        if (!button) return
        const code = button.closest('.cf-code')?.querySelector('code')
        if (!code) return
        void copyText(code.textContent ?? '').then((ok) => {
          if (!ok) return
          button.textContent = t('common.copied')
          window.setTimeout(() => { button.textContent = t('common.copy') }, 1_500)
        })
      }}
      // The string is the sanitised output of markdown-it and DOMPurify; no caller-supplied HTML
      // reaches this node.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
