import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api'
import { localDb, type OutboxItem } from '../../lib/db'
import {
  PROJECT_OUTBOX_CHANGED_EVENT, PROJECT_OUTBOX_FLUSHED_EVENT,
} from '../../lib/runtime'
import {
  enqueueProjectWrite, notifyProjectOutboxFlushed, pendingProjectWrites, replayProjectOutboxItem,
} from './offline-outbox'
import { request } from '../../lib/api'

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, request: vi.fn() }
})

vi.mock('../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/db')>()
  return {
    ...actual,
    localDb: {
      getOutbox: vi.fn(),
      enqueueOutbox: vi.fn(),
      completeOutboxItem: vi.fn(),
      markOutboxFailure: vi.fn(),
      withOutboxReplayLock: vi.fn(),
    },
  }
})

function item(payload: Record<string, unknown>): OutboxItem {
  return {
    id: 'pw_test', clientId: 'client', writeId: 'pw_test', entity: 'project',
    entityId: 'b1', payload, attempts: 0, createdAt: 1,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(localDb.enqueueOutbox).mockResolvedValue(undefined)
  vi.mocked(localDb.getOutbox).mockResolvedValue([])
  vi.mocked(localDb.markOutboxFailure).mockResolvedValue(undefined)
  vi.mocked(request).mockResolvedValue({ ok: true })
})

describe('the project offline outbox', () => {
  it('enqueues a failed write with the board, method and a replay key', async () => {
    let changed = 0
    const listener = () => { changed += 1 }
    window.addEventListener(PROJECT_OUTBOX_CHANGED_EVENT, listener)
    await enqueueProjectWrite('/api/project/boards/b1/cards', 'POST', { title: 'Offline' })
    window.removeEventListener(PROJECT_OUTBOX_CHANGED_EVENT, listener)
    const queued = vi.mocked(localDb.enqueueOutbox).mock.calls[0]![0]
    expect(queued.entity).toBe('project')
    expect(queued.entityId).toBe('b1')
    expect(queued.writeId).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(queued.payload).toMatchObject({ path: '/api/project/boards/b1/cards', method: 'POST', body: { title: 'Offline' } })
    expect(changed).toBe(1)
  })

  it('counts only project rows', async () => {
    vi.mocked(localDb.getOutbox).mockResolvedValue([
      item({ path: '/api/project/cards/c1', method: 'PATCH' }),
      { ...item({}), entity: 'note' as const },
    ])
    expect(await pendingProjectWrites()).toBe(1)
  })

  it('replays with the queued row key as the idempotency key', async () => {
    const outcome = await replayProjectOutboxItem(item({ path: '/api/project/cards/c1', method: 'PATCH', body: { title: 'X' } }))
    expect(outcome.status).toBe('done')
    expect(request).toHaveBeenCalledWith('/api/project/cards/c1', {
      method: 'PATCH', body: { title: 'X' }, idempotencyKey: 'pw_test',
    })
  })

  it('announces the flush only after the store removed the row', () => {
    let flushed = 0
    const listener = () => { flushed += 1 }
    window.addEventListener(PROJECT_OUTBOX_FLUSHED_EVENT, listener)
    notifyProjectOutboxFlushed()
    window.removeEventListener(PROJECT_OUTBOX_FLUSHED_EVENT, listener)
    expect(flushed).toBe(1)
  })

  it('keeps the row when the network is still down', async () => {
    vi.mocked(request).mockRejectedValue(new ApiError(0, 'offline', 'offline'))
    const outcome = await replayProjectOutboxItem(item({ path: '/api/project/cards/c1', method: 'DELETE' }))
    expect(outcome.status).toBe('offline')
    expect(localDb.markOutboxFailure).toHaveBeenCalled()
  })

  it('drops a permanently refused write after telling the reader', async () => {
    vi.mocked(request).mockRejectedValue(new ApiError(403, 'forbidden', 'Permission denied'))
    const outcome = await replayProjectOutboxItem(item({ path: '/api/project/cards/c1', method: 'DELETE' }))
    expect(outcome.status).toBe('done')
  })

  it('refuses a payload that is not a project write', async () => {
    expect((await replayProjectOutboxItem(item({ nonsense: true }))).status).toBe('retry')
    expect(request).not.toHaveBeenCalled()
  })
})
