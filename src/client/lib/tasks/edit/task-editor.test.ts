import { describe, expect, it } from 'vitest'
import { parseTaskLine, toMarkdownLine } from '../model/task'
import { unknownPosition } from '../model/task-location'
import { EmojiTaskSerializer } from '../serializer/emoji'
import { StatusRegistry } from '../status/registry'
import { Priority } from '../model/priority'
import type { Task } from '../model/task'
import type { ToggleSettings } from '../toggle'
import { applyDraft, describeRecurrence, draftFromTask, type TaskDraft } from './task-editor'

const NOW = new Date(2026, 9, 19) // a Monday
const cp = (...codes: number[]): string => String.fromCodePoint(...codes)
const DUE = cp(0x1F4C5)
const DONE_MARK = cp(0x2705)
const RECUR = cp(0x1F501)
const HIGH = cp(0x23EB)

const registry = new StatusRegistry()

function settings(overrides: Partial<ToggleSettings> = {}): ToggleSettings {
  return {
    registry,
    serializer: new EmojiTaskSerializer(),
    setDoneDate: true,
    setCancelledDate: true,
    setCreatedDate: false,
    recurrenceOnNextLine: false,
    recursiveSubTaskCompletion: false,
    ...overrides,
  }
}

function parse(line: string): Task {
  return parseTaskLine(line, unknownPosition('', ''), { registry, serializer: new EmojiTaskSerializer(), now: NOW })!
}

function edit(
  line: string,
  change: (draft: TaskDraft) => TaskDraft,
  statusSymbol = ' ',
  config = settings(),
  options = {},
) {
  const task = parse(line)
  const draft = change(draftFromTask(task))
  return applyDraft(task, draft, registry.bySymbolOrCreate(statusSymbol), config, NOW, options)
}

describe('opening a task for editing', () => {
  it('hands every field back as text', () => {
    const draft = draftFromTask(parse(`- [ ] pay rent ${HIGH} ${DUE} 2026-10-21`))
    expect(draft.description).toBe('pay rent')
    expect(draft.priority).toBe(Priority.High)
    expect(draft.dates.dueDate).toBe('2026-10-21')
    expect(draft.dates.doneDate).toBe('')
    expect(draft.statusSymbol).toBe(' ')
  })

  it('takes the global filter out of the words the reader sees', () => {
    const draft = draftFromTask(parse('- [ ] #task buy milk'), '#task')
    expect(draft.description).toBe('buy milk')
  })
})

describe('saving a draft', () => {
  it('writes back only what was changed', () => {
    const out = edit(`- [ ] pay rent ${HIGH} ${DUE} 2026-10-21`, (draft) => ({ ...draft, description: 'pay the rent' }))
    expect(out.errors.dates).toEqual({})
    expect(out.tasks).toHaveLength(1)
    expect(toMarkdownLine(out.tasks[0]!, new EmojiTaskSerializer()))
      .toBe(`- [ ] pay the rent ${HIGH} ${DUE} 2026-10-21`)
  })

  it('refuses to invent a day out of half-typed text, and names the field', () => {
    const out = edit(`- [ ] pay rent ${DUE} 2026-10-21`, (draft) => ({
      ...draft,
      dates: { ...draft.dates, dueDate: 'the 32nd of what' },
    }))
    expect(out.tasks).toEqual([])
    expect(out.errors.dates.dueDate).toBe(true)
  })

  it('reads a natural-language date, and only ever a coming one', () => {
    // From Monday the 19th, `friday` is the 23rd: a reader adding a due date does not mean a past one.
    const out = edit('- [ ] standup', (draft) => ({ ...draft, dates: { ...draft.dates, dueDate: 'friday' } }))
    expect(toMarkdownLine(out.tasks[0]!, new EmojiTaskSerializer())).toBe(`- [ ] standup ${DUE} 2026-10-23`)
  })

  it('keeps the date the reader typed instead of stamping today when the status is done', () => {
    const out = edit(
      `- [ ] pay rent ${DUE} 2026-10-05`,
      (draft) => ({ ...draft, dates: { ...draft.dates, doneDate: '2026-10-12' } }),
      'x',
    )
    expect(toMarkdownLine(out.tasks[0]!, new EmojiTaskSerializer()))
      .toBe(`- [x] pay rent ${DUE} 2026-10-05 ${DONE_MARK} 2026-10-12`)
  })

  it('produces the next instance from the dates as edited, not as they were', () => {
    const out = edit(
      `- [ ] water ${RECUR} every week ${DUE} 2026-10-19`,
      (draft) => ({ ...draft, dates: { ...draft.dates, dueDate: '2026-10-25' } }),
      'x',
    )
    const lines = out.tasks.map((task) => toMarkdownLine(task, new EmojiTaskSerializer()))
    expect(lines).toHaveLength(2)
    expect(lines.some((line) => line.includes('[x]') && line.includes(`${DUE} 2026-10-25`))).toBe(true)
    expect(lines.some((line) => line.includes('[ ]') && line.includes(`${DUE} 2026-11-01`))).toBe(true)
  })

  it('puts the global filter back on a line the form showed without it', () => {
    const out = edit('- [ ] #task buy milk', (draft) => ({ ...draft, description: 'buy the milk' }), ' ', settings(), { globalFilter: '#task' })
    const line = toMarkdownLine(out.tasks[0]!, new EmojiTaskSerializer())
    expect(line).toContain('- [ ] #task buy the milk')
  })

  it('leaves a line alone when the vault has no global filter', () => {
    const out = edit('- [ ] buy milk', (draft) => ({ ...draft, description: 'buy the milk' }))
    expect(toMarkdownLine(out.tasks[0]!, new EmojiTaskSerializer())).toBe('- [ ] buy the milk')
  })
})

describe('the recurrence preview', () => {
  it('answers with the rule the model would write, or why it cannot', () => {
    expect(describeRecurrence({ ...draftFromTask(parse('- [ ] x')), recurrenceRule: 'every month' }, NOW))
      .toEqual({ text: 'every month', problem: 'none' })
    expect(describeRecurrence({ ...draftFromTask(parse('- [ ] x')), recurrenceRule: 'every blursday' }, NOW).problem)
      .toBe('invalid')
  })

  it('refuses a recurring draft that has no date to recur from', () => {
    const out = edit('- [ ] x', (draft) => ({ ...draft, recurrenceRule: 'every week' }))
    expect(out.tasks).toEqual([])
    expect(out.errors.recurrence).toBe('needs-a-date')
  })
})
