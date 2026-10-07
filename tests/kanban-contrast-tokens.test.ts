import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio, parseColor } from '../scripts/lib/contrast.mjs'
import { TOKENS_PATH, accentVars, accentNames, themeVars } from '../scripts/lib/theme-tokens.mjs'
import { KANBAN_COLOR_NAMES } from '../src/client/lib/markdown/kanban/colors'

/**
 * The board paints text on filled shapes: today's date on the accent (and, in
 * the timeline and gantt headers, on `--danger`), a tick on the colour the user
 * picked, initials on the accent. Hardcoding white for those looked right in
 * the light theme and fell apart in the dark one, where every fill is a light
 * colour — so the rule the board has to keep is the one the rest of the app
 * already keeps: text on a fill uses that fill's own contrast token, and the
 * pair must clear AA for every accent a session can be switched to.
 */
const TOKENS = fs.readFileSync(TOKENS_PATH, 'utf8')
const KANBAN_SOURCE_DIR = 'src/client/lib/markdown/kanban'
const AA_NORMAL = 4.5
const BANNED_TEXT_COLOR = /\btext-(?:white|black)\b|text-\[#[0-9a-f]{3,8}\]/i

function walkSources(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) out = walkSources(target, out)
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(target)
  }
  return out
}

const rgbOf = (vars, name) => parseColor(vars.get(name)).rgb

describe('kanban fill/text contrast pairs', () => {
  it('keeps the accent contrast legible on every accent, in both themes', () => {
    const accents = accentNames(TOKENS)
    expect(accents.length).toBeGreaterThan(1)
    const failures: string[] = []
    for (const theme of ['light', 'dark']) {
      for (const accent of accents) {
        const vars = accentVars(theme, accent, TOKENS)
        const ratio = contrastRatio(rgbOf(vars, '--accent-contrast'), rgbOf(vars, '--accent'))
        if (ratio < AA_NORMAL) failures.push(`${theme} ${accent}: ${ratio.toFixed(2)}:1`)
      }
    }
    expect(failures).toEqual([])
  })

  it('keeps the contrast colour legible on every label colour the picker offers', () => {
    const failures: string[] = []
    for (const theme of ['light', 'dark']) {
      const vars = themeVars(theme, TOKENS)
      for (const name of KANBAN_COLOR_NAMES) {
        const ratio = contrastRatio(rgbOf(vars, '--accent-contrast'), rgbOf(vars, `--kanban-tag-${name}-fg`))
        if (ratio < AA_NORMAL) failures.push(`${theme} ${name}: ${ratio.toFixed(2)}:1`)
      }
    }
    expect(failures).toEqual([])
  })

  it('paints no text colour the token layer did not authorise', () => {
    const offenders: string[] = []
    for (const file of walkSources(KANBAN_SOURCE_DIR)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const line of text.split('\n')) {
        if (BANNED_TEXT_COLOR.test(line)) offenders.push(`${file}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
