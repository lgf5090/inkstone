// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newId } from '../src/worker/lib/id'
import { makeCloudflareBed, readJson, TEST_USER } from './cloudflare-fixtures'

const mocks = vi.hoisted(() => ({ userId: 'u'.repeat(26) }))
vi.mock('../src/worker/middleware/auth', () => ({
  requireClientHeader: async (_c: unknown, next: () => Promise<void>) => { await next() },
  loadSession: async (_c: unknown, next: () => Promise<void>) => { await next() },
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

afterEach(() => vi.unstubAllGlobals())

const BASE = '/api/cloudflare/ai/chat/sessions'
const OTHER_USER = 'o'.repeat(26)

function request(body?: unknown, method = 'POST'): RequestInit {
  return {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }
}

interface SessionBody {
  id: string
  title: string
  pinned: number
  favorite: number
  created_at: number
  updated_at: number
  message_count?: number
}

interface MessageBody {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: number
}

async function createSession(
  bed: Awaited<ReturnType<typeof makeCloudflareBed>>,
  title?: string,
): Promise<SessionBody> {
  const response = await bed.app.request(
    BASE,
    request(title === undefined ? {} : { title }),
    bed.env,
  )
  expect(response.status).toBe(201)
  return await readJson<SessionBody>(response)
}

describe('the chat sessions routes', () => {
  it('creates, lists, renames, pins and favorites a session', async () => {
    const bed = await makeCloudflareBed()
    const first = await createSession(bed, 'First')
    const second = await createSession(bed)
    expect(second.title).toBe('')
    expect(second.message_count).toBe(0)

    let list = await readJson<SessionBody[]>(
      await bed.app.request(BASE, {}, bed.env),
    )
    expect(list.map((row) => row.id).sort()).toEqual([first.id, second.id].sort())

    // Deterministic ordering: pinned first, then the most recently updated.
    await bed.env.DB.prepare('UPDATE cloudflare_chat_session SET pinned = 0, favorite = 0, updated_at = ? WHERE id = ?')
      .bind(1000, first.id).run()
    await bed.env.DB.prepare('UPDATE cloudflare_chat_session SET pinned = 0, favorite = 0, updated_at = ? WHERE id = ?')
      .bind(2000, second.id).run()
    list = await readJson<SessionBody[]>(await bed.app.request(BASE, {}, bed.env))
    expect(list.map((row) => row.id)).toEqual([second.id, first.id])

    const updated = await bed.app.request(`${BASE}/${first.id}`, request({
      title: 'Renamed',
      pinned: true,
      favorite: true,
    }, 'PUT'), bed.env)
    expect(updated.status).toBe(200)
    expect(await readJson<SessionBody>(updated)).toMatchObject({
      id: first.id,
      title: 'Renamed',
      pinned: 1,
      favorite: 1,
    })

    list = await readJson<SessionBody[]>(await bed.app.request(BASE, {}, bed.env))
    expect(list[0]?.id).toBe(first.id)

    const pinned = await readJson<SessionBody[]>(
      await bed.app.request(`${BASE}?tab=pinned`, {}, bed.env),
    )
    expect(pinned.map((row) => row.id)).toEqual([first.id])
    const favorites = await readJson<SessionBody[]>(
      await bed.app.request(`${BASE}?tab=favorite`, {}, bed.env),
    )
    expect(favorites.map((row) => row.id)).toEqual([first.id])

    const badTab = await bed.app.request(`${BASE}?tab=recent`, {}, bed.env)
    expect(badTab.status).toBe(400)
  })

  it('appends messages, counts them, and finds sessions by message content', async () => {
    const bed = await makeCloudflareBed()
    const session = await createSession(bed)

    const appended = await bed.app.request(`${BASE}/${session.id}/messages`, request({
      messages: [
        { role: 'user', content: 'a needle in the haystack' },
        { role: 'assistant', content: 'an answer' },
      ],
    }), bed.env)
    expect(appended.status).toBe(200)
    const inserted = await readJson<MessageBody[]>(appended)
    expect(inserted).toHaveLength(2)
    expect(inserted[0]).toMatchObject({ session_id: session.id, role: 'user', content: 'a needle in the haystack' })
    expect(inserted[1]?.created_at).toBeGreaterThan(inserted[0]!.created_at)

    const messages = await readJson<MessageBody[]>(
      await bed.app.request(`${BASE}/${session.id}/messages`, {}, bed.env),
    )
    expect(messages.map((row) => row.content)).toEqual(['a needle in the haystack', 'an answer'])

    const searched = await readJson<SessionBody[]>(
      await bed.app.request(`${BASE}?q=needle`, {}, bed.env),
    )
    expect(searched.map((row) => row.id)).toEqual([session.id])
    expect(searched[0]?.message_count).toBe(2)

    const invalidRole = await bed.app.request(`${BASE}/${session.id}/messages`, request({
      messages: [{ role: 'system', content: 'nope' }],
    }), bed.env)
    expect(invalidRole.status).toBe(400)
  })

  it('removes the last assistant turn, clears the transcript and deletes the session', async () => {
    const bed = await makeCloudflareBed()
    const session = await createSession(bed)
    await bed.app.request(`${BASE}/${session.id}/messages`, request({
      messages: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'assistant', content: 'second answer' },
      ],
    }), bed.env)

    const dropped = await bed.app.request(`${BASE}/${session.id}/messages/last-assistant`, request(undefined, 'DELETE'), bed.env)
    expect(dropped.status).toBe(200)
    expect(await readJson<{ ok: boolean }>(dropped)).toEqual({ ok: true })
    let messages = await readJson<MessageBody[]>(
      await bed.app.request(`${BASE}/${session.id}/messages`, {}, bed.env),
    )
    expect(messages.map((row) => row.content)).toEqual(['question', 'first answer'])

    const cleared = await bed.app.request(`${BASE}/${session.id}/messages`, request(undefined, 'DELETE'), bed.env)
    expect(cleared.status).toBe(200)
    expect(await readJson<{ ok: boolean }>(cleared)).toEqual({ ok: true })
    messages = await readJson<MessageBody[]>(
      await bed.app.request(`${BASE}/${session.id}/messages`, {}, bed.env),
    )
    expect(messages).toEqual([])

    const removed = await bed.app.request(`${BASE}/${session.id}`, request(undefined, 'DELETE'), bed.env)
    expect(removed.status).toBe(200)
    expect(await readJson<{ ok: boolean }>(removed)).toEqual({ ok: true })
    const gone = await bed.app.request(`${BASE}/${session.id}/messages`, {}, bed.env)
    expect(gone.status).toBe(404)
  })

  it('answers another reader’s session as missing everywhere', async () => {
    const bed = await makeCloudflareBed()
    const sessionId = newId()
    const now = Date.now()
    await bed.env.DB.prepare(
      `INSERT INTO cloudflare_chat_session (id, user_id, title, pinned, favorite, created_at, updated_at)
       VALUES (?, ?, 'Private', 0, 0, ?, ?)`,
    ).bind(sessionId, OTHER_USER, now, now).run()
    await bed.env.DB.prepare(
      `INSERT INTO cloudflare_chat_message (id, user_id, session_id, role, content, created_at)
       VALUES (?, ?, ?, 'user', 'secret', ?)`,
    ).bind(newId(), OTHER_USER, sessionId, now).run()

    const list = await readJson<SessionBody[]>(await bed.app.request(BASE, {}, bed.env))
    expect(list).toEqual([])

    const requests: Array<Promise<Response>> = [
      bed.app.request(`${BASE}/${sessionId}/messages`, {}, bed.env),
      bed.app.request(`${BASE}/${sessionId}/messages`, request({
        messages: [{ role: 'user', content: 'write' }],
      }), bed.env),
      bed.app.request(`${BASE}/${sessionId}/messages/last-assistant`, request(undefined, 'DELETE'), bed.env),
      bed.app.request(`${BASE}/${sessionId}/messages`, request(undefined, 'DELETE'), bed.env),
      bed.app.request(`${BASE}/${sessionId}`, request({ title: 'Mine now' }, 'PUT'), bed.env),
      bed.app.request(`${BASE}/${sessionId}`, request(undefined, 'DELETE'), bed.env),
    ]
    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(404)
    }

    const row = await bed.env.DB.prepare(
      'SELECT title FROM cloudflare_chat_session WHERE id = ?',
    ).bind(sessionId).first<{ title: string }>()
    expect(row?.title).toBe('Private')
  })

  it('refuses malformed session ids as missing', async () => {
    const bed = await makeCloudflareBed()
    const response = await bed.app.request(`${BASE}/not-an-id/messages`, {}, bed.env)
    expect(response.status).toBe(404)
  })
})
