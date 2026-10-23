import { useEffect, useMemo, useRef, useState } from 'react'
import type { EmailAttachment } from '@shared/email/model'
import { textToEmailHtml } from '@shared/email/format'
import { t } from '../../lib/i18n'
import { sanitizeEmailHtml } from './email-markdown'
import { rewriteEmailCidSources } from './format'

const MIN_HEIGHT = 96
const MAX_HEIGHT = 20_000
const HTML_TAG = /<[a-z][\s\S]*>/i

const BASE_STYLE = [
  ':root{color-scheme:light}',
  'html,body{margin:0;padding:0;background:#fff;color:#1f2328}',
  'body{font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;padding:12px;overflow-wrap:anywhere}',
  'img{max-width:100%;height:auto}',
  'table{max-width:100%;border-collapse:collapse}',
  'pre{white-space:pre-wrap}',
  'a{color:#0b6bcb}',
  'blockquote{margin:0 0 0 0.8em;padding-left:0.8em;border-left:2px solid #d0d7de;color:#57606a}',
].join('')

const HEIGHT_SCRIPT = `<script>(function(){function send(){parent.postMessage({type:'inkstone-email-height',height:document.documentElement.scrollHeight},'*')}window.addEventListener('load',send);if(typeof ResizeObserver==='function'){new ResizeObserver(send).observe(document.body)}setTimeout(send,60)})()</script>`

function buildDocument(body: string, attachments: readonly EmailAttachment[], subject: string): string {
  const source = HTML_TAG.test(body) ? body : textToEmailHtml(body)
  const content = sanitizeEmailHtml(rewriteEmailCidSources(source, attachments)) || `<p>${t('email.detail.empty_body')}</p>`
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src * data: blob:">`,
    `<title>${escapeHtml(subject)}</title>`,
    `<style>${BASE_STYLE}</style>`,
    `</head><body>${content}</body>${HEIGHT_SCRIPT}</html>`,
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
  const document = useMemo(() => buildDocument(body, attachments, subject), [body, attachments, subject])

  useEffect(() => {
    setHeight(MIN_HEIGHT)
  }, [document])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const data = event.data as { type?: unknown; height?: unknown } | null
      if (!data || data.type !== 'inkstone-email-height') return
      const next = Number(data.height)
      if (!Number.isFinite(next)) return
      setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(next))))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <iframe
      ref={frame}
      title={t('email.a11y.message_body', { subject })}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={document}
      className="email-frame email-frame-auto"
      style={{ height }}
    />
  )
}
