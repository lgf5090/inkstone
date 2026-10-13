/**
 * The reading app may not lean on browser-drawn UI.
 *
 * A native tooltip, select or bare input renders in the operating system's style — it ignores the page
 * palette, it cannot be themed for a night page, and on a phone a hover hint is simply unreachable. The
 * app already ships `Tooltip`, `Select`, `Input` and `Textarea`, so the reading feature has no reason to
 * reach for the browser's own, and this test is what keeps it that way.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_DIR = join(__dirname, '../src/client/features/reading')

function sources(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const target = join(directory, entry)
    if (statSync(target).isDirectory()) out = sources(target, out)
    else if (/\.tsx?$/.test(entry)) out.push(target)
  }
  return out
}

/** The tag a given line belongs to: the nearest `<name` at or before it. */
function enclosingTag(lines: string[], index: number): string {
  for (let at = index; at >= 0 && at > index - 18; at--) {
    const found = /<([A-Za-z][\w.]*)/.exec(lines[at] ?? '')
    if (found) return found[1]!
  }
  return ''
}

/** A hidden file picker and the app's own slider skin are the two native controls that stay. */
function inputIsAllowed(tag: string): boolean {
  return /type="file"/.test(tag) || /ink-slider/.test(tag)
}

const files = sources(SOURCE_DIR)

describe('the reading app ships no browser-drawn controls', () => {
  it('looks at real files', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('never puts a title attribute on one of its own elements', () => {
    const offenders: string[] = []
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, at) => {
        if (!/\stitle=\{|\stitle="/.test(line)) return
        const tag = enclosingTag(lines, at)
        // A capitalised tag is one of this app's components, which take a `title` prop by design.
        if (tag && /^[A-Z]/.test(tag)) return
        offenders.push(`${file.slice(SOURCE_DIR.length + 1)}:${at + 1} <${tag}>`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('uses the app form components instead of raw fields', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const relative = file.slice(SOURCE_DIR.length + 1)
      for (const tag of [...source.matchAll(/<(input|select|textarea|progress|dialog)\b[\s\S]{0,700}?\/>/g)].map((m) => m[0])) {
        const name = /<(\w+)/.exec(tag)?.[1] ?? ''
        if (name === 'input' && inputIsAllowed(tag)) continue
        offenders.push(`${relative}: <${name}> ${tag.slice(0, 60).replace(/\s+/g, ' ')}`)
      }
      // An `<input>` that does not close itself would slip past the matcher above, so count them too.
      const opened = (source.match(/<input\b/g) ?? []).length
      const matched = [...source.matchAll(/<input\b[\s\S]{0,700}?\/>/g)].length
      expect(opened, `${relative}: an <input> the gate could not read`).toBe(matched)
    }
    expect(offenders).toEqual([])
  })

  it('skins every range control with the app slider', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const tag of [...source.matchAll(/<input\b[\s\S]{0,700}?\/>/g)].map((m) => m[0])) {
        if (/type="range"/.test(tag)) {
          expect(tag, file.slice(SOURCE_DIR.length + 1)).toContain('ink-slider')
        }
      }
    }
  })
})
