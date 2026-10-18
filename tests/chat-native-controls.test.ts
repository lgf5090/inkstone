import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The chat surfaces are the newest in the app, and the cheapest way to build a form there is to reach
 * for the browser's own control — a `datetime-local` box or a file button that no other screen in this
 * product uses, drawn in the operating system's style. Every date, clock and file field in the chat is
 * instead the app's own picker, so these rules are what keeps an OS widget from creeping back in one
 * convenient commit at a time.
 */
const CHAT_DIR = 'src/client/features/chat'

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(target, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(target)
  }
  return out
}

const sources = walk(CHAT_DIR)

/**
 * The code of one file, with its comments blanked out.
 *
 * These rules read source text, and prose *about* a control is not a use of it: a comment explaining that
 * the composer renders `<input type="file">` would otherwise fail the check that keeps that button behind
 * an app-styled trigger, and the fix would be to reword the truth. `://` is left intact so an address in
 * an attribute is never mistaken for the start of a line comment.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
}

describe('chat surfaces avoid operating-system controls', () => {
  it('scans the whole chat directory', () => {
    expect(sources.length, 'the chat feature folder went missing').toBeGreaterThan(5)
  })

  it('never opens a native date, clock or month input', () => {
    for (const file of sources) {
      const text = code(fs.readFileSync(file, 'utf8'))
      for (const type of ['date', 'month', 'time', 'datetime-local', 'week']) {
        expect(text, `${file} reaches for input[type=${type}]`).not.toMatch(new RegExp(`type=["']${type}["']`))
      }
    }
  })

  it('keeps every file input behind an app-styled trigger', () => {
    for (const file of sources) {
      const text = code(fs.readFileSync(file, 'utf8'))
      for (const match of text.matchAll(/<input\b[^>]*type="file"[^>]*>/gs)) {
        expect(match[0], `${file} shows the OS file button`).toMatch(/\shidden(\s|=|>)/)
      }
    }
  })
})
