/**
 * Owner-only CloudDrive endpoints.
 *
 * Kept apart from `../api` so the file browser never pulls the admin surface into its chunk. The
 * request wrapper repeats the few lines of the shared one because `../api` does not export its
 * transport; the error type is the shared class, so callers can translate failures the same way.
 */
import { CLIENT_HEADER } from '@shared/constants'
import { CloudDriveApiError } from '../api'

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set(CLIENT_HEADER, '1')
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  const type = response.headers.get('content-type') ?? ''
  const body = type.includes('application/json') ? await response.json().catch(() => null) : null
  if (!response.ok) {
    const error = body as { error?: { code?: string; message?: string } } | null
    throw new CloudDriveApiError(error?.error?.code ?? 'internal', error?.error?.message ?? response.statusText, response.status)
  }
  return body as T
}

function json(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) }
}

function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export interface CloudDriveAdminCounts {
  files: number
  shares: number
  keys: number
  storages: number
}

export interface CloudDriveAdminStorageUsage {
  id: string
  name: string
  type: string
  usedBytes: number
  quotaBytes: number | null
  trashBytes?: number | null
}

export interface CloudDriveAdminTypeUsage {
  type: string
  bytes: number
  count: number
}

export interface CloudDriveAdminCapacity {
  usedBytes: number
  quotaBytes: number | null
  trashBytes: number
  storages: CloudDriveAdminStorageUsage[]
  types: CloudDriveAdminTypeUsage[]
}

export interface CloudDriveAdminCacheStats {
  entries: number
  hits: number
  misses: number
  bytes: number
  snapshotAt: number
  scope: 'isolate'
}

export interface CloudDriveAdminOverview {
  counts: CloudDriveAdminCounts
  capacity: CloudDriveAdminCapacity
  cache?: CloudDriveAdminCacheStats
  version: string
  environment: string
  database: string
  updatedAt: number
  admin: { ownerCanViewMemberFiles: boolean }
}

export interface CloudDriveAdminActivityDay {
  date: string
  uploads: number
  shares: number
}

export interface CloudDriveAdminActivity {
  days: CloudDriveAdminActivityDay[]
}

export interface CloudDriveAdminFileShare {
  slug: string
  remainingViews: number | null
}

export interface CloudDriveAdminFile {
  id: string
  name: string
  path: string
  mime: string
  size: number
  remainingViews: number | null
  storage: string
  creator: { id: string; name: string }
  createdAt: number
  shares?: CloudDriveAdminFileShare[]
}

export interface CloudDriveAdminFiles {
  files: CloudDriveAdminFile[]
  cursor: string | null
  total: number | null
  ownerCanViewMemberFiles: boolean
}

export interface CloudDriveAdminFilesQuery {
  q?: string
  type?: string
  storage?: string
  creator?: string
  cursor?: string | null
  limit?: number
}

export interface CloudDriveAdminDeleteResult {
  deleted: number
  failed: number
  taskId?: string
}

export type CloudDriveIndexHealth = 'idle' | 'running' | 'error'

export interface CloudDriveAdminIndexMount {
  mountId: string
  mountName: string
  mountPath: string
  external: boolean
  status: CloudDriveIndexHealth
  pending: number
  lastIndexedAt: number | null
  lastError: string | null
}

export interface CloudDriveAdminIndex {
  mounts: CloudDriveAdminIndexMount[]
  pending: number
  lastIndexedAt: number | null
}

export interface CloudDriveAdminIndexJob {
  queued?: number
  taskId?: string
}

export interface CloudDriveTaskProgress {
  total?: number
  done?: number
  failed?: number
  bytes?: number
  doneBytes?: number
  current?: string
}

export interface CloudDriveTask {
  id: string
  type: string
  status: string
  progress: CloudDriveTaskProgress
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface CloudDriveTasks {
  tasks: CloudDriveTask[]
  cursor: string | null
}

export const CLOUDDRIVE_JOB_HANDLERS = [
  'cleanup_upload_sessions',
  'purge_share_sessions',
  'purge_trash',
  'refresh_storage_usage',
  'reindex_initials',
] as const

export type CloudDriveJobHandler = (typeof CLOUDDRIVE_JOB_HANDLERS)[number]

export type CloudDriveJobSchedule = 'interval' | 'cron'
export type CloudDriveJobRunStatus = 'success' | 'failure' | 'skipped'
export type CloudDriveJobTrigger = 'auto' | 'manual'

export interface CloudDriveJob {
  id: string
  handler: CloudDriveJobHandler | string
  name: string
  scheduleType: CloudDriveJobSchedule
  intervalSec: number | null
  cron: string | null
  enabled: boolean
  isBuiltIn: boolean
  config: Record<string, unknown>
  runCount: number
  failureCount: number
  lastRunStatus: CloudDriveJobRunStatus | null
  lastRunAt: number | null
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
}

export interface CloudDriveJobRun {
  id: string
  jobId: string
  status: CloudDriveJobRunStatus
  trigger: CloudDriveJobTrigger
  startedAt: number
  finishedAt: number | null
  durationMs: number | null
  summary: string | null
  error: string | null
}

export interface CloudDriveJobsStats {
  total: number
  enabled: number
  waiting: number
  nextRunAt: number | null
}

export interface CloudDriveJobActivityBucket {
  at: number
  count: number
}

export interface CloudDriveJobsResponse {
  jobs: CloudDriveJob[]
  stats?: CloudDriveJobsStats
  activity?: CloudDriveJobActivityBucket[]
}

export interface CloudDriveJobRunsResponse {
  runs: CloudDriveJobRun[]
  cursor: string | null
}

export interface CloudDriveJobInput {
  handler: CloudDriveJobHandler | string
  name: string
  scheduleType: CloudDriveJobSchedule
  intervalSec: number | null
  cron: string | null
  enabled: boolean
  config?: Record<string, unknown>
}

export interface CloudDriveOrphanObject {
  key: string
  size: number
  uploaded: number
}

export interface CloudDriveOrphanScan {
  orphans: CloudDriveOrphanObject[]
  scanned: number
  cursor: string | null
  done: boolean
}

export interface CloudDriveManifestEntry {
  path: string
  name: string
  kind: 'file' | 'folder'
  category?: string
  mime?: string
  size?: number
  etag?: string | null
  checksum?: string | null
  storageKey?: string | null
  color?: string | null
  starredAt?: number | null
  createdAt?: number
  updatedAt?: number
  uploadedAt?: number
  modifiedAt?: number
  tags?: { tag: string; color: string }[]
}

export interface CloudDriveManifest {
  format: 'inkstone-clouddrive'
  version: 1
  exportedAt: number
  truncated: boolean
  entries: CloudDriveManifestEntry[]
}

export interface CloudDriveImportResult {
  imported: number
  skipped: number
  errors: { path: string; reason: string }[]
}

export const clouddriveAdminApi = {
  overview: () => request<CloudDriveAdminOverview>('/api/clouddrive/admin/overview'),
  activity: (days = 7) => request<CloudDriveAdminActivity>(`/api/clouddrive/admin/activity${query({ days })}`),
  cache: () => request<CloudDriveAdminCacheStats>('/api/clouddrive/admin/cache'),

  files: (params: CloudDriveAdminFilesQuery = {}) => request<CloudDriveAdminFiles>(`/api/clouddrive/admin/files${query({
    q: params.q,
    type: params.type,
    storage: params.storage,
    creator: params.creator,
    cursor: params.cursor,
    limit: params.limit,
  })}`),
  deleteFiles: (ids: string[], onlyRecord: boolean) => request<CloudDriveAdminDeleteResult>('/api/clouddrive/admin/files/delete', json({ ids, onlyRecord })),

  index: () => request<CloudDriveAdminIndex>('/api/clouddrive/admin/index'),
  rebuildIndex: (mountId?: string) => request<CloudDriveAdminIndexJob>('/api/clouddrive/admin/index/rebuild', json(mountId ? { mountId } : {})),
  incrementalIndex: (mountId?: string) => request<CloudDriveAdminIndexJob>('/api/clouddrive/admin/index/incremental', json(mountId ? { mountId } : {})),
  clearIndex: (mountId?: string) => request<CloudDriveAdminIndexJob>('/api/clouddrive/admin/index/clear', json(mountId ? { mountId } : {})),

  tasks: () => request<CloudDriveTasks>('/api/clouddrive/tasks'),
  cancelTask: (id: string) => request<{ ok: true }>(`/api/clouddrive/tasks/${encodeURIComponent(id)}/cancel`, json({})),

  orphans: (cursor?: string | null, limit = 200) => request<CloudDriveOrphanScan>(`/api/clouddrive/admin/maintenance/orphans${query({ cursor, limit })}`),
  deleteOrphans: (keys: string[]) => request<{ deleted: number; skipped: number }>('/api/clouddrive/admin/maintenance/orphans/delete', json({ keys })),
  exportManifest: () => request<CloudDriveManifest>('/api/clouddrive/admin/maintenance/export'),
  importManifest: (manifest: CloudDriveManifest) => request<CloudDriveImportResult>('/api/clouddrive/admin/maintenance/import', json(manifest)),

  jobs: () => request<CloudDriveJobsResponse>('/api/clouddrive/jobs'),
  job: (id: string) => request<{ job: CloudDriveJob }>(`/api/clouddrive/jobs/${encodeURIComponent(id)}`),
  createJob: (body: CloudDriveJobInput) => request<{ job: CloudDriveJob }>('/api/clouddrive/jobs', json(body)),
  updateJob: (id: string, body: Partial<CloudDriveJobInput>) => request<{ job: CloudDriveJob }>(`/api/clouddrive/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteJob: (id: string) => request<{ ok: true }>(`/api/clouddrive/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runJob: (id: string) => request<{ ok?: true; run?: CloudDriveJobRun }>(`/api/clouddrive/jobs/${encodeURIComponent(id)}/run`, json({})),
  jobRuns: (id: string, cursor?: string | null) => request<CloudDriveJobRunsResponse>(`/api/clouddrive/jobs/${encodeURIComponent(id)}/runs${query({ cursor, limit: 50 })}`),
}
