import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCard, ProjectProperty } from '@shared/project/model'
import { projectDayToStamp } from '@shared/project/date'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { CalendarView } from './CalendarView'
import * as api from '../api'
import { prompt } from '../../../components/overlay'

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  createProjectCard: vi.fn(),
}))
vi.mock('../../../components/overlay', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../components/overlay')>(),
  prompt: vi.fn(),
}))

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const properties: ProjectProperty[] = [
  { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: 'propColorBlue' }] },
  { id: 'pd', name: 'Due', type: 'date', options: [] },
]

function card(id: string, from?: Date, to?: Date): ProjectCard {
  const values: Record<string, string> = { ps: 'o1' }
  if (from) values.pd = JSON.stringify(to ? { from: projectDayToStamp(from), to: projectDayToStamp(to) } : { from: projectDayToStamp(from) })
  return { id, boardId: 'b1', parentId: '', title: id, icon: '', isTemplate: false, contentOrder: [], values, ...stamps }
}

let view: RenderedElement
beforeEach(async () => { await initI18n() })
afterEach(() => { view?.unmount() })

async function mount(cards: ProjectCard[], extra: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    view = renderElement(createElement(CalendarView, {
      cards, boardId: 'b1', properties, mode: 'month', onModeChange: vi.fn(), canEdit: true,
      onOpenCard: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), ...extra,
    }))
  })
}

const cells = (): HTMLElement[] => [...view.container.querySelectorAll<HTMLElement>('[data-calendar-day]')]
const cellFor = (key: string): HTMLElement => cells().find((cell) => cell.getAttribute('data-calendar-day') === key)!

describe('the month grid', () => {
  it('draws one labelled bar across the days a card spans, not a chip per day', async () => {
    await mount([card('Sprint', new Date(2026, 10, 10), new Date(2026, 10, 12))])
    const ribbons = [...view.container.querySelectorAll<HTMLElement>('[data-calendar-ribbons] [data-project-card="Sprint"]')]
    expect(ribbons).toHaveLength(1)
    expect(ribbons[0]!.textContent).toBe('Sprint')
    expect(ribbons[0]!.style.gridColumn).toBe('3 / 6')
    expect(ribbons[0]!.getAttribute('style')).toContain('--kanban-tag-blue-fg')
    expect(view.container.querySelector('.pv-cal-chip')).toBeNull()
  })

  it('leaves a bar square on the week edge it runs past', async () => {
    await mount([card('Long', new Date(2026, 10, 5), new Date(2026, 10, 18))])
    const bars = [...view.container.querySelectorAll<HTMLElement>('[data-project-card="Long"]')]
    expect(bars.length).toBeGreaterThan(1)
    expect(bars[0]!.getAttribute('data-continues-right')).toBe('true')
    expect(bars[1]!.getAttribute('data-continues-left')).toBe('true')
    expect(bars[1]!.getAttribute('data-continues-right')).toBe('true')
    expect(bars[bars.length - 1]!.getAttribute('data-continues-left')).toBe('true')
    expect(bars[bars.length - 1]!.getAttribute('data-continues-right')).toBe('false')
  })

  it('keeps a single-day card as a chip and marks today', async () => {
    const now = new Date()
    await mount([card('Once', now)])
    const chip = view.container.querySelector('.pv-cal-chip')
    expect(chip?.textContent).toBe('Once')
    expect(cells().filter((cell) => cell.getAttribute('data-today') === 'true')).toHaveLength(1)
  })

  it('names the spanning cards in a legend', async () => {
    await mount([card('Sprint', new Date(2026, 10, 10), new Date(2026, 10, 12))])
    expect(view.container.querySelector('.pv-legend')?.textContent).toContain('Sprint')
  })
})

describe('the day panel', () => {
  it('says what the selected day means to each card on it', async () => {
    await mount([card('Span', new Date(2026, 10, 10), new Date(2026, 10, 12)), card('Once', new Date(2026, 10, 11))])
    expect(view.container.querySelector('[data-calendar-panel]')).toBeNull()
    await act(async () => { cellFor('2026-11-11').querySelector<HTMLButtonElement>('.pv-cal-hit')!.click() })
    const panel = view.container.querySelector('[data-calendar-panel="2026-11-11"]')!
    expect(panel).not.toBeNull()
    const roles = [...panel.querySelectorAll('.pv-role')].map((node) => [node.getAttribute('data-role'), node.textContent])
    expect(roles).toEqual([['active', t('project.calendar.role_active')], ['both', t('project.calendar.role_both')]])
    const close = [...panel.querySelectorAll('button')].find((button) => button.textContent === t('common.close'))!
    await act(async () => { close.click() })
    expect(view.container.querySelector('[data-calendar-panel]')).toBeNull()
  })
})

describe('rescheduling by pointer', () => {
  it('moves a span to the day it was dropped on and keeps its length', async () => {
    const onPatchCard = vi.fn().mockResolvedValue(undefined)
    await mount([card('Sprint', new Date(2026, 10, 10), new Date(2026, 10, 12))], { onPatchCard })
    const chip = view.container.querySelector<HTMLElement>('[data-project-card="Sprint"]')!
    const target = cellFor('2026-11-20')
    target.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) })
    const original = document.elementFromPoint
    document.elementFromPoint = () => target
    try {
      const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0 })
      await act(async () => { chip.dispatchEvent(down) })
      await act(async () => { window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 60, clientY: 60 })) })
      expect(cellFor('2026-11-20').getAttribute('data-drop')).toBe('true')
      await act(async () => { window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 60, clientY: 60 })) })
    } finally { document.elementFromPoint = original }
    expect(onPatchCard).toHaveBeenCalledTimes(1)
    const [id, patch] = onPatchCard.mock.calls[0]!
    expect(id).toBe('Sprint')
    const written = JSON.parse((patch as { values: Record<string, string> }).values.pd!) as { from: number, to: number }
    expect(written.to - written.from).toBe(2 * 86_400_000)
    expect(new Date(written.from + new Date(written.from).getTimezoneOffset() * 60_000).getDate()).toBe(20)
  })
})

describe('range and quick add', () => {
  it('asks the host to change range rather than keeping it in local state', async () => {
    const onModeChange = vi.fn()
    await mount([], { onModeChange })
    const week = [...view.container.querySelectorAll<HTMLButtonElement>('.pv-seg-btn')].find((button) => button.textContent === t('project.view.calendar_week'))!
    await act(async () => { week.click() })
    expect(onModeChange).toHaveBeenCalledWith('week')
  })

  it('draws seven cells in week mode and one in day mode', async () => {
    await mount([], { mode: 'week' })
    expect(cells()).toHaveLength(7)
    view.unmount()
    await mount([], { mode: 'day' })
    expect(cells()).toHaveLength(1)
  })

  it('files a new card on the day whose plus was pressed', async () => {
    vi.mocked(prompt).mockResolvedValue('Fresh')
    vi.mocked(api.createProjectCard).mockResolvedValue(card('new'))
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    await mount([], { onRefresh })
    const add = cellFor('2026-11-20').querySelector<HTMLButtonElement>(`button[aria-label="${t('project.board.new_card')}"]`)!
    await act(async () => { add.click() })
    const [boardId, input] = vi.mocked(api.createProjectCard).mock.calls[0]!
    expect(boardId).toBe('b1')
    expect(input.title).toBe('Fresh')
    expect(Object.keys(input.values ?? {})).toEqual(['pd'])
    expect(onRefresh).toHaveBeenCalled()
  })
})