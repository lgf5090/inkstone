// @vitest-environment node
/**
 * The panel's three tables, scoped by the reader.
 *
 * What matters is that a change is a change of behaviour: the settings row is read back with the defaults
 * applied, an address belongs to one account, and the history counts every run rather than the page
 * being drawn.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { TOOLS_NETWORK_PANEL_SCHEMA_STATEMENTS } from '../src/worker/tools/network-panel/schema'
import { NetworkPanelStore } from '../src/worker/tools/network-panel/store'
import { NETWORK_PANEL_LIMITS } from '../src/shared/tools/network-panel/types'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'u1'
const OTHER = 'u2'

let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of TOOLS_NETWORK_PANEL_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
})

describe('network panel settings', () => {
  it('reads the shipped defaults before anything was saved', async () => {
    const settings = await new NetworkPanelStore(db, USER).getSettings()
    expect(settings).toMatchObject({
      threads: 8,
      autoStart: false,
      background: false,
      showChart: true,
      saveHistory: true,
      autoRefreshInfo: true,
      maxDataBytes: 0,
      maxSpeedBps: 0,
      nodeId: 'builtin',
    })
  })

  it('merges a one-field patch and keeps the other fields', async () => {
    const store = new NetworkPanelStore(db, USER)
    const afterThreads = await store.saveSettings({ threads: 32 })
    expect(afterThreads.threads).toBe(32)
    expect(afterThreads.showChart).toBe(true)
    const afterCap = await store.saveSettings({ maxDataBytes: 1024 ** 3, background: true })
    expect(afterCap).toMatchObject({ threads: 32, maxDataBytes: 1024 ** 3, background: true })
    expect((await store.getSettings()).maxDataBytes).toBe(1024 ** 3)
  })

  it('keeps two accounts apart', async () => {
    const alice = new NetworkPanelStore(db, USER)
    const bob = new NetworkPanelStore(db, OTHER)
    await alice.saveSettings({ threads: 64 })
    expect((await bob.getSettings()).threads).toBe(8)
    await bob.saveSettings({ threads: 2 })
    expect((await alice.getSettings()).threads).toBe(64)
  })
})

describe('network panel addresses', () => {
  it('lists newest first and deletes only its owner\'s rows', async () => {
    const store = new NetworkPanelStore(db, USER)
    const first = await store.createNode({ id: 'n1', label: 'First', url: '/api/tools/network-panel/download' })
    const second = await store.createNode({ id: 'n2', label: 'Second', url: 'https://example.com/file' })
    const nodes = await store.listNodes()
    expect(nodes).toHaveLength(2)
    expect(nodes[0]!.id).toBe(second.id)
    expect(first.label).toBe('First')
    expect(await store.deleteNode('n1')).toBe(true)
    expect(await store.deleteNode('n1')).toBe(false)
    expect(await new NetworkPanelStore(db, OTHER).deleteNode('n2')).toBe(false)
  })

  it('refuses a list past the documented ceiling', async () => {
    const store = new NetworkPanelStore(db, USER)
    for (let index = 0; index < NETWORK_PANEL_LIMITS.maxNodes; index += 1) {
      await store.createNode({ id: `n${index}`, label: `Address ${index}`, url: '/x' })
    }
    await expect(store.createNode({ id: 'extra', label: 'Extra', url: '/x' })).rejects.toThrow('node_limit')
  })
})

describe('network panel history', () => {
  const run = (bytes: number, speed: number) => ({
    node_label: 'This deployment',
    node_url: '/api/tools/network-panel/download',
    bytes_used: bytes,
    avg_speed_bps: speed,
    duration_ms: 2_000,
    threads: 8,
    stop_reason: 'manual' as const,
  })

  it('records a run and counts every one in the summary', async () => {
    const store = new NetworkPanelStore(db, USER)
    const recorded = await store.recordRun(run(1000, 500))
    expect(recorded.id).toMatch(/[A-Za-z0-9_-]{8,}/)
    await store.recordRun(run(3_000, 1500))
    const history = await store.listRuns(10, 0)
    expect(history.total).toBe(2)
    expect(history.items).toHaveLength(2)
    expect(history.summary.count).toBe(2)
    expect(history.summary.bytes).toBe(4_000)
    expect(history.summary.best_speed_bps).toBe(1500)
    expect(history.summary.avg_speed_bps).toBe(1000)
  })

  it('pages without losing the total', async () => {
    const store = new NetworkPanelStore(db, USER)
    for (let index = 0; index < 5; index += 1) await store.recordRun(run(index, index))
    const page = await store.listRuns(2, 2)
    expect(page.items).toHaveLength(2)
    expect(page.total).toBe(5)
  })

  it('deletes one row, clears the rest, and never touches another account', async () => {
    const store = new NetworkPanelStore(db, USER)
    const other = new NetworkPanelStore(db, OTHER)
    const aliceRun = await store.recordRun(run(2000, 800))
    await other.recordRun(run(4000, 900))
    expect(await store.deleteRun(aliceRun.id)).toBe(true)
    expect((await other.listRuns(10, 0)).total).toBe(1)
    await other.recordRun(run(100, 60))
    expect(await other.clearRuns()).toBe(2)
    expect((await store.listRuns(10, 0)).total).toBe(0)
    expect(await other.clearRuns()).toBe(0)
  })

  it('prunes a ledger older than the retention window', async () => {
    const store = new NetworkPanelStore(db, USER)
    for (let index = 0; index < NETWORK_PANEL_LIMITS.runRetention + 5; index += 1) {
      await store.recordRun(run(index, index))
    }
    const history = await store.listRuns(NETWORK_PANEL_LIMITS.runPageMax, 0)
    expect(history.total).toBe(NETWORK_PANEL_LIMITS.runRetention)
  })
})
