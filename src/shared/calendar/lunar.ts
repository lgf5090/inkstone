export const LUNAR_RANGE_START = 1900
export const LUNAR_RANGE_END = 2100

/**
 * One five-character hex row per lunar year, 1900 through 2100. Bits 0-12 mark, in calendar order,
 * which of that year's twelve (or thirteen) months run to thirty days rather than twenty-nine;
 * bits 13-16 hold the month number that is repeated as the leap month, or 0 when the year has none.
 *
 * Generated from the Shouxing astronomical calendar (lunar-javascript 1.7.7) rather than typed, and
 * pinned by tests/lunar-calendar.test.ts against published almanac anchors - including the 2033
 * leap-month case, which a rule set that ignores the winter-solstice inclusion gets wrong.
 */
export const LUNAR_YEAR_TABLE =
    '116d20075200ea50b64a0064b00a9b095560056a00b5905752007520db25' +
    '00b2500a4b0b4ab002ad0056b04b6900da90fd9200e9200d250ba4d00a56' +
    '002b6095b5006d400ea905e9200e920cd260052b00a570b2b600b5a006d4' +
    '06ec9007490f69300a930052b0ca5b00aad0056a09b5500ba400b4905a93' +
    '00a950f52d0053600aad0b5aa005b200da507d4a00d4a10a9500a9700556' +
    '0cab500ad5006d208ea500ea50064a06c9700a9b0f55a0056a00b690b752' +
    '00b5200b250964b00a4b114ab002ad0056d0cb6900da900d9209d2500d25' +
    '15a4d00a56002b60c5b5006d500ea90be9200e9200d2606a5600a57114d6' +
    '0035a006d50b6c900749006930952b0052b00a5b0555a0056a0fb5500ba4' +
    '00b490ba9300a950052d08aad00ab5135aa005d200da50dd4a00d4a00c95' +
    '0952e0055600ab5055b2006d20cea5007250064b0ac9700cab0055a06ad6' +
    '00b691775200b5200b250da4b00a4b004ab0a55b005ad00b6a05b5200d92' +
    '0fd2500d2500a550b4ad004b6005b506daa00ec911e9200e9200d260ca56' +
    '00a57004d6086d5007550074906e93006930f52b0052b00a5b0b55a0056a' +
    '00b650974a00b4a11a9500a950052d0caad00ab5005aa08ba500da500d4a' +
    '07c9500c960f94e0055600ab50b5b2006d200ea508e4a0068b10c97004ab' +
    '0055b0cad600b6a007520972500b4500a8b0549b004ab' + ''

/**
 * The day of month of each solar term, twenty-four characters per year in TERM_NAMES order, with the
 * same source and the same pinning as LUNAR_YEAR_TABLE. These are Beijing dates, which is what an
 * almanac prints, so they do not move with the reader's own timezone.
 */
export const SOLAR_TERM_TABLE =
    '6K4J6L5K6L6M7N8N8N9O8N7M6L4J6L5L6M6M8N8O8O9O8N8M6L5J6L6L6M7M8O8O8O9O8N8N' +
    '6L5K7M6L7M7M8O9O9O9O8N8N7L5K6L5K6L6M7N8N8N9O8N7M6L4J6L5L6M6M8N8O8O9O8N8M' +
    '6L5J6L6L6M6M8O8O8O9O8N8N6L5K7M6L7M7M8O9O9O9O8N8N7L5K6L5K6L6M7N8N8N9O8N7M' +
    '6L4J6L5L6M6M8N8O8O9O8N8M6L5J6L6L6M6M8O8O8O9O8N8N6L5K7M6L7M7M8O9O9O9O8N8N' +
    '7L5K6L5K6L6M7N8N8N9O8M7M6K4J6L5L6M6M8N8O8N9O8N8M6L4J6L5L6M6M8O8O8O9O8N8N' +
    '6L5K6M6L6M7M8O8O9O9O8N8N6L5K6L5K6L6M7N8N8N8O8M7M6K4J6L5L6L6M8N8O8N9O8N8M' +
    '6L4J6L5L6M6M8O8O8O9O8N8M6L5K6M6L6M7M8O8O9O9O8N8N6L5K6L5K6L6M7N8N8N8O8M7M' +
    '6K4J6L5K6L6M8N8O8N9O8N7M6L4J6L5L6M6M8O8O8O9O8N8M6L5J6L6L6M7M8O8O9O9O8N8N' +
    '6L5K6L5K6L6M7N8N8N8O8M7M6K4J6L5K6L6M8N8O8N9O8N7M6L4J6L5L6M6M8N8O8O9O8N8M' +
    '6L5J6L6L6M7M8O8O9O9O8N8N6L5K6L5K6L6M7N8N8N8N7M7M6K4J6L5K6L6M7N8N8N9O8N7M' +
    '6L4J6L5L6M6M8N8O8O9O8N8M6L5J6L6L6M7M8O8O8O9O8N8N6L5K6L5K6L6L7N8N8N8N7M7M' +
    '6K4J6L5K6L6M7N8N8N9O8N7M6L4J6L5L6M6M8N8O8O9O8N8M6L5J6L6L6M6M8O8O8O9O8N8N' +
    '6L5K6L5K6L6L7N8N8N8N7M7M6K4J6L5K6L6M7N8N8N9O8N7M6L4J6L5L6M6M8N8O8O9O8N8M' +
    '6L5J6L6L6M6M8O8O8O9O8N8N6L5K6L5K6L6L7N8N8N8N7M7M6K4J6L5K6L6M7N8N8N9O8N7M' +
    '6L4J6L5L6M6M8N8O8O9O8N8M6L5J6L6L6M6M8O8O8O9O8N8N6L5K6L5K5L6L7N8N8N8N7M7M' +
    '6K4J6L5K6L6M7N8N8N8O8M7M6K4J6L5L6M6M8N8O8N9O8N8M6L4J6L5L6M6M8O8O8O9O8N8N' +
    '6L5K5L5K5L6L7N7N8N8N7M7M5K4J6L5K6L6M7N8N8N8O8M7M6K4J6L5K6L6M8N8O8N9O8N8M' +
    '6L4J6L5L6M6M8O8O8O9O8N8N6L5K5L5K5L6L7N7N8N8N7M7M5K4J6L5K6L6M7N8N8N8O8M7M' +
    '6K4J6L5K6L6M8N8O8N9O8N7M6L4J6L5L6M6M8N8O8O9O8N8M6L5K5K5K5L6L7N7N8N8N7M7M' +
    '5K4J6L5K6L6M7N8N8N8O8M7M6K4J6L5K6L6M7N8N8N9O8N7M6L4J6L5L6M6M8N8O8O9O8N8M' +
    '6L5J5K5K5L6L7N7N7N8N7M7M5K4J6L5K6L6L7N8N8N8N7M7M6K4J6L5K6L6M7N8N8N9O8N7M' +
    '6L4J6L5L6M6M8N8O8O9O8N8M6L5J5K5K5L6L7N7N7N8N7M7M5K4J6L5K6L6L7N8N8N8N7M7M' +
    '6K4J6L5K6L6M7N8N8N9O8N7M6L4J6L5L6M6M8N8O8O9O8N8M6L5J5K5K5L5L7N7N7N8N7M7M' +
    '5K4J6L5K6L6L7N8N8N8N7M7M6K4J6L5K6L6M7N8N8N9O8N7M6L4J6L5L6M6M8N8O8O9O8N8M' +
    '6L5J5K5K5L5L7N7N7N8N7M7M5K4J6L5K5L6L7N8N8N8N7M7M6K4J6L5K6L6M7N8N8N9O8N7M' +
    '6L4J6L5L6M6M8N8O8N9O8N8M6L5J5K4K5L5L7N7N7N8N7M7M5K4J6L5K5L6L7N7N8N8N7M7M' +
    '6K4J6L5K6L6M7N8N8N8O8N7M6K4J6L5L6L6M8N8O8N9O8N8M6L5J5K4K5L5L7N7N7N8N7M7M' +
    '5K4J6L5K5L6L7N7N8N8N7M7M6K4J6L5K6L6M7N8N8N8O8M7M6K4J6L5K6L6M8N8O8N9O8N8M' +
    '6L4J5K4K5L5L7M7N7N8N7M7M5K4J5L5K5L6L7N7N8N8N7M7M5K4J6L5K6L6M7N8N8N8O8M7M' +
    '6K4J6L5K6L6M7N8O8N9O8N7M6L4J5K4K5L5L7M7N7N8N7M7L5K4J5K5K5L6L7N7N7N8N7M7M' +
    '5K4J6L5K6L6L7N8N8N8O8M7M6K4J6L5K6L6M7N8N8N9O8N7M6L4J5K4K5L5L7M7N7N8N7M7L' +
    '5K4I5K5K5L6L7N7N7N8N7M7M5K4J6L5K6L6L7N8N8N8N7M7M6K4J6L5K6L6M7N8N8N9O8N7M' +
    '6L4J5K4K5L5L7M7N7N8N7M7L5K4I5K5K5L5L7N7N7N8N7M7M5K4J6L5K6L6L7N8N8N8N7M7M' +
    '6K4J6L5K6L6M7N8N8N9O8N7M6L4J5K4K5L5L7M7N7N8N7M7L5K4I5K5K5L5L7N7N7N8N7M7M' +
    '5K4J6L5K6L6L7N8N8N8N7M7M6K4J6L5K6L6M7N8N8N9O8N7M6L4J5K4K5L5L7M7N7N8N7M7L' +
    '5K4I5K5K5L5L7N7N7N8N7M7M5K4J6L5K5L6L7N7N8N8N7M7M6K4J6L5K6L6M7N8N8N9O8N7M' +
    '6L4J5K4K5L5L7M7N7M8N7M7L5K4I5K4K5L5L7N7N7N8N7M7M5K4J6L5K5L6L7N7N8N8N7M7M' +
    '6K4J6L5K6L6M7N8N8N8O8N7M6L4J5K4K5K5L7M7N7M8N7M7L5K4I5K4K5L5L7M7N7N8N7M7M' +
    '5K4J6L5K5L6L7N7N8N8N7M7M6K4J6L5K6L6M7N8N8N8O8M7M6K4J5K4J5K5L7M7N7M8N7M7L' +
    '5K3I5K4K5L5L7M7N7N8N7M7M5K4J5L5K5L6L7N7N8N8N7M7M5K4J6L5K6L6L7N8N8N8O8M7M' +
    '6K4J5K4J5K5L6M7M7M8N7M7L5K3I5K4K5L5L7M7N7N8N7M7L5K4J5K5K5L6L7N7N7N8N7M7M' +
    '5K4J6L5K6L6L7N8N8N8O8M7M6K4J5K4J5K5L6M7M7M8N7M6L5K3I5K4K5L5L7M7N7N8N7M7L' +
    '5K4I5K5K5L5L7N7N7N8N7M7M5K4J6L5K6L6L7N8N8N8N7M7M6K4J5K4J5K5L6M7M7M8N7M6L' +
    '5K3I5K4K5L5L7M7N7N8N7M7L5K4I5K5K5L5L7N7N7N8N7M7M5K4J6L5K6L6L7N8N8N8N7M7M' +
    '6K4J5K4J5K5L6M7M7M8N7M6L5K3I5K4K5L5L7M7N7N8N7M7L5K4I5K5K5L5L7N7N7N8N7M7M' +
    '5K4J6L5K5L6L7N7N8N8N7M7M6K4J5K4J5K5L6M7M7M8N7M6L5K3I5K4K5L5L7M7N7N8N7M7L' +
    '5K4I5K5K5L5L7N7N7N8N7M7M5K4J6L5K5L6L7N7N8N8N7M7M6K4J5K4J5K5L6M7M7M8N7M6L' +
    '5K3I5K4K5K5L7M7N7M8N7M7L5K4I5K4K5L5L7N7N7N8N7M7M5K4J6L5K5L6L7N7N8N8N7M7M' +
    '6K4J5K4J5K5L6M7M7M7N7M6L5K3I5K4J5K5L7M7N7M8N7M7L5K4I5K4K5L5L7M7N7N8N7M7M' +
    '5K4J6L5K5L6L7N7N8N8N7M7M6K4J5K4J5K5K6M7M7M7N7L6L5J3I5K4J5K5L6M7M7M8N7M7L' +
    '5K3I5K4K5L5L7M7N7N8N7M7M5K4J5K5K5L6L7N7N7N8N7M7M5K4J5K4J5K5K6M7M7M7N7L6L' +
    '5J3I5K4J5K5L6M7M7M8N7M7L5K3I5K4K5L5L7M7N7N8N7M7M5K4J5K5K5L5L7N7N7N8N7M7M' +
    '5K4J5K4J5K5K6M7M7M7N7L6L5J3I5K4J5K5L6M7M7M8N7M6L5K3I5K4K5L5L7M7N7N8N7M7L' +
    '5K4J5K5K5L5L7N7N7N8N7M7M5K4J5K4J5K5K6M7M7M7M6L6L5J3I5K4J5K5L6M7M7M8N7M6L' +
    '5K3I5K4K5L5L7M7N7N8N7M7L5K4I5K5K5L5L7N7N7N8N7M7M5K4J5K4J5K5K6M7M7M7M6L6L' +
    '5J3I5K4J5K5L6M7M7M8N7M6L5K3I5K4K5L5L7M7N7N8N7M7L5K4I5K5K5L5L7N7N7N8N7M7M' +
    '5K4J5K4J4K5K6M6M7M7M6L6L5J3I5K4J5K5L6M7M7M8N7M6L5K3I5K4K5K5L7M7N7M8N7M7L' +
    '5K4I5K5K5L5L7N7N7N8N7M7M5K4J5K4J4K5K6M6M7M7M6L6L5J3I5K4J5K5L6M7M7M7N7M6L' +
    '5K3I5K4K5K5L7M7N7M8N7M7L5K4I5K4K5L5L7M7N7N8N7M7M5K4J5K4J4K5K6M6M7M7M6L6L' +
    '5J3I5K4J5K5L6M7M7M7N7M6L5K3I5K4J5K5L6M7N7M8N7M7L5K4I5K4K5L5L7M7N7N8N7M7M' +
    '5K4J5K4J4K5K6M6M7M7M6L6L5J3I5K4J5K5K6M7M7M7N7L6L5K3I5K4J5K5L6M7M7M8N7M7L' +
    '5K3I5K4K5L5L7M7N7N8N7M7M5K4J4J4J4K5K6M6M6M7M6L6L4J3I5K4J5K5K6M7M7M7N7L6L' +
    '5J3I5K4J5K5L6M7M7M8N7M7L5K3I5K4K5L5L7M7N7N8N7M7M5K4J4J4J4K4K6M6M6M7M6L6L' +
    '4J3I5K4J5K5K6M7M7M7N7L6L5J3I5K4J5K5L6M7M7M8N7M6L5K3I5K4K5L5L7M7N7N8N7M7L' +
    '5K4J4J4J4K4K6M6M6M7M6L6L4J3I5K4J5K5K6M7M7M7M6L6L5J3I5K4J5K5L6M7M7M8N7M6L' +
    '5K3I5K4K5L5L7M7N7N8N7M7L5K4I4J4J4K4K6M6M6M7M6L6L4J3I5K4J5K5K6M6M7M7M6L6L' +
    '5J3I5K4J5K5L6M7M7M8N7M6L5K3I5K4K5L5L7M7N7N8N7M7L5K4I5K5K5L5L7N7N7N8N7M7M' + ''

export const TERM_NAMES = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
  '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑',
  '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
] as const

/** Month names as an almanac prints them; index 0 is the first month of the lunar year. */
export const LUNAR_MONTH_NAMES = [
  '正月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '冬月', '腊月',
]

/** Day-of-month names, index 0 is day 1. */
export const LUNAR_DAY_NAMES = [
  '初一', '初二', '初三', '初四', '初五',
  '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五',
  '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五',
  '廿六', '廿七', '廿八', '廿九', '三十',
]

/** The sexagenary cycle and the twelve animals, which name a lunar year to a reader. */
export const GANZI_VOCABULARY = {
  stems: ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'],
  branches: ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'],
  zodiac: ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'],
}

/** The affixes an almanac line is assembled from. */
export const ALMANAC_TEXT = { leap: '闰', month: '月', year: '年' }

export function lunarDayName(day: number): string {
  return LUNAR_DAY_NAMES[day - 1] ?? ''
}

export function lunarMonthName(month: number, isLeap: boolean): string {
  const base = LUNAR_MONTH_NAMES[month - 1] ?? ''
  return isLeap ? `${ALMANAC_TEXT.leap}${base}` : base
}

/**
 * The same name squeezed into one calendar tile. A month cell is 23-27px wide and three Han
 * characters need 26px, so the leap repeat drops the suffix it would otherwise carry: a repeated
 * sixth month reads as two characters on the tile while the tooltip and the today bar keep the
 * whole name.
 */
export function lunarMonthCellName(month: number, isLeap: boolean): string {
  const base = LUNAR_MONTH_NAMES[month - 1] ?? ''
  return isLeap ? `${ALMANAC_TEXT.leap}${base.slice(0, -1)}` : base
}

export function ganzhiOf(lunarYear: number): string {
  const offset = (((lunarYear - 4) % 60) + 60) % 60
  return `${GANZI_VOCABULARY.stems[offset % 10] ?? ''}${GANZI_VOCABULARY.branches[offset % 12] ?? ''}`
}

export function zodiacOf(lunarYear: number): string {
  return GANZI_VOCABULARY.zodiac[((((lunarYear - 4) % 12) + 12) % 12)] ?? ''
}

/** The sexagenary year label an almanac heads a page with, e.g. stem-branches plus the year suffix. */
export function lunarYearLabel(lunarYear: number): string {
  return `${ganzhiOf(lunarYear)}${ALMANAC_TEXT.year}`
}

/** A whole lunar date as an almanac line reads it: sexagenary year, month name, day name. */
export function formatLunarDate(parts: { ganzhi: string, monthName: string, dayName: string }): string {
  return `${parts.ganzhi}${ALMANAC_TEXT.year}${parts.monthName}${parts.dayName}`
}

const MS_PER_DAY = 86_400_000
const ROW_CHARS = 5
const TERM_CHARS = TERM_NAMES.length
const CACHE_LIMIT = 4096

export interface LunarDate {
  year: number
  month: number
  day: number
  isLeap: boolean
  monthName: string
  dayName: string
  ganzhi: string
  zodiac: string
  isYearStart: boolean
  isYearEnd: boolean
}

export interface LunarDateInput {
  year: number
  month: number
  day: number
  isLeap: boolean
}

export interface SolarDate {
  year: number
  month: number
  day: number
}

interface LunarMonth {
  month: number
  isLeap: boolean
  days: number
  startUtc: number
}

interface LunarYear {
  year: number
  startUtc: number
  endUtc: number
  months: LunarMonth[]
}

/**
 * The table stores each year's month lengths, not its start date, so the whole 1900-2100 frame is
 * walked once: a lunar year opens where the previous one's months run out. Doing it per lookup
 * instead would re-walk up to two centuries of months for every cell of every grid.
 */
function buildLunarYear(year: number, startUtc: number): LunarYear {
  const row = Number.parseInt(LUNAR_YEAR_TABLE.slice((year - LUNAR_RANGE_START) * ROW_CHARS, (year - LUNAR_RANGE_START + 1) * ROW_CHARS), 16)
  const leap = (row >> 13) & 0xf
  const flags = row & 0x1fff
  const count = leap === 0 ? 12 : 13
  const months: LunarMonth[] = []
  let cursor = startUtc
  for (let index = 0; index < count; index++) {
    const isLeap = leap !== 0 && index === leap
    const month = leap === 0 ? index + 1 : isLeap ? leap : index < leap ? index + 1 : index
    const days = (flags >> index) & 1 ? 30 : 29
    months.push({ month, isLeap, days, startUtc: cursor })
    cursor += days * MS_PER_DAY
  }
  return { year, startUtc, endUtc: cursor, months }
}

let years: LunarYear[] | null = null

function lunarYears(): LunarYear[] {
  if (!years) {
    const built: LunarYear[] = []
    let cursor = Date.UTC(LUNAR_RANGE_START, 0, 31)
    for (let year = LUNAR_RANGE_START; year <= LUNAR_RANGE_END; year++) {
      const next = buildLunarYear(year, cursor)
      built.push(next)
      cursor = next.endUtc
    }
    years = built
  }
  return years
}

function lunarYear(year: number): LunarYear | null {
  if (!Number.isInteger(year) || year < LUNAR_RANGE_START || year > LUNAR_RANGE_END)
    return null
  return lunarYears()[year - LUNAR_RANGE_START] ?? null
}

function civilUtc(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
}

function findLunarYear(utc: number): LunarYear | null {
  const list = lunarYears()
  if (utc < list[0]!.startUtc || utc >= list[list.length - 1]!.endUtc)
    return null
  let low = 0
  let high = list.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (list[middle]!.startUtc <= utc)
      low = middle
    else
      high = middle - 1
  }
  return list[low]!
}

function computeLunar(utc: number): LunarDate | null {
  const year = findLunarYear(utc)
  if (!year)
    return null
  let slot = year.months.length - 1
  for (let index = 0; index < year.months.length - 1; index++) {
    if (year.months[index + 1]!.startUtc > utc) {
      slot = index
      break
    }
  }
  const month = year.months[slot]!
  const day = Math.floor((utc - month.startUtc) / MS_PER_DAY) + 1
  if (day < 1 || day > month.days)
    return null
  return {
    year: year.year,
    month: month.month,
    day,
    isLeap: month.isLeap,
    monthName: lunarMonthName(month.month, month.isLeap),
    dayName: lunarDayName(day),
    ganzhi: ganzhiOf(year.year),
    zodiac: zodiacOf(year.year),
    isYearStart: slot === 0 && day === 1,
    isYearEnd: slot === year.months.length - 1 && day === month.days,
  }
}

const lunarCache = new Map<number, LunarDate | null>()

function cachedLunar(utc: number): LunarDate | null {
  const hit = lunarCache.get(utc)
  if (hit !== undefined)
    return hit
  const found = computeLunar(utc)
  if (lunarCache.size >= CACHE_LIMIT)
    lunarCache.clear()
  lunarCache.set(utc, found)
  return found
}

/** The lunar date a Gregorian day falls on, or null outside the 1900-2100 table. */
export function lunarOf(date: Date): LunarDate | null {
  return Number.isFinite(date.getTime()) ? cachedLunar(civilUtc(date)) : null
}

/** Solar calendar fields to the lunar date they name, or null outside 1900-2100. */
export function solar2lunar(year: number, month: number, day: number): LunarDate | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)
    || year < LUNAR_RANGE_START || year > LUNAR_RANGE_END + 1) return null
  const utc = Date.UTC(year, month - 1, day)
  const date = new Date(utc)
  if (!Number.isFinite(utc) || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day)
    return null
  return cachedLunar(utc)
}

/** Days in a lunar year, leap month included. */
export function lunarYearDays(year: number): number {
  const entry = lunarYear(year)
  return entry ? entry.months.reduce((total, month) => total + month.days, 0) : 0
}

/** The leap month of a lunar year, or 0 when it has none. */
export function leapMonth(year: number): number {
  const entry = lunarYear(year)
  if (!entry)
    return 0
  return entry.months.find(month => month.isLeap)?.month ?? 0
}

/** Days in a lunar year's leap month. */
export function leapDays(year: number): number {
  const entry = lunarYear(year)
  return entry?.months.find(month => month.isLeap)?.days ?? 0
}

/** Days in one lunar month (29 or 30). */
export function monthDays(year: number, month: number): number {
  const entry = lunarYear(year)
  if (!entry || !Number.isInteger(month) || month < 1 || month > 12)
    return 0
  return entry.months.find(candidate => candidate.month === month && !candidate.isLeap)?.days ?? 0
}

/** The Gregorian day a lunar year opens on, or null when that year is off the table. */
export function lunarYearStart(lunarYearNumber: number): Date | null {
  const entry = lunarYear(lunarYearNumber)
  if (!entry)
    return null
  const utc = new Date(entry.startUtc)
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate())
}

/** Lunar date to solar calendar fields, or null when the date does not exist. */
export function lunar2solar(lunar: LunarDateInput): SolarDate | null {
  const { year, month, day, isLeap } = lunar
  const entry = lunarYear(year)
  if (!entry || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1)
    return null
  const target = entry.months.find(candidate => candidate.month === month && candidate.isLeap === isLeap)
  if (!target || day > target.days)
    return null
  const utc = new Date(target.startUtc + (day - 1) * MS_PER_DAY)
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() }
}

function computeSolarTerm(date: Date): string | null {
  const year = date.getFullYear()
  if (year < LUNAR_RANGE_START || year > LUNAR_RANGE_END)
    return null
  const row = SOLAR_TERM_TABLE.slice((year - LUNAR_RANGE_START) * TERM_CHARS, (year - LUNAR_RANGE_START + 1) * TERM_CHARS)
  const first = date.getMonth() * 2
  const day = date.getDate()
  for (const index of [first, first + 1]) {
    if (Number.parseInt(row[index]!, 32) === day)
      return TERM_NAMES[index] ?? null
  }
  return null
}

const termCache = new Map<number, string | null>()

/** The solar term falling on this Gregorian day. Beijing reckoning, so it is the same for every reader. */
export function solarTermOf(date: Date): string | null {
  if (!Number.isFinite(date.getTime()))
    return null
  const utc = civilUtc(date)
  const hit = termCache.get(utc)
  if (hit !== undefined)
    return hit
  const found = computeSolarTerm(date)
  if (termCache.size >= CACHE_LIMIT)
    termCache.clear()
  termCache.set(utc, found)
  return found
}

/** All twenty-four terms of a Gregorian year, in calendar order. */
export function solarTermsOfYear(year: number): { name: string; date: Date }[] {
  if (year < LUNAR_RANGE_START || year > LUNAR_RANGE_END)
    return []
  const row = SOLAR_TERM_TABLE.slice((year - LUNAR_RANGE_START) * TERM_CHARS, (year - LUNAR_RANGE_START + 1) * TERM_CHARS)
  return TERM_NAMES.map((name, index) => ({
    name,
    date: new Date(Date.UTC(year, index >> 1, Number.parseInt(row[index]!, 32))),
  }))
}
