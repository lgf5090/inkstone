import { NOTE_SAVED_SEARCH_MAX, NOTE_SAVED_SEARCH_NAME_MAX, NOTE_SAVED_SEARCH_QUERY_MAX } from '@shared/constants'
import type { SavedNoteSearch } from '@shared/types'

export function saveNoteSearch(
  current: readonly SavedNoteSearch[],
  id: string,
  rawName: string,
  rawQuery: string,
): SavedNoteSearch[] {
  const name = rawName.trim().slice(0, NOTE_SAVED_SEARCH_NAME_MAX)
  const query = rawQuery.trim().slice(0, NOTE_SAVED_SEARCH_QUERY_MAX)
  if (!name || !query) return [...current]
  const nameKey = name.toLocaleLowerCase()
  const next = current.filter((item) => item.id !== id && item.name.toLocaleLowerCase() !== nameKey)
  return [{ id, name, query }, ...next].slice(0, NOTE_SAVED_SEARCH_MAX)
}

export function removeNoteSearch(current: readonly SavedNoteSearch[], id: string): SavedNoteSearch[] {
  return current.filter((item) => item.id !== id)
}
