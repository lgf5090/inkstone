/**
 * The browser-facing polish DayFlow does not own.
 *
 * Three jobs live here because all of them are about the library's DOM rather than our data:
 *  - a click on an event selects it and opens our extras, instead of the library's full-screen
 *    mobile drawer on desktop;
 *  - every event gets a keyboard stop and an accessible name;
 *  - the compact week header and the header's add button speak the reader's language.
 *
 * The library re-renders its grid, so every job is mirrored by a MutationObserver. We only write
 * attributes and text it does not read, so the mirror cannot fight its render.
 */
import { getCalendarColorsForHex, type ICalendarApp } from '@dayflow/react'
import { narrowWeekdayLabels, type WeekStartDay } from '../../lib/time'

const EVENT_SELECTOR = '.df-event'
const REPEAT_MARKER = '::repeat-'
const COMPACT_LABELS = '.df-compact-header-labels .df-compact-header-label'
const ADD_BUTTON = '#dayflow-add-event-btn'

export interface CalendarChromeOptions {
  root: HTMLElement
  app: ICalendarApp
  locale: string
  weekStart: number
  /** The gesture that opens the library's editor. */
  detailTrigger: 'click' | 'dbClick'
  addLabel: string
  untitledLabel: string
  allDayLabel: string
  /** Desktop only: on a touch layout the library's sheet is the right editor. */
  interceptEvents: boolean
  onAdd: () => void
  onRecurring: () => void
  /** The reader pointed at this event; the surface owns the extras card and its dismissed state. */
  onSelect: (id: string) => void
  onOpenDetail: (id: string) => void
}

function elementOf(target: EventTarget | null): Element | null {
  if (!target) return null
  if (target instanceof Element) return target
  return target instanceof Node ? target.parentElement : null
}

export function eventElementOf(target: EventTarget | null): HTMLElement | null {
  const element = elementOf(target)
  return element?.closest<HTMLElement>(EVENT_SELECTOR) ?? null
}

export function eventIdOf(target: EventTarget | null): string | null {
  const id = eventElementOf(target)?.getAttribute('data-event-id')
  return id && id.length > 0 ? id : null
}

/** The name a screen reader gets for a grid event; the visual title/time are its only source. */
export function eventAccessibleName(element: HTMLElement, untitledLabel: string, allDayLabel: string): string {
  const title = element.querySelector('.df-event-title')?.textContent?.trim() ?? ''
  const time = element.querySelector('.df-event-time')?.textContent?.trim() ?? ''
  const when = element.getAttribute('data-all-day') === 'true' ? allDayLabel : time
  return [title || untitledLabel, when].filter(Boolean).join(' ')
}

export function attachCalendarChrome(options: CalendarChromeOptions): () => void {
  let frame = 0
  let disposed = false

  const paintEvent = (element: HTMLElement, hex: string): void => {
    if (hex) {
      try {
        const palette = getCalendarColorsForHex(hex)
        element.style.backgroundColor = palette.colors.eventColor
        element.style.color = palette.colors.textColor
        element.style.borderColor = palette.colors.lineColor
      } catch {
        // A provider may carry a colour this build cannot parse; the calendar colour stays.
      }
      return
    }
    element.style.removeProperty('background-color')
    element.style.removeProperty('color')
    element.style.removeProperty('border-color')
  }

  /**
   * The mobile week header is its own compressed grid, while the timed body moves a wide canvas under
   * a fixed time column. On a phone the canvas holds one column fewer than a week, centred on the
   * selected day, so the header has to follow both the body's column width and its day set — a fixed
   * seven-column strip put the first weekday label over a Wednesday column.
   */
  const syncCompactHeader = (): void => {
    const header = options.root.querySelector<HTMLElement>('.df-compact-header')
    const labels = options.root.querySelector<HTMLElement>('.df-compact-header-labels')
    const dates = options.root.querySelector<HTMLElement>('.df-compact-header-dates')
    const content = options.root.querySelector<HTMLElement>('.df-week-time-grid-content')
    const timeColumn = options.root.querySelector<HTMLElement>('.df-week-time-grid-time-column')
    const firstRow = options.root.querySelector<HTMLElement>('.df-time-grid-row')
    if (!header || !labels || !dates || !content || !timeColumn || !firstRow) return
    const columns = firstRow.querySelectorAll('.df-week-time-grid-cell').length
    if (columns < 1) return
    const headerRect = header.getBoundingClientRect()
    const contentRect = content.getBoundingClientRect()
    const column = contentRect.width / columns
    if (column <= 0) return
    const timeWidth = timeColumn.getBoundingClientRect().width
    const shift = contentRect.left - headerRect.left - timeWidth
    const selected = options.app.getCurrentDate()
    const key = `${columns}:${Math.round(column)}:${Math.round(shift)}:${Math.round(timeWidth)}:${selected.toDateString()}`
    header.dataset.inkstoneHeader = key
    for (const grid of [labels, dates]) {
      grid.style.gridTemplateColumns = `repeat(${columns}, ${column}px)`
      grid.style.width = `${column * columns}px`
      grid.style.marginLeft = `${Math.round(timeWidth)}px`
      grid.style.transform = `translateX(${Math.round(shift)}px)`
    }
    const rolling = columns < 7
    header.querySelector<HTMLElement>('.df-compact-header-capsule')?.style.setProperty('display', 'none')
    header.dataset.inkstoneRolling = rolling ? '1' : '0'
    const labelCells = [...labels.querySelectorAll<HTMLElement>('.df-compact-header-label-cell')]
    const dateButtons = [...dates.querySelectorAll<HTMLElement>('.df-compact-header-date-button')]
    // A six-column canvas is anchored two days before the selected one; the extra header cell is
    // clipped and every remaining cell is re-labelled to the day its column actually draws.
    const start = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate() - 2)
    const weekday = new Intl.DateTimeFormat(options.locale, { weekday: 'narrow' })
    const full = new Intl.DateTimeFormat(options.locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
    labelCells.forEach((cell, index) => {
      const visible = index < columns
      cell.style.display = visible ? '' : 'none'
      const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
      const text = rolling ? weekday.format(day) : narrowWeekdayLabels(options.locale, options.weekStart as WeekStartDay)[index] ?? ''
      const label = cell.querySelector<HTMLElement>('.df-compact-header-label')
      if (label && label.textContent !== text) label.textContent = text
    })
    dateButtons.forEach((button, index) => {
      const visible = index < columns
      button.style.display = visible ? '' : 'none'
      const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
      if (rolling) {
        button.dataset.inkstoneDay = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
        const pill = button.querySelector<HTMLElement>('.df-compact-header-date-pill')
        if (pill && pill.textContent !== String(day.getDate())) pill.textContent = String(day.getDate())
        const name = full.format(day)
        if (button.getAttribute('aria-label') !== name) button.setAttribute('aria-label', name)
      } else {
        delete button.dataset.inkstoneDay
      }
    })
  }

  const decorate = (): void => {
    if (disposed) return
    syncCompactHeader()
    const header = options.root.querySelector<HTMLElement>('.df-compact-header')
    if (header?.dataset.inkstoneRolling !== '1') {
      const labels = narrowWeekdayLabels(options.locale, options.weekStart as WeekStartDay)
      options.root.querySelectorAll<HTMLElement>(COMPACT_LABELS).forEach((node, index) => {
        const next = labels[index]
        if (next && node.textContent !== next) node.textContent = next
      })
    }

    const add = options.root.querySelector<HTMLButtonElement>(ADD_BUTTON)
    if (add) {
      if (add.title !== options.addLabel) add.title = options.addLabel
      if (add.getAttribute('aria-label') !== options.addLabel) add.setAttribute('aria-label', options.addLabel)
    }

    // One map per pass: looking each event up in the app array made a dense month quadratic.
    const byId = new Map(options.app.getEvents().map(event => [event.id, event]))
    options.root.querySelectorAll<HTMLElement>(EVENT_SELECTOR).forEach((element) => {
      if (element.tabIndex !== 0) element.tabIndex = 0
      if (element.getAttribute('role') !== 'button') element.setAttribute('role', 'button')
      const name = eventAccessibleName(element, options.untitledLabel, options.allDayLabel)
      if (name && element.getAttribute('aria-label') !== name) element.setAttribute('aria-label', name)
      const id = element.getAttribute('data-event-id')
      const color = id ? byId.get(id)?.meta?.color : undefined
      const hex = typeof color === 'string' ? color : ''
      const applied = element.dataset.inkstoneColor
      // The library paints the block's own colour inline. On the first pass there is nothing of ours
      // to replace, so an event with no per-event colour must keep that inline paint untouched; only a
      // colour this bridge applied earlier is removed when the reader clears it.
      if (applied === undefined) {
        element.dataset.inkstoneColor = hex
        if (hex) paintEvent(element, hex)
      } else if (applied !== hex) {
        element.dataset.inkstoneColor = hex
        paintEvent(element, hex)
      }
    })
  }

  const schedule = (): void => {
    if (disposed || frame !== 0) return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      decorate()
    })
  }

  const onClick = (nativeEvent: MouseEvent): void => {
    const target = nativeEvent.target
    if (elementOf(target)?.closest(ADD_BUTTON)) {
      nativeEvent.preventDefault()
      nativeEvent.stopImmediatePropagation()
      options.onAdd()
      return
    }
    // A re-labelled compact header cell has to navigate to the day it now shows; the library bound its
    // handler to the date the cell had before the header was mirrored onto the body's rolling window.
    const headerDay = elementOf(target)?.closest<HTMLElement>('.df-compact-header-date-button')?.dataset.inkstoneDay
    if (headerDay) {
      nativeEvent.preventDefault()
      nativeEvent.stopImmediatePropagation()
      const [year, month, day] = headerDay.split('-').map(Number) as [number, number, number]
      options.app.setCurrentDate(new Date(year, month - 1, day))
      return
    }
    if (!options.interceptEvents) return
    const id = eventIdOf(target)
    if (!id) return
    nativeEvent.preventDefault()
    nativeEvent.stopImmediatePropagation()
    if (id.includes(REPEAT_MARKER)) {
      options.onRecurring()
      return
    }
    options.app.selectEvent(id)
    options.app.highlightEvent(id)
    options.onSelect(id)
    if (options.detailTrigger === 'click') options.onOpenDetail(id)
  }

  const onDoubleClick = (nativeEvent: MouseEvent): void => {
    if (!options.interceptEvents) return
    const id = eventIdOf(nativeEvent.target)
    if (!id) return
    nativeEvent.preventDefault()
    nativeEvent.stopImmediatePropagation()
    if (id.includes(REPEAT_MARKER) || options.detailTrigger === 'click') return
    options.app.selectEvent(id)
    options.app.highlightEvent(id)
    options.onOpenDetail(id)
  }

  const onKeyDown = (nativeEvent: KeyboardEvent): void => {
    const target = elementOf(nativeEvent.target)
    const element = target?.closest<HTMLElement>(EVENT_SELECTOR)
    if (!element) return
    const id = element.getAttribute('data-event-id')
    if (!id) return
    if (nativeEvent.key === 'Enter' || nativeEvent.key === ' ') {
      nativeEvent.preventDefault()
      nativeEvent.stopImmediatePropagation()
      if (id.includes(REPEAT_MARKER)) {
        options.onRecurring()
        return
      }
      options.app.selectEvent(id)
      options.app.highlightEvent(id)
      options.onSelect(id)
      options.onOpenDetail(id)
      return
    }
    if (nativeEvent.key !== 'ArrowDown' && nativeEvent.key !== 'ArrowRight'
      && nativeEvent.key !== 'ArrowUp' && nativeEvent.key !== 'ArrowLeft') return
    const events = [...options.root.querySelectorAll<HTMLElement>(EVENT_SELECTOR)]
    const index = events.indexOf(element)
    if (index < 0) return
    const delta = nativeEvent.key === 'ArrowDown' || nativeEvent.key === 'ArrowRight' ? 1 : -1
    const next = events[index + delta]
    if (!next) return
    nativeEvent.preventDefault()
    nativeEvent.stopImmediatePropagation()
    next.focus({ preventScroll: true })
  }

  const observer = new MutationObserver(schedule)
  observer.observe(options.root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-event-id', 'data-all-day'],
  })
  // The timed canvas announces its horizontal position by rewriting its own transform, so a header
  // that follows it has to hear that one attribute instead of every event repaint.
  const layoutObserver = new MutationObserver((records) => {
    const moved = records.some(record => record.type === 'attributes'
      && (record.target instanceof Element)
      && record.target.classList.contains('df-week-time-grid-content'))
    if (moved) schedule()
  })
  layoutObserver.observe(options.root, { attributes: true, subtree: true, attributeFilter: ['style'] })
  const onResize = (): void => {
    const header = options.root.querySelector<HTMLElement>('.df-compact-header')
    if (header) delete header.dataset.inkstoneHeader
    schedule()
  }
  window.addEventListener('resize', onResize)
  options.root.addEventListener('click', onClick, true)
  options.root.addEventListener('dblclick', onDoubleClick, true)
  options.root.addEventListener('keydown', onKeyDown, true)
  decorate()

  return () => {
    disposed = true
    observer.disconnect()
    layoutObserver.disconnect()
    window.removeEventListener('resize', onResize)
    options.root.removeEventListener('click', onClick, true)
    options.root.removeEventListener('dblclick', onDoubleClick, true)
    options.root.removeEventListener('keydown', onKeyDown, true)
    if (frame !== 0) window.cancelAnimationFrame(frame)
  }
}
