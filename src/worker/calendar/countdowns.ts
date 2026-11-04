/**
 * The countdown rows, read and written.
 *
 * Kept out of `store.ts` because `CalendarStore` owns calendars, events, groups and shares, and a
 * countdown shares none of those rules: no membership, no revision of a series, no range fetch. What
 * it shares is the account scope and the optimistic revision, and those are three lines rather than a
 * reason to grow a class that is already the calendar's largest module.
 *
 * A lunar repeat stores the lunar month and day beside the solar date on purpose. Resolving it at read
 * time would make every list read walk the lunar tables, and the answer cannot change between reads:
 * the reader picked one lunar day.
 */

import type { CalendarCountdownDto, CalendarCountdownInput, CountdownRepeat } from '@shared/calendar/countdown'
import { MAX_COUNTDOWNS } from '@shared/calendar/countdown'
import { solar2lunar } from '@shared/subscriptions/lunar'
import { ApiError } from '../lib/errors'

interface CountdownRow {
  id: string
  title: string
  target_date: string
  repeat_mode: string
  lunar_month: number | null
  lunar_day: number | null
  lunar_leap: number
  note: string
  color: string
  pinned: number
  rev: number
}

/** What a write binds: everything but the derived lunar fields, which this module computes. */
export interface CountdownWrite {
  id: string
  title: string
  date: string
  repeat: CountdownRepeat
  note: string
  color: string
  pinned: boolean
}

export interface CountdownPatch {
  rev: number
  title?: string
  date?: string
  repeat?: CountdownRepeat
  note?: string
  color?: string
  pinned?: boolean
}

function toDto(row: CountdownRow): CalendarCountdownDto {
  const repeat: CountdownRepeat = row.repeat_mode === 'yearly' || row.repeat_mode === 'lunar'
    ? row.repeat_mode
    : 'none'
  return {
    id: row.id,
    title: row.title,
    date: row.target_date,
    repeat,
    lunarMonth: row.lunar_month,
    lunarDay: row.lunar_day,
    lunarLeap: row.lunar_leap === 1,
    note: row.note,
    color: row.color,
    pinned: row.pinned === 1,
    rev: row.rev,
  }
}

/**
 * The lunar fields a repeat needs, from the solar day the reader picked.
 *
 * A lunar repeat whose day falls outside the 1900–2100 table is refused rather than stored as a row
 * that could never resolve: the reader would see a countdown that never moves.
 */
function lunarFieldsOf(date: string, repeat: CountdownRepeat): { month: number | null; day: number | null; leap: number } {
  if (repeat !== 'lunar') return { month: null, day: null, leap: 0 }
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const lunar = solar2lunar(year, month, day)
  if (!lunar) {
    throw ApiError.badRequest('A lunar countdown must start on a day the lunar table covers (1900-2100).')
  }
  return { month: lunar.month, day: lunar.day, leap: lunar.isLeap ? 1 : 0 }
}

const SELECT_COLUMNS = 'id, title, target_date, repeat_mode, lunar_month, lunar_day, lunar_leap, note, color, pinned, rev'

export class CountdownStore {
  constructor(private readonly db: D1Database, private readonly userId: string) {}

  async list(): Promise<CalendarCountdownDto[]> {
    const result = await this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM calendar_countdowns WHERE user_id = ?1
        ORDER BY pinned DESC, target_date, title`,
    ).bind(this.userId).all<CountdownRow>()
    return (result.results ?? []).map(toDto)
  }

  async create(write: CountdownWrite): Promise<CalendarCountdownDto> {
    const existing = await this.db.prepare(
      'SELECT COUNT(*) AS total FROM calendar_countdowns WHERE user_id = ?1',
    ).bind(this.userId).first<{ total: number }>()
    if ((existing?.total ?? 0) >= MAX_COUNTDOWNS) {
      throw ApiError.badRequest(`An account may keep ${MAX_COUNTDOWNS} countdowns.`)
    }
    const lunar = lunarFieldsOf(write.date, write.repeat)
    const now = Date.now()
    const statements: D1PreparedStatement[] = [
      this.db.prepare(
        `INSERT INTO calendar_countdowns (
           user_id, id, title, target_date, repeat_mode, lunar_month, lunar_day, lunar_leap,
           note, color, pinned, created_at, updated_at, rev
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, 1)`,
      ).bind(
        this.userId,
        write.id,
        write.title,
        write.date,
        write.repeat,
        lunar.month,
        lunar.day,
        lunar.leap,
        write.note,
        write.color,
        write.pinned ? 1 : 0,
        now,
      ),
      this.db.prepare(
        `SELECT ${SELECT_COLUMNS} FROM calendar_countdowns WHERE user_id = ?1 AND id = ?2`,
      ).bind(this.userId, write.id),
    ]
    let outcomes: D1Result[]
    try {
      outcomes = await this.db.batch(statements)
    } catch (error) {
      // A duplicate id is the only constraint this table has, and the caller chose the id.
      if (error instanceof Error && /UNIQUE|PRIMARY/i.test(error.message)) {
        throw ApiError.conflict('A countdown with that id already exists')
      }
      throw error
    }
    const row = (outcomes.at(-1) as D1Result<CountdownRow>).results?.[0]
    if (!row) throw new Error('Countdown create did not persist')
    return toDto(row)
  }

  async update(id: string, patch: CountdownPatch): Promise<CalendarCountdownDto> {
    const current = await this.row(id)
    if (!current) throw ApiError.notFound('Countdown not found')
    if (current.rev !== patch.rev) throw ApiError.conflict('The countdown changed elsewhere. Refresh and try again')

    const nextDate = patch.date ?? current.target_date
    const nextRepeat: CountdownRepeat = patch.repeat
      ?? (current.repeat_mode === 'yearly' || current.repeat_mode === 'lunar' ? current.repeat_mode : 'none')
    // The lunar fields only change when the date or the mode does; recomputing them unconditionally
    // would rewrite the row on every pin without the reader ever changing the day.
    const lunar = patch.date !== undefined || patch.repeat !== undefined
      ? lunarFieldsOf(nextDate, nextRepeat)
      : { month: current.lunar_month, day: current.lunar_day, leap: current.lunar_leap }

    const assignments: string[] = ['rev = rev + 1', 'updated_at = ?', 'lunar_month = ?', 'lunar_day = ?', 'lunar_leap = ?']
    const values: unknown[] = [Date.now(), lunar.month, lunar.day, lunar.leap]
    const set = (column: string, value: unknown) => {
      assignments.push(`${column} = ?`)
      values.push(value)
    }
    if (patch.title !== undefined) set('title', patch.title)
    if (patch.date !== undefined) set('target_date', patch.date)
    if (patch.repeat !== undefined) set('repeat_mode', patch.repeat)
    if (patch.note !== undefined) set('note', patch.note)
    if (patch.color !== undefined) set('color', patch.color)
    if (patch.pinned !== undefined) set('pinned', patch.pinned ? 1 : 0)

    const statements: D1PreparedStatement[] = [
      this.db.prepare(
        `UPDATE calendar_countdowns SET ${assignments.join(', ')}
          WHERE user_id = ? AND id = ? AND rev = ?`,
      ).bind(...values, this.userId, id, patch.rev),
      this.db.prepare(
        `SELECT ${SELECT_COLUMNS} FROM calendar_countdowns WHERE user_id = ?1 AND id = ?2`,
      ).bind(this.userId, id),
    ]
    const outcomes = await this.db.batch(statements)
    if (!outcomes[0]?.meta.changes) {
      throw ApiError.conflict('The countdown changed elsewhere. Refresh and try again')
    }
    const row = (outcomes.at(-1) as D1Result<CountdownRow>).results?.[0]
    if (!row) throw new Error('Countdown update did not persist')
    return toDto(row)
  }

  async delete(id: string, rev: number): Promise<void> {
    const result = await this.db.prepare(
      'DELETE FROM calendar_countdowns WHERE user_id = ?1 AND id = ?2 AND rev = ?3',
    ).bind(this.userId, id, rev).run()
    if (!result.meta.changes) {
      // Either it is gone or its revision moved; both mean the caller's copy is stale.
      throw ApiError.conflict('The countdown changed elsewhere. Refresh and try again')
    }
  }

  private async row(id: string): Promise<CountdownRow | null> {
    return this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM calendar_countdowns WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id).first<CountdownRow>()
  }
}

/** The id a countdown write may carry, so a client can create one optimistic row and keep its id. */
export function countdownWriteId(input: CalendarCountdownInput, generated: string): string {
  return input.id ?? generated
}
