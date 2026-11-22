import { isOfficeFileType, type OfficeFileType } from '@shared/office/constants'

export const OFFICE_LIST_PATH = '/office'

export const OFFICE_SMART_VIEWS = ['all', 'recent', 'starred', 'pinned', 'trash'] as const
export type OfficeSmartView = (typeof OFFICE_SMART_VIEWS)[number]

/** What the file list is showing: a smart view, a folder, or a tag. */
export interface OfficeListState {
  view: OfficeSmartView
  folderId: string | null
  tagId: string | null
  query: string
}

export function emptyOfficeListState(): OfficeListState {
  return { view: 'all', folderId: null, tagId: null, query: '' }
}

export type OfficeAddress =
  | ({ kind: 'list' } & OfficeListState)
  | { kind: 'editor'; fileType: OfficeFileType; fileId: string }

const EDITOR_PATH = /^\/office\/([^/]+)\/([^/]+)$/

function decodeSegment(value: string | undefined): string | null {
  if (!value) return null
  try {
    const decoded = decodeURIComponent(value)
    return decoded || null
  } catch {
    return null
  }
}

function parseListState(params: URLSearchParams): OfficeListState {
  const view = params.get('view')
  const folderId = params.get('folder') || null
  const tagId = params.get('tag') || null
  const query = (params.get('q') ?? '').slice(0, 200)
  const smartView = OFFICE_SMART_VIEWS.includes(view as OfficeSmartView) ? view as OfficeSmartView : 'all'
  // A folder or tag browse is the "all" view by construction; a deleted-files view owns no folder.
  const resolvedView = smartView === 'trash' ? 'trash' : folderId || tagId ? 'all' : smartView
  return {
    view: resolvedView,
    folderId: resolvedView === 'all' ? folderId : null,
    tagId: resolvedView === 'all' ? tagId : null,
    query,
  }
}

/**
 * The address as the office shell reads it. Anything that is not a known product under `/office`
 * falls back to the file list, so a stale deep link lands somewhere usable instead of nowhere.
 */
export function parseOfficeAddress(pathname: string, search = ''): OfficeAddress {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  const params = new URLSearchParams(search)
  if (path !== OFFICE_LIST_PATH) {
    const match = EDITOR_PATH.exec(path)
    if (match && isOfficeFileType(match[1])) {
      const fileId = decodeSegment(match[2])
      if (fileId) return { kind: 'editor', fileType: match[1], fileId }
    }
    return { kind: 'list', ...parseListState(params) }
  }
  return { kind: 'list', ...parseListState(params) }
}

/** The address a list state occupies. The query keeps only the parameters that carry meaning. */
export function officeListAddress(state: OfficeListState): string {
  const params = new URLSearchParams()
  if (state.view !== 'all') params.set('view', state.view)
  if (state.view === 'all' && state.folderId) params.set('folder', state.folderId)
  if (state.view === 'all' && state.tagId) params.set('tag', state.tagId)
  const query = state.query.trim()
  if (query) params.set('q', query)
  const search = params.toString()
  return search ? `${OFFICE_LIST_PATH}?${search}` : OFFICE_LIST_PATH
}

export function officeFileAddress(type: OfficeFileType, fileId: string): string {
  return `${OFFICE_LIST_PATH}/${type}/${encodeURIComponent(fileId)}`
}

export function isOfficeSmartView(value: unknown): value is OfficeSmartView {
  return typeof value === 'string' && (OFFICE_SMART_VIEWS as readonly string[]).includes(value)
}