/**
 * The editor's own HTTP calls: read the revision it is about to edit, write it back, and upload the
 * images a snapshot carries.
 *
 * These sit here rather than in `lib/api.ts` only because that table belongs to the office file shell,
 * which lands separately. The GET/PUT shapes are exactly the ones that table will expose, so the whole
 * module can move into `api.office` without touching a caller.
 */
import { CLIENT_HEADER } from '@shared/constants'
import type { OfficeAsset, OfficeFileSummary, OfficeSaveResult, OfficeSnapshot, OfficeSnapshotResponse } from '@shared/office/model'
import { CLIENT_ID, request, routeApiError } from '../../../lib/api'
import { getLocale } from '../../../lib/i18n'

function filePath(fileId: string, suffix = ''): string {
  return `/api/office/files/${encodeURIComponent(fileId)}${suffix}`
}

/** The authoritative revision and content. A missing snapshot answers `{ rev: 0, snapshot: null }`. */
export async function fetchOfficeSnapshot(fileId: string, signal?: AbortSignal): Promise<OfficeSnapshotResponse> {
  return request<OfficeSnapshotResponse>(filePath(fileId, '/snapshot'), { signal })
}

/** The revision alone, for a caller that already holds the snapshot content. */
export async function fetchOfficeFileRev(fileId: string, signal?: AbortSignal): Promise<number> {
  const { file } = await request<{ file: OfficeFileSummary }>(filePath(fileId), { signal })
  return Number.isFinite(file?.rev) ? file.rev : 0
}

export interface SaveOfficeSnapshotInput {
  baseRev: number
  snapshot: OfficeSnapshot
}

/** `409 office_rev_conflict` when `baseRev` is no longer the file's revision; the route carries `currentRev`. */
export async function saveOfficeSnapshot(fileId: string, input: SaveOfficeSnapshotInput): Promise<OfficeSaveResult> {
  return request<OfficeSaveResult>(filePath(fileId, '/snapshot'), {
    method: 'PUT',
    body: input,
    timeoutMs: 30_000,
  })
}

/**
 * Raw bytes rather than a form: the route keys the asset by the sha256 of the body, and a multipart
 * envelope would hash differently for identical images. The shared `request()` only speaks JSON and
 * form data, so this one call carries the same headers itself and reuses `routeApiError()` for the
 * failure, keeping the localized message identical to every other office call.
 */
export async function uploadOfficeAsset(blob: Blob, options: { name?: string; signal?: AbortSignal } = {}): Promise<OfficeAsset> {
  const headers: Record<string, string> = {
    [CLIENT_HEADER]: '1',
    'X-Inkstone-Origin': CLIENT_ID,
    'Accept-Language': getLocale(),
    'Content-Type': blob.type || 'application/octet-stream',
  }
  if (options.name) headers['X-Office-Name'] = options.name

  const response = await fetch('/api/office/assets', {
    method: 'POST',
    headers,
    body: blob,
    credentials: 'same-origin',
    ...(options.signal ? { signal: options.signal } : {}),
  })

  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw routeApiError(response.status, body)
  const asset = body as OfficeAsset | null
  if (!asset || typeof asset.id !== 'string' || typeof asset.url !== 'string') {
    throw new Error('The asset upload answered without an id and url.')
  }
  return asset
}