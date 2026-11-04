/**
 * The yearly activity grid, opened from the calendar sidebar.
 *
 * The sidebar is about two hundred pixels wide, and fifty-three columns of squares do not fit in it:
 * a grid squeezed to two-pixel cells is a texture, not a chart. The card therefore carries the entry
 * and the year's total, and the grid itself opens in a dialog where each column can be twelve pixels.
 *
 * The aggregation runs on the server (`/api/activity/heatmap`), so one request covers a whole year for
 * one filter set. Each square is a real focusable button drawn with SVG, its accessible name carries
 * the number as well as the date, and the arrow keys move between days — colour is never the only
 * signal.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, Flame } from 'lucide-react'
import {
  ACTIVITY_KINDS,
  heatLevel,
  yearGrid,
  type ActivityKind,
  type HeatmapResponse,
} from '@shared/activity/heatmap'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import type { MessageKey } from '@shared/locales/en-US'
import { Button, IconButton, SectionLabel } from '../../components/primitives'
import { Modal, Tooltip } from '../../components/overlay'
import { request } from '../../lib/api'
import { navigateToPath } from '../../lib/app-history'

const KIND_KEYS: Record<ActivityKind, MessageKey> = {
  notes: 'calendar.heatmap.kind.notes',
  todos: 'calendar.heatmap.kind.todos',
  todos_completed: 'calendar.heatmap.kind.todos_completed',
  memos: 'calendar.heatmap.kind.memos',
  events: 'calendar.heatmap.kind.events',
  uploads: 'calendar.heatmap.kind.uploads',
  music: 'calendar.heatmap.kind.music',
  chat: 'calendar.heatmap.kind.chat',
}

const KIND_PATHS: Record<ActivityKind, string> = {
  notes: '/notes',
  todos: '/todo',
  todos_completed: '/todo',
  memos: '/memos',
  events: '/calendar',
  uploads: '/clouddrive',
  music: '/music',
  chat: '/chat',
}

const KINDS_STORAGE_KEY = 'inkstone:calendar:heatmap-kinds'
const CELL = 12
const ROWS = 7

function readKinds(): ActivityKind[] {
  try {
    const raw = localStorage.getItem(KINDS_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!Array.isArray(parsed)) return [...ACTIVITY_KINDS]
    const chosen = parsed.filter((value): value is ActivityKind => (ACTIVITY_KINDS as readonly string[]).includes(value as string))
    return chosen.length > 0 ? chosen : [...ACTIVITY_KINDS]
  } catch {
    return [...ACTIVITY_KINDS]
  }
}

function writeKinds(kinds: ActivityKind[]): void {
  try {
    localStorage.setItem(KINDS_STORAGE_KEY, JSON.stringify(kinds))
  } catch {
    // The selection is a convenience; a full quota must not stop the grid from drawing.
  }
}

/** The count the grid paints: the selected kinds only, so a filter change is visible at once. */
function dayTotal(response: HeatmapResponse | null, date: string, kinds: ActivityKind[]): number {
  const day = response?.days.find(entry => entry.date === date)
  if (!day) return 0
  return kinds.reduce((sum, kind) => sum + (day.counts[kind] ?? 0), 0)
}

/** The sidebar entry: one line, the year's total, and the gesture that opens the grid. */
export function CalendarHeatmapCard({ today }: { today: Date }) {
  const [open, setOpen] = useState(false)
  const [total, setTotal] = useState<number | null>(null)
  const year = today.getFullYear()

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      kinds: readKinds().join(','),
    })
    void request<HeatmapResponse>(`/api/activity/heatmap?${params.toString()}`, { signal: controller.signal })
      .then((answer) => {
        if (controller.signal.aborted) return
        setTotal(Object.values(answer.totals).reduce((sum, value) => sum + (value ?? 0), 0))
      })
      .catch(() => {
        // The card still opens the dialog, which reports its own failure; a missing badge is not an
        // error worth a toast on a screen the reader did not ask about yet.
        if (!controller.signal.aborted) setTotal(null)
      })
    return () => controller.abort()
  }, [year])

  return (
    <section aria-label={t('calendar.heatmap.title')} className="px-3 py-2">
      <SectionLabel className="flex items-center gap-1">
        <Flame size={12} aria-hidden="true" />
        <span>{t('calendar.heatmap.title')}</span>
      </SectionLabel>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 flex w-full items-center justify-between gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-left text-[length:var(--text-11-5)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
      >
        <span className="tabular">{t('calendar.heatmap.total', { count: total ?? 0 })}</span>
        <span className="shrink-0 text-[var(--accent)]">{t('calendar.heatmap.open')}</span>
      </button>
      {open && <HeatmapDialog year={year} today={today} onClose={() => setOpen(false)} />}
    </section>
  )
}

function HeatmapDialog({ year: initialYear, today, onClose }: { year: number; today: Date; onClose: () => void }) {
  const currentYear = today.getFullYear()
  const [year, setYear] = useState(initialYear)
  const [kinds, setKinds] = useState<ActivityKind[]>(readKinds)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [response, setResponse] = useState<HeatmapResponse | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const cellsRef = useRef(new Map<string, HTMLButtonElement>())

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      kinds: kinds.join(','),
    })
    void request<HeatmapResponse>(`/api/activity/heatmap?${params.toString()}`, { signal: controller.signal })
      .then((answer) => {
        if (controller.signal.aborted) return
        setResponse(answer)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setError(cause instanceof Error && cause.message ? cause.message : t('calendar.heatmap.load_failed'))
        setLoading(false)
      })
    return () => controller.abort()
  }, [year, kinds])

  const grid = useMemo(() => yearGrid(year), [year])
  const max = useMemo(() => {
    if (!response) return 0
    let highest = 0
    for (const day of response.days) {
      const total = kinds.reduce((sum, kind) => sum + (day.counts[kind] ?? 0), 0)
      if (total > highest) highest = total
    }
    return highest
  }, [response, kinds])
  const total = useMemo(
    () => (response ? kinds.reduce((sum, kind) => sum + (response.totals[kind] ?? 0), 0) : 0),
    [response, kinds],
  )

  const toggleKind = (kind: ActivityKind): void => {
    // At least one kind stays on: an empty selection would be a request with nothing to count, and
    // the grid would be a field of identical squares rather than an answer.
    const next = kinds.includes(kind)
      ? (kinds.length > 1 ? kinds.filter(value => value !== kind) : kinds)
      : [...kinds, kind]
    setKinds(next)
    writeKinds(next)
  }

  const moveFocus = useCallback((key: string, delta: number): void => {
    const cells = grid.flat().filter(cell => cell.date !== null)
    const index = cells.findIndex(cell => cell.date === key)
    const next = cells[index + delta]
    if (!next?.date) return
    setFocusKey(next.date)
    window.setTimeout(() => cellsRef.current.get(next.date!)?.focus({ preventScroll: true }), 0)
  }, [grid])

  const firstDay = grid.flat().find(cell => cell.date !== null)?.date ?? null

  return (
    <Modal
      open
      onClose={onClose}
      title={t('calendar.heatmap.day_grid_title', { year })}
      description={t('calendar.heatmap.hint')}
      width={880}
      footer={<Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1">
            <IconButton size="sm" label={t('calendar.heatmap.year_previous')} onClick={() => setYear(value => value - 1)}>
              <ChevronLeft size={13} aria-hidden="true" />
            </IconButton>
            <span aria-live="polite" className="min-w-10 text-center text-[length:var(--text-13)] font-semibold tabular text-[var(--text-primary)]">{year}</span>
            <IconButton
              size="sm"
              label={t('calendar.heatmap.year_next')}
              disabled={year >= currentYear}
              onClick={() => setYear(value => Math.min(currentYear, value + 1))}
            >
              <ChevronRight size={13} aria-hidden="true" />
            </IconButton>
            <span className="ml-2 tabular text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('calendar.heatmap.total', { count: total })}</span>
          </span>
          <div role="group" aria-label={t('calendar.heatmap.filter')} className="flex flex-wrap gap-1">
            {ACTIVITY_KINDS.map((kind) => {
              const on = kinds.includes(kind)
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleKind(kind)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[length:var(--text-11)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]',
                    on
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                      : 'border-[var(--border-subtle)] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)]',
                  )}
                >
                  {t(KIND_KEYS[kind])}
                </button>
              )
            })}
          </div>
        </div>

        {loading && (
          <div role="status" className="flex items-center gap-1.5 text-[length:var(--text-12)] text-[var(--text-quaternary)]">
            <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-[var(--accent)]" />
            {t('calendar.heatmap.loading')}
          </div>
        )}
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}

        {!error && (
          <div className="overflow-x-auto pb-1">
            <div
              role="group"
              aria-label={t('calendar.heatmap.grid', { year })}
              className="grid w-max gap-[3px]"
              style={{ gridTemplateRows: `repeat(${ROWS}, ${CELL}px)`, gridAutoFlow: 'column', gridAutoColumns: `${CELL}px` }}
            >
              {grid.flatMap((column, columnIndex) => column.map((cell, rowIndex) => {
                if (!cell.date) return <span key={`pad-${columnIndex}-${rowIndex}`} aria-hidden="true" />
                const count = dayTotal(response, cell.date, kinds)
                const level = heatLevel(count, max)
                const label = t('calendar.heatmap.cell', { date: cell.date, count })
                return (
                  <Tooltip key={cell.date} label={label}>
                    <button
                      ref={(node) => {
                        if (node) cellsRef.current.set(cell.date!, node)
                        else cellsRef.current.delete(cell.date!)
                      }}
                      type="button"
                      aria-label={label}
                      tabIndex={cell.date === (focusKey ?? firstDay) ? 0 : -1}
                      onClick={() => setDetail(cell.date)}
                      onFocus={() => setFocusKey(cell.date)}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowRight') { event.preventDefault(); moveFocus(cell.date!, 7) }
                        else if (event.key === 'ArrowLeft') { event.preventDefault(); moveFocus(cell.date!, -7) }
                        else if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(cell.date!, 1) }
                        else if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(cell.date!, -1) }
                      }}
                      className="rounded-[2px] p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                    >
                      <svg width={CELL} height={CELL} viewBox={`0 0 ${CELL} ${CELL}`} aria-hidden="true" className="block">
                        <rect
                          width={CELL}
                          height={CELL}
                          rx={2}
                          style={{ fill: level === 0
                            ? 'color-mix(in oklab, var(--text-quaternary) 14%, var(--bg-base))'
                            : `color-mix(in oklab, var(--accent) ${[0, 18, 34, 52, 70, 88][level]}%, var(--bg-base))` }}
                        />
                      </svg>
                    </button>
                  </Tooltip>
                )
              }))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          <span className="flex items-center gap-1">
            <span>{t('calendar.heatmap.less')}</span>
            {[0, 1, 2, 3, 4, 5].map(level => (
              <svg key={level} width={CELL} height={CELL} aria-hidden="true" className="block">
                <rect
                  width={CELL}
                  height={CELL}
                  rx={2}
                  style={{ fill: level === 0
                    ? 'color-mix(in oklab, var(--text-quaternary) 14%, var(--bg-base))'
                    : `color-mix(in oklab, var(--accent) ${[0, 18, 34, 52, 70, 88][level]}%, var(--bg-base))` }}
                />
              </svg>
            ))}
            <span>{t('calendar.heatmap.more')}</span>
          </span>
          {!loading && total === 0 && <span>{t('calendar.heatmap.empty')}</span>}
        </div>
      </div>

      {detail && (
        <section aria-label={t('calendar.heatmap.day_title', { date: detail })} className="border-t border-[var(--border-subtle)] pt-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('calendar.heatmap.day_title', { date: detail })}</h3>
            <Button size="sm" variant="ghost" onClick={() => setDetail(null)}>{t('common.close')}</Button>
          </div>
          {kinds.filter(kind => (response?.days.find(entry => entry.date === detail)?.counts[kind] ?? 0) > 0).length === 0 && (
            <p className="text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('calendar.heatmap.day_empty')}</p>
          )}
          <ul className="grid gap-1 sm:grid-cols-2">
            {kinds.filter(kind => (response?.days.find(entry => entry.date === detail)?.counts[kind] ?? 0) > 0).map(kind => (
              <li key={kind}>
                <button
                  type="button"
                  onClick={() => { setDetail(null); onClose(); navigateToPath(KIND_PATHS[kind]) }}
                  className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-1.5 py-1 text-left text-[length:var(--text-12)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                >
                  <span className="min-w-0 flex-1 truncate">{t(KIND_KEYS[kind])}</span>
                  <span className="tabular text-[var(--text-primary)]">{response?.days.find(entry => entry.date === detail)?.counts[kind] ?? 0}</span>
                  <ExternalLink size={12} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Modal>
  )
}
