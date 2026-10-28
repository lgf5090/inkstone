const STORAGE_KEY = 'inkstone.development.database.layout'

export interface StudioLayout {
  sidebarWidth: number
  sidebarCollapsed: boolean
  activeConnectionId: string
  draft: string
}

export const DRAFT_MAX_CHARS = 20_000

export const STUDIO_SIDEBAR_WIDTH = {
  min: 170,
  max: 420,
  default: 240,
  collapsed: 48,
} as const

export function loadStudioLayout(): Partial<StudioLayout> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<StudioLayout>
    return {
      ...(typeof parsed.sidebarWidth === 'number' ? { sidebarWidth: parsed.sidebarWidth } : {}),
      ...(typeof parsed.sidebarCollapsed === 'boolean' ? { sidebarCollapsed: parsed.sidebarCollapsed } : {}),
      ...(typeof parsed.activeConnectionId === 'string' ? { activeConnectionId: parsed.activeConnectionId } : {}),
      ...(typeof parsed.draft === 'string' ? { draft: parsed.draft.slice(0, DRAFT_MAX_CHARS) } : {}),
    }
  } catch (error) {
    console.warn('[inkstone] Development database layout could not be read:', error)
    return {}
  }
}

export function saveStudioLayout(layout: Partial<StudioLayout>): void {
  try {
    if (typeof localStorage === 'undefined') return
    const previous = loadStudioLayout()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...previous, ...layout }))
  } catch (error) {
    console.warn('[inkstone] Development database layout could not be saved:', error)
  }
}
