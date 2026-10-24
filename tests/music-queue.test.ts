// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { MusicTrack } from '../src/shared/music/model'
import {
  MAX_CONSECUTIVE_FAILURES,
  addNextTrack,
  appendTrack,
  createQueue,
  currentTrack,
  emptyQueue,
  failureLimitReached,
  nextInQueue,
  previousInQueue,
  removeTrackFromQueue,
  restoreQueue,
  setQueueMode,
} from '../src/client/features/music/player/queue'

function track(id: string, overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id,
    provider: 'netease',
    providerId: id,
    kind: 'song',
    title: `Track ${id}`,
    artists: [{ id: 'artist', name: 'Artist' }],
    album: 'Album',
    albumId: 'album',
    coverUrl: '',
    coverKey: '',
    durationMs: 120_000,
    format: 'mp3',
    bitrate: 320_000,
    size: 1_000,
    sha256: '',
    r2Key: null,
    source: 'netease',
    sourceQuality: 'exhigh',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

const tracks = [track('a'), track('b'), track('c'), track('d')]

function ids(list: readonly MusicTrack[]): string[] {
  return list.map((entry) => entry.id)
}

/** A deterministic source of randomness: Fisher-Yates consumes one value per step. */
function seeded(values: number[]): () => number {
  let index = 0
  return () => {
    const value = values[index % values.length] ?? 0
    index++
    return value
  }
}

describe('music queue', () => {
  it('builds an ordered queue, keeps the chosen track and drops duplicate ids', () => {
    const queue = createQueue({ tracks: [tracks[0]!, tracks[1]!, tracks[1]!, tracks[2]!] })
    expect(ids(queue.tracks)).toEqual(['a', 'b', 'c'])
    expect(queue.index).toBe(0)
    expect(queue.original).toBeNull()

    const byId = createQueue({ tracks, trackId: 'c' })
    expect(byId.index).toBe(2)
    expect(currentTrack(byId)?.id).toBe('c')

    const clamped = createQueue({ tracks, index: 99 })
    expect(clamped.index).toBe(3)
  })

  it('shuffles without losing the original order, and restores it pointing at the same track', () => {
    const queue = createQueue({ tracks, mode: 'shuffle', index: 1, random: seeded([0, 0, 0]) })
    expect(queue.mode).toBe('shuffle')
    expect(queue.original && ids(queue.original)).toEqual(['a', 'b', 'c', 'd'])
    expect(ids(queue.tracks).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(currentTrack(queue)?.id).toBe('b')

    const restored = setQueueMode(queue, 'order')
    expect(restored.mode).toBe('order')
    expect(restored.original).toBeNull()
    expect(ids(restored.tracks)).toEqual(['a', 'b', 'c', 'd'])
    expect(currentTrack(restored)?.id).toBe('b')
  })

  it('stops at the end in order mode, wraps in repeat, and repeats one track only on a natural finish', () => {
    const ordered = createQueue({ tracks, index: 3 })
    expect(nextInQueue(ordered, 'user').at).toBe('end')
    expect(nextInQueue(ordered, 'auto').at).toBe('end')

    const repeating = { ...createQueue({ tracks, index: 3 }), mode: 'repeat' as const }
    const wrapped = nextInQueue(repeating, 'user')
    expect(wrapped.at).toBe('track')
    expect(wrapped.queue.index).toBe(0)

    const single = createQueue({ tracks, index: 1, mode: 'repeatOne' })
    const natural = nextInQueue(single, 'auto')
    expect(natural.at).toBe('restart')
    expect(natural.queue.index).toBe(1)
    const pressed = nextInQueue(single, 'user')
    expect(pressed.at).toBe('track')
    expect(pressed.queue.index).toBe(2)
  })

  it('wraps a shuffle queue and restarts a one-track queue', () => {
    const shuffled = createQueue({ tracks, index: 2, mode: 'shuffle', random: seeded([0.5, 0.5, 0.5]) })
    expect(nextInQueue(shuffled, 'auto').at).toBe('track')

    const single = createQueue({ tracks: [tracks[0]!], mode: 'repeat' })
    const step = nextInQueue(single, 'auto')
    expect(step.at).toBe('restart')
    expect(step.queue.index).toBe(0)
  })

  it('steps back to the previous track, restarts at the start of an order queue and wraps in repeat', () => {
    const ordered = createQueue({ tracks, index: 2 })
    expect(previousInQueue(ordered).queue.index).toBe(1)

    const first = createQueue({ tracks, index: 0 })
    expect(previousInQueue(first).at).toBe('restart')

    const repeating = { ...createQueue({ tracks, index: 0 }), mode: 'repeat' as const }
    expect(previousInQueue(repeating).queue.index).toBe(3)
  })

  it('inserts the next track after the current one and moves an existing copy there', () => {
    const queue = createQueue({ tracks, index: 0 })
    const inserted = addNextTrack(queue, track('x'))
    expect(ids(inserted.tracks)).toEqual(['a', 'x', 'b', 'c', 'd'])
    expect(inserted.index).toBe(0)

    const moved = addNextTrack(inserted, tracks[3]!)
    expect(ids(moved.tracks)).toEqual(['a', 'd', 'x', 'b', 'c'])
    expect(currentTrack(moved)?.id).toBe('a')

    const current = addNextTrack(moved, tracks[0]!)
    expect(current).toBe(moved)

    const empty = addNextTrack(emptyQueue(), tracks[0]!)
    expect(ids(empty.tracks)).toEqual(['a'])
    expect(empty.index).toBe(0)
  })

  it('appends a queue track without moving the current pointer or duplicating it', () => {
    const queue = createQueue({ tracks, index: 1 })
    const appended = appendTrack(queue, track('x'))
    expect(ids(appended.tracks)).toEqual(['a', 'b', 'c', 'd', 'x'])
    expect(currentTrack(appended)?.id).toBe('b')
    expect(appendTrack(appended, track('x'))).toBe(appended)

    const empty = appendTrack(emptyQueue(), tracks[0]!)
    expect(ids(empty.tracks)).toEqual(['a'])
    expect(empty.index).toBe(0)
  })

  it('keeps the pre-shuffle order in step when a track is inserted or removed', () => {
    const queue = createQueue({ tracks, mode: 'shuffle', index: 1, random: seeded([0.2, 0.7, 0.4]) })
    const withNext = addNextTrack(queue, track('x'))
    expect(withNext.original && ids(withNext.original).sort()).toEqual(['a', 'b', 'c', 'd', 'x'])

    const removed = removeTrackFromQueue(withNext, 'x')
    expect(removed.queue.original?.some((entry) => entry.id === 'x')).toBe(false)
    expect(ids(removed.queue.tracks).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('removes the current track and leaves the queue pointing at what slid into place', () => {
    const queue = createQueue({ tracks, index: 1 })
    const removed = removeTrackFromQueue(queue, 'b')
    expect(removed.found).toBe(true)
    expect(removed.removedCurrent).toBe(true)
    expect(ids(removed.queue.tracks)).toEqual(['a', 'c', 'd'])
    expect(currentTrack(removed.queue)?.id).toBe('c')

    const last = removeTrackFromQueue(queue, 'd')
    expect(last.removedCurrent).toBe(false)
    expect(last.queue.index).toBe(1)

    const before = removeTrackFromQueue(queue, 'a')
    expect(before.queue.index).toBe(0)
    expect(currentTrack(before.queue)?.id).toBe('b')

    const missing = removeTrackFromQueue(queue, 'missing')
    expect(missing.found).toBe(false)
    expect(missing.queue).toBe(queue)

    const emptied = removeTrackFromQueue(createQueue({ tracks: [tracks[0]!] }), 'a')
    expect(emptied.queue.tracks).toEqual([])
    expect(emptied.queue.index).toBe(0)
  })

  it('counts consecutive failures against one named ceiling', () => {
    expect(failureLimitReached(MAX_CONSECUTIVE_FAILURES - 1)).toBe(false)
    expect(failureLimitReached(MAX_CONSECUTIVE_FAILURES)).toBe(true)
  })

  it('restores a persisted queue and rejects a broken record without throwing', () => {
    const restored = restoreQueue({
      tracks: [tracks[0], { nonsense: true }, tracks[1]],
      index: 9,
      mode: 'shuffle',
      original: [tracks[0], tracks[1]],
    })
    expect(ids(restored.tracks)).toEqual(['a', 'b'])
    expect(restored.index).toBe(1)
    expect(restored.mode).toBe('shuffle')
    expect(ids(restored.original ?? [])).toEqual(['a', 'b'])

    expect(restoreQueue(null, 'repeat').mode).toBe('repeat')
    expect(restoreQueue({ tracks: 'nope' }, 'repeat').tracks).toEqual([])
    const badMode = restoreQueue({ tracks: [tracks[0]], index: 0, mode: 'sideways' }, 'repeat')
    expect(badMode.mode).toBe('repeat')
  })
})
