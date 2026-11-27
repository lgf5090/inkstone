import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renewalsOn, todosDueOn, type LinkedTodo } from './linked'

const mocks = vi.hoisted(() => ({
  todos: vi.fn(),
  expiring: vi.fn(),
}))

vi.mock('../../lib/api', () => ({
  api: {
    todos: { list: mocks.todos },
    subscriptions: { expiring: mocks.expiring },
  },
}))

function task(id: number): LinkedTodo {
  return { id: String(id), title: `Task ${id}`, status: 'open', dueAt: Date.parse('2026-11-01T12:00:00Z') }
}

beforeEach(() => {
  mocks.todos.mockReset()
  mocks.expiring.mockReset()
})

describe('todosDueOn', () => {
  it('uses next-local-midnight bounds and follows the total across 121 tasks', async () => {
    const first = Array.from({ length: 60 }, (_, index) => task(index))
    const second = Array.from({ length: 61 }, (_, index) => task(index + 60))
    mocks.todos.mockResolvedValueOnce({ tasks: first, total: 121 }).mockResolvedValueOnce({ tasks: second, total: 121 })
    const controller = new AbortController()

    const rows = await todosDueOn('2026-11-01', controller.signal)

    expect(rows).toHaveLength(121)
    expect(rows.at(-1)!.id).toBe('120')
    expect(mocks.todos).toHaveBeenNthCalledWith(1, {
      dueFrom: '2026-11-01T00:00', dueTo: '2026-11-02T00:00', sort: 'due', limit: 500, offset: 0,
    }, controller.signal)
    expect(mocks.todos).toHaveBeenNthCalledWith(2, {
      dueFrom: '2026-11-01T00:00', dueTo: '2026-11-02T00:00', sort: 'due', limit: 500, offset: 60,
    }, controller.signal)
  })

  it('rejects an empty nonfinal page instead of returning a partial day', async () => {
    mocks.todos.mockResolvedValueOnce({ tasks: [], total: 121 })
    await expect(todosDueOn('2026-11-01')).rejects.toThrow('ended before its total')
  })

  it('propagates abort from the request', async () => {
    const error = new DOMException('Aborted', 'AbortError')
    mocks.todos.mockRejectedValue(error)
    await expect(todosDueOn('2026-11-01')).rejects.toBe(error)
  })
})

describe('renewalsOn', () => {
  it('traverses cursors and trusts the account-zone endpoint rather than UTC date slicing', async () => {
    const first = { id: 'a', name: 'A', amount: 1, currency: 'CNY' as const, expiryDate: '2026-10-31T16:00:00.000Z', isActive: true }
    const second = { ...first, id: 'b', name: 'B' }
    mocks.expiring.mockResolvedValueOnce({ items: [first], nextCursor: 'opaque-1' })
      .mockResolvedValueOnce({ items: [second], nextCursor: null })
    const controller = new AbortController()

    expect(await renewalsOn('2026-11-01', controller.signal)).toEqual([first, second])
    expect(mocks.expiring).toHaveBeenNthCalledWith(1, '2026-11-01', 500, undefined, controller.signal)
    expect(mocks.expiring).toHaveBeenNthCalledWith(2, '2026-11-01', 500, 'opaque-1', controller.signal)
  })

  it('propagates abort from a later cursor page', async () => {
    const error = new DOMException('Aborted', 'AbortError')
    mocks.expiring.mockResolvedValueOnce({ items: [], nextCursor: 'next' }).mockRejectedValueOnce(error)
    await expect(renewalsOn('2026-11-01')).rejects.toBe(error)
  })
})
