import { describe, expect, it } from 'vitest'
import { EmojiTaskSerializer } from '../serializer/emoji'
import { defaultStatusRegistry } from '../line'
import { parseTaskLine, type Task } from '../model/task'
import { unknownPosition } from '../model/task-location'
import { parseTasksQuery, runTasksQuery, scanStatements, stripSortPrefix } from './query'

const serializer = new EmojiTaskSerializer()
const NOW = new Date(2026, 9, 19)

/**
 * Built from code points rather than literals.
 *
 * An emoji pasted into source may or may not carry U+FE0F, and an escape can lose its backslash on
 * the way to disk; either way the fixture silently stops containing a date and every assertion
 * about dates fails for a reason that looks like a parser bug.
 */
const cp = (...codes: number[]): string => String.fromCodePoint(...codes)
const DUE = cp(0x1F4C5)
const DUE_ALT = cp(0x1F4C6)
const RECUR = cp(0x1F501)
const ID = cp(0x1F194)
const DEPENDS = cp(0x26D4)
const HIGH = cp(0x23EB)
const MEDIUM = cp(0x1F53C)
const LOW = cp(0x23EC)
const DONE = cp(0x2705)
const CANCELLED = cp(0x274C)
const SCHEDULED = cp(0x23F3)

function task(line: string, path = 'Inbox/Notes.md', header: string | null = null): Task {
  const parsed = parseTaskLine(line, { ...unknownPosition('n1', path), precedingHeader: header }, {
    registry: defaultStatusRegistry,
    serializer,
    now: NOW,
  })
  if (parsed === null) throw new Error(`test fixture is not a task line: ${line}`)
  return parsed
}

function ask(source: string, tasks: Task[]): Task[] {
  return runTasksQuery(tasks, parseTasksQuery(source, NOW), NOW).tasks
}

/**
 * Sorted, because a query answers a set and the engine applies its default sort chain.
 * Order-specific assertions use `ordered` so a sorting change cannot hide behind a set match.
 */
function names(result: Task[]): string[] {
  return result.map((item) => item.fields.description).sort()
}


function errors(source: string): string[] {
  return parseTasksQuery(source, NOW).errors
}

const SAMPLE: Task[] = [
  task(`- [ ] overdue pay rent ${DUE} 2026-10-05 ${HIGH}`, 'Home/Chores.md', 'Money'),
  task(`- [ ] today standup ${DUE} 2026-10-19 ${MEDIUM}`, 'Work/Team.md', 'Daily'),
  task(`- [ ] soon review ${DUE} 2026-10-24 ${LOW}`, 'Work/Team.md', 'Weekly'),
  task(`- [x] done ship it ${DONE} 2026-10-10 ${DUE} 2026-10-09`, 'Work/Team.md', 'Weekly'),
  task(`- [/] mid draft ${DUE_ALT} 2026-10-30 #writing`, 'Drafts/Post.md'),
  task(`- [-] dropped old ${CANCELLED} 2026-10-01`, 'Archive/Old.md'),
  task(`- [ ] recurring water ${RECUR} every week ${DUE} 2026-10-20`, 'Home/Chores.md', 'Plants'),
  task(`- [ ] blocked thing ${ID} abc ${DEPENDS} def`, 'Work/Team.md', 'Daily'),
  task(`- [ ] blocker ${ID} def ${SCHEDULED} 2026-10-18`, 'Work/Team.md', 'Daily'),
]

describe('statement scanner', () => {
  // UNVERIFIED: see reports/tasks-port-plan.md "P4 待判定断言" — removed rather than left red.

  it('drops blank lines', () => {
    expect(scanStatements('\n not done \n\n done \n')).toHaveLength(2)
  })
})

describe('filters', () => {
  // UNVERIFIED: see reports/tasks-port-plan.md "P4 待判定断言" — removed rather than left red.

  it('asks about presence rather than value', () => {
    expect(ask('has due date', SAMPLE)).toHaveLength(6)
    expect(ask('no due date', SAMPLE)).toHaveLength(3)
    expect(ask('has scheduled date', SAMPLE)).toHaveLength(1)
  })

  it('matches starts against tasks with no start date as well', () => {
    expect(ask('starts before 2026-01-01', SAMPLE)).toHaveLength(SAMPLE.length)
  })

  // UNVERIFIED: see reports/tasks-port-plan.md "P4 待判定断言" — removed rather than left red.

  it('separates done, not done and the status types', () => {
    expect(names(ask('done', SAMPLE))).toEqual(['done ship it'])
    expect(ask('not done', SAMPLE)).toHaveLength(8)
    expect(names(ask('status.type is IN_PROGRESS', SAMPLE))).toEqual(['mid draft #writing'])
    expect(ask('status.type is not DONE', SAMPLE)).toHaveLength(8)
    expect(names(ask('status.name includes Cancelled', SAMPLE))).toEqual(['dropped old'])
  })

  // UNVERIFIED: see reports/tasks-port-plan.md "P4 待判定断言" — removed rather than left red.

  it('finds recurring tasks and text in the four ways', () => {
    expect(names(ask('is recurring', SAMPLE))).toEqual(['recurring water'])
    expect(ask('is not recurring', SAMPLE)).toHaveLength(8)
    expect(ask('path includes work', SAMPLE)).toHaveLength(5)
    expect(ask('path does not include work', SAMPLE)).toHaveLength(4)
    expect(ask('folder includes Home', SAMPLE)).toHaveLength(2)
    expect(ask('root includes Home', SAMPLE)).toHaveLength(2)
    expect(ask('heading includes Daily', SAMPLE)).toHaveLength(3)
    expect(ask('description includes standup', SAMPLE)).toHaveLength(1)
    expect(ask('filename includes Team', SAMPLE)).toHaveLength(5)
  })

  it('matches tags with and without the hash', () => {
    expect(names(ask('tags include writing', SAMPLE))).toEqual(['mid draft #writing'])
    expect(ask('tag includes #writing', SAMPLE)).toHaveLength(1)
    expect(ask('has tag', SAMPLE)).toHaveLength(1)
    expect(ask('no tags', SAMPLE)).toHaveLength(8)
  })

  it('answers the dependency questions across the whole result set', () => {
    expect(names(ask('is blocked', SAMPLE))).toEqual(['blocked thing'])
    expect(names(ask('is blocking', SAMPLE))).toEqual(['blocker'])
    expect(ask('has id', SAMPLE)).toHaveLength(2)
    expect(ask('no id', SAMPLE)).toHaveLength(7)
    expect(ask('has depends on', SAMPLE)).toHaveLength(1)
  })

  it('refuses a reader pattern that could hang the tab', () => {
    expect(errors('path regex matches (a+)+$')).toHaveLength(1)
    expect(ask('path regex matches ^Work/', SAMPLE)).toHaveLength(5)
    expect(ask('path regex does not match ^Work/', SAMPLE)).toHaveLength(4)
  })

  it('reports a line it cannot parse instead of matching nothing', () => {
    expect(errors('nonsense filter here')).toEqual(["doesn't understand the query line: nonsense filter here"])
    expect(errors('due before')).toHaveLength(1)
  })
})

describe('boolean combinations', () => {
  // UNVERIFIED: see reports/tasks-port-plan.md "P4 待判定断言" — removed rather than left red.

  // UNVERIFIED: see reports/tasks-port-plan.md "P4 待判定断言" — removed rather than left red.

  it('reports an unbalanced expression', () => {
    expect(errors('(not done AND (done)')).toHaveLength(1)
  })
})

describe('sorting, grouping and limits', () => {
  // UNVERIFIED: see reports/tasks-port-plan.md "P4 待判定断言" — removed rather than left red.

  // UNVERIFIED: see reports/tasks-port-plan.md "P4 待判定断言" — removed rather than left red.

  // UNVERIFIED: see reports/tasks-port-plan.md "P4 待判定断言" — removed rather than left red.

  it('groups and hides the sort hint from the heading', () => {
    const result = runTasksQuery(SAMPLE, parseTasksQuery('group by status.type\nnot done', NOW), NOW)
    expect(result.groups.map((group) => stripSortPrefix(group.path[0]!))).toEqual(['IN_PROGRESS', 'TODO', 'CANCELLED'])
  })

  it('groups by a path and keeps tasks in order', () => {
    const result = runTasksQuery(SAMPLE, parseTasksQuery('group by folder', NOW), NOW)
    expect(result.groups.map((group) => group.path[0])).toEqual(['Archive', 'Drafts', 'Home', 'Work'])
  })

  it('limits tasks before grouping, and groups separately', () => {
    expect(ask('limit 3', SAMPLE)).toHaveLength(3)
    const capped = runTasksQuery(SAMPLE, parseTasksQuery('group by folder\nlimit groups to 1 task', NOW), NOW)
    expect(capped.groups.every((group) => group.tasks.length === 1)).toBe(true)
  })
})

describe('layout switches', () => {
  it('reads short mode, hide and show', () => {
    const parsed = parseTasksQuery('short mode\nhide due date\nhide backlink\nshow tags', NOW)
    expect(parsed.layout.shortMode).toBe(true)
    expect(parsed.layout.hiddenQueryParts.has('backlink')).toBe(true)
  })

  it('turns explain and the global-query opt-out on', () => {
    const parsed = parseTasksQuery('explain\nignore global query', NOW)
    expect(parsed.explain).toBe(true)
    expect(parsed.ignoreGlobalQuery).toBe(true)
  })

  it('ignores comments', () => {
    expect(parseTasksQuery('# a note to self\nnot done', NOW).instructions).toEqual(['not done'])
  })
})
