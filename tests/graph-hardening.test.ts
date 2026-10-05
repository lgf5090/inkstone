// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/worker/env'
import { initializeDatabase } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

async function freshDatabase() {
  const sqlite = new DatabaseSync(':memory:')
  const db = makeD1(sqlite)
  await initializeDatabase({ DB: db } as unknown as Env)
  return sqlite
}

describe('graph storage and route hardening', () => {
  it('migration produces the source-direction index the graph edge fetch needs', async () => {
    const sqlite = await freshDatabase()
    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'links'")
      .all()
      .map((row) => String(row.name))
    expect(indexes).toContain('idx_links_user_source')
  })

  it('the edge fetch seeks on (user_id, source_note_id) rather than scanning the owner', async () => {
    const sqlite = await freshDatabase()
    const ids = Array.from({ length: 40 }, (_, index) => `note-${index}`)
    const placeholders = ids.map(() => '?').join(',')
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN SELECT source_note_id, target_note_id FROM links
        WHERE user_id = ? AND source_note_id IN (${placeholders})
          AND (target_note_id IN (${placeholders}) OR target_note_id IS NULL)
        ORDER BY source_note_id ASC, target_key ASC LIMIT ?`)
      .all('user-1', ...ids, ...ids, 10001)
      .map((row) => String(row.detail))
      .join(' | ')
    expect(plan).toContain('idx_links_user_source (user_id=? AND source_note_id=?)')
    expect(plan).not.toMatch(/idx_links_user_target \(user_id=\?\)\s/)
  })

  it('degree counts only links whose both ends are visible notes', () => {
    const route = read('../src/worker/routes/search.ts')
    const edges = /link_edges AS \(([\s\S]*?)\),/.exec(route)?.[1] ?? ''
    expect(edges).toContain('JOIN notes src')
    expect(edges).toContain('JOIN notes dst')
    expect(edges.match(/deleted_at IS NULL/g)?.length).toBeGreaterThanOrEqual(2)
    expect(edges.match(/is_archived = 0/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('the graph endpoint consumes a per-user request budget', () => {
    const route = read('../src/worker/routes/search.ts')
    const handler = route.slice(route.indexOf("searchRoutes.get('/graph'"), route.indexOf('searchRoutes.post'))
    expect(handler).toContain('consumeAttemptBudget')
    expect(handler).toContain('key: `graph:${userId}`')
    expect(handler).toContain('too_many_attempts')
  })

  it('the orphan filter splits its OR so each side can use its own index', () => {
    const route = read('../src/worker/routes/search.ts')
    const orphans = /if \(!includeOrphans\) \{\s*filters\.push\(`([\s\S]*?)`\)/.exec(route)?.[1] ?? ''
    expect(orphans).toContain('outgoing.source_note_id = n.id')
    expect(orphans).toContain('incoming.target_note_id = n.id')
    expect(orphans).not.toMatch(/source_note_id = n\.id\s+OR\s+\w+\.target_note_id = n\.id/)
  })

  it('graph controls come from the shared form primitives', () => {
    const panel = read('../src/client/features/graph/GraphPanel.tsx')
    expect(panel).toContain("from '../../components/form'")
    expect(panel).toContain('<Drawer')
    expect(panel).toMatch(/<Segmented[\s\S]*graph\.scope/)
    expect(panel).not.toMatch(/<select\b/)
    expect(panel).not.toMatch(/<input type="checkbox"/)
    expect(panel).not.toMatch(/<input type="range"/)
    expect(panel).not.toMatch(/shadow-\[-/)
  })
})
