import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Download, Loader2, Save } from 'lucide-react'
import type {
  HttpRequestConfig,
  RequestKind,
  ResponseResult,
  TestResult,
} from '@shared/development/api-tester/types'
import {
  FILE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  type FileKind,
} from '@shared/development/api-tester/limits'
import { Empty, LoadingBlock } from '../../../../components/feedback'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { CopyButton } from '../../../../components/copy-button'
import { Tabs } from '../../../../components/tabs'
import { t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { uploadFile, uploadText } from '../api'
import {
  base64ToBytes,
  formatSize,
} from '../lib/relay-client'
import { ResponseBody, readResponseBodyShape, type BodyMode } from './ResponseBody'
import { TimingView } from './TimingView'
import { TestResultsView } from './TestResultsView'
import { CodegenPanel } from './CodegenPanel'

type ResponseTab = 'body' | 'headers' | 'cookies' | 'timing' | 'code' | 'tests'

/**
 * Locale gap: the catalog has no `development.apitester.cookies` / `.timing` / `.code` keys yet, and
 * this task may not touch the locale files. These are protocol-level labels in the reference UI; when
 * the keys land, replace this table with `t()` and delete it.
 */
const TAB_LABEL_FALLBACK = {
  cookies: 'Cookies',
  timing: 'Timing',
  code: 'Code',
} as const

/** Cookie fields the reference shows without a catalog entry. */
const COOKIE_FIELD_FALLBACK = {
  domain: 'domain',
  path: 'path',
} as const

const BODY_MODE_KEY = {
  pretty: 'development.apitester.pretty',
  raw: 'development.apitester.raw',
  preview: 'development.apitester.preview',
} as const

function mediaTypeOf(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? ''
}

/** The server-side file kind the "save to server" action should ask for. */
function fileKindOf(contentType: string): FileKind {
  const mediaType = mediaTypeOf(contentType)
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) return 'json'
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType === 'text/html' || mediaType.endsWith('+html')) return 'html'
  if (mediaType.includes('csv')) return 'csv'
  if (mediaType.includes('xml') || mediaType.endsWith('+xml')) return 'xml'
  if (
    mediaType.startsWith('text/') ||
    mediaType === 'application/x-www-form-urlencoded' ||
    mediaType === 'application/graphql' ||
    mediaType === 'application/yaml'
  ) {
    return 'txt'
  }
  return 'bin'
}

function extensionOf(result: ResponseResult): string {
  const mediaType = mediaTypeOf(result.contentType)
  if (mediaType.startsWith('image/')) return IMAGE_EXTENSIONS[mediaType] ?? 'png'
  return FILE_EXTENSIONS[fileKindOf(result.contentType)]
}

function statusTone(status: number): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status >= 200 && status < 300) return 'success'
  if (status >= 300 && status < 400) return 'warning'
  if (status >= 400) return 'danger'
  return 'neutral'
}

export function ResponsePanel({
  result,
  loading,
  request,
  kind,
  testResults,
  autoPrettify,
}: {
  result: ResponseResult | null
  loading: boolean
  request: HttpRequestConfig | null
  kind: RequestKind
  testResults?: { results: TestResult[]; error?: string }
  autoPrettify: boolean
}): ReactNode {
  const [tab, setTab] = useState<ResponseTab>('body')
  const [bodyMode, setBodyMode] = useState<BodyMode>('pretty')
  const [saving, setSaving] = useState(false)
  const bodyShape = useMemo(() => readResponseBodyShape(result), [result])
  const lastResult = useRef<ResponseResult | null>(null)

  /**
   * `autoPrettify` is a default, not a lock: it picks the first view for each new response and then
   * leaves the user's Pretty/RAW/Preview choice alone. `lastResult` makes that reset depend on the
   * response identity rather than on every render or settings change.
   */
  useEffect(() => {
    if (!result) {
      lastResult.current = null
      setBodyMode('pretty')
      return
    }
    if (lastResult.current === result) return
    lastResult.current = result
    setBodyMode(autoPrettify && bodyShape.isJson ? 'pretty' : 'raw')
    setTab('body')
  }, [autoPrettify, bodyShape.isJson, result])

  const canDownload = Boolean(result && (result.body || result.bodyB64))
  const headerCount = result?.headers.length ?? 0
  const cookieCount = result?.cookies?.length ?? 0
  const passedCount = testResults?.results.filter((entry) => entry.passed).length ?? 0

  const tabs: Array<{ id: ResponseTab; label: string }> = [
    { id: 'body', label: t('development.apitester.body') },
    {
      id: 'headers',
      label: headerCount > 0
        ? `${t('development.apitester.headers')} (${headerCount})`
        : t('development.apitester.headers'),
    },
    {
      id: 'cookies',
      label: cookieCount > 0
        ? `${TAB_LABEL_FALLBACK.cookies} (${cookieCount})`
        : TAB_LABEL_FALLBACK.cookies,
    },
    { id: 'timing', label: TAB_LABEL_FALLBACK.timing },
    { id: 'code', label: TAB_LABEL_FALLBACK.code },
    ...(testResults
      ? [{
          id: 'tests' as const,
          label: testResults.results.length > 0
            ? `${t('development.apitester.tests')} (${passedCount}/${testResults.results.length})`
            : t('development.apitester.tests'),
        }]
      : []),
  ]

  function downloadBody() {
    if (!result || (!result.body && !result.bodyB64)) return
    const mime = result.contentType || (result.bodyB64 ? 'application/octet-stream' : 'text/plain')
    const blob = result.bodyB64
      ? new Blob([base64ToBytes(result.bodyB64)], { type: mime })
      : new Blob([result.body], { type: mime })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `response-${result.status}-${Date.now()}.${extensionOf(result)}`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  async function saveToServer() {
    if (!result || (!result.body && !result.bodyB64)) return
    setSaving(true)
    try {
      const name = `response-${result.status}-${Date.now()}.${extensionOf(result)}`
      if (result.bodyB64) {
        // The response body is binary. It goes up as a binary file, never as a text body.
        const bytes = base64ToBytes(result.bodyB64)
        const mime = result.contentType || 'application/octet-stream'
        await uploadFile(new Blob([bytes], { type: mime }), 'bin', name)
      } else {
        await uploadText(
          result.body,
          fileKindOf(result.contentType),
          name,
          result.contentType || 'text/plain',
        )
      }
      useUi.getState().toast({
        title: t('development.apitester.response.saved_to_server'),
        tone: 'success',
      })
    } catch (error) {
      console.warn('[inkstone] API Tester response save failed', error)
      useUi.getState().toast({
        title: t('development.apitester.save_failed'),
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <LoadingBlock label={t('development.apitester.waiting_response')} />
  }

  if (!result) {
    return (
      <Empty
        art="select"
        title={t('development.apitester.click_send_to_start')}
        description={t('development.apitester.response_will_show_here')}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="api-tester-response-panel">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border-subtle)] px-3 py-1.5">
        {result.error ? (
          <Badge tone="danger">{t('development.apitester.status_error')}</Badge>
        ) : (
          <Badge tone={statusTone(result.status)}>
            {result.status} {result.statusText}
          </Badge>
        )}
        <Badge tone="neutral">{result.durationMs} {t('development.apitester.ms')}</Badge>
        <Badge tone="neutral">{formatSize(result.sizeBytes)}</Badge>
        {result.redirected && <Badge tone="warning">{t('development.apitester.redirected')}</Badge>}
        <div className="flex-1" />
        <div className="flex min-w-0 items-center gap-0.5">
          <CopyButton text={result.body} disabled={!result.body} className="h-6 px-2" />
          <IconButton
            label={t('development.apitester.download_response_title')}
            size="xs"
            disabled={!canDownload}
            onClick={downloadBody}
          >
            <Download size={13} />
          </IconButton>
          <IconButton
            label={t('development.apitester.response.save_to_server')}
            size="xs"
            disabled={!canDownload || saving}
            aria-busy={saving || undefined}
            onClick={() => void saveToServer()}
          >
            {saving ? <Loader2 size={13} className="animate-[ink-spin_0.7s_linear_infinite]" /> : <Save size={13} />}
          </IconButton>
        </div>
        {result.error && (
          <span
            className="min-w-0 max-w-full truncate text-[length:var(--text-11)] text-[var(--danger)]"
            title={result.error}
          >
            {result.error}
          </span>
        )}
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        label={t('development.apitester.response')}
        items={tabs}
        panelId="response-panel"
        className="shrink-0 border-b border-[var(--border-subtle)] px-2 py-1"
      />

      <div
        role="tabpanel"
        id="response-panel"
        aria-labelledby={`response-panel-tab-${tab}`}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-hidden focus-visible:outline-none"
      >
        {tab === 'body' && (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border-subtle)] px-2 py-1">
              <div
                role="group"
                aria-label={t('development.apitester.body')}
                className="flex items-center gap-0.5"
              >
                {(Object.keys(BODY_MODE_KEY) as BodyMode[]).map((mode) => (
                  <Button
                    key={mode}
                    size="sm"
                    variant={bodyMode === mode ? 'secondary' : 'ghost'}
                    aria-pressed={bodyMode === mode}
                    className="h-6 px-2 text-[length:var(--text-11)]"
                    onClick={() => setBodyMode(mode)}
                  >
                    {t(BODY_MODE_KEY[mode])}
                  </Button>
                ))}
              </div>
              <div className="flex-1" />
              <span className="mr-1 hidden min-w-0 max-w-[45%] truncate text-[length:var(--text-10)] text-[var(--text-quaternary)] sm:inline">
                {result.contentType}
              </span>
            </div>
            <div className="min-h-0 flex-1">
              <ResponseBody result={result} mode={bodyMode} shape={bodyShape} />
            </div>
          </div>
        )}

        {tab === 'headers' && (
          <div className="h-full overflow-y-auto overscroll-contain p-2 font-mono text-[length:var(--text-11)]">
            {result.headers.length === 0 ? (
              <p className="text-[var(--text-tertiary)]">{t('development.apitester.no_headers')}</p>
            ) : (
              result.headers.map((header, index) => (
                <div
                  key={`${header.key}-${index}`}
                  className="flex gap-2 border-b border-[var(--border-subtle)] py-1"
                >
                  <span className="w-32 shrink-0 font-semibold text-[var(--text-tertiary)] sm:w-44">
                    {header.key}
                  </span>
                  <span className="min-w-0 break-all text-[var(--text-secondary)]">{header.value}</span>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'cookies' && (
          <div className="h-full overflow-y-auto overscroll-contain p-2 text-[length:var(--text-11)]">
            {cookieCount === 0 ? (
              <p className="text-[var(--text-tertiary)]">{t('development.apitester.no_cookies')}</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {result.cookies?.map((cookie, index) => (
                  <div
                    key={`${cookie.name}-${index}`}
                    className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2 font-mono"
                  >
                    <div className="break-all">
                      <span className="text-[var(--text-tertiary)]">
                        {t('development.apitester.key_name')}:
                      </span>{' '}
                      <span className="text-[var(--text-primary)]">{cookie.name}</span>
                    </div>
                    <div className="break-all">
                      <span className="text-[var(--text-tertiary)]">
                        {t('development.apitester.key_value')}:
                      </span>{' '}
                      <span className="text-[var(--text-primary)]">{cookie.value}</span>
                    </div>
                    {cookie.domain && (
                      <div className="break-all">
                        <span className="text-[var(--text-tertiary)]">
                          {COOKIE_FIELD_FALLBACK.domain}:
                        </span>{' '}
                        <span className="text-[var(--text-secondary)]">{cookie.domain}</span>
                      </div>
                    )}
                    {cookie.path && (
                      <div className="break-all">
                        <span className="text-[var(--text-tertiary)]">
                          {COOKIE_FIELD_FALLBACK.path}:
                        </span>{' '}
                        <span className="text-[var(--text-secondary)]">{cookie.path}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'timing' && (
          <div className="h-full overflow-y-auto overscroll-contain">
            <TimingView timing={result.timing} totalMs={result.durationMs} />
          </div>
        )}

        {tab === 'code' && <CodegenPanel request={request} kind={kind} />}

        {tab === 'tests' && testResults && (
          <TestResultsView results={testResults.results} error={testResults.error} />
        )}
      </div>
    </div>
  )
}
