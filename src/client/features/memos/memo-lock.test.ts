import { webcrypto } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptMemoContent } from './memo-crypto'
import { memoPlaintext, useMemoLock } from './memo-lock'

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})

beforeEach(() => {
  sessionStorage.clear()
  useMemoLock.setState({ userId: null, passphrase: null, unlockedAt: {}, plaintext: {} })
})

describe('memo reveal state', () => {
  it('keeps a revealed body in memory and forgets it on lock', async () => {
    const sealed = await encryptMemoContent('tab passphrase', 'visible body')
    useMemoLock.getState().hydrate('user-1')
    await useMemoLock.getState().unlockWithPassphrase('memo-1', sealed, 'tab passphrase', 30)
    expect(memoPlaintext('memo-1')).toBe('visible body')
    expect(useMemoLock.getState().passphrase).toBe('tab passphrase')

    useMemoLock.getState().lock('memo-1')
    expect(memoPlaintext('memo-1')).toBeNull()
    expect(useMemoLock.getState().passphrase).toBe('tab passphrase')
  })

  it('re-hides a reveal when its minutes are over', async () => {
    const sealed = await encryptMemoContent('tab passphrase', 'visible body')
    useMemoLock.getState().hydrate('user-1')
    await useMemoLock.getState().unlockWithPassphrase('memo-1', sealed, 'tab passphrase', 30)
    useMemoLock.setState({ unlockedAt: { 'memo-1': Date.now() - 1 } })
    expect(useMemoLock.getState().plaintext['memo-1']).toBe('visible body')
    useMemoLock.getState().expire()
    expect(useMemoLock.getState().plaintext['memo-1']).toBeUndefined()
    expect(useMemoLock.getState().unlockedAt['memo-1']).toBeUndefined()
  })

  it('re-hides every body on navigation and keeps the passphrase for the tab', async () => {
    const sealed = await encryptMemoContent('tab passphrase', 'visible body')
    useMemoLock.getState().hydrate('user-1')
    await useMemoLock.getState().unlockWithPassphrase('memo-1', sealed, 'tab passphrase', 30)
    useMemoLock.getState().lockAll()
    expect(useMemoLock.getState().plaintext).toEqual({})
    expect(useMemoLock.getState().unlockedAt).toEqual({})
    expect(useMemoLock.getState().passphrase).toBe('tab passphrase')
  })

  it('keeps the passphrase in session storage, not in a durable store', async () => {
    useMemoLock.getState().hydrate('user-1')
    useMemoLock.getState().setPassphrase('only this tab')
    expect(sessionStorage.getItem('inkstone.memos.passphrase:user-1')).toBe('only this tab')
    expect(localStorage.getItem('inkstone.memos.passphrase:user-1')).toBeNull()
  })
})
