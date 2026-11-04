/** The shared sealed-text surface: every consumer imports from here, never from a private path. */
export {
  NOTE_LOCK_ENVELOPE_PREFIX,
  NOTE_LOCK_KDF_ITERATIONS,
  NOTE_LOCK_KDF_NAME,
  NOTE_LOCK_TIMEOUT_FALLBACK_MINUTES,
  NoteLockSession,
  NoteUnlockError,
  isNoteLockEnvelope,
  openNote,
  saltOfEnvelope,
  sealNote,
  type NoteLockField,
} from './note-lock'
