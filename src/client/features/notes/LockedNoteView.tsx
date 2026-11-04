/**
 * The workspace surface for a sealed note.
 *
 * Locked notes never reach the editor or the ordinary preview: the store holds only ciphertext, and
 * this view is the one place that decides what a session is allowed to see. Unlocking is read-only —
 * the server cannot re-seal a plaintext edit, so editing starts by removing the lock.
 */
import { ArrowLeft, KeyRound, Lock, Unlock } from 'lucide-react'
import type { NoteSummary } from '@shared/types'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { useNoteLocks } from '../../store/note-locks'
import { decryptNoteFromMenu, relockNoteFromMenu, unlockNoteFromMenu } from '../notes/note-lock-actions'
import { Preview } from '../preview/Preview'

export function LockedNoteView({ note, onMobileBack }: {
  note: NoteSummary
  onMobileBack?: () => void
}) {
  const unlocked = useNoteLocks((s) => s.unlocked[note.id] ?? null)
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-editor)]">
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1">
        {onMobileBack && (
          <IconButton label={t('workspace.back_to_notes')} size="sm" onClick={onMobileBack}>
            <ArrowLeft size={16}/>
          </IconButton>
        )}
        {unlocked
          ? (
              <>
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
                  {unlocked.title || t('common.untitled_note')}
                </span>
                <Button size="sm" variant="secondary" onClick={() => relockNoteFromMenu(note.id)}>
                  <Lock size={13}/> {t('notelock.menu_relock')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void decryptNoteFromMenu(note.id)}>
                  <KeyRound size={13}/> {t('notelock.menu_remove')}
                </Button>
              </>
            )
          : (
              <>
                <span className="note-lock-mosaic note-lock-mosaic--wide max-w-72" role="img" aria-label={t('notelock.masked')}/>
                <span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[length:var(--text-11)] text-[var(--accent)]">
                  {t('notelock.badge')}
                </span>
              </>
            )}
      </header>

      {unlocked
        ? (
            <>
              <div role="status" className="mx-3 mt-3 flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
                <Unlock size={13} className="mt-0.5 shrink-0 text-[var(--accent)]"/>
                <span>{t('notelock.unlock_readonly')}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto py-4">
                <Preview
                  content={unlocked.content}
                  noteId={note.id}
                  noteTitle={unlocked.title}
                  className="mx-auto w-full max-w-[760px] px-6"
                  readOnly
                />
              </div>
            </>
          )
        : (
            <div className="note-lock-panel flex min-h-0 flex-1 items-center justify-center p-6">
              <div className="w-full max-w-[420px] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-5 py-6 shadow-[var(--shadow-sm)]">
                <div className="mb-3 inline-flex size-10 items-center justify-center rounded-full bg-[var(--accent-soft)]">
                  <Lock size={18} className="text-[var(--accent)]"/>
                </div>
                <h2 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
                  {t('notelock.locked_panel_title')}
                </h2>
                <p className="mt-1 text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">
                  {t('notelock.locked_panel_desc')}
                </p>
                <div className="mt-4 space-y-2" aria-hidden="true">
                  <span className="note-lock-mosaic note-lock-mosaic--wide note-lock-mosaic--body"/>
                  <span className="note-lock-mosaic note-lock-mosaic--wide note-lock-mosaic--body note-lock-mosaic--short"/>
                  <span className="note-lock-mosaic note-lock-mosaic--wide note-lock-mosaic--body note-lock-mosaic--medium"/>
                </div>
                <p className="mt-4 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {t('notelock.real_e2e_hint')}
                </p>
                <div className="mt-5 flex items-center justify-end gap-2">
                  <Button variant="secondary" onClick={() => void decryptNoteFromMenu(note.id)}>
                    <KeyRound size={13}/> {t('notelock.menu_remove')}
                  </Button>
                  <Button variant="primary" onClick={() => void unlockNoteFromMenu(note.id)}>
                    <Unlock size={13}/> {t('notelock.unlock_action')}
                  </Button>
                </div>
              </div>
            </div>
          )}
    </div>
  )
}
