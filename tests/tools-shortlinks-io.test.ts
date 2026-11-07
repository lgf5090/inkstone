// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseShortlinkImport } from '../src/shared/tools/shortlinks/import-parse'
import { TOOLS_SHORTLINKS_SCHEMA_STATEMENTS } from '../src/worker/tools/shortlinks/schema'
import { ShortlinksStore } from '../src/worker/tools/shortlinks/store'
import { testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-io'

describe('Shortlinks import parsing', () => {
  it('parses the module own CSV export by header instead of cell position', () => {
    const parsed = parseShortlinkImport(
      [
        'id,primary_slug,url,label,password_protected,total_clicks,created_at',
        '1,io-a,https://example.com/a,"Docs, English",1,7,1700000000',
      ].join('\n'),
      'csv',
    )
    expect(parsed.issues).toHaveLength(0)
    expect(parsed.items).toEqual([{ url: 'https://example.com/a', slug: 'io-a', label: 'Docs, English' }])
  })

  it('parses both the plain and protected TXT export shapes', () => {
    const parsed = parseShortlinkImport(
      ['[io-a] -> https://example.com/a (Docs)', '[Protected] [io-b] -> https://example.com/b'].join('\n'),
      'txt',
    )
    expect(parsed.items).toEqual([
      { slug: 'io-a', url: 'https://example.com/a', label: 'Docs' },
      { slug: 'io-b', url: 'https://example.com/b', label: undefined },
    ])
  })

  it('reports the skipped rows with their line numbers', () => {
    const parsed = parseShortlinkImport(
      ['url,custom_slug,label', 'not-a-url,x,Bad', 'https://example.com/ok,ok,Good'].join('\n'),
      'csv',
    )
    expect(parsed.items).toHaveLength(1)
    expect(parsed.issues[0]).toMatchObject({ line: 2, reason: 'invalid_url' })
  })
})

describe('Shortlinks backup round trip', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof makeD1>
  let bucket: ReturnType<typeof testR2Bucket>
  let store: ShortlinksStore

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    for (const statement of TOOLS_SHORTLINKS_SCHEMA_STATEMENTS) sqlite.exec(statement)
    db = makeD1(sqlite)
    bucket = testR2Bucket()
    store = new ShortlinksStore(db, USER)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('exports JSON with slugs, bundles and password hashes, then restores all of it', async () => {
    const created = await store.createLink({
      url: 'https://example.com/round-trip',
      label: 'Round trip',
      password: 'correct-password',
      custom_slug: 'io-main',
    })
    const hashBefore = (sqlite
      .prepare('SELECT password_hash FROM tools_shortlinks_links WHERE id = ?')
      .get(created.id) as { password_hash: string }).password_hash
    await store.addSlug(created.id, 'io-alias')
    const settingsBefore = await store.updateSettings({
      slug_default_length: 8,
      default_range: '90d',
      filter_bots: false,
    })

    const bundle = await store.createBundle({ name: 'IO Bundle', accent: 'green', description: 'round trip' })
    await store.addBundleLinks(bundle.id, [created.id])

    const exportFile = await store.exportData('json', bucket)
    const exported = JSON.parse(await (await bucket.get(exportFile.key))!.text()) as {
      links: Array<{ password_hash?: string | null }>
      bundles: Array<{ link_ids?: number[] }>
    }
    expect(exported.links[0].password_hash).toBe(hashBefore)
    expect(exported.bundles[0].link_ids).toEqual([created.id])

    const backup = await store.createBackup(bucket)
    expect(backup.link_count).toBe(1)
    const listed = await store.listBackups(bucket)
    expect(listed[0].link_count).toBe(1)

    sqlite.exec(`
      DELETE FROM tools_shortlinks_bundle_links WHERE user_id = '${USER}';
      DELETE FROM tools_shortlinks_bundles WHERE user_id = '${USER}';
      DELETE FROM tools_shortlinks_links WHERE user_id = '${USER}';
      DELETE FROM tools_shortlinks_slugs WHERE user_id = '${USER}';
      DELETE FROM tools_shortlinks_settings WHERE user_id = '${USER}';
    `)

    const restored = await store.restoreBackup(String(backup.id), bucket)
    expect(restored.imported).toBe(1)
    expect(restored.restored.settings).toBe(true)
    expect(restored.restored.slugs).toBe(2)

    const link = await store.getLinkById(Number((sqlite
      .prepare(`SELECT id FROM tools_shortlinks_links WHERE user_id = '${USER}'`)
      .get() as { id: number }).id))
    expect(link?.password_protected).toBe(true)
    expect(link?.slugs.map((slug) => slug.slug).sort()).toEqual(['io-alias', 'io-main'])

    const hashAfter = (sqlite
      .prepare(`SELECT password_hash FROM tools_shortlinks_links WHERE user_id = '${USER}'`)
      .get() as { password_hash: string }).password_hash
    expect(hashAfter).toBe(hashBefore)

    const settingsAfter = await store.getSettings()
    expect(settingsAfter.slug_default_length).toBe(8)
    expect(settingsAfter.default_range).toBe('90d')
    expect(settingsAfter.filter_bots).toBe(false)

    const bundlesAfter = await store.listBundles()
    expect(bundlesAfter).toHaveLength(1)
    expect(bundlesAfter[0].name).toBe('IO Bundle')
    expect(await store.getBundleLinks(bundlesAfter[0].id)).toHaveLength(1)
    expect(settingsBefore.slug_default_length).toBe(8)
  })

  it('reports per-row import failures instead of a single vague count', async () => {
    await store.createLink({ url: 'https://example.com/taken', custom_slug: 'io-taken' })
    const result = await store.batchImportLinks([
      { url: 'https://example.com/new', slug: 'io-new' },
      { url: 'https://example.com/conflict', slug: 'io-taken' },
    ])
    expect(result.imported).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toMatchObject({ line: 2, slug: 'io-taken' })
    expect(result.errors[0].reason).toMatch(/slug/i)
  })

  it('deletes a backup row and leaves no stale entries', async () => {
    const backup = await store.createBackup(bucket)
    expect((await store.listBackups(bucket)).length).toBeGreaterThan(0)
    await store.deleteBackup(String(backup.id), bucket)
    expect(await store.listBackups(bucket)).toHaveLength(0)
  })
})
