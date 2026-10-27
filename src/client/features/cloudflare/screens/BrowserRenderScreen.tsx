/**
 * Render a page through Cloudflare's browser and show what came back.
 *
 * Each mode has its own way of being useful: a screenshot is an image, PDF is a download, HTML is a
 * sandboxed preview beside its source, Markdown is rendered prose, and links are a table. The usage
 * card is read from the same quota endpoint the dashboard uses, so the number beside the button is the
 * one Cloudflare bills.
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import type { CloudflareAccount, CloudflareQuotaResponse } from '@shared/cloudflare/model'
import { Button } from '../../../components/primitives'
import { Field, Input, Segmented } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { UsageRing } from '../components/UsageRing'
import { MarkdownBody } from '../components/MarkdownBody'
import { SearchField } from '../components/SearchField'
import { useCfT } from '../i18n'
import { useUi } from '../../../store/ui'
import { cfErrorText } from '../api/client'
import {
  browserRenderApi,
  RENDER_BROWSERS,
  RENDER_MODES,
  renderModeLabelKey,
  type RenderBrowser,
  type RenderMode,
  type RenderResult,
} from '../api/browser-render'
import { downloadDataUrl } from '../lib/download'
import { splitSeconds } from '../lib/format'

function durationText(t: ReturnType<typeof useCfT>, seconds: number): string {
  if (seconds < 60) return t('cloudflare.browser_render.format_seconds', { s: Math.round(seconds) })
  const { m, s } = splitSeconds(seconds)
  return t('cloudflare.browser_render.format_minutes', { m, s })
}

function linkRows(links: unknown): Array<{ href: string; text: string }> {
  if (!Array.isArray(links)) return []
  const rows: Array<{ href: string; text: string }> = []
  for (const entry of links) {
    if (typeof entry === 'string') rows.push({ href: entry, text: entry })
    else if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>
      const href = typeof record.url === 'string' ? record.url : typeof record.href === 'string' ? record.href : ''
      const text = typeof record.text === 'string' ? record.text : href
      if (href) rows.push({ href, text })
    }
  }
  return rows
}

export function BrowserRenderScreen() {
  const t = useCfT()
  const toast = useUi((state) => state.toast)

  const [url, setUrl] = useState('')
  const [mode, setMode] = useState<RenderMode>('screenshot')
  const [browser, setBrowser] = useState<RenderBrowser>('chrome')
  const [accountId, setAccountId] = useState('')
  const [accounts, setAccounts] = useState<CloudflareAccount[]>([])
  const [quota, setQuota] = useState<CloudflareQuotaResponse | null>(null)
  const [result, setResult] = useState<RenderResult | null>(null)
  const [markdownSource, setMarkdownSource] = useState(false)
  const [htmlSource, setHtmlSource] = useState(false)
  const [filter, setFilter] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  async function refreshUsage(): Promise<void> {
    const [accountPage, quotaPage] = await Promise.all([browserRenderApi.accounts(), browserRenderApi.quota()])
    setAccounts(accountPage.accounts)
    setQuota(quotaPage)
  }

  useEffect(() => {
    void refreshUsage().catch((failure: unknown) => setError(cfErrorText(failure)))
  }, [])

  const usage = useMemo(() => {
    let used = 0
    let limit = 0
    for (const account of quota?.accounts ?? []) {
      for (const resource of account.resources) {
        if (resource.resource !== 'browser_render_seconds') continue
        used += resource.count
        limit += resource.limit
      }
    }
    return { used, limit }
  }, [quota])

  const htmlPreview = useMemo(() => {
    if (!result?.html) return ''
    return URL.createObjectURL(new Blob([result.html], { type: 'text/html' }))
  }, [result])

  useEffect(() => () => {
    if (htmlPreview) URL.revokeObjectURL(htmlPreview)
  }, [htmlPreview])

  async function startRender(): Promise<void> {
    if (!url.trim() || running) return
    setRunning(true)
    setError('')
    setResult(null)
    try {
      const next = await browserRenderApi.render({
        url: url.trim(),
        mode,
        browser,
        ...(accountId ? { accountId } : {}),
      })
      setResult(next)
      toast({ title: t('cloudflare.browser_render.render_complete', { time: next.duration.toFixed(1) }), tone: 'success' })
      void refreshUsage().catch(() => undefined)
    } catch (failure) {
      setError(cfErrorText(failure))
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setRunning(false)
    }
  }

  const filteredLinks = useMemo(() => {
    const rows = linkRows(result?.links)
    const needle = filter.trim().toLowerCase()
    return needle ? rows.filter((row) => row.href.toLowerCase().includes(needle) || row.text.toLowerCase().includes(needle)) : rows
  }, [result, filter])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[length:var(--text-17)] font-semibold text-[var(--text-primary)]">
            {t('cloudflare.browser_render.title')}
          </h1>
          <div className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-1.5">
            <UsageRing used={usage.used} limit={usage.limit || 1} label={t('cloudflare.browser_render.usage_rate')} />
            <div className="text-[length:var(--text-11-5)] leading-tight text-[var(--text-tertiary)]">
              <div>{t('cloudflare.browser_render.used_total')}</div>
              <div className="tabular-nums text-[var(--text-primary)]">
                {durationText(t, usage.used)} / {durationText(t, usage.limit)}
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-3 md:p-4">
          <Field label={t('cloudflare.browser_render.enter_url')} hint={t('cloudflare.browser_render.input_hint')}>
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void startRender() }}
              placeholder="https://example.com"
              inputMode="url"
              autoComplete="off"
            />
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <Segmented
              label={t('cloudflare.browser_render.title')}
              value={mode}
              onChange={setMode}
              options={RENDER_MODES.map((value) => ({ value, label: t(renderModeLabelKey(value)) }))}
            />
            <div className="flex min-w-40 flex-col gap-1">
              <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('cloudflare.browser_render.engine')}</span>
              <SelectMenu
                label={t('cloudflare.browser_render.engine')}
                value={browser}
                onChange={setBrowser}
                options={RENDER_BROWSERS.map((value) => ({ value, label: value }))}
                size="sm"
              />
            </div>
            <div className="flex min-w-44 flex-col gap-1">
              <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('cloudflare.browser_render.account')}</span>
              <SelectMenu
                label={t('cloudflare.browser_render.account')}
                value={accountId}
                onChange={setAccountId}
                options={[
                  { value: '', label: t('cloudflare.browser_render.auto_assign') },
                  ...accounts.map((account) => ({ value: account.id, label: account.name })),
                ]}
                size="sm"
              />
            </div>
            <Button variant="primary" onClick={() => void startRender()} loading={running} icon={running ? <Loader2 size={14} /> : <Play size={14} />}>
              {t('cloudflare.browser_render.start_render')}
            </Button>
          </div>
          {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
        </div>

        {result && (
          <div className="flex flex-col gap-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-3 md:p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              <span>{t('cloudflare.browser_render.browser_time', { time: durationText(t, result.duration) })}</span>
              <div className="flex gap-2">
                {result.screenshot && (
                  <Button size="sm" variant="secondary" onClick={() => downloadDataUrl(result.screenshot!, `screenshot-${Date.now()}.png`)}>
                    {t('cloudflare.browser_render.download')}
                  </Button>
                )}
                {result.pdf && (
                  <Button size="sm" variant="secondary" onClick={() => downloadDataUrl(result.pdf!, `page-${Date.now()}.pdf`)}>
                    {t('cloudflare.browser_render.download_pdf')}
                  </Button>
                )}
              </div>
            </div>
            {result.screenshot && (
              <img src={result.screenshot} alt={t('cloudflare.browser_render.screenshot')} className="max-w-full rounded-[var(--r-md)] border border-[var(--border-subtle)]" />
            )}
            {result.html && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Segmented
                    label={t('cloudflare.browser_render.html_render')}
                    value={htmlSource ? 'source' : 'preview'}
                    onChange={(value) => setHtmlSource(value === 'source')}
                    options={[
                      { value: 'preview', label: t('cloudflare.browser_render.preview_mode') },
                      { value: 'source', label: t('cloudflare.browser_render.source_mode') },
                    ]}
                    size="sm"
                  />
                </div>
                {htmlSource
                  ? <pre className="max-h-96 overflow-auto rounded-[var(--r-md)] bg-[var(--bg-inset)] p-3 text-[length:var(--text-12)]">{result.html}</pre>
                  : <iframe title={t('cloudflare.browser_render.html_render')} sandbox="" src={htmlPreview} className="h-96 w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-white" />}
              </div>
            )}
            {result.markdown && (
              <div className="flex flex-col gap-2">
                <Segmented
                  label={t('cloudflare.browser_render.markdown')}
                  value={markdownSource ? 'source' : 'preview'}
                  onChange={(value) => setMarkdownSource(value === 'source')}
                  options={[
                    { value: 'preview', label: t('cloudflare.browser_render.preview_mode') },
                    { value: 'source', label: t('cloudflare.browser_render.source_mode') },
                  ]}
                  size="sm"
                />
                {markdownSource
                  ? <pre className="max-h-96 overflow-auto rounded-[var(--r-md)] bg-[var(--bg-inset)] p-3 text-[length:var(--text-12)]">{result.markdown}</pre>
                  : <MarkdownBody source={result.markdown} className="max-h-96 overflow-auto" />}
              </div>
            )}
            {result.links !== undefined && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-[length:var(--text-14)] font-medium text-[var(--text-primary)]">{t('cloudflare.browser_render.extracted_links')}</h2>
                  <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                    {t('cloudflare.browser_render.total_links', { count: filteredLinks.length })}
                  </span>
                </div>
                <SearchField
                  value={filter}
                  onChange={setFilter}
                  label={t('cloudflare.browser_render.extracted_links')}
                  placeholder={t('cloudflare.browser_render.extracted_links')}
                  className="max-w-sm"
                />
                <div className="max-h-96 overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]">
                  <table className="w-full border-collapse text-left text-[length:var(--text-12)]">
                    <tbody>
                      {filteredLinks.map((row) => (
                        <tr key={row.href} className="border-b border-[var(--border-subtle)] last:border-b-0">
                          <td className="max-w-40 truncate px-2 py-1.5 text-[var(--text-secondary)]">{row.text}</td>
                          <td className="px-2 py-1.5">
                            <a href={row.href} target="_blank" rel="noopener noreferrer" className="break-all text-[var(--accent)] underline">{row.href}</a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {!result && !running && !error && (
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('cloudflare.browser_render.input_hint')}</p>
        )}
      </div>
    </div>
  )
}
