import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Dead code is only really gone while nothing re-introduces it, and these three shapes keep coming
 * back: mount options a registry stores but never reads, a `useMemo` keyed on the props object it
 * just received (a fresh reference on every render, so the memo never hits), and an `api` namespace
 * no caller uses because the module imports the functions by name.
 */
function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

function walkSources(directory: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) out = walkSources(target, out)
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(target)
  }
  return out
}

const ENTRY = 'src/client/lib/markdown/kanban/entry.ts'
const REGISTRY = 'src/client/lib/markdown/kanban/registry.ts'
const CONTEXT_MENU = 'src/client/lib/markdown/kanban/ui/kanban-context-menu.tsx'
/**
 * This fork has one flat api module, not a directory of namespaces, so the endpoints a board needs
 * are already named exports of the store it shares with every other block. What can still come back
 * is a kanban-only namespace bolted onto it, which nothing would import by name.
 */
const API = 'src/client/lib/api.ts'

describe('kanban dead code stays deleted', () => {
  it('keeps theme and locale out of the mount contract', () => {
    // The board root follows both by itself: colours through the tokens, labels through the locale
    // store — so a mount option carrying them would be state the registry stores and never reads.
    for (const file of [ENTRY, REGISTRY]) {
      expect(read(file), file).not.toMatch(/\bdark\b|\blocale\b|\bAppLocale\b/)
    }
  })

  it('keeps the context menu from memoizing on its own props object', () => {
    expect(read(CONTEXT_MENU)).not.toMatch(/\[props]\s*\)/)
  })

  it('leaves the kanban endpoints as named exports, not an unreferenced namespace', () => {
    expect(read(API)).not.toMatch(/\bkanban:\s*\{/)
    const callers = walkSources('src/client')
      .filter((file) => /api\.kanban\./.test(read(file)))
    expect(callers).toEqual([])
  })
})
