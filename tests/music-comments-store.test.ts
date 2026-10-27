// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MusicCommentPage } from '../src/shared/music/comments'
import { musicApi } from '../src/client/features/music/api'
import { useCommentsStore } from '../src/client/features/music/comments/store'

function comment(id: string, content = `comment ${id}`, liked = false): MusicCommentPage['latest'][number] {
  return {
    id,
    userId: `u-${id}`,
    nickname: `User ${id}`,
    avatarUrl: '',
    content,
    createdAt: 1_700_000_000_000,
    likedCount: liked ? 1 : 0,
    liked,
    ipLocation: '',
  }
}

function page(overrides: Partial<MusicCommentPage> = {}): MusicCommentPage {
  return { hot: [comment('h')], latest: [comment('1'), comment('2')], total: 3, hasMore: true, ...overrides }
}

beforeEach(() => {
  useCommentsStore.setState({ activeTrackId: null, buckets: {} })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the comments store', () => {
  it('loads one page, keeps the hot page separate and dedupes the latest stream', async () => {
    vi.spyOn(musicApi, 'comments').mockResolvedValueOnce(page())
    vi.spyOn(musicApi, 'comments').mockResolvedValueOnce(page({ hot: [], latest: [comment('2'), comment('3')], total: 4, hasMore: false }))
    await useCommentsStore.getState().load('track-1')
    let bucket = useCommentsStore.getState().buckets['track-1']!
    expect(bucket.status).toBe('ready')
    expect(bucket.hot.map((entry) => entry.id)).toEqual(['h'])
    expect(bucket.latest.map((entry) => entry.id)).toEqual(['1', '2'])

    await useCommentsStore.getState().loadMore('track-1')
    bucket = useCommentsStore.getState().buckets['track-1']!
    expect(bucket.latest.map((entry) => entry.id)).toEqual(['1', '2', '3'])
    expect(bucket.hot.map((entry) => entry.id)).toEqual(['h'])
    expect(bucket.hasMore).toBe(false)
  })

  it('rolls back a like the provider refuses', async () => {
    vi.spyOn(musicApi, 'comments').mockResolvedValueOnce(page({ hasMore: false }))
    vi.spyOn(musicApi, 'likeComment').mockRejectedValueOnce(new Error('refused'))
    await useCommentsStore.getState().load('track-2')
    const outcome = await useCommentsStore.getState().like('track-2', '1', true)
    expect(outcome.ok).toBe(false)
    const bucket = useCommentsStore.getState().buckets['track-2']!
    expect(bucket.latest.find((entry) => entry.id === '1')).toMatchObject({ liked: false, likedCount: 0 })
    expect(bucket.likeBusy['1']).toBeUndefined()
  })

  it('keeps the liked state the provider accepted', async () => {
    vi.spyOn(musicApi, 'comments').mockResolvedValueOnce(page({ hasMore: false }))
    vi.spyOn(musicApi, 'likeComment').mockResolvedValueOnce({ ok: true })
    await useCommentsStore.getState().load('track-3')
    expect((await useCommentsStore.getState().like('track-3', '1', true)).ok).toBe(true)
    const bucket = useCommentsStore.getState().buckets['track-3']!
    expect(bucket.latest.find((entry) => entry.id === '1')).toMatchObject({ liked: true, likedCount: 1 })
  })

  it('drops an answer for a track the reader already left', async () => {
    const deferred: { resolve: ((value: MusicCommentPage) => void) | null } = { resolve: null }
    vi.spyOn(musicApi, 'comments')
      .mockImplementationOnce(() => new Promise((resolve) => { deferred.resolve = resolve }))
      .mockResolvedValueOnce(page({ latest: [comment('other')], total: 1, hasMore: false }))
    const first = useCommentsStore.getState().load('track-a')
    await useCommentsStore.getState().load('track-b')
    deferred.resolve?.(page({ latest: [comment('late')], total: 1, hasMore: false }))
    await first
    const bucket = useCommentsStore.getState().buckets['track-a']!
    expect(bucket.status).toBe('idle')
    expect(bucket.latest).toEqual([])
  })
})
