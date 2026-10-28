import { useEffect, useState } from 'react'
import { CopyButton } from '../../../../components/copy-button'
import { cn } from '../../../../lib/cn'
import { highlightWithPrism } from '../../../../lib/markdown/prism'

/**
 * Codegen language ids are product names (`python-requests`, `javascript-fetch`); Prism knows the
 * language underneath them. Anything not listed here is already a Prism alias, and `plaintext` is
 * deliberately absent so it never waits on a grammar load.
 */
const PRISM_LANGUAGE: Record<string, string> = {
  curl: 'bash',
  httpie: 'bash',
  wget: 'bash',
  'javascript-fetch': 'javascript',
  'javascript-axios': 'javascript',
  'node-http': 'javascript',
  'python-requests': 'python',
  'python-httpx': 'python',
  'go-nethttp': 'go',
  'java-okhttp': 'java',
  'java-httpclient': 'java',
  'php-curl': 'php',
  'php-guzzle': 'php',
  'ruby-nethttp': 'ruby',
  'rust-reqwest': 'rust',
  'csharp-httpclient': 'csharp',
  'swift-urlsession': 'swift',
  'kotlin-okhttp': 'kotlin',
  'dart-http': 'dart',
  'clojure-cljhttp': 'clojure',
  xml: 'markup',
  html: 'markup',
  text: 'plaintext',
  plaintext: 'plaintext',
}

function escapeHtml(source: string): string {
  return source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function CodeBlock({
  code,
  lang = 'plaintext',
  label,
  maxHeightClass = 'max-h-[420px]',
  fill = false,
  className,
}: {
  code: string
  lang?: string
  label?: string
  maxHeightClass?: string
  /** Fill the parent height instead of capping the scroll area (response body panes). */
  fill?: boolean
  className?: string
}) {
  const [html, setHtml] = useState(() => escapeHtml(code))

  useEffect(() => {
    let cancelled = false
    // Show the escaped source immediately, then replace it once the grammar arrives. The fallback is
    // already HTML-escaped, so nothing from the response can become markup while highlighting loads.
    setHtml(escapeHtml(code))
    const language = PRISM_LANGUAGE[lang] ?? lang
    if (!language || language === 'plaintext') return () => {
      cancelled = true
    }
    void highlightWithPrism(code, language)
      .then((highlighted) => {
        if (!cancelled && highlighted) setHtml(highlighted.html)
      })
      .catch((error) => {
        console.warn('[inkstone] API Tester code highlight failed', error)
      })
    return () => {
      cancelled = true
    }
  }, [code, lang])

  return (
    <div
      data-slot="api-tester-code-block"
      className={cn(
        'overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]',
        fill && 'flex h-full min-h-0 flex-col',
        className,
      )}
    >
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] px-2">
        {label && (
          <span className="truncate text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">
            {label}
          </span>
        )}
        <div className="flex-1" />
        <CopyButton text={code} disabled={!code} className="h-6 px-2 text-[length:var(--text-11)]" />
      </div>
      <div
        className={cn(
          'overscroll-contain overflow-y-auto',
          fill ? 'min-h-0 flex-1' : maxHeightClass,
        )}
      >
        <pre className="overflow-x-auto p-3 font-mono text-[length:var(--text-12)] leading-relaxed">
          {/*
            The only HTML injected here comes from Prism (which escapes every token) or from
            `escapeHtml` above. Raw response/request text never reaches this node.
          */}
          <code className={`hljs language-${lang}`} dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
    </div>
  )
}
