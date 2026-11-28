import { useCallback, useEffect, useRef } from 'react'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { useLibrary } from '../store/library'
import type { BookRecord } from '../types'

/** Long enough for a comment edit to settle, short enough to feel like part of the same action. */
const AUTO_NOTE_REFRESH_DELAY_MS = 500

/**
 * Keep the book's generated note in step with its highlights.
 *
 * The first change creates and links the note; later changes rewrite its generated section. The store is
 * read when the debounce fires so a burst of edits writes the latest marks, not the render that queued
 * them. Changing books or turning the setting off cancels work that has not started.
 */
export function useAutoReadingNote(book: BookRecord, enabled: boolean): () => void {
  const toast = useUi((state) => state.toast)
  const timerRef = useRef<number | null>(null)
  const latestRef = useRef({ book, enabled })
  latestRef.current = { book, enabled }

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  useEffect(() => clearTimer, [book.id, clearTimer])

  useEffect(() => {
    if (!enabled) clearTimer()
  }, [enabled, clearTimer])

  const scheduleRefresh = useCallback(() => {
    if (!latestRef.current.enabled) return
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      const current = latestRef.current
      if (!current.enabled) return
      void (async () => {
        try {
          const { ensureReadingNote } = await import('../reading-note')
          if (!latestRef.current.enabled || latestRef.current.book.id !== current.book.id) return
          const library = useLibrary.getState()
          const highlights = library.highlights[current.book.id] ?? []
          const existingNoteId = library.notes.byBook[current.book.id]
          const id = await ensureReadingNote(current.book, highlights, existingNoteId)
          if (!latestRef.current.enabled || latestRef.current.book.id !== current.book.id) return
          if (!id) {
            toast({ title: t('reading.note_failed'), tone: 'danger' })
            return
          }
          if (id !== existingNoteId) library.linkNote(current.book.id, id)
        } catch (error) {
          if (!latestRef.current.enabled || latestRef.current.book.id !== current.book.id) return
          toast({
            title: t('reading.note_failed'),
            description: error instanceof Error ? error.message : undefined,
            tone: 'danger',
          })
        }
      })()
    }, AUTO_NOTE_REFRESH_DELAY_MS)
  }, [clearTimer, toast])

  return scheduleRefresh
}
