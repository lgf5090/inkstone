import { describe, expect, it } from 'vitest'
import { EmojiTaskSerializer } from '../serializer/emoji'
import { defaultStatusRegistry } from '../line'
import { parseTaskLine, type Task } from '../model/task'
import { unknownPosition } from '../model/task-location'
import { urgencyOf } from '../model/urgency'
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

function ordered(result: Task[]): string[] {
  return result.map((item) => item.fields.description)
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

  it('drops blank lines', () => {
    expect(scanStatements('\n not done \n\n done \n')).toHaveLength(2)
  })
})

describe('filters', () => {

  it('asks about presence rather than value', () => {
    expect(ask('has due date', SAMPLE)).toHaveLength(6)
    expect(ask('no due date', SAMPLE)).toHaveLength(3)
    expect(ask('has scheduled date', SAMPLE)).toHaveLength(1)
  })

  it('matches starts against tasks with no start date as well', () => {
    expect(ask('starts before 2026-01-01', SAMPLE)).toHaveLength(SAMPLE.length)
  })


  it('separates done, not done and the status types', () => {
    expect(names(ask('done', SAMPLE))).toEqual(['done ship it'])
    expect(ask('not done', SAMPLE)).toHaveLength(8)
    expect(names(ask('status.type is IN_PROGRESS', SAMPLE))).toEqual(['mid draft #writing'])
    expect(ask('status.type is not DONE', SAMPLE)).toHaveLength(8)
    expect(names(ask('status.name includes Cancelled', SAMPLE))).toEqual(['dropped old'])
  })


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


  it('reports an unbalanced expression', () => {
    expect(errors('(not done AND (done)')).toHaveLength(1)
  })
})

describe('sorting, grouping and limits', () => {



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

describe('statement scanner, reconciled', () => {
  it('joins a continuation with one space and keeps a literal backslash', () => {
    expect(scanStatements('due before 2026-10-20 \\\n  and not done').map((item) => item.instruction))
      .toEqual(['due before 2026-10-20 and not done'])
    expect(scanStatements('path includes C:\\\\notes').map((item) => item.instruction))
      .toEqual(['path includes C:\\notes'])
  })
})

describe('filters, reconciled', () => {
  it('answers the date relations in the engine default order', () => {
    expect(ordered(ask('due before 2026-10-19', SAMPLE))).toEqual(['overdue pay rent', 'done ship it'])
    expect(names(ask('due on 2026-10-19', SAMPLE))).toEqual(['today standup'])
    expect(names(ask('due after 2026-10-19', SAMPLE))).toEqual(['mid draft #writing', 'recurring water', 'soon review'])
    expect(names(ask('due on or before 2026-10-19', SAMPLE))).toHaveLength(3)
  })

  it('reads a relative span, and answers none when nothing falls in it', () => {
    expect(names(ask('due this month', SAMPLE))).toEqual([
      'done ship it', 'mid draft #writing', 'overdue pay rent', 'recurring water', 'soon review', 'today standup',
    ])
    expect(names(ask('due next month', SAMPLE))).toEqual([])
  })

  it('orders priority with above, below and not', () => {
    expect(names(ask('priority is high', SAMPLE))).toEqual(['overdue pay rent'])
    expect(names(ask('priority above none', SAMPLE))).toEqual(['overdue pay rent', 'today standup'])
    expect(names(ask('priority below high', SAMPLE))).toHaveLength(8)
    expect(names(ask('priority is not none', SAMPLE))).toHaveLength(3)
  })
})

describe('boolean combinations, reconciled', () => {
  it('works across all four delimiter pairs', () => {
    expect(names(ask('(due before 2026-10-19) AND (priority is high)', SAMPLE))).toEqual(['overdue pay rent'])
    expect(names(ask('(heading includes Plants) OR (status.type is CANCELLED)', SAMPLE))).toHaveLength(2)
    expect(names(ask('[due on 2026-10-19] XOR [done]', SAMPLE))).toEqual(['done ship it', 'today standup'])
    expect(names(ask('NOT (path includes Work)', SAMPLE))).toHaveLength(4)
    expect(names(ask('{not done} AND (priority is high)', SAMPLE))).toHaveLength(1)
  })

  it('reads AND NOT as two connectives, not one unknown word', () => {
    expect(names(ask('(due before 2026-10-19) AND NOT (priority is high)', SAMPLE))).toEqual(['done ship it'])
  })

  it('recurses into a nested expression', () => {
    expect(names(ask('((not done) AND (path includes Work)) OR (status.type is CANCELLED)', SAMPLE))).toHaveLength(5)
  })

  it('reports an unbalanced expression instead of matching everything', () => {
    const parsed = parseTasksQuery('(not done AND (done)', NOW)
    expect(parsed.filters).toHaveLength(0)
    expect(parsed.errors).toHaveLength(1)
  })
})

describe('ordering, reconciled', () => {
  it('leads the default chain with the open status type, not the most urgent task', () => {
    const first = ordered(ask('not done', SAMPLE))[0]!
    expect(first).toBe('mid draft #writing')
  })

  it('honours an explicit sort and its reverse', () => {
    expect(ordered(ask('sort by path\nnot done', SAMPLE))[0]).toBe('dropped old')
    expect(ordered(ask('sort by path reverse\nnot done', SAMPLE)).at(-1)).toBe('dropped old')
  })

  it('sorts by urgency monotonically', () => {
    const sorted = ordered(ask('sort by urgency\nnot done', SAMPLE))
    const scores = sorted.map((name) => urgencyOf(SAMPLE.find((item) => item.fields.description === name)!, NOW))
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
  })

  it('orders groups by their hidden sort key', () => {
    const result = runTasksQuery(SAMPLE, parseTasksQuery('group by status.type\nnot done', NOW), NOW)
    expect(result.groups.map((group) => stripSortPrefix(group.path[0]!))).toEqual(['IN_PROGRESS', 'TODO', 'CANCELLED'])
  })
})
