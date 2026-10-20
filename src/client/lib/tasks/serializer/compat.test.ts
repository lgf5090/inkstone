import { describe, expect, it } from 'vitest'
import { OnCompletion } from '../model/on-completion'
import { Priority } from '../model/priority'
import { formatTaskDate } from '../date/date-tools'
import { DataviewTaskSerializer } from './dataview-format'
import { CompatTaskSerializer } from './compat'
import { EmojiTaskSerializer } from './emoji'

const cp = (...codes: number[]): string => String.fromCodePoint(...codes)
const DUE = cp(0x1F4C5)
const HIGH = cp(0x23EB)
const DONE_MARK = cp(0x2705)

const reads = new CompatTaskSerializer(new EmojiTaskSerializer())

describe('reading either format', () => {
  it('takes a field from whichever format wrote it', () => {
    const fields = reads.deserialize(`ship it ${DUE} 2026-10-04 [priority:: high]`)
    expect(fields.description).toBe('ship it')
    expect(formatTaskDate(fields.dueDate)).toBe('2026-10-04')
    expect(fields.priority).toBe(Priority.High)
  })

  it('reads an inline-field recurrence rule and an inline on-completion', () => {
    const fields = reads.deserialize('water [repeat:: every week] [onCompletion:: delete]')
    expect(fields.recurrenceRuleText).toBe('every week')
    expect(fields.onCompletion).toBe(OnCompletion.Delete)
  })

  it('reads a whole emoji line and keeps its trailing tag', () => {
    const fields = reads.deserialize(`pay rent ${HIGH} ${DUE} 2026-10-01 ${DONE_MARK} 2026-10-02 #home`)
    expect(fields.description).toBe('pay rent #home')
    expect(fields.priority).toBe(Priority.High)
    expect(formatTaskDate(fields.doneDate)).toBe('2026-10-02')
    expect(fields.tags).toEqual(['#home'])
  })

  it('refuses to invent a field out of prose', () => {
    const fields = reads.deserialize('read [Book:: Sapiens] and see #x')
    expect(fields.description).toBe('read [Book:: Sapiens] and see #x')
    expect(fields.dueDate).toBeNull()
  })

  it('keeps an unparseable date written the other way round', () => {
    const fields = reads.deserialize('file [due:: 2022-02-30]')
    expect(fields.dueDate).not.toBeNull()
    expect(Number.isNaN(fields.dueDate!.getTime())).toBe(true)
    expect(fields.invalidDates.dueDate).toBe('2022-02-30')
  })

  it('writes in the one format it was given', () => {
    const asInline = new CompatTaskSerializer(new DataviewTaskSerializer())
    const fields = asInline.deserialize(`mend the fence ${DUE} 2026-10-04`)
    expect(asInline.serialize(fields)).toBe('mend the fence [due:: 2026-10-04]')
  })
})
