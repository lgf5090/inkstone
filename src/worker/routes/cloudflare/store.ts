/**
 * `/api/cloudflare/store` — catalogue sources, the merged catalogue, and two-phase deployment.
 *
 * Every row is scoped by the reader's id; another reader's source is answered as missing, not
 * forbidden. Deployment is two-phase because the second phase writes to Cloudflare: preflight checks
 * the account, the template and a reachable source without changing anything, and deploy performs the
 * same checks again before the first upload. Batch is per-target by contract — one refused account
 * is a row in the result, never an exception for the whole call.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { loadAccount, type LoadedAccount } from '../../cloudflare/accounts'
import { auditFailureDetail, createAuditLog, type AuditStatus } from '../../cloudflare/audit'
import {
  addSource,
  deleteSource,
  downloadReadme,
  downloadReadmeImage,
  downloadTemplateBytes,
  errorMessage,
  findTemplate,
  getSourceRow,
  listSources,
  seedDefaultSources,
  templateSources,
  updateSource,
  type CatalogTemplate,
} from '../../cloudflare/catalog'
import { collectCatalogue } from '../../cloudflare/catalog'
import {
  assertDeployName,
  deployTemplate,
  extractPagesArchive,
  resolveDeployType,
  type DeployType,
} from '../../cloudflare/store-deploy'

export const storeRouter = new Hono<AppBindings>()

const MAX_BATCH_DEPLOYMENTS = 50
const MAX_RECORD_ENTRIES = 100

interface DeploymentRequest {
  accountId: string
  templateId: string
  name: string
  bindingSelections: Record<string, string>
  secretValues: Record<string, string>
  deployType?: string
}

interface DeploymentResult {
  accountId: string
  name: string
  success: boolean
  url?: string
  error?: string
}

async function jsonObject(c: Context<AppBindings>): Promise<Record<string, unknown>> {
  const value = await c.req.json().catch(() => null) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('A JSON object is required')
  }
  return value as Record<string, unknown>
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw ApiError.badRequest(`${key} is required`)
  }
  return value.trim()
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw ApiError.badRequest(`${key} must be a string`)
  return value
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw ApiError.badRequest(`${key} must be a boolean`)
  return value
}

function stringRecord(body: Record<string, unknown>, key: string): Record<string, string> {
  const value = body[key]
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest(`${key} must be an object of strings`)
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_RECORD_ENTRIES) {
    throw ApiError.badRequest(`${key} has more than ${MAX_RECORD_ENTRIES} entries`)
  }
  const out: Record<string, string> = {}
  for (const [name, entry] of entries) {
    if (typeof entry !== 'string') throw ApiError.badRequest(`${key}.${name} must be a string`)
    out[name] = entry
  }
  return out
}

function readDeployment(value: unknown): DeploymentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('Each deployment must be an object')
  }
  const body = value as Record<string, unknown>
  return {
    accountId: requiredString(body, 'accountId'),
    templateId: requiredString(body, 'templateId'),
    name: requiredString(body, 'name'),
    bindingSelections: stringRecord(body, 'bindingSelections'),
    secretValues: stringRecord(body, 'secretValues'),
    ...(optionalString(body, 'deployType') !== undefined
      ? { deployType: optionalString(body, 'deployType') }
      : {}),
  }
}

async function audit(
  c: Context<AppBindings>,
  userId: string,
  accountId: string | null,
  action: string,
  target: string | null,
  detail: string | null,
  status: AuditStatus = 'success',
): Promise<void> {
  await createAuditLog(c.env, userId, accountId, action, target, detail, status)
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

storeRouter.get('/sources', async (c) => {
  const sources = await listSources(c.env, c.get('userId'))
  return c.json({ sources })
})

storeRouter.post('/sources/test', async (c) => {
  const body = await jsonObject(c)
  const url = requiredString(body, 'url')
  const { fetchCatalog } = await import('../../cloudflare/catalog')
  const { catalog } = await fetchCatalog(url)
  if (!catalog) throw new ApiError(502, 'cloudflare_upstream', 'The catalog answered without a document')
  const name = typeof catalog.name === 'string' && catalog.name.trim() ? catalog.name : undefined
  return c.json({ ok: true, count: catalog.templates.length, ...(name ? { name } : {}) })
})

storeRouter.post('/sources', async (c) => {
  const userId = c.get('userId')
  const body = await jsonObject(c)
  const url = requiredString(body, 'url')
  const name = requiredString(body, 'name')
  const source = await addSource(c.env, userId, url, name)
  await audit(c, userId, null, 'create_catalog_source', source.name, source.url)
  return c.json({ source }, 201)
})

storeRouter.put('/sources/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const body = await jsonObject(c)
  const name = optionalString(body, 'name')
  const enabled = optionalBoolean(body, 'enabled')
  if (name === undefined && enabled === undefined) throw ApiError.badRequest('No fields to update')
  const source = await updateSource(c.env, userId, id, {
    ...(name !== undefined ? { name } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  })
  const changed = [name !== undefined ? 'name' : '', enabled !== undefined ? 'enabled' : ''].filter(Boolean)
  await audit(c, userId, null, 'update_catalog_source', source.name, `fields=${changed.join(',')}`)
  return c.json({ source })
})

storeRouter.delete('/sources/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const row = await getSourceRow(c.env, userId, id)
  if (!row) throw ApiError.notFound('That catalog source does not exist')
  await deleteSource(c.env, userId, id)
  await audit(c, userId, null, 'delete_catalog_source', row.name, row.url)
  return c.json({ ok: true })
})

/**
 * The README proxy: the catalog host is not in this deployment's connect-src, so the worker reads it.
 *
 * POST rather than GET because the argument is the address of a third-party page the reader chose to
 * look at — a query string writes that address into every access log between here and the platform.
 */
storeRouter.post('/readme', async (c) => {
  const raw = (await jsonObject(c)).url
  if (typeof raw !== 'string' || !raw.trim()) throw ApiError.badRequest('A readme URL is required')
  const text = await downloadReadme(raw)
  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Cache-Control', 'private, no-store')
  return c.text(text)
})

/**
 * A README's images, fetched through the worker because the page's `img-src` does not allow the
 * documentation host. This one stays a GET: an `<img>` cannot carry a body, so the address is in the
 * URL by construction. What the log learns is which public page the reader was already reading.
 */
storeRouter.get('/image', async (c) => {
  const raw = c.req.query('url')
  if (typeof raw !== 'string' || !raw.trim()) throw ApiError.badRequest('An image URL is required')
  const { bytes, type } = await downloadReadmeImage(raw)
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': type,
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      // README badges are mostly SVG, and SVG served from this origin is a document rather than a
      // bitmap. It stays inert because the response sandboxes itself and allows no fetch target.
      'content-security-policy': "default-src 'none'; sandbox; img-src 'none'; form-action 'none'; base-uri 'none'",
    },
  })
})

storeRouter.post('/init', async (c) => {
  const userId = c.get('userId')
  const created = await seedDefaultSources(c.env, userId)
  if (created > 0) {
    await audit(c, userId, null, 'init_catalog_sources', null, `created=${created}`)
  }
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------------------------

storeRouter.get('/templates', async (c) => {
  const catalogue = await collectCatalogue(c.env, c.get('userId'), { refresh: false })
  return c.json(catalogue)
})

storeRouter.post('/refresh', async (c) => {
  const catalogue = await collectCatalogue(c.env, c.get('userId'), { refresh: true })
  return c.json(catalogue)
})

// ---------------------------------------------------------------------------------------------
// Preflight and deployment
// ---------------------------------------------------------------------------------------------

interface LoadedTarget {
  account: LoadedAccount
  template: CatalogTemplate
  deployType: DeployType
}

async function loadTarget(
  c: Context<AppBindings>,
  userId: string,
  request: DeploymentRequest,
): Promise<LoadedTarget> {
  assertDeployName(request.name)
  const account = await loadAccount(c.env, userId, request.accountId)
  const match = await findTemplate(c.env, userId, request.templateId)
  if (!match) throw ApiError.notFound('That template is not in any enabled catalog')
  const deployType = resolveDeployType(match.template, request.deployType)
  return { account, template: match.template, deployType }
}

type SourceLabel = 'Worker' | 'Pages'

function requiredSourceUrls(
  template: CatalogTemplate,
  deployType: DeployType,
): Array<{ label: SourceLabel; url: string | undefined }> {
  const sources = templateSources(template)
  if (deployType === 'worker') return [{ label: 'Worker', url: sources.worker }]
  if (deployType === 'pages') return [{ label: 'Pages', url: sources.pages }]
  return [
    { label: 'Worker', url: sources.worker },
    { label: 'Pages', url: sources.pages },
  ]
}

storeRouter.post('/preflight', async (c) => {
  const userId = c.get('userId')
  const body = await jsonObject(c)
  const request = readDeployment(body)
  const { account, template, deployType } = await loadTarget(c, userId, request)

  const problems: string[] = []
  for (const { label, url } of requiredSourceUrls(template, deployType)) {
    if (!url) {
      problems.push(`This template has no ${label} source`)
      continue
    }
    try {
      const bytes = await downloadTemplateBytes(url)
      if (label === 'Pages') await extractPagesArchive(bytes)
    } catch (error) {
      problems.push(errorMessage(error))
    }
  }

  const sourceOk = problems.length === 0
  const sourceError = sourceOk ? undefined : problems.join('; ')
  const warning = account.row.cf_account_id
    ? undefined
    : 'The account is not bound to a Cloudflare account id'
  const ok = sourceOk && Boolean(account.row.cf_account_id)

  return c.json({
    ok,
    templateId: request.templateId,
    templateName: template.name,
    accountId: account.row.id,
    accountName: account.row.name,
    deployType,
    sourceOk,
    ...(sourceError ? { sourceError } : {}),
    ...(warning ? { warning } : {}),
  })
})

/** The shared body of `/deploy` and one batch row; throws only when the preconditions fail. */
async function runDeployment(
  c: Context<AppBindings>,
  userId: string,
  request: DeploymentRequest,
): Promise<DeploymentResult> {
  const { account, template, deployType } = await loadTarget(c, userId, request)
  const outcome = await deployTemplate(c.env, {
    account,
    template,
    name: request.name,
    deployType,
    bindingSelections: request.bindingSelections,
    secretValues: request.secretValues,
  })
  return {
    accountId: account.row.id,
    name: request.name,
    success: outcome.ok,
    ...(outcome.url ? { url: outcome.url } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  }
}

storeRouter.post('/deploy', async (c) => {
  const userId = c.get('userId')
  const body = await jsonObject(c)
  const request = readDeployment(body)
  try {
    const result = await runDeployment(c, userId, request)
    await audit(
      c,
      userId,
      result.accountId,
      'store_deploy',
      result.name,
      `template=${request.templateId}${result.url ? ` url=${result.url}` : ''}`,
      result.success ? 'success' : 'error',
    )
    return c.json(result, result.success ? 201 : 200)
  } catch (error) {
    await audit(c, userId, request.accountId, 'store_deploy', request.name, auditFailureDetail(error), 'error')
    throw error
  }
})

storeRouter.post('/deploy-batch', async (c) => {
  const userId = c.get('userId')
  const body = await jsonObject(c)
  const raw = body.deployments
  if (!Array.isArray(raw) || raw.length === 0) {
    throw ApiError.badRequest('deployments must be a non-empty array')
  }
  if (raw.length > MAX_BATCH_DEPLOYMENTS) {
    throw ApiError.badRequest(`At most ${MAX_BATCH_DEPLOYMENTS} deployments can be sent at once`)
  }

  const results: DeploymentResult[] = []
  for (const entry of raw) {
    let request: DeploymentRequest | null = null
    try {
      request = readDeployment(entry)
      const result = await runDeployment(c, userId, request)
      await audit(
        c,
        userId,
        result.accountId,
        'store_deploy_batch',
        result.name,
        `template=${request.templateId}${result.url ? ` url=${result.url}` : ''}`,
        result.success ? 'success' : 'error',
      )
      results.push(result)
    } catch (error) {
      const message = errorMessage(error)
      const accountId = request?.accountId ?? ''
      const name = request?.name ?? ''
      await audit(c, userId, accountId || null, 'store_deploy_batch', name || null, auditFailureDetail(error), 'error')
      results.push({ accountId, name, success: false, error: message })
    }
  }

  const succeeded = results.filter((result) => result.success).length
  return c.json({
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  })
})

// Re-exported for the settings slice, which lists source status beside the task list.
