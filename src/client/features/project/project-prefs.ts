const PINNED_BOARDS_KEY = 'inkstone.project.pinnedBoards'
const STARRED_BOARDS_KEY = 'inkstone.project.starredBoards'

function readArrayPref(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeArrayPref(key: string, items: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(items))
  } catch {}
}

export function readPinnedBoardsPref(): string[] {
  return readArrayPref(PINNED_BOARDS_KEY)
}

export function writePinnedBoardsPref(boardIds: string[]): void {
  writeArrayPref(PINNED_BOARDS_KEY, boardIds)
}

export function readStarredBoardsPref(): string[] {
  return readArrayPref(STARRED_BOARDS_KEY)
}

export function writeStarredBoardsPref(boardIds: string[]): void {
  writeArrayPref(STARRED_BOARDS_KEY, boardIds)
}
