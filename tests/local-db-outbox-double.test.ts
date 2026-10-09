import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `useNotes.flush()` replays the outbox through `localDb.withOutboxReplayLock`, so a test double for
 * `lib/db` that models the queue without the lock throws a `TypeError` the moment a scheduled flush
 * fires — and because the debounced save is fire-and-forget, that landed as an unhandled rejection
 * attributed to whichever test file happened to be running. The method was added to the real store
 * and only two of the doubles were updated; the rest kept passing until a busy machine moved the
 * timer. This reads the doubles instead: a mock that names one of the outbox methods has to name the
 * lock with it.
 */
const OUTBOX_METHODS = ['getOutbox', 'enqueueOutbox', 'markOutboxFailure', 'advanceOutboxDependents', 'setContentBatch']
const LOCK = 'withOutboxReplayLock'

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) testFiles(full, out)
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** The factory a file hands to `vi.mock('…/lib/db', …)`, or null when it mocks none. */
function dbMockOf(text: string): string | null {
  const match = /vi\.mock\((['"])[^'"]*\/db\1,\s*(?:async\s*)?\([^)]*\)\s*=>/.exec(text)
  if (!match) return null
  let depth = 0
  const start = text.indexOf('=>', match.index) + 2
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (char === '{' || char === '(' || char === '[') depth++
    else if (char === '}' || char === ')' || char === ']') {
      depth--
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return text.slice(start)
}

const found = testFiles(path.join(process.cwd(), 'src')).map((file) => {
  const body = dbMockOf(fs.readFileSync(file, 'utf8'))
  if (!body) return null
  const names = OUTBOX_METHODS.filter((method) => body.includes(method))
  return names.length ? { file: path.relative(process.cwd(), file), names, locked: body.includes(LOCK) } : null
}).filter((entry): entry is { file: string; names: string[]; locked: boolean } => entry !== null)

describe('the localDb test double models the whole outbox', () => {
  it('finds the doubles this rule is about', () => {
    expect(found.length).toBeGreaterThanOrEqual(5)
    expect(found.some((entry) => entry.file.endsWith('store/notes.test.ts'))).toBe(true)
  })

  it('mocks the replay lock wherever it mocks the queue', () => {
    const offenders = found.filter((entry) => !entry.locked).map((entry) => `${entry.file} (${entry.names.join(', ')})`)
    expect(offenders, `doubles that will throw when a scheduled flush replays the outbox:\n${offenders.join('\n')}`).toEqual([])
  })
})
