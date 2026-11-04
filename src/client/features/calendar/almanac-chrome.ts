/**
 * The month grid's week column and almanac line.
 *
 * DayFlow's month view has no slot for either. `monthDateNumberContent` exists in its type
 * declarations but the React wrapper never forwards it, and its own week number is drawn *inside*
 * the first cell of every row, which is exactly where the lunar line needs to sit. Both are
 * therefore written into the grid after each of the library's renders, mirrored by a
 * MutationObserver, touching only text the library never reads.
 *
 * The week column is a real gutter rather than a decoration: the row's shell is indented by one
 * fixed width and the number is positioned in that indent, so the seven day cells keep their own
 * geometry and the event layer — which is absolutely positioned against the same shell — is moved
 * with it. A number drawn inside a cell would push the day number and the lunar line together,
 * which is the overlap this replaces.
 *
 * The lunar line is a real `<button>`: it has to be reachable by keyboard and carry an accessible
 * name that says the date, the lunar date and the holiday, and a click on it must not be mistaken
 * for a click on the cell (which navigates to the week view).
 */

import { Temporal } from 'temporal-polyfill'
import type { CalendarDayAlmanac } from './almanac'
import { gridAlmanac } from './almanac'
import { weekOrdinal, type WeekStartDay } from '../../lib/time'

const CELL = '.df-month-day-cell'
const ROW_GRID = '.df-month-week-grid'
const ROW_SHELL = '.df-month-week-grid-shell'
const HEADER_GRID = '.df-week-header-row .df-week-grid'
const NUMBER_CONTAINER = '.df-month-date-number-container'
/** The attribute the injected label carries, so a re-render finds it instead of adding a second one. */
const MARK_ATTR = 'data-inkstone-almanac'
const MARK_SELECTOR = `[${MARK_ATTR}]`
const WEEK_SHELL_CLASS = 'cal-week-shell'
const WEEK_NUMBER_CLASS = 'cal-week-number'
const WEEK_HEAD_CLASS = 'cal-week-head-pad'

export interface AlmanacChromeOptions {
  root: HTMLElement
  weekStart: number
  /** Print the lunar day, solar term and festival names under each number. */
  showAlmanac: boolean
  /** Print the day-off and makeup-workday marks for statutory days. */
  showHolidayMarks: boolean
  /** Draw the ISO week gutter on the left of the grid. */
  showWeekColumn: boolean
  /** The reader's language, used to rebuild the cell's accessible name. */
  formatDate: (key: string) => string
  /** The week gutter's accessible name, e.g. "week 46 of 2026". */
  weekLabel: (week: number, year: number) => string
  labelOf: (info: CalendarDayAlmanac) => string | null
  holidayLabel: (info: CalendarDayAlmanac) => string | null
  onOpenDay: (key: string) => void
}

function dayKey(cell: HTMLElement): string | null {
  const key = cell.dataset.date ?? ''
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null
}

function localDateOf(key: string): Date {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, day)
}

/** The first dated cell of a row, skipping the week gutter this module inserts. */
function firstDateCell(grid: Element): HTMLElement | null {
  return grid.querySelector<HTMLElement>(`${CELL}[data-date]`)
}

function removeWeekColumn(root: HTMLElement): void {
  root.querySelectorAll(`.${WEEK_SHELL_CLASS}`).forEach(node => node.classList.remove(WEEK_SHELL_CLASS))
  root.querySelectorAll(`.${WEEK_NUMBER_CLASS}`).forEach(node => node.remove())
  root.querySelectorAll(`.${WEEK_HEAD_CLASS}`).forEach(node => node.classList.remove(WEEK_HEAD_CLASS))
}

export function attachAlmanacChrome(options: AlmanacChromeOptions): () => void {
  let frame = 0
  let disposed = false

  const ensureWeekNumber = (shell: HTMLElement, week: number, year: number): void => {
    let number = shell.querySelector<HTMLElement>(`.${WEEK_NUMBER_CLASS}`)
    if (number === null) {
      number = document.createElement('span')
      number.className = WEEK_NUMBER_CLASS
      shell.append(number)
    }
    const text = String(week)
    if (number.textContent !== text) number.textContent = text
    const label = options.weekLabel(week, year)
    if (number.getAttribute('aria-label') !== label) number.setAttribute('aria-label', label)
  }

  const drawWeekColumn = (): void => {
    if (!options.showWeekColumn) {
      removeWeekColumn(options.root)
      return
    }
    const grids = options.root.querySelectorAll<HTMLElement>(ROW_GRID)
    for (const grid of grids) {
      const first = firstDateCell(grid)
      const key = first ? dayKey(first) : null
      const shell = grid.closest<HTMLElement>(ROW_SHELL)
      if (!key || !shell) continue
      const ordinal = weekOrdinal(localDateOf(key), options.weekStart as WeekStartDay)
      shell.classList.add(WEEK_SHELL_CLASS)
      ensureWeekNumber(shell, ordinal.week, ordinal.year)
    }
    for (const header of options.root.querySelectorAll<HTMLElement>(HEADER_GRID)) {
      header.classList.add(WEEK_HEAD_CLASS)
    }
  }

  const ensureMark = (container: HTMLElement, key: string): HTMLButtonElement => {
    let mark = container.querySelector<HTMLButtonElement>(MARK_SELECTOR)
    if (mark === null) {
      mark = document.createElement('button')
      mark.type = 'button'
      mark.className = 'cal-almanac-mark'
      const text = document.createElement('span')
      text.className = 'cal-almanac-text'
      const badge = document.createElement('span')
      badge.className = 'cal-almanac-badge'
      mark.append(text, badge)
      container.append(mark)
    }
    mark.setAttribute(MARK_ATTR, key)
    return mark
  }

  const decorateCells = (): void => {
    const cells = options.root.querySelectorAll<HTMLElement>(`${CELL}[data-date]`)
    if (cells.length === 0) return
    const firstKey = dayKey(cells[0]!)
    const lastKey = dayKey(cells[cells.length - 1]!)
    if (!firstKey || !lastKey) return
    // One window for the whole grid, counted from the cell the grid opens with. Deriving it from
    // the month instead left the trailing week of a six-week grid unresolved, and continuous
    // scrolling draws ten rows, so the length comes from the cells rather than a constant.
    const span = Math.round((Date.parse(`${lastKey}T00:00:00Z`) - Date.parse(`${firstKey}T00:00:00Z`)) / 86_400_000) + 1
    const map = gridAlmanac(Temporal.PlainDate.from(firstKey), options.weekStart, Math.max(42, span))

    for (const cell of cells) {
      const key = dayKey(cell)
      const container = cell.querySelector<HTMLElement>(NUMBER_CONTAINER)
      if (!key || !container) continue
      const info = map.get(key)
      if (!info) continue
      const label = options.showAlmanac ? options.labelOf(info) : ''
      const holiday = options.showHolidayMarks ? options.holidayLabel(info) : ''
      if (!label && !holiday) {
        container.querySelector(MARK_SELECTOR)?.remove()
        continue
      }

      const mark = ensureMark(container, key)
      // The date number is wider than two digits on the first of a month ("1 October"), and its
      // width is the only thing that decides where the label has to stop. Measured here and handed
      // to CSS as a custom property, so no cell's label can run under its own number.
      const number = container.querySelector<HTMLElement>('.df-month-date-number')
      if (number) {
        // The reserve is the whole right-hand box, padding included, measured from the container's
        // edge to the number's left side: a fixed pixel guess was what cut the label to one
        // character on a phone and pushed it under the number on the first of a month.
        const reserve = Math.ceil(container.getBoundingClientRect().right - number.getBoundingClientRect().left)
        container.style.setProperty('--cal-number-width', `${reserve}px`)
      }
      const text = mark.querySelector<HTMLElement>('.cal-almanac-text')
      const badge = mark.querySelector<HTMLElement>('.cal-almanac-badge')
      if (text && text.textContent !== label) text.textContent = label
      if (badge) {
        const shown = holiday || ''
        if (badge.textContent !== shown) badge.textContent = shown
        badge.toggleAttribute('hidden', shown === '')
        badge.toggleAttribute('data-off', Boolean(holiday) && info.holiday.off)
      }
      const name = [options.formatDate(key), label, holiday].filter(Boolean).join(' ')
      if (mark.getAttribute('aria-label') !== name) mark.setAttribute('aria-label', name)
      mark.dataset.festival = info.festivalShort ? 'true' : 'false'
      mark.dataset.term = info.solarTerm ? 'true' : 'false'
      mark.dataset.lunar = label ? 'true' : 'false'
    }
  }

  const decorate = (): void => {
    if (disposed) return
    drawWeekColumn()
    decorateCells()
  }

  const schedule = (): void => {
    if (disposed || frame !== 0) return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      decorate()
    })
  }

  const onClick = (nativeEvent: MouseEvent): void => {
    const mark = (nativeEvent.target instanceof Element)
      ? nativeEvent.target.closest<HTMLElement>(MARK_SELECTOR)
      : null
    if (!mark) return
    // The cell's own handler would switch to the week view; the label speaks for the almanac instead.
    nativeEvent.preventDefault()
    nativeEvent.stopImmediatePropagation()
    const key = mark.getAttribute(MARK_ATTR)
    if (key) options.onOpenDay(key)
  }

  const observer = new MutationObserver(schedule)
  observer.observe(options.root, { childList: true, subtree: true })
  options.root.addEventListener('click', onClick, true)
  decorate()

  return () => {
    disposed = true
    observer.disconnect()
    options.root.removeEventListener('click', onClick, true)
    if (frame !== 0) window.cancelAnimationFrame(frame)
    options.root.querySelectorAll(MARK_SELECTOR).forEach(node => node.remove())
    removeWeekColumn(options.root)
  }
}
