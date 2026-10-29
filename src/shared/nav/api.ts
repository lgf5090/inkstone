import type {
  NavBootstrap,
  NavCategory,
  NavCheckResult,
  NavLink,
  NavSettings,
  NavWebdavSettings,
} from './model'

export interface NavApiErrorBody {
  error: { code: string; message: string }
}

export interface NavCategoryResponse {
  category: NavCategory
}

export interface NavLinkResponse {
  link: NavLink
}

export interface NavIconsResponse {
  icon: { id: string; url: string; width: number | null; height: number | null }
}

export interface NavFaviconResponse {
  icon: string | null
}

export interface NavCheckResponse {
  results: NavCheckResult[]
}

export interface NavAiModel {
  id: string
  label: string
  providerLabel: string
  available: boolean
}

export interface NavAiModelsResponse {
  models: NavAiModel[]
  selected: string
  available: boolean
  reason: string | null
}

export interface NavAiSuggestResponse {
  description: string
  categoryId: string | null
}

export interface NavImportResponse {
  imported: number
  skipped: number
}

export interface NavRestoreResponse {
  restoredLinks: number
  restoredCategories: number
  restoredVisits: number
  unlockedCategoryNames: string[]
}

export interface NavSettingsResponse {
  display: NavSettings['display']
  search: NavSettings['search']
  ai: NavSettings['ai']
  webdav: NavWebdavSettings
}

export interface NavWebdavTestResponse {
  ok: boolean
  status?: number
  error?: string
}

export interface NavWebdavBackupResponse {
  ok: boolean
  filename: string
  verified: boolean
}

export type NavBootstrapResponse = NavBootstrap
