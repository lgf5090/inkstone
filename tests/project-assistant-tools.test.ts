// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import { PROJECT_WRITE_TOOL_NAMES } from '../src/shared/project/assistant-tools'
import type { ProjectBoard, ProjectCard } from '../src/shared/project/model'
import type { Env } from '../src/worker/env'
import { PROJECT_BOARD_TOOLS, PROJECT_WRITE_TOOLS } from '../src/worker/assistant/project-tools'
import { ToolError, type ToolContext } from '../src/worker/assistant/tools'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const app = createApp()
let sqlite: DatabaseSync
let env: Env
let token: string
let bobToken: string

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  for (const account of ['alice', 'bob']) {
    sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at) VALUES (?,?,'hash',?,?, 'member',?,?)`).run(account, account, account, account, now, now)
  }
  token = await createSession(env.DB, 'alice')
  bobToken = await createSession(env.DB, 'bob')
})

beforeEach(() => {
  sqlite.exec('DELETE FROM project_card_values; DELETE FROM project_cards; DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards')
})

async function req(method: string, path: string, body?: unknown, who = token): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${who}`, [CLIENT_HEADER]: '1' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function makeBoard(): Promise<ProjectBoard> {
  return ((await (await req('POST', '/boards', { title: 'Tool board' })).json()) as { board: ProjectBoard }).board
}

function ctxFor(userId: string): ToolContext {
  return { env, store: { userId } as ToolContext['store'] } as ToolContext
}

function toolNamed(name: string) {
  const found = PROJECT_BOARD_TOOLS.find((tool) => tool.name === name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

async function runTool(name: string, args: Record<string, unknown>, userId = 'alice'): Promise<unknown> {
  const tool = toolNamed(name)
  if (tool.permission === 'destructive') throw new Error('use prepare/commit for destructive tools')
  return tool.run(args, ctxFor(userId))
}

describe('the project tool surface (R3-28)', () => {
  it('offers read and write tools and keeps the refresh list in step with them', () => {
    expect(PROJECT_BOARD_TOOLS.length).toBeGreaterThanOrEqual(6)
    expect([...PROJECT_WRITE_TOOLS].sort()).toEqual([...PROJECT_WRITE_TOOL_NAMES].sort())
  })

  it('lists only the boards the calling account can see', async () => {
    await makeBoard()
    const mine = await runTool('project_list_boards', {}) as { boards: { id: string }[] }
    const theirs = await runTool('project_list_boards', {}, 'bob') as { boards: { id: string }[] }
    expect(mine.boards).toHaveLength(1)
    expect(theirs.boards).toHaveLength(0)
  })

  it('refuses a board the account cannot see without confirming it exists', async () => {
    const board = await makeBoard()
    await expect(runTool('project_list_cards', { boardId: board.id }, 'bob')).rejects.toThrow(ToolError)
    await expect(runTool('project_create_card', { boardId: board.id, title: 'Nope' }, 'bob')).rejects.toThrow(/does not exist or is not visible/)
  })

  it('creates a card and reads it back through the list tool', async () => {
    const board = await makeBoard()
    const created = await runTool('project_create_card', { boardId: board.id, title: 'From the assistant' }) as { created: { id: string, title: string } }
    expect(created.created.title).toBe('From the assistant')
    const listed = await runTool('project_list_cards', { boardId: board.id }) as { cards: { id: string }[] }
    expect(listed.cards.map((card) => card.id)).toContain(created.created.id)
  })

  it('refuses a write from a viewer', async () => {
    const board = await makeBoard()
    await req('POST', `/boards/${board.id}/members`, { userId: 'bob', role: 'viewer' })
    await expect(runTool('project_create_card', { boardId: board.id, title: 'Nope' }, 'bob')).rejects.toThrow(/viewer on that board; editor is required/)
  })

  it('schedules a card through the shared day conversion and rejects an impossible day', async () => {
    const board = await makeBoard()
    sqlite.prepare(`INSERT INTO project_properties (board_id, id, name, type, options, position, created_at, updated_at) VALUES (?, 'pd', 'Due', 'date', '[]', 0, 1, 1)`).run(board.id)
    const created = await runTool('project_create_card', { boardId: board.id, title: 'Dated' }) as { created: { id: string } }
    const scheduled = await runTool('project_schedule_card', { cardId: created.created.id, propertyId: 'pd', from: '2026-11-15', to: '2026-11-18' }) as { updated: { values: Record<string, string> } }
    expect(JSON.parse(scheduled.updated.values.pd!)).toMatchObject({ from: expect.any(Number), to: expect.any(Number) })
    await expect(runTool('project_schedule_card', { cardId: created.created.id, propertyId: 'pd', from: '2026-02-30' })).rejects.toThrow(/real calendar day/)
  })

  it('soft-deletes through prepare and commit so the approval names the card', async () => {
    const board = await makeBoard()
    const created = ((await (await req('POST', `/boards/${board.id}/cards`, { title: 'Doomed' })).json()) as { card: ProjectCard }).card
    const tool = toolNamed('project_delete_card')
    if (tool.permission !== 'destructive') throw new Error('delete must stay destructive')
    const target = await tool.prepare({ cardId: created.id }, ctxFor('alice'))
    expect(target).toEqual({ targetId: created.id, targetLabel: 'Doomed' })
    await tool.commit(target.targetId, ctxFor('alice'), {})
    const listed = await runTool('project_list_cards', { boardId: board.id }) as { cards: { id: string }[] }
    expect(listed.cards.map((card) => card.id)).not.toContain(created.id)
  })

  it('will not file a subtask under a card on another board', async () => {
    const board = await makeBoard()
    const other = ((await (await req('POST', '/boards', { title: 'Other' })).json()) as { board: ProjectBoard }).board
    const parent = ((await (await req('POST', `/boards/${other.id}/cards`, { title: 'Elsewhere' })).json()) as { card: ProjectCard }).card
    await expect(runTool('project_create_card', { boardId: board.id, title: 'Child', parentId: parent.id })).rejects.toThrow(/parent card is not on this board/)
  })
})