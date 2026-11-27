// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '@shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectBoardBundle, ProjectShare } from '@shared/project/model'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const app = createApp()
const tokens = new Map<string, string>()
let sqlite: DatabaseSync
let env: Env

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  for (const account of ['alice', 'bob']) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, ?, 'member', ?, ?)`,
    ).run(account, account, account, account, now, now)
    tokens.set(account, await createSession(env.DB, account))
  }
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM project_write_receipts; DELETE FROM project_activity_changes; DELETE FROM project_activity;
    DELETE FROM project_shares; DELETE FROM project_comments; DELETE FROM project_card_contents; DELETE FROM project_card_values;
    DELETE FROM project_cards; DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards`)
})

async function memberReq(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get('alice')}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
}

async function publicReq(method: string, path: string, body?: unknown, key?: string): Promise<Response> {
  const headers: Record<string, string> = { [CLIENT_HEADER]: '1' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (key) headers['Idempotency-Key'] = key
  return app.fetch(new Request(`http://localhost/api/project/public${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
}

async function createBoard(): Promise<ProjectBoard> {
  const response = await memberReq('POST', '/boards', {
    title: 'Intake',
    cardProperties: [
      { id: `p${'a'.repeat(26)}`, name: 'Details', type: 'text', options: [] },
      { id: `p${'b'.repeat(26)}`, name: 'Count', type: 'number', options: [] },
      { id: `p${'c'.repeat(26)}`, name: 'Owner', type: 'person', options: [] },
    ],
  })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

async function shareBoard(boardId: string, intake: ProjectShare['intake'], extra: Record<string, unknown> = {}): Promise<ProjectShare> {
  const response = await memberReq('PUT', `/boards/${boardId}/share`, { intake, ...extra })
  expect(response.status, await response.clone().text()).toBe(200)
  return ((await response.json()) as { share: ProjectShare }).share
}

const textId = `p${'a'.repeat(26)}`
const numberId = `p${'b'.repeat(26)}`
const personId = `p${'c'.repeat(26)}`
const intake = { enabled: true, title: 'Request', propertyIds: [textId, numberId], requiredPropertyIds: [textId] }

describe('public form intake', () => {
  it('creates a card, replays idempotently and exposes only configured form fields', async () => {
    const board = await createBoard()
    const share = await shareBoard(board.id, intake)
    const before = await memberReq('GET', `/boards/${board.id}/cursor`)
    const cursorBefore = ((await before.json()) as { cursor: number }).cursor
    const submitted = await publicReq('POST', `/${share.slug}/intake`, { title: 'New request', values: { [textId]: 'Details', [numberId]: '3' } }, 'intake-key-1')
    expect(submitted.status, await submitted.clone().text()).toBe(201)
    const first = (await submitted.json()) as { ok: boolean, cardId: string }
    const replay = await publicReq('POST', `/${share.slug}/intake`, { title: 'New request', values: { [textId]: 'Details', [numberId]: '3' } }, 'intake-key-1')
    expect(replay.status).toBe(201)
    expect(((await replay.json()) as { cardId: string }).cardId).toBe(first.cardId)
    const conflict = await publicReq('POST', `/${share.slug}/intake`, { title: 'Different', values: { [textId]: 'Details' } }, 'intake-key-1')
    expect(conflict.status).toBe(409)

    const bundleResponse = await publicReq('POST', `/${share.slug}`, {})
    const bundle = (await bundleResponse.json()) as ProjectBoardBundle
    expect(bundle.intake).toEqual(intake)
    expect(bundle.cards.find((card) => card.id === first.cardId)).toMatchObject({ title: 'New request', createdBy: 'public:intake', values: { [textId]: 'Details', [numberId]: '3' } })
    const after = await memberReq('GET', `/boards/${board.id}/cursor`)
    expect(((await after.json()) as { cursor: number }).cursor).toBeGreaterThan(cursorBefore)
    const activity = sqlite.prepare('SELECT actor_id FROM project_activity WHERE board_id = ? ORDER BY created_at DESC LIMIT 1').get(board.id) as { actor_id: string }
    expect(activity.actor_id).toBe('public:intake')
    const changes = sqlite.prepare('SELECT field_key, new_value FROM project_activity_changes WHERE board_id = ?').all(board.id) as Array<{ field_key: string, new_value: string | null }>
    expect(changes).toEqual([{ field_key: 'created', new_value: 'true' }])
    const shareRow = sqlite.prepare('SELECT views FROM project_shares WHERE slug = ?').get(share.slug) as { views: number }
    expect(shareRow.views).toBe(1)
  })

  it('rejects missing, unknown, unsafe and disabled fields', async () => {
    const board = await createBoard()
    const share = await shareBoard(board.id, intake)
    expect((await publicReq('POST', `/${share.slug}/intake`, { title: 'Missing', values: {} }, 'intake-key-2')).status).toBe(400)
    expect((await publicReq('POST', `/${share.slug}/intake`, { title: 'Unknown', values: { [textId]: 'ok', [personId]: 'bob' } }, 'intake-key-3')).status).toBe(400)
    expect((await publicReq('POST', `/${share.slug}/intake`, { title: 'Unknown', values: { [textId]: 'ok', [`p${'z'.repeat(26)}`]: 'x' } }, 'intake-key-4')).status).toBe(400)
    const unsafe = await shareBoard(board.id, { ...intake, propertyIds: [textId, personId] })
    expect((await publicReq('POST', `/${unsafe.slug}/intake`, { title: 'Unsafe', values: { [textId]: 'ok' } }, 'intake-key-5')).status).toBe(400)
    const disabled = await shareBoard(board.id, { ...intake, enabled: false })
    expect((await publicReq('POST', `/${disabled.slug}/intake`, { title: 'Disabled', values: { [textId]: 'ok' } }, 'intake-key-6')).status).toBe(404)
  })

  it('enforces passcode, expiry, archive and revocation before create or replay', async () => {
    const board = await createBoard()
    const protectedShare = await shareBoard(board.id, intake, { password: 'secret-pass' })
    expect((await publicReq('POST', `/${protectedShare.slug}/intake`, { title: 'Locked', values: { [textId]: 'ok' } }, 'intake-key-7')).status).toBe(401)
    expect((await publicReq('POST', `/${protectedShare.slug}/intake`, { password: 'wrong', title: 'Locked', values: { [textId]: 'ok' } }, 'intake-key-8')).status).toBe(401)
    const created = await publicReq('POST', `/${protectedShare.slug}/intake`, { password: 'secret-pass', title: 'Allowed', values: { [textId]: 'ok' } }, 'intake-key-9')
    expect(created.status).toBe(201)

    const expired = await shareBoard(board.id, intake, { expiresAt: Date.now() - 1 })
    expect((await publicReq('POST', `/${expired.slug}/intake`, { title: 'Expired', values: { [textId]: 'ok' } }, 'intake-key-10')).status).toBe(404)
    expect((await memberReq('PATCH', `/boards/${board.id}`, { archived: true })).status).toBe(200)
    expect((await publicReq('POST', `/${expired.slug}/intake`, { title: 'Archived', values: { [textId]: 'ok' } }, 'intake-key-11')).status).toBe(404)
    await memberReq('PATCH', `/boards/${board.id}`, { archived: false })
    await memberReq('DELETE', `/boards/${board.id}/share`)
    expect((await publicReq('POST', `/${expired.slug}/intake`, { title: 'Revoked', values: { [textId]: 'ok' } }, 'intake-key-9')).status).toBe(404)
  })
})
