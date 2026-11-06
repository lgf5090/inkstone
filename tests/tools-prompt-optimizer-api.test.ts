// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TOOLS_PROMPT_OPTIMIZER_REQUIRED_INDEXES,
  TOOLS_PROMPT_OPTIMIZER_REQUIRED_TABLES,
  TOOLS_PROMPT_OPTIMIZER_SCHEMA_STATEMENTS,
} from '../src/worker/tools/prompt-optimizer/schema'
import { PromptOptimizerStore } from '../src/worker/tools/prompt-optimizer/store'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { toolsPromptOptimizerRoutes } from '../src/worker/routes/tools-prompt-optimizer'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER_A = 'user-alice'
const USER_B = 'user-bob'

function testApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('/api/tools/prompt-optimizer/*', async (c, next) => {
    const userId = c.req.header('x-test-user')
    if (userId) {
      c.set('userId', userId)
      c.set('user', {
        id: userId,
        username: userId,
        login: userId,
        name: userId,
        avatarUrl: '',
        role: 'member',
        createdAt: 0,
        settingsRaw: '{}',
      })
    }
    await next()
  })
  app.route('/api/tools/prompt-optimizer', toolsPromptOptimizerRoutes)
  return app
}

const app = testApp()

let sqlite: DatabaseSync
let env: Env

async function call(method: string, path: string, options: { user?: string | null; body?: unknown } = {}): Promise<Response> {
  const userId = options.user === undefined ? USER_A : options.user
  const headers: Record<string, string> = { 'X-Inkstone-Client': '1' }
  if (userId) headers['x-test-user'] = userId
  let body: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return app.fetch(new Request(`http://localhost${path}`, { method, headers, body }), env)
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of TOOLS_PROMPT_OPTIMIZER_SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite), { FILES: testR2Bucket() })
})

afterEach(() => {
  sqlite.close()
})

describe('Prompt Optimizer schema', () => {
  it('creates every required table and index', () => {
    const tables = new Set((sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((row) => row.name))
    for (const table of TOOLS_PROMPT_OPTIMIZER_REQUIRED_TABLES) expect(tables.has(table), table).toBe(true)
    const indexes = new Set((sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as { name: string }[]).map((row) => row.name))
    for (const index of TOOLS_PROMPT_OPTIMIZER_REQUIRED_INDEXES) expect(indexes.has(index), index).toBe(true)
  })

  it('requires authentication', async () => {
    const res = await call('GET', '/api/tools/prompt-optimizer/settings', { user: null })
    expect(res.status).toBe(401)
  })
})

describe('Prompt Optimizer settings and templates', () => {
  it('round-trips settings', async () => {
    const initial = await json<{ data: Record<string, unknown> }>(await call('GET', '/api/tools/prompt-optimizer/settings'))
    expect(initial.data.builtinTemplateLanguage).toBe('zh')
    const updated = await json<{ data: Record<string, unknown> }>(await call('PUT', '/api/tools/prompt-optimizer/settings', {
      body: { builtinTemplateLanguage: 'en', autosaveDrafts: false, testGroupDefault: 4 },
    }))
    expect(updated.data.builtinTemplateLanguage).toBe('en')
    expect(updated.data.autosaveDrafts).toBe(false)
    expect(updated.data.testGroupDefault).toBe(4)
  })

  it('lists builtin templates and creates a user template', async () => {
    const catalogue = await json<{ data: { builtin: { id: string; metadata: { language: string } }[]; user: { id: string }[] } }>(
      await call('GET', '/api/tools/prompt-optimizer/templates'),
    )
    // One edition per id: the catalogue carries both languages, the route answers with the current one.
    expect(catalogue.data.builtin.length).toBe(60)
    expect(new Set(catalogue.data.builtin.map((template) => template.id)).size).toBe(60)
    expect(catalogue.data.builtin.every((template) => template.metadata.language === 'zh')).toBe(true)
    expect(catalogue.data.user).toEqual([])
    const created = await json<{ data: { id: string } }>(await call('POST', '/api/tools/prompt-optimizer/templates', {
      body: { id: 'mine', name: 'Mine', content: 'Improve {{originalPrompt}}', metadata: { version: '1.0.0', lastModified: 0, templateType: 'optimize' } },
    }))
    expect(created.data.id).toBe('mine')
    const after = await json<{ data: { user: { id: string }[] } }>(await call('GET', '/api/tools/prompt-optimizer/templates'))
    expect(after.data.user.map((template) => template.id)).toContain('mine')
  })
})

describe('Prompt Optimizer favorites, variables and sessions', () => {
  it('isolates favorites by account and counts usage', async () => {
    const created = await json<{ data: { id: string } }>(await call('POST', '/api/tools/prompt-optimizer/favorites', {
      body: { title: 'Alpha', content: 'body', description: '', functionMode: 'basic', tags: ['one', 'two'], metadata: {}, examples: [] },
    }))
    const favoriteId = created.data.id
    const list = await json<{ data: { id: string; tags: string[] }[] }>(await call('GET', '/api/tools/prompt-optimizer/favorites'))
    expect(list.data[0]?.tags).toEqual(['one', 'two'])
    const other = await json<{ data: unknown[] }>(await call('GET', '/api/tools/prompt-optimizer/favorites', { user: USER_B }))
    expect(other.data).toEqual([])
    await call('POST', `/api/tools/prompt-optimizer/favorites/${favoriteId}/use`)
    const detail = await json<{ data: { favorite: { useCount: number } } }>(await call('GET', `/api/tools/prompt-optimizer/favorites/${favoriteId}`))
    expect(detail.data.favorite.useCount).toBe(1)
  })

  it('stores variables and rejects an invalid name', async () => {
    const saved = await json<{ data: { name: string } }>(await call('POST', '/api/tools/prompt-optimizer/variables', {
      body: { name: 'theme', value: 'spring', description: '' },
    }))
    expect(saved.data.name).toBe('theme')
    const invalid = await call('POST', '/api/tools/prompt-optimizer/variables', { body: { name: '1bad', value: '' } })
    expect(invalid.status).toBe(400)
  })

  it('detects a session conflict and keeps the newer revision', async () => {
    const first = await json<{ data: { rev: number } }>(await call('PUT', '/api/tools/prompt-optimizer/sessions/basic_system', {
      body: { rev: 0, state: { prompt: 'one' } },
    }))
    expect(first.data.rev).toBe(1)
    const stale = await call('PUT', '/api/tools/prompt-optimizer/sessions/basic_system', {
      body: { rev: 0, state: { prompt: 'stale' } },
    })
    expect(stale.status).toBe(409)
    const fresh = await json<{ data: { rev: number; state: { prompt: string } } }>(await call('PUT', '/api/tools/prompt-optimizer/sessions/basic_system', {
      body: { rev: 1, state: { prompt: 'two' } },
    }))
    expect(fresh.data.rev).toBe(2)
    expect(fresh.data.state.prompt).toBe('two')
  })
})

describe('Prompt Optimizer history', () => {
  it('lists chains, exports and imports them under the caller', async () => {
    const store = new PromptOptimizerStore(env.DB, USER_A)
    await store.createRecord({
      chainId: 'chain-1',
      recordType: 'optimize',
      workspace: 'basic_system',
      originalPrompt: 'raw',
      optimizedPrompt: 'better',
      metadata: {},
    })
    const history = await json<{ data: { chains: { chainId: string }[] } }>(await call('GET', '/api/tools/prompt-optimizer/history'))
    expect(history.data.chains[0]?.chainId).toBe('chain-1')
    const exported = await json<{ data: { text: string } }>(await call('POST', '/api/tools/prompt-optimizer/export?format=json'))
    expect(JSON.parse(exported.data.text).format).toBe('inkstone-prompt-optimizer')
    const imported = await json<{ data: { imported: Record<string, number> } }>(await call('POST', '/api/tools/prompt-optimizer/import', {
      body: JSON.parse(exported.data.text),
    }))
    expect(imported.data.imported.records).toBe(1)
    expect((await call('DELETE', '/api/tools/prompt-optimizer/history/chain-1')).status).toBe(200)
  })
})
