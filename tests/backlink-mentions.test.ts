// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { countText, deriveExcerpt, segmentCJK } from '../src/shared/markdown-utils'
import { findLinkedBacklinks, findUnlinkedMentions, linkMentionInNote } from '../src/worker/routes/notes'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * "deep research notes" in Chinese, plus the words it is made of, written as code points
 * so this file stays free of Han — the i18n gate allows Chinese only in the zh locale.
 * These strings are the point of the test: a CJK run is a single index token, so finding
 * the title in the middle of a sentence only works through the segmented phrase query.
 */
const cp = (...codes: number[]) => String.fromCodePoint(...codes)
const CN = cp(0x6DF1, 0x5EA6, 0x7814, 0x7A76, 0x7B14, 0x8BB0)
const CN_DEEP = cp(0x6DF1, 0x5EA6)
const CN_RESEARCH = cp(0x7814, 0x7A76)
const CN_NOTES = cp(0x7B14, 0x8BB0)
const CN_ABOUT = cp(0x5173, 0x4E8E)
const CN_IDEAS = cp(0x7684, 0x4E00, 0x4E9B, 0x60F3, 0x6CD5)
const CN_ALSO = cp(0x548C)
const CN_SCATTERED = cp(0x662F, 0x5206, 0x5F00, 0x7684)
const PAD = 'x'.repeat(120)

const USER = 'user-a'
const OTHER = 'user-b'
const TARGET = 'tgt'

let sqlite: DatabaseSync
let db: D1Database

function note(id: string, title: string, body: string, over: { user?: string; deletedAt?: number | null } = {}) {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, folder_id, title, title_key, content, excerpt, rev,
       word_count, char_count, is_pinned, is_starred, is_archived, position, content_hash,
       created_at, updated_at, deleted_at)
     VALUES (?, ?, NULL, ?, ?, ?, '', 1, 0, 0, 0, 0, 0, 0, '', 1, ?, ?)`,
  ).run(id, over.user ?? USER, title, title.toLowerCase(), body, Date.now(), over.deletedAt ?? null)
  if ((over.user ?? USER) === USER && over.deletedAt == null)
    sqlite.prepare('INSERT INTO notes_fts (note_id, user_id, title, body) VALUES (?, ?, ?, ?)')
      .run(id, USER, segmentCJK(title).trim(), segmentCJK(body))
}

function linkTo(source: string, title: string) {
  sqlite.prepare('INSERT INTO links (source_note_id, target_key, target_title, target_note_id, user_id) VALUES (?,?,?,?,?)')
    .run(source, title.toLowerCase(), title, TARGET, USER)
}

const mentions = (title: string, fts = true) => findUnlinkedMentions(db, USER, { id: TARGET, title }, fts, 50)
const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort()

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  sqlite.exec('CREATE VIRTUAL TABLE notes_fts USING fts5(note_id, user_id, title, body, tokenize = "unicode61 remove_diacritics 2")')
  note(TARGET, CN, 'target body')
  db = makeD1(sqlite) as unknown as D1Database
})

describe('unlinked mentions', () => {
  it('finds a chinese title inside a sentence and returns the text around it', async () => {
    note('mid', 'misc', `${PAD}${CN_ABOUT}${CN}${CN_IDEAS}${PAD}`)
    const rows = await mentions(CN)
    expect(ids(rows)).toEqual(['mid'])
    expect(rows[0].context).toContain(CN)
    expect(rows[0].context.length).toBeGreaterThan(10)
  })

  it('does not list a note that already links to the target', async () => {
    note('linked', 'has link', `text [[${CN}]] more`)
    note('plain', 'no link', `text ${CN} more`)
    linkTo('linked', CN)
    expect(ids(await mentions(CN))).toEqual(['plain'])
  })

  it('skips the note itself, the trash, and other accounts', async () => {
    note('other-note', 'another', CN)
    note('trashed', 'in trash', `${CN} body`, { deletedAt: 5 })
    note('elsewhere', 'foreign', `${CN} body`, { user: OTHER })
    expect(ids(await mentions(CN))).toEqual(['other-note'])
  })

  it('needs the characters adjacent, not merely all present', async () => {
    note('apart', 'scattered', `${CN_DEEP}${CN_ALSO}${CN_RESEARCH}${CN_ALSO}${CN_NOTES}${CN_SCATTERED}`)
    expect(ids(await mentions(CN))).toEqual([])
  })

  it('matches an ascii title inside a sentence', async () => {
    note('ascii', 'English note', 'a paragraph mentioning Deep Research Notes casually')
    expect(ids(await mentions('Deep Research Notes'))).toEqual(['ascii'])
  })

  it('refuses a one-character title rather than matching half the vault', async () => {
    note('short', 'misc', 'A appears in many places')
    expect(await mentions('A')).toEqual([])
  })

  it('still matches a two-character title, since that is a real name', async () => {
    note('ai', 'misc', 'notes about AI and tooling')
    expect(ids(await mentions('AI'))).toEqual(['ai'])
  })

  it('answers the same with and without the full-text index', async () => {
    note('mid', 'misc', `${CN_ABOUT}${CN}${CN_IDEAS}`)
    note('plain', 'no link', `text ${CN} more`)
    const indexed = ids(await mentions(CN, true))
    const scanned = ids(await mentions(CN, false))
    expect(indexed).toHaveLength(2)
    expect(scanned).toEqual(indexed)
  })

  it('caps the list', async () => {
    for (let i = 0; i < 60; i++) note(`bulk${i}`, `bulk ${i}`, `text ${CN} entry ${i}`)
    expect(await mentions(CN)).toHaveLength(50)
  })
})

describe('linked backlinks', () => {
  const linked = () => findLinkedBacklinks(db, USER, { id: TARGET, title: CN })

  it('carries the text around the link, not an empty excerpt', async () => {
    note('src', 'source', `${PAD}reading on I wrote [[${CN}]] so it continues${PAD}`)
    linkTo('src', CN)
    const rows = await linked()
    expect(ids(rows)).toEqual(['src'])
    expect(rows[0].context).toContain(CN)
  })

  it('shows the link by its words, the way the reader says them', async () => {
    note('src', 'source', `reading on I wrote [[${CN}]] so it continues`)
    linkTo('src', CN)
    expect((await linked())[0].context).toBe(`reading on I wrote ${CN} so it continues`)
  })

  it('places the excerpt around an accented link SQLite cannot fold', async () => {
    const accented = 'Café Résumé'
    note('src', 'source', `HEAD${'x'.repeat(200)}reading about [[CAFÉ RÉSUMÉ]] dailyTAILMARK`)
    linkTo('src', accented)
    const rows = await findLinkedBacklinks(db, USER, { id: TARGET, title: accented })
    // Without the fold the scan reports no position and the excerpt falls back to the top
    // of the note, which is the same string with the wrong sentence in it.
    expect(rows[0].context).toContain('CAFÉ RÉSUMÉ')
    expect(rows[0].context).toContain('TAILMARK')
    expect(rows[0].context).not.toContain('HEAD')
  })

  it('drops a source that went to the trash', async () => {
    note('gone', 'trashed', `[[${CN}]]`, { deletedAt: 7 })
    linkTo('gone', CN)
    expect(await linked()).toEqual([])
  })
})

describe('mentions the cheap index pass cannot place', () => {
  const CAFE = 'Café Résumé'
  const CAFE_CAPS = 'CAFÉ RÉSUMÉ'
  const mentioned = (title: string, fts = true) => findUnlinkedMentions(db, USER, { id: TARGET, title }, fts, 50)

  it('lists a mention whose capitals SQLite leaves alone', async () => {
    note('src', 'source', `notes about ${CAFE_CAPS} here`)
    const rows = await mentioned(CAFE)
    expect(ids(rows)).toEqual(['src'])
    expect(rows[0].context).toContain(CAFE_CAPS)
  })

  it('finds one further in than the first window reaches', async () => {
    note('src', 'source', `${'word '.repeat(150)}a line mentioning ${CAFE_CAPS} deep in the note`)
    expect(ids(await mentioned(CAFE))).toEqual(['src'])
  })

  it('reaches a mention thousands of characters in, because the fold runs in the scan', async () => {
    note('src', 'source', `${'word '.repeat(1200)}a line mentioning ${CAFE_CAPS} far away`)
    const rows = await mentioned(CAFE)
    expect(ids(rows)).toEqual(['src'])
    expect(rows[0].context).toContain(CAFE_CAPS)
  })

  it('looks past an alias that only the front matter carries', async () => {
    note('src', 'source', `---\ntitle: misc\naliases: [${CAFE}]\n---\n${'word '.repeat(120)}a line mentioning ${CAFE_CAPS} in the body`)
    const rows = await mentioned(CAFE)
    expect(ids(rows)).toEqual(['src'])
    expect(rows[0].context).toContain(CAFE_CAPS)
    expect(rows[0].context).not.toContain('aliases')
  })

  it('refuses words that only happen to sit next to each other', async () => {
    note('src', 'source', 'notes about café  résumé here')
    expect(ids(await mentioned('Café Résumé'))).toEqual([])
    expect(ids(await mentioned('Café Résumé', false))).toEqual([])
  })

  it('refuses a title that lives only in the note front matter', async () => {
    note('src', 'source', `---\ntitle: unrelated\naliases: [${CAFE}]\n---\nnothing to see here`)
    expect(ids(await mentioned(CAFE))).toEqual([])
  })

  it('answers the same with and without the index for a plain latin mention', async () => {
    note('src', 'source', `notes about ${CAFE_CAPS} here`)
    expect(ids(await mentioned(CAFE, false))).toEqual(ids(await mentioned(CAFE, true)))
  })
})

describe('linking a mention for real', () => {
  const row = (id: string) => (sqlite.prepare('SELECT content, rev, updated_at, excerpt, word_count FROM notes WHERE id = ?')
    .get(id) as { content: string; rev: number; updated_at: number; excerpt: string; word_count: number })
  const savedVersions = (id: string) => (sqlite.prepare('SELECT content FROM note_versions WHERE note_id = ? ORDER BY created_at')
    .all(id) as Array<{ content: string }>)

  it('writes the link, moves the row to the backlinks, and keeps the old text', async () => {
    const before = `notes about ${CN} and ideas`
    note('src', 'source', before)
    const outcome = await linkMentionInNote(db, USER, 'src', CN, true)
    expect(outcome.status).toBe('linked')
    expect(row('src').content).toBe(`notes about [[${CN}]] and ideas`)
    expect(row('src').rev).toBe(2)
    expect(row('src').updated_at).toBeGreaterThan(1)
    expect(savedVersions('src')).toEqual([{ content: before }])
    expect(ids(await mentions(CN))).toEqual([])
    expect(ids(await findLinkedBacklinks(db, USER, { id: TARGET, title: CN }))).toEqual(['src'])
  })

  it('refreshes the derived columns, so the row is not left describing the old text', async () => {
    note('src', 'source', `# diary\nnotes about ${CN} and ideas`)
    await linkMentionInNote(db, USER, 'src', CN, true)
    const after = row('src')
    expect(after.excerpt).toBe(deriveExcerpt(after.content))
    expect(after.excerpt).not.toBe('')
    expect(after.word_count).toBe(countText(after.content).words)
  })

  it('takes one mention per call, so the reader can work down the note', async () => {
    note('src', 'source', `${CN} then ${CN}`)
    await linkMentionInNote(db, USER, 'src', CN, true)
    await linkMentionInNote(db, USER, 'src', CN, true)
    expect(row('src').content).toBe(`[[${CN}]] then [[${CN}]]`)
    expect(row('src').rev).toBe(3)
    expect(savedVersions('src')).toHaveLength(2)
  })

  it('reports no mention, without touching the note, when the row went stale', async () => {
    note('src', 'source', 'nothing to do here')
    expect((await linkMentionInNote(db, USER, 'src', CN, true)).status).toBe('no-mention')
    expect(row('src').rev).toBe(1)
    expect(savedVersions('src')).toEqual([])
  })

  it('refuses a note it does not own or that lives only in the trash', async () => {
    note('foreign', 'mine but not yours', CN, { user: OTHER })
    note('trashed', 'restoring soon', CN, { deletedAt: 9 })
    expect((await linkMentionInNote(db, USER, 'foreign', CN, true)).status).toBe('missing')
    expect((await linkMentionInNote(db, USER, 'trashed', CN, true)).status).toBe('missing')
    expect((await linkMentionInNote(db, USER, 'absent', CN, true)).status).toBe('missing')
    expect(row('foreign').rev).toBe(1)
    expect(row('trashed').rev).toBe(1)
  })

  it('still links when the full-text index is off', async () => {
    note('src', 'source', `notes about ${CN}`)
    expect((await linkMentionInNote(db, USER, 'src', CN, false)).status).toBe('linked')
    expect(row('src').content).toBe(`notes about [[${CN}]]`)
  })
})
