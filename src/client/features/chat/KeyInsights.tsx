/**
 * What one slice of the ring has been doing, and the attempts behind the numbers.
 *
 * Three scopes with one shape: a key, its provider, or the whole account. The scope is a row of buttons
 * rather than a menu because the question a reader has is always "and how does that compare" — the numbers
 * are only useful beside the next level up.
 *
 * The logs are the detail the rollups cannot give: which attempt, which model, how long, and why it
 * failed. A prompt body is shown only when the reader turned body logging on; the column is null
 * otherwise, so the panel has nothing to hide.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, Clock, Coins, Download, FileText, Hash, Trash2, XCircle } from 'lucide-react'
import type { AssistantKeyStats, AssistantProvider, AssistantRequestLog, AssistantStatsScope } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Segmented, Switch } from '../../components/form'
import { useAssistant } from './assistant-store'
import { Modal, confirm } from '../../components/overlay'
import { cn } from '../../lib/cn'
import { useUi } from '../../store/ui'
import { csvCell, csvParts, downloadParts, fetchAllLogs, jsonParts } from './request-log-shared'
import { EXPORT_DONE, EXPORT_PARTIAL, INSIGHT_SCOPE, INSIGHT_TABS } from './request-log-keys'
import { LoadFailure } from './assistant-settings-shared'

/** A number with thousands separators; the panel is about magnitudes, not exact digits. */
const count = (value: number): string => value.toLocaleString()

const LOG_WINDOWS = [
  { ms: 3_600_000, key: 'assistant.insights.since_1h' },
  { ms: 86_400_000, key: 'assistant.insights.since_24h' },
  { ms: 604_800_000, key: 'assistant.insights.since_7d' },
  { ms: 2_592_000_000, key: 'assistant.insights.since_30d' },
  { ms: null, key: 'assistant.insights.since_all' },
] as const

const CSV_HEADER = 'at,provider,model,key_hint,ok,http_status,error_kind,input_tokens,output_tokens,cached,latency_ms'

/** Pre-rendered CSV rows; csvParts joins them into bounded Blob fragments at download time. */
function csvRows(logs: AssistantRequestLog[]): string[] {
  return logs.map((entry) => [
    new Date(entry.at).toISOString(),
    entry.providerLabel || entry.providerId,
    entry.modelLabel || entry.operation,
    entry.keyHint,
    String(entry.ok),
    entry.httpStatus,
    entry.errorKind,
    entry.inputTokens,
    entry.outputTokens,
    entry.cachedInputTokens,
    entry.latencyMs,
  ].map(csvCell).join(','))
}

/** Tokens in the reader's own units: 43,397 is fine, 4,330,000 is not. */
function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function when(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** One figure with its label, sized so four of them fit on a phone. */
function Stat({ icon, label, value, tone }: { icon: React.ReactNode, label: string, value: string, tone?: 'ok' | 'bad' | 'muted' }) {
  return (
    <div className={cn(
      'flex min-w-0 flex-col gap-0.5 rounded-[var(--r-md)] border-y border-r border-l-[3px] px-2.5 py-2',
      tone === 'ok'
        ? 'border-l-[var(--success)] border-y-[var(--border-subtle)] border-r-[var(--border-subtle)]'
        : tone === 'bad'
          ? 'border-l-[var(--danger)] border-y-[color-mix(in_oklab,var(--danger)_30%,transparent)] border-r-[color-mix(in_oklab,var(--danger)_30%,transparent)] bg-[color-mix(in_oklab,var(--danger)_6%,transparent)]'
          : 'border-l-[var(--border-strong)] border-y-[var(--border-subtle)] border-r-[var(--border-subtle)]',
    )}>
      <span className={cn('flex items-center gap-1 text-[length:var(--text-10-5)]',
        tone === 'ok' ? 'text-[var(--text-tertiary)]' : tone === 'bad' ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]',
      )}
      >
        {icon}
        {label}
      </span>
      <span className={cn('truncate tabular text-[length:var(--text-16)] font-semibold',
        tone === 'bad' ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]',
      )}
      >
        {value}
      </span>
    </div>
  )
}

export function KeyInsights({ open, onClose, provider, keyId, keyLabel, keyHint }: {
  open: boolean
  onClose: () => void
  provider: AssistantProvider
  /** Absent for the provider-wide entry: the panel then opens on the provider scope. */
  keyId?: string
  keyLabel?: string
  keyHint?: string
}) {
  const toast = useUi((state) => state.toast)
  const logBodies = useAssistant((state) => state.settings?.logRequestBodies ?? false)
  const saveSettings = useAssistant((state) => state.saveSettings)
  const [tab, setTab] = useState<'stats' | 'logs'>('stats')
  const [scope, setScope] = useState<AssistantStatsScope>(keyId === undefined ? 'provider' : 'key')
  const [rows, setRows] = useState<AssistantKeyStats[] | null>(null)
  const [logs, setLogs] = useState<AssistantRequestLog[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  /** Each read owns a sequence: a fast scope or tab switch must not let the older answer paint. */
  const statsId = useRef(0)
  const logsId = useRef(0)
  const effectId = useRef(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [sinceMs, setSinceMs] = useState<number | null>(null)

  const logScope = useCallback(() => ({
    ...(scope === 'key' ? { providerId: provider.id, keyId } : {}),
    ...(scope === 'provider' ? { providerId: provider.id } : {}),
  }), [scope, provider.id, keyId])

  const loadStats = useCallback(async () => {
    const id = ++statsId.current
    const answer = await api.assistant.keyStats({
      scope,
      ...(scope === 'key' ? { providerId: provider.id, keyId } : {}),
      ...(scope === 'provider' ? { providerId: provider.id } : {}),
    })
    if (id !== statsId.current) return
    setRows(answer.rows)
  }, [scope, provider.id, keyId])

  const loadLogs = useCallback(async () => {
    const id = ++logsId.current
    const answer = await api.assistant.requestLogs({
      ...logScope(),
      ...(sinceMs !== null ? { sinceMs } : {}),
      limit: 50,
    })
    if (id !== logsId.current) return
    setLogs(answer.logs)
  }, [logScope, sinceMs])

  const exportLogs = async (format: 'json' | 'csv') => {
    try {
      const { logs, total, truncated } = await fetchAllLogs({
        ...logScope(),
        ...(sinceMs !== null ? { sinceMs } : {}),
      })
      // includeBody=false semantics for both formats: whole rows in JSON, but never the prompt body, so a
      // reader's conversation is not quietly added to a downloaded file.
      const safe = logs.map((entry) => ({ ...entry, requestBody: null }))
      const parts = format === 'json' ? jsonParts(safe) : csvParts(CSV_HEADER, csvRows(logs))
      downloadParts(
        parts,
        format === 'json' ? 'application/json' : 'text/csv;charset=utf-8',
        `key-logs${truncated ? '-partial' : ''}.${format}`,
      )
      toast({
        title: truncated
          ? t(EXPORT_PARTIAL, { count: logs.length, total })
          : t(EXPORT_DONE, { count: logs.length }),
        tone: truncated ? 'warning' : 'default',
      })
    } catch (error) {
      toast({
        title: t('assistant.insights.export_failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    }
  }

  useEffect(() => {
    if (!open) return
    const id = ++effectId.current
    setBusy(true)
    setFailure(null)
    const work = tab === 'stats' ? loadStats() : loadLogs()
    void work
      .catch((error: unknown) => {
        if (id !== effectId.current) return
        const message = error instanceof Error ? error.message : String(error)
        // A failed read keeps its own surface. Without this the log tab would spin forever and the
        // statistics tab would show nothing at all, which reads as "no data" rather than "no answer".
        setFailure(message)
        toast({ title: message, tone: 'danger' })
      })
      .finally(() => { if (id === effectId.current) setBusy(false) })
  }, [open, tab, scope, loadStats, loadLogs, toast, reload])

  const total = rows?.[0] ?? null
  const scopeName = scope === 'all'
    ? t('assistant.insights.scope_all')
    : scope === 'provider' ? provider.label : (keyLabel || keyHint || t('assistant.keys.primary'))

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={720}
      title={(
        <span className="flex items-center gap-2">
          <Activity size={15} className="text-[var(--accent)]" />
          {t('assistant.insights.title', { name: scopeName })}
        </span>
      )}
      description={t('assistant.insights.hint')}
    >
      <div className="flex flex-col gap-3">
        {/* Two questions, one surface: "how much" and "which one failed". Segmented supplies the
            radiogroup, roving tabindex and arrow/Home/End keys the old aria-pressed buttons lacked. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Segmented
            size="sm"
            label={t(INSIGHT_TABS)}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'stats' as const, label: t('assistant.insights.tab_stats') },
              { value: 'logs' as const, label: t('assistant.insights.tab_logs') },
            ]}
          />
          <Segmented
            size="sm"
            label={t(INSIGHT_SCOPE)}
            value={scope}
            onChange={setScope}
            options={[
              ...(keyId !== undefined ? [{ value: 'key' as const, label: `····${keyHint ?? ''}` }] : []),
              { value: 'provider' as const, label: t('assistant.insights.scope_provider') },
              { value: 'all' as const, label: t('assistant.insights.scope_all') },
            ]}
          />
        </div>

        {busy && <div className="flex justify-center py-8"><Spinner /></div>}

        {!busy && failure && (
          <LoadFailure
            messageKey="assistant.insights.load_failed"
            detail={failure}
            onRetry={() => setReload((value) => value + 1)}
          />
        )}

        {!busy && !failure && tab === 'stats' && total && (
          <>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              <Stat icon={<Hash size={10} />} label={t('assistant.insights.requests')} value={count(total.requests)} />
              <Stat icon={<CheckCircle2 size={10} />} label={t('assistant.insights.succeeded')} value={count(total.succeeded)} tone="ok" />
              <Stat icon={<XCircle size={10} />} label={t('assistant.insights.failed')} value={count(total.failed)} tone={total.failed > 0 ? 'bad' : 'muted'} />
              <Stat icon={<Clock size={10} />} label={t('assistant.insights.latency')} value={total.avgLatencyMs === null ? '—' : `${Math.round(total.avgLatencyMs)}ms`} />
              <Stat icon={<Coins size={10} />} label={t('assistant.insights.input')} value={tokens(total.inputTokens)} />
              <Stat icon={<Coins size={10} />} label={t('assistant.insights.output')} value={tokens(total.outputTokens)} />
              <Stat icon={<Coins size={10} />} label={t('assistant.insights.cached')} value={tokens(total.cachedInputTokens)} />
              <Stat icon={<Activity size={10} />} label={t('assistant.insights.tools')} value={count(total.toolCalls)} />
            </div>
            {total.lastAttemptAt !== null && (
              <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('assistant.insights.last_attempt', { when: when(total.lastAttemptAt) })}
              </p>
            )}
            {scope !== 'key' && rows && rows.length > 1 && (
              <div className="flex flex-col gap-1">
                {rows.map((row) => (
                  <div key={row.id} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-1.5 text-[length:var(--text-11-5)]">
                    <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
                      {scope === 'all' ? t('assistant.insights.scope_all') : row.label || row.providerId}
                    </span>
                    <span className="tabular text-[var(--text-quaternary)]">{count(row.requests)}</span>
                    {row.failed > 0 && (
                      <span className="flex items-center gap-0.5 tabular text-[var(--danger)]">
                        <AlertTriangle size={10} />
                        {count(row.failed)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {total.requests === 0 && (
              <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
                {t('assistant.insights.empty')}
              </p>
            )}
          </>
        )}
        {!busy && !failure && tab === 'stats' && !total && (
          <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
            {t('assistant.insights.empty')}
          </p>
        )}

        {!busy && !failure && tab === 'logs' && (
          <>
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('assistant.insights.logs_since')}</span>
                {LOG_WINDOWS.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    aria-pressed={sinceMs === entry.ms}
                    onClick={() => setSinceMs(entry.ms)}
                    className={cn(
                      'rounded-[var(--r-md)] px-2 py-1 text-[length:var(--text-10-5)] transition-colors duration-[var(--dur-fast)]',
                      sinceMs === entry.ms
                        ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
                        : 'text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    {t(entry.key)}
                  </button>
                ))}
                <span className="ml-auto flex items-center gap-1.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                  {t('assistant.insights.log_bodies')}
                  <Switch
                    checked={logBodies}
                    label={t('assistant.insights.log_bodies')}
                    onChange={(checked) => void saveSettings({ logRequestBodies: checked })}
                  />
                </span>
                <Button size="sm" variant="ghost" icon={<Download size={12} />} onClick={() => void exportLogs('json')}>
                  {t('assistant.insights.export_json')}
                </Button>
                <Button size="sm" variant="ghost" icon={<Download size={12} />} onClick={() => void exportLogs('csv')}>
                  {t('assistant.insights.export_csv')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={12} />}
                  onClick={() => {
                    void (async () => {
                      const goal = scope === 'all'
                        ? t('assistant.insights.scope_all')
                        : scope === 'provider' ? provider.label : (keyLabel || keyHint || t('assistant.keys.primary'))
                      const agreed = await confirm({
                        title: t('assistant.insights.clear_title', { name: goal }),
                        description: t('assistant.insights.clear_body'),
                        tone: 'danger',
                      })
                      if (!agreed) return
                      try {
                        await api.assistant.clearRequestLogs({
                          ...(scope === 'key' ? { providerId: provider.id, keyId } : {}),
                          ...(scope === 'provider' ? { providerId: provider.id } : {}),
                          ...(scope === 'all' ? { all: true } : {}),
                        })
                        setExpanded(null)
                        await loadLogs()
                      } catch (error) {
                        toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
                      }
                    })()
                  }}
                >
                  {t('assistant.insights.clear')}
                </Button>
              </div>
              <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('assistant.insights.logs_hint')}</p>
            </div>
            {!logs || logs.length === 0 ? (
              <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.insights.logs_empty')}</p>
            ) : (
              <ul className="flex max-h-[52vh] flex-col gap-1 overflow-y-auto">
                {logs.map((entry) => (
                  <li key={entry.id} className="rounded-[var(--r-md)] border border-[var(--border-subtle)]">
                    <button
                      type="button"
                      onClick={() => setExpanded((current) => current === entry.id ? null : entry.id)}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[length:var(--text-11)]"
                    >
                      {entry.ok
                        ? <CheckCircle2 size={12} className="shrink-0 text-[var(--success)]" />
                        : <XCircle size={12} className="shrink-0 text-[var(--danger)]" />}
                      <span className="shrink-0 font-mono text-[var(--text-10-5)] text-[var(--text-quaternary)]">{when(entry.at)}</span>
                      <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{entry.modelLabel || entry.operation}</span>
                      <span className="shrink-0 font-mono text-[var(--text-10-5)] text-[var(--text-quaternary)]">····{entry.keyHint}</span>
                      <span className="shrink-0 tabular text-[var(--text-10-5)] text-[var(--text-quaternary)]">
                        {tokens(entry.inputTokens)}/{tokens(entry.outputTokens)}
                      </span>
                      {entry.latencyMs !== null && (
                        <span className="shrink-0 tabular text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                          {t('assistant.keys.probe_latency', { ms: entry.latencyMs })}
                        </span>
                      )}
                      {!entry.ok && entry.errorKind && (
                        <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] px-1.5 text-[length:var(--text-10)] text-[var(--danger)]">
                          {entry.errorKind}
                        </span>
                      )}
                    </button>
                    {expanded === entry.id && (
                      <div className="flex flex-col gap-1.5 border-t border-[var(--border-subtle)] px-2.5 py-2 text-[length:var(--text-11)]">
                        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
                          <dt className="text-[var(--text-quaternary)]">{t('assistant.insights.provider')}</dt>
                          <dd className="truncate text-[var(--text-secondary)]">{entry.providerLabel || entry.providerId}</dd>
                          <dt className="text-[var(--text-quaternary)]">{t('assistant.insights.operation')}</dt>
                          <dd className="text-[var(--text-secondary)]">{entry.operation}</dd>
                          {entry.httpStatus !== null && (<>
                            <dt className="text-[var(--text-quaternary)]">{t('assistant.insights.status')}</dt>
                            <dd className={entry.ok ? 'text-[var(--text-secondary)]' : 'text-[var(--danger)]'}>{entry.httpStatus}</dd>
                          </>)}
                          <dt className="text-[var(--text-quaternary)]">{t('assistant.insights.tokens')}</dt>
                          <dd className="tabular text-[var(--text-secondary)]">
                            {t('assistant.insights.tokens_line', { input: count(entry.inputTokens), output: count(entry.outputTokens) })}
                            {entry.cachedInputTokens > 0
                              ? ` ${t('assistant.insights.cached_line', { cached: count(entry.cachedInputTokens) })}`
                              : ''}
                          </dd>
                        </dl>
                        {entry.errorMessage && (
                          <p className="flex items-start gap-1 text-[var(--danger)]">
                            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                            <span className="min-w-0 break-words">{entry.errorMessage}</span>
                          </p>
                        )}
                        {entry.requestBody && (
                          <details>
                            <summary className="flex cursor-pointer items-center gap-1 text-[var(--text-quaternary)]">
                              <FileText size={11} />
                              {t('assistant.insights.body')}
                            </summary>
                            <pre className="mt-1 max-h-40 overflow-auto rounded-[var(--r-sm)] bg-[var(--bg-sunken)] p-2 font-mono text-[length:var(--text-10-5)] whitespace-pre-wrap break-all text-[var(--text-secondary)]">
                              {entry.requestBody}
                            </pre>
                          </details>
                        )}
                        <div className="flex justify-end">
                          <IconButton
                            size="xs"
                            label={t('assistant.insights.delete_one')}
                            onClick={() => {
                              void (async () => {
                                const agreed = await confirm({
                                  title: t('assistant.insights.delete_one'),
                                  tone: 'danger',
                                })
                                if (!agreed) return
                                try {
                                  await api.assistant.deleteRequestLog(entry.id)
                                  setExpanded(null)
                                  await loadLogs()
                                } catch (error) {
                                  toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
                                }
                              })()
                            }}
                          >
                            <Trash2 size={12} />
                          </IconButton>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
