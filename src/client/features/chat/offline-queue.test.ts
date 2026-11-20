// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  OFFLINE_QUEUE_LIMIT,
  clearOfflineQueue,
  enqueueOfflineText,
  offlineQueueSize,
  readOfflineQueue,
} from './offline-queue'

describe('the offline draft shelf', () => {
  beforeEach(() => {
    localStorage.clear()
    clearOfflineQueue()
  })

  it('keeps one entry per draft even when several events capture the same text', () => {
    expect(enqueueOfflineText('half-written question')).toBe(1)
    expect(enqueueOfflineText('half-written question')).toBe(1)
    expect(readOfflineQueue()).toEqual(['half-written question'])
  })

  it('keeps distinct drafts apart and bounds the shelf', () => {
    enqueueOfflineText('first')
    enqueueOfflineText('second')
    expect(readOfflineQueue()).toEqual(['first', 'second'])
    for (let index = 0; index < OFFLINE_QUEUE_LIMIT + 5; index++) enqueueOfflineText(`draft ${index}`)
    expect(offlineQueueSize()).toBe(OFFLINE_QUEUE_LIMIT)
  })

  it('ignores blank text and clears back to empty', () => {
    expect(enqueueOfflineText('   ')).toBe(0)
    enqueueOfflineText('kept')
    clearOfflineQueue()
    expect(readOfflineQueue()).toEqual([])
  })
})
