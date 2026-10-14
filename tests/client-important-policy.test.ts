// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `!important` may not spread.
 *
 * `AGENTS.md` rule 12 allows it only to override a third-party sheet, a print stylesheet, or an
 * accessibility force, and requires it to be scoped and commented. The tree has 155 of them and 136
 * sit inside exactly those contexts — vendored Excalidraw/KaTeX/CodeMirror rules, the print sheets,
 * and the `prefers-reduced-motion` override. The rest are the theme-swap transition and the RSS
 * printing class, which are the same three reasons written a different way.
 *
 * What this file enforces is the ratchet, not the justification. Proving justification needs a real
 * CSS AST: a line walk gets `@media (prefers-reduced-motion)` and the print blocks wrong often
 * enough to red-flag legitimate rules, and the repo deliberately has no CSS parser dependency. So the
 * budget per file can only shrink, the per-file totals are re-measured rather than trusted, and the
 * reason each file still has any is on the record here for the person who pays it down.
 */
const STYLE_DIR = path.join('src', 'client', 'styles')

const IMPORTANT_BUDGET = new Map<string, number>([
  ['prose.css', 130],
  ['rss.css', 14],
  ['app.css', 6],
  ['presentation.css', 3],
  ['editor.css', 2],
])

const REASONS: Record<string, string> = {
  'prose.css': 'Rendered note content meets third-party markup (KaTeX, Mermaid, the JSON tree, CodeMirror) whose own sheets win by author order; most of these are overrides inside `.ink-prose` for that vendor output.',
  'rss.css': 'The print path toggles a class (`html.rss-printing`) rather than `@media print`, so it has to beat the on-screen layout it reuses.',
  'app.css': 'Two theme-swap transition overrides and four lines of the `prefers-reduced-motion` force.',
  'presentation.css': 'Print sheet hides everything that is not the deck, and the deck is not an ancestor of the page body.',
  'editor.css': 'Editor surfaces override the vendored CodeMirror theme.',
}

/** `!important` declarations per stylesheet, comments excluded. */
function importantCounts(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const name of fs.readdirSync(STYLE_DIR)) {
    if (!name.endsWith('.css')) continue
    const lines = fs.readFileSync(path.join(STYLE_DIR, name), 'utf8').split('\n')
    const hits = lines.filter((line) => !line.trim().startsWith('/*') && !line.trim().startsWith('*')
      && line.includes('!important')).length
    if (hits) counts.set(name, hits)
  }
  return counts
}

describe('important overrides stay inside their budget', () => {
  const COUNTS = importantCounts()

  it('keeps each stylesheet within the count recorded here', () => {
    const over = [...COUNTS]
      .filter(([name, count]) => count > (IMPORTANT_BUDGET.get(name) ?? 0))
      .map(([name, count]) => `${name}: ${count} (budget ${IMPORTANT_BUDGET.get(name) ?? 0}) — ${REASONS[name] ?? 'no recorded reason; scope it and comment it'}`)
    expect(over, `${over.length} stylesheet(s) grew past their !important budget`).toEqual([])
  })

  it('drops the budget entry when a file is paid down', () => {
    // Both directions, like every other allowlist in this repo: a budget for a file that no longer
    // overuses `!important` hides the win and invites the next one back in.
    const stale = [...IMPORTANT_BUDGET.keys()].filter((name) => !COUNTS.has(name))
    expect(stale, `no !important left in ${stale.join(', ')} — delete the budget`).toEqual([])
  })

  it('reads the stylesheets it claims to measure', () => {
    // A guard whose directory moved would pass forever on an empty file list.
    expect(COUNTS.size, 'no stylesheet carried an !important, so the walk is probably broken').toBeGreaterThan(3)
  })
})
