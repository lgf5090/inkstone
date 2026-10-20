// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  MAX_TODO_CSV_BYTES,
  MAX_TODO_CSV_ROWS,
  TodoCsvError,
  parseTodoCsv,
} from '../src/worker/todos/import-csv'

const ZONE = 'Asia/Shanghai'

/** The instant a bare `YYYY-MM-DD` means in the account's zone: the end of that local day. */
function endOfDay(day: string): number {
  return Date.parse(`${day}T23:59:00+08:00`)
}

describe('the CSV reader', () => {
  it('reads a BOM, CRLF, doubled quotes and a line break inside a quoted cell', () => {
    const csv = '\uFEFFtitle,notes,due,priority,list,tags,completed\r\n'
      + '"Plan, ""2027""","line one\r\nline two",2027-01-05 09:30,P1,Work,home;errand;home,true\r\n'
      + 'Second,,2027-02-01,4,,,false\r\n'

    const parsed = parseTodoCsv(csv, ZONE)

    expect(parsed.errors).toEqual([])
    expect(parsed.rows).toHaveLength(2)
    const [first, second] = parsed.rows
    expect(first).toMatchObject({
      line: 2,
      title: 'Plan, "2027"',
      notes: 'line one\nline two',
      dueAt: Date.parse('2027-01-05T01:30:00Z'),
      priority: 'urgent',
      listName: 'Work',
      tags: ['home', 'errand'],
      completed: true,
    })
    expect(second).toMatchObject({
      line: 4,
      title: 'Second',
      notes: '',
      dueAt: endOfDay('2027-02-01'),
      priority: 'low',
      listName: null,
      tags: [],
      completed: false,
    })
  })

  it('keeps the good rows and reports bad ones by their source line', () => {
    const csv = [
      'title,due',
      'Good,2027-01-05',
      ',2027-01-06',
      'Bad date,next week',
      'Last,',
    ].join('\n')

    const parsed = parseTodoCsv(csv, ZONE)

    expect(parsed.rows.map((row) => row.title)).toEqual(['Good', 'Last'])
    expect(parsed.rows.map((row) => row.line)).toEqual([2, 5])
    expect(parsed.errors).toEqual([
      { line: 3, reason: 'title is required' },
      { line: 4, reason: 'due date "next week" is not a date this app can read' },
    ])
  })

  it('reports an unterminated quoted field without losing the rows before it', () => {
    const parsed = parseTodoCsv('title\nFirst\n"unterminated', ZONE)

    expect(parsed.rows.map((row) => row.title)).toEqual(['First'])
    expect(parsed.errors).toEqual([{ line: 3, reason: 'unterminated quoted field' }])
  })

  it('finds the columns by lower-case name and reads description as notes', () => {
    const parsed = parseTodoCsv(
      'Title,Description,Priority,Tags,Completed\nRead,From the library,P2,#focus; deep work,Yes',
      ZONE,
    )

    expect(parsed.errors).toEqual([])
    expect(parsed.rows[0]).toMatchObject({
      title: 'Read',
      notes: 'From the library',
      priority: 'high',
      tags: ['focus', 'deep work'],
      completed: true,
    })
  })

  it('maps every priority spelling to one of the four levels', () => {
    const rows = ['1', '2', 'P3', 'low', 'urgent', 'medium', 'high', 'P4', '1', 'nonsense']
      .map((priority) => `Task,${priority}`)
      .join('\n')
    const parsed = parseTodoCsv(`title,priority\n${rows}`, ZONE)

    expect(parsed.errors).toEqual([])
    expect(parsed.rows.map((row) => row.priority)).toEqual([
      'urgent', 'high', 'medium', 'low', 'urgent', 'medium', 'high', 'low', 'urgent', 'medium',
    ])
  })

  it('leaves completion alone when the file has no completed column', () => {
    const withoutColumn = parseTodoCsv('title\nNo column', ZONE)
    const withColumn = parseTodoCsv('title,completed\nEmpty,\nNo,0\nDone,yes', ZONE)

    expect(withoutColumn.errors).toEqual([])
    expect(withoutColumn.rows[0]!.completed).toBeNull()
    expect(withColumn.errors).toEqual([])
    expect(withColumn.rows.map((row) => row.completed)).toEqual([false, false, true])
  })

  it('reads a date-only due as the end of that local day and a full instant as itself', () => {
    const parsed = parseTodoCsv(
      'title,due\nDate only,2027-01-05\nInstant,2027-01-05T01:30:00Z',
      ZONE,
    )

    expect(parsed.errors).toEqual([])
    expect(parsed.rows[0]!.dueAt).toBe(endOfDay('2027-01-05'))
    expect(parsed.rows[1]!.dueAt).toBe(Date.parse('2027-01-05T01:30:00Z'))
  })

  it('counts a bad row after a multiline cell on the line the row starts', () => {
    const parsed = parseTodoCsv('title,notes\n"two\nlines",x\n,broken', ZONE)

    expect(parsed.rows.map((row) => row.line)).toEqual([2])
    expect(parsed.errors).toEqual([{ line: 4, reason: 'title is required' }])
  })

  it('refuses a file with no title column or no rows at all', () => {
    expect(() => parseTodoCsv('name,notes\nTask,x', ZONE)).toThrow(TodoCsvError)
    expect(() => parseTodoCsv('\uFEFF\r\n', ZONE)).toThrow(TodoCsvError)
  })
})

describe('the CSV import ceilings', () => {
  it('names a 5000-row and a 2 MiB ceiling', () => {
    expect(MAX_TODO_CSV_ROWS).toBe(5000)
    expect(MAX_TODO_CSV_BYTES).toBe(2 * 1024 * 1024)
  })
})
