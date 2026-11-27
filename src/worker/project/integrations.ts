import type { ProjectCard, ProjectExternalLink, ProjectIntegration, ProjectIntegrationProvider } from '@shared/project/model'
import type { ProjectIntegrationCreateInput } from '@shared/project/validation'
import { newProjectId } from '@shared/project/limits'
import { newId } from '../lib/id'
import { ApiError } from '../lib/errors'
import { checkTarget, outbound } from '../lib/outbound'
import { decryptProjectIntegrationConfig, encryptProjectIntegrationConfig } from '../lib/crypto'
import type { AppBindings } from '../env'

const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 64 * 1024

type IntegrationConfig =
  | { webhookUrl: string }
  | { token: string, owner: string, repo: string }
  | { baseUrl: string, email: string, token: string, projectKey: string }

interface IntegrationRow {
  id: string
  board_id: string
  provider: ProjectIntegrationProvider
  config_ciphertext?: string
  target: string
  enabled: number
  created_at: number
}

interface ExternalLinkRow {
  id: string
  card_id: string
  provider: 'github' | 'jira'
  external_id: string
  external_url: string
  title: string
  status: 'pending' | 'ready'
}

function rowToIntegration(row: IntegrationRow): ProjectIntegration {
  return {
    id: row.id,
    boardId: row.board_id,
    provider: row.provider,
    target: row.target,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
  }
}

function rowToExternalLink(row: ExternalLinkRow): ProjectExternalLink {
  return {
    id: row.id,
    cardId: row.card_id,
    provider: row.provider,
    externalId: row.external_id,
    externalUrl: row.external_url,
    title: row.title,
  }
}

function integrationTarget(provider: ProjectIntegrationProvider, config: IntegrationConfig): string {
  if (provider === 'slack') return 'Slack'
  if (provider === 'github') return `${(config as { owner: string }).owner}/${(config as { repo: string }).repo}`
  return (config as { projectKey: string }).projectKey
}

function assertIntegrationUrl(raw: string): string {
  const target = checkTarget(raw)
  if (!target.url || target.url.protocol !== 'https:') throw ApiError.badRequest('Integration URL must use HTTPS')
  return target.url.toString()
}

export async function listProjectIntegrations(db: D1Database, boardId: string): Promise<ProjectIntegration[]> {
  const { results } = await db.prepare(
    'SELECT id, board_id, provider, target, enabled, created_at FROM project_integrations WHERE board_id = ?1 ORDER BY created_at, id',
  ).bind(boardId).all<IntegrationRow>()
  return results.map(rowToIntegration)
}

export async function saveProjectIntegration(
  db: D1Database,
  env: AppBindings['Bindings'],
  boardId: string,
  userId: string,
  input: ProjectIntegrationCreateInput,
  now: number,
): Promise<ProjectIntegration> {
  const config = input.config as IntegrationConfig
  if (input.provider === 'slack') assertIntegrationUrl((config as { webhookUrl: string }).webhookUrl)
  if (input.provider === 'jira') assertIntegrationUrl((config as { baseUrl: string }).baseUrl)
  const target = integrationTarget(input.provider, config)
  const inserted = await db.prepare(
    `INSERT INTO project_integrations (id, board_id, provider, config_ciphertext, target, enabled, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, '', ?4, 0, ?5, ?6, ?6)
     ON CONFLICT(board_id, provider) DO NOTHING`,
  ).bind(newId(), boardId, input.provider, target, userId, now).run()
  const claimed = await db.prepare('SELECT id FROM project_integrations WHERE board_id = ?1 AND provider = ?2')
    .bind(boardId, input.provider).first<{ id: string }>()
  if (!claimed) throw new Error('project_integration_claim_failed')
  try {
    const ciphertext = await encryptProjectIntegrationConfig(env, claimed.id, config as unknown as Record<string, string>)
    await db.prepare(
      'UPDATE project_integrations SET config_ciphertext = ?1, target = ?2, enabled = 1, updated_at = ?3 WHERE id = ?4',
    ).bind(ciphertext, target, now, claimed.id).run()
  } catch (error) {
    if (inserted.meta?.changes) await db.prepare('DELETE FROM project_integrations WHERE id = ?1 AND config_ciphertext = \'\'').bind(claimed.id).run()
    throw error
  }
  const { results } = await db.prepare(
    'SELECT id, board_id, provider, config_ciphertext, target, enabled, created_at FROM project_integrations WHERE board_id = ?1 AND provider = ?2',
  ).bind(boardId, input.provider).all<IntegrationRow>()
  return rowToIntegration(results[0]!)
}

export async function patchProjectIntegration(
  db: D1Database,
  boardId: string,
  id: string,
  enabled: boolean,
  now: number,
): Promise<ProjectIntegration | null> {
  const result = await db.prepare('UPDATE project_integrations SET enabled = ?1, updated_at = ?2 WHERE board_id = ?3 AND id = ?4')
    .bind(enabled ? 1 : 0, now, boardId, id).run()
  if (!result.meta?.changes) return null
  const { results } = await db.prepare(
    'SELECT id, board_id, provider, config_ciphertext, target, enabled, created_at FROM project_integrations WHERE board_id = ?1 AND id = ?2',
  ).bind(boardId, id).all<IntegrationRow>()
  return results[0] ? rowToIntegration(results[0]) : null
}

export async function deleteProjectIntegration(db: D1Database, boardId: string, id: string): Promise<void> {
  await db.prepare('DELETE FROM project_integrations WHERE board_id = ?1 AND id = ?2').bind(boardId, id).run()
}

async function integrationConfig(
  db: D1Database,
  env: AppBindings['Bindings'],
  boardId: string,
  provider: ProjectIntegrationProvider,
): Promise<IntegrationConfig | null> {
  const row = await db.prepare(
    'SELECT id, config_ciphertext FROM project_integrations WHERE board_id = ?1 AND provider = ?2 AND enabled = 1',
  ).bind(boardId, provider).first<{ id: string, config_ciphertext: string }>()
  if (!row) return null
  return await decryptProjectIntegrationConfig(env, row.id, row.config_ciphertext) as IntegrationConfig | null
}

async function cardMarkdown(db: D1Database, card: ProjectCard): Promise<string> {
  const { results } = await db.prepare(
    'SELECT title FROM project_card_contents WHERE card_id = ?1 AND delete_at = 0 ORDER BY position, id',
  ).bind(card.id).all<{ title: string }>()
  return results.map((row) => row.title).filter(Boolean).join('\n\n')
}

export async function dispatchProjectSlackEvent(
  db: D1Database,
  env: AppBindings['Bindings'],
  boardId: string,
  event: string,
  targetId: string,
): Promise<void> {
  const config = await integrationConfig(db, env, boardId, 'slack') as { webhookUrl?: string } | null
  if (!config?.webhookUrl) return
  const card = await db.prepare('SELECT title FROM project_cards WHERE id = ?1').bind(targetId).first<{ title: string }>()
  const url = assertIntegrationUrl(config.webhookUrl)
  const result = await outbound(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `Inkstone · ${event} · ${card?.title || targetId}` }),
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
  })
  if (!result.ok) console.warn('[inkstone] Slack project notification failed:', result.error || `HTTP ${result.status}`)
}

export async function listProjectExternalLinks(db: D1Database, cardId: string): Promise<ProjectExternalLink[]> {
  const { results } = await db.prepare(
    'SELECT id, card_id, provider, external_id, external_url, title FROM project_external_links WHERE card_id = ?1 AND status = \'ready\' ORDER BY created_at, id',
  ).bind(cardId).all<ExternalLinkRow>()
  return results.map(rowToExternalLink)
}

async function githubIssueRequest(
  config: { token: string, owner: string, repo: string },
  issueId: string | null,
  title: string,
  body: string,
): Promise<{ id: string, url: string }> {
  const base = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/issues`
  const url = issueId ? `${base}/${encodeURIComponent(issueId)}` : base
  const result = await outbound(url, {
    method: issueId ? 'PATCH' : 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${config.token}`,
      'accept': 'application/vnd.github+json',
      'user-agent': 'Inkstone-Project/1',
    },
    body: JSON.stringify({ title, body }),
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
  })
  if (!result.ok) throw new ApiError(502, 'upstream_unavailable', `GitHub issue request failed (${result.status})`)
  let payload: { number?: number, html_url?: string }
  try { payload = JSON.parse(result.text) as { number?: number, html_url?: string } } catch { throw new ApiError(502, 'upstream_unavailable', 'GitHub returned an invalid issue') }
  if (!payload.number || !payload.html_url) throw new ApiError(502, 'upstream_unavailable', 'GitHub returned an invalid issue')
  return { id: String(payload.number), url: assertIntegrationUrl(payload.html_url) }
}

async function jiraIssueRequest(
  config: { baseUrl: string, email: string, token: string, projectKey: string },
  issueId: string | null,
  title: string,
  body: string,
): Promise<{ id: string, url: string }> {
  const base = assertIntegrationUrl(config.baseUrl).replace(/\/$/, '')
  const url = issueId ? `${base}/rest/api/3/issue/${encodeURIComponent(issueId)}` : `${base}/rest/api/3/issue`
  const auth = btoa(`${config.email}:${config.token}`)
  const fields = issueId
    ? { summary: title, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] } }
    : { project: { key: config.projectKey }, summary: title, issuetype: { name: 'Task' }, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] } }
  const result = await outbound(url, {
    method: issueId ? 'PUT' : 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Basic ${auth}`,
      'accept': 'application/json',
    },
    body: JSON.stringify({ fields }),
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
  })
  if (!result.ok) throw new ApiError(502, 'upstream_unavailable', `Jira issue request failed (${result.status})`)
  let payload: { key?: string, self?: string }
  try { payload = JSON.parse(result.text || '{}') as { key?: string, self?: string } } catch { throw new ApiError(502, 'upstream_unavailable', 'Jira returned an invalid issue') }
  const id = issueId ?? payload.key
  if (!id) throw new ApiError(502, 'upstream_unavailable', 'Jira returned an invalid issue')
  return { id, url: payload.self ? assertIntegrationUrl(payload.self) : `${base}/browse/${encodeURIComponent(id)}` }
}

export async function createProjectExternalIssue(
  db: D1Database,
  env: AppBindings['Bindings'],
  card: ProjectCard,
  provider: 'github' | 'jira',
): Promise<ProjectExternalLink> {
  const existing = await db.prepare('SELECT * FROM project_external_links WHERE card_id = ?1 AND provider = ?2')
    .bind(card.id, provider).first<ExternalLinkRow>()
  if (existing?.status === 'ready') return rowToExternalLink(existing)
  if (existing?.status === 'pending') throw new ApiError(409, 'conflict', 'External issue creation is already in progress')
  const config = await integrationConfig(db, env, card.boardId, provider)
  if (!config) throw ApiError.notFound('Integration not found')
  const id = newProjectId('activity')
  const now = Date.now()
  const claimed = await db.prepare(
    `INSERT INTO project_external_links (id, card_id, board_id, provider, external_id, external_url, title, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, '', '', ?5, 'pending', ?6, ?6)
     ON CONFLICT(card_id, provider) DO NOTHING`,
  ).bind(id, card.id, card.boardId, provider, card.title, now).run()
  if (!claimed.meta?.changes) {
    const current = await db.prepare('SELECT * FROM project_external_links WHERE card_id = ?1 AND provider = ?2')
      .bind(card.id, provider).first<ExternalLinkRow>()
    if (current?.status === 'ready') return rowToExternalLink(current)
    throw new ApiError(409, 'conflict', 'External issue creation is already in progress')
  }
  try {
    const body = await cardMarkdown(db, card)
    const issue = provider === 'github'
      ? await githubIssueRequest(config as { token: string, owner: string, repo: string }, null, card.title, body)
      : await jiraIssueRequest(config as { baseUrl: string, email: string, token: string, projectKey: string }, null, card.title, body)
    await db.prepare(
      'UPDATE project_external_links SET external_id = ?1, external_url = ?2, title = ?3, status = \'ready\', updated_at = ?4 WHERE id = ?5',
    ).bind(issue.id, issue.url, card.title, Date.now(), id).run()
    return { id, cardId: card.id, provider, externalId: issue.id, externalUrl: issue.url, title: card.title }
  } catch (error) {
    await db.prepare('DELETE FROM project_external_links WHERE id = ?1 AND status = \'pending\'').bind(id).run()
    throw error
  }
}

export async function syncProjectExternalLinksForCard(db: D1Database, env: AppBindings['Bindings'], card: ProjectCard): Promise<void> {
  const { results } = await db.prepare('SELECT * FROM project_external_links WHERE card_id = ?1 AND status = \'ready\'').bind(card.id).all<ExternalLinkRow>()
  for (const link of results) {
    try {
      const config = await integrationConfig(db, env, card.boardId, link.provider)
      if (!config) continue
      const body = await cardMarkdown(db, card)
      if (link.provider === 'github') {
        const issue = await githubIssueRequest(config as { token: string, owner: string, repo: string }, link.external_id, card.title, body)
        await db.prepare('UPDATE project_external_links SET title = ?1, external_url = ?2, updated_at = ?3 WHERE id = ?4')
          .bind(card.title, issue.url, Date.now(), link.id).run()
      } else {
        const issue = await jiraIssueRequest(config as { baseUrl: string, email: string, token: string, projectKey: string }, link.external_id, card.title, body)
        await db.prepare('UPDATE project_external_links SET title = ?1, external_url = ?2, updated_at = ?3 WHERE id = ?4')
          .bind(card.title, issue.url, Date.now(), link.id).run()
      }
    } catch (error) {
      console.warn('[inkstone] project external issue sync failed:', link.id, error instanceof Error ? error.message : error)
    }
  }
}
