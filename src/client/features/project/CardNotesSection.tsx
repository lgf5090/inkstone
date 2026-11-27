import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { FileText, Link2, Plus, Search, Trash2 } from 'lucide-react'
import type { ProjectCardNoteLink } from '@shared/project/model'
import { t, useLocale } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { LoadingBlock } from '../../components/feedback'
import { confirm, Modal } from '../../components/overlay'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { fetchCardNotes, linkCardNote, searchLinkableNotes, unlinkCardNote } from './api'

export function CardNotesSection({ cardId, canEdit }: { cardId: string, canEdit: boolean }): ReactElement {
  const locale = useLocale()
  const toast = useUi((state) => state.toast)
  const [notes, setNotes] = useState<ProjectCardNoteLink[] | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<{ id: string, title: string }>>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setNotes(null)
    setError(false)
    fetchCardNotes(cardId, controller.signal)
      .then(setNotes)
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [cardId, attempt])

  useEffect(() => {
    if (!pickerOpen) return
    const controller = new AbortController()
    setSearching(true)
    const timer = window.setTimeout(() => {
      searchLinkableNotes(query.trim(), controller.signal)
        .then((response) => setResults(response.results.map((hit) => ({ id: hit.note.id, title: hit.note.title }))))
        .catch(() => { if (!controller.signal.aborted) setResults([]) })
        .finally(() => { if (!controller.signal.aborted) setSearching(false) })
    }, 250)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [pickerOpen, query])

  const openNote = useCallback((noteId: string) => { void useNotes.getState().openNote(noteId) }, [])
  const add = async (noteId: string): Promise<void> => {
    try {
      await linkCardNote(cardId, noteId)
      setPickerOpen(false)
      setQuery('')
      setAttempt((current) => current + 1)
    } catch (cause: unknown) {
      toast({ title: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    }
  }
  const remove = async (noteId: string): Promise<void> => {
    const ok = await confirm({ title: t('project.card.unlink_note_confirm'), tone: 'danger', confirmLabel: t('common.delete') })
    if (!ok) return
    try {
      await unlinkCardNote(cardId, noteId)
      setAttempt((current) => current + 1)
    } catch (cause: unknown) {
      toast({ title: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    }
  }

  return (
    <section aria-label={t('project.card.notes')} className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]"><Link2 size={13} aria-hidden="true" />{t('project.card.notes')}</h3>
        {canEdit && <IconButton label={t('project.card.link_note')} size="sm" onClick={() => setPickerOpen(true)}><Plus size={13} /></IconButton>}
      </div>
      {error
        ? <Button size="sm" variant="ghost" onClick={() => setAttempt((current) => current + 1)}>{t('common.retry')}</Button>
        : notes === null
          ? <LoadingBlock />
          : notes.length === 0
            ? <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.card.notes_empty')}</p>
            : (
                <ul className="space-y-1">
                  {notes.map((note) => (
                    <li key={note.noteId} className="flex items-center gap-2 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-2 py-1.5">
                      <FileText size={13} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
                      <button type="button" className="min-w-0 flex-1 truncate text-left text-[length:var(--text-12)] text-[var(--text-primary)] hover:underline" onClick={() => openNote(note.noteId)}>{note.title || t('project.board.untitled_card')}</button>
                      <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{new Date(note.updatedAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</span>
                      {canEdit && <IconButton label={t('project.card.unlink_note')} size="sm" onClick={() => void remove(note.noteId)}><Trash2 size={12} /></IconButton>}
                    </li>
                  ))}
                </ul>
              )}
      {pickerOpen && (
        <Modal open onClose={() => setPickerOpen(false)} title={t('project.card.link_note')} width={480}>
          <div className="space-y-3">
            <Input className="w-full" value={query} placeholder={t('project.card.search_notes')} aria-label={t('project.card.search_notes')} onChange={(event) => setQuery(event.target.value)} />
            {searching
              ? <LoadingBlock />
              : results.length === 0
                ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.card.no_notes_found')}</p>
                : (
                    <ul className="max-h-72 space-y-1 overflow-y-auto">
                      {results.map((note) => (
                        <li key={note.id}>
                          <button type="button" className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-2 text-left hover:bg-[var(--bg-hover)]" onClick={() => void add(note.id)}>
                            <Search size={13} aria-hidden="true" className="text-[var(--text-quaternary)]" />
                            <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{note.title || t('project.board.untitled_card')}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
          </div>
        </Modal>
      )}
    </section>
  )
}
