// Owner-facing snippet and import routes (plan W7-02). Every statement is scoped to the session's
// `userId`, and the audit table is not involved: snippets are content, not security events.

import { Hono, type Context } from 'hono'
import type { WebsshImportCommitResult, WebsshSnippet } from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { clampPage, clampPageSize, WebsshHostsStore } from './hosts'
import { normalizeImportCommit, previewImport, WEBSSH_IMPORT_CANDIDATE_MAX } from './import'
import {
  normalizeSnippetCommand,
  normalizeSnippetDescription,
  normalizeSnippetShell,
  normalizeSnippetTags,
  normalizeSnippetTitle,
  WebsshSnippetsStore,
  type WebsshSnippetInput,
} from './snippets'

export const websshSnippetRoutes = new Hono<AppBindings>()

websshSnippetRoutes.use('*', requireAuth)

function snippetsStore(c: Context<AppBindings>): WebsshSnippetsStore {
  return new WebsshSnippetsStore(c.env.DB, c.get('userId'))
}

function parseSnippetBody(body: Record<string, unknown>, existing?: WebsshSnippet): WebsshSnippetInput {
  return {
    title: normalizeSnippetTitle(body.title, !existing),
    command: normalizeSnippetCommand(body.command, !existing),
    description: body.description !== undefined
      ? normalizeSnippetDescription(body.description)
      : existing?.description ?? '',
    tags: body.tags !== undefined ? normalizeSnippetTags(body.tags) : existing?.tags ?? [],
    shell: body.shell !== undefined ? normalizeSnippetShell(body.shell) : existing?.shell ?? '',
    favorite: body.favorite === undefined ? existing?.favorite ?? false : body.favorite === true,
    sortOrder: body.sortOrder === undefined
      ? existing?.sortOrder
      : typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder) ? body.sortOrder : existing?.sortOrder,
  }
}

websshSnippetRoutes.get('/snippets', async (c) => {
  const query = c.req.query('q') ?? ''
  return c.json(await snippetsStore(c).list({
    query,
    favoriteOnly: c.req.query('favorite') === '1',
    page: clampPage(c.req.query('page'), 1),
    pageSize: clampPageSize(c.req.query('pageSize')),
  }))
})

websshSnippetRoutes.post('/snippets', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const snippet = await snippetsStore(c).create(parseSnippetBody(body))
  return c.json({ snippet }, 201)
})

websshSnippetRoutes.patch('/snippets/:id', async (c) => {
  const store = snippetsStore(c)
  const existing = await store.get(c.req.param('id'))
  if (!existing) throw ApiError.notFound('Snippet not found')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  return c.json({ snippet: await store.update(existing.id, parseSnippetBody(body, existing)) })
})

websshSnippetRoutes.delete('/snippets/:id', async (c) => {
  const removed = await snippetsStore(c).remove(c.req.param('id'))
  if (!removed) throw ApiError.notFound('Snippet not found')
  return c.json({ ok: true })
})

/** Marks a snippet as used when it is inserted into a terminal. */
websshSnippetRoutes.post('/snippets/:id/touch', async (c) => {
  const snippet = await snippetsStore(c).touch(c.req.param('id'))
  if (!snippet) throw ApiError.notFound('Snippet not found')
  return c.json({ snippet })
})

websshSnippetRoutes.post('/imports/preview', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.templateLibrary)
  return c.json(previewImport(body.content, body.format))
})

websshSnippetRoutes.post('/imports', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.templateLibrary)
  if (!Array.isArray(body.hosts)) throw ApiError.badRequest('hosts must be an array')
  if (body.hosts.length > WEBSSH_IMPORT_CANDIDATE_MAX) {
    throw ApiError.badRequest(`At most ${WEBSSH_IMPORT_CANDIDATE_MAX} hosts can be imported at once`)
  }
  const store = new WebsshHostsStore(c.env.DB, c.get('userId'))
  const created: WebsshImportCommitResult['created'] = []
  const skipped: WebsshImportCommitResult['skipped'] = []
  for (const value of body.hosts) {
    const { input, issues } = normalizeImportCommit(value)
    const name = typeof (value as { name?: unknown })?.name === 'string' ? (value as { name: string }).name : ''
    if (!input) {
      skipped.push({ name, reason: issues[0] ?? 'invalid' })
      continue
    }
    if (await store.hasDuplicate(input)) {
      skipped.push({ name: input.name, reason: 'duplicate' })
      continue
    }
    created.push(await store.createImported(input))
  }
  return c.json<WebsshImportCommitResult>({ created, skipped })
})
