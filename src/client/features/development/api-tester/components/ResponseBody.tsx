import { JsonTree } from '../../../../components/json-tree'
import { t } from '../../../../lib/i18n'
import type { ResponseResult } from '@shared/development/api-tester/types'
import { tryParseJson } from '../lib/relay-client'
import { CodeBlock } from './CodeBlock'
import { RawViewer } from './RawViewer'

export type BodyMode = 'pretty' | 'raw' | 'preview'

export interface ResponseBodyShape {
  isJson: boolean
  isXml: boolean
  isHtml: boolean
  isImage: boolean
  json: unknown
}

/**
 * The response body's own CSP, injected at the front of `srcdoc`. `sandbox=""` already gives the
 * document an opaque origin; this stops it from loading scripts, network resources or fonts even if a
 * future browser relaxes the sandbox default. Inline styles and data/blob images are allowed so a
 * self-contained HTML report still renders.
 */
const PREVIEW_CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'">`

export function previewDocument(html: string): string {
  return `${PREVIEW_CSP}${html}`
}

export function readResponseBodyShape(result: ResponseResult | null): ResponseBodyShape {
  if (!result) return { isJson: false, isXml: false, isHtml: false, isImage: false, json: null }
  const mediaType = result.contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  const isImage = mediaType.startsWith('image/')
  const isHtml = mediaType === 'text/html' || mediaType === 'application/xhtml+xml' || mediaType.endsWith('+html')
  const isXml = !isHtml && (mediaType.includes('xml') || mediaType.endsWith('+xml'))
  const looksJson =
    mediaType === 'application/json' ||
    mediaType.endsWith('+json') ||
    /^\s*[{[]/.test(result.body)
  const json = looksJson ? tryParseJson(result.body) : null
  return {
    isJson: looksJson && json !== null,
    isXml,
    isHtml,
    isImage,
    json,
  }
}

export function ResponseBody({
  result,
  mode,
  shape,
}: {
  result: ResponseResult
  mode: BodyMode
  shape: ResponseBodyShape
}) {
  if (mode === 'raw') {
    const raw = result.body || (result.bodyB64 ? t('development.apitester.binary_data') : '')
    return (
      <div className="h-full min-h-0" data-slot="api-tester-response-body" data-mode="raw">
        <RawViewer text={raw} />
      </div>
    )
  }

  if (mode === 'preview') {
    return (
      <div
        className="h-full min-h-0 overflow-y-auto overscroll-contain p-2"
        data-slot="api-tester-response-body"
        data-mode="preview"
      >
        {shape.isImage ? (
          result.bodyB64 ? (
            <img
              src={`data:${result.contentType};base64,${result.bodyB64}`}
              alt={t('development.apitester.preview')}
              className="max-w-full rounded-[var(--r-md)]"
            />
          ) : (
            // The relay refused to buffer it (over the size cap), so there is nothing to show and
            // loading `result.url` here would fetch straight from the target, outside the relay.
            <div className="flex h-full items-center justify-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('development.apitester.preview_unsupported')}
            </div>
          )
        ) : shape.isHtml ? (
          <iframe
            title={t('development.apitester.preview')}
            className="h-full min-h-[240px] w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-white"
            srcDoc={previewDocument(result.body)}
            sandbox=""
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('development.apitester.preview_unsupported')}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="h-full min-h-0" data-slot="api-tester-response-body" data-mode="pretty">
      {shape.isJson ? (
        <JsonTree
          data={shape.json}
          searchable
          defaultExpandedDepth={1}
          className="h-full"
        />
      ) : shape.isXml || shape.isHtml ? (
        <CodeBlock
          code={result.body}
          lang={shape.isHtml ? 'html' : 'xml'}
          fill
          className="h-full rounded-none border-0 bg-transparent"
        />
      ) : (
        <pre className="h-full overflow-auto overscroll-contain p-3 font-mono text-[length:var(--text-12)] whitespace-pre-wrap break-all text-[var(--text-secondary)]">
          {result.body || t('development.apitester.empty_body')}
        </pre>
      )}
    </div>
  )
}
