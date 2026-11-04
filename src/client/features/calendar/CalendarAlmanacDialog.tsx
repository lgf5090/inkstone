/**
 * The day panel: the almanac of one date, plus what the other modules have on it.
 *
 * Opening it from the lunar label inside a month cell is the reader saying "tell me about this day".
 * The panel answers in three parts, in falling order of certainty: the statutory calendar (a published
 * notice), the lunar date and solar term (tables this notebook owns), and the day's rule-based
 * almanac below them, which is labelled as derived because that is what it is.
 *
 * The other-module rows at the bottom are references, never copies: each one opens its own app, and
 * nothing here writes to the to-do or subscription tables.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowUpRight, CalendarClock, ListChecks, Loader2, RefreshCw } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import { countdownFallsOn, countdownOccurrence, sortCountdowns, type CalendarCountdownDto } from '@shared/calendar/countdown'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { dayAlmanac } from './almanac'
import { auspiciousHours, loadAlmanacDetail, type AlmanacDetail } from './huangli'
import { renewalsOn, todosDueOn, type LinkedRenewal, type LinkedTodo } from './linked'
import { openTaskInTodo } from '../todos/open-task'

interface CalendarAlmanacDialogProps {
  open: boolean
  /** `YYYY-MM-DD`; null while nothing has been picked, which keeps the dialog closed. */
  dateKey: string | null
  countdowns: readonly CalendarCountdownDto[]
  onClose: () => void
  onJump: (path: string) => void
}

function parseKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, day)
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-[length:var(--text-11)] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{title}</h3>
      {children}
    </section>
  )
}

function Chips({ values, tone }: { values: readonly string[], tone: 'good' | 'bad' | 'plain' }) {
  if (values.length === 0) return <span className="text-[length:var(--text-12)] text-[var(--text-quaternary)]">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {values.map(value => (
        <span
          key={value}
          className={cn(
            'rounded-[var(--r-xs)] px-1.5 py-0.5 text-[length:var(--text-11-5)]',
            tone === 'good' && 'bg-[var(--success-soft)] text-[var(--success)]',
            tone === 'bad' && 'bg-[var(--danger-soft)] text-[var(--danger)]',
            tone === 'plain' && 'bg-[var(--bg-sunken)] text-[var(--text-secondary)]',
          )}
        >
          {value}
        </span>
      ))}
    </div>
  )
}

export function CalendarAlmanacDialog({ open, dateKey, countdowns, onClose, onJump }: CalendarAlmanacDialogProps) {
  const date = useMemo(() => (dateKey ? parseKey(dateKey) : null), [dateKey])
  const info = useMemo(() => (date ? dayAlmanac(date) : null), [date])
  const [detail, setDetail] = useState<AlmanacDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [todos, setTodos] = useState<LinkedTodo[] | null>(null)
  const [renewals, setRenewals] = useState<LinkedRenewal[] | null>(null)
  const [linkedError, setLinkedError] = useState(false)

  useEffect(() => {
    if (!open || !date || !dateKey) return
    let cancelled = false
    setDetail(null)
    setDetailLoading(true)
    setTodos(null)
    setRenewals(null)
    setLinkedError(false)
    void loadAlmanacDetail(date).then((value) => {
      if (cancelled) return
      setDetail(value)
      setDetailLoading(false)
    })
    const controller = new AbortController()
    void Promise.all([todosDueOn(dateKey, controller.signal), renewalsOn(dateKey, controller.signal)])
      .then(([todoRows, renewalRows]) => {
        if (cancelled) return
        setTodos(todoRows)
        setRenewals(renewalRows)
      })
      .catch(() => {
        if (cancelled) return
        setLinkedError(true)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [open, date, dateKey])

  if (!open || !date || !info || !dateKey) return null

  const today = Temporal.PlainDate.from(dateKey)
  const onThisDay = sortCountdowns(countdowns.filter(item => countdownFallsOn(item, today)), today)
  const holidayLabel = info.holiday.makeup
    ? t('calendar.almanac.holiday_makeup')
    : info.holiday.off
      ? t('calendar.almanac.holiday_off')
      : null
  const holidayName = info.holiday.name ? t(info.holiday.name) : null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.almanac.title', { date: dateKey })}
      description={info.long || t('calendar.almanac.empty')}
      width={560}
      footer={<Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-1.5 text-[length:var(--text-12)]">
          {info.solarTerm && <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 font-medium text-[var(--accent-on-soft)]">{info.solarTerm}</span>}
          {info.festival && <span className="rounded-full bg-[var(--bg-sunken)] px-2 py-0.5 text-[var(--text-secondary)]">{info.festival}</span>}
          {holidayLabel && (
            <span className={cn(
              'rounded-full px-2 py-0.5 font-medium',
              info.holiday.off ? 'bg-[var(--danger-soft)] text-[var(--danger)]' : 'bg-[var(--bg-sunken)] text-[var(--text-secondary)]',
            )}>
              {holidayName ? `${holidayName} · ${holidayLabel}` : holidayLabel}
            </span>
          )}
          {info.zodiac && <span className="text-[var(--text-tertiary)]">{t('calendar.almanac.zodiac')} {info.zodiac}</span>}
          <span className="text-[var(--text-tertiary)]">{t('calendar.almanac.constellation')} {t(info.constellation)}</span>
        </div>

        {info.holiday.source && (
          <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('calendar.almanac.source', { source: t(info.holiday.source) })}</p>
        )}
        {!info.holiday.source && (
          <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('calendar.almanac.source_none')}</p>
        )}

        {detailLoading && (
          <p role="status" className="flex items-center gap-1.5 text-[length:var(--text-12)] text-[var(--text-quaternary)]">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            {t('calendar.almanac.loading')}
          </p>
        )}

        {detail && (
          <>
            <div className="flex items-center gap-1.5">
              <span className="rounded-[var(--r-xs)] bg-[var(--bg-sunken)] px-1.5 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
                {t('calendar.almanac.inferred')}
              </span>
              <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('calendar.almanac.inferred_hint')}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[length:var(--text-12)] sm:grid-cols-3">
              <div><span className="text-[var(--text-quaternary)]">{t('calendar.almanac.ganzhi')}</span> <span className="tabular">{detail.ganZhiYear} {detail.ganZhiMonth} {detail.ganZhiDay}</span></div>
              <div><span className="text-[var(--text-quaternary)]">{t('calendar.almanac.nayin')}</span> {detail.naYin}</div>
              <div><span className="text-[var(--text-quaternary)]">{t('calendar.almanac.zhixing')}</span> {detail.zhiXing}</div>
              <div><span className="text-[var(--text-quaternary)]">{t('calendar.almanac.tianshen')}</span> {detail.tianShen} ({detail.tianShenLuck})</div>
              <div><span className="text-[var(--text-quaternary)]">{t('calendar.almanac.xiu')}</span> {detail.xiu}{detail.animal} ({detail.xiuLuck})</div>
              <div><span className="text-[var(--text-quaternary)]">{t('calendar.almanac.chong')}</span> {detail.chong} {detail.sha}</div>
            </div>
            <Section title={t('calendar.almanac.yi')}>
              <Chips values={detail.yi} tone="good" />
            </Section>
            <Section title={t('calendar.almanac.ji')}>
              <Chips values={detail.ji} tone="bad" />
            </Section>
            <div className="grid gap-2 sm:grid-cols-2">
              <Section title={t('calendar.almanac.jishen')}>
                <Chips values={detail.jiShen.slice(0, 10)} tone="plain" />
              </Section>
              <Section title={t('calendar.almanac.xiongsha')}>
                <Chips values={detail.xiongSha.slice(0, 10)} tone="plain" />
              </Section>
            </div>
            <Section title={t('calendar.almanac.hours')}>
              <div className="flex flex-wrap gap-1">
                {auspiciousHours(detail).map(hour => (
                  <span key={hour.zhi} className="rounded-[var(--r-xs)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--accent-on-soft)]">
                    {hour.zhi} {hour.window}
                  </span>
                ))}
              </div>
            </Section>
          </>
        )}

        {(onThisDay.length > 0 || todos !== null || renewals !== null || linkedError) && (
          <div className="border-t border-[var(--border-subtle)] pt-3">
            <div className="space-y-3">
              {onThisDay.length > 0 && (
                <Section title={t('calendar.almanac.countdowns')}>
                  <ul className="space-y-1">
                    {onThisDay.map((item) => {
                      const occurrence = countdownOccurrence(item, today)
                      return (
                        <li key={item.id} className="flex items-center gap-2 text-[length:var(--text-12)]">
                          <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: item.color || 'var(--accent)' }} />
                          <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{item.title}</span>
                          <span className="tabular text-[var(--text-quaternary)]">{t('calendar.countdown.ordinal', { n: occurrence.ordinal })}</span>
                        </li>
                      )
                    })}
                  </ul>
                </Section>
              )}

              {todos !== null && todos.length > 0 && (
                <Section title={t('calendar.almanac.todos')}>
                  <ul className="space-y-1">
                    {todos.map(task => (
                      <li key={task.id}>
                        <button
                          type="button"
                          onClick={() => void openTaskInTodo(task.id)}
                          className="flex w-full items-center gap-1.5 rounded-[var(--r-sm)] px-1 py-0.5 text-left text-[length:var(--text-12)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                        >
                          <ListChecks size={12} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />
                          <span className={cn('min-w-0 flex-1 truncate', task.status === 'done' && 'line-through text-[var(--text-quaternary)]')}>{task.title}</span>
                          <ArrowUpRight size={12} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {renewals !== null && renewals.length > 0 && (
                <Section title={t('calendar.almanac.renewals')}>
                  <ul className="space-y-1">
                    {renewals.map(item => (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => onJump('/subscriptions')}
                          className="flex w-full items-center gap-1.5 rounded-[var(--r-sm)] px-1 py-0.5 text-left text-[length:var(--text-12)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                        >
                          <CalendarClock size={12} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate">{item.name}</span>
                          {item.amount !== null && <span className="tabular text-[var(--text-tertiary)]">{item.currency} {item.amount}</span>}
                          <ArrowUpRight size={12} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {linkedError && (
                <p role="alert" className="flex items-center gap-1.5 text-[length:var(--text-11-5)] text-[var(--danger)]">
                  <RefreshCw size={12} aria-hidden="true" />
                  {t('calendar.almanac.link_failed')}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
