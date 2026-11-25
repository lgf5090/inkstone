/** The workspace surface for a sealed note that has not been unlocked in this session. */
import { ArrowLeft, KeyRound, Lock, Unlock } from 'lucide-react'
import { useState } from 'react'
import type { NoteSummary } from '@shared/types'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { decryptNoteFromMenu, unlockNoteFromMenu } from './note-lock-actions'

export function LockedNoteView({ note, onMobileBack }: {
  note: NoteSummary
  onMobileBack?: () => void
}) {
  const [pending, setPending] = useState<'unlock' | 'decrypt' | null>(null)
  const run = async (operation: 'unlock' | 'decrypt') => {
    if (pending) return
    setPending(operation)
    try {
      if (operation === 'unlock') await unlockNoteFromMenu(note.id)
      else await decryptNoteFromMenu(note.id)
    } finally {
      setPending(null)
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-editor)]">
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1">
        {onMobileBack && (
          <IconButton label={t('workspace.back_to_notes')} size="sm" onClick={onMobileBack}>
            <ArrowLeft size={16}/>
          </IconButton>
        )}
        <span className="note-lock-mosaic note-lock-mosaic--wide max-w-72" role="img" aria-label={t('notelock.masked')}/>
        <span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[length:var(--text-11)] text-[var(--accent)]">
          {t('notelock.badge')}
        </span>
      </header>

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
            <Button variant="secondary" loading={pending === 'decrypt'} disabled={pending !== null} onClick={() => void run('decrypt')}>
              <KeyRound size={13}/> {t('notelock.menu_remove')}
            </Button>
            <Button variant="primary" loading={pending === 'unlock'} disabled={pending !== null} onClick={() => void run('unlock')}>
              <Unlock size={13}/> {t('notelock.unlock_action')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
