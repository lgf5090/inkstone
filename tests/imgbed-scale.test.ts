import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { makeD1 } from './doubles/d1-sqlite'
import { IMGBED_SCHEMA_STATEMENTS } from '../src/worker/imgbed/schema'
import { getSidebarData, listFiles } from '../src/worker/imgbed/store'

describe('imgbed scale smoke', () => {
  it('keeps a 10k-file list and sidebar bounded', async () => {
    const sqlite = new DatabaseSync(':memory:')
    for (const statement of IMGBED_SCHEMA_STATEMENTS) sqlite.exec(statement)
    const insert = sqlite.prepare(
      `INSERT INTO imgbed_files (id, object_key, file_name, file_type, file_size_bytes, directory, source, channel, channel_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    sqlite.exec('BEGIN')
    for (let index = 0; index < 10_000; index++) {
      const directory = `d${index % 100}/`
      insert.run(`${directory}file${index}.png`, `key-${index}`, `file${index}.png`, 'image/png', 1024, directory, 'cfr2', 'CloudflareR2', 'R2', index, index)
    }
    sqlite.exec('COMMIT')
    const db = makeD1(sqlite)

    const started = performance.now()
    const page = await listFiles(db, { dir: '', count: 30, recursive: true, skipDirectories: true })
    const sidebar = await getSidebarData(db, { timezoneOffset: 0, days: 30 })
    const elapsed = performance.now() - started
    expect(page.totalCount).toBe(10_000)
    expect(page.files).toHaveLength(30)
    expect(page.directories).toEqual([])
    expect(sidebar.counts.all).toBe(10_000)
    console.info(`[imgbed-scale] 10k list+sidebar in ${elapsed.toFixed(1)}ms`)
  })
})
