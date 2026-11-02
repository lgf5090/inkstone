import { describe, expect, it } from 'vitest'
import { parseQuickAdd } from './quick-add'

const NOW = new Date('2026-10-26T01:00:00Z')
const ZONE = 'Asia/Shanghai'

function parse(text: string) {
  return parseQuickAdd(text, NOW, ZONE, 'Untitled')
}

describe('quick add parser', () => {
  it('reads a Chinese date, time and duration', () => {
    expect(parse('明天 15:00 开会 1小时')).toMatchObject({
      title: '开会',
      start: { year: 2026, month: 10, day: 27, hour: 15, minute: 0 },
      end: { year: 2026, month: 10, day: 27, hour: 16, minute: 0 },
    })
  })

  it('reads next week and a half-hour clock', () => {
    const result = parse('下周一 10点半 设计评审 30分钟')
    expect(result?.title).toBe('设计评审')
    expect(result?.start.toString()).toBe('2026-11-02T10:30:00+08:00[Asia/Shanghai]')
    expect(result?.end.toString()).toBe('2026-11-02T11:00:00+08:00[Asia/Shanghai]')
  })

  it('reads English weekday, meridiem and duration', () => {
    const result = parse('Friday 3pm design review 45m')
    expect(result?.title).toBe('design review')
    expect(result?.start.toString()).toBe('2026-10-30T15:00:00+08:00[Asia/Shanghai]')
    expect(result?.end.toString()).toBe('2026-10-30T15:45:00+08:00[Asia/Shanghai]')
  })

  it('reads an explicit month and day, and falls back to a title', () => {
    expect(parse('10月28日 09:30 体检')?.start.toString())
      .toBe('2026-10-28T09:30:00+08:00[Asia/Shanghai]')
    expect(parse('明天 15:00')?.title).toBe('Untitled')
    expect(parse('   ')).toBeNull()
  })

  it('applies Chinese afternoon and evening periods instead of leaving them in the title', () => {
    const tomorrowAfternoon = parse('明天下午3点开会')
    expect(tomorrowAfternoon?.title).toBe('开会')
    expect(tomorrowAfternoon?.start.toString()).toBe('2026-10-27T15:00:00+08:00[Asia/Shanghai]')

    const fridayEvening = parse('周五晚7点看电影')
    expect(fridayEvening?.title).toBe('看电影')
    expect(fridayEvening?.start.toString()).toBe('2026-10-30T19:00:00+08:00[Asia/Shanghai]')
  })

  it('keeps the period on a colon clock and honours half past', () => {
    expect(parse('下午3:30 评审')?.start.toString()).toBe('2026-10-26T15:30:00+08:00[Asia/Shanghai]')
    expect(parse('上午10点半 站会')?.start.toString()).toBe('2026-10-26T10:30:00+08:00[Asia/Shanghai]')
    expect(parse('凌晨1点 值班')?.start.toString()).toBe('2026-10-26T01:00:00+08:00[Asia/Shanghai]')
  })
})
