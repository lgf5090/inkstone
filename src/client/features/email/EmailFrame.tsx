import { useEffect, useMemo, useRef, useState } from 'react'
import type { EmailAttachment } from '@shared/email/model'
import { textToEmailHtml } from '@shared/email/format'
import { t } from '../../lib/i18n'
import { useThemeDark } from '../../lib/hooks'
import { useSession } from '../../store/session'
import { sanitizeEmailHtml } from './email-markdown'
import { rewriteEmailCidSources } from './format'

const MIN_HEIGHT = 96
const MAX_HEIGHT = 20_000
const HTML_TAG = /<[a-z][\s\S]*>/i

export interface EmailReadingTheme {
  dark: boolean
  background: string
  text: string
  secondary: string
  tertiary: string
  border: string
  accent: string
  inset: string
  font: string
  mono: string
  width: string
  size: string
  line: string
}

const LIGHT_FALLBACK = {
  background: '#ffffff',
  text: '#1f2328',
  secondary: '#57606a',
  tertiary: '#6e7781',
  border: '#d8dee4',
  accent: '#0b6bcb',
  inset: '#f6f8fa',
}

const DARK_FALLBACK = {
  background: '#1b1d1f',
  text: '#e6e6e3',
  secondary: '#b7bcc2',
  tertiary: '#8d949c',
  border: '#33383d',
  accent: '#7aa2f7',
  inset: '#232629',
}

function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback
}

export function readingTheme(dark: boolean): EmailReadingTheme {
  const fallback = dark ? DARK_FALLBACK : LIGHT_FALLBACK
  if (typeof window === 'undefined') {
    return {
      dark,
      ...fallback,
      font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      width: '72ch',
      size: '16px',
      line: '1.65',
    }
  }
  const style = getComputedStyle(document.documentElement)
  return {
    dark,
    background: token(style, '--bg-surface', fallback.background),
    text: token(style, '--text-primary', fallback.text),
    secondary: token(style, '--text-secondary', fallback.secondary),
    tertiary: token(style, '--text-tertiary', fallback.tertiary),
    border: token(style, '--border-subtle', fallback.border),
    accent: token(style, '--accent', fallback.accent),
    inset: token(style, '--bg-inset', fallback.inset),
    font: token(style, '--font-ui', 'system-ui, -apple-system, "Segoe UI", sans-serif'),
    mono: token(style, '--font-mono', 'ui-monospace, SFMono-Regular, Menlo, monospace'),
    width: token(style, '--prose-width', '72ch'),
    size: token(style, '--prose-size', '16px'),
    line: token(style, '--prose-line', '1.65'),
  }
}

function readingStyle(theme: EmailReadingTheme): string {
  return [
    `:root{color-scheme:${theme.dark ? 'dark' : 'light'}}`,
    `html,body{margin:0;padding:0;background:${theme.background};color:${theme.text}}`,
    `body{font-family:${theme.font};font-size:${theme.size};line-height:${theme.line};overflow-wrap:anywhere}`,
    `.email-reading{box-sizing:border-box;max-width:${theme.width};margin:0 auto;padding:16px 20px 24px;overflow-x:auto}`,
    '.email-reading>:first-child{margin-top:0}',
    '.email-reading>:last-child{margin-bottom:0}',
    '.email-reading p{margin:0 0 0.72em;text-wrap:pretty}',
    '.email-reading h1,.email-reading h2,.email-reading h3,.email-reading h4,.email-reading h5,.email-reading h6{margin:1.45em 0 0.44em;font-weight:600;line-height:1.3;color:inherit}',
    '.email-reading h1{font-size:1.65em}.email-reading h2{font-size:1.4em}.email-reading h3{font-size:1.2em}',
    '.email-reading h4,.email-reading h5,.email-reading h6{font-size:1em}',
    '.email-reading ul,.email-reading ol{margin:0 0 0.72em;padding-left:1.5em}',
    '.email-reading li+li{margin-top:0.18em}',
    `.email-reading blockquote{margin:1em 0;padding-left:1em;border-left:3px solid ${theme.border};color:${theme.secondary}}`,
    `.email-reading a{color:${theme.accent};text-decoration:underline;text-underline-offset:2px}`,
    `.email-reading code{font-family:${theme.mono};font-size:0.9em;background:${theme.inset};padding:0.12em 0.32em;border-radius:4px}`,
    `.email-reading pre{margin:1em 0;padding:12px;background:${theme.inset};border:1px solid ${theme.border};border-radius:8px;white-space:pre-wrap;overflow-x:auto}`,
    '.email-reading pre code{background:none;padding:0}',
    '.email-reading table{max-width:100%;border-collapse:collapse;margin:1em 0;font-size:0.92em}',
    `.email-reading th,.email-reading td{border:1px solid ${theme.border};padding:6px 8px;text-align:left;vertical-align:top}`,
    `.email-reading hr{margin:1.5em 0;border:0;border-top:1px solid ${theme.border}}`,
    '.email-reading img{max-width:100%;height:auto;border-radius:4px}',
    `.email-reading mark{background:${theme.inset};color:inherit}`,
  ].join('')
}

export function buildEmailDocument(body: string, attachments: readonly EmailAttachment[], subject: string, theme: EmailReadingTheme): string {
  const source = HTML_TAG.test(body) ? body : textToEmailHtml(body)
  const content = sanitizeEmailHtml(rewriteEmailCidSources(source, attachments)) || `<p>${t('email.detail.empty_body')}</p>`
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'; script-src 'none'; font-src data:; media-src * data: blob:">`,
    `<title>${escapeHtml(subject)}</title>`,
    `<style>${readingStyle(theme)}</style>`,
    `</head><body><div class="email-reading">${content}</div></body></html>`,
  ].join('')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function EmailFrame({ body, attachments, subject }: {
  body: string
  attachments: readonly EmailAttachment[]
  subject: string
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(MIN_HEIGHT)
  const dark = useThemeDark()
  const appearance = useSession((state) => state.settings.appearance)
  const document = useMemo(
    () => buildEmailDocument(body, attachments, subject, readingTheme(dark)),
    [attachments, body, dark, subject, appearance.proseFont, appearance.proseLineHeight, appearance.proseSize, appearance.proseWidth],
  )

  useEffect(() => {
    setHeight(MIN_HEIGHT)
  }, [document])

  useEffect(() => {
    const iframe = frame.current
    if (!iframe) return
    let observer: ResizeObserver | null = null
    let timers: number[] = []
    let contentWindow: Window | null = null
    const measure = (): void => {
      const doc = iframe.contentDocument
      if (!doc) return
      const next = Math.max(
        doc.documentElement.scrollHeight,
        doc.body?.scrollHeight ?? 0,
        doc.body?.offsetHeight ?? 0,
      )
      if (!Number.isFinite(next)) return
      setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(next))))
    }
    const attach = (): void => {
      measure()
      for (const timer of timers) window.clearTimeout(timer)
      timers = [250, 1000, 2500].map((delay) => window.setTimeout(measure, delay))
      contentWindow?.removeEventListener('load', measure, true)
      contentWindow = iframe.contentWindow
      contentWindow?.addEventListener('load', measure, true)
      const doc = iframe.contentDocument
      if (!doc || typeof ResizeObserver !== 'function') return
      observer?.disconnect()
      observer = new ResizeObserver(measure)
      if (doc.body) observer.observe(doc.body)
      observer.observe(doc.documentElement)
      for (const image of doc.images) image.addEventListener('load', measure)
    }
    iframe.addEventListener('load', attach)
    attach()
    window.addEventListener('resize', measure)
    return () => {
      iframe.removeEventListener('load', attach)
      window.removeEventListener('resize', measure)
      contentWindow?.removeEventListener('load', measure, true)
      for (const timer of timers) window.clearTimeout(timer)
      observer?.disconnect()
    }
  }, [document])

  return (
    <iframe
      ref={frame}
      title={t('email.a11y.message_body', { subject })}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={document}
      className="email-frame email-frame-auto"
      style={{ height }}
    />
  )
}
