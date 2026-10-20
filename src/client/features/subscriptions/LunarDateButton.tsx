/**
 * Picking a date by its lunar calendar name.
 *
 * The form's date field is the browser's own, which is the right control for a Gregorian date — it is
 * keyboard accessible, it is what a phone gives you, and it localises itself. What it cannot do is let a
 * reader name a month by its lunar sequence, which is how a birthday or an anniversary is actually
 * remembered for half the accounts this app serves. So the native field stays and this sits beside it.
 *
 * The day list is rebuilt from the month, not fixed at thirty: a lunar month is 29 or 30 days depending
 * on the year, and the thirtieth of the last month does not exist in most of them. Offering a day that
 * cannot be converted is how a reader ends up with a date that silently means something else.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Moon } from 'lucide-react'
import {
  LUNAR_MONTH_NAMES,
  LUNAR_RANGE_END,
  LUNAR_RANGE_START,
  leapDays,
  leapMonth,
  lunar2solar,
  lunarDayLabel,
  lunarLeapMonthLabel,
  lunarMonthLabel,
  monthDays,
  solar2lunar,
} from '@shared/subscriptions/lunar'
import { Button, IconButton } from '../../components/primitives'
import { Select } from '../../components/form'
import { useClickOutside, useEscape } from '../../components/overlay'
import { getLocale, t } from '../../lib/i18n'
import { Z_INDEX } from '../../lib/z-index'
import { cn } from '../../lib/cn'

/**
 * The panel's width, and the three columns inside it.
 *
 * The month column gets the flexible space because a leap month is named with three characters — the
 * leap marker (U+95F0) plus the two of the month it follows. At an equal three-column split the panel
 * clipped that name to two characters at exactly the year where it is the only correct answer. Year and
 * day only ever hold four digits or two characters, so they are pinned.
 */
const PANEL_WIDTH = 260
/** Years the picker opens with: a decade either side of today, with the full table behind a scroll. */
const NEARBY_YEARS = 10

/**
 * The month list's own marker for a leap month.
 *
 * A leap month takes the number of the month it follows, so the plain second month and the leap second
 * month are two different dates wearing the same number — which is why they are two options rather than a
 * list plus a checkbox. The checkbox shape let a reader mark "leap" against a month that has none, and the
 * only honest answer to that combination was a picker that refuses to fill anything.
 */
const LEAP_PREFIX = 'leap:'

function monthOption(month: number, isLeap: boolean): string {
  return isLeap ? `${LEAP_PREFIX}${month}` : String(month)
}

function parseMonthOption(option: string): { month: number, isLeap: boolean } {
  return option.startsWith(LEAP_PREFIX)
    ? { month: Number(option.slice(LEAP_PREFIX.length)), isLeap: true }
    : { month: Number(option), isLeap: false }
}

export function LunarDateButton({ value, onPick }: {
  /** The solar date currently in the field, as YYYY-MM-DD. */
  value: string
  onPick: (date: string) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  // The almanac's names are shown in the language the reader is reading the interface in, not in one
  // language only.
  const locale = getLocale()
  const wrapRef = useRef<HTMLDivElement>(null)
  const today = new Date()
  const [year, setYear] = useState(() => Number(value.slice(0, 4)) || today.getFullYear())
  const [month, setMonth] = useState(1)
  const [day, setDay] = useState(1)
  const [isLeap, setIsLeap] = useState(false)

  useEscape(open, () => setOpen(false))
  useClickOutside([wrapRef], open, () => setOpen(false))

  // Opening reads the field it sits beside, so the lunar date on screen is the one already chosen
  // rather than wherever the control was left after the last subscription.
  const openAt = (): void => {
    const parsed = Date.parse(`${value}T00:00:00Z`)
    if (Number.isFinite(parsed)) {
      const lunar = solar2lunar(
        new Date(parsed).getUTCFullYear(),
        new Date(parsed).getUTCMonth() + 1,
        new Date(parsed).getUTCDate(),
      )
      if (lunar) {
        setYear(lunar.year)
        setMonth(lunar.month)
        setDay(lunar.day)
        setIsLeap(lunar.isLeap)
      }
    }
    setOpen(true)
  }

  const leap = leapMonth(year)
  const maxDay = isLeap ? leapDays(year) : monthDays(year, month)
  const days = useMemo(() => Array.from({ length: maxDay }, (_, index) => index + 1), [maxDay])
  const years = useMemo(() => {
    const centre = Number.isFinite(Number(value.slice(0, 4))) && value.length === 10
      ? Number(value.slice(0, 4))
      : today.getFullYear()
    const from = Math.max(LUNAR_RANGE_START, centre - NEARBY_YEARS)
    const to = Math.min(LUNAR_RANGE_END, centre + NEARBY_YEARS)
    return Array.from({ length: to - from + 1 }, (_, index) => from + index)
  }, [value])

  const solar = lunar2solar({ year, month, day, isLeap })
  const iso = solar ? `${solar.year}-${String(solar.month).padStart(2, '0')}-${String(solar.day).padStart(2, '0')}` : null

  useEffect(() => {
    // A month that has no leap of its own, or a day the shorter month lost, must not linger selected:
    // moving the year is allowed to drop a choice, but not to leave one on screen that means nothing.
    if (isLeap && leap !== month) setIsLeap(false)
    if (day > maxDay) setDay(maxDay)
  }, [year, month, isLeap, day, maxDay, leap])

  return (
    <div ref={wrapRef} className="relative">
      <IconButton label={t('subscriptions.lunar.pick')} size="sm" active={open} onClick={openAt}>
        <Moon size={13} />
      </IconButton>
      {open && (
        <div
          className="absolute right-0 top-[calc(100%+4px)] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)]"
          style={{ width: PANEL_WIDTH, zIndex: Z_INDEX.pop }}
          role="group"
          aria-label={t('subscriptions.lunar.title')}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="grid grid-cols-[72px_minmax(0,1fr)_72px] gap-1">
            <Select
              aria-label={t('subscriptions.lunar.year')}
              value={String(year)}
              onChange={(event) => setYear(Number(event.target.value))}
              className="h-7 text-[length:var(--text-11-5)]"
            >
              {years.map((option) => <option key={option} value={option}>{option}</option>)}
            </Select>
            <Select
              aria-label={t('subscriptions.lunar.month')}
              value={monthOption(month, isLeap)}
              onChange={(event) => {
                const picked = parseMonthOption(event.target.value)
                setMonth(picked.month)
                setIsLeap(picked.isLeap)
              }}
              className="h-7 text-[length:var(--text-11-5)]"
            >
              {LUNAR_MONTH_NAMES.flatMap((_, index) => {
                const number = index + 1
                const plain = <option key={number} value={number}>{lunarMonthLabel(index, locale)}</option>
                // The leap month is listed where it falls in the sequence rather than pinned to the top,
                // so counting down the list lands on the month a reader is looking for.
                return leap === number
                  ? [plain, <option key={`leap-${number}`} value={monthOption(number, true)}>{lunarLeapMonthLabel(index, locale)}</option>]
                  : [plain]
              })}
            </Select>
            <Select
              aria-label={t('subscriptions.lunar.day')}
              value={String(day)}
              onChange={(event) => setDay(Number(event.target.value))}
              className="h-7 text-[length:var(--text-11-5)]"
            >
              {days.map((option) => <option key={option} value={option}>{lunarDayLabel(option, locale)}</option>)}
            </Select>
          </div>
          <p className={cn('mt-1.5 text-[length:var(--text-11)] tabular-nums', iso ? 'text-[var(--text-secondary)]' : 'text-[var(--danger)]')}>
            {iso ?? t('subscriptions.lunar.out_of_range')}
          </p>
          <div className="mt-1.5 flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{t('subscriptions.cancel')}</Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!iso}
              onClick={() => {
                if (iso) onPick(iso)
                setOpen(false)
              }}
            >
              {t('subscriptions.lunar.fill')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
