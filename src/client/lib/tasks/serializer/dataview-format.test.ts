import { describe, expect, it } from 'vitest'
import { DataviewTaskSerializer } from './dataview-format'
import { EmojiTaskSerializer } from './emoji'
import { Priority } from '../model/priority'
import { OnCompletion } from '../model/on-completion'
import { dateKey } from '../../../lib/time'

const dv = new DataviewTaskSerializer()
const emoji = new EmojiTaskSerializer()

describe('dataview inline-field format', () => {
  it('reads both bracket styles and any field order', () => {
    const square = dv.deserialize('plan it [due:: 2026-10-04] [priority:: high] #work')
    expect(square.description).toBe('plan it #work')
    expect(dateKey(square.dueDate!)).toBe('2026-10-04')
    expect(square.priority).toBe(Priority.High)

    const round = dv.deserialize('plan it (due:: 2026-10-04) [repeat:: every week]')
    expect(dateKey(round.dueDate!)).toBe('2026-10-04')
    expect(round.recurrenceRuleText).toBe('every week')
  })

  it('reads the six dates, id, depends on and on completion', () => {
    const fields = dv.deserialize('x [created:: 2026-10-01] [start:: 2026-10-02] [scheduled:: 2026-10-03] [due:: 2026-10-04] [cancelled:: 2026-10-05] [completion:: 2026-10-06] [id:: abc] [dependsOn:: def, ghi] [onCompletion:: delete]')
    expect([fields.createdDate, fields.startDate, fields.scheduledDate, fields.dueDate, fields.cancelledDate, fields.doneDate]
      .map((date) => date === null ? 'null' : dateKey(date)))
      .toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'])
    expect(fields.id).toBe('abc')
    expect(fields.dependsOn).toEqual(['def', 'ghi'])
    expect(fields.onCompletion).toBe(OnCompletion.Delete)
    expect(fields.description).toBe('x')
  })

  it('keeps a date that names no real day', () => {
    const fields = dv.deserialize('typo [due:: 2022-02-30]')
    expect(Number.isNaN(fields.dueDate!.getTime())).toBe(true)
    expect(fields.invalidDates.dueDate).toBe('2022-02-30')
    expect(dv.serialize(fields)).toBe('typo [due:: 2022-02-30]')
  })

  it('writes canonical square fields in a fixed order', () => {
    expect(dv.serialize(dv.deserialize('x (due:: 2026-10-04) [priority:: high] [completion:: 2026-10-06]')))
      .toBe('x [priority:: high] [due:: 2026-10-04] [completion:: 2026-10-06]')
  })

  it('omits a priority that is none, rather than writing it out', () => {
    expect(dv.serialize(dv.deserialize('plain [due:: 2026-10-04]'))).toBe('plain [due:: 2026-10-04]')
  })

  it('never writes an inferred scheduled date', () => {
    const fields = dv.deserialize('x')
    fields.scheduledDate = new Date(2026, 9, 7)
    expect(dv.serialize(fields, { scheduledDateIsInferred: true })).toBe('x')
    expect(dv.serialize(fields)).toBe('x [scheduled:: 2026-10-07]')
  })
})

describe('the two formats agree', () => {
  it('parse the same task to the same fields', () => {
    const fromEmoji = emoji.deserialize('review 🔺 🔁 every week ➕ 2026-10-01 📅 2026-10-04 ✅ 2026-10-06')
    const fromDataview = dv.deserialize('review [priority:: highest] [repeat:: every week] [created:: 2026-10-01] [due:: 2026-10-04] [completion:: 2026-10-06]')
    expect(fromDataview.description).toBe(fromEmoji.description)
    expect(fromDataview.priority).toBe(fromEmoji.priority)
    expect(fromDataview.recurrenceRuleText).toBe(fromEmoji.recurrenceRuleText)
    expect(fromDataview.createdDate?.getTime()).toBe(fromEmoji.createdDate?.getTime())
    expect(fromDataview.dueDate?.getTime()).toBe(fromEmoji.dueDate?.getTime())
    expect(fromDataview.doneDate?.getTime()).toBe(fromEmoji.doneDate?.getTime())
  })
})
