import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api'
import { memoRequest, memosApi } from './api'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(body, status))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function callOf(fetchMock: ReturnType<typeof stubFetch>, index = 0): [string, RequestInit] {
  const call = fetchMock.mock.calls[index]
  if (!call) throw new Error(`missing fetch call ${index}`)
  return [String(call[0]), call[1] ?? {}]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('memoRequest', () => {
  it('puts every path under the memos API prefix', async () => {
    const fetchMock = stubFetch({ items: [], nextCursor: null })
    await memoRequest('/anything')
    expect(callOf(fetchMock)[0]).toBe('/api/memos/anything')
  })

  it('keeps the shared request headers and sends JSON writes', async () => {
    const fetchMock = stubFetch({ id: 'memo' })
    await memosApi.create({ content: 'hello' })
    const [path, init] = callOf(fetchMock)
    expect(path).toBe('/api/memos')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ content: 'hello' }))
    const headers = init.headers as Record<string, string>
    expect(headers['X-Inkstone-Client']).toBe('1')
    expect(headers['Content-Type']).toBe('application/json')
  })
})

describe('memo list and detail', () => {
  it('encodes every list option and forwards the abort signal', async () => {
    const fetchMock = stubFetch({ items: [], nextCursor: null })
    const controller = new AbortController()
    await memosApi.list({
      state: 'normal',
      spaceId: 'space1',
      filter: 'tag == "design"',
      orderBy: 'updated',
      order: 'asc',
      cursor: 'abc',
      limit: 16,
      tz: 'Asia/Shanghai',
    }, controller.signal)
    const [path, init] = callOf(fetchMock)
    expect(path).toBe('/api/memos?state=normal&spaceId=space1&filter=tag+%3D%3D+%22design%22&orderBy=updated&order=asc&cursor=abc&limit=16&tz=Asia%2FShanghai')
    expect(init.signal).toBe(controller.signal)
  })

  it('omits an empty list query', async () => {
    const fetchMock = stubFetch({ items: [], nextCursor: null })
    await memosApi.list({ spaceId: null, filter: '', cursor: null })
    expect(callOf(fetchMock)[0]).toBe('/api/memos')
  })

  it('gets one memo with its id encoded', async () => {
    const fetchMock = stubFetch({ id: 'abc/def' })
    const controller = new AbortController()
    await memosApi.get('abc/def', controller.signal)
    const [path, init] = callOf(fetchMock)
    expect(path).toBe('/api/memos/abc%2Fdef')
    expect(init.signal).toBe(controller.signal)
  })

  it('patches, deletes and restores a memo', async () => {
    const fetchMock = stubFetch({ ok: true })
    await memosApi.patch('memo1', { rev: 2, content: 'next' })
    await memosApi.remove('memo1')
    await memosApi.restore('memo1')
    expect(callOf(fetchMock, 0)).toEqual(['/api/memos/memo1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ rev: 2, content: 'next' }),
    })])
    expect(callOf(fetchMock, 1)[0]).toBe('/api/memos/memo1')
    expect(callOf(fetchMock, 1)[1].method).toBe('DELETE')
    expect(callOf(fetchMock, 2)[0]).toBe('/api/memos/memo1/restore')
    expect(callOf(fetchMock, 2)[1].method).toBe('POST')
  })
})

describe('comments and relations', () => {
  it('lists and creates comments', async () => {
    const fetchMock = stubFetch({ items: [], nextCursor: null })
    const controller = new AbortController()
    await memosApi.comments.list('memo1', { cursor: 'next', limit: 16, tz: 'UTC' }, controller.signal)
    await memosApi.comments.create('memo1', { content: 'reply' })
    expect(callOf(fetchMock, 0)[0]).toBe('/api/memos/memo1/comments?cursor=next&limit=16&tz=UTC')
    expect(callOf(fetchMock, 0)[1].signal).toBe(controller.signal)
    expect(callOf(fetchMock, 1)).toEqual(['/api/memos/memo1/comments', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ content: 'reply' }),
    })])
  })

  it('reads and replaces relations', async () => {
    const fetchMock = stubFetch({ outgoing: [], incoming: [] })
    const controller = new AbortController()
    await memosApi.relations.get('memo1', controller.signal)
    await memosApi.relations.put('memo1', ['memo2', 'memo3'])
    expect(callOf(fetchMock, 0)[0]).toBe('/api/memos/memo1/relations')
    expect(callOf(fetchMock, 0)[1].signal).toBe(controller.signal)
    expect(callOf(fetchMock, 1)).toEqual(['/api/memos/memo1/relations', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ relatedMemoIds: ['memo2', 'memo3'] }),
    })])
  })
})

describe('reactions', () => {
  it('lists, upserts and removes a reaction', async () => {
    const fetchMock = stubFetch({ reactions: [] })
    const controller = new AbortController()
    await memosApi.reactions.list('memo1', controller.signal)
    await memosApi.reactions.upsert('memo1', { type: '👍' })
    await memosApi.reactions.delete('memo1', '👍')
    expect(callOf(fetchMock, 0)[0]).toBe('/api/memos/memo1/reactions')
    expect(callOf(fetchMock, 0)[1].signal).toBe(controller.signal)
    expect(callOf(fetchMock, 1)).toEqual(['/api/memos/memo1/reactions', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ type: '👍' }),
    })])
    expect(callOf(fetchMock, 2)[0]).toBe('/api/memos/memo1/reactions/%F0%9F%91%8D')
    expect(callOf(fetchMock, 2)[1].method).toBe('DELETE')
  })
})

describe('views and preferences', () => {
  it('drives saved views', async () => {
    const fetchMock = stubFetch({ views: [] })
    await memosApi.views.list()
    await memosApi.views.create({ title: 'Today', filter: 'created_ts > 0' })
    await memosApi.views.update('view1', { title: 'Later' })
    await memosApi.views.delete('view1')
    await memosApi.views.validate('tag == "x"')
    expect(callOf(fetchMock, 0)[0]).toBe('/api/memos/views')
    expect(callOf(fetchMock, 1)).toEqual(['/api/memos/views', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ title: 'Today', filter: 'created_ts > 0' }),
    })])
    expect(callOf(fetchMock, 2)).toEqual(['/api/memos/views/view1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ title: 'Later' }),
    })])
    expect(callOf(fetchMock, 3)[0]).toBe('/api/memos/views/view1')
    expect(callOf(fetchMock, 3)[1].method).toBe('DELETE')
    expect(callOf(fetchMock, 4)).toEqual(['/api/memos/views/validate', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ filter: 'tag == "x"' }),
    })])
  })

  it('reads and patches preferences', async () => {
    const fetchMock = stubFetch({ defaultVisibility: 'private' })
    await memosApi.preferences.get()
    await memosApi.preferences.patch({ enableLinkPreview: false })
    expect(callOf(fetchMock, 0)[0]).toBe('/api/memos/preferences')
    expect(callOf(fetchMock, 1)).toEqual(['/api/memos/preferences', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ enableLinkPreview: false }),
    })])
  })
})

describe('access tokens', () => {
  it('lists tokens, creates one and revokes it by id', async () => {
    const fetchMock = stubFetch({ tokens: [] })
    const controller = new AbortController()
    await memosApi.tokens.list(controller.signal)
    await memosApi.tokens.create({ description: 'Web Clipper', expiresAt: 1_900_000_000 })
    await memosApi.tokens.delete('tok/1')
    expect(callOf(fetchMock, 0)[0]).toBe('/api/memos/tokens')
    expect(callOf(fetchMock, 0)[1].signal).toBe(controller.signal)
    expect(callOf(fetchMock, 1)).toEqual(['/api/memos/tokens', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ description: 'Web Clipper', expiresAt: 1_900_000_000 }),
    })])
    expect(callOf(fetchMock, 2)[0]).toBe('/api/memos/tokens/tok%2F1')
    expect(callOf(fetchMock, 2)[1].method).toBe('DELETE')
  })
})

describe('spaces', () => {
  it('lists, creates, updates and deletes a space', async () => {
    const fetchMock = stubFetch({ spaces: [] })
    await memosApi.spaces.list()
    await memosApi.spaces.create({ title: 'Work' })
    await memosApi.spaces.update('space1', { icon: 'W' })
    await memosApi.spaces.delete('space1', 'delete')
    expect(callOf(fetchMock, 0)[0]).toBe('/api/memos/spaces')
    expect(callOf(fetchMock, 1)).toEqual(['/api/memos/spaces', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ title: 'Work' }),
    })])
    expect(callOf(fetchMock, 2)).toEqual(['/api/memos/spaces/space1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ icon: 'W' }),
    })])
    expect(callOf(fetchMock, 3)[0]).toBe('/api/memos/spaces/space1?mode=delete')
    expect(callOf(fetchMock, 3)[1].method).toBe('DELETE')
  })

  it('defaults space deletion to unfiling', async () => {
    const fetchMock = stubFetch({ ok: true })
    await memosApi.spaces.delete('space1')
    expect(callOf(fetchMock)[0]).toBe('/api/memos/spaces/space1?mode=unfile')
  })
})

describe('attachments', () => {
  it('lists attachments by scope and memo', async () => {
    const fetchMock = stubFetch({ items: [], nextCursor: null })
    const controller = new AbortController()
    await memosApi.attachments.list({
      scope: 'media',
      memoId: 'memo1',
      cursor: 'next',
      limit: 16,
    }, controller.signal)
    expect(callOf(fetchMock, 0)[0]).toBe('/api/memos/attachments?scope=media&memoId=memo1&cursor=next&limit=16')
    expect(callOf(fetchMock, 0)[1].signal).toBe(controller.signal)
  })

  it('uploads a file, thumbnail and media metadata as multipart', async () => {
    const fetchMock = stubFetch({ id: 'attachment1' })
    const file = new File(['image'], 'photo.png', { type: 'image/png' })
    const thumbnail = new File(['thumb'], 'thumb.png', { type: 'image/png' })
    await memosApi.attachments.upload({
      file,
      thumbnail,
      memoId: 'memo1',
      metadata: { photo: { width: 10, height: 20 } },
      motionGroupId: 'group1',
      motionRole: 'still',
    })
    const [path, init] = callOf(fetchMock)
    expect(path).toBe('/api/memos/attachments')
    expect(init.method).toBe('POST')
    const form = init.body
    expect(form).toBeInstanceOf(FormData)
    const body = form as FormData
    expect(body.get('file')).toBe(file)
    expect(body.get('thumbnail')).toBe(thumbnail)
    expect(body.get('memoId')).toBe('memo1')
    expect(body.get('metadata')).toBe(JSON.stringify({ photo: { width: 10, height: 20 } }))
    expect(body.get('motionGroupId')).toBe('group1')
    expect(body.get('motionRole')).toBe('still')
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBeUndefined()
  })

  it('deletes, batch deletes and prunes attachments', async () => {
    const fetchMock = stubFetch({ ok: true })
    await memosApi.attachments.delete('attachment1')
    await memosApi.attachments.batchDelete(['attachment1', 'attachment2'])
    await memosApi.attachments.prune()
    expect(callOf(fetchMock, 0)[0]).toBe('/api/memos/attachments/attachment1')
    expect(callOf(fetchMock, 0)[1].method).toBe('DELETE')
    expect(callOf(fetchMock, 1)).toEqual(['/api/memos/attachments/batch-delete', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ ids: ['attachment1', 'attachment2'] }),
    })])
    expect(callOf(fetchMock, 2)[0]).toBe('/api/memos/attachments/prune')
    expect(callOf(fetchMock, 2)[1].method).toBe('POST')
  })
})

describe('stats, shares and public data', () => {
  it('encodes the stats query', async () => {
    const fetchMock = stubFetch({
      total: 0,
      archived: 0,
      comments: 0,
      attachmentBytes: 0,
      tagCounts: {},
      typeCounts: { link: 0, code: 0, todo: 0, undo: 0 },
      dayCounts: {},
    })
    await memosApi.stats.get({ spaceId: 'space1', from: 10, to: 20, tz: 'UTC', timeBasis: 'updated' })
    expect(callOf(fetchMock)[0]).toBe('/api/memos/stats?spaceId=space1&from=10&to=20&tz=UTC&timeBasis=updated')
  })

  it('lists, creates and removes shares', async () => {
    const fetchMock = stubFetch({ shares: [] })
    await memosApi.shares.list('memo1')
    await memosApi.shares.create('memo1', { expiresAt: 123 })
    await memosApi.shares.delete('memo1', 'share/1')
    expect(callOf(fetchMock, 0)[0]).toBe('/api/memos/memo1/shares')
    expect(callOf(fetchMock, 1)).toEqual(['/api/memos/memo1/shares', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ expiresAt: 123 }),
    })])
    expect(callOf(fetchMock, 2)[0]).toBe('/api/memos/memo1/shares/share%2F1')
    expect(callOf(fetchMock, 2)[1].method).toBe('DELETE')
  })

  it('reads public explore, profiles, detail and shares', async () => {
    const fetchMock = stubFetch({ items: [], nextCursor: null })
    await memosApi.publicMemos.explore({ cursor: 'c', limit: 20 })
    await memosApi.publicMemos.userMemos('alice/name', { limit: 16 })
    await memosApi.publicMemos.userMemo('alice/name', 'memo/1')
    await memosApi.publicMemos.share('share/token')
    expect(callOf(fetchMock, 0)[0]).toBe('/api/memos/public/explore?cursor=c&limit=20')
    expect(callOf(fetchMock, 1)[0]).toBe('/api/memos/public/users/alice%2Fname/memos?limit=16')
    expect(callOf(fetchMock, 2)[0]).toBe('/api/memos/public/users/alice%2Fname/memos/memo%2F1')
    expect(callOf(fetchMock, 3)[0]).toBe('/api/memos/public/shares/share%2Ftoken')
  })
})

describe('failures', () => {
  it('throws the shared ApiError for a refused memo request', async () => {
    stubFetch({ error: { code: 'memo_not_found', message: 'Memo not found' } }, 404)
    const error = await memosApi.get('missing').then(() => null).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(404)
    expect((error as ApiError).code).toBe('memo_not_found')
  })
})
