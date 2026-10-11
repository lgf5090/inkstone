import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The JSON faces' text has to be readable on the backgrounds it actually paints on, in both themes.
 *
 * A browser pass over the shipped palette found the key colour at 3.49:1 on a white card and the "+N" line
 * at 1.48:1 in the dark theme — numbers no type check, unit test or token-existence gate can see. This
 * re-derives them from the stylesheets so the *roles* stay fixed rather than the values: each entry names a
 * selector, and the ink it paints with is read out of `prose.css` rather than restated here, because a table
 * that repeats the colour is a table that stays green when the colour is reverted.
 *
 * The colour maths is checked against four values read out of a real browser, and the ratio against the
 * reference pair published for 4.54:1, before any role is judged.
 */

const TOKENS = readFileSync(path.join('src', 'client', 'styles', 'tokens.css'), 'utf8')
const PROSE = readFileSync(path.join('src', 'client', 'styles', 'prose.css'), 'utf8')

interface Rgba { r: number, g: number, b: number, a: number }

function parseColour(value: string): Rgba | null {
  const text = value.trim()
  if (!text) return null
  const hex = /^#([\da-f]{3,8})$/i.exec(text)
  if (hex) {
    const digits = hex[1]!
    const pair = (index: number) => Number.parseInt(digits[index]! + digits[index]!, 16)
    if (digits.length === 3 || digits.length === 4)
      return { r: pair(0), g: pair(1), b: pair(2), a: digits.length === 4 ? pair(3) / 255 : 1 }
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
    }
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text)
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter(Boolean).map(Number.parseFloat)
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts.length > 3 ? parts[3]! : 1 }
  }
  const oklch = /^oklch\(([^)]+)\)$/.exec(text)
  if (oklch) {
    const [head, alphaPart] = oklch[1]!.split(/\s*\/\s*/)
    const numbers = head!.trim().split(/[\s,]+/).map(Number.parseFloat)
    return oklchToRgba(head!.includes('%') ? numbers[0]! / 100 : numbers[0]!, numbers[1] ?? 0, numbers[2] ?? 0,
      alphaPart ? (alphaPart.includes('%') ? Number.parseFloat(alphaPart) / 100 : Number.parseFloat(alphaPart)) : 1)
  }
  const named: Record<string, Rgba> = {
    white: { r: 255, g: 255, b: 255, a: 1 },
    black: { r: 0, g: 0, b: 0, a: 1 },
    transparent: { r: 0, g: 0, b: 0, a: 0 },
  }
  return /^[a-z]+$/i.test(text) ? named[text.toLowerCase()] ?? null : null
}

function oklchToRgba(lightness: number, chroma: number, hueDegrees: number, a: number): Rgba {
  const h = (hueDegrees * Math.PI) / 180
  const labA = chroma * Math.cos(h)
  const labB = chroma * Math.sin(h)
  const l = lightness + 0.3963377774 * labA + 0.2158037573 * labB
  const m = lightness - 0.1055613458 * labA - 0.0638541728 * labB
  const s = lightness - 0.0894841775 * labA - 1.291485548 * labB
  const [lc, mc, sc] = [l ** 3, m ** 3, s ** 3]
  const encode = (channel: number) => {
    const gamma = channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.max(0, channel) ** (1 / 2.4) - 0.055
    return Math.round(Math.min(1, Math.max(0, gamma)) * 255)
  }
  return {
    r: encode(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc),
    g: encode(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc),
    b: encode(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc),
    a,
  }
}

interface Declaration { selector: string, property: string, token: string }

function blocks(source: string): Array<{ selector: string, body: string }> {
  const found: Array<{ selector: string, body: string }> = []
  // Comments have to go first: a note between two rules otherwise reads as part of the next selector.
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) found.push({ selector: match[1]!.trim(), body: match[2]! })
  return found
}

function customProperties(body: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of body.split('\n')) {
    const pair = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*;?\s*$/.exec(line)
    if (pair) out.set(pair[1]!, pair[2]!)
  }
  return out
}

/** Every `color`/`fill`/`stroke` the JSON faces set, one entry per selector in the group. */
function jsonInks(): Declaration[] {
  const found: Declaration[] = []
  for (const block of blocks(PROSE)) {
    const decls = new Map<string, string>()
    for (const line of block.body.split('\n')) {
      const pair = /^\s*(color|fill|stroke)\s*:\s*var\((--[\w-]+)\)\s*;?\s*$/.exec(line)
      if (pair) decls.set(pair[1]!, pair[2]!)
    }
    if (!decls.size) continue
    for (const selector of block.selector.split(',').map(part => part.trim()).filter(Boolean)) {
      if (!/(^|[\s.>])(jt-|jm-|json-)/.test(selector) && !/\s(path|rect)$/.test(selector)) continue
      for (const [property, token] of decls) {
        // A background colour on a stroke is a halo, not an ink: the edge label's own outline is drawn in
        // the page colour so it stays legible over the dotted backdrop.
        if (token.startsWith('--bg-')) continue
        found.push({ selector, property, token })
      }
    }
  }
  return found
}

type Theme = 'light' | 'dark'

function palette(theme: Theme, white: boolean): Map<string, string> {
  const merged = new Map<string, string>()
  for (const block of blocks(TOKENS)) {
    const gated = /data-theme='(light|dark)'/.test(block.selector)
    const wantsWhite = /data-background='white'/.test(block.selector)
    // The white-page variants override only the four backgrounds, so the theme's own block has to be read
    // underneath them or `--bg-hover` and the rest vanish from the scenario.
    if (wantsWhite && !white) continue
    if (gated && !block.selector.includes(`data-theme='${theme}'`)) continue
    for (const [key, value] of customProperties(block.body)) merged.set(key, value)
  }
  return merged
}

function resolve(tokens: Map<string, string>, name: string, depth = 0): Rgba {
  const raw = tokens.get(name)
  if (!raw) throw new Error(`token ${name} is not defined in this theme`)
  if (depth > 4) throw new Error(`${name} resolves through itself`)
  const variable = /^var\((--[\w-]+)\)$/.exec(raw.trim())
  if (variable) return resolve(tokens, variable[1]!, depth + 1)
  const colour = parseColour(raw)
  if (!colour) throw new Error(`${name}: ${raw} is a form this gate cannot read`)
  return colour
}

function over(top: Rgba, bottom: Rgba): Rgba {
  return {
    r: Math.round(top.r * top.a + bottom.r * (1 - top.a)),
    g: Math.round(top.g * top.a + bottom.g * (1 - top.a)),
    b: Math.round(top.b * top.a + bottom.b * (1 - top.a)),
    a: 1,
  }
}

function channel(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function contrast(a: Rgba, b: Rgba): number {
  const first = 0.2126 * channel(a.r) + 0.7152 * channel(a.g) + 0.0722 * channel(a.b)
  const second = 0.2126 * channel(b.r) + 0.7152 * channel(b.g) + 0.0722 * channel(b.b)
  const [high, low] = [first, second].sort((p, q) => q - p)
  return Number(((high + 0.05) / (low + 0.05)).toFixed(2))
}

const OPAQUE = ['--bg-base', '--bg-surface', '--bg-inset', '--bg-overlay']
const WASHES = ['--bg-hover', '--bg-active']

function surfaces(theme: Theme, white: boolean): Map<string, Rgba> {
  const tokens = palette(theme, white)
  const out = new Map<string, Rgba>()
  for (const name of OPAQUE) out.set(name, resolve(tokens, name))
  for (const wash of WASHES) {
    const layer = resolve(tokens, wash)
    for (const name of OPAQUE) out.set(`${wash}-on-${name}`, over(layer, out.get(name)!))
  }
  return out
}

interface Role {
  /** Matched at the end of the selector, so a pseudo-class state is not mistaken for the base rule. */
  selector: string
  property: 'color' | 'fill' | 'stroke'
  on: string[]
  floor: number
}

// A tree row can sit on the page, the inset panel or either hover wash; a map card only ever sits on the
// card's own surface, and the detail panel on the overlay. Naming that per role is what keeps the budget
// honest — a blanket "every background" rule would demand a darker grey than the theme's hierarchy has.
const ROW = ['--bg-surface', '--bg-inset', '--bg-base', '--bg-active-on---bg-inset', '--bg-active-on---bg-surface', '--bg-hover-on---bg-inset']
const CARD = ['--bg-surface']
const PANEL = ['--bg-overlay', '--bg-inset']

/**
 * Content has to clear 4.5:1; an annotation, a piece of punctuation or a hover tint may sit at 3:1, because
 * the same information is available elsewhere (the colon beside an index, the resting colour under a hover,
 * the `{}` that already says a node is an object). Each of those lower floors is a decision, so each one
 * names what it is standing in for.
 */
const ROLES: Role[] = [
  { selector: '.jt-key', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jm-key', property: 'color', on: CARD, floor: 4.5 },
  { selector: '.jt-value--string', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jt-value--number', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jt-value--boolean', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jt-value--null', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jm-value', property: 'color', on: CARD, floor: 4.5 },
  { selector: '.jm-value--string', property: 'color', on: CARD, floor: 4.5 },
  { selector: '.jm-value--number', property: 'color', on: CARD, floor: 4.5 },
  { selector: '.jm-value--boolean', property: 'color', on: CARD, floor: 4.5 },
  { selector: '.jm-value--null', property: 'color', on: CARD, floor: 4.5 },
  { selector: '.jm-value--object', property: 'color', on: CARD, floor: 4.5 },
  { selector: '.jm-value--array', property: 'color', on: CARD, floor: 4.5 },
  { selector: '.jt-index', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jt-op', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jt-brace', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jt-input', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.json-tree', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.json-filter-input', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.json-tab', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.json-tool', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.json-view-note', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.json-view-note.is-invalid', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jm-fold', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jm-more', property: 'color', on: CARD, floor: 4.5 },
  { selector: '.jm-empty', property: 'color', on: CARD, floor: 4.5 },
  { selector: '.jm-edge-label', property: 'fill', on: ['--bg-base', '--bg-surface'], floor: 4.5 },
  { selector: '.jm-detail-body', property: 'color', on: PANEL, floor: 4.5 },
  { selector: '.jm-detail-path', property: 'color', on: PANEL, floor: 4.5 },
  { selector: '.jm-detail-label', property: 'color', on: PANEL, floor: 4.5 },
  { selector: '.jm-detail-title', property: 'color', on: PANEL, floor: 4.5 },
  { selector: '.jm-detail-close', property: 'color', on: PANEL, floor: 4.5 },
  { selector: '.jm-detail-copy', property: 'color', on: PANEL, floor: 4.5 },
  { selector: '.json-fs-title', property: 'color', on: PANEL, floor: 4.5 },
  { selector: '.json-shortcuts', property: 'color', on: PANEL, floor: 4.5 },
  // Punctuation, kind badges and the tree's own fold chevron. These sit at `--text-secondary` and are held
  // to the same floor as the rest: the bottom two tiers of the theme's ramp measured 1.75–2.71:1 on a
  // hovered row in the dark theme, which is not a quieter grey but an invisible one.
  { selector: '.jt-colon', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jt-count', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jt-kind', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jt-fold', property: 'color', on: ROW, floor: 4.5 },
  // Hover and selected tints: the resting colour is the one that carries the label.
  { selector: '.json-tab.is-active', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.json-tab:hover', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.json-tool:hover', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jt-op:hover', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jt-fold:hover', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jm-fold:hover', property: 'color', on: ROW, floor: 4.5 },
  { selector: '.jm-detail-close:hover', property: 'color', on: PANEL, floor: 4.5 },
  { selector: '.jm-detail-copy:hover', property: 'color', on: PANEL, floor: 4.5 },
  // A connector is a graphic object rather than text, so it answers to 1.4.11's 3:1.
  { selector: 'path', property: 'stroke', on: ['--bg-base', '--bg-surface'], floor: 3 },
]

/**
 * Colours this round deliberately left alone, with the number they measure and why.
 *
 * `.json-tool[aria-expanded='true']` paints the open filter button in the accent on the accent's own soft
 * tint. That is not this feature's convention: `.block-tool-btn`, `.chart-tool-btn`, `.mindmap-tool-btn`
 * and the layout trigger all do the same, so changing the JSON one alone would make its toolbar disagree
 * with the four beside it. The fix belongs to a theme pass on `--accent-soft`, which should delete this
 * entry — and the test below fails if it is still listed once the rule no longer needs it.
 */
const DEBT: Array<{ selector: string, property: string, token: string, reason: string }> = [
  { selector: ".json-tool[aria-expanded='true']", property: 'color', token: '--accent', reason: 'shared with the four other block toolbars' },
]

function inkFor(decls: Declaration[], role: Role): Declaration {
  const match = decls.find(decl => decl.selector.endsWith(role.selector) && decl.property === role.property)
  if (!match) throw new Error(`no ${role.property} on ${role.selector} in prose.css — the role table is stale`)
  return match
}

describe('the json views meet their contrast budget (card round)', () => {
  it('reads the same colours a browser does', () => {
    const cases: Array<[string, [number, number, number]]> = [
      ['oklch(100% 0 0)', [255, 255, 255]],
      ['oklch(96.8% 0.005 90)', [246, 244, 241]],
      ['oklch(21.5% 0.01 265)', [23, 25, 30]],
      ['oklch(14% 0.008 265)', [8, 9, 12]],
      ['#e36209', [227, 98, 9]],
    ]
    for (const [value, expected] of cases) {
      const colour = parseColour(value)
      expect([colour!.r, colour!.g, colour!.b], value).toEqual(expected)
    }
    expect(contrast(parseColour('#767676')!, parseColour('#ffffff')!)).toBe(4.54)
    expect(contrast(parseColour('#000000')!, parseColour('#ffffff')!)).toBe(21)
  })

  it('finds the JSON inks in prose.css, and every one of them has a role or a recorded reason', () => {
    const decls = jsonInks()
    expect(decls.length).toBeGreaterThan(15)
    const unroled = decls
      .filter(decl => !ROLES.some(role => decl.selector.endsWith(role.selector) && role.property === decl.property))
      .filter(decl => !DEBT.some(debt => decl.selector.endsWith(debt.selector) && decl.property === debt.property))
      .map(decl => `${decl.selector} { ${decl.property}: var(${decl.token}) }`)
    expect(unroled, 'colours the views paint with no contrast role assigned').toEqual([])
  })

  it('carries no debt that nothing needs any more', () => {
    const decls = jsonInks()
    const stale = DEBT
      .filter(debt => !decls.some(decl => decl.selector.endsWith(debt.selector) && decl.property === debt.property && decl.token === debt.token))
      .map(debt => `${debt.selector} ${debt.property}:var(${debt.token})`)
    expect(stale, 'debt entries whose rule has already been fixed — delete them').toEqual([])
  })

  for (const theme of ['light', 'dark'] as Theme[]) {
    for (const white of [false, true]) {
      const label = white ? `${theme} on a white page` : theme
      it(`keeps every text role legible in ${label}`, () => {
        const tokens = palette(theme, white)
        const backgrounds = surfaces(theme, white)
        const decls = jsonInks()
        const failures: string[] = []
        for (const role of ROLES) {
          const declaration = inkFor(decls, role)
          const ink = resolve(tokens, declaration.token)
          for (const name of role.on) {
            const base = backgrounds.get(name)
            if (!base) throw new Error(`${name} is not a background this gate resolves`)
            const ratio = contrast(ink, base)
            if (ratio < role.floor) failures.push(`${declaration.selector} ${declaration.property}:var(${declaration.token}) on ${name} = ${ratio} (floor ${role.floor})`)
          }
        }
        expect(failures, `roles below their floor in ${label}`).toEqual([])
      })
    }
  }

  it('measures the depth the key colour had to move to', () => {
    const tokens = palette('light', false)
    const key = resolve(tokens, inkFor(jsonInks(), ROLES[0]!).token)
    const card = resolve(tokens, '--bg-surface')
    expect(contrast(key, card)).toBeGreaterThanOrEqual(4.5)
    // The value that shipped is pinned so the reason this test exists stays legible: 3.49:1, under AA.
    expect(contrast(parseColour('#e36209')!, card)).toBe(3.49)
  })
})
