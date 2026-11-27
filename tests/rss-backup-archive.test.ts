// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { BACKUP_RSS_NAME, parseMarkdownBackupManifest } from '../src/shared/backup-format'
import { emptyLibrary, newFeed } from '../src/shared/rss/model'
import { parseRssBackup } from '../src/shared/rss/backup'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { buildSnapshot, materializeSnapshot } from '../src/worker/backup/snapshot'
import { saveServerRssArticles, storeRssLibrary } from '../src/worker/lib/rss-store'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import { sha256Hex } from '../src/worker/lib/encoding'

const USER = 'rss-backup-user'
let sqlite: DatabaseSync
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, role, settings, created_at, last_seen_at)
    VALUES (?, 'rss', 'h', 'rss', 'RSS', 'member', '{}', 1, 1)`).run(USER)
  env = testBindings(makeD1(sqlite))
})

describe('RSS in full account archives', () => {
  it('writes a versioned metadata backup and pins it in the manifest', async () => {
    const library = emptyLibrary()
    library.feeds.push(newFeed('f1', 'https://example.com/feed', 'Example', 0))
    await storeRssLibrary(env.DB, USER, library, 1)
    await saveServerRssArticles(env.DB, USER, 'f1', [{
      id: 'e1', feedId: 'f1', title: 'One', link: 'https://example.com/1', author: '',
      publishedTs: 1, summary: 'Summary', content: 'Body', imageUrl: '', audioUrl: '',
    }], 2)
    const snapshot = await buildSnapshot(env, USER)
    const files = await materializeSnapshot(snapshot)
    const rss = files.find(file => file.path === BACKUP_RSS_NAME)
    const manifestFile = files.find(file => file.path === 'manifest.json')
    expect(rss).toBeDefined()
    const backup = parseRssBackup(new TextDecoder().decode(rss!.body))
    expect(backup?.library.feeds.map(feed => feed.id)).toEqual(['f1'])
    expect(backup?.articles[0]).toMatchObject({ id: 'e1', summary: 'Summary', content: '' })
    expect(backup?.includesContent).toBe(false)
    const manifest = parseMarkdownBackupManifest(JSON.parse(new TextDecoder().decode(manifestFile!.body)))
    expect(manifest?.rss).toMatchObject({ path: BACKUP_RSS_NAME, bytes: rss!.body.byteLength, sha256: await sha256Hex(rss!.body) })
  })

  it('omits the RSS file when the account has no library', async () => {
    const files = await materializeSnapshot(await buildSnapshot(env, USER))
    expect(files.some(file => file.path === BACKUP_RSS_NAME)).toBe(false)
  })
})
