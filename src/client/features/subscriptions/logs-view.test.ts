import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import type { NotifyLogEntry, ScheduleLogEntry } from '@shared/subscriptions/model'
import { installTestGlobals } from '../../lib/test-render'
import { LogsView } from './LogsView'

let host: HTMLDivElement
let root: Root
beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('log filters', () => {
  it('applies a changed filter immediately', async () => {
    const onLoad = vi.fn()
    act(() => root.render(createElement(LogsView, {
      logs: { notify: [], schedule: [], loading: false, error: null },
      items: [],
      onLoad,
    })))
    const select = host.querySelector<HTMLSelectElement>('select[aria-label]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(select, 'today')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onLoad).toHaveBeenCalledTimes(2)
    expect(onLoad.mock.calls[1]?.[0]).toMatchObject({ since: expect.any(String) })
  })

  it('offers 72-hour and unlimited periods and applies the selected result limit', async () => {
    const onLoad = vi.fn()
    act(() => root.render(createElement(LogsView, {
      logs: { notify: [], schedule: [], loading: false, error: null },
      items: [],
      onLoad,
    })))
    const period = host.querySelector<HTMLSelectElement>(`select[aria-label="${t('subscriptions.logs.filter_period')}"]`)!
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(period, 'hours72')
      period.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const since = Date.parse(onLoad.mock.calls.at(-1)?.[0].since)
    expect(Math.abs(Date.now() - since - 72 * 3_600_000)).toBeLessThan(5_000)
    await act(async () => {
      setter.call(period, 'all')
      period.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onLoad.mock.calls.at(-1)?.[0].since).toBeUndefined()
    const limit = host.querySelector<HTMLSelectElement>(`select[aria-label="${t('subscriptions.logs.filter_limit')}"]`)!
    await act(async () => {
      setter.call(limit, '500')
      limit.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onLoad.mock.calls.at(-1)?.[0].limit).toBe(500)
  })

  it('shows notification identity and scheduler diagnostics when a row is expanded', async () => {
    const notify: NotifyLogEntry = {
      id: 'n1', subscriptionId: 'sub-1', subscriptionName: 'Netflix', ruleId: 'rule-42', channel: 'telegram',
      status: 'failed', title: 'Netflix expires in 3 days', body: 'Body', error: 'Timeout', detail: 'token=***',
      createdAt: '2026-11-28T08:00:00.000Z',
    }
    const schedule: ScheduleLogEntry = {
      id: 's1', startedAt: '2026-11-28T08:00:00.000Z', finishedAt: '2026-11-28T08:00:01.000Z',
      timezone: 'Asia/Shanghai', hour: '09', hours: ['08', '09'], inWindow: true,
      checkedCount: 8, matchedCount: 2, dedupedCount: 1, sentCount: 1, renewedCount: 0,
      status: 'ok', reason: 'Sweep complete', detail: 'Checked two rules',
    }
    act(() => root.render(createElement(LogsView, {
      logs: { notify: [notify], schedule: [schedule], loading: false, error: null },
      items: [],
      onLoad: () => {},
    })))
    const notificationRow = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Netflix'))!
    act(() => notificationRow.click())
    expect(host.textContent).toContain('rule-42')
    expect(host.textContent).toContain('Netflix expires in 3 days')
    expect(host.textContent).toContain('token=***')
    const scheduleRow = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Sweep complete'))!
    act(() => scheduleRow.click())
    for (const value of ['Asia/Shanghai', '08, 09', 'Checked two rules']) expect(host.textContent).toContain(value)
    expect(scheduleRow.getAttribute('aria-expanded')).toBe('true')
  })
})
