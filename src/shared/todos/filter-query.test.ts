import { describe, expect, it } from 'vitest'
import { emptyTodoFilter, parseTodoFilter, type TodoFilterQuery } from './filter-query'

/**
 * The to-do filter line, one row per reading.
 *
 * The table is the grammar: every supported qualifier, the quoted and negated spellings, the two
 * window ends, and the values that are not filters. Those last rows are the policy made explicit:
 * a value the line cannot read is kept as search text, so the reader sees an empty answer instead of
 * a list that silently ignored half of what they asked for.
 */

/** The shape a line with nothing in it means, with the fields a case is about laid over it. */
function expected(overrides: Partial<TodoFilterQuery> = {}): TodoFilterQuery {
  return { ...emptyTodoFilter(), ...overrides }
}

const cases: ReadonlyArray<readonly [line: string, reading: TodoFilterQuery]> = [
  ['', expected()],
  ['list:Work', expected({ list: 'Work' })],
  ['list:"Work stuff"', expected({ list: 'Work stuff' })],
  ['LIST:Work', expected({ list: 'Work' })],
  ['tag:work', expected({ tag: 'work' })],
  ['tag:#work', expected({ tag: 'work' })],
  ['tag:"work meeting"', expected({ tag: 'work meeting' })],
  ['tag:one tag:two', expected({ tag: 'two' })],
  ['-tag:later', expected({ excludedTags: ['later'] })],
  ['-tag:"work meeting"', expected({ excludedTags: ['work meeting'] })],
  ['p:1', expected({ priority: 'low' })],
  ['p:2', expected({ priority: 'medium' })],
  ['P:3', expected({ priority: 'high' })],
  ['p:4', expected({ priority: 'urgent' })],
  ['p:0', expected({ text: 'p:0' })],
  ['p:5', expected({ text: 'p:5' })],
  ['p:x', expected({ text: 'p:x' })],
  ['starred:true', expected({ starred: true })],
  ['is:starred', expected({ starred: true })],
  ['starred:false', expected({ text: 'starred:false' })],
  ['status:todo,in_progress', expected({ status: ['todo', 'in_progress'] })],
  ['status:"todo, in_progress"', expected({ status: ['todo', 'in_progress'] })],
  ['status:todo,todo', expected({ status: ['todo'] })],
  ['status:done,later', expected({ text: 'status:done,later' })],
  ['due:2026-10-01..2026-10-31', expected({ dueFrom: '2026-10-01', dueTo: '2026-10-31' })],
  ['due:2026-10-01..', expected({ dueFrom: '2026-10-01' })],
  ['due:..2026-10-31', expected({ dueTo: '2026-10-31' })],
  ['due:2026-02-30..2026-03-01', expected({ text: 'due:2026-02-30..2026-03-01' })],
  ['due:2026-10-31..2026-10-01', expected({ text: 'due:2026-10-31..2026-10-01' })],
  ['due:2026-10-01', expected({ text: 'due:2026-10-01' })],
  ['due:..', expected({ text: 'due:..' })],
  ['write "the report" by friday', expected({ text: 'write the report by friday' })],
  ['foo:bar report', expected({ text: 'foo:bar report' })],
  ['-list:Work', expected({ text: '-list:Work' })],
  ['list:', expected({ text: 'list:' })],
  ['folder:Inbox report', expected({ text: 'report' })],
  [
    'list:Work tag:urgent p:1 starred:true status:todo,in_progress due:2026-10-01..2026-10-31 report -tag:later',
    expected({
      list: 'Work',
      tag: 'urgent',
      priority: 'low',
      starred: true,
      status: ['todo', 'in_progress'],
      dueFrom: '2026-10-01',
      dueTo: '2026-10-31',
      text: 'report',
      excludedTags: ['later'],
    }),
  ],
]

describe('the to-do filter line', () => {
  it.each(cases)('reads %j', (line, reading) => {
    expect(parseTodoFilter(line)).toEqual(reading)
  })

  it('keeps a recognized qualifier out of the search text', () => {
    expect(parseTodoFilter('list:Work report').text).toBe('report')
    expect(parseTodoFilter('tag:urgent report').text).toBe('report')
  })

  it('starts from an empty reading for every field', () => {
    expect(emptyTodoFilter()).toEqual({
      list: null,
      tag: null,
      priority: null,
      starred: null,
      status: null,
      dueFrom: null,
      dueTo: null,
      text: '',
      excludedTags: [],
    })
  })
})
