import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Z_INDEX } from '../src/client/lib/z-index'
import { DEBOUNCE } from '../src/shared/constants'

/**
 * The shared layer's own contract, read off the files that define it: `styles/tokens.css`,
 * `lib/z-index.ts` and the `DEBOUNCE` group in `src/shared/constants.ts`.
 *
 * The audit this came out of found four authorities disagreeing about stack levels — the CSS token
 * scale, raw `z-index:` numbers in stylesheets, `z-[N]` in tsx, and a JS map with three keys — and
 * focus rings spelled by hand at two thicknesses in five places. Naming a scale does not keep it true;
 * only a check does. These cases are that check, and they are deliberately narrow: they police the
 * layer every feature shares, where one more hand-picked number is copied a hundred times.
 */

const TOKENS = 'src/client/styles/tokens.css'
const COMPONENTS = path.join('src', 'client', 'components')

/** A `--z-*: <integer>` band, and where it sits in the file. */
interface Band {
  name: string
  value: number
  line: number
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

function bands(source: string): Band[] {
  const out: Band[] = []
  for (const match of source.matchAll(/--z-([a-z0-9-]+)\s*:\s*(\d+)\s*;/g)) {
    out.push({
      name: `--z-${match[1]}`,
      value: Number(match[2]),
      line: source.slice(0, match.index).split('\n').length,
    })
  }
  return out
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Relative, forward-slashed, so a failure reads the same on every platform. */
function show(file: string): string {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

/**
 * The two JS keys whose spelling the CSS scale has already moved past. Each is pinned to the band it
 * actually carries, so the mismatch is on the record rather than in the dark — and so paying it off
 * (renaming the call site, deleting the key) fails here until the entry goes too.
 */
const LEGACY_JS_BAND_NAMES = new Map<string, string>([
  ['menu', '--z-pop'],
  ['hoverPinned', '--z-pinned'],
])

const TOKEN_BANDS = bands(read(TOKENS))

describe('the stacking scale is one source of truth', () => {
  it('defines every band the scale is meant to cover', () => {
    const names = TOKEN_BANDS.map((band) => band.name)
    expect(names).toEqual(expect.arrayContaining([
      '--z-sticky', '--z-menu', '--z-float', '--z-popover', '--z-drawer', '--z-panel',
      '--z-workspace', '--z-prompt', '--z-modal', '--z-picker', '--z-pop', '--z-submenu',
      '--z-hover-card', '--z-pinned', '--z-pinned-menu', '--z-toast', '--z-tooltip',
      '--z-peek', '--z-top',
    ]))
  })

  it('lists the bands in ascending order, with no value used twice', () => {
    // Reading the file top to bottom is the order a person learns the scale from, so a band written out
    // of sequence is as much a failure as two bands sharing a number.
    const ascending = TOKEN_BANDS.every((band, index) => index === 0 || TOKEN_BANDS[index - 1]!.value < band.value)
    expect(ascending, `bands out of order: ${TOKEN_BANDS.map((b) => `${b.name}=${b.value}`).join(' ')}`).toBe(true)
    const shared = TOKEN_BANDS.map((band) => band.value).filter((value, index, all) => all.indexOf(value) !== index)
    expect(shared).toEqual([])
  })

  it('defines each band exactly once', () => {
    // A second definition anywhere — a theme override, a stray rule later in the sheet — silently
    // retunes a tier for the half of the app that reads it after the cascade reaches it.
    const duplicated = TOKEN_BANDS.map((band) => band.name)
      .filter((name, index, all) => all.indexOf(name) !== index)
    expect(duplicated).toEqual([])
  })

  it('mirrors the scale in z-index.ts, value for value', () => {
    const values = new Map(TOKEN_BANDS.map((band) => [band.value, band.name]))
    const dangling = Object.entries(Z_INDEX)
      .filter(([key, value]) => values.get(value as number) === undefined)
      .map(([key, value]) => {
        const legacy = LEGACY_JS_BAND_NAMES.get(key)
        return legacy ? `${key}=${String(value)} (has no band named ${legacy} either)` : `${key}=${String(value)}`
      })
    expect(dangling, `a JS tier with no matching --z-* band`).toEqual([])
  })

  it('names each JS tier after the band it carries, except the two on record', () => {
    // camelCase key → kebab token, the spelling the scale uses. A key that names a different band than
    // the number it holds is how `menu` came to mean 260 while `--z-menu` meant 20.
    const byValue = new Map(TOKEN_BANDS.map((band) => [band.value, band.name]))
    const mismatches = Object.entries(Z_INDEX).flatMap(([key, value]) => {
      const token = byValue.get(value as number)!
      const expected = `--z-${key.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
      if (token === expected) return []
      return LEGACY_JS_BAND_NAMES.has(key) ? [] : [`${key}=${String(value)} names ${token}`]
    })
    expect(mismatches).toEqual([])
  })

  it('keeps the recorded JS rename debt actually outstanding', () => {
    // Both directions, like every other allowlist in this repo: an entry whose key has been renamed
    // away has to be deleted the moment it is paid off.
    for (const [key, token] of LEGACY_JS_BAND_NAMES) {
      expect(Z_INDEX, `${key} is on the rename list but no longer a key`).toHaveProperty(key)
      const carried = TOKEN_BANDS.find((band) => band.name === token)!.value
      expect(Z_INDEX[key as keyof typeof Z_INDEX], `${key} no longer carries ${token}`).toBe(carried)
    }
    const stillLegacy = Object.keys(Z_INDEX).filter((key) => !key.startsWith('--'))
      .filter((key) => LEGACY_JS_BAND_NAMES.has(key))
    expect(stillLegacy.sort()).toEqual([...LEGACY_JS_BAND_NAMES.keys()].sort())
  })

  it('keeps the shared layer off hand-picked stack levels', () => {
    // `z-[327]` and `zIndex = 40` in the layer every feature copies from are how the four authorities
    // got to disagree in the first place.
    const offenders: string[] = []
    for (const file of sourceFiles(COMPONENTS)) {
      const source = read(file)
      source.split('\n').forEach((line, index) => {
        if (/z-\[\d+\]/.test(line) || /\bzIndex\s*[:=]\s*\d/.test(line)) {
          offenders.push(`${show(file)}:${index + 1}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('the focus ring is one token per role', () => {
  const ring = /(--shadow-ring(?:-focus)?)\s*:\s*0 0 0 (\d+)px var\(--accent-ring\);/g

  it('names a ring for a control and a ring for a field, at two measured thicknesses', () => {
    const spelled = [...read(TOKENS).matchAll(ring)].map((match) => ({ token: match[1]!, px: Number(match[2]) }))
    expect(spelled).toEqual([
      { token: '--shadow-ring', px: 2 },
      { token: '--shadow-ring-focus', px: 3 },
    ])
  })

  it('keeps the shared layer spelling its focus ring out of the token', () => {
    // Four sites used to write `0_0_0_3px_var(--accent-ring)` by hand and one wrote it at 2px; a fifth
    // thickness was one copy-paste away.
    const offenders = sourceFiles(COMPONENTS).flatMap((file) => {
      const source = read(file)
      return source.split('\n')
        .map((line, index) => ({ line, at: index + 1 }))
        .filter(({ line }) => /shadow-\[0_0_0_\d+px/.test(line) || /0 0 0 \d+px var\(--accent-ring\)/.test(line))
        .map(({ at }) => `${show(file)}:${at}`)
    })
    expect(offenders).toEqual([])
  })

  it('gives no surface a third ring thickness', () => {
    // Outside the shared layer the hand-spelled rings are still allowed to exist until their owners
    // move, but they may only be one of the two thicknesses on record — which is what stops the
    // disagreement from growing a fourth value. An `inset` spread is a hairline drawn inside a shape
    // (a code token's edge), not a ring around a focused control, so it is not this rule's business.
    const widths = new Set<number>()
    for (const file of sourceFiles(path.join('src', 'client'))) {
      const source = read(file)
      for (const match of source.matchAll(/shadow-\[0_0_0_(\d+)px|(?<!inset )0 0 0 (\d+)px var\(--accent-ring\)/g)) {
        widths.add(Number(match[1] ?? match[2]))
      }
    }
    expect([...widths].sort((a, b) => a - b)).toEqual([2, 3])
  })

  it('keeps the shared layer free of a numeric debounce it invented', () => {
    // `DEBOUNCE` in `src/shared/constants.ts` is the answer for a filter box, a preview repaint and a
    // settings write. Nothing in the shared layer should need a fourth number. Both hooks are read:
    // `useDebouncedDraft` is the same wait behind a draft box, and a rule that only looked at the other
    // one would be a door left open.
    const offenders = sourceFiles(COMPONENTS).flatMap((file) => {
      const source = read(file)
      return source.split('\n')
        .map((line, index) => ({ line, at: index + 1 }))
        .filter(({ line }) => /useDebounced(?:Draft)?\([^)]*,\s*\d/.test(line))
        .map(({ at }) => `${show(file)}:${at}`)
    })
    expect(offenders).toEqual([])
  })
})

describe('the debounce scale is one number per job', () => {
  it('names the three waits and orders them by what each is waiting for', () => {
    expect(Object.keys(DEBOUNCE).sort()).toEqual(['persist', 'render', 'search'])
    for (const [name, value] of Object.entries(DEBOUNCE)) {
      expect(Number.isInteger(value), `${name} is not a whole number of milliseconds`).toBe(true)
      expect(value, `${name} is not a wait at all`).toBeGreaterThan(0)
    }
    // A preview repaint reads text that is already on the screen, a filter waits a keystroke burst
    // out, and a write is the one thing a reader does not expect to see land immediately. A scale that
    // has those the wrong way round is a redesign, not a retune — which is what the six hand-picked
    // search values in front of this rule were.
    expect(DEBOUNCE.render < DEBOUNCE.search, 'a repaint may not wait longer than a filter').toBe(true)
    expect(DEBOUNCE.search < DEBOUNCE.persist, 'a write may not land sooner than a keystroke burst').toBe(true)
  })
})
