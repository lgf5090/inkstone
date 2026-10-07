// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyBackupTemplates, readBackupTemplates } from '../src/worker/backup/templates'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { buildTemplateLibraryExport } from '../src/shared/note-templates'
import { makeD1 } from './doubles/d1-sqlite'
import type { NoteTemplate, NoteTemplateCategory } from '../src/shared/types'

const USER = 'user-1'
const OTHER = 'user-2'

const CATEGORY: NoteTemplateCategory = { id: 'cat-1', name: 'Notes', builtin: false, position: 0, createdAt: 1, icon: '📝', color: '#059669' }

function template(id: string, overrides: Partial<NoteTemplate> = {}): NoteTemplate {
  return {
    id,
    categoryId: CATEGORY.id,
    name: `Template ${id}`,
    description: '',
    content: '# Body\n',
    tags: ['daily'],
    builtin: false,
    isPinned: false,
    isStarred: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

let sqlite: DatabaseSync
let db: D1Database

function stored(userId = USER): string | null {
  return (sqlite.prepare('SELECT template_library AS v FROM users WHERE id = ?1').get(userId) as { v: string | null }).v
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  for (const id of [USER, OTHER]) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       VALUES (?, ?, 'h', ?, 'One', '', 'member', '{}', 1, 1)`,
    ).run(id, id, id)
  }
  db = makeD1(sqlite)
})

describe('restoring a template library from a backup', () => {
  it('stores the library so the next hydration reads it back', async () => {
    const text = JSON.stringify(buildTemplateLibraryExport([CATEGORY], [template('tpl-1', { isStarred: true })]))
    await expect(applyBackupTemplates(db, USER, text)).resolves.toMatchObject({ templates: 1, categories: 1 })
    const envelope = JSON.parse(stored()!) as { savedAt: number; library: { templates: Array<{ id: string; isStarred: boolean; icon?: string }> } }
    expect(envelope.library.templates[0]).toMatchObject({ id: 'tpl-1', isStarred: true })
    expect(envelope.savedAt).toBeGreaterThan(0)
  })

  it('refuses a file that is not a library document', async () => {
    await expect(applyBackupTemplates(db, USER, 'not json')).rejects.toThrow(/template library/i)
    await expect(applyBackupTemplates(db, USER, JSON.stringify({ app: 'obsidian', kind: 'x' }))).rejects.toThrow()
    expect(stored()).toBe(null)
  })

  it('refuses a file with entries the importer would have to drop', async () => {
    const smuggled = JSON.stringify({
      app: 'inkstone',
      kind: 'template-library',
      version: 1,
      exportedAt: 1,
      categories: [CATEGORY],
      templates: [template('tpl-1'), { id: 'okr', name: 'Fake built-in', content: 'x', builtin: true }],
    })
    await expect(applyBackupTemplates(db, USER, smuggled)).rejects.toThrow(/drop|discard/i)
    expect(stored()).toBe(null)
  })

  it('reads back only the library document of the stored envelope', async () => {
    const text = JSON.stringify(buildTemplateLibraryExport([CATEGORY], [template('tpl-1')]))
    await applyBackupTemplates(db, USER, text)
    expect(await readBackupTemplates(db, USER)).toBe(text)
    sqlite.prepare('UPDATE users SET template_library = ?1 WHERE id = ?2').run('{"savedAt":1,"library":"junk"}', USER)
    expect(await readBackupTemplates(db, USER)).toBe(null)
    sqlite.prepare('UPDATE users SET template_library = ?1 WHERE id = ?2').run(null, USER)
    expect(await readBackupTemplates(db, USER)).toBe(null)
  })
})
