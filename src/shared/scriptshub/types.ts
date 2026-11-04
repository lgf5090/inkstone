/**
 * What the ScriptsHub screens and routes exchange.
 *
 * Timestamps are milliseconds, the same unit every other D1-backed store in this app writes, so a
 * client never has to guess whether a number is seconds. A publication's token never appears here:
 * the plaintext is returned once by the rotation route and only its hash stays in the database.
 */

import type { ScriptLanguageId } from './languages'

export type ScriptTagColor = string | null

export interface ScriptFolder {
  id: string
  parentId: string | null
  name: string
  icon: string | null
  color: string | null
  position: number
  createdAt: number
  updatedAt: number
  snippetCount: number
}

export interface ScriptTag {
  id: string
  name: string
  parentId: string | null
  color: ScriptTagColor
  createdAt: number
  updatedAt: number
  snippetCount: number
}

export interface ScriptFile {
  id: string
  name: string
  language: ScriptLanguageId
  content: string
  position: number
  updatedAt: number
}

export interface ScriptSnippetSummary {
  id: string
  title: string
  description: string
  folderId: string | null
  language: ScriptLanguageId
  isFavorite: boolean
  isPinned: boolean
  isDeprecated: boolean
  copyCount: number
  downloadCount: number
  fileCount: number
  /** The first file's opening text, already flattened to one line, for the list row. */
  preview: string
  /** Total characters across every file, so a row can say how much code it holds. */
  charCount: number
  tags: ScriptTag[]
  publication: ScriptPublicationSummary | null
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

export interface ScriptSnippetDetail extends ScriptSnippetSummary {
  sourceUrl: string
  notes: string
  files: ScriptFile[]
  revisionCount: number
}

export interface ScriptPublicationSummary {
  id: string
  path: string
  isEnabled: boolean
  visibility: ScriptPublicationVisibility
  hasToken: boolean
  expiresAt: number | null
  shortSlug: string | null
  fileId: string
  createdAt: number
  updatedAt: number
  lastServedAt: number | null
}

export interface ScriptPublication extends ScriptPublicationSummary {
  snippetId: string
  snippetTitle: string
  fileCount: number
  downloadCount: number
  uniqueVisitors: number
}

export type ScriptPublicationVisibility = 'public' | 'token'

/** A published path as the distribution route sees it, split from the `@version` suffix. */
export interface ParsedPublicationPath {
  path: string
  version: number | null
}

export interface ScriptRevisionMeta {
  version: number
  title: string
  description: string
  source: ScriptRevisionSource
  fileCount: number
  charCount: number
  /** Lines this version added and removed against the version before it. */
  added: number
  removed: number
  createdAt: number
}

export type ScriptRevisionSource = 'create' | 'save' | 'restore' | 'import' | 'overwrite'

export interface ScriptRevisionSnapshot extends ScriptRevisionMeta {
  files: ScriptFile[]
}

export interface ScriptAsset {
  id: string
  snippetId: string
  fileName: string
  contentType: string
  byteSize: number
  createdAt: number
}

export interface ScriptListQuery {
  search?: string
  folderId?: string | null
  tagId?: string | null
  quick?: 'all' | 'favorites' | 'pinned' | 'deprecated' | 'published'
  sort?: 'updated' | 'created' | 'title' | 'uses'
  limit?: number
  offset?: number
}

export interface ScriptListResponse {
  items: ScriptSnippetSummary[]
  total: number
  limit: number
  offset: number
}

export interface ScriptFolderInput {
  id?: string
  name: string
  parentId?: string | null
  icon?: string | null
  color?: string | null
}

export interface ScriptTagInput {
  id?: string
  name: string
  parentId?: string | null
  color?: string | null
}

export interface ScriptSnippetInput {
  title: string
  description?: string
  folderId?: string | null
  language?: ScriptLanguageId
  sourceUrl?: string
  notes?: string
  tags?: string[]
}

export interface ScriptFileInput {
  id?: string
  name: string
  language: ScriptLanguageId
  content: string
}

export interface ScriptSnippetSaveInput {
  title: string
  description: string
  folderId: string | null
  language: ScriptLanguageId
  sourceUrl: string
  notes: string
  tags: string[]
  files: ScriptFileInput[]
}

export type ScriptBatchAction = 'tag' | 'move' | 'delete'

export interface ScriptBatchInput {
  action: ScriptBatchAction
  ids: string[]
  tagIds?: string[]
  folderId?: string | null
}

export interface ScriptBatchResult {
  affected: number
  skipped: number
}

export type ScriptImportSource = 'masscode' | 'vscode' | 'generic'
export type ScriptImportConflict = 'skip' | 'rename' | 'overwrite'

export interface ScriptImportFile {
  name: string
  language: ScriptLanguageId
  content: string
}

export interface ScriptImportEntry {
  title: string
  description: string
  tags: string[]
  files: ScriptImportFile[]
}

export interface ScriptImportInput {
  source: ScriptImportSource
  conflict: ScriptImportConflict
  folderId?: string | null
  entries: ScriptImportEntry[]
}

export interface ScriptImportResult {
  created: number
  overwritten: number
  skipped: number
  renamed: number
  tags: number
}

export interface ScriptPublicationInput {
  fileId: string
  path: string
  visibility: ScriptPublicationVisibility
  expiresAt?: number | null
  createShortlink?: boolean
}

export interface ScriptPublicationPatch {
  path?: string
  visibility?: ScriptPublicationVisibility
  expiresAt?: number | null
  isEnabled?: boolean
}

export interface ScriptPublicationCreated extends ScriptPublication {
  /** The plaintext gate token, present only on the response that minted it. */
  token?: string
  shortUrl?: string
}

export type ScriptStatsRange = '7d' | '30d' | '365d'

export interface ScriptStatsCount {
  label: string
  value: number
  color?: string | null
}

export interface ScriptStatsDailyPoint {
  day: string
  downloads: number
  visitors: number
  failures: number
}

export interface ScriptStatsTopScript {
  id: string
  title: string
  path: string | null
  downloads: number
  uniqueVisitors: number
}

export interface ScriptStatsRecentEdit {
  id: string
  title: string
  updatedAt: number
  revisionCount: number
}

export interface ScriptStatsHotCopy {
  id: string
  title: string
  copies: number
}

export interface ScriptStatsOverview {
  snippets: number
  files: number
  languages: ScriptStatsCount[]
  folders: ScriptStatsCount[]
  tags: ScriptStatsCount[]
  published: number
  publishedShare: number
  added: Record<'7d' | '30d' | '365d', number>
}

export interface ScriptStatsDistribution {
  downloads: number
  uniqueVisitors: number
  daily: ScriptStatsDailyPoint[]
  topScripts: ScriptStatsTopScript[]
  referrers: ScriptStatsCount[]
  browsers: ScriptStatsCount[]
  devices: ScriptStatsCount[]
  failures: ScriptStatsCount[]
}

export interface ScriptStatsSnippets {
  hotCopies: ScriptStatsHotCopy[]
  recentEdits: ScriptStatsRecentEdit[]
  revisions: number
}

export interface ScriptStatsResponse {
  range: ScriptStatsRange
  since: number
  generatedAt: number
  overview: ScriptStatsOverview
  distribution: ScriptStatsDistribution
  snippets: ScriptStatsSnippets
}

export interface ScriptsHubOverview {
  folders: ScriptFolder[]
  tags: ScriptTag[]
  counts: {
    snippets: number
    favorites: number
    pinned: number
    deprecated: number
    published: number
  }
}
