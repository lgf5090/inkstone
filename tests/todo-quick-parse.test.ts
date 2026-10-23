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
import { mapToSourceOffset, normalizeQuickAddInput, normalizeWithPositions, parseQuickAdd } from '../src/shared/todos/quick-parse'

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
  expect(parsed.repeat).toEqual({ freq: 'weekly', interval: 1, weekdays: [5] })
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

it('reads a weekday list as one weekly rule instead of refusing it', () => {
  const parsed = parse('\u6bcf\u5468\u4e00\u4e09\u4e94 \u6668\u8dd1')
  expect(parsed.repeat).toEqual({ freq: 'weekly', interval: 1, weekdays: [1, 3, 5] })
  // Today is Tuesday, so the coming selected day is Wednesday.
  expect(wallClock(parsed.dueAt)).toBe('2026-10-21 23:59')
  expect(parsed.title).toBe('\u6668\u8dd1')

  const spaced = parse('\u6bcf\u5468\u4e09\u3001\u4e94 \u6253\u5361')
  expect(spaced.repeat).toEqual({ freq: 'weekly', interval: 1, weekdays: [3, 5] })
  expect(spaced.title).toBe('\u6253\u5361')
})

it('keeps the interval beside a weekday list', () => {
  const parsed = parse('\u6bcf2\u5468\u5468\u4e00\u3001\u5468\u4e09 \u7ad9\u4f1a')
  expect(parsed.repeat).toEqual({ freq: 'weekly', interval: 2, weekdays: [1, 3] })
  expect(wallClock(parsed.dueAt)).toBe('2026-10-21 23:59')
  expect(parsed.title).toBe('\u7ad9\u4f1a')
})

// `every weekday` is a rhythm that names five days without spelling them, and it ends in the word `day`.
// So the case that matters is not the one that works but the neighbours it must not eat: `every day`,
// `every 2 days` and `every week` all keep the answers they had before this token existed.
it('reads a work week as five named days rather than a daily rhythm', () => {
  const weekday = parse('every weekday standup')
  expect(weekday.repeat).toEqual({ freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] })
  // Today is Tuesday, and a Tuesday is one of the five, so the rhythm opens today rather than tomorrow.
  // The weekday-list case above lands on Wednesday only because Tuesday was not among the days named.
  expect(wallClock(weekday.dueAt)).toBe('2026-10-20 23:59')
  expect(weekday.title).toBe('standup')

  expect(parse('every working day review').repeat).toEqual({ freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] })
  expect(parse('every business days').repeat).toEqual({ freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] })

  const cn = parse('\u6bcf\u4e2a\u5de5\u4f5c\u65e5 \u6253\u5361')
  expect(cn.repeat).toEqual({ freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] })
  expect(wallClock(cn.dueAt)).toBe('2026-10-20 23:59')
  expect(cn.title).toBe('\u6253\u5361')
})

it('leaves the rhythms beside a work week exactly as they were', () => {
  expect(parse('every day jog').repeat).toEqual({ freq: 'daily', interval: 1 })
  expect(parse('every 2 days water plants').repeat).toEqual({ freq: 'daily', interval: 2 })
  expect(parse('every week notes').repeat).toEqual({ freq: 'weekly', interval: 1 })
  expect(parse('every 3 weeks review').repeat).toEqual({ freq: 'weekly', interval: 3 })
  expect(parse('every month close books').repeat).toEqual({ freq: 'monthly', interval: 1 })
  // `gong zuo ri` only means a work week behind `mei`; on its own it is prose, and a title that happens
  // to end in those three characters must not acquire a rhythm nobody asked for.
  const prose = parse('\u5206\u5de5\u4f5c\u65e5')
  expect(prose.repeat).toBeNull()
  expect(prose.title).toBe('\u5206\u5de5\u4f5c\u65e5')
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
  // 45 minutes is not one of the nine tiers, so promising "close enough" would be the parser lying
  // about what the task will actually do. The words stay in the title, unread and unhidden.
  const parsed = parse('\u63d0\u524d45\u5206\u949f\u63d0\u9192 \u660e\u5929 \u4ea4\u7a0e')
  expect(parsed.remindAt).toBeNull()
  expect(parsed.title).toContain('\u63d0\u524d45\u5206\u949f')

  const english = parse('remind me 90 minutes before tomorrow pay tax')
  expect(english.remindAt).toBeNull()
})

// The tiers are a list the forms, the settings merge and the server all read from one table; the typed
// grammar used to hardcode three of them, so the other six existed everywhere except where a reader
// actually types. This is the door that has to keep up.
it('types every reminder tier in either language', () => {
  const due = parse('\u660e\u5929 \u4ea4\u7a0e').dueAt!
  const before = (ms: number) => due - ms
  const cases: [string, number][] = [
    ['\u63d0\u524d5\u5206\u949f\u63d0\u9192 \u660e\u5929 \u4ea4\u7a0e', 5 * 60_000],
    ['\u63d0\u524d10\u5206\u949f \u660e\u5929 \u4ea4\u7a0e', 10 * 60_000],
    ['\u63d0\u524d15\u5206\u949f\u63d0\u9192\u7ed9\u6211 \u660e\u5929 \u4ea4\u7a0e', 15 * 60_000],
    ['\u63d0\u524d\u5341\u5206\u949f\u63d0\u9192 \u660e\u5929 \u4ea4\u7a0e', 10 * 60_000],
    ['\u63d0\u524d30\u5206\u949f\u5185\u63d0\u9192 \u660e\u5929 \u4ea4\u7a0e', 30 * 60_000],
    ['\u63d0\u524d1\u4e2a\u5c0f\u65f6\u63d0\u9192 \u660e\u5929 \u4ea4\u7a0e', 3_600_000],
    ['\u63d0\u524d3\u5929\u63d0\u9192 \u660e\u5929 \u4ea4\u7a0e', 3 * 86_400_000],
    ['\u63d0\u524d1\u5468\u63d0\u9192 \u660e\u5929 \u4ea4\u7a0e', 7 * 86_400_000],
  ]
  for (const [line, ms] of cases) expect(parse(line).remindAt, line).toBe(before(ms))

  expect(parse('remind me 30 minutes before the report tomorrow').remindAt).toBe(before(30 * 60_000))
  // Two hours is not one of the nine tiers, in either language. It is refused rather than snapped to
  // the nearest one: a reminder that fires at a time nobody wrote is a wrong fact with a confident
  // face on it, and the words stay in the title where the reader can see them.
  expect(parse('remind me 2 hours before the report tomorrow').remindAt).toBeNull()
  expect(parse('\u63d0\u524d2\u4e2a\u5c0f\u65f6\u63d0\u9192 \u660e\u5929 \u4ea4\u7a0e').remindAt).toBeNull()
  expect(parse('remind me 3 days before the report tomorrow').remindAt).toBe(before(3 * 86_400_000))
  expect(parse('remind me 1 week before the report tomorrow').remindAt).toBe(before(7 * 86_400_000))
  // The words a person actually types stay read as one of the unit, not as their own special cases.
  expect(parse('remind me an hour before the report tomorrow').remindAt).toBe(before(3_600_000))
  expect(parse('remind me a day before the report tomorrow').remindAt).toBe(before(86_400_000))
  expect(parse('remind me at the due time the report tomorrow').remindAt).toBe(due)
  expect(parse('remind me to send the report tomorrow').remindAt).toBe(due)
})

it('never sets a reminder without a time to count back from', () => {
  const parsed = parse('\u63d0\u524d1\u5c0f\u65f6\u63d0\u9192 \u4ea4\u7a0e')
  expect(parsed.remindAt).toBeNull()
  expect(parsed.dueAt).toBeNull()
})

/**
 * The plan a line carries.
 *
 * A duration is the one field whose words are two letters long, so every case below is a case of two
 * patterns wanting the same characters: the `30` of `30m` is also the `30` of a day of the month, the
 * `1` of `1h` is also the `1` of a clock hour, and the `/` a spent half is written with is the `/` a
 * date is written with. The parser's ruling is the order it consumes in — reminder first, so a
 * reminder's own minutes never become a plan; duration before the rhythm and before the dates, so the
 * unit letters are still there to be read.
 */
it('reads a written duration as the plan the line carries', () => {
  const hour = parse('\u5199\u5468\u62a5 1h')
  expect(hour.timeEstimateMs).toBe(60 * 60_000)
  expect(hour.title, 'the plan was read out of the words left behind').toBe('\u5199\u5468\u62a5')
  expect(parse('\u5199\u5468\u62a5 30m').timeEstimateMs).toBe(30 * 60_000)
  expect(parse('\u5199\u5468\u62a5 1h20m').timeEstimateMs).toBe(80 * 60_000)
  expect(parse('\u5199\u5468\u62a5 1.5h').timeEstimateMs).toBe(90 * 60_000)
})

it('splits the spent half of a pair from the estimate half', () => {
  // `5m/1h` is the reference apps' own syntax and it reads spent-first: five minutes gone, one hour planned.
  const parsed = parse('\u5199\u5468\u62a5 5m/1h')
  expect(parsed.timeLoggedMs).toBe(5 * 60_000)
  expect(parsed.timeEstimateMs).toBe(60 * 60_000)
  expect(parsed.title).toBe('\u5199\u5468\u62a5')
})

it('names no plan on a line that carries none', () => {
  const inputs = [
    '\u4e70\u725b\u5976',
    '10/25 \u4ea4\u4fdd\u9669',
    '10-25 \u4ea4\u4fdd\u9669',
    '30\u53f7 \u4ea4\u4fdd\u9669',
    '10\u670825\u65e5 \u4ea4\u4fdd\u9669',
    '\u4e0b\u53483\u70b9 \u63a5\u5b69\u5b50',
    'remind me 15 minutes tomorrow 10:00 call home',
    '\u8dd1 5min',
    'rest 1hour',
    'run 90minutes',
  ]
  for (const input of inputs) {
    const parsed = parse(input)
    expect(parsed.timeEstimateMs, input).toBeNull()
    expect(parsed.timeLoggedMs, input).toBeNull()
  }
})

it('takes the estimate without eating the slash a date is written with', () => {
  const parsed = parse('10/25 \u4ea4\u4fdd\u9669 1h')
  expect(wallClock(parsed.dueAt), 'the slash still spells a date').toBe('2026-10-25 23:59')
  expect(parsed.timeEstimateMs).toBe(60 * 60_000)
  expect(parsed.title).toBe('\u4ea4\u4fdd\u9669')

  // A pair carries its own slash, and it is the only slash the pair gets to take: the one the date is
  // written with stays where the date is, or the reader loses the day they typed.
  const paired = parse('10/25 \u4ea4\u4fdd\u9669 5m/1h')
  expect(wallClock(paired.dueAt)).toBe('2026-10-25 23:59')
  expect(paired.timeLoggedMs).toBe(5 * 60_000)
  expect(paired.timeEstimateMs).toBe(60 * 60_000)
  expect(paired.title).toBe('\u4ea4\u4fdd\u9669')
})

it('keeps a month-day beside the plan the line names', () => {
  const parsed = parse('10\u670825\u65e5 \u4ea4\u4fdd\u9669 30m')
  expect(wallClock(parsed.dueAt)).toBe('2026-10-25 23:59')
  expect(parsed.timeEstimateMs).toBe(30 * 60_000)
  expect(parsed.title).toBe('\u4ea4\u4fdd\u9669')

  const dashed = parse('\u5f00\u4f1a10-25\u62a5\u544a3\u70b9 1h20m')
  expect(wallClock(dashed.dueAt)).toBe('2026-10-25 03:00')
  expect(dashed.timeEstimateMs).toBe(80 * 60_000)
})

it('reads a clock hour and a plan in the same line without confusing them', () => {
  const parsed = parse('\u660e\u5929\u4e0b\u53481\u70b9 \u5f00\u4f1a 1h')
  expect(wallClock(parsed.dueAt)).toBe('2026-10-21 13:00')
  expect(parsed.timeEstimateMs).toBe(60 * 60_000)
  expect(parsed.title).toBe('\u5f00\u4f1a')

  const english = parse('submit the report tomorrow 3pm 1h')
  expect(wallClock(english.dueAt)).toBe('2026-10-21 15:00')
  expect(english.timeEstimateMs).toBe(60 * 60_000)
  expect(english.title).toBe('submit the report')
})

it('leaves a rhythm word to the rhythm pass and takes only the duration', () => {
  const parsed = parse('\u6bcf\u5929 \u6253\u5361 30m')
  expect(parsed.repeat).toEqual({ freq: 'daily', interval: 1 })
  expect(parsed.timeEstimateMs).toBe(30 * 60_000)
  expect(parsed.title).toBe('\u6253\u5361')
})

it('reads the reminder before the plan, so a reminder\u2019s minutes stay the reminder', () => {
  const han = parse('\u63d0\u524d15\u5206\u949f\u63d0\u9192 \u660e\u592910\u70b9 \u6253\u75ab\u82d7')
  expect(han.timeEstimateMs).toBeNull()
  expect(han.timeLoggedMs).toBeNull()
  expect(wallClock(han.remindAt)).toBe('2026-10-21 09:45')

  const english = parse('remind me 15 minutes tomorrow 10:00 call home')
  expect(english.timeEstimateMs, '15 minutes is an offset, not a plan').toBeNull()
  expect(wallClock(english.remindAt)).toBe('2026-10-21 09:45')
  expect(english.title).toBe('call home')

  const both = parse('\u63d0\u524d15\u5206\u949f\u63d0\u9192 \u660e\u592910\u70b9 \u6253\u75ab\u82d7 1h')
  expect(both.timeEstimateMs).toBe(60 * 60_000)
  expect(wallClock(both.remindAt)).toBe('2026-10-21 09:45')
  expect(both.title).toBe('\u6253\u75ab\u82d7')
})

it('leaves a plan past the ceiling a row may carry in the title', () => {
  // Three hundred hours is over the ten working days one task may hold: promising it would be a
  // create the server answers 400, so the words stay where the reader can see and fix them.
  const parsed = parse('\u4ea4\u5468\u62a5 300h')
  expect(parsed.timeEstimateMs).toBeNull()
  expect(parsed.title).toBe('\u4ea4\u5468\u62a5 300h')
  expect(parsed.tokens).toEqual([])
})

it('reports the plan it read as the words it read them from', () => {
  const parsed = parse('\u5199\u5468\u62a5 5m/1h')
  const spans = parsed.tokens.filter((token) => token.kind === 'time')
  expect(spans.map((token) => token.text)).toEqual(['5m/1h'])
  expect(parsed.source.slice(spans[0]!.start, spans[0]!.end)).toBe('5m/1h')
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

/**
 * Where the parser says a token is.
 *
 * `tokens` is grouped by field for the preview row, so its array order is not the order of the words,
 * and the parser cuts each span out of a string that keeps shrinking under it. Either of those read as
 * the same bug in a highlight layer: the right words painted over the wrong ones. The two assertions
 * below are what a colour is allowed to rest on, and they are the reason `start` exists at all, so
 * they run over a corpus rather than over the case that motivated them.
 */
const OFFSET_CORPUS = [
  '\u660e\u5929 \u4e70\u725b\u5976',
  '\u660e\u5929\u4e0b\u53483\u70b9 \u4ea4\u5468\u62a5 #\u5de5\u4f5c !2',
  '#\u5de5\u4f5c \u660e\u5929\u4e09\u70b9',
  '\u4ea4\u5468\u62a5 #\u5de5\u4f5c !2 @\u81ea\u5a92\u4f53',
  '\u5f00\u4f1a10-25\u62a5\u544a3\u70b9',
  '\u4e0b\u5348 \u63d0\u524d15\u5206\u949f\u63d0\u9192 3\u70b9 \u6253\u75ab\u82d7',
  '\u63d0\u524d15\u5206\u949f\u63d0\u9192 \u660e\u592910\u70b9 \u6253\u75ab\u82d7',
  '\u6bcf\u5468\u4e09\u3001\u4e94 \u6253\u5361',
  '\u6bcf2\u5468\u5468\u4e00\u3001\u5468\u4e09 \u7ad9\u4f1a',
  '\u6708\u5e95 \u4ea4\u62a5\u8868',
  '\u660e\u665a \u770b\u7535\u5f71 !1 #\u79c1',
  '3\u5929\u540e \u4ea4\u623f\u79df \u63d0\u524d1\u5c0f\u65f6\u63d0\u9192',
  '15:30 \u63a5\u5b69\u5b50',
  '\u4eca\u665a \u770b\u7535\u5f71',
  '#a #b #c \u5f00\u4f1a',
  '\u4e0a\u534810\u70b9 \u8bc4\u5ba1 p2 @\u4ea7\u54c1 #\u5de5\u4f5c \u6bcf\u5468\u4e8c',
  '2026-11-11 \u9001\u793c @\u81ea\u5a92\u4f53',
  'submit the report tomorrow 3pm #work p1',
  'in 3 days ship it',
  'every 2 weeks review notes on friday',
  'remind me 15 minutes tomorrow 10:00 call home',
  '   \u660e\u5929   \u4e0b\u53483\u70b9  \u5f00\u4f1a  ',
  '\u6bcf\u5929 \u6253\u5361 !3 #habit',
  '\u4e0b\u5468\u4e94 \u4ea4\u62a5\u544a @\u81ea\u5a92\u4f53 \u5230\u671f\u63d0\u9192',
  // The plan is the newest span in the line, and every one of these puts it next to a pattern that
  // would read the same characters as its own: a slash date, a day of the month, a clock, a rhythm.
  '\u5199\u5468\u62a5 1h',
  '\u4ea4\u5468\u62a5 5m/1h',
  '10/25 \u4ea4\u4fdd\u9669 1h',
  '\u5f00\u4f1a10-25\u62a5\u544a3\u70b9 1h20m',
  '\u6bcf\u5929 \u6253\u5361 30m !2',
  '\u4e0b\u5348 \u63d0\u524d15\u5206\u949f\u63d0\u9192 3\u70b9 \u6253\u75ab\u82d7 1h',
  '\u63d0\u524d15\u5206\u949f\u63d0\u9192 \u660e\u592910\u70b9 \u6253\u75ab\u82d7 1.5h',
  'remind me 15 minutes tomorrow 10:00 call home 1h',
  'submit the report tomorrow 3pm 1h #work',
  '   \u660e\u5929   10/25  \u4ea4\u5468\u62a5  1h  ',
]

function expectOffsetsHold(input: string): void {
  const parsed = parse(input)
  expect(parsed.source).toBe(normalizeQuickAddInput(input))
  // A line that yields no token would pass the two loops below by never entering them, so the corpus
  // is checked for carrying something first.
  expect(parsed.tokens.length, `nothing was recognised in ${input}`).toBeGreaterThan(0)
  for (const token of parsed.tokens) {
    expect(parsed.source.slice(token.start, token.end), `${token.kind} ${token.text} in ${input}`).toBe(token.text)
  }
  // In input order the spans are the words themselves: each one inside the line, and none of them
  // standing on another. A highlight drawn over an overlap would paint one field's colour onto
  // another's words, which is the same defect wearing a different hat.
  let after = 0
  for (const token of [...parsed.tokens].sort((a, b) => a.start - b.start)) {
    expect(token.start).toBeGreaterThanOrEqual(0)
    expect(token.end).toBeLessThanOrEqual(parsed.source.length)
    expect(token.start).toBeGreaterThanOrEqual(after)
    after = token.end
  }
}

it('reports every token at the place in the line where its own words are', () => {
  for (const input of OFFSET_CORPUS) expectOffsetsHold(input)
})

it('keeps the array grouped by field while the offsets follow the words', () => {
  // The chip row is grouped by field and the highlight layer reads in order; one of the two would be
  // wrong whichever way the array went, so both orders are pinned here rather than inferred.
  const parsed = parse('#\u5de5\u4f5c \u660e\u5929\u4e09\u70b9')
  expect(parsed.tokens.map((token) => token.kind)).toEqual(['date', 'time', 'tag'])
  expect(parsed.tokens.map((token) => token.start)).toEqual([4, 6, 0])
})

it('records a span the input does not hold together as the pieces it really is', () => {
  // `xia-wu ti-qian 15 fen-zhong ti-xing 3 dian`: the reminder is cut out first, so the clock reads as
  // one time across the gap the cut left. No range of the input contains both halves and not the
  // reminder, so the parser says so instead of drawing one that covers the words in between.
  const parsed = parse('\u4e0b\u5348 \u63d0\u524d15\u5206\u949f\u63d0\u9192 3\u70b9 \u6253\u75ab\u82d7')
  const times = parsed.tokens.filter((token) => token.kind === 'time')
  expect(times.map((token) => token.text)).toEqual(['\u4e0b\u5348', '3\u70b9'])
  expect(times.map((token) => `${token.start}:${token.end}`)).toEqual(['0:2', '12:14'])
  const remind = parsed.tokens.find((token) => token.kind === 'remind')!
  expect(parsed.source.slice(remind.start, remind.end)).toBe('\u63d0\u524d15\u5206\u949f\u63d0\u9192')
})

it('reads the line the offsets are measured against, not the keystrokes', () => {
  const parsed = parse('   \u660e\u5929   \u4e0b\u53483\u70b9  \u5f00\u4f1a  ')
  expect(parsed.source).toBe('\u660e\u5929 \u4e0b\u53483\u70b9 \u5f00\u4f1a')
  expect(parsed.tokens.find((token) => token.kind === 'date')?.start).toBe(0)
})

it('maps a working-string index back to the input, and says where there is no input character', () => {
  // The table is the whole claim: a character the parser still holds points at the input, and the one
  // space a cut leaves standing, position -1, points nowhere rather than at its neighbour.
  const positions = [0, 1, 2, -1, 7, 8]
  expect(mapToSourceOffset(0, positions)).toBe(0)
  expect(mapToSourceOffset(2, positions)).toBe(2)
  expect(mapToSourceOffset(3, positions)).toBeNull()
  expect(mapToSourceOffset(4, positions)).toBe(7)
  expect(mapToSourceOffset(9, positions)).toBeNull()
})

it('walks the whitespace to the same line the one-liner normalizes to', () => {
  // The parser's own surgery and the highlight layer both read the position walk, so the walk has to
  // answer with exactly the string `normalizeQuickAddInput` answers with. Otherwise a span measured on
  // one of them lands a character off on the other, and none of the assertions above would notice.
  for (const input of OFFSET_CORPUS) {
    const kept = normalizeWithPositions(input, input.split('').map((_, index) => index))
    expect(kept.text).toBe(normalizeQuickAddInput(input))
    expect(kept.positions).toHaveLength(kept.text.length)
  }
})

