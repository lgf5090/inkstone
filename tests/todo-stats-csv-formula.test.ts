// @vitest-environment jsdom
/**
 * M-05: the statistics CSV neutralises a cell that opens like a spreadsheet formula.
 *
 * The export's label columns carry names the account did not necessarily invent: `normalizeTagNames`
 * strips a `#`, folds whitespace and truncates, and refuses nothing that starts with `=`, so a tag called
 * `=HYPERLINK("http://evil","click")` is a storable tag — and `routes/todo-import.ts` hands an imported
 * CSV's tag column straight to it. Un-.defused, that text left this file as the first character of a cell
 * and Excel, Numbers or WPS would evaluate it when the reader opened their own export.
 *
 * The layout is a contract as well: a script written against one export has to still read the next, so
 * the BOM, the five tables and every column name are pinned here alongside the escaping.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { initI18n } from '../src/client/lib/i18n'
import { buildStatsCsv } from '../src/client/features/todos/stats-csv'
import { normalizeTagNames } from '../src/shared/todos/model'
import type { TaskStatsNamedCount, TodoStats, Worklog } from '../src/shared/todos/model'

const RANGE = { from: '2026-10-01', to: '2026-10-30', bucket: 'day' as const, timezone: 'UTC' }

/** One named slice of a distribution, at the shape the statistics answer carries. */
function slice(id: string, name: string): TaskStatsNamedCount {
  return { id, name, completed: 4, share: 0.5 }
}

/** Statistics whose tag slices are the names the case under test is about. */
function statsTaggedBy(tags: TaskStatsNamedCount[], lists: TaskStatsNamedCount[] = []): TodoStats {
  return {
    range: RANGE,
    summary: {
      completed: 4,
      created: 2,
      net: 2,
      open: 3,
      completionRate: 0.25,
      abandoned: 0,
      abandonedRate: 0,
      onTime: 1,
      onTimeDue: 2,
      onTimeRate: 0.5,
      medianLeadTimeMs: 3_600_000,
      currentStreak: 1,
      longestStreak: 2,
      overdue: 0,
    },
    series: [{ day: '2026-10-05', completed: 4, created: 2 }],
    flow: [{ day: '2026-10-05', todo: 3, inProgress: 1, done: 4 }],
    flowTrackedSince: null,
    distributions: {
      byList: lists,
      byTag: tags,
      byPriority: [],
      byWeekday: [],
      byHour: [{ hour: 9, completed: 4 }],
      byWeekdayHour: [],
    },
    leadTime: { p50: 3_600_000, p90: null, byPriority: [] },
    backlog: { under7: 1, days7to30: 0, over30: 0, none: 2 },
  }
}

/** The `tag,key,label,count` line a tag of this name exports as. */
function tagLine(name: string): string {
  return buildStatsCsv(statsTaggedBy([slice('T1', name)]))
    .split('\n')
    .find((line) => line.startsWith('tag,')) ?? ''
}

beforeEach(async () => {
  await initI18n()
})

describe('the formula lead', () => {
  it('is defused in a tag named after a formula, in the exact serialized cell', () => {
    expect(tagLine('=1+1')).toBe(`tag,T1,'=1+1,4`)
  })

  it('defuses the hyperlink payload the imported CSV can carry', () => {
    const [stored] = normalizeTagNames(['=HYPERLINK("http://evil","click")'])

    expect(stored, 'the tag model still admits this name — the export is the last door').toBe(
      '=HYPERLINK("http://evil","click")',
    )
    expect(tagLine(stored!)).toBe(`tag,T1,"'=HYPERLINK(""http://evil"",""click"")",4`)
  })

  it.each([
    ['=', '=1+1', `tag,T1,'=1+1,4`],
    ['+', '+1+1', `tag,T1,'+1+1,4`],
    ['-', '-1+1', `tag,T1,'-1+1,4`],
    ['@', '@SUM(1,2)', `tag,T1,"'@SUM(1,2)",4`],
    ['tab', '\t=1+1', `tag,T1,'\t=1+1,4`],
    ['carriage return', '\r=1+1', `tag,T1,"'\r=1+1",4`],
  ] as const)(
    'defuses a name that opens with %s, to the exact byte',
    (_lead, name, expected) => {
      expect(tagLine(name)).toBe(expected)
    },
  )

  it('leaves an ordinary name alone, because a script reads the label column verbatim', () => {
    expect(tagLine('urgent')).toBe('tag,T1,urgent,4')
    expect(tagLine('5-year plan')).toBe('tag,T1,5-year plan,4')
  })

  it('defuses a list name and a worklog group label the same way, since both run through one cell()', () => {
    const csv = buildStatsCsv(statsTaggedBy([], [slice('L1', '+cmd')]))
    expect(csv).toContain(`list,L1,'+cmd,4`)

    const tracked: Worklog = {
      range: { from: RANGE.from, to: RANGE.to, dimension: 'tag' },
      totalMs: 5_400_000,
      entryCount: 1,
      byDay: [{ day: '2026-10-05', trackedMs: 5_400_000 }],
      byGroup: [{ key: 'T1', label: '@SUM(1,2)', trackedMs: 5_400_000 }],
      truncatedGroups: 0,
      estimatedCount: 0,
      overEstimateCount: 0,
      overEstimateRate: 0,
    }
    // The group row leads with the dimension it was grouped by, not with the word `group`.
    expect(buildStatsCsv(statsTaggedBy([]), tracked)).toContain(`tag,T1,"'@SUM(1,2)",5400000`)
  })

  it('does not mark a number, because the counts are the server\'s own and a minus is a value', () => {
    const csv = buildStatsCsv(statsTaggedBy([]))

    expect(csv).toContain('2026-10-05,4,2')
    expect(csv).toContain('2026-10-05,3,1,4')
    expect(csv).toContain('hour,9,09,4')
    expect(csv).not.toContain("'")
  })
})

describe('the file a script reads', () => {
  it('keeps its BOM, its five tables and their column names, formula marks notwithstanding', () => {
    const csv = buildStatsCsv(statsTaggedBy([slice('T1', '=1+1')]))

    expect(csv.charCodeAt(0), 'the file must start with a UTF-8 BOM').toBe(0xfeff)
    expect(csv).toContain('# table 1: completed and created by period')
    expect(csv).toContain('period,completed,created')
    expect(csv).toContain('distribution,key,label,count')
    expect(csv).toContain('# table 3: cumulative flow by period')
    expect(csv).toContain('period,todo,in_progress,done')
  })
})
