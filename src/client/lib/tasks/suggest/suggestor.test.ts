import { describe, expect, it } from 'vitest'
import { StatusRegistry } from '../status/registry'
import { canSuggestForLine, generateUniqueId, lastOpenBracket, suggestFor } from './suggestor'

const NOW = new Date(2026, 9, 19) // a Monday
const cp = (...codes: number[]): string => String.fromCodePoint(...codes)
const DUE = cp(0x1F4C5)
const START = cp(0x1F6EB)
const SCHEDULED = cp(0x23F3)
const RECUR = cp(0x1F501)
const ON_DONE = cp(0x1F3C1)
const CREATED = cp(0x2795)
const HIGH = cp(0x23EB)
const MEDIUM = cp(0x1F53C)
const LOW = cp(0x1F53D)
const HIGHEST = cp(0x1F53A)
const LOWEST = cp(0x23EC)

function menu(line: string, cursor = line.length, settings = {}, extra = {}) {
  return suggestFor({ line, cursorPos: cursor, now: NOW, settings: { autoSuggestMaxItems: 20, ...settings }, ...extra })
}

const texts = (items: ReturnType<typeof menu>): string[] => items.map((item) => item.displayText)

describe('the field menu', () => {
  it('offers the fields a bare task line does not have, and an escape row first', () => {
    const out = menu('- [ ] some task ')
    expect(out[0]).toEqual({ suggestionType: 'empty', displayText: '⏎', appendText: '\n' })
    expect(texts(out)).toEqual([
      '⏎',
      `${DUE} due date`,
      `${START} start date`,
      `${SCHEDULED} scheduled date`,
      `${HIGH} high priority`,
      `${MEDIUM} medium priority`,
      `${LOW} low priority`,
      `${HIGHEST} highest priority`,
      `${LOWEST} lowest priority`,
      `${RECUR} recurring (repeat)`,
      `${CREATED} created today (${format(2026, 10, 19)})`,
      `${ID} id`,
      `${DEPENDS} depends on id`,
      `${ON_DONE} on completion`,
    ])
  })

  it('stops offering a field the line already carries', () => {
    const out = menu(`- [ ] some task ${DUE} 2026-10-20 `)
    expect(texts(out)).not.toContain(`${DUE} due date`)
    expect(texts(out)).toContain(`${RECUR} recurring (repeat)`)
  })

  it('does not offer the priority family once one priority is on the line', () => {
    const out = menu(`- [ ] some task ${HIGH} `)
    expect(texts(out).some((text) => text.includes('priority'))).toBe(false)
  })
})

describe('the date menu after a date symbol', () => {
  it('completes an empty date field with the days a reader means', () => {
    const line = `- [ ] some task ${DUE}`
    const out = menu(line)
    expect(out[0]).toEqual({
      suggestionType: 'match',
      displayText: `today (${format(2026, 10, 19)})`,
      appendText: `${DUE} ${format(2026, 10, 19)} `,
      insertAt: 16,
      insertSkip: 2,
    })
    expect(texts(out).some((text) => text.startsWith('tomorrow'))).toBe(true)
  })

  it('answers the day the typed words name, ahead of the generic list', () => {
    const out = menu(`- [ ] some task ${DUE} 27 oct`)
    expect(out[0]?.displayText).toBe(format(2026, 10, 27))
    expect(out[0]?.appendText).toBe(`${DUE} ${format(2026, 10, 27)} `)
  })

  it('looks forward for a weekday, so a Sunday typed on Monday means next Sunday', () => {
    const out = menu(`- [ ] some task ${DUE} sunday`)
    expect(out[0]?.displayText).toBe(format(2026, 10, 25))
  })

  it('waits for the reader to type enough before filtering', () => {
    expect(menu(`- [ ] some task ${DUE} t`, undefined, { autoSuggestMinMatch: 3 })).toEqual([])
    const out = menu(`- [ ] some task ${DUE} tod`, undefined, { autoSuggestMinMatch: 3 })
    expect(texts(out).some((text) => text.startsWith('today'))).toBe(true)
  })
})

describe('the recurrence menu', () => {
  it('offers the rules, and narrows them to what was typed', () => {
    const out = menu(`- [ ] some task ${RECUR} every we`)
    // The rule text is handed to the recurrence parser, which reads `we` as Wednesday — the menu shows
    // what would actually be written, not a string guess.
    expect(out[0]?.suggestionType).toBe('match')
    expect(out[0]?.appendText.startsWith(`${RECUR} every`)).toBe(true)
    expect(texts(out).some((text) => text.includes('every week on Sunday'))).toBe(true)
  })

  it('shows a complete rule as a match, then stops offering one', () => {
    const mid = menu(`- [ ] some task ${RECUR} every d`)
    expect(mid.some((item) => item.suggestionType === 'match' && item.appendText.includes('every day'))).toBe(true)
    // The rule is already finished and the caret sits past it: the reader is typing on, so nothing
    // about recurrence is offered any more — and the field it completes is no longer missing either.
    const done = menu(`- [ ] some task ${RECUR} every week `)
    expect(done.some((item) => item.suggestionType === 'match' && item.appendText.includes(RECUR))).toBe(false)
    expect(texts(done)).not.toContain(`${RECUR} recurring (repeat)`)
  })
})

describe('the on-completion menu', () => {
  it('offers the two actions', () => {
    expect(texts(menu(`- [ ] some task ${ON_DONE} de`))).toContain('delete')
    expect(texts(menu(`- [ ] some task ${ON_DONE} k`))).toContain('keep')
  })
})

describe('the id menu', () => {
  it('offers to mint one when the symbol is standing alone', () => {
    const line = `- [ ] some task ${ID}`
    const out = menu(line)
    const generated = out.find((item) => item.displayText === 'generate unique id')
    expect(generated?.appendText).toMatch(new RegExp(`^${ID} [a-z0-9]{4} $`))
  })
})

describe('where the menu may appear', () => {
  const registry = new StatusRegistry()

  it('waits until the caret is past the checkbox', () => {
    const line = '- [ ] write the plan'
    expect(canSuggestForLine(line, 2, registry, '')).toBe(false)
    expect(canSuggestForLine(line, line.length, registry, '')).toBe(true)
  })

  it('stays out of a line that is not a task', () => {
    expect(canSuggestForLine('just prose, with a cursor at the end', 35, registry, '')).toBe(false)
    expect(canSuggestForLine('- a plain bullet item', 20, registry, '')).toBe(false)
  })

  it('stays out of a line whose status the reader declared is not a task', () => {
    expect(canSuggestForLine('- [ ] write the plan', 12, registry, '#task')).toBe(false)
    expect(canSuggestForLine('- [ ] #task write the plan', 12, registry, '#task')).toBe(true)
  })

  it('does not open on an empty line', () => {
    expect(canSuggestForLine('', 0, registry, '')).toBe(false)
  })
})

describe('brackets', () => {
  it('report which one is still open, and close it when the reader picks a field', () => {
    expect(lastOpenBracket('due [due:: 2026', [['(', ')'], ['[', ']']])).toBe('[')
    expect(lastOpenBracket('due [due:: 2026-10-19]', [['(', ')'], ['[', ']']])).toBeNull()
    const out = suggestFor({
      line: `- [ ] some task [due:: ${DUE}`,
      cursorPos: `- [ ] some task [due:: ${DUE}`.length,
      now: NOW,
      settings: { autoSuggestMaxItems: 20 },
      dataviewMode: true,
    })
    expect(out.some((item) => item.appendText.endsWith('] '))).toBe(true)
  })
})

describe('ids', () => {
  it('are four characters and not one already in the note', () => {
    const id = generateUniqueId(['aaaa', 'bbbb'])
    expect(id).toMatch(/^[a-z0-9]{4}$/)
    expect(id).not.toBe('aaaa')
  })
})

const ID = cp(0x1F194)
const DEPENDS = cp(0x26D4)

function format(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
