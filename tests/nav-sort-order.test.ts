// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NAV_SETTINGS, type NavBootstrap } from '../src/shared/nav/model'
import { useNavStore } from '../src/client/features/nav/nav-store'
import { navApi } from '../src/client/features/nav/api'
import { useSession } from '../src/client/store/session'
import type { PublicUser } from '../src/shared/types'

const USER: PublicUser = { id: 'user-1', login: 'user-1', name: 'User', avatarUrl: '', role: 'member', createdAt: 0, username: 'user-1' }

const BOOTSTRAP: NavBootstrap = {
  categories: [],
  links: [],
  visits: {},
  settings: DEFAULT_NAV_SETTINGS,
  webdav: { url: '', username: '', hasPassword: false },
  counts: { total: 0, byCategory: {} },
  serverTime: 1,
}

afterEach(() => {
  vi.restoreAllMocks()
  useSession.setState({ user: null })
})

describe('nav reorder requests', () => {
  it('passes every unlocked category with a pinned reorder', async () => {
    useSession.setState({ user: USER })
    const order = vi.spyOn(navApi, 'orderLinks').mockResolvedValue({ ok: true })
    vi.spyOn(navApi, 'bootstrap').mockResolvedValue(BOOTSTRAP)
    useNavStore.setState({ status: 'ready', unlockTokens: { 'cat-a': 'token-a', 'cat-b': 'token-b' } })
    const ids = ['a'.repeat(26), 'b'.repeat(26)]

    await useNavStore.getState().reorderLinks('pinned', ids)
    expect(order).toHaveBeenCalledWith({ scope: 'pinned', categoryId: undefined, orderedIds: ids }, ['token-a', 'token-b'])
  })

  it('keeps the category id and unlock tokens on an in-category reorder', async () => {
    useSession.setState({ user: USER })
    const order = vi.spyOn(navApi, 'orderLinks').mockResolvedValue({ ok: true })
    vi.spyOn(navApi, 'bootstrap').mockResolvedValue(BOOTSTRAP)
    useNavStore.setState({ status: 'ready', unlockTokens: { 'cat-a': 'token-a' } })
    const ids = ['a'.repeat(26), 'b'.repeat(26)]

    await useNavStore.getState().reorderLinks('category', ids, 'c'.repeat(26))
    expect(order).toHaveBeenCalledWith({ scope: 'category', categoryId: 'c'.repeat(26), orderedIds: ids }, ['token-a'])
  })
})
