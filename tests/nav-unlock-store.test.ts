// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NAV_LIMITS } from '../src/shared/nav/model'
import { navApi } from '../src/client/features/nav/api'
import { useSession } from '../src/client/store/session'
import { requestTokens, useNavStore } from '../src/client/features/nav/nav-store'

describe('navigation unlock store', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.sessionStorage.clear()
    useSession.setState({ user: { id: 'user-1' } as never })
    useNavStore.setState({ unlocks: {}, status: 'ready' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function unlockMany(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const expiresAt = 1_000_000 + index * 1_000
      vi.spyOn(navApi, 'unlockCategory').mockResolvedValue({ token: `token-${index}`, expiresAt })
      vi.spyOn(navApi, 'bootstrap').mockResolvedValue({
        categories: [], links: [], visits: {}, settings: { display: {}, search: {}, ai: {} },
        webdav: { url: '', username: '', hasPassword: false }, counts: { total: 0, byCategory: {} }, serverTime: 1,
      } as never)
      await useNavStore.getState().unlock(`cat-${index}`, 'password')
    }
  }

  it('keeps only as many unlocks as the server reads back', async () => {
    await unlockMany(NAV_LIMITS.unlockTokens + 5)
    const unlocks = useNavStore.getState().unlocks
    expect(Object.keys(unlocks)).toHaveLength(NAV_LIMITS.unlockTokens)
    // The twenty with the furthest expiry, not the twenty unlocked first: the server takes the head of the
    // list it is sent, so keeping the oldest silently dropped whichever folder had just been opened.
    expect(unlocks[`cat-${NAV_LIMITS.unlockTokens + 4}`]).toBeDefined()
    expect(unlocks['cat-0']).toBeUndefined()
    expect(requestTokens(unlocks)).toHaveLength(NAV_LIMITS.unlockTokens)
  })

  it('drops an unlock once the server has expired it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2000))
    vi.spyOn(navApi, 'unlockCategory').mockResolvedValue({ token: 'soon-gone', expiresAt: 5000 })
    vi.spyOn(navApi, 'bootstrap').mockResolvedValue({
      categories: [], links: [], visits: {}, settings: { display: {}, search: {}, ai: {} },
      webdav: { url: '', username: '', hasPassword: false }, counts: { total: 0, byCategory: {} }, serverTime: 1,
    } as never)
    await useNavStore.getState().unlock('cat-x', 'password')
    expect(useNavStore.getState().unlocks['cat-x']).toBeDefined()

    vi.setSystemTime(new Date(9000))
    await useNavStore.getState().load(true)
    expect(useNavStore.getState().unlocks['cat-x']).toBeUndefined()
  })

  it('ignores entries left by the older token-only format', async () => {
    window.sessionStorage.setItem('inkstone.nav.unlocks.user-1', JSON.stringify({ 'cat-old': 'bare-token' }))
    vi.spyOn(navApi, 'bootstrap').mockResolvedValue({
      categories: [], links: [], visits: {}, settings: { display: {}, search: {}, ai: {} },
      webdav: { url: '', username: '', hasPassword: false }, counts: { total: 0, byCategory: {} }, serverTime: 1,
    } as never)
    await useNavStore.getState().load(true)
    expect(useNavStore.getState().unlocks['cat-old']).toBeUndefined()
    expect(requestTokens(useNavStore.getState().unlocks)).toEqual([])
  })
})
