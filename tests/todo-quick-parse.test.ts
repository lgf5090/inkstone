// @vitest-environment node
/**
 * Quick-add parsing.
 *
 * What is pinned is the two ways a parser like this fails a reader: it invents a date the words never
 * said, or it silently drops a phrase it did not understand. Every "no" assertion below (an unsupported
 * rhythm stays in the title, an unrecognised offset never sets a reminder) matters as much as the yes
 * assertions, because the words left visible are the ones the reader can still fix.
 *
 * The clock is fixed to one instant and read in two zones, so the zone-dependent cases cannot be written
 * as a coincidence of the machine this runs on. `2026-10-20` is a Tuesday.
 */
import { expect, it } from 'vitest'
import { getZonedParts } from '../src/shared/assistant-schedule'
import { parseQuickAdd } from '../src/shared/todos/quick-parse'

/** One instant, read as 01:30 on Tuesday 2026-10-20 in Shanghai and 17:30 on Monday in London. */
const NOW = Date.parse('2026-10-19T17:30:00Z')
const CN = 'Asia/Shanghai'

const parse = (input: string, timeZone = CN) => parseQuickAdd(input, NOW, timeZone)

/** Local wall clock in the reading zone, which is the only form a reader can check the answer against. */
function wallClock(millis: number | null, timeZone = CN): string {
  if (millis === null) return 'none'
  const parts = getZonedParts(new Date(millis), timeZone)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
}

it('reads a relative day and keeps the rest of the line as the title', () => {
  const parsed = parse('\u660e\u5929 \u4e70\u725b\u5976')
  expect(wallClock(parsed.dueAt)).toBe('2026-10-21 23:59')
  expect(parsed.title).toBe('\u4e70\u725b\u5976')
})

it('reads a period word with a clock number as that hour, not the end of the day', () => {
  const parsed = parse('\u660e\u5929\u4e0b\u53483\u70b9 \u5f00\u4f1a')
  expect(wallClock(parsed.dueAt)).toBe('2026-10-21 15:00')
  expect(parsed.title).toBe('\u5f00\u4f1a')
})

it('reads half past and a colon time beside a period word', () => {
  expect(wallClock(parse('\u4e0b\u53483\u70b9\u534a \u63a5\u5b69\u5b50').dueAt)).toBe('2026-10-20 15:30')
  expect(wallClock(parse('\u4e0b\u53483:30 \u63a5\u5b69\u5b50').dueAt)).toBe('2026-10-20 15:30')
})

it('takes a bare time as today while it is still ahead and tomorrow once it has passed', () => {
  expect(wallClock(parse('15:30 \u63a5\u5b69\u5b50').dueAt)).toBe('2026-10-20 15:30')
  expect(wallClock(parse('00:30 \u53d6\u8d27').dueAt)).toBe('2026-10-21 00:30')
})

it('splits symbols into tags, a list and a priority, and leaves no marker in the title', () => {
  const parsed = parse('\u4ea4\u5468\u62a5 #\u5de5\u4f5c !2 @\u81ea\u5a92\u4f53')
  expect(parsed.title).toBe('\u4ea4\u5468\u62a5')
  expect(parsed.tags).toEqual(['\u5de5\u4f5c'])
  expect(parsed.listName).toBe('\u81ea\u5a92\u4f53')
  expect(parsed.priority).toBe('high')
})

it('maps !1 to the most urgent, the way the reference apps number P1', () => {
  expect(parse('\u6551\u706b !1').priority).toBe('urgent')
  expect(parse('\u6551\u706b !4').priority).toBe('low')
  expect(parse('\u6551\u706b p3').priority).toBe('medium')
})

it('dedupes and caps tags through the same rule the store enforces', () => {
  expect(parse('#a #a #b').tags).toEqual(['a', 'b'])
})

it('turns a named weekday into the coming one and a weekly rhythm', () => {
  const parsed = parse('\u6bcf\u5468\u4e94 \u5199\u5468\u62a5')
  expect(parsed.repeat).toEqual({ freq: 'weekly', interval: 1 })
  expect(wallClock(parsed.dueAt)).toBe('2026-10-23 23:59')
  expect(parsed.title).toBe('\u5199\u5468\u62a5')
})

it('pushes a next-week weekday a full week past the coming one', () => {
  // Today is Tuesday, so the coming Monday is the 26th and `xia zhou yi` is the 2nd of November.
  expect(wallClock(parse('\u4e0b\u5468\u4e00 \u590d\u76d8').dueAt)).toBe('2026-11-02 23:59')
})

it('reads an interval rhythm in either spelling and clamps the count', () => {
  expect(parse('\u6bcf\u5929 \u6253\u5361').repeat).toEqual({ freq: 'daily', interval: 1 })
  expect(parse('\u6bcf2\u5468 \u6d17\u8f66').repeat).toEqual({ freq: 'weekly', interval: 2 })
  expect(parse('\u6bcf\u6708\u5e95 \u4ea4\u62a5\u8868').repeat).toBeNull()
})

it('refuses a rhythm that names two weekdays instead of guessing one', () => {
  const parsed = parse('\u6bcf\u5468\u4e09\u3001\u4e94 \u6253\u5361')
  expect(parsed.repeat).toBeNull()
  expect(parsed.title).toContain('\u6bcf\u5468\u4e09')
})

it('reads an absolute day, rolling a passed month-day into next year', () => {
  expect(wallClock(parse('10-25 \u4ea4\u4fdd\u9669').dueAt)).toBe('2026-10-25 23:59')
  expect(wallClock(parse('12-31 \u8de8\u5e74').dueAt)).toBe('2026-12-31 23:59')
  expect(wallClock(parse('09-15 \u8865\u6863\u6848').dueAt)).toBe('2027-09-15 23:59')
  expect(wallClock(parse('2026-11-11 \u9001\u793c').dueAt)).toBe('2026-11-11 23:59')
})

it('lands the last day of the month on the 31st, and February on its own last day', () => {
  expect(wallClock(parse('\u6708\u5e95 \u4ea4\u62a5\u8868').dueAt)).toBe('2026-10-31 23:59')
  const march = parseQuickAdd('\u6708\u5e95 \u4ea4\u62a5\u8868', Date.parse('2026-02-10T09:00:00Z'), CN)
  expect(wallClock(march.dueAt)).toBe('2026-02-28 23:59')
})

it('counts a shift in days from the reader’s own today', () => {
  expect(wallClock(parse('3\u5929\u540e \u4ea4\u623f\u79df').dueAt)).toBe('2026-10-23 23:59')
  expect(wallClock(parse('\u540e\u5929 \u4ea4\u623f\u79df').dueAt)).toBe('2026-10-22 23:59')
  expect(wallClock(parse('\u5927\u540e\u5929 \u4ea4\u623f\u79df').dueAt)).toBe('2026-10-23 23:59')
})

it('resolves the same instant against the account zone, not the machine’s', () => {
  // The same fire is Tuesday in Shanghai and Monday evening in London: `jin-tian` cannot be one answer.
  expect(wallClock(parse('\u4eca\u5929 \u5199\u65e5\u8bb0').dueAt, CN)).toBe('2026-10-20 23:59')
  expect(wallClock(parseQuickAdd('\u4eca\u5929 \u5199\u65e5\u8bb0', NOW, 'Europe/London').dueAt, 'Europe/London')).toBe('2026-10-19 23:59')
})

it('keeps a wall clock across a daylight-saving boundary', () => {
  // New York is on EST at this instant and on EDT on the day being named: the wall clock the reader
  // asked for is 09:00 on the 8th, and only the UTC offset is allowed to move.
  const across = parseQuickAdd('\u660e\u59299\u70b9 \u5f00\u4f1a', Date.parse('2026-03-07T14:00:00Z'), 'America/New_York')
  expect(wallClock(across.dueAt, 'America/New_York')).toBe('2026-03-08 09:00')
})

it('turns a reminder phrase into an offset from the due time it was written beside', () => {
  const parsed = parse('\u63d0\u524d15\u5206\u949f\u63d0\u9192 \u660e\u592910\u70b9 \u6253\u7599\u82d7')
  expect(wallClock(parsed.dueAt)).toBe('2026-10-21 10:00')
  expect(wallClock(parsed.remindAt)).toBe('2026-10-21 09:45')
})

it('takes an at-the-due-time reminder as the due instant itself', () => {
  const parsed = parse('\u5230\u671f\u63d0\u9192 \u660e\u5929 \u4ea4\u7a0e')
  expect(parsed.remindAt).toBe(parsed.dueAt)
})

it('leaves an offset the app cannot store in the title instead of rounding it', () => {
  // The shipped offsets are 15m, 1h, 1d and at-due. Ten minutes is not one of them, so promising
  // "close enough" would be the parser lying about what the task will actually do.
  const parsed = parse('\u63d0\u524d10\u5206\u949f\u63d0\u9192 \u660e\u5929 \u4ea4\u7a0e')
  expect(parsed.remindAt).toBeNull()
  expect(parsed.title).toContain('\u63d0\u524d10\u5206\u949f')
})

it('never sets a reminder without a time to count back from', () => {
  const parsed = parse('\u63d0\u524d1\u5c0f\u65f6\u63d0\u9192 \u4ea4\u7a0e')
  expect(parsed.remindAt).toBeNull()
  expect(parsed.dueAt).toBeNull()
})

it('reads the English half of the vocabulary', () => {
  const parsed = parse('submit the report tomorrow 3pm #work p1', 'UTC')
  expect(parsed.title).toBe('submit the report')
  expect(wallClock(parsed.dueAt, 'UTC')).toBe('2026-10-20 15:00')
  expect(parsed.tags).toEqual(['work'])
  expect(parsed.priority).toBe('urgent')
})

it('reads tonight as an evening on the coming day', () => {
  expect(wallClock(parse('\u4eca\u665a \u770b\u7535\u5f71').dueAt)).toBe('2026-10-20 19:00')
  expect(wallClock(parseQuickAdd('tonight call home', NOW, 'UTC').dueAt, 'UTC')).toBe('2026-10-19 19:00')
})

it('reports what it understood, in reading order, for the preview row', () => {
  const parsed = parse('\u660e\u5929\u4e0b\u53483\u70b9 \u4ea4\u5468\u62a5 #\u5de5\u4f5c !2')
  expect(parsed.tokens.map((token) => token.kind)).toEqual(['date', 'time', 'priority', 'tag'])
  expect(parsed.tokens.find((token) => token.kind === 'tag')?.text).toBe('#\u5de5\u4f5c')
})

it('invents no title when only a date was typed', () => {
  const parsed = parse('\u660e\u5929')
  expect(parsed.title).toBe('')
  expect(parsed.dueAt).not.toBeNull()
})

it('leaves a line it does not understand exactly as it was written', () => {
  const input = '\u7ed9\u82b1\u6d47\u6c34'
  const parsed = parse(input)
  expect(parsed.title).toBe(input)
  expect(parsed.dueAt).toBeNull()
  expect(parsed.remindAt).toBeNull()
  expect(parsed.priority).toBeNull()
  expect(parsed.tags).toEqual([])
  expect(parsed.listName).toBeNull()
  expect(parsed.repeat).toBeNull()
  expect(parsed.tokens).toEqual([])
})

it('does not claim a number inside a title as a date or a priority', () => {
  const parsed = parse('\u770b\u7b2c 3 \u7ae0')
  expect(parsed.dueAt).toBeNull()
  expect(parsed.priority).toBeNull()
  expect(parsed.title).toContain('3')
})
