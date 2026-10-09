// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { collectFieldNotes, collectFieldValues } from '../src/worker/routes/quickadd'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'

const MINE = 'user-a'
const OTHER = 'user-b'

let sqlite: DatabaseSync
let db: ReturnType<typeof makeD1>

/** `stamp` is what "newest" is measured by, so the window under test is reproducible. */
function note(id: string, content: string, stamp: number, options: { user?: string; folderId?: string | null } = {}): void {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, folder_id, title, title_key, content, excerpt, rev,
       word_count, char_count, is_pinned, is_starred, is_archived, position, content_hash,
       created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, '', 1, 0, 0, 0, 0, 0, 0, '', ?, ?, NULL)`,
  ).run(id, options.user ?? MINE, options.folderId ?? null, id, id, content, stamp, stamp)
}

function frontMatter(values: string[]): string {
  // `mood: a, b` is one string to YAML, so a list has to be spelled as a list.
  return `---\nmood: ${values.length === 1 ? values[0] : `[${values.join(', ')}]`}\n---\nbody\n`
}

function folder(id: string, name: string, parent: string | null = null): void {
  sqlite.prepare(
    'INSERT INTO folders (id, user_id, parent_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 1, 1)',
  ).run(id, MINE, parent, name)
}

function tag(noteId: string, tagId: string, name: string): void {
  sqlite.prepare('INSERT OR IGNORE INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, 1)').run(tagId, MINE, name)
  sqlite.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tagId)
}

const values = (query: Parameters<typeof collectFieldValues>[2]) => collectFieldValues(db, MINE, { name: 'mood', ...query })

describe('the {{FIELD:}} scan window', () => {
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec(SCHEMA_STATEMENTS.join(';'))
    db = makeD1(sqlite)
  })

  it('reaches the 400th newest note and no further', async () => {
    // 420 notes: the window is the newest 400, so stamps 0..19 fall outside it.
    for (let index = 20; index < 420; index += 1)
      note(`n-${index}`, index === 415 ? frontMatter(['in-window']) : frontMatter([`plain-${index}`]), index)
    note('n-old', frontMatter(['out-of-window']), 5)

    const found = await values({})
    expect(found, 'a value on the 396th newest note is a suggestion').toContain('in-window')
    expect(found, 'a value older than the window is not, however rare it is').not.toContain('out-of-window')
  })

  it('caps the list at two hundred values and keeps the most used ones', async () => {
    for (let index = 0; index < 250; index += 1)
      note(`n-${index}`, frontMatter(index < 3 ? ['shared'] : [`only-${index}`]), index)

    const found = await values({})
    expect(found).toHaveLength(200)
    expect(found[0], 'the value three notes carry outranks 247 singletons').toBe('shared')
    const asked = await values({ limit: '5' })
    expect(asked).toHaveLength(5)
    expect(asked[0]).toBe('shared')
    const greedy = await values({ limit: '99999' })
    expect(greedy, 'a client cannot raise the ceiling by asking harder').toHaveLength(200)
  })

  it('drops a value too long to be a suggestion', async () => {
    note('n-long', frontMatter(['x'.repeat(201)]), 3)
    note('n-edge', frontMatter(['y'.repeat(200)]), 2)

    const found = await values({})
    expect(found).toContain('y'.repeat(200))
    expect(found, 'a paragraph is not a candidate value').not.toContain('x'.repeat(201))
  })

  it('counts a list property as several candidates', async () => {
    note('n-one', frontMatter(['alpha', 'beta']), 2)
    note('n-two', frontMatter(['beta']), 1)

    expect(await values({})).toEqual(['beta', 'alpha'])
  })

  it('filters by the note’s own folder name, not by its ancestors', async () => {
    folder('f-root', 'Proj')
    folder('f-child', 'Sub', 'f-root')
    note('n-root', frontMatter(['at-root']), 3, { folderId: 'f-root' })
    note('n-child', frontMatter(['at-child']), 2, { folderId: 'f-child' })
    note('n-loose', frontMatter(['nowhere']), 1)

    expect(await values({ folder: 'proj' })).toEqual(['at-root'])
    expect(await values({ folder: 'Sub' })).toEqual(['at-child'])
  })

  it('keeps another account’s notes out of the list', async () => {
    note('n-mine', frontMatter(['mine']), 2)
    note('n-theirs', frontMatter(['theirs']), 1, { user: OTHER })

    expect(await values({})).toEqual(['mine'])
  })

  it('applies the tag filters in both directions', async () => {
    note('n-in', frontMatter(['wanted']), 3)
    note('n-out', frontMatter(['untagged']), 2)
    note('n-done', frontMatter(['finished']), 1)
    tag('n-in', 't-work', 'work')
    tag('n-done', 't-done', 'done')

    expect(await values({ tag: 'work' })).toEqual(['wanted'])
    expect(await values({ excludeTag: 'done' })).toEqual(['untagged', 'wanted'])
  })

  // The three bounds above are only worth having if the scan they cap is slow enough to notice. This
  // is the measurement behind the round-5 ledger entry: a full window of realistic notes, timed.
  it('reads a full window of real-sized notes in one frame’s worth of work', async () => {
    const body = '\n'.repeat(60) + 'Some prose that a journal note would actually carry, in a few sentences.\n'
    for (let index = 0; index < 400; index += 1)
      note(`n-${index}`, `---\nmood: felt-${index % 40}\ntags: [a, b]\nproject: p${index % 7}\n---\n${body}`, index)

    const started = performance.now()
    const found = await values({})
    const elapsed = performance.now() - started
    console.log(`FIELD scan: 400 notes × 3 properties → ${found.length} values in ${elapsed.toFixed(1)}ms`)
    expect(found).toHaveLength(40)
    expect(elapsed, 'the window is a cost ceiling, not a rounding error').toBeLessThan(1500)
  })
})

describe('the property: capture target’s note scan', () => {
  const titles = async (query: Parameters<typeof collectFieldNotes>[2]) =>
    (await collectFieldNotes(db, MINE, { name: 'mood', ...query })).map((entry) => entry.title)

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec(SCHEMA_STATEMENTS.join(';'))
    db = makeD1(sqlite)
  })

  it('finds the notes whose property holds the value', async () => {
    note('n-glad', frontMatter(['glad']), 3)
    note('n-sad', frontMatter(['sad']), 2)
    note('n-glad-2', frontMatter(['glad']), 1)
    expect(await titles({ value: 'glad' })).toEqual(['n-glad', 'n-glad-2'])
  })

  it('reads a list property as any of its items', async () => {
    sqlite.prepare(
      `INSERT INTO notes (id, user_id, folder_id, title, title_key, content, excerpt, rev,
         word_count, char_count, is_pinned, is_starred, is_archived, position, content_hash,
         created_at, updated_at, deleted_at)
       VALUES ('n-list', ?, NULL, 'n-list', 'n-list', '---\nmood: [glad, tired]\n---\nbody\n', '', 1, 0, 0, 0, 0, 0, 0, '', 1, 1, NULL)`,
    ).run(MINE)
    expect(await titles({ value: 'tired' })).toEqual(['n-list'])
    expect(await titles({ value: 'sleepy' })).toEqual([])
  })

  it('asks which notes have the property at all when no value is given', async () => {
    note('n-has', frontMatter(['glad']), 2)
    note('n-none', '---\ntags: [a]\n---\nbody\n', 1)
    expect(await titles({})).toEqual(['n-has'])
  })

  it('matches a value without caring about case or the spaces around it', async () => {
    note('n-one', frontMatter(['Glad']), 1)
    expect(await titles({ value: '  glad  ' })).toEqual(['n-one'])
  })

  it('keeps another account’s notes out of the answer', async () => {
    note('n-mine', frontMatter(['glad']), 2)
    note('n-theirs', frontMatter(['glad']), 1, { user: OTHER })
    expect(await titles({ value: 'glad' })).toEqual(['n-mine'])
  })

  it('honours the same folder and tag scopes the value list uses', async () => {
    folder('f-journal', 'Journal')
    note('n-journal', frontMatter(['glad']), 3, { folderId: 'f-journal' })
    note('n-root', frontMatter(['glad']), 2)
    tag('n-tagged', 't-work', 'work')
    note('n-tagged', frontMatter(['glad']), 1)
    expect(await titles({ value: 'glad', folder: 'Journal' })).toEqual(['n-journal'])
    expect(await titles({ value: 'glad', tag: 'work' })).toEqual(['n-tagged'])
  })

  it('answers newest first and stops at the cap', async () => {
    for (let index = 0; index < 5; index += 1) note(`n-${index}`, frontMatter(['glad']), index)
    expect(await titles({ value: 'glad', limit: '2' })).toEqual(['n-4', 'n-3'])
  })

  it('skips a note whose front matter cannot be read', async () => {
    note('n-broken', '---\nmood: [unclosed\n---\nbody\n', 1)
    note('n-good', frontMatter(['glad']), 2)
    expect(await titles({ value: 'glad' })).toEqual(['n-good'])
  })
})
