// @vitest-environment jsdom
/**
 * The revision and the key a task write travels with.
 *
 * The route refuses a stale write by comparing `If-Match` with the row's revision, so the guard is only
 * real if the client actually puts the header on the request. This pins the wire shape: the revision
 * argument of `api.todos.update`, `api.todos.plan` and `api.todos.snooze` becomes `If-Match`, and a
 * write that names no revision stays unconditional, which is what the older surfaces (the assistant's
 * tools, an undo) still send.
 *
 * A create has the same problem in the other direction: it is not conditional but repeatable, so the
 * second argument of `api.todos.create` becomes `Idempotency-Key` and the route can answer a lost
 * response with the row it already wrote instead of a second one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'

const requests: Array<{ url: string; init: RequestInit }> = []

function stubFetch(): void {
  requests.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify({ task: { id: 'task-1' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }))
}

function headersOf(index = 0): Record<string, string> {
  return (requests[index]!.init.headers ?? {}) as Record<string, string>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a guarded task write', () => {
  it('sends the revision as If-Match', async () => {
    stubFetch()

    await api.todos.update('task-1', { title: 'Edited' }, 7)

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('/api/todos/task-1')
    expect(requests[0]!.init.method).toBe('PATCH')
    expect(headersOf()['If-Match']).toBe('7')
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ title: 'Edited' })
  })

  it('leaves the guard off a write that names no revision', async () => {
    stubFetch()

    await api.todos.update('task-1', { title: 'Edited' })

    expect(headersOf()).not.toHaveProperty('If-Match')
  })

  it('sends a create its idempotency key', async () => {
    stubFetch()

    await api.todos.create({ title: 'Book the room' }, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')

    expect(requests[0]!.url).toBe('/api/todos')
    expect(requests[0]!.init.method).toBe('POST')
    expect(headersOf()['Idempotency-Key']).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  })

  it('sends a plain create with no key', async () => {
    stubFetch()

    await api.todos.create({ title: 'Book the room' })

    expect(headersOf()).not.toHaveProperty('Idempotency-Key')
  })

  it('sends a pick and a snooze the revision they were read at', async () => {
    stubFetch()

    await api.todos.plan('task-1', '2026-10-21', 7)
    await api.todos.snooze('task-1', 60, 8)

    expect(requests[0]!.url).toBe('/api/todos/task-1/plan')
    expect(headersOf(0)['If-Match']).toBe('7')
    expect(requests[1]!.url).toBe('/api/todos/task-1/snooze')
    expect(headersOf(1)['If-Match']).toBe('8')
  })

  it('leaves a pick and a snooze unconditional when no revision is named', async () => {
    stubFetch()

    await api.todos.plan('task-1', null)
    await api.todos.snooze('task-1', 60)

    expect(headersOf(0)).not.toHaveProperty('If-Match')
    expect(headersOf(1)).not.toHaveProperty('If-Match')
  })
})
