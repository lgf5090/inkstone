/**
 * The menu-facing half of note locking: ask for the password, run the operation, and turn every
 * outcome into a message the reader can act on.
 *
 * The crypto itself lives in `store/note-locks.ts`; this module only owns the dialogs, so a menu
 * item is one call and the store never depends on a UI component.
 */
import { t } from '../../lib/i18n'
import { prompt } from '../../components/overlay'
import { useUi } from '../../store/ui'
import {
  NoteUnlockError,
} from '@shared/crypto'
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
): Promise<string | null> {
  return prompt({
    title: t(titleKey),
    description: t(descriptionKey),
    placeholder: t('notelock.password_placeholder'),
    confirmLabel: t(confirmKey),
    inputType: 'password',
    preserveSpaces: true,
  })
}

/** Add a lock to one note. The password is the key; the server never sees it. */
export async function lockNoteFromMenu(noteId: string): Promise<void> {
  const password = await askPassword('notelock.lock_title', 'notelock.lock_desc', 'notelock.lock_confirm')
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
  const password = await askPassword('notelock.unlock_title', 'notelock.unlock_desc', 'notelock.unlock_confirm')
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
  const password = await askPassword('notelock.remove_title', 'notelock.remove_desc', 'notelock.remove_confirm')
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
  const password = await askPassword('notelock.folder_lock_title', 'notelock.folder_lock_desc', 'notelock.lock_confirm')
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
  const password = await askPassword('notelock.vault_lock_title', 'notelock.vault_lock_desc', 'notelock.lock_confirm')
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
  const password = await askPassword('notelock.folder_remove_title', 'notelock.folder_remove_desc', 'notelock.remove_confirm')
  if (!password) return
  try {
    const result = await decryptFolderPermanently(folderId, password)
    toast(t('notelock.folder_removed_toast', { value0: result.opened, value1: folderName, value2: result.skipped }))
  } catch (error) {
    toast(t('notelock.remove_failed'), 'danger', lockError(error) ?? undefined)
  }
}
