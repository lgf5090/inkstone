export interface ConnectionGuard {
  readOnly: boolean
  production: boolean
}

export const DEFAULT_GUARD: ConnectionGuard = { readOnly: false, production: false }

const STORAGE_KEY = 'inkstone.development.database.guards'

export function loadGuards(): Record<string, ConnectionGuard> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, Partial<ConnectionGuard>>
    const out: Record<string, ConnectionGuard> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue
      if (typeof value.readOnly !== 'boolean' && typeof value.production !== 'boolean') continue
      out[key] = {
        readOnly: value.readOnly === true,
        production: value.production === true,
      }
    }
    return out
  } catch (error) {
    console.warn('[inkstone] Development database guards could not be read:', error)
    return {}
  }
}

export function saveGuards(guards: Record<string, ConnectionGuard>): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(guards))
  } catch (error) {
    console.warn('[inkstone] Development database guards could not be saved:', error)
  }
}
