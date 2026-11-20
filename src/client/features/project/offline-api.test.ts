import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, request } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { fetchProjectBoardBundle, patchProjectCard } from './api'
import * as offline from './offline-outbox'

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, request: vi.fn() }
})

beforeEach(async () => {
  await initI18n()
  vi.clearAllMocks()
  vi.spyOn(offline, 'enqueueProjectWrite').mockResolvedValue(undefined)
})

describe('the project request wrapper', () => {
  it('queues a write that failed because the network is gone', async () => {
    vi.mocked(request).mockRejectedValue(new ApiError(0, 'offline', 'offline'))
    await expect(patchProjectCard('c1', { title: 'Offline' })).rejects.toThrow(t('project.offline.queued'))
    expect(offline.enqueueProjectWrite).toHaveBeenCalledWith('/api/project/cards/c1', 'PATCH', { title: 'Offline' })
  })

  it('queues a 5xx failure but not a refusal the server will repeat', async () => {
    vi.mocked(request).mockRejectedValueOnce(new ApiError(503, 'unavailable', 'Service unavailable'))
    await expect(patchProjectCard('c1', {})).rejects.toThrow(t('project.offline.queued'))
    vi.mocked(request).mockRejectedValueOnce(new ApiError(403, 'forbidden', 'Permission denied'))
    await expect(patchProjectCard('c1', {})).rejects.toThrow('Permission denied')
    expect(offline.enqueueProjectWrite).toHaveBeenCalledTimes(1)
  })

  it('leaves reads alone, including the POST-shaped anonymous share reader', async () => {
    vi.mocked(request).mockRejectedValue(new ApiError(0, 'offline', 'offline'))
    await expect(fetchProjectBoardBundle('b1')).rejects.toThrow('offline')
    expect(offline.enqueueProjectWrite).not.toHaveBeenCalled()
  })

  it('keeps reporting the original error when the queue itself refuses the write', async () => {
    vi.mocked(request).mockRejectedValue(new ApiError(0, 'offline', 'offline'))
    vi.mocked(offline.enqueueProjectWrite).mockRejectedValueOnce(new Error('IndexedDB unavailable'))
    await expect(patchProjectCard('c1', {})).rejects.toThrow('offline')
  })
})
