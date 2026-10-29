export interface NavAssistantContext {
  categoryId: string | null
  categoryName: string | null
  subcategoryId: string | null
  subcategoryName: string | null
  query: string | null
  totalLinks: number | null
  visibleLinks: number | null
  pinnedCount: number | null
  lockedCategories: number | null
  unlockTokens: string[]
}

export const MAX_NAV_CONTEXT_QUERY = 200
export const MAX_NAV_CONTEXT_NAME = 120
export const MAX_NAV_CONTEXT_TOKENS = 20
