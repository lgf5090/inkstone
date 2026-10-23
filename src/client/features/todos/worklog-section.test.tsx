// @vitest-environment jsdom
/**
 * The worklog section of the statistics screen.
 *
 * The case worth pinning is the missing denominator. A range in which nothing was estimated has no
 * overrun rate, and showing `0%` there would tell an account that never planned anything that it plans
 * perfectly — the mistake the reference app's metric makes. The dash is the honest answer, and beside
 * it the counts stay, so the reader can see why there is no rate.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { chooseOption } from '../../lib/test-menu'
import { WorklogSection, useWorklog } from './WorklogSection'
import type { Worklog } from '@shared/todos/model'

/**
 * The section as the screen mounts it: `useWorklog` owns the read so the CSV export can carry the very
 * same answer, which means the thing under test is the pair, not the presentation alone.
 */
function Harness() {
  return createElement(WorklogSection, { state: useWorklog({ from: '2026-03-01', to: '2026-03-05' }) })
}

const service = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  answer: null as Worklog | null,
  fail: false,
}))

function worklog(over: Partial<Worklog> = {}): Worklog {
  return {
    range: { from: '2026-03-01', to: '2026-03-05', dimension: 'list' },
    totalMs: 3 * 3_600_000,
    entryCount: 2,
    byDay: [
      { day: '2026-03-01', trackedMs: 0 },
      { day: '2026-03-02', trackedMs: 2 * 3_600_000 },
      { day: '2026-03-03', trackedMs: 3_600_000 },
    ],
    byGroup: [{ key: 'l1', label: 'Client', trackedMs: 3 * 3_600_000 }],
    truncatedGroups: 0,
    estimatedCount: 2,
    overEstimateCount: 1,
    overEstimateRate: 0.5,
    ...over,
  }
}

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      worklog: async (params: Record<string, unknown>) => {
        service.calls.push(params)
        if (service.fail) throw new Error('the ledger could not be read')
        return service.answer
      },
    },
  },
}))

let view: RenderedElement | null = null

async function mount(): Promise<void> {
  view = renderElement(createElement(Harness))
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

function section(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-worklog-section]')
  if (!node) throw new Error('the worklog section did not render')
  return node
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.calls.length = 0
  service.fail = false
  service.answer = worklog()
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the worklog section', () => {
  it('asks for the window the screen is showing, by list until the reader says otherwise', async () => {
    await mount()

    expect(service.calls[0]).toEqual({ from: '2026-03-01', to: '2026-03-05', group: 'list' })
    expect(section().textContent).toContain(t('todo.stats.worklog.title'))
  })

  it('re-asks against the new dimension when the picker is changed', async () => {
    await mount()

    await chooseOption(section(), t('todo.stats.worklog.group_by'), t('todo.stats.worklog.by_tag'))

    expect(service.calls.at(-1)).toEqual({ from: '2026-03-01', to: '2026-03-05', group: 'tag' })
  })

  it('shows a dash rather than a fake zero when nothing was planned', async () => {
    service.answer = worklog({ estimatedCount: 0, overEstimateCount: 0, overEstimateRate: null })

    await mount()

    // The rate's own cell, not the section's whole text: the single bar in the breakdown is 100% of
    // itself, and `100%` contains the `0%` a loose substring check would flag.
    const rate = [...section().querySelectorAll('span')]
      .filter((node) => (node.textContent ?? '').trim() === '—')
      .map((node) => node.parentElement?.textContent ?? '')
    expect(rate.length, 'the missing rate is not drawn as a dash').toBeGreaterThan(0)
    expect(rate.join(' ')).not.toContain('0 of 0')
  })

  it('keeps the counts beside a rate it could compute', async () => {
    await mount()

    expect(section().textContent).toContain('50%')
    expect(section().textContent).toContain(t('todo.stats.worklog.overrun_of', { over: 1, planned: 2 }))
  })

  it('says so when the window holds no hours at all, instead of an empty chart', async () => {
    service.answer = worklog({ totalMs: 0, entryCount: 0, byGroup: [], byDay: [{ day: '2026-03-01', trackedMs: 0 }] })

    await mount()

    expect(section().textContent).toContain(t('todo.stats.worklog.empty'))
    expect(section().querySelector('ul')).toBeNull()
  })

  it('names the groups it left out rather than dropping them from the answer', async () => {
    service.answer = worklog({ truncatedGroups: 4 })

    await mount()

    expect(section().textContent).toContain(t('todo.stats.worklog.more', { count: 4 }))
  })

  it('reports a failed read as a failure with a way to try again', async () => {
    service.fail = true

    await mount()

    expect(section().querySelector('[role="alert"]')?.textContent).toBe('the ledger could not be read')
    expect(section().querySelector('[role="status"]'), 'a failed read must not look like an empty one').toBeNull()

    service.fail = false
    const retry = [...section().querySelectorAll('button')].find((node) => (node.textContent ?? '') === t('common.retry'))
    expect(retry).toBeTruthy()
    await act(async () => {
      retry!.click()
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    })

    expect(section().textContent).toContain('50%')
  })
})
