// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { initI18n } from './i18n'

beforeEach(async () => {
  await initI18n()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the JSON to-do import client', () => {
  it('parses the picked document and sends the conflict rule and retry key', async () => {
    const document = { format: 'inkstone-todos', version: 1, tasks: [] }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      total: 0, created: 0, skipped: 0, failed: 0, partial: false, imported: [], errors: [], warnings: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await api.todos.importJson(
      new File([JSON.stringify(document)], 'tasks.json', { type: 'application/json' }),
      'duplicate',
      'todo-json-retry-1',
    )

    expect(fetchMock).toHaveBeenCalledWith('/api/todos/import-json?conflict=duplicate', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(document),
      headers: expect.objectContaining({ 'Idempotency-Key': 'todo-json-retry-1' }),
    }))
  })

  it('refuses malformed JSON before making a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.todos.importJson(
      new File(['{broken'], 'tasks.json', { type: 'application/json' }),
      'skip',
      'todo-json-retry-2',
    )).rejects.toBeInstanceOf(SyntaxError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
