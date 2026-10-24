// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `sr-only` may not sit on a `<table>`.
 *
 * The utility clips by declaring `width: 1px; overflow: hidden`, and a table's used width never falls
 * below the width of what it holds — so the class quietly does nothing on the one element where the
 * content is widest. Measured in a real browser, the statistics screen's hidden definitions table came
 * out 638 pixels wide inside a 480-pixel window: the whole page scrolled sideways to reveal nothing at
 * all, while a screen reader still read the table correctly, which is precisely why no test caught it.
 *
 * The fix is a block element around the table, which does obey the clip. This scan is what keeps the
 * next hidden table from being written the way the last one was.
 */
const CLIENT_DIR = path.join('src', 'client')

/** Every `.tsx` under the client tree, including the tests that mount components directly. */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(name)
    return entry.name.endsWith('.tsx') || entry.name.endsWith('.ts') ? [name] : []
  })
}

/**
 * The attribute region of each `<table` opening tag: the text up to the first tag that follows it.
 *
 * Cut at the next `<` rather than at the next `>` because an arrow function inside an attribute would
 * end the search early, and a table is never self-closed.
 */
function tableTags(text: string): string[] {
  const tags: string[] = []
  let from = 0
  for (;;) {
    const at = text.indexOf('<table', from)
    if (at < 0) return tags
    const next = text.indexOf('<', at + 1)
    tags.push(text.slice(at, next < 0 ? text.length : next))
    from = at + 1
  }
}

function offenders(): string[] {
  const found: string[] = []
  for (const file of sourceFiles(CLIENT_DIR)) {
    const text = fs.readFileSync(file, 'utf8')
    for (const tag of tableTags(text)) {
      if (!/\bsr-only\b/.test(tag)) continue
      const line = text.slice(0, text.indexOf(tag)).split('\n').length
      found.push(`${file}:${line} — ${tag.replace(/\s+/g, ' ').slice(0, 90)}`)
    }
  }
  return found
}

describe('a hidden table', () => {
  it('is clipped by a box that obeys the clip, never by the table itself', () => {
    expect(offenders()).toEqual([])
  })
})
