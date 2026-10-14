// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The worker's layers point one way: a route adapts HTTP, a store talks to D1, and nothing imports
 * upward (`AGENTS.md` rule 3).
 *
 * Both halves were violated at once in this repository. Nine routes carried raw SQL, and the fix
 * exposed the other direction: `notes/store.ts` imported `buildFtsQuery` from `routes/search`, and
 * `mcp/retrieval.ts` imported `searchUserNotes` from the same file — a persistence layer and a
 * non-HTTP consumer reaching into the presentation layer for behaviour. Counting only "SQL inside a
 * route" never finds that, so both are measured here, in both directions, with an empty allowance
 * list: a new violation fails this file rather than a review comment.
 *
 * `app.ts` is the one module allowed to name the route modules, because wiring the HTTP surface is
 * what its whole job is.
 */
const ROUTES_DIR = path.join('src', 'worker', 'routes')
const WORKER_DIR = 'src/worker'
const WIRING = 'src/worker/app.ts'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.ts$/.test(entry.name)) out.push(full)
  }
  return out
}

const repoPath = (file: string): string => path.relative(process.cwd(), file).replaceAll('\\', '/')

/** Every `.prepare(` / `.batch(` a route file writes, as `file:line`. */
function sqlInRoutes(): string[] {
  const found: string[] = []
  for (const file of walk(ROUTES_DIR)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (/\.(?:prepare|batch)\s*\(/.test(line))
        found.push(`${repoPath(file)}:${index + 1} ${line.trim().slice(0, 60)}`)
    })
  }
  return found
}

/** Every import of a route module written by something that is not a route and is not the wiring. */
function upwardImports(): string[] {
  const found: string[] = []
  for (const file of walk(WORKER_DIR)) {
    const name = repoPath(file)
    if (name.startsWith(ROUTES_DIR.replaceAll('\\', '/')) || name === WIRING) continue
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (/from '\.\.?\/(?:\.\.\/)*routes\//.test(line) || /from '\.\/routes\//.test(line))
        found.push(`${name}:${index + 1} ${line.trim().slice(0, 70)}`)
    })
  }
  return found
}

describe('the worker talks downward, never sideways into the HTTP layer', () => {
  it('keeps SQL out of every route file', () => {
    const found = sqlInRoutes()
    expect(found, `${found.length} SQL statement(s) written in a route; move them into the module that owns the table`).toEqual([])
  })

  it('keeps non-route modules from importing a route', () => {
    const found = upwardImports()
    expect(found, `${found.length} upward import(s) of a route module; take the behaviour to a service or store`).toEqual([])
  })

  it('measures something, so a broken scan cannot look like a clean worker', () => {
    const routes = walk(ROUTES_DIR)
    expect(routes.length, 'the scan found no route files, so it cannot be trusted').toBeGreaterThan(20)
    const stores = walk(WORKER_DIR).filter((file) => /store\.ts$/.test(file))
    expect(stores.length, 'the scan found no store modules, so it cannot be trusted').toBeGreaterThan(8)
    // The rule is only meaningful while the layers still exist: app.ts must name routes, and a route
    // must still be a thing a store could wrongly import.
    const wiring = fs.readFileSync(WIRING, 'utf8')
    expect(wiring, 'app.ts no longer wires the routes, so the exemption is stale').toContain('./routes/search')
  })

  it('fires on a route that writes SQL and on a store that imports a route', () => {
    // Positive control: both halves of this rule were violated for months, so a scan that could not
    // see either would be reporting the world it wishes for rather than the one it is in.
    const routeSample = `const rows = await db.prepare('SELECT 1').bind(userId).all()`
    const storeSample = `import { buildFtsQuery } from '../routes/search'`
    expect(/\.(?:prepare|batch)\s*\(/.test(routeSample)).toBe(true)
    expect(/from '\.\.?\/(?:\.\.\/)*routes\//.test(storeSample)).toBe(true)
  })
})
