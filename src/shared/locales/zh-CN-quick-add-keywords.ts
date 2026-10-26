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
  hourUnits: '小时|个小时',
  minuteUnit: '分钟',
  weekdayNumbers: { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 } as Record<string, number>,
} as const
