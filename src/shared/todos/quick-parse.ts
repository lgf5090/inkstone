/**
 * Quick-add parsing: one line of prose in, a task draft out.
 *
 * A line like `ming-tian xia-wu 3 dian  jiao zhou-bao  #gong-zuo  !2  @zi-mei-ti  ti-qian 15 fen-zhong ti-xing`
 * (tomorrow 3 p.m., file the weekly report, tag work, priority two, list self-media, remind 15 minutes
 * before) answers with the words that are left as the title plus the fields those words named. It is
 * deterministic and dependency-free on purpose: a to-do app that resolves dates through a network call
 * writes a wrong date with confidence and stops working on a train, while this is readable, testable, and
 * offline. Anything it does not recognise stays in the title — a phrase the reader can still see is
 * recoverable, an invented date is not.
 *
 * Chinese words are written as `\uXXXX` escapes because `scripts/check-i18n.mjs` admits Han characters
 * only into the locale catalog, and these are parsing patterns rather than interface copy. Each one
 * carries a pinyin gloss below.
 */
import type { TaskPriority } from '../assistant'
import { daysInMonth, getZonedParts, zonedTimeToUtc } from '../assistant-schedule'
import { TASK_DURATION_PATTERN, parseTaskDuration } from './duration'
import {
  MAX_LIST_NAME_CHARS,
  MAX_TAG_NAME_CHARS,
  MAX_REPEAT_INTERVAL,
  MIN_REPEAT_INTERVAL,
  isTimeEstimateMs,
  normalizeTagNames,
  type RemindOffset,
  type RepeatFrequency,
  type RepeatRule,
} from './model'

/**
 * What the parser recognised, so the input row can show it back before anything is written.
 *
 * `time` carries the clock *and* the plan: the two are one family of words — "when, and for how long" —
 * and the surfaces that paint or speak a token key their colour and their label off this union, so a
 * new kind is a change to those files rather than to this one.
 */
export type QuickAddTokenKind = 'date' | 'time' | 'repeat' | 'remind' | 'priority' | 'tag' | 'list'

export interface QuickAddToken {
  kind: QuickAddTokenKind
  /** The exact words that were understood, as they appeared in the input. */
  text: string
  /**
   * Where those words sit in `QuickAddParse.source` — the input with runs of whitespace collapsed to
   * one space and the ends trimmed, which is what `source` holds and what a highlight layer paints.
   *
   * Every coordinate here is measured against that one string, never against the raw keystrokes and
   * never against the shrinking working string the parser cuts its spans out of. A caller holding the
   * raw line maps `start`/`end` across with `normalizeWithPositions`; the board's inline field does
   * exactly that in `features/todos/quick-add-highlight.ts`.
   */
  start: number
  /** One past the last character of the token, in the same coordinates as `start`. */
  end: number
}

export interface QuickAddParse {
  /** The input with every recognised span cut out; whitespace collapsed, never invented. */
  title: string
  /**
   * The string `tokens` are measured against: `input` with `\s+` collapsed to single spaces and
   * trimmed, exactly as the parser reads it. The raw input is not it whenever the reader typed two
   * spaces in a row or left the line open at either end.
   */
  source: string
  dueAt: number | null
  remindAt: number | null
  priority: TaskPriority | null
  tags: string[]
  listName: string | null
  repeat: RepeatRule | null
  /**
   * The plan the line carries, in milliseconds, or null when it named none.
   *
   * `1h`, `30m`, `1h20m` and the right half of `5m/1h` all land here: it is what the row says the work
   * will take, which is a column of the row and what the create body carries.
   */
  timeEstimateMs: number | null
  /**
   * Hours the line says have already gone, in milliseconds: the left half of `5m/1h`.
   *
   * Null unless the line was written as a pair. It is a fact about the ledger rather than a property of
   * the row, so a caller files it through the ledger's back-fill door and not on the create body.
   */
  timeLoggedMs: number | null
  tokens: QuickAddToken[]
}

/** How long a written-out date may be before it stops being a date and is left as prose. */
const MAX_TAG_CHARS = MAX_TAG_NAME_CHARS
const MAX_LIST_CHARS = MAX_LIST_NAME_CHARS

/**
 * The wall-clock rule the whole app already uses: a date with no hour means "by the end of that day"
 * (23:59), which is what the server's own `parseLocalTime` does. Keeping it here means the preview chip
 * and the row the server writes cannot disagree.
 */
const END_OF_DAY_HOUR = 23
const END_OF_DAY_MINUTE = 59

/** A bare time-of-day word with no number beside it. */
const DEFAULT_HOURS: Record<string, number> = {
  '\u65e9\u4e0a': 8, // zao-shang, morning
  '\u4e0a\u5348': 9, // shang-wu, a.m.
  '\u4e2d\u5348': 12, // zhong-wu, noon
  '\u4e0b\u5348': 14, // xia-wu, p.m.
  '\u665a\u4e0a': 19, // wan-shang, evening
  '\u591c\u91cc': 21, // ye-li, night
}

/** `!1` is what the reference apps call P1 — the most urgent, not the highest number. */
const PRIORITY_BY_DIGIT: Record<string, TaskPriority> = {
  '1': 'urgent',
  '2': 'high',
  '3': 'medium',
  '4': 'low',
}

/** CJK numerals up through ten, which is as far as an interval or a day-of-month ever needs to be read. */
const CN_DIGITS: Record<string, number> = {
  '\u96f6': 0, // ling
  '\u4e00': 1, // yi
  '\u4e8c': 2, // er
  '\u4e24': 2, // liang, the spoken two
  '\u4e09': 3, // san
  '\u56db': 4, // si
  '\u4e94': 5, // wu
  '\u516d': 6, // liu
  '\u4e03': 7, // qi
  '\u516b': 8, // ba
  '\u4e5d': 9, // jiu
  '\u5341': 10, // shi
}

/** Day one through seven, and both words Sunday uses (`ri` and `tian`). */
const WEEKDAY_BY_CHAR: Record<string, number> = {
  '\u4e00': 1, // yi, Monday
  '\u4e8c': 2, // er, Tuesday
  '\u4e09': 3, // san, Wednesday
  '\u56db': 4, // si, Thursday
  '\u4e94': 5, // wu, Friday
  '\u516d': 6, // liu, Saturday
  '\u65e5': 0, // ri, Sunday
  '\u5929': 0, // tian, Sunday in its spoken form
  '0': 0,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 0,
}

const WEEKDAY_BY_NAME: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

/**
 * Monday to Friday, the days a reader means by `every weekday`.
 *
 * Written out rather than generated by excluding the weekend, because the two spellings are different
 * answers: a work week is the five days, and a project that works six does not get a second token —
 * the rule it produces names the days, so the reader can move Friday off it in the editor.
 */
const WORKDAYS = [1, 2, 3, 4, 5] as const

/**
 * The word a reader types after `every`, and the frequency the rule stores for it.
 *
 * They are different vocabularies on purpose: a frequency names the unit a cycle advances by, and the
 * plain English word for that unit is one letter shorter. Listing them here is what keeps the pair from
 * drifting, since the compiler checks each value but nothing checks a bare cast.
 */
const REPEAT_FREQ_BY_UNIT: Record<string, RepeatFrequency | undefined> = {
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
  year: 'yearly',
}

const MONTH_BY_NAME: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/** `x y` pair: a shift of days from the reader's own today. */
const DAY_SHIFT: Record<string, number> = {
  '\u4eca\u5929': 0, // jin-tian, today
  '\u4eca\u65e5': 0, // jin-ri, today (written)
  '\u660e\u5929': 1, // ming-tian, tomorrow
  '\u660e\u65e5': 1, // ming-ri, tomorrow (written)
  '\u540e\u5929': 2, // hou-tian, the day after tomorrow
  '\u5927\u540e\u5929': 3, // da-hou-tian, three days out
}

/** The evening words that name a day and an hour at once. */
const EVENING_SHIFT: Record<string, number> = {
  '\u4eca\u665a': 0, // jin-wan, tonight
  '\u660e\u665a': 1, // ming-wan, tomorrow evening
}

/**
 * One duration as it is written on a line of prose, or the pair `spent/plan` beside it.
 *
 * The words are `duration.ts`'s own grammar, dropped in rather than restated: the quick-add line and
 * the estimate field have to read `1h20m` the same way, and the one way to guarantee that is for only
 * one file to know what the letters mean. What lives here is the *edge* of a span, which only exists on
 * a line of prose — a duration is a plan only when nothing sticks to it, so `x3m` stays a variable,
 * `5min` and `1hour` stay words, and `10-25` stays the day of the month it was written as.
 */
const ONE_DURATION = `(?:${TASK_DURATION_PATTERN})`
const TIME_PLAN_PATTERN = new RegExp(String.raw`(?<![\w./-])${ONE_DURATION}(?:\s*\/\s*${ONE_DURATION})?(?!\w)`, 'i')

interface Draft {
  dayShift: number | null
  monthDay: { month: number, day: number } | null
  absolute: { year: number, month: number, day: number } | null
  hour: number | null
  minute: number | null
}

/**
 * A number written either as digits or as one CJK numeral, optionally followed by `shi` for the teens
 * (twelve through nineteen) — enough for a day of month, an interval, or a clock hour, and nothing more.
 */
function readCount(source: string): number | null {
  const digits = /^\d{1,4}/.exec(source)
  if (digits) return Number(digits[0])
  const first = source.charAt(0)
  if (!(first in CN_DIGITS)) return null
  const head = CN_DIGITS[first]!
  if (head === 10) return 10
  const ten = /^\u5341(\d|[0-9\u4e00-\u4e5d])?/.exec(source)
  if (source.startsWith('\u5341')) return 10 + (ten && ten[1] ? (CN_DIGITS[ten[1]] ?? Number(ten[1]) ?? 0) : 0)
  const pair = /^(\d|[\u4e00-\u4e5d])\u5341/.exec(source)
  if (pair && pair[1]) {
    const tens = CN_DIGITS[pair[1]] ?? Number(pair[1])
    if (Number.isFinite(tens)) return tens * 10 + (head === 10 ? 0 : head)
  }
  return head
}

/**
 * The line as the parser reads it: every run of whitespace becomes one space, and nothing is left at
 * either end. Token coordinates are measured against this string and nothing else, so the words a
 * highlight layer paints are the words the parser measured.
 */
export function normalizeQuickAddInput(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

/**
 * Where one index of the parser's shrinking working string sits in the input it was cut from, or null
 * when the character there is the space a cut left behind rather than a character of the input.
 *
 * `sourcePositions` is the table the surgery rebuilds on every cut: `sourcePositions[i]` names the
 * position in the normalized input that the working string's character `i` came from. A list of
 * deleted intervals is the smaller structure, and it is wrong: a cut puts one space where the words
 * were, and when the span sat between two characters that were not spaces — a month-day written in
 * the middle of a run of words — that space is a character the input never had, and every offset
 * after it drifts by one. Drift by one paints the right words in the wrong place, which is the failure
 * this table exists to make impossible; `tests/todo-quick-parse.test.ts` pins the property it protects.
 */
export function mapToSourceOffset(restIndex: number, sourcePositions: readonly number[]): number | null {
  const position = sourcePositions[restIndex] ?? -1
  return position < 0 ? null : position
}

/**
 * The same normalization as `normalizeQuickAddInput`, with the characters it dropped named.
 *
 * `positions[i]` says where `text[i]` came from, and the answer keeps the characters that were *not*
 * written down — the space a cut left where the words were carries whatever the table says of it, which
 * is -1 when no input character is behind it. One walk, one rule, so a caller outside the parser can
 * carry its own offsets across the same collapse and cannot possibly disagree with the parser about
 * which line it was reading. `tests/todo-quick-parse.test.ts` holds the two against each other.
 */
export function normalizeWithPositions(text: string, positions: readonly number[]): { text: string, positions: number[] } {
  let kept = ''
  const keptPositions: number[] = []
  let index = 0
  while (index < text.length) {
    if (!/\s/.test(text[index]!)) {
      kept += text[index]
      keptPositions.push(positions[index]!)
      index += 1
      continue
    }
    let runEnd = index
    while (runEnd < text.length && /\s/.test(text[runEnd]!)) runEnd += 1
    // A run keeps one space only where words stand on both sides of it, which is the whole rule the
    // normalization applies to a line.
    if (kept.length > 0 && runEnd < text.length) {
      kept += ' '
      keptPositions.push(positions[index]!)
    }
    index = runEnd
  }
  return { text: kept, positions: keptPositions }
}

export function parseQuickAdd(input: string, now: number, timeZone: string): QuickAddParse {
  const tokens: QuickAddToken[] = []
  const draft: Draft = { dayShift: null, monthDay: null, absolute: null, hour: null, minute: null }
  let priority: TaskPriority | null = null
  let listName: string | null = null
  let repeat: RepeatRule | null = null
  let remindAt: number | null = null
  let remindOffset: RemindOffset | null = null
  let timeEstimateMs: number | null = null
  let timeLoggedMs: number | null = null
  const tagNames: string[] = []

  const source = normalizeQuickAddInput(input)
  let rest = source
  /** Where each character of `rest` came from in `source`; -1 marks a space a cut left standing. */
  let restPositions = source.split('').map((_, index) => index)

  /**
   * Record the span the parser just matched, placed back on `source`.
   *
   * `text` stays what it always was — the matched words, edges trimmed — and `start`/`end` are added
   * beside it, so `source.slice(start, end)` is that text by construction rather than by hope.
   */
  const record = (kind: QuickAddTokenKind, restStart: number, restEnd: number): void => {
    /** One run of characters that were neighbours in the input becomes one token of this kind. */
    const pushRun = (from: number, to: number): void => {
      let first = from
      let last = to
      while (first < last && (mapToSourceOffset(first, restPositions) === null || /\s/.test(rest[first]!))) first += 1
      while (last > first && (mapToSourceOffset(last - 1, restPositions) === null || /\s/.test(rest[last - 1]!))) last -= 1
      const start = mapToSourceOffset(first, restPositions)
      const tail = mapToSourceOffset(last - 1, restPositions)
      if (start === null || tail === null) return
      tokens.push({ kind, text: source.slice(start, tail + 1), start, end: tail + 1 })
    }

    let runStart: number | null = null
    let expected = -1
    for (let index = restStart; index < restEnd; index += 1) {
      const position = mapToSourceOffset(index, restPositions)
      if (runStart !== null && position !== null && position === expected) {
        expected = position + 1
        continue
      }
      if (runStart !== null) pushRun(runStart, index)
      runStart = position === null ? null : index
      if (position !== null) expected = position + 1
    }
    if (runStart !== null) pushRun(runStart, restEnd)
  }

  /**
   * Cut `rest`'s span out, and rebuild the text and its position table in the same pass.
   *
   * The surgery is what it always was — the words go, one space is put where they were, and the line is
   * collapsed and trimmed as `normalizeQuickAddInput` would. What is new is that the table is walked
   * alongside it, so a character that stops existing stops being counted, and the space the cut leaves
   * is carried as -1: no character of the input stands behind it.
   */
  const cut = (restStart: number, restEnd: number): void => {
    const merged = `${rest.slice(0, restStart)} ${rest.slice(restEnd)}`
    const mergedPositions = [...restPositions.slice(0, restStart), -1, ...restPositions.slice(restEnd)]
    const kept = normalizeWithPositions(merged, mergedPositions)
    rest = kept.text
    restPositions = kept.positions
  }

  /** Cut the first span matching `pattern`, record it, and hand the match back for the handler. */
  const consume = (kind: QuickAddTokenKind, pattern: RegExp, apply: (match: RegExpExecArray) => boolean): boolean => {
    const match = pattern.exec(rest)
    if (!match || match[0].length === 0) return false
    if (!apply(match)) return false
    const start = match.index
    const end = start + match[0].length
    record(kind, start, end)
    cut(start, end)
    return true
  }

  // Symbols first: they are unambiguous, and a `#` or `@` inside a date phrase would be the reader's own
  // typing rather than something a pattern can reason about.
  const tagPattern = /(?:^|\s)#([^\s#@!]{1,40})/
  while (true) {
    const match = tagPattern.exec(rest)
    if (!match) break
    const name = match[1]!
    if (name.length > MAX_TAG_CHARS) break
    tagNames.push(name)
    record('tag', match.index, match.index + match[0].length)
    cut(match.index, match.index + match[0].length)
    if (!tagPattern.test(rest)) break
  }

  consume('list', /(?:^|\s)@([^\s#@!]{1,40})/, (match) => {
    listName = match[1]!.slice(0, MAX_LIST_CHARS)
    return true
  })

  consume('priority', /(?:[!]{1}([1-4])(?=\s|$))|(?:\bp([1-4])\b)/i, (match) => {
    const digit = match[1] ?? match[2]
    if (!digit) return false
    priority = PRIORITY_BY_DIGIT[digit] ?? null
    return priority !== null
  })

  // Reminders, before the date pass: `ti qian 15 fen zhong ti xing wo` contains a numeral that a bare
  // date pattern would otherwise be glad to claim as a day of the month.
  consume('remind', /\u63d0\u524d\s*(15|\u5341\u4e94)\s*\u5206\u949f(?:\u5185)?(?:\u63d0\u9192|\u901a\u77e5)?(?:\u7ed9\u6211)?/, () => {
    remindOffset = '15m'
    return true
  })
  consume('remind', /\u63d0\u524d\s*(1|\u4e00)\s*(?:\u4e2a)?\u5c0f\u65f6(?:\u5185)?(?:\u63d0\u9192|\u901a\u77e5)?/, () => {
    remindOffset = '1h'
    return true
  })
  consume('remind', /\u63d0\u524d\s*(1|\u4e00)\s*\u5929(?:\u63d0\u9192|\u901a\u77e5)?/, () => {
    remindOffset = '1d'
    return true
  })
  consume('remind', /(?:\u5230\u671f|\u51c6\u70b9|\u6b63\u786e\u65f6\u95f4)(?:\u63d0\u9192|\u901a\u77e5|\u544a\u8bc9\u6211)?/, (match) => {
    // Bare `dao qi` ("due") is a word people write in titles, so only the reminder spellings count.
    if (!/\u63d0\u9192|\u901a\u77e5|\u544a\u8bc9\u6211/.test(match[0])) return false
    remindOffset = 'due'
    return true
  })
  consume('remind', /\bremind(?:er)?\s+me\s+(15\s*minutes?|an?\s*hour|a\s*day|at\s*the\s*due\s*time)?/i, (match) => {
    const words = match[1]?.toLowerCase() ?? ''
    remindOffset = words.includes('minute') ? '15m'
      : words.includes('hour') ? '1h'
      : words.includes('day') ? '1d'
      : 'due'
    return true
  })

  // The plan, between the reminder and the rhythm. The order is the whole design of this pass: read
  // after the reminder, so the minutes a reminder names are spent on the reminder and never become an
  // estimate; read before the rhythm and the dates, so the `m` of `30m` is still standing when the only
  // reader that would take it for a day of the month comes round. A pair is read spent-first — `5m/1h`
  // is five minutes gone of an hour planned — and a half that is not a duration refuses the whole span,
  // because half a pair cut out of a line would leave the reader with the other half as prose.
  consume('time', TIME_PLAN_PATTERN, (match) => {
    const [first, second] = match[0].split('/')
    const estimate = parseTaskDuration(second ?? first!)
    if (estimate === null || !isTimeEstimateMs(estimate)) return false
    timeEstimateMs = estimate
    if (second !== undefined) {
      const spent = parseTaskDuration(first!)
      if (spent === null) return false
      timeLoggedMs = spent
    }
    return true
  })

  // Repeat before the single-date pass, because `mei zhou wu` names both a rhythm and a weekday, and the
  // generic rhythm pattern alone would eat the `mei zhou` and leave the `wu` stranded in the title. A
  // list — `mei zhou yi san wu`, or the same days separated by a comma — is one rule with several
  // weekdays, and the due date is the first of them that is still ahead.
  const today = getZonedParts(new Date(now), timeZone)

  // `mei ge gong zuo ri` is the same rhythm as `every weekday`: Monday to Friday, and nobody names a day.
  // Its own pass rather than a branch of the weekday list below, because that list is spelled out of the
  // characters a reader may type after `mei zhou` and `gong zuo ri` shares none of them. It also has to
  // come before the generic unit pass, which would read the trailing `ri` ("day") as a daily rhythm —
  // the wrong answer twice over, once for the interval and once for the five days.
  consume('repeat', /\u6bcf(?:\u9694)?\s*(?:\u4e2a)?\s*(\u5de5\u4f5c\u65e5|\u5de5\u4f5c\u5929)/, () => {
    repeat = { freq: 'weekly', interval: 1, weekdays: [...WORKDAYS] }
    draft.dayShift = Math.min(...WORKDAYS.map((weekday) => nextWeekdayShift(today, weekday, timeZone)))
    return true
  })

  consume('repeat', /\u6bcf(?:\u9694)?\s*(\d{1,2}|[\u4e00-\u4e5d\u5341])?\s*(?:\u4e2a)?(\u5468|\u661f\u671f|\u793c\u62dc)\s*((?:(?:\u5468|\u661f\u671f|\u793c\u62dc)?[0-9\u4e00-\u516d\u65e5\u5929])+(?:\s*[\u3001,\u548c\u53ca]\s*(?:(?:\u5468|\u661f\u671f|\u793c\u62dc)?[0-9\u4e00-\u516d\u65e5\u5929])+)*)/, (match) => {
    const days = new Set<number>()
    for (const character of match[3]!) {
      const weekday = WEEKDAY_BY_CHAR[character]
      if (weekday !== undefined) days.add(weekday)
    }
    if (!days.size) return false
    const interval = match[1] ? readCount(match[1]) : 1
    if (interval === null || interval < MIN_REPEAT_INTERVAL) return false
    const weekdays = [...days].sort((a, b) => a - b)
    repeat = { freq: 'weekly', interval: Math.min(interval, MAX_REPEAT_INTERVAL), weekdays }
    draft.dayShift = Math.min(...weekdays.map((weekday) => nextWeekdayShift(today, weekday, timeZone)))
    return true
  })
  consume('repeat', /\u6bcf(\u5929|\u65e5)/, () => {
    repeat = { freq: 'daily', interval: 1 }
    return true
  })
  consume('repeat', /(?:\u6bcf|\u6bcf\u9694)\s*(\d{1,2}|[0-9\u4e00-\u4e5d\u5341])?\s*(?:\u4e2a)?(\u5929|\u65e5|\u5468|\u661f\u671f|\u793c\u62dc|\u6708|\u5e74)(?!\s*[\u3001,\u548c\u53ca]?\s*[\u5e95\u672b0-9\u4e00-\u516d\u65e5\u5929])/, (match) => {
    const unit = match[2]!
    const raw = match[1]
    const interval = raw ? readCount(raw) : 1
    if (interval === null || interval < MIN_REPEAT_INTERVAL) return false
    const freq: RepeatFrequency = unit === '\u6708' ? 'monthly'
      : unit === '\u5e74' ? 'yearly'
      : unit === '\u5468' || unit === '\u661f\u671f' || unit === '\u793c\u62dc' ? 'weekly'
      : 'daily'
    repeat = { freq, interval: Math.min(interval, MAX_REPEAT_INTERVAL) }
    return true
  })
  // The English twin of `mei ge gong zuo ri`, and it has to come before the generic unit pass below for
  // the same reason: `every weekday` ends in the word `day`, and reading it as a daily rhythm would lose
  // both the five days and the week. `every day`, `every week` and `every 2 days` all miss this pattern
  // and keep the answers they already had.
  consume('repeat', /\bevery\s+(?:the\s+)?(?:week|work|working|business)\s*-?\s*days?\b/i, () => {
    repeat = { freq: 'weekly', interval: 1, weekdays: [...WORKDAYS] }
    draft.dayShift = Math.min(...WORKDAYS.map((weekday) => nextWeekdayShift(today, weekday, timeZone)))
    return true
  })
  consume('repeat', /\bevery\s+(?:(\d{1,2})\s+)?(day|week|month|year)s?\b/i, (match) => {
    const interval = match[1] ? Number(match[1]) : 1
    const freq = REPEAT_FREQ_BY_UNIT[match[2]!.toLowerCase()]
    if (interval < MIN_REPEAT_INTERVAL) return false
    // Read from the table rather than cast: the word a reader types is not the name the rule stores
    // (`day` is not a frequency), and the cast that used to do this handed back `freq: 'day'`, which
    // `parseRepeatRule` refuses on the way in — so `every day` from quick add saved a task that
    // repeated nothing, and said nothing about it.
    if (!freq) return false
    repeat = { freq, interval: Math.min(interval, MAX_REPEAT_INTERVAL) }
    return true
  })

  // Dates. Each pattern is tried in order and the first that applies removes its own span, so a phrase
  // cannot be read twice.

  consume('date', /(?:(?<!\u6bcf))(?:\u4e0b|\u8fd9|\u672c|\u8fd9\u4e2a)?\s*(\u5468|\u661f\u671f|\u793c\u62dc)\s*([0-9\u4e00-\u4e5d\u5929\u65e5])/, (match) => {
    const prefix = match[0].slice(0, Math.max(0, match[0].indexOf(match[1]!)))
    const next = /\u4e0b/.test(prefix)
    const named = match[2]!
    const weekday = WEEKDAY_BY_CHAR[named]
    if (weekday === undefined) return false
    const shift = nextWeekdayShift(today, weekday, timeZone)
    // `zhou wu` on a Friday means today's slot; the reader who says `xia zhou wu` means next week's, and
    // nothing in between.
    draft.dayShift = next ? shift + 7 : shift
    return true
  })

  consume('date', /(?:(?<!\u6bcf))(?:\u4e0b\s*(?:\u4e2a)?\u6708\s*\u5e95|\u672c\s*(?:\u4e2a)?\u6708\s*\u5e95|\u6708\u5e95|\u6708\u672b)/, (match) => {
    const nextMonth = /\u4e0b/.test(match[0])
    const month = nextMonth ? (today.month % 12) + 1 : today.month
    const year = nextMonth && today.month === 12 ? today.year + 1 : today.year
    draft.absolute = { year, month, day: daysInMonth(year, month) }
    return true
  })

  consume('date', /(?:\u4e0b|\u8fd9|\u672c|\u4e0b\u4e2a)?\s*\u5468\s*\u672b/, (match) => {
    const todayWeekday = new Date(zonedTimeToUtc(today.year, today.month, today.day, 12, 0, timeZone)).getUTCDay()
    const toSaturday = (6 - todayWeekday + 7) % 7
    draft.dayShift = /\u4e0b/.test(match[0]) ? toSaturday + 7 : toSaturday
    return true
  })

  for (const [word, shift] of Object.entries(DAY_SHIFT)) {
    if (consume('date', new RegExp(`(?:^|\\s)${word}`), () => {
      draft.dayShift = shift
      return true
    })) break
  }

  for (const [word, shift] of Object.entries(EVENING_SHIFT)) {
    if (consume('date', new RegExp(word), () => {
      draft.dayShift = shift
      draft.hour = DEFAULT_HOURS['\u665a\u4e0a']!
      return true
    })) break
  }

  consume('date', /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/, (match) => {
    draft.absolute = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
    return true
  })
  consume('date', /(\d{1,2})\s*(?:\u6708)\s*(\d{1,2})\s*(?:\u65e5|\u53f7)?/, (match) => {
    draft.monthDay = { month: Number(match[1]), day: Number(match[2]) }
    return true
  })
  consume('date', /\b(\d{1,2})[/-](\d{1,2})\b/, (match) => {
    draft.monthDay = { month: Number(match[1]), day: Number(match[2]) }
    return true
  })
  consume('date', /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i, (match) => {
    const month = MONTH_BY_NAME[match[1]!.toLowerCase().slice(0, 3)]
    if (!month) return false
    draft.monthDay = { month, day: Number(match[1]) }
    return true
  })
  consume('date', /\b(next\s+)?(mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat|suns?|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i, (match) => {
    const key = match[2]!.toLowerCase().slice(0, 3)
    const weekday = WEEKDAY_BY_NAME[key]
    if (weekday === undefined) return false
    const shift = nextWeekdayShift(today, weekday, timeZone)
    draft.dayShift = match[1] ? shift + 7 : shift
    return true
  })
  consume('date', /\b(today|tonight|tomorrow)\b/i, (match) => {
    const word = match[1]!.toLowerCase()
    draft.dayShift = word === 'tomorrow' ? 1 : 0
    if (word === 'tonight') draft.hour = DEFAULT_HOURS['\u665a\u4e0a']!
    return true
  })
  consume('date', /\bin\s+(\d{1,3})\s+days?\b/i, (match) => {
    draft.dayShift = Number(match[1])
    return true
  })
  consume('date', /(\d{1,3}|[0-9\u4e00-\u4e5d\u5341]+)\s*(?:\u4e2a)?\s*\u5929\u540e/, (match) => {
    const count = readCount(match[1]!)
    if (count === null || count === 0) return false
    draft.dayShift = count
    return true
  })

  // Times, last: a period word is meaningful on its own, and a number with `dian` or a colon is not a date.
  consume('time', /(?:\u65e9\u4e0a|\u4e0a\u5348|\u4e2d\u5348|\u4e0b\u5348|\u665a\u4e0a|\u591c\u91cc)\s*(\d{1,2}|[0-9\u4e00-\u4e5d\u5341]+)?\s*(?:\u70b9|\u65f6)?\s*(?:\u534a|(\d{1,2})\s*\u5206|[:\uff1a](\d{2}))?/, (match) => {
    const period = match[0].match(/^\s*(\u65e9\u4e0a|\u4e0a\u5348|\u4e2d\u5348|\u4e0b\u5348|\u665a\u4e0a|\u591c\u91cc)/)![1]!
    const hourWords = match[1]
    const rawHour = hourWords ? readCount(hourWords) : null
    if (hourWords !== undefined && hourWords !== null && rawHour === null) return false
    let hour = rawHour ?? DEFAULT_HOURS[period]!
    const half = /(?:\u534a)$/.test(match[0])
    const minutes = match[2] ? Number(match[2]) : match[3] ? Number(match[3]) : half ? 30 : 0
    const pm = period === '\u4e0b\u5348' || period === '\u665a\u4e0a' || period === '\u591c\u91cc'
    if (pm && hour < 12) hour += 12
    if (hour > 23) return false
    draft.hour = hour % 24
    draft.minute = minutes > 59 ? 0 : minutes
    return true
  })
  consume('time', /(?<![\d:])(\d{1,2}|[\u4e00-\u4e5d\u5341]+)\s*\u70b9(?:\u534a|(\d{1,2})\s*\u5206)?/, (match) => {
    // A period word has already answered this one, and a rhythm count is not a clock.
    if (draft.hour !== null) return false
    const hour = readCount(match[1]!)
    if (hour === null || hour > 23) return false
    draft.hour = hour
    draft.minute = match[0].endsWith('\u534a') ? 30 : match[2] ? Number(match[2]) : 0
    return true
  })
  consume('time', /\b(\d{1,2})\s*[:\uff1a]\s*(\d{2})\b/, (match) => {
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour > 23 || minute > 59) return false
    draft.hour = hour
    draft.minute = minute
    return true
  })
  consume('time', /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i, (match) => {
    const suffix = match[3]!.toLowerCase()
    let hour = Number(match[1])
    if (hour < 1 || hour > 12) return false
    if (suffix === 'pm' && hour !== 12) hour += 12
    if (suffix === 'am' && hour === 12) hour = 0
    draft.hour = hour
    draft.minute = match[2] ? Number(match[2]) : 0
    return true
  })

  // Resolve the day the words pointed at, then the hour, in the reader's own zone.
  let resolved: { year: number, month: number, day: number } | null = null
  if (draft.absolute) {
    resolved = draft.absolute
  } else if (draft.monthDay) {
    // A bare `10-25` is this year's, and when that day has already passed it is next year's — the same
    // reading a reference app gives, and the only one that keeps `12-31` in January useful.
    const candidate = { year: today.year, month: draft.monthDay.month, day: draft.monthDay.day }
    const candidateMillis = zonedTimeToUtc(candidate.year, candidate.month, candidate.day, 23, 59, timeZone).getTime()
    resolved = candidateMillis < now ? { ...candidate, year: candidate.year + 1 } : candidate
  } else {
    const shift = draft.dayShift
    if (shift !== null) {
      const shifted = new Date(zonedTimeToUtc(today.year, today.month, today.day, 12, 0, timeZone))
      shifted.setUTCDate(shifted.getUTCDate() + shift)
      resolved = { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }
    }
  }

  let dueAt: number | null = null
  if (resolved) {
    const hour = draft.hour ?? END_OF_DAY_HOUR
    const minute = draft.minute ?? (draft.hour === null ? END_OF_DAY_MINUTE : 0)
    dueAt = zonedTimeToUtc(resolved.year, resolved.month, resolved.day, hour, minute, timeZone).getTime()
    // A day named without a clock means "by the end of it". When that instant is already behind the
    // reader the day still stands and the hour stays at the end of it — moving the day silently is the
    // mistake a reader cannot see, while a late hour is one they can.
  } else if (draft.hour !== null) {
    // A time with no day: today if it is still ahead, otherwise the same hour tomorrow.
    const tonight = zonedTimeToUtc(today.year, today.month, today.day, draft.hour, draft.minute ?? 0, timeZone).getTime()
    const day = tonight > now ? { year: today.year, month: today.month, day: today.day } : shiftDay(today, 1, timeZone)
    dueAt = zonedTimeToUtc(day.year, day.month, day.day, draft.hour, draft.minute ?? 0, timeZone).getTime()
  }

  if (dueAt !== null && remindOffset !== null && remindOffset !== 'none') {
    const offsetMs = remindOffset === '15m' ? 15 * 60_000
      : remindOffset === '1h' ? 60 * 60_000
      : remindOffset === '1d' ? 24 * 60 * 60_000
      : 0
    remindAt = dueAt - offsetMs
  }

  // Grouped for the preview row, which reads better by field than by position: the order of this array
  // is not the order of the words. Anything that paints or speaks the line uses `start` for that.
  tokens.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))

  return {
    title: rest.trim(),
    source,
    dueAt,
    remindAt,
    priority,
    tags: normalizeTagNames(tagNames),
    listName,
    repeat,
    timeEstimateMs,
    timeLoggedMs,
    tokens,
  }
}

/** The preview shows the day before the clock, then the framing fields, then what the words organise. */
const KIND_ORDER: QuickAddTokenKind[] = ['date', 'time', 'repeat', 'remind', 'priority', 'list', 'tag']

function shiftDay(parts: { year: number, month: number, day: number }, days: number, timeZone: string) {
  const shifted = new Date(zonedTimeToUtc(parts.year, parts.month, parts.day, 12, 0, timeZone))
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }
}

/** How many days from the reader's own today the next `weekday` falls, noon-anchored so a short or long
 * day in the zone cannot move which calendar day it is. */
function nextWeekdayShift(parts: { year: number, month: number, day: number }, weekday: number, timeZone: string): number {
  const anchor = new Date(zonedTimeToUtc(parts.year, parts.month, parts.day, 12, 0, timeZone))
  return (weekday - anchor.getUTCDay() + 7) % 7
}
