/**
 * A board's own data carries two fields that are URLs, and every one of them is a URL the browser may
 * be asked to follow: a cover becomes an `<img src>`, a file's `url` becomes an `<a href>` in the
 * detail panel, a download link, and a `fetch` when the reader opens a text attachment. The fence they
 * come from is not the author's private file — a board arrives by import, by share, or pasted out of
 * somebody else's note — so the only thing standing between a `javascript:` cover and a click that runs
 * it is the protocol check at the parse boundary (`assertFenceUrlsAreSafe` in `body.ts`), which fails
 * the whole fence into its error state rather than quietly dropping a field.
 *
 * The check itself is covered by `body.test.ts`. What is not, and what this file exists for, is that
 * the *list* of fields cannot fall behind the shape of the data: it reads the interfaces out of
 * `types.ts`, finds every field whose name says it holds a URL, and requires the guard to cover exactly
 * those. A card that grows a `thumbnail` (or a whole new interface with a URL on it) fails here on the
 * day it is declared — while somebody is thinking about protocol safety — rather than later, when the
 * field is already drawn by a surface that trusted it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseKanbanBody } from '../src/client/lib/markdown/kanban/body'
import type { KanbanItem } from '../src/client/lib/markdown/kanban/types'

const TYPES_FILE = path.join('src', 'client', 'lib', 'markdown', 'kanban', 'types.ts')
/** What the names of such a field look like, whichever interface it turns up on. */
const URL_FIELD = /(url|cover|href|src|thumbnail|image|link|poster|download)/i

/** The body of one `export interface X { … }`, found by its brace rather than by its length. */
function interfaceBody(source: string, name: string): string | null {
  const start = source.indexOf(`export interface ${name} {`)
  if (start === -1) return null
  const end = source.indexOf('\n}', start)
  return source.slice(start, end)
}

/** Interface name → the field names on it that hold a URL. */
function urlFieldsByInterface(source: string): Record<string, string[]> {
  const found: Record<string, string[]> = {}
  for (const match of source.matchAll(/^export interface (\w+) \{/gm)) {
    const name = match[1]!
    const body = interfaceBody(source, name) ?? ''
    const fields = [...body.matchAll(/^\s{2}(\w+)\??:/gm)]
      .map((field) => field[1]!)
      .filter((field) => URL_FIELD.test(field))
    if (fields.length > 0) found[name] = fields
  }
  return found
}

/** One way to smuggle a URL into a card, named by the field it goes into, with its own whitelist. */
const URL_FIELDS: { field: string; item: (url: string) => KanbanItem; allowed: string[] }[] = [
  {
    field: 'cover',
    item: (url) => ({ id: '1', title: 'Task', cover: url, properties: {} }),
    // The cover is an `<img src>`, so an inline image carries the pixels and cannot run.
    allowed: ['/api/kanban/file/default/1-cover.png', 'https://cdn.example.test/spec.pdf', 'data:image/png;base64,iVBORw0KGgo='],
  },
  {
    field: 'files[].url',
    item: (url) => ({
      id: '1',
      title: 'Task',
      files: [{ id: 'f1', name: 'x.png', size: 1, mime: 'image/png', url }],
      properties: {},
    }),
    // A file url is a link the reader presses and a body the panel fetches, so it never takes a
    // data url — there is nothing to preview that the reader did not already have in the note.
    allowed: ['/api/kanban/file/default/1-cover.png', 'https://cdn.example.test/spec.pdf'],
  },
]

const HOSTILE_URLS = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '//evil.example.test/x.png']

function parseWith(urlField: (url: string) => KanbanItem, url: string) {
  return parseKanbanBody(JSON.stringify({ items: [urlField(url)] }))
}

describe('every URL a card can carry is on the parse-time whitelist', () => {
  it('covers exactly the fields the data shape declares as URLs', () => {
    const declared = urlFieldsByInterface(fs.readFileSync(TYPES_FILE, 'utf8'))
    expect(
      declared,
      'a URL field was added to (or renamed on) a board interface: give it to assertFenceUrlsAreSafe in ' +
        'body.ts, then extend URL_FIELDS here so the guard is asked about it',
    ).toEqual({ KanbanFile: ['url'], KanbanItem: ['cover'] })
    expect(URL_FIELDS.map((entry) => entry.field).sort()).toEqual(['cover', 'files[].url'])
  })

  it.each(URL_FIELDS)('refuses a $field the browser would follow off-origin or into script', ({ field, item }) => {
    for (const url of HOSTILE_URLS) {
      const result = parseWith(item, url)
      expect(result.ok, `${field} accepted ${url}`).toBe(false)
      if (result.ok) continue
      // The message names the field, so an author whose board will not open can find the line.
      expect(result.error).toContain(field.split('[')[0]!)
    }
  })

  it.each(URL_FIELDS)('keeps a $field on its whitelist, so the guard is not a blanket refusal', ({ item, allowed }) => {
    for (const url of allowed) {
      const result = parseWith(item, url)
      expect(result.ok, `a legitimate ${url} was refused: ${result.ok ? '' : result.error}`).toBe(true)
    }
  })
})
