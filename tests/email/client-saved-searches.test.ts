// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailSavedSearch } from '@shared/email/searches'
import { api } from '../../src/client/lib/api'
import { useEmailStore } from '../../src/client/features/email/store'

const original = useEmailStore.getState()

function search(patch: Partial<EmailSavedSearch> = {}): EmailSavedSearch {
  return {
    id: 's1',
    name: 'Invoices',
    query: 'from:billing is:unread',
    createdAt: '2026-01-01T10:00:00.000Z',
    ...patch,
  }
}

beforeEach(() => {
  useEmailStore.setState(original, true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useEmailStore.setState(original, true)
})

describe('the saved search api', () => {
  it('uses the account search routes and sends the documented bodies', async () => {
    const calls: { path: string; method: string; body: string | null }[] = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({
        path,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      const parsed = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      const payload = init?.method === 'POST'
        ? search({ name: String(parsed.name), query: String(parsed.query) })
        : init?.method === 'PATCH'
          ? search({ name: String(parsed.name) })
          : [search()]
      return new Response(JSON.stringify(payload), {
        status: init?.method === 'POST' ? 201 : 200,
        headers: { 'content-type': 'application/json' },
      })
    }))

    await expect(api.email.listSearches('a1')).resolves.toEqual([search()])
    await api.email.createSearch('a1', { name: 'Invoices', query: 'from:billing' })
    await api.email.updateSearch('a1', 's1', { name: 'Billing' })
    await api.email.deleteSearch('a1', 's1')

    expect(calls.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      'GET /api/email/accounts/a1/searches',
      'POST /api/email/accounts/a1/searches',
      'PATCH /api/email/accounts/a1/searches/s1',
      'DELETE /api/email/accounts/a1/searches/s1',
    ])
    expect(JSON.parse(calls[1]!.body!)).toEqual({ name: 'Invoices', query: 'from:billing' })
    expect(JSON.parse(calls[2]!.body!)).toEqual({ name: 'Billing' })
  })
})

describe('the saved search store', () => {
  it('loads searches and keeps the previous account list separate', async () => {
    const first = search()
    const list = vi.spyOn(api.email, 'listSearches')
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([])
    await useEmailStore.getState().loadSearches('a1')
    expect(useEmailStore.getState()).toMatchObject({
      searches: [first],
      searchesStatus: 'ready',
      searchesError: null,
      searchesAccountId: 'a1',
    })
    expect(list).toHaveBeenCalledWith('a1')

    await useEmailStore.getState().loadSearches('b1')
    expect(useEmailStore.getState()).toMatchObject({
      searches: [],
      searchesStatus: 'ready',
      searchesAccountId: 'b1',
    })
  })

  it('reports a failed load without dropping to an empty ready list', async () => {
    vi.spyOn(api.email, 'listSearches').mockRejectedValueOnce(new Error('Searches offline'))
    await useEmailStore.getState().loadSearches('a1')
    expect(useEmailStore.getState().searchesStatus).toBe('error')
    expect(useEmailStore.getState().searchesError).toBe('Searches offline')
  })

  it('creates, renames and deletes a search and reloads the list after each write', async () => {
    const created = search()
    const list = vi.spyOn(api.email, 'listSearches').mockResolvedValue([created])
    const create = vi.spyOn(api.email, 'createSearch').mockResolvedValue(created)
    await expect(useEmailStore.getState().createSearch('a1', 'Invoices', 'from:billing')).resolves.toEqual(created)
    expect(create).toHaveBeenCalledWith('a1', { name: 'Invoices', query: 'from:billing' })

    const update = vi.spyOn(api.email, 'updateSearch').mockResolvedValue(search({ name: 'Billing' }))
    await useEmailStore.getState().renameSearch('a1', created.id, 'Billing')
    expect(update).toHaveBeenCalledWith('a1', created.id, { name: 'Billing' })

    const remove = vi.spyOn(api.email, 'deleteSearch').mockResolvedValue(undefined)
    list.mockResolvedValueOnce([])
    await useEmailStore.getState().deleteSearch('a1', created.id)
    expect(remove).toHaveBeenCalledWith('a1', created.id)
    expect(useEmailStore.getState().searches).toEqual([])
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('clears saved searches when their account is deleted', async () => {
    useEmailStore.setState({
      accountId: 'a1',
      searches: [search()],
      searchesStatus: 'ready',
      searchesAccountId: 'a1',
      accounts: [{
        id: 'a1',
        address: 'owner@example.com',
        displayName: 'Owner',
        settings: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    })
    vi.spyOn(api.email, 'deleteAccount').mockResolvedValue(undefined)
    await useEmailStore.getState().deleteAccount('a1')
    expect(useEmailStore.getState()).toMatchObject({
      searches: [],
      searchesStatus: 'idle',
      searchesError: null,
      searchesAccountId: null,
    })
  })
})
