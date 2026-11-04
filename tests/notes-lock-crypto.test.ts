// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  NoteLockSession,
  NoteUnlockError,
  isNoteLockEnvelope,
  openNote,
  saltOfEnvelope,
  sealNote,
} from '../src/shared/crypto'

/**
 * The encryption primitive is the only thing that stands between a password and a note's words.
 *
 * These cases pin the three properties the rest of the feature relies on: the same password opens
 * what it sealed, a wrong password cannot, and an envelope cannot be moved to another note or
 * another field. The work factor is lowered here — the production constant is exercised by the
 * envelope's own `iter` field, not by making every unit test wait for it.
 */

const FAST = { iterations: 1_000 }

describe('a locked note round-trips', () => {
  it('opens the title and body with the same password', async () => {
    const session = await NoteLockSession.create('correct horse', FAST)
    const sealed = await sealNote(session, 'note-1', { title: 'Secret title', content: 'Body with 中文 and emoji 🚀' })

    expect(isNoteLockEnvelope(sealed.title)).toBe(true)
    expect(isNoteLockEnvelope(sealed.content)).toBe(true)

    const reopened = await NoteLockSession.create('correct horse', {
      salt: saltOfEnvelope(sealed.title)!,
      ...FAST,
    })
    await expect(openNote(reopened, 'note-1', sealed)).resolves.toEqual({
      title: 'Secret title',
      content: 'Body with 中文 and emoji 🚀',
    })
  })

  it('uses the shared memoenc:v1 envelope with one salt for both fields', async () => {
    const session = await NoteLockSession.create('batch', FAST)
    const first = await sealNote(session, 'note-a', { title: 'A', content: 'a' })
    expect(first.title.startsWith('memoenc:v1:')).toBe(true)
    expect(first.title.slice('memoenc:v1:'.length).split(':')).toHaveLength(3)
    expect(saltOfEnvelope(first.title)).toBe(session.salt)
    expect(saltOfEnvelope(first.content)).toBe(session.salt)
  })
})

describe('a lock refuses what it should not open', () => {
  it('throws a wrong-password error for the wrong password', async () => {
    const sealed = await sealNote(await NoteLockSession.create('right', FAST), 'n', { title: 't', content: 'c' })
    const wrong = await NoteLockSession.create('wrong', { salt: saltOfEnvelope(sealed.title)!, ...FAST })
    await expect(openNote(wrong, 'n', sealed)).rejects.toMatchObject({ code: 'wrong-password' })
  })

  it('refuses a ciphertext edited in place', async () => {
    const session = await NoteLockSession.create('pw', FAST)
    const sealed = await sealNote(session, 'n', { title: 't', content: 'c' })
    const parsed = sealed.content.slice('memoenc:v1:'.length).split(':')
    const data = parsed[2]!
    parsed[2] = `${data.slice(0, -2)}AA`
    const tampered = `memoenc:v1:${parsed.join(':')}`
    await expect(openNote(session, 'n', { title: sealed.title, content: tampered })).rejects.toBeInstanceOf(NoteUnlockError)
  })

  it('refuses an envelope sealed under a different salt', async () => {
    const sealed = await sealNote(await NoteLockSession.create('pw', FAST), 'a', { title: 't', content: 'c' })
    const other = await NoteLockSession.create('pw', FAST)
    await expect(openNote(other, 'n', sealed)).rejects.toMatchObject({ code: 'invalid-envelope' })
  })

  it('does not mistake ordinary text for an envelope', () => {
    expect(isNoteLockEnvelope('plain text')).toBe(false)
    expect(isNoteLockEnvelope('memoenc:v1:')).toBe(false)
    expect(isNoteLockEnvelope('memoenc:v1:a:b')).toBe(false)
    expect(isNoteLockEnvelope('inkstone:enc:v1:a:b:c')).toBe(false)
  })
})
