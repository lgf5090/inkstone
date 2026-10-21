import { describe, expect, it } from 'vitest'
import { compileMemoFilter, type MemoFilterContext, type MemoFilterRecord } from './index'

const fixedContext: MemoFilterContext = {
  viewerId: 'user-1',
  now: Date.UTC(2024, 2, 10, 12, 0, 0) / 1000,
  timeZone: 'Asia/Tokyo',
}

const baseRecord: MemoFilterRecord = {
  id: 'memo-1',
  creatorId: 'user-1',
  content: 'TODO ship v2',
  tags: ['work'],
  visibility: 'public',
  pinned: false,
  spaceId: null,
  size: 120,
  hasLink: false,
  hasCode: false,
  hasTaskList: false,
  hasIncompleteTasks: false,
  hasLocation: false,
  createdAt: Date.UTC(2024, 2, 9, 16, 0, 0) / 1000,
  updatedAt: Date.UTC(2024, 2, 9, 16, 30, 0) / 1000,
}

function evaluates(
  expression: string,
  record: MemoFilterRecord = baseRecord,
  context: MemoFilterContext = fixedContext,
): boolean {
  const compiled = compileMemoFilter(expression)
  if (!compiled.ok) {
    throw new Error(`"${expression}" failed validation: ${compiled.error.message} at ${compiled.error.position}`)
  }
  return compiled.filter.matches(record, context)
}

const recordWith = (patch: Partial<MemoFilterRecord>): MemoFilterRecord => ({ ...baseRecord, ...patch })

describe('memo view examples', () => {
  it('pinned', () => {
    expect(evaluates('pinned', recordWith({ pinned: true }))).toBe(true)
    expect(evaluates('pinned')).toBe(false)
  })

  it('created_ts >= now - duration("1h")', () => {
    const near = { ...fixedContext, now: baseRecord.createdAt + 1_800 }
    const far = { ...fixedContext, now: baseRecord.createdAt + 7_200 }
    expect(evaluates('created_ts >= now - duration("1h")', baseRecord, near)).toBe(true)
    expect(evaluates('created_ts >= now - duration("1h")', baseRecord, far)).toBe(false)
  })

  it('visibility == "PUBLIC"', () => {
    expect(evaluates('visibility == "PUBLIC"')).toBe(true)
    expect(evaluates('visibility == "PUBLIC"', recordWith({ visibility: 'private' }))).toBe(false)
  })

  it('tag in ["work", "personal"]', () => {
    expect(evaluates('tag in ["work", "personal"]', recordWith({ tags: ['work', 'work/done'] }))).toBe(true)
    expect(evaluates('tag in ["work", "personal"]', recordWith({ tags: ['personal'] }))).toBe(true)
    expect(evaluates('tag in ["work", "personal"]', recordWith({ tags: ['work/2024'] }))).toBe(false)
  })

  it('size(tags) == 0', () => {
    expect(evaluates('size(tags) == 0', recordWith({ tags: [] }))).toBe(true)
    expect(evaluates('size(tags) == 0')).toBe(false)
  })

  it('tags.exists(t, t.startsWith("archive"))', () => {
    expect(evaluates('tags.exists(t, t.startsWith("archive"))', recordWith({ tags: ['archive/2024'] }))).toBe(true)
    expect(evaluates('tags.exists(t, t.startsWith("archive"))')).toBe(false)
  })

  it('space == null', () => {
    expect(evaluates('space == null')).toBe(true)
    expect(evaluates('space == null', recordWith({ spaceId: 'space-1' }))).toBe(false)
  })

  it('space == "spaces/your-space-id"', () => {
    expect(evaluates('space == "spaces/your-space-id"', recordWith({ spaceId: 'your-space-id' }))).toBe(true)
    expect(evaluates('space == "spaces/your-space-id"')).toBe(false)
  })

  it('has_task_list && has_incomplete_tasks', () => {
    expect(evaluates('has_task_list && has_incomplete_tasks', recordWith({ hasTaskList: true, hasIncompleteTasks: true }))).toBe(true)
    expect(evaluates('has_task_list && has_incomplete_tasks', recordWith({ hasTaskList: true }))).toBe(false)
  })

  it('has_link || has_code', () => {
    expect(evaluates('has_link || has_code', recordWith({ hasCode: true }))).toBe(true)
    expect(evaluates('has_link || has_code', recordWith({ hasLink: true }))).toBe(true)
    expect(evaluates('has_link || has_code')).toBe(false)
  })

  it('!has_location', () => {
    expect(evaluates('!has_location')).toBe(true)
    expect(evaluates('!has_location', recordWith({ hasLocation: true }))).toBe(false)
  })

  it('content.contains("TODO")', () => {
    expect(evaluates('content.contains("TODO")')).toBe(true)
    expect(evaluates('content.contains("TODO")', recordWith({ content: 'ship later' }))).toBe(false)
  })

  it('content.startsWith("TODO")', () => {
    expect(evaluates('content.startsWith("TODO")')).toBe(true)
    expect(evaluates('content.startsWith("TODO")', recordWith({ content: 'later TODO' }))).toBe(false)
  })

  it('content.matches("v[0-9]+")', () => {
    expect(evaluates('content.matches("v[0-9]+")')).toBe(true)
    expect(evaluates('content.matches("v[0-9]+")', recordWith({ content: 'TODO ship' }))).toBe(false)
  })

  it('tags.all(t, t.endsWith("-done"))', () => {
    expect(evaluates('tags.all(t, t.endsWith("-done"))', recordWith({ tags: ['a-done', 'b-done'] }))).toBe(true)
    expect(evaluates('tags.all(t, t.endsWith("-done"))', recordWith({ tags: ['a-done', 'b'] }))).toBe(false)
    expect(evaluates('tags.all(t, t.endsWith("-done"))', recordWith({ tags: [] }))).toBe(false)
  })

  it('tags.exists_one(t, t.startsWith("project/"))', () => {
    expect(evaluates('tags.exists_one(t, t.startsWith("project/"))', recordWith({ tags: ['project/a'] }))).toBe(true)
    expect(evaluates('tags.exists_one(t, t.startsWith("project/"))', recordWith({ tags: ['project/a', 'project/b'] }))).toBe(false)
    expect(evaluates('tags.exists_one(t, t.startsWith("project/"))')).toBe(false)
  })

  it('sets.intersects(tags, ["work", "urgent"])', () => {
    expect(evaluates('sets.intersects(tags, ["work", "urgent"])')).toBe(true)
    expect(evaluates('sets.intersects(tags, ["work", "urgent"])', recordWith({ tags: ['other'] }))).toBe(false)
  })

  it('sets.equivalent(tags, ["inbox"])', () => {
    expect(evaluates('sets.equivalent(tags, ["inbox"])', recordWith({ tags: ['inbox'] }))).toBe(true)
    expect(evaluates('sets.equivalent(tags, ["inbox"])', recordWith({ tags: ['inbox', 'extra'] }))).toBe(false)
    expect(evaluates('sets.equivalent(tags, ["inbox"])', recordWith({ tags: [] }))).toBe(false)
  })

  it('created_ts.getFullYear() == 2024', () => {
    expect(evaluates('created_ts.getFullYear() == 2024')).toBe(true)
    expect(evaluates('created_ts.getFullYear() == 2024', recordWith({ createdAt: Date.UTC(2023, 5, 1) / 1000 }))).toBe(false)
  })

  it('created_ts.getDayOfWeek() == 0 || created_ts.getDayOfWeek() == 6', () => {
    expect(evaluates('created_ts.getDayOfWeek() == 0 || created_ts.getDayOfWeek() == 6')).toBe(true)
    expect(
      evaluates(
        'created_ts.getDayOfWeek() == 0 || created_ts.getDayOfWeek() == 6',
        recordWith({ createdAt: Date.UTC(2024, 2, 6, 12) / 1000 }),
      ),
    ).toBe(false)
  })

  it('size(content) > 280', () => {
    expect(evaluates('size(content) > 280', recordWith({ content: 'a'.repeat(281) }))).toBe(true)
    expect(evaluates('size(content) > 280', recordWith({ content: 'a'.repeat(280) }))).toBe(false)
  })
})

describe('memo filter fields', () => {
  it('reads visibility as the upper-case enum name', () => {
    expect(evaluates('visibility == "PRIVATE"', recordWith({ visibility: 'private' }))).toBe(true)
    expect(evaluates('visibility == "public"')).toBe(false)
    expect(evaluates('visibility in ["PUBLIC", "PROTECTED"]')).toBe(true)
    expect(evaluates('visibility in ["PUBLIC", "PROTECTED"]', recordWith({ visibility: 'private' }))).toBe(false)
  })

  it('supports membership tests with "in"', () => {
    expect(evaluates('"work" in tags')).toBe(true)
    expect(evaluates('"personal" in tags')).toBe(false)
    expect(evaluates('tag in []')).toBe(false)
    expect(evaluates('"work" in []')).toBe(false)
  })

  it('reads creator resource names and the viewer alias', () => {
    expect(evaluates('creator == "users/user-1"')).toBe(true)
    expect(evaluates('creator != "users/user-2"')).toBe(true)
    expect(evaluates('creator == "me"')).toBe(true)
    expect(evaluates('creator == "me"', baseRecord, { ...fixedContext, viewerId: 'user-2' })).toBe(false)
    expect(evaluates('creator != "me"', baseRecord, { ...fixedContext, viewerId: 'user-2' })).toBe(true)
  })

  it('reads the caller supplied size attribute', () => {
    expect(evaluates('size > 100')).toBe(true)
    expect(evaluates('size > 200')).toBe(false)
  })

  it('compares booleans explicitly', () => {
    expect(evaluates('pinned == false')).toBe(true)
    expect(evaluates('pinned != true')).toBe(true)
    expect(evaluates('has_location == false')).toBe(true)
    expect(evaluates('pinned == true', recordWith({ pinned: true }))).toBe(true)
  })

  it('compares space with strings and null', () => {
    expect(evaluates('space != null', recordWith({ spaceId: 'space-1' }))).toBe(true)
    expect(evaluates('space == "spaces/space-1"', recordWith({ spaceId: 'space-1' }))).toBe(true)
    expect(evaluates('space == "spaces/space-2"', recordWith({ spaceId: 'space-1' }))).toBe(false)
  })
})

describe('memo filter string matching', () => {
  it('folds case for contains, startsWith and endsWith', () => {
    expect(evaluates('content.contains("todo")')).toBe(true)
    expect(evaluates('content.startsWith("todo")')).toBe(true)
    expect(evaluates('content.endsWith("V2")')).toBe(true)
    expect(evaluates('content.endsWith("v3")')).toBe(false)
  })

  it('folds non-ASCII case', () => {
    expect(evaluates('content.contains("café")', recordWith({ content: 'CAFÉ latte' }))).toBe(true)
    expect(evaluates('content.startsWith("éclair")', recordWith({ content: 'ÉCLAIR' }))).toBe(true)
  })

  it('keeps matches case-sensitive', () => {
    expect(evaluates('content.matches("todo")')).toBe(false)
    expect(evaluates('content.matches("TODO")')).toBe(true)
  })

  it('decodes escapes in string literals and regex patterns', () => {
    expect(evaluates('content.contains("line\\n")', recordWith({ content: 'line\nbreak' }))).toBe(true)
    expect(evaluates('content.matches("^#\\\\s")', recordWith({ content: '# heading' }))).toBe(true)
  })
})

describe('memo filter timestamps', () => {
  it('parses timestamp literals as UTC instants', () => {
    expect(evaluates('created_ts >= timestamp("2024-01-01")')).toBe(true)
    expect(evaluates('created_ts < timestamp("2024-01-01")')).toBe(false)
    expect(evaluates('created_ts >= timestamp("2024-03-09T16:00:00Z")')).toBe(true)
    expect(evaluates('created_ts > timestamp("2024-03-09T16:00:00Z")')).toBe(false)
  })

  it('parses durations and folds arithmetic in seconds', () => {
    expect(evaluates('updated_ts - created_ts == duration("30m")')).toBe(true)
    expect(evaluates('updated_ts - created_ts <= duration("1h")')).toBe(true)
    expect(evaluates('updated_ts - created_ts <= duration("10m")')).toBe(false)
    expect(evaluates('created_ts + duration("30m") == updated_ts')).toBe(true)
    expect(evaluates('duration("1.5h") == duration("90m")')).toBe(true)
    expect(evaluates('duration("1h") + duration("30m") == duration("90m")')).toBe(true)
    expect(evaluates('now >= created_ts + duration("20h")')).toBe(true)
  })

  it('reads date parts in the requested time zone', () => {
    const tokyo = fixedContext
    expect(evaluates('created_ts.getFullYear() == 2024', baseRecord, tokyo)).toBe(true)
    expect(evaluates('created_ts.getMonth() == 2', baseRecord, tokyo)).toBe(true)
    expect(evaluates('created_ts.getDate() == 10', baseRecord, tokyo)).toBe(true)
    expect(evaluates('created_ts.getDayOfWeek() == 0', baseRecord, tokyo)).toBe(true)
    expect(evaluates('created_ts.getHours() == 1', baseRecord, tokyo)).toBe(true)
    expect(evaluates('created_ts.getMinutes() == 0', baseRecord, tokyo)).toBe(true)
    expect(evaluates('created_ts.getSeconds() == 0', baseRecord, tokyo)).toBe(true)

    const utc = { ...fixedContext, timeZone: 'UTC' }
    expect(evaluates('created_ts.getDate() == 9', baseRecord, utc)).toBe(true)
    expect(evaluates('created_ts.getDayOfWeek() == 6', baseRecord, utc)).toBe(true)
    expect(evaluates('created_ts.getHours() == 16', baseRecord, utc)).toBe(true)
    expect(evaluates('created_ts.getDate() == 10', baseRecord, utc)).toBe(false)
  })

  it('reads date parts of now across a day boundary', () => {
    const newYork = {
      viewerId: 'user-1',
      now: Date.UTC(2024, 0, 1, 0, 30, 0) / 1000,
      timeZone: 'America/New_York',
    }
    expect(evaluates('now.getFullYear() == 2023', baseRecord, newYork)).toBe(true)
    expect(evaluates('now.getMonth() == 11', baseRecord, newYork)).toBe(true)
    expect(evaluates('now.getDate() == 31', baseRecord, newYork)).toBe(true)
    expect(evaluates('now.getDayOfWeek() == 0', baseRecord, newYork)).toBe(true)
    expect(evaluates('now.getHours() == 19', baseRecord, newYork)).toBe(true)
    expect(evaluates('now.getMinutes() == 30', baseRecord, newYork)).toBe(true)
    expect(evaluates('now.getSeconds() == 0', baseRecord, newYork)).toBe(true)

    const utc = { ...newYork, timeZone: 'UTC' }
    expect(evaluates('now.getFullYear() == 2024', baseRecord, utc)).toBe(true)
    expect(evaluates('now.getMonth() == 0', baseRecord, utc)).toBe(true)
    expect(evaluates('now.getDate() == 1', baseRecord, utc)).toBe(true)
    expect(evaluates('now.getHours() == 0', baseRecord, utc)).toBe(true)
    expect(evaluates('now.getFullYear() == 2024', baseRecord, newYork)).toBe(false)
  })

  it('evaluates accessors on computed timestamps', () => {
    expect(evaluates('(now - duration("1h")).getHours() == 20')).toBe(true)
    expect(evaluates('created_ts.getFullYear() == now.getFullYear()')).toBe(true)
  })
})

describe('memo filter tag lambdas and sets', () => {
  it('binds the lambda variable per tag', () => {
    expect(evaluates('tags.exists(t, t in ["work", "draft"])')).toBe(true)
    expect(evaluates('tags.exists(t, t in ["draft"])')).toBe(false)
    expect(evaluates('tags.all(t, t != "draft")', recordWith({ tags: ['work', 'inbox'] }))).toBe(true)
    expect(evaluates('tags.all(t, t != "draft")', recordWith({ tags: ['work', 'draft'] }))).toBe(false)
  })

  it('follows the set operation definitions', () => {
    expect(evaluates('sets.contains(tags, [])')).toBe(true)
    expect(evaluates('sets.contains(tags, ["work", "urgent"])')).toBe(false)
    expect(evaluates('sets.intersects(tags, [])')).toBe(false)
    expect(evaluates('sets.equivalent(tags, [])', recordWith({ tags: [] }))).toBe(true)
    expect(evaluates('sets.equivalent(tags, [])')).toBe(false)
    expect(evaluates('sets.equivalent(tags, ["work", "work"])')).toBe(true)
  })

  it('counts content by code point', () => {
    expect(evaluates('size(content) == 140', recordWith({ content: '😀'.repeat(140) }))).toBe(true)
    expect(evaluates('size(content) == 280', recordWith({ content: '😀'.repeat(140) }))).toBe(false)
    expect(evaluates('size(tags) == 2', recordWith({ tags: ['a', 'b'] }))).toBe(true)
  })
})
