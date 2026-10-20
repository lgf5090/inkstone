import { describe, expect, it } from 'vitest'
import { parseTasksQuery } from '../src/client/lib/tasks/query/query'

/**
 * The acceptance list for the `tasks` query language, as one runnable gate.
 *
 * §4.3 of the port plan is the contract this engine was written against, and a contract nobody can
 * re-check drifts. Every family there appears here at least once, and the lines the plan says the
 * engine does *not* implement are pinned as refusals — an instruction that starts being accepted is
 * a change to the language, and so is one that stops being.
 */
const NOW = new Date(2026, 9, 19)

function errors(source: string): string[] {
  return parseTasksQuery(source, NOW, { currentPath: 'Home/Chores.md' }).errors
}

const DATE_RELATION_FIELDS = ['due', 'done', 'created', 'starts', 'scheduled', 'cancelled', 'happens']
/** The same fields, spelled as the presence instructions spell them: `starts before`, but `has start date`. */
const DATE_PRESENCE_FIELDS = ['due', 'done', 'created', 'start', 'scheduled', 'cancelled', 'happens']
const RELATIONS: Array<[string, string]> = [
  ['before', '2026-10-20'],
  ['on', '2026-10-20'],
  ['in', '2026-10'],
  ['after', '2026-10-20'],
  ['on or before', '2026-10-20'],
  ['in or before', 'last week'],
  ['on or after', '2026-10-20'],
  ['in or after', 'next month'],
]
const TEXT_MATCHERS = ['includes', 'does not include', 'regex matches', 'regex does not match']
const TEXT_FIELDS = ['status.name', 'recurrence', 'id', 'path', 'folder', 'root', 'filename', 'heading', 'description', 'tag', 'tags']
const SORT_FIELDS = ['status', 'status.name', 'status.type', 'urgency', 'due', 'done', 'scheduled', 'start', 'created',
  'cancelled', 'happens', 'priority', 'path', 'filename', 'heading', 'description', 'tag 1', 'recurring', 'id', 'random']
const GROUP_FIELDS = ['path', 'due', 'done', 'scheduled', 'start', 'created', 'cancelled', 'happens', 'priority',
  'status', 'status.name', 'status.type', 'recurrence', 'tags', 'tag', 'filename', 'heading', 'id', 'depends on',
  'folder', 'root', 'backlink', 'urgency']
const QUERY_PARTS = ['toolbar', 'postpone button', 'edit button', 'backlink', 'nested backlink', 'task count', 'group count', 'tree', 'urgency']
const LAYOUT_FIELDS = ['id', 'depends on', 'priority', 'recurrence rule', 'on completion', 'created date', 'start date',
  'scheduled date', 'due date', 'cancelled date', 'done date', 'tags']
const PRESETS = ['this_file', 'this_folder', 'this_folder_only', 'this_root', 'hide_date_fields', 'hide_non_date_fields', 'hide_query_elements', 'hide_everything']

/** Every line the language owes its readers, generated rather than hand-picked so a family cannot be forgotten. */
function acceptedLines(): string[] {
  const out: string[] = [
    'explain',
    'ignore global query',
    'short mode',
    'full mode',
    'view list',
    'limit 5',
    'limit to 5',
    'limit 5 tasks',
    'limit groups 2',
    'limit groups to 2 tasks',
    '# a note to self',
    'done',
    'not done',
    'is recurring',
    'is not recurring',
    'has id',
    'no id',
    'has depends on',
    'no depends on',
    'is blocked',
    'is not blocked',
    'is blocking',
    'is not blocking',
    'exclude sub-items',
    // The relation keyword is optional in the reference grammar, so a bare date means "on".
    'due tomorrow',
    'not done \\',
    '  due before 2026-10-20',
    '(not done) AND (due before 2026-10-20)',
    '(not done) OR (done)',
    '(not done) XOR (due before 2026-10-20)',
    'NOT (done)',
    '(not done) AND NOT (due before 2026-10-20)',
    '(not done) OR NOT (due before 2026-10-20)',
    '[(not done) AND [due before 2026-10-20]]',
    '{(not done) AND (due before 2026-10-20)}',
    '(NOT (priority high)) AND (status.type is TODO)',
  ]
  for (const field of DATE_RELATION_FIELDS) {
    for (const [relation, operand] of RELATIONS) out.push(`${field} ${relation} ${operand}`)
  }
  for (const field of DATE_PRESENCE_FIELDS) out.push(`has ${field} date`, `no ${field} date`, `${field} date is invalid`)
  for (const field of TEXT_FIELDS) {
    for (const matcher of TEXT_MATCHERS) out.push(`${field} ${matcher} abc`)
  }
  out.push(
    'priority high',
    'priority is high',
    'priority above low',
    'priority below highest',
    'priority not none',
    'priority is not medium',
    'status.type is TODO',
    'status.type is not DONE',
  )
  for (const field of SORT_FIELDS) out.push(`sort by ${field}`, `sort by ${field} reverse`)
  for (const field of GROUP_FIELDS) out.push(`group by ${field}`, `group by ${field} reverse`)
  for (const part of QUERY_PARTS) out.push(`hide ${part}`, `show ${part}`)
  for (const field of LAYOUT_FIELDS) out.push(`hide ${field}`, `show ${field}`)
  for (const preset of PRESETS) out.push(`preset ${preset}`)
  return out
}

describe('the tasks query language accepts what the plan promised', () => {
  it.each(acceptedLines().map((line) => [line]))('parses %s', (line) => {
    expect(errors(line)).toEqual([])
  })
})

describe('the tasks query language refuses what it does not do', () => {
  it.each([
    ['an instruction that is nothing', 'nonsense filter here'],
    ['an unknown sort key', 'sort by nonsense'],
    ['an unknown group key', 'group by nonsense'],
    ['an unknown thing to hide', 'hide nonsense'],
    ['an unknown status type', 'status.type is BOGUS'],
    ['a limit that is not a number', 'limit abc'],
    ['columns, which the port does not do', 'view columns by folder'],
    ['function filters, which the port does not do', 'filter by function !this.task.isDone'],
  ])('refuses %s', (_label, line) => {
    expect(errors(line).length, line).toBeGreaterThan(0)
  })

  it('names the line it could not read', () => {
    expect(errors('not done\nnonsense here')[0]).toContain('nonsense here')
  })
})
