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
import { t } from '../lib/i18n'
import type { AttachmentWithUsage } from '@shared/types'
import { api, ApiError } from '../lib/api'
import { useNotes } from './notes'
import { useSession } from './session'
import { useUi } from './ui'

export interface UnlockedNote {
  title: string
  content: string
  unlockedAt: number
  expiresAt: number
}

export interface UnlockedNoteDraft {
  title: string
  content: string
}

interface NoteLocksState {
  /** Decrypted bodies, keyed by note id. Presence is exactly what "unlocked" means. */
  unlocked: Record<string, UnlockedNote>
  /** Plaintext edits live only in this non-persisted store until their envelope is saved. */
  drafts: Record<string, UnlockedNoteDraft>
}

export const useNoteLocks = create<NoteLocksState>(() => ({ unlocked: {}, drafts: {} }))

interface RetainedNoteSession {
  session: NoteLockSession
  title: string
  content: string
}

/** Crypto keys never enter Zustand, local storage, IndexedDB or any persisted note cache. */
const retainedSessions = new Map<string, RetainedNoteSession>()
/** Timers are not state: a re-render must not reset an unlock, and React never sees them. */
const lockTimers = new Map<string, number>()
/** Serialize reseals so a slower earlier edit cannot overwrite a later revision. */
const saveTails = new Map<string, Promise<unknown>>()
const attachmentUrls = new Map<string, Map<string, ResolvedNoteAttachment>>()
const attachmentLoads = new Map<string, Promise<ResolvedNoteAttachment>>()
const attachmentEpochs = new Map<string, number>()

export interface ResolvedNoteAttachment {
  url: string
  filename: string
  mime: string
}

function attachmentLoadKey(noteId: string, attachmentId: string): string {
  return `${noteId}:${attachmentId}`
}

function revokeAttachmentUrls(id: string): void {
  attachmentEpochs.set(id, (attachmentEpochs.get(id) ?? 0) + 1)
  for (const attachment of attachmentUrls.get(id)?.values() ?? []) URL.revokeObjectURL(attachment.url)
  attachmentUrls.delete(id)
}

export async function resolveLockedNoteAttachment(
  noteId: string,
  attachmentId: string,
): Promise<ResolvedNoteAttachment> {
  const cached = attachmentUrls.get(noteId)?.get(attachmentId)
  if (cached) return cached
  const key = attachmentLoadKey(noteId, attachmentId)
  const pending = attachmentLoads.get(key)
  if (pending) return pending
  const retained = retainedSessions.get(noteId)
  if (!retained) throw new NoteUnlockError('invalid-envelope')
  const epoch = attachmentEpochs.get(noteId) ?? 0
  const task = (async (): Promise<ResolvedNoteAttachment> => {
    const response = await fetch(`/api/files/${encodeURIComponent(attachmentId)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`Encrypted attachment fetch failed: ${response.status}`)
    if (response.headers.get('X-Inkstone-Attachment-Encryption') !== 'note-lock-v1') {
      throw new NoteUnlockError('invalid-envelope')
    }
    const sealed = new Uint8Array(await response.arrayBuffer())
    if (retainedSessions.get(noteId) !== retained || (attachmentEpochs.get(noteId) ?? 0) !== epoch) {
      throw new NoteUnlockError('invalid-envelope')
    }
    const plaintext = await openLockedNoteAttachment(noteId, attachmentId, sealed)
    if (retainedSessions.get(noteId) !== retained || (attachmentEpochs.get(noteId) ?? 0) !== epoch) {
      throw new NoteUnlockError('invalid-envelope')
    }
    const mime = response.headers.get('X-Inkstone-Attachment-Type') || 'application/octet-stream'
    const encodedFilename = response.headers.get('X-Inkstone-Attachment-Filename') ?? ''
    let filename = attachmentId
    try {
      filename = decodeURIComponent(encodedFilename) || attachmentId
    } catch {
      filename = attachmentId
    }
    const url = URL.createObjectURL(new Blob([new Uint8Array(plaintext)], { type: mime }))
    const urls = attachmentUrls.get(noteId) ?? new Map<string, ResolvedNoteAttachment>()
    urls.set(attachmentId, { url, filename, mime })
    attachmentUrls.set(noteId, urls)
    return { url, filename, mime }
  })()
  attachmentLoads.set(key, task)
  const clear = () => {
    if (attachmentLoads.get(key) === task) attachmentLoads.delete(key)
  }
  void task.then(clear, clear)
  return task
}

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
  lockTimers.set(id, window.setTimeout(() => void lockAfterSaving(id), timeoutMs()))
}

async function lockAfterSaving(id: string): Promise<void> {
  const draft = useNoteLocks.getState().drafts[id]
  if (draft) {
    try {
      const result = await saveUnlockedNoteEdit(id, draft)
      if (result === 'conflict') throw new Error('The note changed on another device')
    } catch (error) {
      console.warn('[inkstone] could not save a draft before auto-lock', id, error)
      useUi.getState().toast({ title: t('notelock.autolock_unsaved'), tone: 'warning' })
      if (isNoteUnlocked(id)) scheduleLock(id)
      return
    }
  }
  lockNow(id)
}

/** Object URLs embedded in decrypted text must not outlive the session that revealed them. */
function revokeDecryptedUrls(...texts: Array<string | undefined>): void {
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return
  const urls = new Set<string>()
  for (const text of texts) {
    if (!text) continue
    for (const match of text.matchAll(/blob:[^\s"'<>)\]]+/g)) urls.add(match[0])
  }
  for (const url of urls) URL.revokeObjectURL(url)
}

/** Drop one note's key, draft and decrypted text. Idempotent. */
export function lockNow(id: string): void {
  clearTimer(id)
  revokeAttachmentUrls(id)
  const state = useNoteLocks.getState()
  const unlocked = state.unlocked[id]
  const draft = state.drafts[id]
  retainedSessions.delete(id)
  if (unlocked || draft) revokeDecryptedUrls(unlocked?.title, unlocked?.content, draft?.title, draft?.content)
  if (!unlocked && !draft) return
  const { [id]: _unlocked, ...restUnlocked } = state.unlocked
  const { [id]: _draft, ...restDrafts } = state.drafts
  useNoteLocks.setState({ unlocked: restUnlocked, drafts: restDrafts })
}

/** Drop every key — leaving the app, hiding the tab, or a failed unlock. */
export function lockAll(): void {
  const ids = new Set([...Object.keys(useNoteLocks.getState().unlocked), ...retainedSessions.keys()])
  for (const id of ids) lockNow(id)
  useNoteLocks.setState({ unlocked: {}, drafts: {} })
}

/** Re-lock every note except the one still on screen. Called when the reader switches notes. */
export function lockOthers(activeId: string | null): void {
  for (const id of Object.keys(useNoteLocks.getState().unlocked)) {
    if (id !== activeId) lockNow(id)
  }
}

export function isNoteUnlocked(id: string | null | undefined): boolean {
  return Boolean(id && useNoteLocks.getState().unlocked[id] && retainedSessions.has(id))
}

export async function sealLockedNoteAttachment(noteId: string, attachmentId: string, bytes: Uint8Array): Promise<Uint8Array> {
  const retained = retainedSessions.get(noteId)
  if (!retained) throw new NoteUnlockError('invalid-envelope')
  return retained.session.sealNoteAttachment(noteId, attachmentId, bytes)
}

export async function openLockedNoteAttachment(noteId: string, attachmentId: string, bytes: Uint8Array): Promise<Uint8Array> {
  const retained = retainedSessions.get(noteId)
  if (!retained) throw new NoteUnlockError('invalid-envelope')
  return retained.session.openNoteAttachment(noteId, attachmentId, bytes)
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
  const session = await NoteLockSession.fromEnvelope(password, note.title)
  const opened = await openNote(session, id, { title: note.title, content })
  const now = Date.now()
  const entry: UnlockedNote = { ...opened, unlockedAt: now, expiresAt: now + timeoutMs() }
  retainedSessions.set(id, { session, title: note.title, content })
  useNoteLocks.setState((current) => {
    const { [id]: _previousDraft, ...drafts } = current.drafts
    return { unlocked: { ...current.unlocked, [id]: entry }, drafts }
  })
  scheduleLock(id)
  return entry
}

/** Stage a plaintext edit without touching the persisted note cache or offline write queue. */
export function updateUnlockedNoteDraft(id: string, edit: Partial<UnlockedNoteDraft>): void {
  const state = useNoteLocks.getState()
  const current = state.drafts[id] ?? state.unlocked[id]
  if (!current || !retainedSessions.has(id)) return
  const next = {
    title: edit.title ?? current.title,
    content: edit.content ?? current.content,
  }
  if (next.title === current.title && next.content === current.content) return
  useNoteLocks.setState((latest) => ({
    drafts: { ...latest.drafts, [id]: next },
  }))
  scheduleLock(id)
}

/**
 * Re-seal both fields under the retained non-extractable key and PATCH the existing note directly.
 * A conflict is returned to the caller and deliberately leaves the in-memory draft intact.
 */
export async function saveUnlockedNoteEdit(
  id: string,
  edit: UnlockedNoteDraft,
): Promise<'saved' | 'conflict'> {
  const previous = saveTails.get(id) ?? Promise.resolve()
  const run = async (): Promise<'saved' | 'conflict'> => {
    const retained = retainedSessions.get(id)
    const unlocked = useNoteLocks.getState().unlocked[id]
    const note = useNotes.getState().notes[id]
    const content = useNotes.getState().contents[id]
    if (!retained || !unlocked || !note?.isEncrypted || content === undefined)
      throw new NoteUnlockError('invalid-envelope')
    if (retained.title !== note.title || retained.content !== content) {
      // Another device changed the envelope after this session opened it. Its key and plaintext are
      // no longer authoritative, so fail closed instead of resealing over the remote note.
      lockNow(id)
      throw new NoteUnlockError('invalid-envelope')
    }
    const sealed = await sealNote(retained.session, id, edit)
    try {
      const saved = await useNotes.getState().saveNoteEnvelope(id, sealed, note.rev)
      if (retainedSessions.get(id) !== retained) return 'saved'
      retainedSessions.set(id, { ...retained, title: saved.title, content: saved.content })
      useNoteLocks.setState((latest) => {
        const currentUnlocked = latest.unlocked[id]
        if (!currentUnlocked) return latest
        const currentDraft = latest.drafts[id]
        const draftStillMatches = currentDraft?.title === edit.title && currentDraft.content === edit.content
        const { [id]: _savedDraft, ...drafts } = latest.drafts
        return {
          unlocked: {
            ...latest.unlocked,
            [id]: { ...currentUnlocked, title: edit.title, content: edit.content },
          },
          drafts: draftStillMatches ? drafts : latest.drafts,
        }
      })
      return 'saved'
    }
    catch (error) {
      if (error instanceof ApiError && error.isConflict) return 'conflict'
      throw error
    }
  }
  const task = previous.then(run, run)
  saveTails.set(id, task)
  const clear = () => {
    if (saveTails.get(id) === task) saveTails.delete(id)
  }
  void task.then(clear, clear)
  return task
}

interface PreparedAttachmentMigration {
  id: string
  filename: string
  mime: string
  plaintext: Uint8Array
  sealed?: Uint8Array
  expectedSha256?: string
}

async function attachmentsOfNote(noteId: string | null): Promise<AttachmentWithUsage[]> {
  const attachments: AttachmentWithUsage[] = []
  let cursor: string | undefined
  do {
    const page = await api.files.list(cursor)
    attachments.push(...page.files.filter((file) => noteId === null || file.noteId === noteId))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return attachments
}

async function attachmentBytes(id: string, encrypted: boolean): Promise<Uint8Array> {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error(`Attachment fetch failed: ${response.status}`)
  const header = response.headers.get('X-Inkstone-Attachment-Encryption')
  if ((header === 'note-lock-v1') !== encrypted) throw new NoteUnlockError('invalid-envelope')
  return new Uint8Array(await response.arrayBuffer())
}

async function prepareAttachmentSeal(
  noteId: string,
  session: NoteLockSession,
  known?: AttachmentWithUsage[],
): Promise<PreparedAttachmentMigration[]> {
  const prepared: PreparedAttachmentMigration[] = []
  for (const file of known ?? await attachmentsOfNote(noteId)) {
    if (file.encryption === 'note-lock-v1') throw new Error(t('notelock.attachment_migration_failed'))
    const plaintext = await attachmentBytes(file.id, false)
    prepared.push({
      id: file.id,
      filename: file.filename,
      mime: file.mime,
      plaintext,
      sealed: await session.sealNoteAttachment(noteId, file.id, plaintext),
      expectedSha256: file.sha256,
    })
  }
  return prepared
}

async function prepareAttachmentOpen(
  noteId: string,
  session: NoteLockSession,
  known?: AttachmentWithUsage[],
): Promise<PreparedAttachmentMigration[]> {
  const prepared: PreparedAttachmentMigration[] = []
  for (const file of known ?? await attachmentsOfNote(noteId)) {
    if (file.encryption !== 'note-lock-v1') continue
    const sealed = await attachmentBytes(file.id, true)
    prepared.push({
      id: file.id,
      filename: file.filename,
      mime: file.mime,
      plaintext: await session.openNoteAttachment(noteId, file.id, sealed),
      sealed,
      expectedSha256: file.sha256,
    })
  }
  return prepared
}

function attachmentFile(file: PreparedAttachmentMigration, bytes: Uint8Array): File {
  return new File([new Uint8Array(bytes)], file.filename, { type: file.mime || 'application/octet-stream' })
}

/**
 * Seal one note with a caller-held session.
 *
 * The session is passed in because a folder lock runs one PBKDF2 over many notes. The lock is written
 * to the server before the in-memory key is dropped, so a failed request leaves the note readable
 * rather than claiming a lock the account never received.
 */
export async function sealWithSession(id: string, session: NoteLockSession, knownAttachments?: AttachmentWithUsage[]): Promise<void> {
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
  const attachments = await prepareAttachmentSeal(id, session, knownAttachments)
  const sealed = await sealNote(session, id, { title: note.title, content })
  await useNotes.getState().sealNoteRecord(id, sealed, rev)
  const replaced: PreparedAttachmentMigration[] = []
  try {
    for (const file of attachments) {
      if (!file.sealed) throw new Error('Prepared attachment ciphertext is missing')
      const stored = await api.files.replace(file.id, attachmentFile(file, file.sealed), {
        encryption: 'note-lock-v1',
        plaintextSize: file.plaintext.byteLength,
        expectedSha256: file.expectedSha256,
      })
      file.expectedSha256 = stored.sha256 ?? file.expectedSha256
      replaced.push(file)
    }
  } catch (error) {
    const rollbackErrors: unknown[] = []
    try {
      const remote = await api.notes.get(id)
      if (remote.isEncrypted) await useNotes.getState().openNoteRecord(id, { title: note.title, content }, remote.rev)
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    for (const file of replaced) {
      try {
        await api.files.replace(file.id, attachmentFile(file, file.plaintext), {
          encryption: 'none',
          expectedSha256: file.expectedSha256,
        })
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], t('notelock.attachment_migration_failed'))
    throw new Error(t('notelock.attachment_migration_failed'), { cause: error })
  }
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
  const byNote = new Map<string, AttachmentWithUsage[]>()
  for (const file of await attachmentsOfNote(null)) byNote.set(file.noteId ?? '', [...(byNote.get(file.noteId ?? '') ?? []), file])
  for (const id of ids) {
    try {
      const before = useNotes.getState().notes[id]
      if (before?.isEncrypted) {
        skipped++
        continue
      }
      // One salt per note, exactly as Memos seals one memo per salt: no two notes share key
      // material even when a folder is locked in one pass.
      await sealWithSession(id, await NoteLockSession.create(password), byNote.get(id) ?? [])
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
export async function decryptNotePermanently(id: string, password: string, knownAttachments?: AttachmentWithUsage[]): Promise<void> {
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
  const session = await NoteLockSession.fromEnvelope(password, note.title)
  const opened = await openNote(session, id, { title: note.title, content })
  const attachments = await prepareAttachmentOpen(id, session, knownAttachments)
  await useNotes.getState().openNoteRecord(id, opened, rev)
  const replaced: PreparedAttachmentMigration[] = []
  try {
    for (const file of attachments) {
      const stored = await api.files.replace(file.id, attachmentFile(file, file.plaintext), {
        encryption: 'none',
        expectedSha256: file.expectedSha256,
      })
      file.expectedSha256 = stored.sha256 ?? file.expectedSha256
      replaced.push(file)
    }
  } catch (error) {
    const rollbackErrors: unknown[] = []
    try {
      const remote = await api.notes.get(id)
      if (!remote.isEncrypted) await useNotes.getState().saveNoteEnvelope(id, { title: note.title, content }, remote.rev)
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    for (const file of replaced) {
      if (!file.sealed) continue
      try {
        await api.files.replace(file.id, attachmentFile(file, file.sealed), {
          encryption: 'note-lock-v1',
          plaintextSize: file.plaintext.byteLength,
          expectedSha256: file.expectedSha256,
        })
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], t('notelock.attachment_migration_failed'))
    throw new Error(t('notelock.attachment_migration_failed'), { cause: error })
  }
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
  const byNote = new Map<string, AttachmentWithUsage[]>()
  for (const file of await attachmentsOfNote(null)) byNote.set(file.noteId ?? '', [...(byNote.get(file.noteId ?? '') ?? []), file])
  for (const id of ids) {
    try {
      const note = useNotes.getState().notes[id]
      if (!note) continue
      if (!saltOfEnvelope(note.title)) {
        skipped++
        continue
      }
      await decryptNotePermanently(id, password, byNote.get(id) ?? [])
      opened++
    } catch (error) {
      console.warn('[inkstone] could not decrypt a note', id, error)
      skipped++
    }
  }
  return { opened, skipped }
}

/** A remote envelope replacement invalidates the old key and any edit based on its plaintext. */
function invalidateChangedEnvelope(id: string): void {
  const retained = retainedSessions.get(id)
  if (!retained) return
  const state = useNotes.getState()
  const note = state.notes[id]
  const content = state.contents[id]
  if (!note?.isEncrypted || content === undefined || note.title !== retained.title || content !== retained.content) {
    lockNow(id)
    return
  }
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
  const unsubscribeNotes = useNotes.subscribe((state, previous) => {
    for (const id of retainedSessions.keys()) {
      if (!state.notes[id] || (previous.notes[id]?.isEncrypted && !state.notes[id]?.isEncrypted)) lockNow(id)
    }
  })
  const onNoteSealed = (event: Event) => {
    const id = (event as CustomEvent<string>).detail
    if (typeof id === 'string') invalidateChangedEnvelope(id)
  }
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') lockAll()
  }
  const onPageHide = () => lockAll()
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('inkstone:note-sealed', onNoteSealed)
  return () => {
    unsubscribe()
    unsubscribeNotes()
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('inkstone:note-sealed', onNoteSealed)
    lockAll()
  }
}
