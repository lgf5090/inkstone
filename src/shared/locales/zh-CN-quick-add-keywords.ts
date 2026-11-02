/** The Chinese words the quick-add parser reads. Data about the language, not interface copy. */
export const ZH_QUICK_ADD_KEYWORDS = {
  today: '今天',
  tomorrow: '明天',
  afterTomorrow: '后天',
  next: '下',
  weekPrefixes: '周|星期|礼拜',
  weekdayChars: '一二三四五六日天',
  month: '月',
  daySuffixes: '日号',
  timeUnits: '点时時',
  half: '半',
  /** The words that shift a 12-hour wall clock into the afternoon/evening; data about the language. */
  periodWords: '凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|晚',
  afternoonPeriods: ['下午', '傍晚', '晚上', '夜里', '晚'],
  noonPeriod: '中午',
  midnightPeriod: '凌晨',
  hourUnits: '小时|个小时',
  minuteUnit: '分钟',
  weekdayNumbers: { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 } as Record<string, number>,
} as const
