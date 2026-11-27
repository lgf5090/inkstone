// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { initI18n } from './i18n'

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(async () => {
  await initI18n()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the task time client', () => {
  it('reads one task through its encoded id and keeps the entry list', async () => {
    const entries = [{
      id: 'entry-1', taskId: 'task/1', startAt: 100, endAt: 200,
      day: '2026-10-20', source: 'manual', createdAt: 100, updatedAt: 200,
    }]
    const fetchMock = vi.fn(async () => json({ entries }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.todos.time('task/1')).resolves.toEqual({ entries })
    expect(fetchMock).toHaveBeenCalledWith('/api/todos/task%2F1/time', expect.objectContaining({
      method: 'GET',
      credentials: 'same-origin',
    }))
  })

  it('posts a manual span with both instants', async () => {
    const fetchMock = vi.fn(async () => json({ entries: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await api.todos.addTime('task-1', { startAt: 100, endAt: 200 })

    expect(fetchMock).toHaveBeenCalledWith('/api/todos/task-1/time', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ startAt: 100, endAt: 200 }),
    }))
  })

  it('deletes one entry through the encoded entry route', async () => {
    const fetchMock = vi.fn(async () => json({ deleted: true }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.todos.removeTime('entry/1')).resolves.toEqual({ deleted: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/todos/time/entry%2F1', expect.objectContaining({
      method: 'DELETE',
      credentials: 'same-origin',
    }))
  })
})
