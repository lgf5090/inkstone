/**
 * The session-only side of note locking.
 *
 * A key lives here and nowhere else: not in a store that persists, not in the URL, not in a cookie.
 * Unlocking decrypts the title and body into memory, schedules a timeout from the reader's setting,
 * and re-locks when the note is no longer the one being read. A page reload starts locked again,
 * which is the point — an unlock is a session, not a property of the note.
 */
import { create } from 'zustand'
import {
  NOTE_LOCK_TIMEOUT_FALLBACK_MINUTES,
  NoteLockSession,
  NoteUnlockError,
  openNote,
  saltOfEnvelope,
  sealNote,
} from '@shared/crypto'
import { folderDescendantIds } from '../lib/folders'
import { api } from '../lib/api'
import { useNotes } from './notes'
import { useSession } from './session'
import { useUi } from './ui'

export interface UnlockedNote {
  title: string
  content: string
  unlockedAt: number
  expiresAt: number
}

interface NoteLocksState {
  /** Decrypted bodies, keyed by note id. Presence is exactly what "unlocked" means. */
  unlocked: Record<string, UnlockedNote>
}

export const useNoteLocks = create<NoteLocksState>(() => ({ unlocked: {} }))

/** Timers are not state: a re-render must not reset an unlock, and React never sees them. */
const lockTimers = new Map<string, number>()

function timeoutMs(): number {
  const minutes = useSession.getState().settings.notes?.lockTimeoutMinutes
  return Math.max(1, minutes ?? NOTE_LOCK_TIMEOUT_FALLBACK_MINUTES) * 60_000
}

function clearTimer(id: string): void {
  const timer = lockTimers.get(id)
  if (timer !== undefined) window.clearTimeout(timer)
  lockTimers.delete(id)
}

function scheduleLock(id: string): void {
  clearTimer(id)
  if (typeof window === 'undefined') return
  lockTimers.set(id, window.setTimeout(() => lockNow(id), timeoutMs()))
}

/** Drop one note's key and decrypted text. Idempotent. */
export function lockNow(id: string): void {
  clearTimer(id)
  const state = useNoteLocks.getState()
  if (!Object.prototype.hasOwnProperty.call(state.unlocked, id)) return
  const { [id]: _removed, ...rest } = state.unlocked
  useNoteLocks.setState({ unlocked: rest })
}

/** Drop every key — leaving the app, hiding the tab, or a failed unlock. */
export function lockAll(): void {
  for (const id of Object.keys(useNoteLocks.getState().unlocked)) clearTimer(id)
  useNoteLocks.setState({ unlocked: {} })
}

/** Re-lock every note except the one still on screen. Called when the reader switches notes. */
export function lockOthers(activeId: string | null): void {
  for (const id of Object.keys(useNoteLocks.getState().unlocked)) {
    if (id !== activeId) lockNow(id)
  }
}

export function isNoteUnlocked(id: string | null | undefined): boolean {
  return Boolean(id && useNoteLocks.getState().unlocked[id])
}

/**
 * Open one sealed note into this session.
 *
 * `saltOfEnvelope` is what lets a wrong password fail here rather than after a network call: the
 * envelope names the PBKDF2 salt, and the GCM tag is what proves the password. Every failure is
 * user-facing, so this throws rather than returning a falsy result.
 */
export async function unlockNote(id: string, password: string): Promise<UnlockedNote> {
  const state = useNotes.getState()
  const note = state.notes[id]
  if (!note?.isEncrypted) throw new NoteUnlockError('invalid-envelope')
  let content = state.contents[id]
  if (content === undefined) {
    await state.openNote(id)
    content = useNotes.getState().contents[id]
  }
  if (content === undefined) throw new NoteUnlockError('invalid-envelope')
  const salt = saltOfEnvelope(note.title) ?? saltOfEnvelope(content)
  if (!salt) throw new NoteUnlockError('invalid-envelope')
  const session = await NoteLockSession.create(password, { salt })
  const opened = await openNote(session, id, { title: note.title, content })
  const now = Date.now()
  const entry: UnlockedNote = { ...opened, unlockedAt: now, expiresAt: now + timeoutMs() }
  useNoteLocks.setState((current) => ({ unlocked: { ...current.unlocked, [id]: entry } }))
  scheduleLock(id)
  return entry
}

/**
 * Seal one note with a caller-held session.
 *
 * The session is passed in because a folder lock runs one PBKDF2 over many notes. The lock is written
 * to the server before the in-memory key is dropped, so a failed request leaves the note readable
 * rather than claiming a lock the account never received.
 */
export async function sealWithSession(id: string, session: NoteLockSession): Promise<void> {
  const state = useNotes.getState()
  const note = state.notes[id]
  if (!note || note.isEncrypted) return
  let content = state.contents[id]
  let rev = note.rev
  if (content === undefined) {
    // A folder batch must not switch the reader's open note once per file, so the body is fetched
    // directly and the revision it names is the one this lock replaces.
    const fetched = await api.notes.get(id)
    content = fetched.content
    rev = fetched.rev
  }
  if (content === undefined) throw new Error('Note content could not be loaded')
  const sealed = await sealNote(session, id, { title: note.title, content })
  await useNotes.getState().sealNoteRecord(id, sealed, rev)
  lockNow(id)
}

/** Lock one note after asking for its password. */
export async function lockNoteWithPassword(id: string, password: string): Promise<void> {
  const session = await NoteLockSession.create(password)
  await sealWithSession(id, session)
}

/**
 * Lock every note in a folder subtree (the "whole notebook" entry) under one password.
 *
 * Each note gets its own PBKDF2 salt, matching Memos's per-row key material. Notes that are already
 * sealed are skipped rather than re-sealed under a different password.
 */
export async function lockFolderWithPassword(folderId: string, password: string): Promise<{ sealed: number; skipped: number }> {
  const { folders, notes } = useNotes.getState()
  const subtree = folderDescendantIds(folders, folderId)
  const ids = Object.values(notes)
    .filter((note) => !note.deletedAt && note.folderId && subtree.has(note.folderId))
    .map((note) => note.id)
  return sealMany(ids, password)
}

/** Lock every live note in the vault — the "whole notebook" entry. */
export async function lockVaultWithPassword(password: string): Promise<{ sealed: number; skipped: number }> {
  const ids = Object.values(useNotes.getState().notes)
    .filter((note) => !note.deletedAt && !note.isEncrypted)
    .map((note) => note.id)
  return sealMany(ids, password)
}

async function sealMany(ids: string[], password: string): Promise<{ sealed: number; skipped: number }> {
  let sealed = 0
  let skipped = 0
  for (const id of ids) {
    try {
      const before = useNotes.getState().notes[id]
      if (before?.isEncrypted) {
        skipped++
        continue
      }
      // One salt per note, exactly as Memos seals one memo per salt: no two notes share key
      // material even when a folder is locked in one pass.
      await sealWithSession(id, await NoteLockSession.create(password))
      sealed++
    } catch (error) {
      // One unusable note must not abandon the rest of the batch; the caller reports both counts.
      console.warn('[inkstone] could not lock a note', id, error)
    }
  }
  return { sealed, skipped }
}

/**
 * Open one note permanently: decrypt it and send the plaintext back, removing the lock.
 *
 * This is the only operation in this module that puts plaintext back on the server, which is why it
 * is a deliberate "remove encryption" action and not part of unlocking for reading.
 */
export async function decryptNotePermanently(id: string, password: string): Promise<void> {
  const state = useNotes.getState()
  const note = state.notes[id]
  if (!note?.isEncrypted) return
  let content = state.contents[id]
  let rev = note.rev
  if (content === undefined) {
    const fetched = await api.notes.get(id)
    content = fetched.content
    rev = fetched.rev
  }
  if (content === undefined) throw new NoteUnlockError('invalid-envelope')
  const salt = saltOfEnvelope(note.title) ?? saltOfEnvelope(content)
  if (!salt) throw new NoteUnlockError('invalid-envelope')
  const session = await NoteLockSession.create(password, { salt })
  const opened = await openNote(session, id, { title: note.title, content })
  await useNotes.getState().openNoteRecord(id, opened, rev)
  lockNow(id)
}

/** Decrypt every sealed note in a folder subtree with one password. */
export async function decryptFolderPermanently(folderId: string, password: string): Promise<{ opened: number; skipped: number }> {
  const { folders, notes } = useNotes.getState()
  const subtree = folderDescendantIds(folders, folderId)
  const ids = Object.values(notes)
    .filter((note) => note.isEncrypted && !note.deletedAt && note.folderId && subtree.has(note.folderId))
    .map((note) => note.id)
  let opened = 0
  let skipped = 0
  const sessions = new Map<string, NoteLockSession>()
  for (const id of ids) {
    try {
      const note = useNotes.getState().notes[id]
      if (!note) continue
      const salt = saltOfEnvelope(note.title)
      if (!salt) {
        skipped++
        continue
      }
      let session = sessions.get(salt)
      if (!session) {
        session = await NoteLockSession.create(password, { salt })
        sessions.set(salt, session)
      }
      let content = useNotes.getState().contents[id]
      let rev = note.rev
      if (content === undefined) {
        const fetched = await api.notes.get(id)
        content = fetched.content
        rev = fetched.rev
      }
      if (content === undefined) {
        skipped++
        continue
      }
      const openedNote = await openNote(session, id, { title: note.title, content })
      await useNotes.getState().openNoteRecord(id, openedNote, rev)
      lockNow(id)
      opened++
    } catch (error) {
      console.warn('[inkstone] could not decrypt a note', id, error)
      skipped++
    }
  }
  return { opened, skipped }
}

/**
 * Wire the automatic re-lock rules once per app start.
 *
 * Switching notes locks the one left behind; hiding the tab or leaving the page drops every key.
 * The pathname is not watched: switching app tabs keeps the same note open, and a reader who comes
 * back to the notebook should still find the note they were reading rather than a second prompt.
 */
export function installNoteLockLifecycle(): () => void {
  const unsubscribe = useUi.subscribe((state, previous) => {
    if (state.activeNoteId !== previous.activeNoteId) lockOthers(state.activeNoteId)
  })
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') lockAll()
  }
  const onPageHide = () => lockAll()
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  return () => {
    unsubscribe()
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    lockAll()
  }
}
