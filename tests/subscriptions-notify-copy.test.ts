import { describe, expect, it } from 'vitest'
import { EN_US_SUBSCRIPTIONS_NOTIFY } from '../src/shared/locales/en-US-subscriptions-notify'
import { ZH_CN_SUBSCRIPTIONS_NOTIFY } from '../src/shared/locales/zh-CN-subscriptions-notify'
import { describeTimezone, fill, notifyCopy } from '../src/shared/subscriptions/notify-copy'

const placeholders = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort()

describe('the notification catalog', () => {
  it('has the same keys in both languages', () => {
    expect(Object.keys(ZH_CN_SUBSCRIPTIONS_NOTIFY).sort()).toEqual(Object.keys(EN_US_SUBSCRIPTIONS_NOTIFY).sort())
  })

  it('has the same placeholders in both languages', () => {
    for (const [key, value] of Object.entries(EN_US_SUBSCRIPTIONS_NOTIFY)) {
      if (typeof value !== 'string') continue
      const twin = (ZH_CN_SUBSCRIPTIONS_NOTIFY as Record<string, unknown>)[key]
      expect(typeof twin).toBe('string')
      expect(placeholders(twin as string)).toEqual(placeholders(value))
    }
  })

  it('names the same time zones in both languages', () => {
    expect(Object.keys(ZH_CN_SUBSCRIPTIONS_NOTIFY.zoneNames).sort())
      .toEqual(Object.keys(EN_US_SUBSCRIPTIONS_NOTIFY.zoneNames).sort())
  })
})

describe('copy helpers', () => {
  it('picks the catalog the account asked for', () => {
    expect(notifyCopy('en-US').title).toBe(EN_US_SUBSCRIPTIONS_NOTIFY.title)
    expect(notifyCopy('zh-CN').title).toBe(ZH_CN_SUBSCRIPTIONS_NOTIFY.title)
    expect(notifyCopy(undefined).title).toBe(ZH_CN_SUBSCRIPTIONS_NOTIFY.title)
  })

  it('fills a count and drops an unknown key', () => {
    expect(fill('Due in {count} days', { count: 3 })).toBe('Due in 3 days')
    expect(fill('{missing}', {})).toBe('')
  })

  it('names a zone with its offset', () => {
    expect(describeTimezone(notifyCopy('en-US'), 'Asia/Shanghai')).toBe('China Standard Time (UTC+8)')
    expect(describeTimezone(notifyCopy('en-US'), 'Mars/Olympus')).toBe('Mars/Olympus (UTC+0)')
  })
})
