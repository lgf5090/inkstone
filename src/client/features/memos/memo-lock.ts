import { create } from 'zustand'
import { NoteLockError, NoteLockSession, isNoteLockEnvelope, saltOfEnvelope } from '@shared/crypto'

const PASSPHRASE_PREFIX = 'inkstone.memos.passphrase:'
const UNLOCK_PREFIX = 'inkstone.memos.unlocked:'

/**
 * The passphrase the tab is currently using, and per-memo reveal timestamps.
 *
 * The passphrase lives in `sessionStorage`, not `localStorage`: closing the tab forgets it, and a
 * reader who shares a machine does not leave the key behind. Decrypted bodies are kept only in
 * memory, so a reload with a lost session storage can never render stale plaintext. This is a real
 * sealed-body scheme — the server never receives the passphrase or the plaintext — with the honest
 * caveat that a script running in this origin could read the session value, as it could read any
 * page.
 */
interface MemoLockState {
  userId: string | null
  passphrase: string | null
  /** memo id → epoch ms at which the reveal expires (0 = until the tab closes). */
  unlockedAt: Record<string, number>
  plaintext: Record<string, string>
  hydrate: (userId: string | null) => void
  setPassphrase: (value: string | null) => void
  unlock: (memoId: string, ciphertext: string, ttlMinutes: number) => Promise<void>
  unlockWithPassphrase: (memoId: string, ciphertext: string, passphrase: string, ttlMinutes: number) => Promise<void>
  lock: (memoId: string) => void
  lockAll: () => void
  expire: () => void
}

function storageKey(prefix: string, userId: string): string {
  return `${prefix}${userId}`
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.sessionStorage?.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.sessionStorage?.setItem(key, JSON.stringify(value))
  } catch {
    // Private-mode storage refusal only costs the reader a passphrase re-entry; it is not a failure
    // worth interrupting the unlock that is already visible.
  }
}

function readString(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeString(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.sessionStorage?.removeItem(key)
    else globalThis.sessionStorage?.setItem(key, value)
  } catch {
    // See writeJson: the unlock still works for this page even when storage is unavailable.
  }
}

function expiresAt(ttlMinutes: number): number {
  return ttlMinutes > 0 ? Date.now() + ttlMinutes * 60 * 1000 : 0
}

function isFresh(at: number | undefined): boolean {
  return typeof at === 'number' && (at === 0 || at > Date.now())
}

/**
 * Open a sealed memo with the shared envelope, keeping the two error messages the memo reader shows.
 *
 * The shared module distinguishes `wrong-password` from `invalid-envelope`; this layer maps those
 * back to the copy Memos already uses, so removing the private crypto module changes no visible text.
 */
export async function openMemoBody(passphrase: string, ciphertext: string): Promise<string> {
  const trimmed = passphrase.trim()
  if (!trimmed) throw new Error('A passphrase is required to open a sealed memo')
  if (!isNoteLockEnvelope(ciphertext)) throw new Error('This memo does not carry a readable sealed body')
  try {
    const salt = saltOfEnvelope(ciphertext)!
    return await (await NoteLockSession.create(trimmed, { salt })).open(ciphertext)
  } catch (error) {
    if (error instanceof NoteLockError && error.code === 'wrong-password') {
      throw new Error('The passphrase did not open this memo', { cause: error })
    }
    throw error
  }
}

export const useMemoLock = create<MemoLockState>((set, get) => ({
  userId: null,
  passphrase: null,
  unlockedAt: {},
  plaintext: {},

  hydrate(userId) {
    if (get().userId === userId) return
    if (!userId) {
      set({ userId: null, passphrase: null, unlockedAt: {}, plaintext: {} })
      return
    }
    const unlockedAt = readJson<Record<string, number>>(storageKey(UNLOCK_PREFIX, userId), {})
    const fresh = Object.fromEntries(Object.entries(unlockedAt).filter(([, at]) => isFresh(at)))
    set({
      userId,
      passphrase: readString(storageKey(PASSPHRASE_PREFIX, userId)),
      unlockedAt: fresh,
      plaintext: {},
    })
  },

  setPassphrase(value) {
    const userId = get().userId
    if (!userId) return
    writeString(storageKey(PASSPHRASE_PREFIX, userId), value)
    set({ passphrase: value })
  },

  async unlock(memoId, ciphertext, ttlMinutes) {
    const passphrase = get().passphrase
    if (!passphrase) throw new Error('A passphrase is required to open this memo')
    await get().unlockWithPassphrase(memoId, ciphertext, passphrase, ttlMinutes)
  },

  async unlockWithPassphrase(memoId, ciphertext, passphrase, ttlMinutes) {
    const plaintext = await openMemoBody(passphrase, ciphertext)
    const userId = get().userId
    if (!userId) throw new Error('No account is signed in')
    const at = expiresAt(ttlMinutes)
    const unlockedAt = { ...get().unlockedAt, [memoId]: at }
    writeJson(storageKey(UNLOCK_PREFIX, userId), unlockedAt)
    writeString(storageKey(PASSPHRASE_PREFIX, userId), passphrase.trim())
    set({
      passphrase: passphrase.trim(),
      unlockedAt,
      plaintext: { ...get().plaintext, [memoId]: plaintext },
    })
  },

  lock(memoId) {
    const { [memoId]: _removed, ...rest } = get().plaintext
    const { [memoId]: _at, ...unlockedAt } = get().unlockedAt
    const userId = get().userId
    if (userId) writeJson(storageKey(UNLOCK_PREFIX, userId), unlockedAt)
    set({ unlockedAt, plaintext: rest })
  },

  lockAll() {
    const userId = get().userId
    if (userId) writeJson(storageKey(UNLOCK_PREFIX, userId), {})
    set({ unlockedAt: {}, plaintext: {} })
  },

  expire() {
    const userId = get().userId
    const unlockedAt = get().unlockedAt
    const stale = Object.keys(unlockedAt).filter((memoId) => !isFresh(unlockedAt[memoId]))
    if (stale.length === 0) return
    const nextAt = { ...unlockedAt }
    const nextPlain = { ...get().plaintext }
    for (const memoId of stale) {
      delete nextAt[memoId]
      delete nextPlain[memoId]
    }
    if (userId) writeJson(storageKey(UNLOCK_PREFIX, userId), nextAt)
    set({ unlockedAt: nextAt, plaintext: nextPlain })
  },
}))

/** The decrypted body when this memo is revealed, or null while it stays sealed. */
export function memoPlaintext(memoId: string): string | null {
  const state = useMemoLock.getState()
  if (!isFresh(state.unlockedAt[memoId])) return null
  return state.plaintext[memoId] ?? null
}

export function memoIsRevealed(memoId: string): boolean {
  const state = useMemoLock.getState()
  return isFresh(state.unlockedAt[memoId]) && state.plaintext[memoId] !== undefined
}
