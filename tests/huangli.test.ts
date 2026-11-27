import { describe, expect, it, vi } from 'vitest'
import { Solar } from 'lunar-typescript'
import { loadAlmanacDetail } from '../src/client/features/calendar/huangli'
import { lunarOf, solarTermOf } from '../src/shared/calendar/lunar'

vi.setConfig({ testTimeout: 60_000 })

const HUANGLI_ANCHORS = [
  '1900-01-31',
  '1933-07-22',
  '2026-02-04',
  '2026-12-22',
  '2027-02-05',
  '2027-02-06',
  '2033-12-22',
  '2052-08-24',
  '2101-01-28',
]

function dateOf(key: string): Date {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, day)
}

describe('huangli detail', () => {
  it.each(HUANGLI_ANCHORS)('keeps package rule parity and shared calendar fields for %s', async (key) => {
    const date = dateOf(key)
    const [year, month, day] = key.split('-').map(Number) as [number, number, number]
    const expected = Solar.fromYmd(year, month, day).getLunar()
    const sharedLunar = lunarOf(date)
    const sharedTerm = solarTermOf(date)
    const detail = await loadAlmanacDetail(date)

    expect(sharedLunar).not.toBeNull()
    expect(detail).not.toBeNull()
    expect(detail!.ganZhiYear).toBe(sharedLunar!.ganzhi)
    expect(detail!.ganZhiYear).toBe(expected.getYearInGanZhi())
    expect(detail!.terms).toEqual(expected.getJieQi() ? [expected.getJieQi()] : [])
    expect(detail!.terms).toEqual(sharedTerm ? [sharedTerm] : [])
    expect(detail!.ganZhiMonth).toBe(expected.getMonthInGanZhi())
    expect(detail!.ganZhiDay).toBe(expected.getDayInGanZhi())
    expect(detail!.naYin).toBe(expected.getDayNaYin())
    expect(detail!.zhiXing).toBe(expected.getZhiXing())
    expect(detail!.tianShen).toBe(expected.getDayTianShen())
    expect(detail!.tianShenLuck).toBe(expected.getDayTianShenLuck())
    expect(detail!.xiu).toBe(expected.getXiu())
    expect(detail!.xiuLuck).toBe(expected.getXiuLuck())
    expect(detail!.animal).toBe(expected.getAnimal())
    expect(detail!.chong).toBe(expected.getDayChongDesc())
    expect(detail!.sha).toBe(expected.getDaySha())
    expect(detail!.yi).toEqual(expected.getDayYi())
    expect(detail!.ji).toEqual(expected.getDayJi())
    expect(detail!.jiShen).toEqual(expected.getDayJiShen())
    expect(detail!.xiongSha).toEqual(expected.getDayXiongSha())

    const expectedHours = expected.getTimes()
    expect(detail!.hours).toHaveLength(expectedHours.length)
    detail!.hours.forEach((hour, index) => {
      const source = expectedHours[index]!
      expect(hour.zhi).toBe(source.getZhi())
      expect(hour.ganZhi).toBe(source.getGanZhi())
      expect(hour.luck).toBe(source.getTianShenLuck())
      expect(hour.yi).toEqual(source.getYi().slice(0, 4))
      expect(hour.ji).toEqual(source.getJi().slice(0, 4))
      expect(hour.window).toMatch(/^\d{2}:\d{2}-\d{2}:\d{2}$/)
    })
  })

  it('does not ask the rule package for dates outside the shared table', async () => {
    await expect(loadAlmanacDetail(dateOf('1899-12-31'))).resolves.toBeNull()
    await expect(loadAlmanacDetail(dateOf('2101-01-29'))).resolves.toBeNull()
    await expect(loadAlmanacDetail(new Date(Number.NaN))).resolves.toBeNull()
  })
})
