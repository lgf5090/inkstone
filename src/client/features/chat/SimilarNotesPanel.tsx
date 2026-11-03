/**
 * The notes closest to the one on screen, by meaning.
 *
 * It is a reading aid, not a second search box: the query is the note itself, and a press on a result
 * opens that note. The panel says when the index cannot answer, because "no related note" and "there is
 * no index" are not the same thing to a reader.
 */
import { useEffect, useState } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { Modal } from '../../components/overlay'
import { Button } from '../../components/primitives'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'

interface Hit {
  id: string
  title: string
  excerpt: string
  score: number
}

export function SimilarNotesPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const noteId = useUi((state) => state.activeNoteId)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<'ok' | 'unavailable' | 'failed' | null>(null)
  const [hits, setHits] = useState<Hit[]>([])
  useEffect(() => {
    if (!open || !noteId) return
    let wanted = true
    setLoading(true)
    setStatus(null)
    setHits([])
    void api.assistant.similarNotes(noteId)
      .then((answer) => {
        if (!wanted) return
        setStatus(answer.status)
        setHits(answer.hits)
      })
      .catch(() => { if (wanted) setStatus('failed') })
      .finally(() => { if (wanted) setLoading(false) })
    return () => { wanted = false }
  }, [open, noteId])
  const openNote = (id: string) => {
    onClose()
    void useNotes.getState().openNote(id)
  }
  return (
    <Modal open={open} onClose={onClose} title={t('assistant.similar.title')} width={520}>
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          <Loader2 size={14} className="animate-spin" />
          {t('assistant.similar.loading')}
        </div>
      ) : status === 'unavailable' ? (
        <p className="py-6 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">{t('assistant.similar.unavailable')}</p>
      ) : status === 'failed' ? (
        <p className="py-6 text-[length:var(--text-12)] text-[var(--danger)]">{t('assistant.similar.failed')}</p>
      ) : !hits.length ? (
        <p className="py-6 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('assistant.similar.empty')}</p>
      ) : (
        <ul className="space-y-1.5">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                onClick={() => openNote(hit.id)}
                className="flex w-full items-start gap-2 rounded-[var(--r-md)] px-2 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
              >
                <FileText size={14} className="mt-0.5 shrink-0 text-[var(--text-quaternary)]" />
                <span className="min-w-0">
                  <span className="block truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{hit.title || t('common.untitled_note')}</span>
                  <span className="mt-0.5 line-clamp-2 block text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{hit.excerpt}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="ghost" onClick={onClose}>{t('common.close')}</Button>
      </div>
    </Modal>
  )
}
