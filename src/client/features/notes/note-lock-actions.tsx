/**
 * The menu-facing half of note locking: ask for the password, run the operation, and turn every
 * outcome into a message the reader can act on.
 *
 * The crypto itself lives in `store/note-locks.ts`; this module only owns the dialogs, so a menu
 * item is one call and the store never depends on a UI component.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { normalizeNoteLockPassword, NoteUnlockError } from '@shared/crypto'
import { t } from '../../lib/i18n'
import { Modal } from '../../components/overlay'
import { Button } from '../../components/primitives'
import { Input } from '../../components/form'
import { PasswordStrengthIndicator } from '../../components/password-strength'
import { useUi } from '../../store/ui'
import {
  decryptFolderPermanently,
  decryptNotePermanently,
  isNoteUnlocked,
  lockFolderWithPassword,
  lockNoteWithPassword,
  lockNow,
  lockVaultWithPassword,
  unlockNote,
} from '../../store/note-locks'

export interface NoteLockPasswordOptions {
  title: string
  description: string
  confirmLabel: string
  mode: 'new' | 'existing'
}

export interface NoteLockPasswordRequest {
  options: NoteLockPasswordOptions
  resolve: (value: string | null) => void
}

let enqueuePassword: ((request: NoteLockPasswordRequest) => void) | null = null

/** Request the project password dialog; no native prompt or password fallback exists. */
export function requestNoteLockPassword(options: NoteLockPasswordOptions): Promise<string | null> {
  if (!enqueuePassword) return Promise.resolve(null)
  return new Promise((resolve) => enqueuePassword?.({ options, resolve }))
}

export function NoteLockPasswordHost() {
  const [current, setCurrent] = useState<NoteLockPasswordRequest | null>(null)
  const currentRef = useRef<NoteLockPasswordRequest | null>(null)
  const queueRef = useRef<NoteLockPasswordRequest[]>([])

  useEffect(() => {
    enqueuePassword = (request) => {
      if (currentRef.current) {
        queueRef.current.push(request)
        return
      }
      currentRef.current = request
      setCurrent(request)
    }
    return () => {
      enqueuePassword = null
      currentRef.current?.resolve(null)
      for (const request of queueRef.current) request.resolve(null)
      currentRef.current = null
      queueRef.current = []
    }
  }, [])

  const finish = useCallback((request: NoteLockPasswordRequest | null, value: string | null) => {
    if (!request || currentRef.current !== request) return
    request.resolve(value)
    const next = queueRef.current.shift() ?? null
    currentRef.current = next
    setCurrent(next)
  }, [])

  return current ? <NoteLockPasswordDialog request={current} finish={finish}/> : null
}

/** Accessible new-password confirmation and shared strength feedback for note encryption. */
export function NoteLockPasswordDialog({ request, finish }: {
  request: NoteLockPasswordRequest
  finish: (request: NoteLockPasswordRequest, value: string | null) => void
}) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const strengthId = useId()
  const mismatchId = useId()
  const isNew = request.options.mode === 'new'
  const normalized = normalizeNoteLockPassword(password)
  const normalizedConfirmation = normalizeNoteLockPassword(confirmation)
  const mismatch = isNew && confirmation.length > 0 && normalized !== normalizedConfirmation
  const canSubmit = Boolean(normalized) && (!isNew || (confirmation.length > 0 && normalized === normalizedConfirmation))
  const submit = () => {
    if (canSubmit) finish(request, normalized)
  }

  return (
    <Modal
      open
      onClose={() => finish(request, null)}
      title={request.options.title}
      description={request.options.description}
      width={440}
      footer={<>
        <Button variant="ghost" onClick={() => finish(request, null)}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={!canSubmit} onClick={submit}>
          {request.options.confirmLabel}
        </Button>
      </>}
    >
      <form className="mt-[var(--sp-2)] space-y-3" onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}>
        <div>
          <label htmlFor={`${strengthId}-password`} className="mb-1 block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('notelock.password_label')}
          </label>
          <Input
            id={`${strengthId}-password`}
            data-autofocus
            type="password"
            autoComplete={isNew ? 'new-password' : 'current-password'}
            value={password}
            placeholder={t('notelock.password_placeholder')}
            aria-describedby={isNew && password ? strengthId : undefined}
            onChange={(event) => setPassword(event.target.value)}
          />
          {isNew && <PasswordStrengthIndicator id={strengthId} password={normalized}/>}
        </div>
        {isNew && (
          <div>
            <label htmlFor={`${strengthId}-confirmation`} className="mb-1 block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('notelock.confirm_password_label')}
            </label>
            <Input
              id={`${strengthId}-confirmation`}
              type="password"
              autoComplete="new-password"
              value={confirmation}
              placeholder={t('notelock.password_placeholder')}
              aria-invalid={mismatch || undefined}
              aria-describedby={mismatch ? mismatchId : undefined}
              onChange={(event) => setConfirmation(event.target.value)}
            />
            {mismatch && <p id={mismatchId} role="alert" className="mt-1 text-[length:var(--text-11)] text-[var(--danger)]">
              {t('notelock.password_mismatch')}
            </p>}
          </div>
        )}
      </form>
    </Modal>
  )
}

function toast(title: string, tone: 'success' | 'danger' | 'warning' = 'success', description?: string): void {
  useUi.getState().toast({ title, tone, ...(description ? { description } : {}) })
}

function lockError(error: unknown): string | null {
  if (error instanceof NoteUnlockError && error.code === 'wrong-password') return null
  return error instanceof Error ? error.message : String(error)
}

async function askPassword(
  titleKey: Parameters<typeof t>[0],
  descriptionKey: Parameters<typeof t>[0],
  confirmKey: Parameters<typeof t>[0],
  mode: NoteLockPasswordOptions['mode'],
): Promise<string | null> {
  return requestNoteLockPassword({
    title: t(titleKey),
    description: t(descriptionKey),
    confirmLabel: t(confirmKey),
    mode,
  })
}

/** Add a lock to one note. The password is the key; the server never sees it. */
export async function lockNoteFromMenu(noteId: string): Promise<void> {
  const password = await askPassword('notelock.lock_title', 'notelock.lock_desc', 'notelock.lock_confirm', 'new')
  if (!password) return
  try {
    await lockNoteWithPassword(noteId, password)
    toast(t('notelock.locked_toast'))
  } catch (error) {
    toast(t('notelock.lock_failed'), 'danger', lockError(error) ?? undefined)
  }
}

/** Unlock a note for this session only. Nothing is written back to the server. */
export async function unlockNoteFromMenu(noteId: string): Promise<void> {
  const password = await askPassword('notelock.unlock_title', 'notelock.unlock_desc', 'notelock.unlock_confirm', 'existing')
  if (!password) return
  try {
    await unlockNote(noteId, password)
    toast(t('notelock.unlocked_toast'))
  } catch (error) {
    toast(t(error instanceof NoteUnlockError && error.code === 'wrong-password' ? 'notelock.wrong_password' : 'notelock.unlock_failed'), 'danger', lockError(error) ?? undefined)
  }
}

/** Re-lock an unlocked note without waiting for the session timeout. */
export function relockNoteFromMenu(noteId: string): void {
  if (!isNoteUnlocked(noteId)) return
  lockNow(noteId)
  toast(t('notelock.relocked_toast'))
}

/** Remove the lock: decrypt locally and write the plaintext back, a deliberate downgrade. */
export async function decryptNoteFromMenu(noteId: string): Promise<void> {
  const password = await askPassword('notelock.remove_title', 'notelock.remove_desc', 'notelock.remove_confirm', 'existing')
  if (!password) return
  try {
    await decryptNotePermanently(noteId, password)
    toast(t('notelock.removed_toast'))
  } catch (error) {
    toast(t(error instanceof NoteUnlockError && error.code === 'wrong-password' ? 'notelock.wrong_password' : 'notelock.remove_failed'), 'danger', lockError(error) ?? undefined)
  }
}

/** Lock every note in a folder subtree under one password. */
export async function lockFolderFromMenu(folderId: string, folderName: string): Promise<void> {
  const password = await askPassword('notelock.folder_lock_title', 'notelock.folder_lock_desc', 'notelock.lock_confirm', 'new')
  if (!password) return
  try {
    const result = await lockFolderWithPassword(folderId, password)
    toast(t('notelock.folder_locked_toast', { value0: result.sealed, value1: folderName, value2: result.skipped }))
  } catch (error) {
    toast(t('notelock.lock_failed'), 'danger', lockError(error) ?? undefined)
  }
}

/** Lock the whole notebook: every live note under one password. */
export async function lockVaultFromMenu(): Promise<void> {
  const password = await askPassword('notelock.vault_lock_title', 'notelock.vault_lock_desc', 'notelock.lock_confirm', 'new')
  if (!password) return
  try {
    const result = await lockVaultWithPassword(password)
    toast(t('notelock.vault_locked_toast', { value0: result.sealed, value2: result.skipped }))
  } catch (error) {
    toast(t('notelock.lock_failed'), 'danger', lockError(error) ?? undefined)
  }
}

/** Decrypt every locked note in a folder subtree. */
export async function decryptFolderFromMenu(folderId: string, folderName: string): Promise<void> {
  const password = await askPassword('notelock.folder_remove_title', 'notelock.folder_remove_desc', 'notelock.remove_confirm', 'existing')
  if (!password) return
  try {
    const result = await decryptFolderPermanently(folderId, password)
    toast(t('notelock.folder_removed_toast', { value0: result.opened, value1: folderName, value2: result.skipped }))
  } catch (error) {
    toast(t('notelock.remove_failed'), 'danger', lockError(error) ?? undefined)
  }
}
