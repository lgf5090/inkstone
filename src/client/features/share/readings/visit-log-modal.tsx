/**
 * The visit log: every row the account has, newest first, paged.
 *
 * Three things make this surface what it is, and each of them is a rule the response shape enforces
 * rather than a preference. The page count comes from the server — `total`, `limit` and `totalPages` are
 * one answer, and a client that computes its own ceiling from a page size it guessed will tell the reader
 * they have reached the end while rows remain. The traffic rule is the single-choice filter, because the
 * log's `WHERE` reads that one value and nothing else. And a channel drill-down is refused when the name
 * handed to it is not a marker the column could hold: a filter that quietly widened to "everything" is how
 * a mistyped campaign reads as a wildly successful one.
 *
 * What a row may say about a visitor is the eight-character label the worker already truncated. The raw
 * digest, the IP and the user-agent never leave the API, so there is nothing here to ask for and nothing
 * here to leak.
 */
import { Activity, ChevronLeft, ChevronRight, RefreshCw, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { parseChannelDrillDown } from '@shared/share-channel'
import { VISIT_LOG_FILTERS } from '@shared/share-selection'
import type { VisitLogFilter } from '@shared/share-selection'
import type { ShareBreakdownItem, ShareVisitsResponse } from '@shared/share-hub'
import { Badge, Button, IconButton } from '../../../components/primitives'
import { Segmented, Select } from '../../../components/form'
import { Skeleton } from '../../../components/feedback'
import { Modal, confirm } from '../../../components/overlay'
import { shareHubApi } from '../../../lib/api-share-hub'
import { t } from '../../../lib/i18n'
import { formatDate, formatNumber, fullTime, shortTime } from '../../../lib/time'
import { useUi } from '../../../store/ui'
import {
  EVERY_VISITOR_TOGGLES,
  channelItemName,
  countryName,
  deviceLabel,
  pageWindow,
  rowChannelName,
  trafficParams,
  visitorLabel,
} from './share-readings'

/** The five classes a log reading can ask for, in the order the control lists them. */
const LOG_FILTER_KEYS: Record<VisitLogFilter, 'share.log_filter_all' | 'share.log_filter_real' | 'share.log_filter_bot' | 'share.log_filter_owner' | 'share.log_filter_self'> = {
  all: 'share.log_filter_all',
  real: 'share.log_filter_real',
  bot: 'share.log_filter_bot',
  owner: 'share.log_filter_owner',
  self: 'share.log_filter_self',
}

export function ShareVisitLogModal({
  noteId,
  slug,
  onClose,
}: {
  noteId?: string
  slug?: string
  onClose: () => void
}) {
  const toast = useUi((s) => s.toast)
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState<VisitLogFilter>('real')
  const [channel, setChannel] = useState<string | null>(null)
  /** A channel this surface refused to ask for, and why. The rows on screen stay as they were. */
  const [refusedChannel, setRefusedChannel] = useState<string | null>(null)
  const [data, setData] = useState<ShareVisitsResponse | null>(null)
  const [channels, setChannels] = useState<ShareBreakdownItem[] | null>(null)
  /** A read in flight, and whether the last one failed. The rows on screen stay while a new page loads. */
  const [busy, setBusy] = useState(true)
  const [failed, setFailed] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [attempt, setAttempt] = useState(0)

  // The log narrows to one link by one address: the route refuses both at once, so whichever the hub
  // passes still gets its narrowing rather than a 400.
  const scopedNoteId = noteId
  const scopedSlug = noteId === undefined ? slug : undefined

  const reload = useCallback(() => setAttempt((count) => count + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    setBusy(true)
    setFailed(false)
    void shareHubApi.visits.list({
      page,
      noteId: scopedNoteId,
      slug: scopedSlug,
      filter,
      channel: channel ?? undefined,
      signal: controller.signal,
    })
      .then((response) => {
        setData(response)
        setBusy(false)
      })
      .catch(() => {
        // An aborted read is this surface replacing its own request, not a failure to report.
        if (controller.signal.aborted) return
        setFailed(true)
        setBusy(false)
      })
    return () => controller.abort()
  }, [page, filter, channel, scopedNoteId, scopedSlug, attempt])

  // The drill-down's option list is a reading in its own right: the whole window with nothing excluded,
  // so a channel whose visits were bots is still a channel the owner can name and walk into.
  useEffect(() => {
    const controller = new AbortController()
    const reading = scopedNoteId !== undefined
      ? shareHubApi.analytics.note(scopedNoteId, { range: 'all', ...trafficParams(EVERY_VISITOR_TOGGLES), signal: controller.signal })
      : shareHubApi.analytics.global({ range: 'all', ...trafficParams(EVERY_VISITOR_TOGGLES), signal: controller.signal })
    void reading
      .then((response) => setChannels(response.channels))
      .catch(() => {
        if (controller.signal.aborted) return
        // A picker with no options is worse than a picker that says it could not be filled.
        setChannels(null)
      })
    return () => controller.abort()
  }, [scopedNoteId])

  const chooseChannel = (raw: string) => {
    if (raw === '') {
      setRefusedChannel(null)
      setChannel(null)
      setPage(1)
      return
    }
    if (parseChannelDrillDown(raw).kind === 'invalid') {
      // Refused here as well as at the route: a name the column cannot hold would answer with a 400 the
      // reader cannot act on, and quietly widening to every row would be the wrong consolation.
      setRefusedChannel(raw)
      return
    }
    setRefusedChannel(null)
    setChannel(raw)
    setPage(1)
  }

  const clearLog = async () => {
    const ok = await confirm({
      title: t('share.log_clear_confirm_title'),
      description: t('share.log_clear_confirm_desc'),
      confirmLabel: t('share.log_clear_confirm_action'),
      tone: 'danger',
    })
    if (!ok) return
    setClearing(true)
    try {
      const result = await shareHubApi.visits.clear()
      // The count is the server's own, not the rows on screen: a wipe takes every page at once.
      toast({ title: t('share.log_cleared', { count: formatNumber(result.deleted) }), tone: 'success' })
      setPage(1)
      setAttempt((count) => count + 1)
    } catch {
      toast({ title: t('share.log_clear_failed'), tone: 'danger' })
    } finally {
      setClearing(false)
    }
  }

  const totalPages = data?.totalPages ?? 1
  const shown = data ? pageWindow(data.page, data.limit, data.total) : null

  return (
    <Modal
      open
      onClose={onClose}
      width={1060}
      title={
        <span className="flex items-center gap-[var(--sp-1-5)]">
          <Activity size={16} className="text-[var(--accent)]" aria-hidden="true" />
          {t('share.visit_logs_title')}
          {data && (
            <span className="text-[length:var(--text-11)] font-normal text-[var(--text-tertiary)]">
              {t('share.log_total_records', { count: formatNumber(data.total) })}
            </span>
          )}
        </span>
      }
      description={t('share.visit_logs_desc')}
    >
      <div className="flex flex-col gap-[var(--sp-2-5)]">
        <div className="flex flex-wrap items-center justify-between gap-[var(--sp-2)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[var(--sp-2-5)]">
          <div className="flex flex-wrap items-center gap-[var(--sp-2)]">
            <Segmented
              size="sm"
              label={t('share.log_filter_label')}
              value={filter}
              onChange={(next) => {
                setFilter(next)
                setPage(1)
              }}
              options={VISIT_LOG_FILTERS.map((option) => ({ value: option, label: t(LOG_FILTER_KEYS[option]) }))}
            />
            <ChannelPicker channels={channels} value={channel ?? ''} onSelect={chooseChannel} />
            {channel !== null && (
              <Button
                size="sm"
                variant="secondary"
                icon={<X size={12} aria-hidden="true" />}
                onClick={() => chooseChannel('')}
              >
                {t('share.log_channel_clear', { channel })}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-[var(--sp-1)]">
            <Button
              size="sm"
              variant="secondary"
              className="text-[var(--danger)]"
              icon={<Trash2 size={12} aria-hidden="true" />}
              loading={clearing}
              onClick={() => void clearLog()}
            >
              {t('share.log_clear_btn')}
            </Button>
            <IconButton size="sm" label={t('common.refresh')} disabled={busy} onClick={reload}>
              <RefreshCw size={13} className={busy ? 'animate-spin' : ''} aria-hidden="true" />
            </IconButton>
          </div>
        </div>

        {refusedChannel !== null && (
          <p role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">
            {t('share.log_channel_refused', { channel: refusedChannel })}
          </p>
        )}

        {failed && (
          <div className="flex flex-wrap items-center gap-[var(--sp-2)]">
            <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">
              {t('share.log_load_failed')}
            </p>
            <Button size="sm" variant="secondary" onClick={reload}>{t('common.retry')}</Button>
          </div>
        )}
        {busy && data === null && (
          <div className="space-y-[var(--sp-1-5)]" aria-busy="true">
            {[0, 1, 2, 3].map((row) => <Skeleton key={row} className="h-[var(--sp-6)]" />)}
          </div>
        )}
        {busy && data !== null && (
          <p role="status" className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('common.loading')}</p>
        )}
        {data !== null && (
          <>
            {data.visits.length === 0
              ? <p className="py-[var(--sp-6)] text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('share.log_empty')}</p>
              : <VisitLogTable visits={data.visits} showNote={scopedNoteId === undefined} />}
            <div className="flex flex-wrap items-center justify-between gap-[var(--sp-2)] text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              <p aria-live="polite">
                {shown && t('share.log_rows_shown', { from: shown.from, to: shown.to, total: formatNumber(data.total) })}
              </p>
              <div className="flex items-center gap-[var(--sp-2)]">
                <span>{t('share.reading_page_info', { page: data.page, totalPages })}</span>
                <div className="flex items-center gap-[var(--sp-1)]">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<ChevronLeft size={13} aria-hidden="true" />}
                    disabled={data.page <= 1 || busy}
                    onClick={() => setPage(Math.max(1, data.page - 1))}
                  >
                    {t('share.reading_prev_page')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    trailing={<ChevronRight size={13} aria-hidden="true" />}
                    disabled={data.page >= totalPages || busy}
                    onClick={() => setPage(Math.min(totalPages, data.page + 1))}
                  >
                    {t('share.reading_next_page')}
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/**
 * The channels the owner can drill into, named the way the breakdown names them.
 *
 * The two reserved names stay two options: one asks for the visits that carried no marker, the other for
 * the ones whose marker was refused. Folding them into a single row would hide the one failure this column
 * exists to catch — a campaign string that stopped being a valid marker.
 */
function ChannelPicker({ channels, value, onSelect }: {
  channels: ShareBreakdownItem[] | null
  value: string
  onSelect: (raw: string) => void
}) {
  return (
    <Select
      aria-label={t('share.log_channel_label')}
      value={value}
      disabled={channels === null}
      className="h-7 max-w-[220px] text-[length:var(--text-11)]"
      onChange={(event) => onSelect(event.target.value)}
    >
      {/* While the reading is in flight the control says what it does not yet know, rather than offering
          one option and reading as a filter that matches nothing. */}
      <option value="">{channels === null ? t('share.log_channel_loading') : t('share.log_channel_none')}</option>
      {(channels ?? []).map((item) => (
        <option key={item.name} value={item.name}>{`${channelItemName(item)} · ${formatNumber(item.count)}`}</option>
      ))}
    </Select>
  )
}

function VisitLogTable({ visits, showNote }: { visits: ShareVisitsResponse['visits'], showNote: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[length:var(--text-11)]">
        <caption className="sr-only">{t('share.visit_logs_title')}</caption>
        <thead className="text-[var(--text-quaternary)]">
          <tr className="border-b border-[var(--border-subtle)]">
            <th scope="col" className="py-[var(--sp-1)] pr-[var(--sp-2)] font-medium">{t('share.reading_col_time')}</th>
            {showNote && <th scope="col" className="py-[var(--sp-1)] pr-[var(--sp-2)] font-medium">{t('share.log_col_note')}</th>}
            <th scope="col" className="py-[var(--sp-1)] pr-[var(--sp-2)] font-medium">{t('share.reading_col_place')}</th>
            <th scope="col" className="py-[var(--sp-1)] pr-[var(--sp-2)] font-medium">{t('share.log_col_referrer')}</th>
            <th scope="col" className="py-[var(--sp-1)] pr-[var(--sp-2)] font-medium">{t('share.reading_col_device')}</th>
            <th scope="col" className="py-[var(--sp-1)] pr-[var(--sp-2)] font-medium">{t('share.log_col_kind')}</th>
            <th scope="col" className="py-[var(--sp-1)] pr-[var(--sp-2)] font-medium">{t('share.reading_col_channel')}</th>
            <th scope="col" className="py-[var(--sp-1)] font-medium">{t('share.reading_col_visitor')}</th>
          </tr>
        </thead>
        <tbody>
          {visits.map((visit) => (
            <tr key={visit.id} className="border-b border-[var(--border-subtle)] align-top">
              <th scope="row" className="py-[var(--sp-1)] pr-[var(--sp-2)] text-left font-normal text-[var(--text-tertiary)]">
                <time dateTime={new Date(visit.visitedAt).toISOString()} title={fullTime(visit.visitedAt)}>
                  {`${formatDate(visit.visitedAt)} ${shortTime(visit.visitedAt)}`}
                </time>
              </th>
              {showNote && (
                <td className="max-w-[280px] truncate py-[var(--sp-1)] pr-[var(--sp-2)] text-[var(--text-primary)]">
                  {visit.noteTitle ?? t('share.log_note_deleted')}
                </td>
              )}
              <td className="py-[var(--sp-1)] pr-[var(--sp-2)] text-[var(--text-secondary)]">
                {countryName(visit.country)}
              </td>
              <td className="max-w-[220px] truncate py-[var(--sp-1)] pr-[var(--sp-2)] text-[var(--text-secondary)]" title={visit.referrer ?? undefined}>
                {visit.referrerHost ?? t('share.log_referrer_direct')}
              </td>
              <td className="py-[var(--sp-1)] pr-[var(--sp-2)] text-[var(--text-secondary)]">
                {deviceLabel(visit)}
              </td>
              <td className="py-[var(--sp-1)] pr-[var(--sp-2)]">
                <VisitKindBadges visit={visit} />
              </td>
              <td className="max-w-[180px] truncate py-[var(--sp-1)] pr-[var(--sp-2)] font-mono text-[var(--text-secondary)]">
                {rowChannelName(visit.channel)}
              </td>
              <td className="py-[var(--sp-1)] font-mono text-[var(--text-quaternary)]">
                {visitorLabel(visit.visitorFp) ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Which kind of traffic a row is, in the vocabulary the filter above uses.
 *
 * A row can carry more than one mark while the filter is single-choice, so the badges say what the row is
 * rather than what the reading asked for: a bot that also came from the owner's own device says both.
 */
function VisitKindBadges({ visit }: { visit: ShareVisitsResponse['visits'][number] }) {
  const botLabel = visit.botName ? `${t('share.badge_bot')} ${visit.botName}` : t('share.badge_bot')
  return (
    <span className="flex flex-wrap items-center gap-[var(--sp-0-5)]">
      {visit.isBot && <Badge tone="danger">{botLabel}</Badge>}
      {visit.isOwner && <Badge tone="accent">{t('share.badge_owner')}</Badge>}
      {visit.isSelfReferrer && <Badge tone="warning">{t('share.badge_self_referrer')}</Badge>}
      {!visit.isBot && !visit.isOwner && !visit.isSelfReferrer && (
        <span className="text-[var(--text-quaternary)]">{t('share.log_kind_real')}</span>
      )}
    </span>
  )
}
