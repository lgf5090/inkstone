// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * `as never` on a bindings object erases the checker for that whole argument: the route then reads
 * `DB`, `ASSETS` and `OAUTH_KV` off an object that has none of them, the test passes, and production
 * throws the first day it reaches for one. `tests/doubles/bindings.ts` builds a real `Env` instead,
 * so a route that reads an unwired binding meets a miss, an empty store or a loud error.
 *
 * This file only guards the floor. It counts every assertion whose type is the bare `never` keyword
 * in a top-level `tests/*.ts` file, and fails if that count grows past `AS_NEVER_CAP` or if a file
 * that moved to the factory slips back. The doubles directory is out of scope: it is where the
 * shapes live, including the one `KVNamespace` return the platform's fourteen overloads force open.
 * `as never[]`, which spreads call arguments, is a different hole and is not counted here.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TESTS = path.join(ROOT, 'tests')

/** Measured on the day the factory landed. Anything under it is progress; over it is a new cast. */
const AS_NEVER_CAP = 30

/** The files that build their `Env` with `testBindings`, so their own casts must stay gone. */
const BOUND_BY_THE_FACTORY = [
  'tests/assistant-routes.test.ts',
  'tests/backup-snapshot-templates.test.ts',
  'tests/do-auth-guard.test.ts',
  'tests/excalidraw-official-catalog-route.test.ts',
  'tests/notes-pinned-view.test.ts',
]

function scannedFiles(): string[] {
  return readdirSync(TESTS, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Every `expr as never` in one file.
 *
 * Read off the syntax tree, because a comment that mentions the cast is not one — and a plain text
 * search would also catch "was never" and "has never", which is how this count was first overstated.
 */
function countAsNever(source: ts.SourceFile): number {
  let count = 0
  const visit = (node: ts.Node) => {
    if (ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.NeverKeyword) count += 1
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(path.join(TESTS, file), 'utf8'), ts.ScriptTarget.Latest, true)
}

function counts(): Array<{ file: string; count: number }> {
  return scannedFiles()
    .map((file) => ({ file: `tests/${file}`, count: countAsNever(parse(file)) }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
}

function listing(entries: Array<{ file: string; count: number }>): string {
  const lines = entries.map(({ file, count }) => `  ${file}: ${count}`)
  const total = entries.reduce((sum, entry) => sum + entry.count, 0)
  return `\n${lines.join('\n')}\n  total: ${total}`
}

describe('the as never ratchet', () => {
  it('reads the files it is supposed to read', () => {
    const files = scannedFiles()
    const missing = BOUND_BY_THE_FACTORY.filter((file) => !files.includes(path.basename(file)))
    expect(missing, 'these files left the scan, so the ratchet no longer sees them').toEqual([])
  })

  it('counts a cast and not the word never in prose', () => {
    const source = ts.createSourceFile('probe.ts', [
      '// an older test wrote env as never and nobody noticed',
      "const note = 'as never silences everything'",
      'const env = { DB: null } as never',
      'const spread = [...values] as never[]',
    ].join('\n'), ts.ScriptTarget.Latest, true)
    expect(countAsNever(source)).toBe(1)
  })

  it('holds the whole tests directory at or under the last measured count', () => {
    const found = counts()
    const total = found.reduce((sum, entry) => sum + entry.count, 0)
    expect(
      total,
      `${total} as never casts are left in tests/, the cap is ${AS_NEVER_CAP}.`
      + ' Build the bindings with testBindings() from tests/doubles/bindings.ts instead.'
      + listing(found),
    ).toBeLessThanOrEqual(AS_NEVER_CAP)
  })

  it('keeps every factory-bound file free of the cast it replaced', () => {
    const slipped = BOUND_BY_THE_FACTORY
      .map((file) => ({ file, count: countAsNever(ts.createSourceFile(file, readFileSync(path.join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true)) }))
      .filter((entry) => entry.count > 0)
    expect(slipped, `testBindings() builds these fixtures, so none of them should cast to never${listing(slipped)}`).toEqual([])
  })
})
