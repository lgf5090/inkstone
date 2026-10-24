/**
 * One link's change history, newest first.
 *
 * The trail is the answer to "who turned this into what, and when" — so the surface is a list of entries
 * with the fields each one moved, not a table of raw rows: the comparison a reader makes is between two
 * moments of the same link, and the ordering the server gives (`created_at DESC, id DESC`) is the reading.
 *
 * Two rules hold here and neither is decoration. A passcode is shown as set or cleared and never as a
 * value — the worker stores it that way, and anything hash-shaped that ever arrived anyway is redacted
 * rather than printed. And a failed read says so with a retry: an empty history and an unreadable one are
 * different answers, and the owner cannot tell them apart from a blank box.
 */
import { History } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { LIMITS } from '@shared/constants'
import type { ShareAuditFieldChange, ShareAuditLogEntry } from '@shared/share-hub'
import { Button } from '../../../components/primitives'
import { Skeleton } from '../../../components/feedback'
import { t } from '../../../lib/i18n'
import { fullTime, relativeTime } from '../../../lib/time'
import { shareHubApi } from '../../../lib/api-share-hub'
import { looksLikeSecret } from './share-readings'

/** The page this surface asks the hub for, and the ceiling the route answers with. One number, shared. */
const AUDIT_PAGE_LIMIT = LIMITS.shareAuditEntriesPerPage

export function ShareAuditHistory({ noteId }: { noteId: string }) {
  const [entries, setEntries] = useState<ShareAuditLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [limit, setLimit] = useState<number>(AUDIT_PAGE_LIMIT)
  const [page, setPage] = useState(1)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState('loading')
    void shareHubApi.audit(noteId, { page, limit: AUDIT_PAGE_LIMIT, signal: controller.signal })
      .then((response) => {
        setEntries(response.entries)
        setTotal(response.total)
        setLimit(response.limit)
        setState('ready')
      })
      .catch(() => {
        // An aborted read is this component replacing its own request, not a failure to report.
        if (controller.signal.aborted) return
        setState('error')
      })
    return () => controller.abort()
  }, [noteId, page, attempt])

  const reload = useCallback(() => setAttempt((count) => count + 1), [])
  const totalPages = Math.max(1, Math.ceil(total / limit))

  return (
    <section
      aria-label={t('share.audit_history_title')}
      className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[var(--sp-3)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-[var(--sp-2)]">
        <p className="flex items-center gap-[var(--sp-1-5)] text-[length:var(--text-10-5)] font-semibold tracking-[0.075em] text-[var(--text-quaternary)] uppercase">
          <History size={12} aria-hidden="true" />
          {t('share.audit_history_title')}
        </p>
        {state === 'ready' && total > 0 && (
          <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {t('share.audit_total', { count: total })}
          </span>
        )}
      </div>

      {state === 'error' && <AuditFailure onRetry={reload} />}
      {state === 'loading' && (
        <div className="space-y-[var(--sp-1-5)] pt-[var(--sp-2)]" aria-busy="true">
          {[0, 1, 2].map((row) => <Skeleton key={row} className="h-[var(--sp-6)]" />)}
        </div>
      )}
      {state === 'ready' && entries.length === 0 && (
        <p className="pt-[var(--sp-2)] text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {t('share.audit_empty')}
        </p>
      )}
      {state === 'ready' && entries.length > 0 && <AuditEntryList entries={entries} />}

      {state === 'ready' && total > limit && (
        <AuditPager page={page} totalPages={totalPages} onPage={setPage} />
      )}
    </section>
  )
}

function AuditFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-[var(--sp-2)] pt-[var(--sp-2)]">
      <p role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">
        {t('share.audit_load_failed')}
      </p>
      <Button size="sm" variant="secondary" onClick={onRetry}>{t('common.retry')}</Button>
    </div>
  )
}

function AuditEntryList({ entries }: { entries: ShareAuditLogEntry[] }) {
  return (
    <ul className="space-y-[var(--sp-2)] pt-[var(--sp-2)]">
      {entries.map((entry) => (
        <li key={entry.id} className="text-[length:var(--text-11)] text-[var(--text-secondary)]">
          <div className="flex items-baseline justify-between gap-[var(--sp-2)]">
            <span className="font-medium text-[var(--text-primary)]">{auditActionLabel(entry.action)}</span>
            <time dateTime={new Date(entry.createdAt).toISOString()} title={fullTime(entry.createdAt)}>
              {relativeTime(entry.createdAt)}
            </time>
          </div>
          {entry.changed.length > 0 && (
            <ul className="mt-[var(--sp-0-5)] space-y-[var(--sp-0-5)]">
              {entry.changed.map((change) => (
                <li key={change.field} className="text-[var(--text-tertiary)]">{auditChangeLine(change)}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )
}

/** A real button pair, because a history that only grows must stay reachable at the end of it. */
function AuditPager({ page, totalPages, onPage }: { page: number, totalPages: number, onPage: (page: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-[var(--sp-2)] pt-[var(--sp-2)] text-[length:var(--text-11)] text-[var(--text-tertiary)]">
      <span>{t('share.reading_page_info', { page, totalPages })}</span>
      <div className="flex items-center gap-[var(--sp-1)]">
        <Button
          size="sm"
          variant="secondary"
          disabled={page <= 1}
          onClick={() => onPage(Math.max(1, page - 1))}
        >
          {t('share.reading_prev_page')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={page >= totalPages}
          onClick={() => onPage(Math.min(totalPages, page + 1))}
        >
          {t('share.reading_next_page')}
        </Button>
      </div>
    </div>
  )
}

const AUDIT_ACTION_KEYS = {
  create: 'share.audit_action_create',
  update: 'share.audit_action_update',
  revoke: 'share.audit_action_revoke',
  batch: 'share.audit_action_batch',
} as const

const AUDIT_FIELD_KEYS: Record<string, 'share.audit_field_slug' | 'share.audit_field_password' | 'share.audit_field_expires_at' | 'share.audit_field_is_enabled' | 'share.audit_field_folder_id' | 'share.audit_field_tags'> = {
  slug: 'share.audit_field_slug',
  has_password: 'share.audit_field_password',
  expires_at: 'share.audit_field_expires_at',
  is_enabled: 'share.audit_field_is_enabled',
  folder_id: 'share.audit_field_folder_id',
  tags: 'share.audit_field_tags',
}

function auditActionLabel(action: ShareAuditLogEntry['action']): string {
  return t(AUDIT_ACTION_KEYS[action])
}

/** A field the catalog has no name for shows its stored name rather than vanishing from the trail. */
function auditFieldLabel(field: string): string {
  const key = AUDIT_FIELD_KEYS[field]
  return key ? t(key) : field
}

function auditChangeLine(change: ShareAuditFieldChange): string {
  return t('share.audit_change_line', {
    field: auditFieldLabel(change.field),
    from: auditValue(change.field, change.from),
    to: auditValue(change.field, change.to),
  })
}

/**
 * One value as the owner reads it.
 *
 * The passcode field is the case the whole function exists for: it is a boolean precisely because the
 * hash must never reach this side of the API, so `true` prints "a passcode was set" and nothing else.
 * `looksLikeSecret` is the guard behind it — a value shaped like a digest or a hash is redacted whatever
 * field it arrived in, so a server-side slip cannot turn the audit trail into a place secrets get read.
 */
function auditValue(field: string, value: string | number | boolean | null | undefined): string {
  if (field === 'has_password' || field === 'password') {
    return value ? t('share.audit_value_password_set') : t('share.audit_value_password_cleared')
  }
  if (field === 'is_enabled') return value ? t('share.audit_value_enabled') : t('share.audit_value_disabled')
  if (field === 'expires_at') return typeof value === 'number' ? fullTime(value) : t('share.audit_value_none')
  if (value === null || value === undefined || value === '') return t('share.audit_value_none')
  const text = String(value)
  if (looksLikeSecret(text)) return t('share.audit_value_redacted')
  return text
}
