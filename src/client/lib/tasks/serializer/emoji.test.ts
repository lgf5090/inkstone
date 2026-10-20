import { describe, expect, it } from 'vitest'
import { EmojiTaskSerializer } from './emoji'
import { Priority } from '../model/priority'
import { OnCompletion } from '../model/on-completion'
import { dateKey } from '../../../lib/time'

const serializer = new EmojiTaskSerializer()

function parse(line: string) {
  return serializer.deserialize(line)
}

describe('emoji format reading', () => {
  it('leaves a plain description alone', () => {
    const fields = parse('write the plan')
    expect(fields.description).toBe('write the plan')
    expect(fields.priority).toBe(Priority.None)
    expect(fields.dueDate).toBeNull()
    expect(fields.tags).toEqual([])
  })

  it('reads every field regardless of the order they were written in', () => {
    const canonical = parse('ship it 🔺 🔁 every week ➕ 2026-10-01 🛫 2026-10-02 ⏳ 2026-10-03 📅 2026-10-04 ❌ 2026-10-05 ✅ 2026-10-06')
    expect(canonical.description).toBe('ship it')
    expect(canonical.priority).toBe(Priority.Highest)
    expect(canonical.recurrenceRuleText).toBe('every week')
    expect([canonical.createdDate, canonical.startDate, canonical.scheduledDate, canonical.dueDate, canonical.cancelledDate, canonical.doneDate]
      .map((date) => date === null ? 'null' : dateKey(date)))
      .toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'])

    const shuffled = parse('ship it ✅ 2026-10-06 📅 2026-10-04 🔺')
    expect(shuffled.priority).toBe(Priority.Highest)
    expect(shuffled.dueDate === null ? null : dateKey(shuffled.dueDate)).toBe('2026-10-04')
    expect(shuffled.doneDate === null ? null : dateKey(shuffled.doneDate)).toBe('2026-10-06')
    expect(shuffled.description).toBe('ship it')
  })

  it('accepts the alternate emoji and the spacing a reader actually types', () => {
    expect(dateKey(parse('a 📆 2026-10-04').dueDate!)).toBe('2026-10-04')
    expect(dateKey(parse('a 🗓 2026-10-04').dueDate!)).toBe('2026-10-04')
    expect(dateKey(parse('a ⌛ 2026-10-03').scheduledDate!)).toBe('2026-10-03')
    expect(dateKey(parse('a ⌚ 2026-10-03').scheduledDate!)).toBe('2026-10-03')
    expect(dateKey(parse('a ➕ 2026-10-01').createdDate!)).toBe('2026-10-01')
    expect(dateKey(parse('a ✕ 2026-10-01').createdDate!)).toBe('2026-10-01')
    expect(dateKey(parse('a ✅2026-10-06').doneDate!)).toBe('2026-10-06')
    expect(dateKey(parse('a ⏳  2026-10-03').scheduledDate!)).toBe('2026-10-03')
  })

  it('keeps an emoji that is part of the prose rather than a field', () => {
    const fields = parse('ship ✅ the feature')
    expect(fields.description).toBe('ship ✅ the feature')
    expect(fields.doneDate).toBeNull()
  })

  it('collects tags that sit between fields and puts them back in order', () => {
    const fields = parse('do it #work 📅 2026-10-04 #urgent')
    expect(fields.description).toBe('do it #work #urgent')
    expect(fields.tags).toEqual(['#work', '#urgent'])
    expect(dateKey(fields.dueDate!)).toBe('2026-10-04')
  })

  it('reads id, depends on and on completion', () => {
    const fields = parse('blocked task 🆔 abc-123 ⛔ def456, ghi789 🏁 delete')
    expect(fields.id).toBe('abc-123')
    expect(fields.dependsOn).toEqual(['def456', 'ghi789'])
    expect(fields.onCompletion).toBe(OnCompletion.Delete)
    expect(fields.description).toBe('blocked task')
  })

  it('keeps a date that names no real day, as invalid rather than absent', () => {
    const fields = parse('typo 📅 2022-02-30')
    expect(fields.dueDate).toBeInstanceOf(Date)
    expect(Number.isNaN(fields.dueDate!.getTime())).toBe(true)
    expect(fields.invalidDates.dueDate).toBe('2022-02-30')
  })

  it('handles more trailing tags than the upstream loop cap allowed', () => {
    const tags = Array.from({ length: 26 }, (_, index) => `#t${index}`).join(' ')
    const fields = parse(`many tags ${tags} 📅 2026-10-04`)
    expect(fields.tags).toHaveLength(26)
    expect(dateKey(fields.dueDate!)).toBe('2026-10-04')
    expect(fields.description).toBe(`many tags ${tags}`)
  })

  it('matches an emoji with or without its variation selector', () => {
    const withSelector = `a ${'🗓' + String.fromCharCode(0xFE0F)} 2026-10-04`
    expect(dateKey(parse(withSelector).dueDate!)).toBe('2026-10-04')
    expect(dateKey(parse('a 🗓 2026-10-04').dueDate!)).toBe('2026-10-04')
  })
})

describe('emoji format writing', () => {
  function roundTrip(line: string): string {
    return serializer.serialize(parse(line))
  }

  it('writes fields back in the canonical order', () => {
    expect(roundTrip('ship it ✅ 2026-10-06 ❌ 2026-10-05 📅 2026-10-04 ⏳ 2026-10-03 🛫 2026-10-02 ➕ 2026-10-01 🔁 every week 🔺 🆔 abc ⛔ def'))
      .toBe('ship it 🆔 abc ⛔ def 🔺 🔁 every week ➕ 2026-10-01 🛫 2026-10-02 ⏳ 2026-10-03 📅 2026-10-04 ❌ 2026-10-05 ✅ 2026-10-06')
  })

  it('normalises an alternate spelling to the written form', () => {
    expect(roundTrip('a 📆 2026-10-04')).toBe('a 📅 2026-10-04')
    expect(roundTrip('a ⌛ 2026-10-03')).toBe('a ⏳ 2026-10-03')
    expect(roundTrip('a ✕ 2026-10-01')).toBe('a ➕ 2026-10-01')
  })

  it('puts a broken date back exactly as it was found', () => {
    expect(roundTrip('typo 📅 2022-02-30')).toBe('typo 📅 2022-02-30')
  })

  it('keeps the symbol but drops the value in short mode', () => {
    const fields = parse('a 📅 2026-10-04 ✅ 2026-10-06')
    expect(serializer.serialize({ ...fields, description: '' }, { shortMode: true }).trim()).toBe('📅 ✅')
  })

  it('writes nothing extra for a task with no fields', () => {
    expect(serializer.serialize(parse('just text'))).toBe('just text')
  })
})
