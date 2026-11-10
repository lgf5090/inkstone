// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = 'src/client/features/project'

/**
 * The project app draws its selects with the app's own menu.
 *
 * A native `<select>` cannot carry an option's colour dot or the accent state the rest of the app
 * uses, and its system chrome ignores every design token. `SelectMenu` exists for exactly this and
 * is what the other features use; this app was the last one still on the browser control, which is
 * why its status pickers read as grey text where the reference shows a coloured pill.
 */
describe('the project app\'s selects', () => {
  it('draws every one with SelectMenu rather than the browser control', () => {
    const offenders = readdirSync(DIR)
      .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
      .filter((name) => /<Select[\s>]/.test(readFileSync(join(DIR, name), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('imports SelectMenu in every file that draws one', () => {
    const drawing = readdirSync(DIR)
      .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
      .filter((name) => readFileSync(join(DIR, name), 'utf8').includes('<SelectMenu'))
    expect(drawing.length).toBeGreaterThan(0)
    for (const name of drawing) {
      expect(readFileSync(join(DIR, name), 'utf8'), name).toContain("from '../../components/select-menu'")
    }
  })
})