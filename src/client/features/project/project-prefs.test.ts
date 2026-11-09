import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readPinnedBoardsPref,
  readStarredBoardsPref,
  writePinnedBoardsPref,
  writeStarredBoardsPref,
} from './project-prefs'

describe('project-prefs', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('reads empty arrays when nothing stored', () => {
    expect(readPinnedBoardsPref()).toEqual([])
    expect(readStarredBoardsPref()).toEqual([])
  })

  it('writes and reads pinned boards', () => {
    writePinnedBoardsPref(['b1', 'b2'])
    expect(readPinnedBoardsPref()).toEqual(['b1', 'b2'])
  })

  it('writes and reads starred boards', () => {
    writeStarredBoardsPref(['b3'])
    expect(readStarredBoardsPref()).toEqual(['b3'])
  })

  it('handles invalid JSON gracefully', () => {
    localStorage.setItem('inkstone.project.pinnedBoards', 'not json')
    expect(readPinnedBoardsPref()).toEqual([])
  })
})
