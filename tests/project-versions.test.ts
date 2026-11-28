// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '@shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectCard, ProjectCardVersionDetail } from '../src/shared/project/model'
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
  sqlite.exec(`DELETE FROM project_card_versions; DELETE FROM project_activity_changes; DELETE FROM project_activity;
    DELETE FROM project_comments; DELETE FROM project_card_contents; DELETE FROM project_card_values;
    DELETE FROM project_cards; DELETE FROM project_board_members; DELETE FROM project_boards`)
})

async function req(account: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
}

async function createBoard(cardProperties: unknown[] = []): Promise<ProjectBoard> {
  const response = await req('alice', 'POST', '/boards', { title: 'Versions', cardProperties })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

async function createCard(boardId: string, body: Record<string, unknown>): Promise<ProjectCard> {
  const response = await req('alice', 'POST', `/boards/${boardId}/cards`, body)
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { card: ProjectCard }).card
}

async function createContent(cardId: string, title: string): Promise<{ id: string }> {
  const response = await req('alice', 'POST', `/cards/${cardId}/contents`, { type: 'text', title })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { content: { id: string } }).content
}

async function versions(cardId: string): Promise<Array<{ id: string, createdAt: number }>> {
  const response = await req('alice', 'GET', `/cards/${cardId}/versions`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { versions: Array<{ id: string, createdAt: number }> }).versions
}

async function waitForVersions(cardId: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await versions(cardId)).length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Card versions did not appear')
}

describe('card version history', () => {
  it('restores card fields and content while preserving newer comments', async () => {
    const propertyId = `p${'a'.repeat(26)}`
    const board = await createBoard([{ id: propertyId, name: 'Status', type: 'text', options: [] }])
    const card = await createCard(board.id, { title: 'Original', values: { [propertyId]: 'One' } })
    const originalContent = await createContent(card.id, 'Body original')
    const comment = await req('alice', 'POST', `/cards/${card.id}/comments`, { body: 'Keep me' })
    expect(comment.status).toBe(201)

    expect((await req('alice', 'PATCH', `/cards/${card.id}`, { title: 'Changed', values: { [propertyId]: 'Two' } })).status).toBe(200)
    await createContent(card.id, 'Extra block')
    expect((await req('alice', 'PATCH', `/contents/${originalContent.id}`, { title: 'Body changed' })).status).toBe(200)
    await waitForVersions(card.id, 3)

    const list = await versions(card.id)
    const original = list.at(-2)!
    const detailResponse = await req('alice', 'GET', `/cards/${card.id}/versions/${original.id}`)
    expect(detailResponse.status).toBe(200)
    const detail = ((await detailResponse.json()) as { version: ProjectCardVersionDetail }).version
    expect(detail.snapshot.card.title).toBe('Original')
    expect(detail.snapshot.card.values[propertyId]).toBe('One')
    expect(detail.snapshot.contents.map((content) => content.title)).toEqual(['Body original'])

    const current = ((await (await req('alice', 'GET', `/cards/${card.id}`)).json()) as { card: ProjectCard }).card
    const restored = await req('alice', 'POST', `/cards/${card.id}/versions/${original.id}/restore`, { expectedUpdateAt: current.updateAt })
    expect(restored.status, await restored.clone().text()).toBe(200)
    const restoredCard = ((await restored.json()) as { card: ProjectCard }).card
    expect(restoredCard.title).toBe('Original')
    expect(restoredCard.values[propertyId]).toBe('One')

    const detailAfter = await req('alice', 'GET', `/cards/${card.id}/detail`)
    const after = ((await detailAfter.json()) as { contents: Array<{ title: string }>, comments: Array<{ body: string }> })
    expect(after.contents.map((content) => content.title)).toEqual(['Body original'])
    expect(after.comments.map((item) => item.body)).toContain('Keep me')
    expect(restoredCard.contentOrder.flat()).toContain(originalContent.id)
  })

  it('rejects stale restores and viewer restores', async () => {
    const board = await createBoard()
    const card = await createCard(board.id, { title: 'Before' })
    expect((await req('alice', 'PATCH', `/cards/${card.id}`, { title: 'After' })).status).toBe(200)
    await waitForVersions(card.id, 1)
    const version = (await versions(card.id))[0]!
    const stale = ((await (await req('alice', 'GET', `/cards/${card.id}`)).json()) as { card: ProjectCard }).card
    expect((await req('alice', 'PATCH', `/cards/${card.id}`, { title: 'Newer' })).status).toBe(200)
    const conflict = await req('alice', 'POST', `/cards/${card.id}/versions/${version.id}/restore`, { expectedUpdateAt: stale.updateAt })
    expect(conflict.status).toBe(409)

    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
      .run(board.id, 'bob', 'viewer')
    const beforeViewerWrite = (await versions(card.id)).length
    expect((await req('bob', 'PATCH', `/cards/${card.id}`, { title: 'Forbidden' })).status).toBe(403)
    expect((await versions(card.id)).length).toBe(beforeViewerWrite)
    expect((await req('bob', 'GET', `/cards/${card.id}/versions`)).status).toBe(200)
    expect((await req('bob', 'POST', `/cards/${card.id}/versions/${version.id}/restore`, { expectedUpdateAt: stale.updateAt })).status).toBe(403)
  })
})
