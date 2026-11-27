/** Assemble the event write queue and the durable offline outbox around one surface lifetime. */
import { useEffect, useRef, type RefObject } from 'react'
import type { ICalendarApp } from '@dayflow/react'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { toastFailure } from './calendar-notifications'
import { enqueueOutbox, flushOutbox, removeOutbox } from './offline-outbox'
import { EventPersistence, type ConflictRequest, type RecurrenceOccurrenceRequest } from './persistence'
import type { CalendarEditHistory } from './history'

interface UseCalendarPersistenceOptions {
  app: ICalendarApp
  userId: string | undefined
  revs: Map<string, number>
  history: CalendarEditHistory
  persistenceRef: RefObject<EventPersistence | null>
  timeZone: () => string
  fallbackTitle: () => string
  onServerState: (eventId?: string, status?: number) => void | Promise<void>
  onConflict: (request: ConflictRequest) => void | Promise<void>
  onRecurringEdit: () => void
  onRecurrenceOccurrence: (request: RecurrenceOccurrenceRequest) => void
  onReadOnlyEdit: () => void
  onCommitted: (id: string, recurring: boolean) => void
  onDeleted: (id: string, title: string | undefined) => void
  onHistoryChange: () => void
}

export function useCalendarPersistence({
  app,
  userId,
  revs,
  history,
  persistenceRef,
  timeZone,
  fallbackTitle,
  onServerState,
  onConflict,
  onRecurringEdit,
  onRecurrenceOccurrence,
  onReadOnlyEdit,
  onCommitted,
  onDeleted,
  onHistoryChange,
}: UseCalendarPersistenceOptions): void {
  const accountRef = useRef<string | null>(null)
  accountRef.current = userId ?? null

  useEffect(() => {
    const persistence = new EventPersistence({
      app,
      revs,
      history,
      timeZone,
      fallbackTitle,
      onServerState,
      onError: error => toastFailure(t('calendar.error.save_failed'), error),
      onConflict: request => { void onConflict(request) },
      onRecurringEdit,
      onRecurrenceOccurrence,
      onOffline: async (entry) => {
        const account = accountRef.current
        if (!account) {
          toastFailure(t('calendar.error.save_failed'), new Error('No signed-in account is available for offline sync.'))
          return false
        }
        try {
          if (entry.kind === 'delete') {
            const rev = entry.rev
            if (rev === null) {
              await removeOutbox(account, entry.eventId)
              return true
            }
            await enqueueOutbox(account, { ...entry, rev, at: Date.now() })
          } else {
            await enqueueOutbox(account, { ...entry, at: Date.now() })
          }
        } catch (error) {
          toastFailure(t('calendar.error.save_failed'), error)
          return false
        }
        useUi.getState().toast({ title: t('calendar.offline.queued'), tone: 'warning' })
        return true
      },
      onReadOnlyEdit,
      onCommitted: (id, recurring) => {
        onHistoryChange()
        onCommitted(id, recurring)
      },
      onDeleted: (id, title) => {
        onHistoryChange()
        onDeleted(id, title)
      },
    })
    persistenceRef.current = persistence
    const dispose = persistence.start()
    return () => {
      dispose()
      persistenceRef.current = null
    }
  }, [
    app,
    fallbackTitle,
    history,
    onCommitted,
    onConflict,
    onDeleted,
    onHistoryChange,
    onReadOnlyEdit,
    onRecurrenceOccurrence,
    onRecurringEdit,
    onServerState,
    persistenceRef,
    revs,
    timeZone,
  ])

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    const flush = async (): Promise<void> => {
      try {
        const result = await flushOutbox(userId, {
          onConflict: request => {
            persistenceRef.current?.acceptConflict(request)
            void onConflict(request)
          },
        })
        if (cancelled) return
        if (result.dropped > 0) {
          useUi.getState().toast({
            title: t('calendar.sync.failed', { name: t('calendar.app.title') }),
            tone: 'danger',
          })
        }
        if (result.flushed > 0 || result.dropped > 0) await onServerState()
      } catch (error) {
        if (!cancelled) toastFailure(t('calendar.error.save_failed'), error)
      }
    }
    void flush()
    const online = (): void => { void flush() }
    window.addEventListener('online', online)
    return () => {
      cancelled = true
      window.removeEventListener('online', online)
    }
  }, [onConflict, onServerState, persistenceRef, userId])
}
