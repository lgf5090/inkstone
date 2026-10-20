import { describe, expect, it } from 'vitest'
import { EmojiTaskSerializer } from '../serializer/emoji'
import { StatusRegistry } from '../status/registry'
import { extractTaskComponents, parseTaskLine, toMarkdownLine, type Task } from './task'
import { unknownPosition } from './task-location'
import { filenameOf, folderOf, rootOf } from './task'
import { urgencyOf } from './urgency'
import { dateKey } from '../../../lib/time'

const serializer = new EmojiTaskSerializer()
const registry = new StatusRegistry()
const NOW = new Date(2026, 9, 19)

function parse(line: string, options: { fallbackDate?: Date | null } = {}): Task | null {
  return parseTaskLine(line, unknownPosition('n1', 'Inbox/Note.md'), {
    registry,
    serializer,
    now: NOW,
    fallbackDate: options.fallbackDate ?? null,
  })
}

describe('task line parsing', () => {
  it('separates the markdown from the body', () => {
    const parts = extractTaskComponents('  - [ ] write the plan')
    expect(parts).not.toBeNull()
    expect(parts!.indentation).toBe('  ')
    expect(parts!.listMarker).toBe('-')
    expect(parts!.statusSymbol).toBe(' ')
    expect(parts!.body).toBe('write the plan')
  })

  it('holds a block link and a hard break apart from the description', () => {
    const task = parse('- [ ] anchored ^my-id  ')!
    expect(task.fields.description).toBe('anchored')
    expect(task.blockLink).toBe(' ^my-id')
    expect(task.hardBreak).toBe('  ')
    expect(toMarkdownLine(task, serializer)).toBe('- [ ] anchored ^my-id  ')
  })

  it('round-trips a full line without moving anything', () => {
    const line = '> 3. [/] ship it #work 🆔 abc ⛔ def 🔺 🔁 every week ➕ 2026-10-01 📅 2026-10-04 ✅ 2026-10-06'
    const task = parse(line)!
    expect(toMarkdownLine(task, serializer)).toBe(line)
    expect(task.status.symbol).toBe('/')
    expect(task.status.type).toBe('IN_PROGRESS')
    expect(task.fields.tags).toEqual(['#work'])
  })

  it('gives an unregistered character a type rather than dropping the task', () => {
    const task = parse('- [★] odd status')!
    expect(task.status.type).toBe('TODO')
    expect(task.status.name).toBe('UNKNOWN (★)')
  })

  it('refuses a line with no checkbox', () => {
    expect(parse('- just a list item')).toBeNull()
    expect(parse('not a list at all')).toBeNull()
  })
})

describe('inferred schedule', () => {
  it('borrows the filename day only when the line states no date', () => {
    const withFallback = parse('- [ ] undated thing', { fallbackDate: new Date(2026, 9, 7) })!
    expect(dateKey(withFallback.fields.scheduledDate!)).toBe('2026-10-07')
    expect(withFallback.scheduledDateIsInferred).toBe(true)
    expect(toMarkdownLine(withFallback, serializer)).toBe('- [ ] undated thing')

    const dated = parse('- [ ] dated 📅 2026-10-04', { fallbackDate: new Date(2026, 9, 7) })!
    expect(dated.scheduledDateIsInferred).toBe(false)
    expect(dated.fields.scheduledDate).toBeNull()
  })
})

describe('recurrence on a parsed task', () => {
  it('anchors the rule on the due date that was read from the same line', () => {
    const task = parse('- [ ] standup 🔁 every week 📅 2026-10-19')!
    expect(task.recurrence).not.toBeNull()
    expect(task.recurrence!.toText()).toBe('every week')
    const next = task.recurrence!.next(NOW)
    expect(next?.dueDate === null ? null : dateKey(next!.dueDate)).toBe('2026-10-26')
  })

  it('leaves a half-typed rule unparsed rather than guessing', () => {
    const task = parse('- [ ] typing 🔁 every')!
    expect(task.recurrence).toBeNull()
    expect(task.fields.recurrenceRuleText).toBe('every')
    expect(toMarkdownLine(task, serializer)).toBe('- [ ] typing 🔁 every')
  })
})

describe('urgency', () => {
  function score(line: string): number {
    return urgencyOf(parse(line)!, NOW)
  }

  it('gives an undated, unprioritised task the neutral score', () => {
    expect(score('- [ ] plain')).toBeCloseTo(1.95, 5)
  })

  it('rises as a due date slips into the past', () => {
    expect(score('- [ ] due 📅 2026-10-19')).toBeCloseTo(10.75, 5)
    expect(score('- [ ] late 📅 2026-10-09')).toBeCloseTo(13.95, 5)
    expect(score('- [ ] far 📅 2026-12-19')).toBeCloseTo(4.35, 5)
  })

  it('orders priorities the way the reference plugin does', () => {
    expect(score('- [ ] 🔺')).toBeCloseTo(9, 5)
    expect(score('- [ ] ⏫')).toBeCloseTo(6, 5)
    expect(score('- [ ] 🔼')).toBeCloseTo(3.9, 5)
    expect(score('- [ ] plain')).toBeCloseTo(1.95, 5)
    expect(score('- [ ] 🔽')).toBeCloseTo(0, 5)
    expect(score('- [ ] ⏬')).toBeCloseTo(-1.8, 5)
  })

  it('counts a scheduled date that has arrived and a start date that has not', () => {
    expect(score('- [ ] ⏳ 2026-10-19')).toBeCloseTo(6.95, 5)
    expect(score('- [ ] 🛫 2026-10-25')).toBeCloseTo(-1.05, 5)
  })

  it('ignores a date that names no real day', () => {
    expect(score('- [ ] 📅 2022-02-30')).toBeCloseTo(1.95, 5)
  })
})

describe('path helpers', () => {
  it('splits a note path the way grouping and the backlink expect', () => {
    const task = parse('- [ ] x')!
    task.location.path = 'Work/Projects/Alpha/Note.md'
    expect(filenameOf(task)).toBe('Note.md')
    expect(rootOf(task)).toBe('Work')
    expect(folderOf(task)).toBe('Work/Projects/Alpha')
    task.location.path = 'Loose.md'
    expect(filenameOf(task)).toBe('Loose.md')
    expect(rootOf(task)).toBe('Loose.md')
    expect(folderOf(task)).toBe('')
  })
})
