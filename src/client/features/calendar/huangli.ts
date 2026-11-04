/**
 * The almanac panel's detail line, inferred by rules rather than quoted from an authority.
 *
 * The month grid's lunar date, solar term and festival come from the notebook's own tables. What a
 * reader means by the day's almanac is more than those: the day's sexagenary pair, the officer on duty, which
 * activities are said to suit it and which not, and the auspicious hours. That is a large rule set
 * (dozens of spirits, each with its own table), and rewriting it here would be inventing an almanac.
 *
 * So this module wraps `lunar-typescript`, the maintained implementation of the same rules, and
 * loads it on demand: the tables are over a megabyte and a reader who never opens the panel should
 * not download them. Everything it returns is labelled as derived in the interface — the library
 * computes these from published rules, and a calendar that presented them as authoritative would be
 * lying.
 */

export interface AlmanacHour {
  /** The double-hour's earthly branch. */
  zhi: string
  ganZhi: string
  /** The library's own luck word: auspicious, inauspicious or neutral. */
  luck: string
  /** The hour window as `HH:mm-HH:mm`, from the library's own bounds. */
  window: string
  yi: string[]
  ji: string[]
}

export interface AlmanacDetail {
  ganZhiYear: string
  ganZhiMonth: string
  ganZhiDay: string
  naYin: string
  /** The twelve officers of the day. */
  zhiXing: string
  tianShen: string
  tianShenLuck: string
  xiu: string
  xiuLuck: string
  animal: string
  /** The day's clash branch and the direction it faces. */
  chong: string
  sha: string
  yi: string[]
  ji: string[]
  jiShen: string[]
  xiongSha: string[]
  hours: AlmanacHour[]
  /** Terms that fall on this day, empty on most days. */
  terms: string[]
}

interface LunarLike {
  getYearInGanZhi(): string
  getMonthInGanZhi(): string
  getDayInGanZhi(): string
  getDayNaYin(): string
  getZhiXing(): string
  getDayTianShen(): string
  getDayTianShenLuck(): string
  getXiu(): string
  getXiuLuck(): string
  getAnimal(): string
  getDayChongDesc(): string
  getDaySha(): string
  getDayYi(): string[]
  getDayJi(): string[]
  getDayJiShen(): string[]
  getDayXiongSha(): string[]
  getTimes(): AlmanacHourLike[]
  getJieQi(): string
  getJieQiTable(): Record<string, unknown>
}

interface AlmanacHourLike {
  getZhi(): string
  getGanZhi(): string
  getTianShenLuck(): string
  getMinHm(): string
  getMaxHm(): string
  getYi(): string[]
  getJi(): string[]
}

function windowOf(hour: AlmanacHourLike): string {
  const from = hour.getMinHm()
  const to = hour.getMaxHm()
  const pad = (value: string): string => value.padStart(2, '0').slice(0, 5)
  return `${pad(from)}-${pad(to)}`
}

function hourOf(hour: AlmanacHourLike): AlmanacHour {
  return {
    zhi: hour.getZhi(),
    ganZhi: hour.getGanZhi(),
    luck: hour.getTianShenLuck(),
    window: windowOf(hour),
    yi: hour.getYi().slice(0, 4),
    ji: hour.getJi().slice(0, 4),
  }
}

/**
 * The day's rules, from the maintained implementation.
 *
 * A date outside the library's supported range throws inside it; the caller treats that as "no
 * detail" rather than as an error, because the lunar tables here only promise 1900–2100.
 */
export async function loadAlmanacDetail(date: Date): Promise<AlmanacDetail | null> {
  try {
    const { Solar } = await import('lunar-typescript')
    const lunar = Solar.fromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate()).getLunar() as unknown as LunarLike
    const term = lunar.getJieQi()
    return {
      ganZhiYear: lunar.getYearInGanZhi(),
      ganZhiMonth: lunar.getMonthInGanZhi(),
      ganZhiDay: lunar.getDayInGanZhi(),
      naYin: lunar.getDayNaYin(),
      zhiXing: lunar.getZhiXing(),
      tianShen: lunar.getDayTianShen(),
      tianShenLuck: lunar.getDayTianShenLuck(),
      xiu: lunar.getXiu(),
      xiuLuck: lunar.getXiuLuck(),
      animal: lunar.getAnimal(),
      chong: lunar.getDayChongDesc(),
      sha: lunar.getDaySha(),
      yi: lunar.getDayYi(),
      ji: lunar.getDayJi(),
      jiShen: lunar.getDayJiShen(),
      xiongSha: lunar.getDayXiongSha(),
      hours: lunar.getTimes().map(hourOf),
      terms: term ? [term] : [],
    }
  } catch {
    // The library refuses dates outside 1900–2100 and a few malformed ones; the panel then shows the
    // lunar date it already has and no inferred line, which is honest rather than empty.
    return null
  }
}

/** The code point of the library's auspicious luck word, so no copy is spelled in this module. */
const AUSPICIOUS_CODE_POINT = 0x5409

/** The hours the panel marks as auspicious, in clock order. */
export function auspiciousHours(detail: AlmanacDetail): AlmanacHour[] {
  return detail.hours.filter(hour => hour.luck.codePointAt(0) === AUSPICIOUS_CODE_POINT)
}
