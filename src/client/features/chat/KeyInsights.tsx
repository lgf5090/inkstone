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
import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, ChevronLeft, Clock, Coins, FileText, Hash, Trash2, XCircle } from 'lucide-react'
import type { AssistantKeyStats, AssistantProvider, AssistantRequestLog, AssistantStatsScope } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Switch } from '../../components/form'
import { useAssistant } from './assistant-store'
import { Modal, confirm } from '../../components/overlay'
import { cn } from '../../lib/cn'
import { useUi } from '../../store/ui'

/** A number with thousands separators; the panel is about magnitudes, not exact digits. */
const count = (value: number): string => value.toLocaleString()

/** Tokens in the reader's own units: 43,397 is fine, 4,330,000 is not. */
function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function when(at: number): string {
  const date = new Date(at)
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}

/** One figure with its label, sized so four of them fit on a phone. */
function Stat({ icon, label, value, tone }: { icon: React.ReactNode, label: string, value: string, tone?: 'ok' | 'bad' | 'muted' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-2">
      <span className={cn('flex items-center gap-1 text-[length:var(--text-10-5)]',
        tone === 'ok' ? 'text-[var(--text-tertiary)]' : tone === 'bad' ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]',
      )}
      >
        {icon}
        {label}
      </span>
      <span className={cn('truncate tabular text-[length:var(--text-15)] font-semibold',
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
  const [expanded, setExpanded] = useState<string | null>(null)

  const loadStats = useCallback(async () => {
    const answer = await api.assistant.keyStats({
      scope,
      ...(scope === 'key' ? { providerId: provider.id, keyId } : {}),
      ...(scope === 'provider' ? { providerId: provider.id } : {}),
    })
    setRows(answer.rows)
  }, [scope, provider.id, keyId])

  const loadLogs = useCallback(async () => {
    const answer = await api.assistant.requestLogs({
      ...(scope === 'key' ? { providerId: provider.id, keyId } : {}),
      ...(scope === 'provider' ? { providerId: provider.id } : {}),
      limit: 50,
    })
    setLogs(answer.logs)
  }, [scope, provider.id, keyId])

  useEffect(() => {
    if (!open) return
    setBusy(true)
    const work = tab === 'stats' ? loadStats() : loadLogs()
    void work
      .catch((error: unknown) => toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' }))
      .finally(() => setBusy(false))
  }, [open, tab, scope, loadStats, loadLogs, toast])

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
        {/* Two questions, one surface: "how much" and "which one failed". */}
        <div className="flex items-center gap-1.5">
          {(['stats', 'logs'] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              aria-pressed={tab === entry}
              onClick={() => setTab(entry)}
              className={cn(
                'rounded-[var(--r-md)] px-2.5 py-1 text-[length:var(--text-11-5)] transition-colors duration-[var(--dur-fast)]',
                tab === entry
                  ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
                  : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
              )}
            >
              {entry === 'stats' ? t('assistant.insights.tab_stats') : t('assistant.insights.tab_logs')}
            </button>
          ))}
          <span className="mx-1 h-3 w-px bg-[var(--border-subtle)]" />
          {(['key', 'provider', 'all'] as const).map((entry) => {
            if (entry === 'key' && keyId === undefined) return null
            return (
              <button
                key={entry}
                type="button"
                aria-pressed={scope === entry}
                onClick={() => setScope(entry)}
                className={cn(
                  'rounded-[var(--r-md)] px-2.5 py-1 text-[length:var(--text-11-5)] transition-colors duration-[var(--dur-fast)]',
                  scope === entry
                    ? 'bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)] ring-1 ring-[var(--border-strong)]'
                    : 'text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                {entry === 'key' ? `····${keyHint ?? ''}` : entry === 'provider' ? t('assistant.insights.scope_provider') : t('assistant.insights.scope_all')}
              </button>
            )
          })}
        </div>

        {busy && <div className="flex justify-center py-8"><Spinner /></div>}

        {!busy && tab === 'stats' && total && (
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

        {!busy && tab === 'logs' && (
          <>
            <div className="flex items-center justify-between">
              <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.insights.logs_hint')}</p>
              <span className="flex items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('assistant.insights.log_bodies')}
                <Switch
                  checked={logBodies}
                  label={t('assistant.insights.log_bodies')}
                  onChange={(checked) => void saveSettings({ logRequestBodies: checked })}
                />
              </span>
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
                    await api.assistant.clearRequestLogs({
                      ...(scope === 'key' ? { providerId: provider.id, keyId } : {}),
                      ...(scope === 'provider' ? { providerId: provider.id } : {}),
                      ...(scope === 'all' ? { all: true } : {}),
                    })
                    await loadLogs()
                  })()
                }}
              >
                {t('assistant.insights.clear')}
              </Button>
            </div>
            {logs === null ? <div className="flex justify-center py-6"><Spinner /></div> : logs.length === 0 ? (
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
                                await api.assistant.deleteRequestLog(entry.id)
                                await loadLogs()
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

/** The icon a row wears to open the panel; exported so the two entry points stay identical. */
export const InsightsIcon = Activity

/** A small back-arrow label for the provider-wide entry, kept here so both doors read the same. */
export const InsightsBackIcon = ChevronLeft
