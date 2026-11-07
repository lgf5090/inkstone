// Read-only audit browser and local health view (plan W7-03). The panel never offers an edit or
// delete control: the trail is append-only by construction, so the UI can only filter and page it.

import { useEffect, useState } from 'react'
import { Activity, ShieldCheck } from 'lucide-react'
import type { WebsshAuditEventView, WebsshHealthReport } from '@shared/webssh/types'
import { WEBSSH_AUDIT_EVENT_TYPES } from '@shared/webssh/types'
import { Button, Spinner } from '../../components/primitives'
import { Input, Select } from '../../components/form'
import { Empty } from '../../components/feedback'
import { Modal } from '../../components/overlay'
import { cn } from '../../lib/cn'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { websshApi } from './api'

function errorText(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : t('webssh.error.generic')
}

function dayStart(value: string): number {
  if (!value) return 0
  const time = new Date(`${value}T00:00:00`).getTime()
  return Number.isFinite(time) ? time : 0
}

function dayEnd(value: string): number {
  if (!value) return 0
  const time = new Date(`${value}T23:59:59.999`).getTime()
  return Number.isFinite(time) ? time : 0
}

function healthText(code: string): string {
  if (code === 'session_failures') return t('webssh.health.alert_session_failures')
  if (code === 'host_key_changed') return t('webssh.health.alert_host_key_changed')
  if (code === 'retention_failed') return t('webssh.health.alert_retention_failed')
  return t('webssh.health.alert_ticket_anomaly')
}

export function AuditPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'events' | 'health'>('events')
  const [eventType, setEventType] = useState('')
  const [fromInput, setFromInput] = useState('')
  const [toInput, setToInput] = useState('')
  const [filters, setFilters] = useState({ eventType: '', from: 0, to: 0 })
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [items, setItems] = useState<WebsshAuditEventView[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [health, setHealth] = useState<WebsshHealthReport | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [healthError, setHealthError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || tab !== 'events') return
    let cancelled = false
    setLoading(true)
    websshApi.listAudit({ page, pageSize, eventType: filters.eventType, from: filters.from, to: filters.to })
      .then((response) => {
        if (cancelled) return
        setItems(response.items)
        setTotal(response.total)
        setError(null)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, tab, page, pageSize, filters])

  useEffect(() => {
    if (!open || tab !== 'health') return
    let cancelled = false
    setHealthLoading(true)
    websshApi.auditHealth()
      .then((report) => {
        if (!cancelled) {
          setHealth(report)
          setHealthError(null)
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setHealthError(errorText(caught))
      })
      .finally(() => {
        if (!cancelled) setHealthLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, tab])

  const apply = () => {
    setFilters({ eventType, from: dayStart(fromInput), to: dayEnd(toInput) })
    setPage(1)
  }

  const reset = () => {
    setEventType('')
    setFromInput('')
    setToInput('')
    setFilters({ eventType: '', from: 0, to: 0 })
    setPage(1)
  }

  const pages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.audit.title')}
      description={t('webssh.audit.description')}
      width={960}
      footer={<Button variant="ghost" onClick={onClose}>{t('webssh.actions.close')}</Button>}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <Button size="sm" variant={tab === 'events' ? 'primary' : 'secondary'} onClick={() => setTab('events')}>
              {t('webssh.audit.tab_events')}
            </Button>
            <Button size="sm" variant={tab === 'health' ? 'primary' : 'secondary'} onClick={() => setTab('health')}>
              {t('webssh.audit.tab_health')}
            </Button>
          </div>
          <span className="ms-auto rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-2 py-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
            {t('webssh.audit.read_only')}
          </span>
        </div>

        {tab === 'events' ? (
          <>
            <div className="flex flex-wrap items-end gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2">
              <label className="flex min-w-[160px] flex-1 flex-col gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                {t('webssh.audit.filter_type')}
                <Select value={eventType} onChange={(event) => setEventType(event.target.value)} aria-label={t('webssh.audit.filter_type')}>
                  <option value="">{t('webssh.audit.all_types')}</option>
                  {WEBSSH_AUDIT_EVENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                {t('webssh.audit.from')}
                <Input type="date" value={fromInput} onChange={(event) => setFromInput(event.target.value)} aria-label={t('webssh.audit.from')} />
              </label>
              <label className="flex flex-col gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                {t('webssh.audit.to')}
                <Input type="date" value={toInput} onChange={(event) => setToInput(event.target.value)} aria-label={t('webssh.audit.to')} />
              </label>
              <Button size="sm" variant="primary" onClick={apply}>{t('webssh.audit.apply')}</Button>
              <Button size="sm" variant="ghost" onClick={reset}>{t('webssh.audit.reset')}</Button>
            </div>

            {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
            {loading && items.length === 0 ? (
              <div className="flex justify-center py-8"><Spinner size={16} /></div>
            ) : items.length === 0 ? (
              <Empty art="search" compact title={t('webssh.audit.empty')} />
            ) : (
              <div className="overflow-x-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[length:var(--text-11)] uppercase tracking-wide text-[var(--text-quaternary)]">
                      <th className="px-2 py-1.5 font-medium">{t('webssh.audit.column_time')}</th>
                      <th className="px-2 py-1.5 font-medium">{t('webssh.audit.column_type')}</th>
                      <th className="hidden px-2 py-1.5 font-medium sm:table-cell">{t('webssh.audit.column_host')}</th>
                      <th className="hidden px-2 py-1.5 font-medium sm:table-cell">{t('webssh.audit.column_session')}</th>
                      <th className="px-2 py-1.5 font-medium">{t('webssh.audit.column_details')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-subtle)]">
                    {items.map((item) => (
                      <tr key={item.id} className="align-top hover:bg-[var(--bg-hover)]">
                        <td className="whitespace-nowrap px-2 py-1.5 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                          {new Date(item.createdAt).toLocaleString()}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-[length:var(--text-11-5)] text-[var(--text-primary)]">{item.eventType}</td>
                        <td className="hidden px-2 py-1.5 font-mono text-[length:var(--text-10-5)] text-[var(--text-tertiary)] sm:table-cell">
                          {item.hostId || '—'}
                        </td>
                        <td className="hidden px-2 py-1.5 font-mono text-[length:var(--text-10-5)] text-[var(--text-tertiary)] sm:table-cell">
                          {item.sessionId || '—'}
                        </td>
                        <td className="max-w-[320px] break-all px-2 py-1.5 font-mono text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                          {Object.keys(item.metadata).length ? JSON.stringify(item.metadata) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
              <span>{t('webssh.audit.count', { count: total })}</span>
              <span className="flex items-center gap-1">
                <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
                  {t('webssh.audit.previous')}
                </Button>
                <span>{t('webssh.audit.page', { page, pages })}</span>
                <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>
                  {t('webssh.audit.next')}
                </Button>
              </span>
            </div>
          </>
        ) : (
          <div className="space-y-3">
            {healthError && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{healthError}</p>}
            {healthLoading && !health ? (
              <div className="flex justify-center py-8"><Spinner size={16} /></div>
            ) : health ? (
              <>
                <h3 className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{t('webssh.health.title')}</h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat label={t('webssh.health.sessions')} value={String(health.sessions.total)} />
                  <Stat label={t('webssh.health.failures')} value={String(health.sessions.failed)} />
                  <Stat label={t('webssh.health.rate')} value={`${Math.round(health.sessions.failureRate * 100)}%`} />
                  <Stat label={t('webssh.health.host_key_changed')} value={String(health.signals.hostKeyChanged)} />
                  <Stat label={t('webssh.health.retention_failed')} value={String(health.signals.retentionFailed)} />
                  <Stat label={t('webssh.health.ticket_rejected')} value={String(health.signals.ticketRejected)} />
                </div>
                {health.alerts.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
                    <ShieldCheck size={16} aria-hidden="true" className="text-[var(--success)]" />
                    <p className="text-[length:var(--text-12-5)] text-[var(--text-secondary)]">{t('webssh.health.no_alerts')}</p>
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {health.alerts.map((alert) => (
                      <li
                        key={alert.code}
                        className={cn(
                          'flex items-start gap-2 rounded-[var(--r-md)] border p-3',
                          alert.severity === 'danger'
                            ? 'border-[var(--danger)]/40 bg-[var(--danger-soft)]'
                            : 'border-[var(--warning)]/40 bg-[var(--warning-softer)]',
                        )}
                      >
                        <Activity size={15} aria-hidden="true" className={alert.severity === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--warning)]'} />
                        <div className="min-w-0 flex-1">
                          <p className="text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{healthText(alert.code)}</p>
                          <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                            {alert.severity === 'danger' ? t('webssh.health.severity_danger') : t('webssh.health.severity_warning')}
                            {alert.lastAt ? ` · ${t('webssh.health.last_at', { date: new Date(alert.lastAt).toLocaleString() })}` : ''}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('webssh.health.description')}</p>
              </>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2.5">
      <p className="text-[length:var(--text-10-5)] uppercase tracking-wide text-[var(--text-quaternary)]">{label}</p>
      <p className="mt-0.5 tabular text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{value}</p>
    </div>
  )
}
