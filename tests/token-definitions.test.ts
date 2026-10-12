import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|css)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

// A token counts as defined either in a stylesheet or as a quoted '--x' literal
// in TS (runtime setProperty / inline-style keys resolve the same way).
function collectDefined(files: string[]): Set<string> {
  const defined = new Set<string>()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const pattern = file.endsWith('.css') ? /(--[a-z0-9-]+)\s*:/g : /["'](--[a-z0-9-]+)["']/g
    for (const match of source.matchAll(pattern)) defined.add(match[1]!)
  }
  return defined
}

// Debt that predates the kanban port and belongs to whoever owns that file. Registering it here means
// the gate is green today and turns red the moment *anyone* adds a new dangling token — which is the
// only reason it exists. Removing an entry requires the owning module to define the token.
// Three entries this list used to carry — `--danger-soft`, `--sp-0-625`, `--font-display` — are gone
// because the calendar round defined them in `styles/tokens.css` instead of leaving them dangling.
const LEGACY_DANGLING = new Map<string, string>([
  ['--code-font-size', 'styles/prose.css and kanban.css; the value is set at runtime by the code-block JS'],
  ['--code-line-height', 'styles/prose.css; same runtime-set pair as --code-font-size'],
  // Not debt: a template prefix. colors.ts writes var(--kanban-tag-${name}-bg), so the scanner reads a
  // truncated name. The 24 real tokens it expands to are all declared, in both themes.
  ['--kanban-tag-', 'kanban/colors.ts template prefix var(--kanban-tag-<name>-bg); the expanded tokens are declared'],
  // Inherited from the reference project, where they dangle exactly the same way (checked with a
  // repo-wide grep for a definition). Both projects therefore render these through the fallback, so
  // picking a fork token here would be a silent visual redesign, not a port fix.
  ['--accent-fg', 'kanban tag-picker foreground; undefined in the reference too, falls back to inherited'],
  ['--bg-surface-subtle', 'kanban column-cards surface; undefined in the reference too, falls back to inherited'],
  ['--text-20', 'kanban chart-view type scale; undefined in the reference too, falls back to inherited'],
])

describe('every design token referenced by the client is defined (SH-37)', () => {
  const files = walk(path.join('src', 'client'))
  const defined = collectDefined(files)

  it('scans a non-trivial source set', () => {
    // Sized to this fork's tree, not the reference's: the assertion exists to catch a scan that
    // silently stopped covering anything, not to encode another project's file count.
    expect(files.length).toBeGreaterThan(300)
    expect(defined.size).toBeGreaterThan(100)
  })

  it('references no status-color *-subtle aliases after the -soft unification', () => {
    const aliased = files.filter((file) => /var\(--(danger|warning|success|accent)-subtle\)/.test(readFileSync(file, 'utf8')))
    expect(aliased).toEqual([])
  })

  it('defines every var() token except the whitelisted legacy debt', () => {
    const dangling = new Map<string, string[]>()
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/var\((--[a-z0-9-]+)/g)) {
        const name = match[1]!
        if (defined.has(name) || LEGACY_DANGLING.has(name)) continue
        dangling.set(name, [...(dangling.get(name) ?? []), file])
      }
    }
    expect([...dangling.entries()]).toEqual([])
  })

  it('carries no registered debt that nothing references any more', () => {
    // A list that only grows stops meaning anything, so paying off a token has to delete its entry
    // and this is what makes leaving it behind expensive enough to notice.
    const sources = files.map((file) => readFileSync(file, 'utf8'))
    const stale = [...LEGACY_DANGLING.entries()].filter(([name]) => !sources.some((source) => source.includes(`var(${name}`)))
    expect(stale).toEqual([])
  })

  it('never names a theme colour after a font-size step', () => {
    // `text-*` holds both colours and font sizes, so a theme colour named `base` silently turns the
    // built-in `text-base` into `color: var(--bg-base)` - the page background, i.e. invisible text -
    // and takes the size with it. The collision is invisible in the source and only shows in the
    // rendered sheet, so the name itself is what has to be policed.
    const theme = readFileSync('src/client/styles/app.css', 'utf8')
    const colours = [...theme.matchAll(/^\s*--color-([a-z0-9-]+)\s*:/gm)].map((m) => m[1]!)
    const FONT_SIZES = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl']
    expect(colours.filter((name) => FONT_SIZES.includes(name))).toEqual([])
  })
})
