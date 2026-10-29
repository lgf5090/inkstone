// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { InknoteTemplate } from '../src/shared/inknote/types'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { inknoteSettingsRoutes } from '../src/worker/routes/inknote-settings'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket } from './doubles/bindings'

const ALICE = '0123456789abcdefghjkmnpqrs'
const BOB = '0123456789abcdefghjkmnpqrt'

const mocks = { userId: ALICE }

function id(value: number): string {
  return String(value).padStart(26, '0')
}

let sqlite: DatabaseSync
let env: Env
let app: Hono<AppBindings>

function insertAsset(userId: string, assetId: string, kind: string): void {
  sqlite.prepare(
    `INSERT INTO inknote_assets (
       user_id, id, note_id, page_id, kind, filename, mime, size, sha256,
       object_key, width, height, storage, created_at
     ) VALUES (?, ?, NULL, NULL, ?, 'bg.png', 'image/png', 10, 'hash', ?, 1, 1, 'r2', 1)`,
  ).run(userId, assetId, kind, `inknote/templates/${userId}/${assetId}.png`)
}

function insertTemplateRow(userId: string, templateId: string, name: string): void {
  sqlite.prepare(
    `INSERT INTO inknote_templates (
       user_id, id, name, paper_style, paper_color, paper_spacing, bg_asset_id, texts,
       title, sub, title_size, sub_size, created_at, updated_at
     ) VALUES (?, ?, ?, 'line', 'white', 'normal', NULL, '[]', '', '', 32, 15, 1, 1)`,
  ).run(userId, templateId, name)
}

function count(sql: string, ...values: string[]): number {
  return Number((sqlite.prepare(sql).get(...values) as { n: number }).n)
}

async function send(
  method: string,
  path: string,
  body?: unknown,
  userId = ALICE,
): Promise<Response> {
  mocks.userId = userId
  return await app.request(
    `/api/inknote${path}`,
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  )
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

const TEXT = {
  id: 't1',
  x: 0.1,
  y: 0.1,
  w: 0.5,
  h: 0.1,
  text: 'Hello',
  fontSize: 26,
  color: '#1e293b',
  align: 'left',
  bold: false,
  italic: false,
  underline: false,
  hl: null,
  lh: 1.3,
  list: null,
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite), { FILES: testR2Bucket() })
  mocks.userId = ALICE
  app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('/api/inknote/*', async (c, next) => {
    c.set('userId', mocks.userId)
    await next()
  })
  app.route('/api/inknote', inknoteSettingsRoutes)
})

describe('user templates', () => {
  it('creates, lists and renames a template with sanitized paper and texts', async () => {
    const assetId = id(40)
    insertAsset(ALICE, assetId, 'template')

    const created = await send('POST', '/templates', {
      name: '  My template  ',
      paper: { style: 'grid', color: 'cream', spacing: 'wide' },
      bgAssetId: assetId,
      texts: [TEXT, { ...TEXT, id: 'bad', color: 'rgb(0,0,0)' }],
      title: 'Title',
      sub: 'Sub',
    })
    expect(created.status).toBe(201)
    const template = await json<InknoteTemplate>(created)
    expect(template).toMatchObject({
      name: 'My template',
      paper: { style: 'grid', color: 'cream', spacing: 'wide' },
      bgAssetId: assetId,
      bgUrl: `/api/inknote/assets/${assetId}`,
      title: 'Title',
      sub: 'Sub',
      builtIn: false,
    })
    expect(template.texts).toHaveLength(1)
    expect(template.texts[0]!.text).toBe('Hello')

    const listed = await json<{ templates: InknoteTemplate[] }>(await send('GET', '/templates'))
    expect(listed.templates.map((entry) => entry.id)).toEqual([template.id])

    const renamed = await send('PATCH', `/templates/${template.id}`, { name: 'Renamed' })
    expect(renamed.status).toBe(200)
    expect((await json<InknoteTemplate>(renamed)).name).toBe('Renamed')
    expect((await send('PATCH', `/templates/${id(99)}`, { name: 'Missing' })).status).toBe(404)
  })

  it('requires a name and accepts only a background asset owned by the caller', async () => {
    insertAsset(BOB, id(41), 'template')
    insertAsset(ALICE, id(42), 'image')
    insertAsset(ALICE, id(43), 'background')

    expect((await send('POST', '/templates', {})).status).toBe(400)
    expect((await send('POST', '/templates', {
      name: ' '.repeat(3),
    })).status).toBe(400)
    expect((await send('POST', '/templates', {
      name: 'Foreign',
      bgAssetId: id(41),
    })).status).toBe(400)
    expect((await send('POST', '/templates', {
      name: 'Wrong kind',
      bgAssetId: id(42),
    })).status).toBe(400)
    expect((await send('POST', '/templates', {
      name: 'Owned',
      bgAssetId: id(43),
    })).status).toBe(201)
  })

  it('enforces the 200-template ceiling', async () => {
    for (let index = 0; index < 200; index++) insertTemplateRow(ALICE, id(100 + index), `T${index}`)
    const response = await send('POST', '/templates', { name: 'One more' })
    expect(response.status).toBe(400)
    expect(count('SELECT COUNT(*) AS n FROM inknote_templates WHERE user_id = ?', ALICE)).toBe(200)
  })

  it('keeps a shared background when one template is deleted and drops it with the last', async () => {
    const assetId = id(44)
    insertAsset(ALICE, assetId, 'template')
    const first = await json<InknoteTemplate>(await send('POST', '/templates', {
      name: 'First',
      bgAssetId: assetId,
    }))
    const second = await json<InknoteTemplate>(await send('POST', '/templates', {
      name: 'Second',
      bgAssetId: assetId,
    }))

    expect((await send('DELETE', `/templates/${first.id}`)).status).toBe(200)
    expect(count(
      'SELECT COUNT(*) AS n FROM inknote_assets WHERE user_id = ? AND id = ?',
      ALICE,
      assetId,
    )).toBe(1)

    expect((await send('DELETE', `/templates/${second.id}`)).status).toBe(200)
    expect(count(
      'SELECT COUNT(*) AS n FROM inknote_assets WHERE user_id = ? AND id = ?',
      ALICE,
      assetId,
    )).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM inknote_templates WHERE user_id = ?', ALICE)).toBe(0)
    expect((await send('DELETE', `/templates/${id(99)}`)).status).toBe(404)
  })
})
