import type { OfficeFileType } from './constants'

export type OfficeSnapshot = Record<string, unknown>

export interface OfficeFileSummary {
  id: string
  type: OfficeFileType
  title: string
  folderId: string | null
  rev: number
  size: number
  isPinned: boolean
  isStarred: boolean
  position: number
  lastOpenedAt: number | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface OfficeFolder {
  id: string
  parentId: string | null
  name: string
  icon: string | null
  color: string | null
  position: number
  createdAt: number
  updatedAt: number
}

export interface OfficeTag {
  id: string
  name: string
  color: string | null
  isPinned: boolean
  createdAt: number
  count: number
}

export interface OfficeVersionSummary {
  rev: number
  size: number
  createdAt: number
}

export interface OfficeSnapshotResponse {
  rev: number
  snapshot: OfficeSnapshot | null
  updatedAt: number
}

export interface OfficeListFilters {
  type?: OfficeFileType
  query?: string
  folderId?: string | null
  tagId?: string
  trash?: boolean
  starred?: boolean
  recent?: boolean
  limit?: number
}

export const OFFICE_BATCH_ACTIONS = ['move', 'copy', 'tag', 'star', 'pin', 'delete'] as const
export type OfficeBatchActionKind = (typeof OFFICE_BATCH_ACTIONS)[number]

export interface OfficeBatchAction {
  ids: string[]
  action: OfficeBatchActionKind
  folderId?: string | null
  tagIds?: string[]
}

/** The request body the batch endpoint accepts; the name keeps route code readable. */
export type OfficeBatchRequest = OfficeBatchAction

export interface OfficeSaveResult {
  rev: number
  size: number
  updatedAt: number
}

export interface OfficeAsset {
  id: string
  url: string
  mime: string
  size: number
  name: string
}

export interface OfficeFolderInput {
  name: string
  parentId?: string | null
  icon?: string | null
  color?: string | null
}

export interface OfficeTagInput {
  name: string
  color?: string | null
}