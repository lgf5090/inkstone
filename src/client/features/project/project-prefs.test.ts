import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROJECT_SIDEBAR_DEFAULT_WIDTH,
  PROJECT_SIDEBAR_MAX_WIDTH,
  PROJECT_SIDEBAR_MIN_WIDTH,
  readSidebarOpenPref,
  readSidebarWidthPref,
  writeSidebarOpenPref,
  writeSidebarWidthPref,
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

describe('sidebar layout prefs (R3-27)', () => {
  beforeEach(() => { localStorage.clear() })

  it('defaults to open and remembers an explicit close', () => {
    expect(readSidebarOpenPref()).toBe(true)
    writeSidebarOpenPref(false)
    expect(readSidebarOpenPref()).toBe(false)
    writeSidebarOpenPref(true)
    expect(readSidebarOpenPref()).toBe(true)
  })

  it('clamps a stored width into the usable range', () => {
    expect(readSidebarWidthPref()).toBe(PROJECT_SIDEBAR_DEFAULT_WIDTH)
    writeSidebarWidthPref(10)
    expect(readSidebarWidthPref()).toBe(PROJECT_SIDEBAR_MIN_WIDTH)
    writeSidebarWidthPref(9999)
    expect(readSidebarWidthPref()).toBe(PROJECT_SIDEBAR_MAX_WIDTH)
    writeSidebarWidthPref(300)
    expect(readSidebarWidthPref()).toBe(300)
  })

  it('falls back to the default for a stored value that is not a width', () => {
    localStorage.setItem('inkstone.project.sidebarWidth', 'wide')
    expect(readSidebarWidthPref()).toBe(PROJECT_SIDEBAR_DEFAULT_WIDTH)
  })

  it('clamps a width written by something other than this writer', () => {
    localStorage.setItem('inkstone.project.sidebarWidth', '5')
    expect(readSidebarWidthPref()).toBe(PROJECT_SIDEBAR_MIN_WIDTH)
    localStorage.setItem('inkstone.project.sidebarWidth', '4000')
    expect(readSidebarWidthPref()).toBe(PROJECT_SIDEBAR_MAX_WIDTH)
  })
})
