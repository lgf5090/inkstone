// @vitest-environment jsdom
/**
 * The note a mention points at, and the note that actually arrives.
 *
 * A picked note used to travel as nothing but its title, which is a description rather than an address:
 * rename the note, or give two notes the same title, and the model is handed a different document from the
 * one the reader chose — quietly. So the composer writes the id into the link and keeps the title as the
 * alias the reader reads, and the worker resolves on the id first. The mentions already stored in a
 * conversation are title-only and stay that way, so the older lookup has to keep answering too.
 *
 * This file sits with the worker's tests because it is the only place both halves can be reached: the
 * composer writes the text on one side of the boundary and the resolver reads it back on the other, and
 * the round trip is the promise.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { makeD1 } from './doubles/d1-sqlite'
import { formatNoteMention, noteMentionLinks } from '../src/client/features/chat/note-refs'
import { noteMentions, resolveNoteMentions } from '../src/worker/assistant/note-mentions'

const USER = 'user-1'
/** ULID-shaped, because the resolver only trusts an id of exactly this shape. */
const CHOSEN = '01hzzzzzzzzzzzzzzzzzzzzz11'
const TWIN = '01hzzzzzzzzzzzzzzzzzzzzz12'
const GONE = '01hzzzzzzzzzzzzzzzzzzzzz13'

/** The scope a reader gets when they allowed the assistant nothing in particular: everything they can read. */
const openScope = { restricted: false, folderIds: new Set<string>(), tagIds: new Set<string>(), noteIds: new Set<string>() }

/**
 * Two notes that share a title, and the one the reader picked is the older of them.
 *
 * That order is the whole defect: a lookup by title takes the most recently updated, so the note the
 * reader did not choose is the one an id-less mention reaches.
 */
function seed(): D1Database {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
  `)
  const rows: Array<[string, string, string, number]> = [
    [CHOSEN, 'Quarterly plan', 'the chosen note: coffee beans', 10],
    [TWIN, 'Quarterly plan', 'the twin note: oat milk', 20],
    [GONE, 'Deleted note', 'words of a deleted note', 5],
  ]
  for (const [id, title, content, updatedAt] of rows) {
    sqlite.prepare('INSERT INTO notes (id, user_id, title, content, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, USER, title, content, updatedAt)
  }
  sqlite.prepare('UPDATE notes SET deleted_at = 1 WHERE id = ?').run(GONE)
  return makeD1(sqlite)
}

describe('the mention the composer writes', () => {
  it('carries the id of the note the reader picked, with its title kept as the words', () => {
    const text = `look at ${formatNoteMention(CHOSEN, 'Quarterly plan')} before Friday`
    expect(text).toBe(`look at [[${CHOSEN}|Quarterly plan]] before Friday`)
    expect(noteMentions(text)).toEqual([{ id: CHOSEN, title: 'Quarterly plan' }])
  })

  it('names the same note twice without reading it twice', () => {
    const mention = formatNoteMention(CHOSEN, 'Quarterly plan')
    expect(noteMentions(`${mention} and again ${mention}`)).toHaveLength(1)
  })

  it('keeps the title shape for a row that carries no note id', () => {
    // A hand-typed trigger, or a listing from somewhere that is not the notebook: an unusable id must not
    // become a note title, so the old bare `[[Title]]` is what the reader gets.
    expect(formatNoteMention('b', 'Beta')).toBe('[[Beta]]')
    expect(noteMentions('[[Beta]]')).toEqual([{ id: null, title: 'Beta' }])
  })

  it('holds together when the title carries characters the link syntax cannot', async () => {
    const text = formatNoteMention(CHOSEN, 'Plan ]]\n| Q3')
    expect(text).toBe(`[[${CHOSEN}|Plan Q3]]`)
    expect(noteMentions(text)).toEqual([{ id: CHOSEN, title: 'Plan Q3' }])
    // Cut to what the syntax can hold, and still the right note: the id, not the words, is the address.
    expect(await resolveNoteMentions(seed(), USER, text, openScope)).toContain('coffee beans')
  })
})

describe('the note the worker reads out of a mention', () => {
  it('reaches the note that was picked even though another note shares its title', async () => {
    const block = await resolveNoteMentions(seed(), USER, formatNoteMention(CHOSEN, 'Quarterly plan'), openScope)
    expect(block).toContain('the chosen note: coffee beans')
    expect(block).not.toContain('oat milk')
  })

  it('still answers the title-only mentions stored before the id was carried', async () => {
    const block = await resolveNoteMentions(seed(), USER, '看看 [[Quarterly plan]] 里写了什么', openScope)
    expect(block).toContain('[mentioned notes]')
    // The old rule, unchanged: the most recently updated of the notes that share the title.
    expect(block).toContain('the twin note: oat milk')
  })

  it('names a mention that matches nothing, by the words the reader wrote', async () => {
    expect(await resolveNoteMentions(seed(), USER, '[[不存在的笔记]]', openScope))
      .toContain('no note with that title')
    // A mention whose note has since been deleted is not the same claim, and saying "no note with that
    // title" would send the reader looking for a rename instead of telling them the note is gone.
    const gone = await resolveNoteMentions(seed(), USER, formatNoteMention(GONE, 'Deleted note'), openScope)
    expect(gone).toContain('no longer exists')
    expect(gone).not.toContain('words of a deleted note')
  })

  it('carries the words of every note a turn mentions', async () => {
    const text = `${formatNoteMention(CHOSEN, 'Quarterly plan')} plus [[Quarterly plan]]`
    const block = await resolveNoteMentions(seed(), USER, text, openScope)
    expect(block).toContain('coffee beans')
    expect(block).toContain('oat milk')
    expect(await resolveNoteMentions(seed(), USER, 'no mentions here', openScope)).toBe('')
  })
})

describe('following a mention in the transcript', () => {
  it('opens the note the id names instead of making a new one named by it', () => {
    const opened: string[] = []
    const created: string[] = []
    const links = noteMentionLinks({
      openNote: (id) => { opened.push(id) },
      createNote: (title) => { created.push(title) },
    })
    // The renderer resolves a `[[…]]` by title, so the link the composer wrote arrives here as a note the
    // vault appears not to have. Its target is the id, and an id is not a title worth creating.
    links.createNote?.(CHOSEN)
    expect(opened).toEqual([CHOSEN])
    expect(created).toEqual([])
    // A title the notebook genuinely does not have still becomes the offer it was before.
    links.createNote?.('A note the reader really did name')
    expect(created).toEqual(['A note the reader really did name'])
    expect(opened).toEqual([CHOSEN])
  })
})
