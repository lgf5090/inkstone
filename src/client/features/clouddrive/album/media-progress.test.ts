import { beforeEach, describe, expect, it } from 'vitest'
import { readMediaProgress, saveMediaProgress } from './media-progress'

beforeEach(() => localStorage.clear())

describe('CloudDrive media progress', () => {
  it('restores a mid-file position for the same account and duration', () => {
    saveMediaProgress('owner', 'video-1', 42, 100)
    expect(readMediaProgress('owner', 'video-1', 100)).toBe(42)
  })

  it('does not expose progress to another account', () => {
    saveMediaProgress('owner', 'video-1', 42, 100)
    expect(readMediaProgress('member', 'video-1', 100)).toBeNull()
  })

  it('refuses a different rendition and positions at either edge', () => {
    saveMediaProgress('owner', 'video-1', 42, 100)
    expect(readMediaProgress('owner', 'video-1', 101)).toBeNull()
    saveMediaProgress('owner', 'video-1', 2, 100)
    expect(readMediaProgress('owner', 'video-1', 100)).toBeNull()
    saveMediaProgress('owner', 'video-1', 98, 100)
    expect(readMediaProgress('owner', 'video-1', 100)).toBeNull()
  })
})
