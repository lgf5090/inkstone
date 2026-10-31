// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BLOG_SETTINGS } from '../src/shared/blog/settings'
import { SCHEMA_MIGRATIONS } from '../src/worker/db/schema'

const MODULE_HREFS = ['/', '/archive', '/friends', '/moments', '/anime', '/compass', '/albums', '/more']
const MORE_HREFS = ['/timeline', '/projects', '/devices', '/games', '/skills', '/about']

describe('the shipped navigation exposes every public module', () => {
  it('orders the top-level entries and the More children like the public site', () => {
    const links = DEFAULT_BLOG_SETTINGS.nav.links as Array<{ href: string; children?: Array<{ href: string }> }>
    expect(links.map((link) => link.href)).toEqual(MODULE_HREFS)
    const more = links.find((link) => link.href === '/more')
    expect(more?.children?.map((child) => child.href)).toEqual(MORE_HREFS)
  })

  it('the nav default migration upgrades a single Home link to the shipped default and leaves other navs alone', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(
      'CREATE TABLE blog_settings (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)',
    )
    const insert = db.prepare('INSERT INTO blog_settings (user_id, key, value) VALUES (?, ?, ?)')
    insert.run('legacy-en', 'nav', '{"links":[{"label":"Home","href":"/"}]}')
    insert.run('legacy-zh', 'nav', '{"links":[{"label":"首页","href":"/"}]}')
    insert.run('custom', 'nav', '{"links":[{"label":"Blog","href":"/posts"}]}')
    insert.run('other-key', 'sidebar', '{"links":[{"label":"Home","href":"/"}]}')

    const migration = SCHEMA_MIGRATIONS.find((entry) =>
      entry.statements.some((statement) => statement.includes("WHERE key = 'nav' AND value LIKE")),
    )
    expect(migration).toBeTruthy()
    for (const statement of migration!.statements) db.prepare(statement).run()

    const rows = db
      .prepare('SELECT user_id, value FROM blog_settings ORDER BY user_id')
      .all() as Array<{ user_id: string; value: string }>
    const byUser = new Map(rows.map((row) => [row.user_id, row.value]))
    expect(JSON.parse(byUser.get('legacy-en')!)).toEqual({ links: DEFAULT_BLOG_SETTINGS.nav.links })
    expect(JSON.parse(byUser.get('legacy-zh')!)).toEqual({ links: DEFAULT_BLOG_SETTINGS.nav.links })
    expect(JSON.parse(byUser.get('custom')!)).toEqual({ links: [{ label: 'Blog', href: '/posts' }] })
    expect(JSON.parse(byUser.get('other-key')!)).toEqual({ links: [{ label: 'Home', href: '/' }] })

    for (const statement of migration!.statements) db.prepare(statement).run()
    const rerun = db
      .prepare('SELECT value FROM blog_settings WHERE user_id = ?')
      .get('legacy-en') as { value: string }
    expect(JSON.parse(rerun.value)).toEqual({ links: DEFAULT_BLOG_SETTINGS.nav.links })
  })
})
