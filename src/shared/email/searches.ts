export const EMAIL_SAVED_SEARCH_MAX = 30
export const EMAIL_SAVED_SEARCH_NAME_MAX_CHARS = 80
export const EMAIL_SAVED_SEARCH_QUERY_MAX_CHARS = 500

export interface EmailSavedSearch {
  id: string
  name: string
  query: string
  createdAt: string
}

export interface EmailSavedSearchInput {
  name: string
  query: string
}

export interface EmailSavedSearchPatch {
  name?: string
  query?: string
}

export function normalizeEmailSavedSearchName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || name.length > EMAIL_SAVED_SEARCH_NAME_MAX_CHARS) return null
  return name
}

export function normalizeEmailSavedSearchQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const query = value.trim()
  if (!query || query.length > EMAIL_SAVED_SEARCH_QUERY_MAX_CHARS) return null
  return query
}

export function parseEmailSavedSearchInput(value: unknown): EmailSavedSearchInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const name = normalizeEmailSavedSearchName(raw.name)
  const query = normalizeEmailSavedSearchQuery(raw.query)
  if (!name || !query) return null
  return { name, query }
}

export function parseEmailSavedSearchPatch(value: unknown): EmailSavedSearchPatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const patch: EmailSavedSearchPatch = {}
  if (raw.name !== undefined) {
    const name = normalizeEmailSavedSearchName(raw.name)
    if (!name) return null
    patch.name = name
  }
  if (raw.query !== undefined) {
    const query = normalizeEmailSavedSearchQuery(raw.query)
    if (!query) return null
    patch.query = query
  }
  return Object.keys(patch).length > 0 ? patch : null
}

export function emailSearchQueriesEqual(saved: string, current: string | null): boolean {
  return current !== null && saved.trim() === current.trim()
}
