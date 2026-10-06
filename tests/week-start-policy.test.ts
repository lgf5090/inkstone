import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Which weekday opens a calendar is derived once, from `Intl` locale data, in `src/client/lib/time.ts`.
 *
 * Before that, the answer was written out per component — and it was the same wrong sentence each
 * time: `locale === 'zh-CN' ? 1 : 0` names the two languages this app ships, so a German or Arabic
 * reader would have gotten Sunday, and the grid, its header and the picker each carried their own
 * copy of the labels. A fix that only changes one of those copies leaves the reader with a month
 * grid whose columns disagree with the row above it, which is exactly what happened inside the
 * kanban module (K2-04b fixed the picker, K2-04g1 the view). These cases keep the next calendar
 * from re-deriving the week on its own.
 */
const CLIENT_ROOT = path.resolve('src/client')
const OWNER = path.join('lib', 'time.ts')

const RULES = [
  { name: 'a week start read off the language code', pattern: /weekStart[^\n]*locale\s*===/ },
  { name: 'a second reader of the locale week data', pattern: /getWeekInfo/ },
  { name: 'a second narrow weekday label builder', pattern: /weekday:\s*'narrow'/ },
]

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return []
    return [full]
  })
}

function offenders(pattern: RegExp): string[] {
  return sourceFiles(CLIENT_ROOT)
    .filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(CLIENT_ROOT, file))
    .filter((file) => file !== OWNER)
}

describe('the week-start derivation has exactly one home', () => {
  it.each(RULES)('$name does not appear outside it', ({ pattern }) => {
    expect(offenders(pattern)).toEqual([])
  })

  it('sees each shape it claims, so no rule passes by matching nothing', () => {
    expect(RULES[0].pattern.test('const weekStart = locale === \'zh-CN\' ? 1 : 0')).toBe(true)
    expect(RULES[0].pattern.test('weekStart={locale === \'zh-CN\' ? 1 : 0}')).toBe(true)
    expect(RULES[1].pattern.test('const firstDay = locale.getWeekInfo?.()?.firstDay')).toBe(true)
    expect(RULES[2].pattern.test('new Intl.DateTimeFormat(locale, { weekday: \'narrow\' })')).toBe(true)
  })

  it('finds both derivations in its owner, so the scan has somewhere to point', () => {
    const owner = fs.readFileSync(path.join(CLIENT_ROOT, OWNER), 'utf8')
    expect(RULES[1].pattern.test(owner), OWNER).toBe(true)
    expect(RULES[2].pattern.test(owner), OWNER).toBe(true)
  })
})
