/** The JSON shapes crossing /api/inknote; DTOs stay free of worker and DOM types. */
import type {
  InknoteAsset,
  InknoteLibrary,
  InknoteNoteMeta,
  InknotePage,
  InknoteRecording,
  InknoteRecordingEvent,
  InknoteSearchResult,
  InknoteSnapshotMeta,
  InknoteTemplate,
  InknoteUsage,
} from './types'

export interface InknoteLibraryResponse extends InknoteLibrary {
  counts: { subjects: number; notebooks: number; notes: number }
}

export interface InknoteNoteResponse {
  note: InknoteNoteMeta
  pages: InknotePage[]
}

export interface InknoteNoteCreateBody {
  id?: string
  notebookId: string
  title?: string
  paper?: unknown
  pages?: unknown
}

export interface InknotePageSaveBody {
  content: string
  baseRev: number
}

export interface InknotePageSaveResponse {
  rev: number
  updatedAt: number
}

export interface InknotePageConflict {
  current: { content: string; rev: number; updatedAt: number }
}

export interface InknoteSearchResponse {
  results: InknoteSearchResult[]
  total: number
}

export interface InknoteSettingsResponse {
  config: unknown
  updatedAt: number
}

export interface InknoteTemplatesResponse {
  templates: InknoteTemplate[]
}

export interface InknoteAssetsResponse {
  assets: InknoteAsset[]
}

export interface InknoteRecordingsResponse {
  recordings: InknoteRecording[]
}

export interface InknoteTimelineResponse {
  events: InknoteRecordingEvent[]
}

export interface InknoteSnapshotsResponse {
  snapshots: InknoteSnapshotMeta[]
}

export interface InknoteUsageResponse extends InknoteUsage {}

export interface InknoteRestoreResponse {
  restored: boolean
  missingAssets: string[]
}
