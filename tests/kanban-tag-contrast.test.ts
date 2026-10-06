import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio, over, parseColor } from '../scripts/lib/contrast.mjs'
import { TOKENS_PATH, themeVars } from '../scripts/lib/theme-tokens.mjs'
import { KANBAN_COLOR_NAMES } from '../src/client/lib/markdown/kanban/colors'

/**
 * Kanban labels are the one palette the app does not derive from the accent: the
 * user picks a colour per option, so it has to work on every surface the board
 * paints them on and in both themes. That also means nothing else guards it —
 * `scripts/check-contrast.mjs` measures what the running app paints, and this
 * palette is only painted once a board exists.
 *
 * So the gate reads the declarations instead. A chip is a translucent tint of
 * the label colour over whatever surface it lands on, so the pair that has to
 * clear 4.5:1 is (label colour, tint composited on that surface) — judged over
 * every solid surface of the theme, because the same chip appears on the
 * sunken board, the raised card and the overlay dialog.
 */
const TOKENS = fs.readFileSync(TOKENS_PATH, 'utf8')
const KANBAN_CSS = fs.readFileSync('src/client/styles/kanban.css', 'utf8')
const AA_NORMAL = 4.5
const SURFACE_TOKENS = ['--bg-sunken', '--bg-base', '--bg-editor', '--bg-surface', '--bg-raised', '--bg-overlay', '--bg-inset']

const COLOR_MIX_RE = /^color-mix\(in oklab,\s*(.+?)\s+([\d.]+)%\s*,\s*transparent\)$/
const VAR_RE = /^var\((--[\w-]+)\)$/

/** Resolves a token value to rgb + alpha the way the browser composites it. */
function resolveColor(vars, raw, seen = new Set()) {
  const text = raw.trim()
  const mix = text.match(COLOR_MIX_RE)
  if (mix) {
    // Mixing with transparent keeps the colour and scales only its alpha.
    return { ...resolveColor(vars, mix[1], seen), alpha: Number(mix[2]) / 100 }
  }
  const reference = text.match(VAR_RE)
  if (reference) {
    const name = reference[1]
    if (seen.has(name) || !vars.has(name)) throw new Error(`undeclared token ${name}`)
    return resolveColor(vars, vars.get(name), new Set(seen).add(name))
  }
  const parsed = parseColor(text)
  if (!parsed) throw new Error(`unparsed colour: ${text}`)
  return parsed
}

const VARS: Record<string, Map<string, string>> = { light: themeVars('light', TOKENS), dark: themeVars('dark', TOKENS) }

function solidSurfaces(vars) {
  return SURFACE_TOKENS
    .filter((name) => vars.has(name))
    .map((name) => ({ name, color: resolveColor(vars, vars.get(name)) }))
    .filter((surface) => surface.color.alpha === 1)
}

function worstChipRatio(vars, name) {
  const foreground = resolveColor(vars, vars.get(`--kanban-tag-${name}-fg`))
  const tint = resolveColor(vars, vars.get(`--kanban-tag-${name}-bg`))
  let worst = { ratio: Infinity, surface: '' }
  for (const surface of solidSurfaces(vars)) {
    const ratio = contrastRatio(foreground.rgb, over(tint, surface.color.rgb))
    if (ratio < worst.ratio) worst = { ratio, surface: surface.name }
  }
  return worst
}

const SOURCE_ROOT = 'src/client'

function walkSources(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) out = walkSources(target, out)
    else if (/\.(ts|tsx|css)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(target)
  }
  return out
}

// The palette is mostly addressed through template literals
// (`var(--kanban-tag-${name}-bg)`) and described that way in prose as well
// (`--kanban-tag-<name>-fg`), so a reference is only checkable once its
// placeholder is expanded over the colour names the picker offers. A name that is
// not a placeholder is a real token and has to be declared as spelled.
function expandTagToken(suffix) {
  const placeholder = suffix.match(/^(?:\$\{[\w.]+\}|<[\w.]+>|\*)(.*)$/)
  if (!placeholder) return [`--kanban-tag-${suffix}`]
  return KANBAN_COLOR_NAMES.map((name) => `--kanban-tag-${name}${placeholder[1]}`)
}

describe('kanban label palette', () => {
  it('declares the palette in the token layer, not in a module stylesheet', () => {
    expect(KANBAN_CSS).not.toMatch(/#[0-9a-f]{3,8}\b|--kanban-tag-[\w-]+\s*:/i)
    for (const theme of ['light', 'dark']) {
      for (const name of KANBAN_COLOR_NAMES) {
        expect(VARS[theme].has(`--kanban-tag-${name}-fg`), `${theme} --kanban-tag-${name}-fg`).toBe(true)
        expect(VARS[theme].has(`--kanban-tag-${name}-bg`), `${theme} --kanban-tag-${name}-bg`).toBe(true)
      }
    }
  })

  it('keeps every label colour AA against its own tint on any surface', () => {
    const failures: string[] = []
    for (const theme of ['light', 'dark']) {
      for (const name of KANBAN_COLOR_NAMES) {
        const { ratio, surface } = worstChipRatio(VARS[theme], name)
        if (ratio < AA_NORMAL) failures.push(`${theme} ${name}: ${ratio.toFixed(2)}:1 on ${surface}`)
      }
    }
    expect(failures).toEqual([])
  })

  it('only references tag tokens it actually declares', () => {
    const undeclared: string[] = []
    for (const file of walkSources(SOURCE_ROOT)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const match of text.matchAll(/--kanban-tag-([^)\s,`'";:]+)/g)) {
        for (const token of expandTagToken(match[1])) {
          for (const theme of ['light', 'dark']) {
            if (!VARS[theme].has(token)) undeclared.push(`${file} → ${theme} ${token}`)
          }
        }
      }
    }
    expect(undeclared).toEqual([])
  })
})
