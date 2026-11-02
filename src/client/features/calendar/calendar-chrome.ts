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
import type { ICalendarApp } from '@dayflow/react'
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

  const decorate = (): void => {
    if (disposed) return
    const labels = narrowWeekdayLabels(options.locale, options.weekStart as WeekStartDay)
    options.root.querySelectorAll<HTMLElement>(COMPACT_LABELS).forEach((node, index) => {
      const next = labels[index]
      if (next && node.textContent !== next) node.textContent = next
    })

    const add = options.root.querySelector<HTMLButtonElement>(ADD_BUTTON)
    if (add) {
      if (add.title !== options.addLabel) add.title = options.addLabel
      if (add.getAttribute('aria-label') !== options.addLabel) add.setAttribute('aria-label', options.addLabel)
    }

    options.root.querySelectorAll<HTMLElement>(EVENT_SELECTOR).forEach((element) => {
      if (element.tabIndex !== 0) element.tabIndex = 0
      if (element.getAttribute('role') !== 'button') element.setAttribute('role', 'button')
      const name = eventAccessibleName(element, options.untitledLabel, options.allDayLabel)
      if (name && element.getAttribute('aria-label') !== name) element.setAttribute('aria-label', name)
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
  options.root.addEventListener('click', onClick, true)
  options.root.addEventListener('dblclick', onDoubleClick, true)
  options.root.addEventListener('keydown', onKeyDown, true)
  decorate()

  return () => {
    disposed = true
    observer.disconnect()
    options.root.removeEventListener('click', onClick, true)
    options.root.removeEventListener('dblclick', onDoubleClick, true)
    options.root.removeEventListener('keydown', onKeyDown, true)
    if (frame !== 0) window.cancelAnimationFrame(frame)
  }
}
