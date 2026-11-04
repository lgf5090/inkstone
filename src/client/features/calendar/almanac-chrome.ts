/**
 * The almanac line inside DayFlow's month cells.
 *
 * The library's month grid has no slot for a second line under the day number — `monthDateNumberContent`
 * exists in its type declarations but the React wrapper never forwards it — so the label is written
 * into the cell the same way the event chrome writes accessible names: after each of the library's
 * renders, mirrored by a MutationObserver, touching only text it never reads.
 *
 * The label is a real `<button>`, not a decorated span: it has to be reachable by keyboard and expose
 * an accessible name that says the full lunar date and the holiday, and a click on it must not be
 * mistaken for a click on the cell (which navigates to the week view).
 */

import type { CalendarDayAlmanac } from './almanac'
import { monthAlmanac } from './almanac'

const CELL = '.df-month-day-cell'
const NUMBER_CONTAINER = '.df-month-date-number-container'
/** The attribute the injected label carries, so a re-render finds it instead of adding a second one. */
const MARK_ATTR = 'data-inkstone-almanac'
const MARK_SELECTOR = `[${MARK_ATTR}]`

export interface AlmanacChromeOptions {
  root: HTMLElement
  weekStart: number
  /** Print the lunar day and festival names under each number. */
  showAlmanac: boolean
  /** Print the day-off and makeup-workday marks for statutory days. */
  showHolidayMarks: boolean
  /** The reader's language, only used to rebuild the cell's tooltip text. */
  formatDate: (key: string) => string
  labelOf: (info: CalendarDayAlmanac) => string | null
  holidayLabel: (info: CalendarDayAlmanac) => string | null
  onOpenDay: (key: string) => void
}

function dayKey(cell: HTMLElement): string | null {
  const key = cell.dataset.date ?? ''
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null
}

/** The month the grid is drawing, from the first cell of a row rather than from the cursor. */
function monthOf(key: string): { year: number; month: number } {
  const [year, month] = key.split('-').map(Number) as [number, number]
  return { year, month }
}

export function attachAlmanacChrome(options: AlmanacChromeOptions): () => void {
  let frame = 0
  let disposed = false

  const decorate = (): void => {
    if (disposed) return
    const cells = options.root.querySelectorAll<HTMLElement>(`${CELL}[data-date]`)
    if (cells.length === 0) return
    const firstKey = dayKey(cells[0]!)
    if (!firstKey) return
    const { year, month } = monthOf(firstKey)
    // One month map per render pass: the library draws exactly one month at a time, and this is the
    // lookup every cell below reads instead of running the lunar tables itself.
    const map = monthAlmanac(year, month, options.weekStart)

    for (const cell of cells) {
      const key = dayKey(cell)
      const container = cell.querySelector<HTMLElement>(NUMBER_CONTAINER)
      if (!key || !container) continue
      const info = map.get(key)
      if (!info) continue
      const label = options.showAlmanac ? options.labelOf(info) : null
      const holiday = options.showHolidayMarks ? options.holidayLabel(info) : null
      if (!label && !holiday) {
        container.querySelector(MARK_SELECTOR)?.remove()
        continue
      }

      let mark = container.querySelector<HTMLButtonElement>(MARK_SELECTOR)
      if (!mark) {
        mark = document.createElement('button')
        mark.type = 'button'
        mark.setAttribute(MARK_ATTR, key)
        mark.className = 'cal-almanac-mark'
        container.append(mark)
      }
      mark.setAttribute(MARK_ATTR, key)
      const text = [options.formatDate(key), label, holiday].filter(Boolean).join(' ')
      if (mark.getAttribute('aria-label') !== text) mark.setAttribute('aria-label', text)
      if (mark.textContent !== (label ?? '')) {
        mark.textContent = label ?? ''
        mark.toggleAttribute('data-empty', !label)
      }
      if (holiday) {
        if (mark.dataset.holiday !== holiday) {
          mark.dataset.holiday = holiday
          mark.dataset.off = info.holiday.off ? 'true' : 'false'
        }
      } else if (mark.hasAttribute('data-holiday')) {
        mark.removeAttribute('data-holiday')
        mark.removeAttribute('data-off')
      }
      // The festival name outranks the lunar number visually, and a statutory day off outranks both:
      // it is the one line a reader scans the month for.
      mark.dataset.festival = info.festivalShort ? 'true' : 'false'
      mark.dataset.term = info.solarTerm ? 'true' : 'false'
    }
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
  }
}
