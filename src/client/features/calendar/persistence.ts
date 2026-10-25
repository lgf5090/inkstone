/**
 * The event write queue.
 *
 * DayFlow announces every mutation through `subscribeEventChanges`; this is the only place those
 * announcements become API calls. Changes for the same event coalesce over a short debounce and are
 * then written one at a time, so a fast sequence of edits lands as its final state instead of a race
 * of PATCHes. A rejected write either refreshes the affected range (the server is authoritative) or
 * is retried once and then reported — never dropped silently.
 */
import type { Event, EventChange, ICalendarApp } from '@dayflow/react'
import { ApiError } from '../../lib/api'
import * as api from './api'
import type { CalendarEditHistory } from './history'
import { toEventInput, eventCalendarIds } from './model'

const DEBOUNCE_MS = 150
const RETRY_DELAY_MS = 400
const RECURRING_NOTICE_MS = 3000
/** A conflict, a vanished event or a schema refusal all mean "reload; do not keep retrying". */
const RELOAD_STATUSES = new Set([400, 404, 409])

type Intent =
  | { kind: 'save'; event: Event; remote: boolean }
  | { kind: 'delete'; remote: boolean }

interface Draft {
  before: Event | null
  after: Event | null
}

export interface EventPersistenceOptions {
  app: ICalendarApp
  revs: Map<string, number>
  history: CalendarEditHistory
  timeZone: () => string
  fallbackTitle: () => string
  /** Re-fetch the last range and reapply it as `source: 'remote'`. */
  onServerState: (eventId: string, status: number) => void | Promise<void>
  onError: (error: unknown) => void
  onConflict: (error: unknown) => void
  onRecurringEdit: () => void
  onDeleted?: (id: string, title: string | undefined) => void
}

function isOccurrence(change: EventChange): boolean {
  const event = change.type === 'update' ? change.after : change.event
  return Boolean(event._recurrenceMasterId) || event.id.includes('::repeat-')
}

function changeEvent(change: EventChange): Event {
  return change.type === 'update' ? change.after : change.event
}

function isPermanent(error: unknown): boolean {
  return error instanceof ApiError && !error.isOffline && error.status >= 400 && error.status < 500
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

export class EventPersistence {
  private readonly options: EventPersistenceOptions
  private readonly pending = new Map<string, Intent>()
  private readonly drafts = new Map<string, Draft>()
  private readonly skipped = new Set<string>()
  private unsubscribe: (() => void) | null = null
  private timer: number | undefined
  private recurringTimer: number | undefined
  private flushing = false
  private notifiedRecurring = false

  constructor(options: EventPersistenceOptions) {
    this.options = options
  }

  start(): () => void {
    this.unsubscribe = this.options.app.subscribeEventChanges(changes => {
      for (const change of changes) this.accept(change)
    })
    return () => this.dispose()
  }

  /** Server state about to be re-applied: its echo must not be written back. */
  skip(ids: Iterable<string>): void {
    for (const id of ids) this.skipped.add(id)
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    window.clearTimeout(this.timer)
    window.clearTimeout(this.recurringTimer)
    this.timer = undefined
    if (this.pending.size > 0) void this.flush()
  }

  private accept(change: EventChange): void {
    const event = changeEvent(change)
    const id = event.id

    if (this.skipped.delete(id)) return

    // Generated recurrence occurrences are a view of their series. A remote recalculation is normal;
    // a local edit of one cannot be mapped back to the master with the current API, so it is refused
    // rather than written as a dirty `::repeat-` row.
    if (isOccurrence(change)) {
      if (change.source !== 'remote') this.reportRecurring()
      return
    }

    const calendarIds = eventCalendarIds(event)
    if (change.source !== 'remote'
      && calendarIds.length > 0
      && !calendarIds.some(id => this.options.app.canMutateFromUI(id))) return

    const draft = this.drafts.get(id)
    if (change.source !== 'remote') {
      if (change.type === 'create') {
        this.drafts.set(id, { before: draft?.before ?? null, after: change.event })
      } else if (change.type === 'update') {
        this.drafts.set(id, { before: draft?.before ?? change.before, after: change.after })
      } else {
        this.drafts.set(id, { before: draft?.before ?? change.event, after: null })
      }
    }

    const remote = change.source === 'remote'
    if (change.type === 'delete') this.pending.set(id, { kind: 'delete', remote })
    else this.pending.set(id, { kind: 'save', event: event, remote })

    this.schedule()
  }

  private schedule(delay = DEBOUNCE_MS): void {
    if (this.timer !== undefined || this.flushing) return
    this.timer = window.setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, delay)
  }

  private async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      const entries = [...this.pending.entries()]
      this.pending.clear()
      for (const [id, intent] of entries) await this.persist(id, intent)
    } finally {
      this.flushing = false
      if (this.pending.size > 0) this.schedule(0)
    }
  }

  private async persist(id: string, intent: Intent): Promise<void> {
    try {
      await this.attempt(id, intent)
    } catch (error) {
      if (isPermanent(error) && error instanceof ApiError && RELOAD_STATUSES.has(error.status)) {
        this.drafts.delete(id)
        this.options.onConflict(error)
        await this.options.onServerState(id, error.status)
        return
      }
      if (isPermanent(error)) {
        this.drafts.delete(id)
        this.options.onError(error)
        return
      }
      // A transport failure or a 5xx may be transient: one retry, then the reader is told.
      try {
        await wait(RETRY_DELAY_MS)
        await this.attempt(id, intent)
      } catch (retryError) {
        this.drafts.delete(id)
        this.options.onError(retryError)
      }
    }
  }

  private async attempt(id: string, intent: Intent): Promise<void> {
    const rev = this.options.revs.get(id)
    if (intent.kind === 'delete') {
      if (rev === undefined) {
        // Created and deleted before either reached the server: there is nothing to delete.
        this.drafts.delete(id)
        return
      }
      const title = this.drafts.get(id)?.before?.title
      await api.deleteEvent(id, rev)
      this.options.revs.delete(id)
      this.commitDraft(id)
      this.options.onDeleted?.(id, title)
      return
    }

    const input = toEventInput(intent.event, {
      fallbackTitle: this.options.fallbackTitle(),
      timeZone: this.options.timeZone(),
    })
    if (rev === undefined) {
      const created = intent.remote
        ? (await api.createEvents([input], 'upsert'))[0]
        : await api.createEvent(input)
      if (!created) throw new Error('The calendar server did not return the saved event')
      this.options.revs.set(id, created.rev)
    } else {
      const updated = await api.updateEvent(id, input, rev)
      this.options.revs.set(id, updated.rev)
    }
    this.commitDraft(id)
  }

  private commitDraft(id: string): void {
    const draft = this.drafts.get(id)
    if (!draft) return
    this.drafts.delete(id)
    this.options.history.record({ id, before: draft.before, after: draft.after })
  }

  private reportRecurring(): void {
    if (this.notifiedRecurring) return
    this.notifiedRecurring = true
    this.options.onRecurringEdit()
    window.clearTimeout(this.recurringTimer)
    this.recurringTimer = window.setTimeout(() => {
      this.notifiedRecurring = false
    }, RECURRING_NOTICE_MS)
  }
}
