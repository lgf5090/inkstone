/**
 * The Workers screen's door to `/api/cloudflare/workers`.
 *
 * Every account id and worker name is encoded here, so a name a reader typed cannot change which
 * endpoint a call reaches. Batch deploys are multipart because the script is a file, not JSON.
 */
import { cfRequest } from './client'

export type WorkerKind = 'worker' | 'pages'

export interface WorkerRow {
  type: WorkerKind
  name: string
  status: string
  accountId: string
  accountName: string
  createdOn: string | null
  modifiedOn: string | null
}

export interface WorkerSummary {
  accountId: string
  accountName: string
  requests: number
  errors: number
  subrequests: number
  cpuTimeMs: number
  workerCount: number
  pagesCount: number
}

export interface WorkerUsage {
  accountId: string
  accountName: string
  requests: number
  errors: number
  subrequests: number
  cpuTimeMs: number
}

export interface WorkerSecret {
  name: string
  type?: string
}

export interface WorkerCronSchedule {
  id?: string
  cron: string
  created_on?: string
  modified_on?: string
}

export interface WorkerSchedulesResponse {
  schedules?: WorkerCronSchedule[]
}

export interface WorkerDomain {
  id: string
  hostname: string
  environment?: string
}

export interface WorkerSubdomain {
  enabled?: boolean
  previews_enabled?: boolean
  url?: string
  accountSubdomain?: string
}

export interface WorkerDeployment {
  id?: string
  created_on?: string
  source?: string
}

export interface WorkerRoute {
  id: string
  pattern: string
  script?: string
}

export type DeployBindingType = 'kv' | 'd1' | 'r2' | 'ai' | 'durable_object' | 'service' | 'queue'

export interface DeployVarInput {
  name: string
  value?: string
  secret: boolean
  keep?: boolean
}

export interface DeployBindingInput {
  type: DeployBindingType
  name: string
  resourceName?: string
  mode?: 'auto' | 'existing'
  existingId?: string
  className?: string
  scriptName?: string
  service?: string
  environment?: string
  queueName?: string
}

export interface DeployTarget {
  accountId: string
  workerName: string
}

export interface DeployResultRow {
  accountId: string
  workerName: string
  success: boolean
  url?: string
  error?: string
}

export interface DeployBatchResult {
  total: number
  succeeded: number
  failed: number
  results: DeployResultRow[]
}

export interface WorkerBinding {
  type: string
  name: string
  text?: string
  namespace_id?: string
  id?: string
  bucket_name?: string
  class_name?: string
  script_name?: string
  service?: string
  environment?: string
  queue_name?: string
}

export interface WorkerSettings {
  bindings?: WorkerBinding[]
  compatibility_date?: string
  compatibility_flags?: string[]
  observability?: { enabled?: boolean; [key: string]: unknown }
  logpush?: boolean
  tags?: string[]
  [key: string]: unknown
}

export interface WorkerConfig {
  settings: WorkerSettings
  deployments: unknown
  vars: Array<{ name: string; value: string; secret: boolean }>
  bindings: DeployBindingInput[]
}

export interface KvNamespace {
  id: string
  title?: string
}

export interface D1Database {
  uuid?: string
  name?: string
}

export interface R2Bucket {
  name?: string
}

export interface R2BucketsResponse {
  buckets: R2Bucket[]
  r2_not_enabled: boolean
}

export interface ZoneOption {
  id: string
  name: string
  status?: string
}

export interface PagesEnvVar {
  type?: 'plain_text' | 'secret_text'
  value?: string
}

export interface PagesDeploymentConfig {
  env_vars?: Record<string, PagesEnvVar>
  kv_namespaces?: Record<string, { namespace_id?: string }>
  d1_databases?: Record<string, { id?: string }>
  r2_buckets?: Record<string, { name?: string }>
  ai?: Record<string, Record<string, unknown>>
  [key: string]: unknown
}

export interface PagesProject {
  id?: string
  name?: string
  subdomain?: string
  production_branch?: string
  framework?: string | null
  created_on?: string
  uses_functions?: boolean
  deployment_configs?: {
    production?: PagesDeploymentConfig
    preview?: PagesDeploymentConfig
  }
  [key: string]: unknown
}

export interface PagesDomain {
  name: string
  status?: string
}

export interface PagesDeployment {
  id: string
  environment?: string
  url?: string
  created_on?: string
  latest_stage?: { name?: string; status?: string }
  [key: string]: unknown
}

export interface DeletePagesDeploymentsResult {
  total: number
  succeeded: number
  failed: number
  results: Array<{ id: string; success: boolean; error?: string }>
}

export interface EnvSyncSource {
  accountId: string
  workerName: string
}

export interface EnvSyncTarget {
  accountId: string
  workerName: string
}

export interface EnvSyncMissingKey {
  name: string
  type: 'plain_text' | 'secret_text'
}

export interface EnvSyncPreviewEntry {
  accountId: string
  workerName: string
  missing: EnvSyncMissingKey[]
  changed: Array<{ name: string; source: string; target: string }>
  error?: string
}

export interface EnvSyncPreview {
  source: {
    vars: Array<{ name: string; value: string }>
    secrets: string[]
  }
  previews: EnvSyncPreviewEntry[]
}

export interface EnvSyncResultRow {
  accountId: string
  workerName: string
  success: boolean
  applied: string[]
  error?: string
}

function workerPath(accountId: string, name: string, suffix = ''): string {
  return `/workers/${encodeURIComponent(accountId)}/workers/${encodeURIComponent(name)}${suffix}`
}

function pagesPath(accountId: string, name: string, suffix = ''): string {
  return `/workers/${encodeURIComponent(accountId)}/pages/${encodeURIComponent(name)}${suffix}`
}

export const workersApi = {
  list: (accountId?: string) => cfRequest<WorkerRow[]>(
    `/workers${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`,
  ),
  summary: () => cfRequest<WorkerSummary[]>('/workers/summary'),
  usage: () => cfRequest<WorkerUsage[]>('/workers/usage'),
  detail: (accountId: string, name: string) => cfRequest<unknown>(workerPath(accountId, name)),
  remove: (accountId: string, name: string) =>
    cfRequest<{ success: true }>(workerPath(accountId, name), { method: 'DELETE' }),
  removePages: (accountId: string, name: string) =>
    cfRequest<{ success: true }>(pagesPath(accountId, name), { method: 'DELETE' }),

  getLogs: (accountId: string, name: string) =>
    cfRequest<unknown>(workerPath(accountId, name, '/logs')),
  getDeployments: (accountId: string, name: string) =>
    cfRequest<WorkerDeployment[] | { deployments?: WorkerDeployment[]; items?: WorkerDeployment[] }>(
      workerPath(accountId, name, '/deployments'),
    ),

  getSecrets: (accountId: string, name: string) =>
    cfRequest<WorkerSecret[]>(workerPath(accountId, name, '/secrets')),
  updateSecret: (
    accountId: string,
    name: string,
    secretName: string,
    type: string,
    text?: string,
    keyBase64?: string,
  ) => cfRequest<unknown>(workerPath(accountId, name, '/secrets'), {
    method: 'PUT',
    body: { name: secretName, type, text, key_base64: keyBase64 },
  }),
  deleteSecret: (accountId: string, name: string, secretName: string) =>
    cfRequest<{ success: true }>(
      workerPath(accountId, name, `/secrets/${encodeURIComponent(secretName)}`),
      { method: 'DELETE' },
    ),

  getSchedules: (accountId: string, name: string) =>
    cfRequest<WorkerSchedulesResponse>(workerPath(accountId, name, '/schedules')),
  updateSchedules: (accountId: string, name: string, crons: string[]) =>
    cfRequest<unknown>(workerPath(accountId, name, '/schedules'), {
      method: 'PUT',
      body: { crons },
    }),

  getDomains: (accountId: string, name: string) =>
    cfRequest<WorkerDomain[]>(workerPath(accountId, name, '/domains')),
  createDomain: (accountId: string, name: string, hostname: string, environment?: string) =>
    cfRequest<WorkerDomain>(workerPath(accountId, name, '/domains'), {
      method: 'POST',
      body: { hostname, environment },
    }),
  deleteDomain: (accountId: string, name: string, domainId: string) =>
    cfRequest<{ success: true }>(
      workerPath(accountId, name, `/domains/${encodeURIComponent(domainId)}`),
      { method: 'DELETE' },
    ),

  getSubdomain: (accountId: string, name: string) =>
    cfRequest<WorkerSubdomain>(workerPath(accountId, name, '/subdomain')),
  setSubdomain: (accountId: string, name: string, enabled: boolean) =>
    cfRequest<unknown>(workerPath(accountId, name, '/subdomain'), {
      method: 'PUT',
      body: { enabled },
    }),

  getSettings: (accountId: string, name: string) =>
    cfRequest<WorkerSettings>(workerPath(accountId, name, '/settings')),
  updateSettings: (accountId: string, name: string, settings: Record<string, unknown>) =>
    cfRequest<unknown>(workerPath(accountId, name, '/settings'), {
      method: 'PATCH',
      body: settings,
    }),

  getRoutes: (accountId: string, name: string, zoneId: string) =>
    cfRequest<WorkerRoute[]>(`${workerPath(accountId, name, '/routes')}?zone_id=${encodeURIComponent(zoneId)}`),
  createRoute: (accountId: string, name: string, zoneId: string, pattern: string) =>
    cfRequest<WorkerRoute>(workerPath(accountId, name, '/routes'), {
      method: 'POST',
      body: { zone_id: zoneId, pattern },
    }),
  deleteRoute: (accountId: string, name: string, routeId: string, zoneId: string) =>
    cfRequest<{ success: true }>(
      `${workerPath(accountId, name, `/routes/${encodeURIComponent(routeId)}`)}?zone_id=${encodeURIComponent(zoneId)}`,
      { method: 'DELETE' },
    ),

  getContent: (accountId: string, name: string) =>
    cfRequest<string>(workerPath(accountId, name, '/content')),
  getWorkerConfig: (accountId: string, name: string) =>
    cfRequest<WorkerConfig>(workerPath(accountId, name, '/config')),

  getPagesProject: (accountId: string, name: string) =>
    cfRequest<PagesProject>(pagesPath(accountId, name, '/project')),
  editPagesProject: (accountId: string, name: string, patch: Record<string, unknown>) =>
    cfRequest<PagesProject>(pagesPath(accountId, name, '/project'), { method: 'PATCH', body: patch }),
  getPagesConfig: (accountId: string, name: string) =>
    cfRequest<PagesProject>(pagesPath(accountId, name, '/config')),
  getPagesDomains: (accountId: string, name: string) =>
    cfRequest<PagesDomain[]>(pagesPath(accountId, name, '/domains')),
  addPagesDomain: (accountId: string, name: string, hostname: string) =>
    cfRequest<PagesDomain>(pagesPath(accountId, name, '/domains'), {
      method: 'POST',
      body: { hostname },
    }),
  removePagesDomain: (accountId: string, name: string, hostname: string) =>
    cfRequest<{ success: true }>(
      pagesPath(accountId, name, `/domains/${encodeURIComponent(hostname)}`),
      { method: 'DELETE' },
    ),
  getPagesDeployments: (accountId: string, name: string) =>
    cfRequest<PagesDeployment[]>(pagesPath(accountId, name, '/deployments')),
  deletePagesDeployments: (accountId: string, name: string, ids: string[]) =>
    cfRequest<DeletePagesDeploymentsResult>(pagesPath(accountId, name, '/deployments'), {
      method: 'DELETE',
      body: { ids },
    }),
  updatePagesBindings: (accountId: string, name: string, deploymentConfigs: Record<string, unknown>) =>
    cfRequest<PagesProject>(pagesPath(accountId, name, '/bindings'), {
      method: 'PUT',
      body: { deployment_configs: deploymentConfigs },
    }),

  getKvNamespaces: (accountId: string) =>
    cfRequest<KvNamespace[]>(`/workers/${encodeURIComponent(accountId)}/resources/kv`),
  getD1Databases: (accountId: string) =>
    cfRequest<D1Database[]>(`/workers/${encodeURIComponent(accountId)}/resources/d1`),
  getR2Buckets: (accountId: string) =>
    cfRequest<R2BucketsResponse>(`/workers/${encodeURIComponent(accountId)}/resources/r2`),
  getZones: (accountId: string) =>
    cfRequest<ZoneOption[]>(`/workers/${encodeURIComponent(accountId)}/resources/zones`),

  batchDeploy: (
    targets: DeployTarget[],
    options: {
      script?: File
      url?: string
      mainModule?: string
      vars?: DeployVarInput[]
      bindings?: DeployBindingInput[]
      compatibilityDate?: string
      isRedeploy?: boolean
    } = {},
  ) => {
    const form = new FormData()
    form.append('targets', JSON.stringify(targets))
    if (options.script) form.append('script', options.script)
    if (options.url) form.append('url', options.url)
    if (options.mainModule) form.append('mainModule', options.mainModule)
    if (options.vars?.length) form.append('vars', JSON.stringify(options.vars))
    if (options.bindings?.length) form.append('bindings', JSON.stringify(options.bindings))
    if (options.compatibilityDate) form.append('compatibilityDate', options.compatibilityDate)
    if (options.isRedeploy) form.append('isRedeploy', 'true')
    return cfRequest<DeployBatchResult>('/workers/batch-deploy', {
      method: 'POST',
      formData: form,
      timeoutMs: 120_000,
    })
  },
  batchDeployPages: (
    targets: DeployTarget[],
    options: {
      zipFile?: File
      vars?: DeployVarInput[]
      bindings?: DeployBindingInput[]
    } = {},
  ) => {
    const form = new FormData()
    form.append('targets', JSON.stringify(targets))
    if (options.zipFile) form.append('zipFile', options.zipFile)
    if (options.vars?.length) form.append('vars', JSON.stringify(options.vars))
    if (options.bindings?.length) form.append('bindings', JSON.stringify(options.bindings))
    return cfRequest<DeployBatchResult>('/workers/batch-deploy-pages', {
      method: 'POST',
      formData: form,
      timeoutMs: 300_000,
    })
  },

  envSyncPreview: (source: EnvSyncSource, targets: EnvSyncTarget[]) =>
    cfRequest<EnvSyncPreview>('/workers/env-sync/preview', {
      method: 'POST',
      body: { source, targets },
    }),
  envSyncExecute: (
    source: EnvSyncSource,
    targets: EnvSyncTarget[],
    keys: string[],
    secretValues: Record<string, string>,
  ) =>
    cfRequest<EnvSyncResultRow[]>('/workers/env-sync/execute', {
      method: 'POST',
      body: { source, targets, keys, secretValues },
    }),
}
