import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCard, ProjectProperty } from '@shared/project/model'
import { projectDayToStamp, projectStampToInput } from '@shared/project/date'
import { PROJECT_TIMELINE_COLUMN_PX } from '@shared/project/timeline-layout'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { TimelineView } from './ExtraViews'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const properties: ProjectProperty[] = [{ id: 'pd', name: 'Due', type: 'date', options: [] }]

function card(id: string, title: string, from?: Date, to?: Date, parentId = ''): ProjectCard {
  const values: Record<string, string> = from === undefined ? {} : { pd: JSON.stringify(to ? { from: projectDayToStamp(from), to: projectDayToStamp(to) } : { from: projectDayToStamp(from) }) }
  return { id, boardId: 'b1', parentId, title, icon: '', isTemplate: false, contentOrder: [], values, ...stamps }
}

let view: RenderedElement
beforeEach(async () => {
  // jsdom ships no pointer capture; the drag handler asks for it before it attaches its listeners.
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  await initI18n()
})
afterEach(() => { view?.unmount() })

async function mount(cards: ProjectCard[], gantt = false): Promise<void> {
  await act(async () => { view = renderElement(createElement(TimelineView, { cards, properties, links: [], gantt, onOpenCard: vi.fn() })) })
}

describe('the timeline axis (R3-22)', () => {
  it('draws a dated axis with a bar per card rather than an unscaled strip', async () => {
    await mount([card('c1', 'Sprint', new Date(2026, 10, 10), new Date(2026, 10, 13))])
    const root = view.container.querySelector('[data-project-timeline]')
    expect(root, 'no timeline surface').not.toBeNull()
    const bar = view.container.querySelector<HTMLButtonElement>('[data-timeline-row="c1"] button')
    expect(bar).not.toBeNull()
    expect(bar!.style.width).toBe(`${4 * PROJECT_TIMELINE_COLUMN_PX.day}px`)
    expect(view.container.textContent).toContain('Sprint')
  })

  it('marks today when the window covers it', async () => {
    const now = new Date()
    await mount([card('c1', 'Now', new Date(now.getFullYear(), now.getMonth(), now.getDate()))])
    expect(view.container.querySelector('[data-timeline-today]')).not.toBeNull()
  })

  it('indents a subtask under its parent instead of listing it as a sibling', async () => {
    await mount([card('p', 'Parent', new Date(2026, 10, 10)), card('c', 'Child', new Date(2026, 10, 11), undefined, 'p')])
    const rows = [...view.container.querySelectorAll('[data-timeline-row]')]
    expect(rows.map((row) => row.getAttribute('data-timeline-row'))).toEqual(['p', 'c'])
    const expand = view.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.card.collapse_subtasks')}"]`)
    expect(expand, 'the parent has no collapse control').not.toBeNull()
    await act(async () => { expand!.click() })
    expect(view.container.querySelector('[data-timeline-row="c"]')).toBeNull()
    expect(view.container.querySelector('[data-timeline-row="p"]')).not.toBeNull()
  })

  it('lists undated cards in the unscheduled panel instead of dropping them', async () => {
    await mount([card('c1', 'Dated', new Date(2026, 10, 10)), card('c2', 'No date yet')])
    const panel = view.container.querySelector(`aside[aria-label="${t('project.view.unscheduled')}"]`)
    expect(panel, 'no unscheduled panel').not.toBeNull()
    expect(panel!.textContent).toContain('No date yet')
    expect(panel!.textContent).not.toContain('Dated')
    expect(view.container.querySelector('[data-timeline-row="c2"]')).toBeNull()
  })

  it('narrows the columns when the scale changes', async () => {
    await mount([card('c1', 'Sprint', new Date(2026, 10, 10), new Date(2026, 10, 13))])
    const before = view.container.querySelector<HTMLButtonElement>('[data-timeline-row="c1"] button')!.style.width
    const weeks = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === t('project.view.scale_week'))
    expect(weeks, 'no scale control').toBeDefined()
    await act(async () => { weeks!.click() })
    const after = view.container.querySelector<HTMLButtonElement>('[data-timeline-row="c1"] button')!.style.width
    expect(after).not.toBe(before)
    expect(after).toBe(`${4 * PROJECT_TIMELINE_COLUMN_PX.week}px`)
  })
})
describe('dragging a bar to reschedule (R3-22/R5-1)', () => {
  it('writes both ends through the shared day conversion and keeps the length', async () => {
    const onPatchCard = vi.fn().mockResolvedValue(undefined)
    const cards = [card('c1', 'Sprint', new Date(2026, 10, 10), new Date(2026, 10, 13))]
    await act(async () => { view = renderElement(createElement(TimelineView, { cards, properties, links: [], gantt: true, onOpenCard: vi.fn(), canEdit: true, onPatchCard })) })
    const bar = view.container.querySelector<HTMLButtonElement>('[data-timeline-row="c1"] button')!
    const down = new Event('pointerdown', { bubbles: true }) as PointerEvent
    Object.defineProperties(down, { clientX: { value: 100 }, pointerId: { value: 1 } })
    await act(async () => { bar.dispatchEvent(down) })
    const move = new Event('pointermove', { bubbles: true }) as PointerEvent
    Object.defineProperties(move, { clientX: { value: 100 + 2 * PROJECT_TIMELINE_COLUMN_PX.day } })
    await act(async () => { bar.dispatchEvent(move) })
    const up = new Event('pointerup', { bubbles: true }) as PointerEvent
    await act(async () => { bar.dispatchEvent(up) })
    expect(onPatchCard).toHaveBeenCalledTimes(1)
    const [id, patch] = onPatchCard.mock.calls[0]!
    expect(id).toBe('c1')
    const written = JSON.parse((patch as { values: Record<string, string> }).values.pd!) as { from: number, to: number }
    expect(projectStampToInput(written.from)).toBe('2026-11-12')
    expect(projectStampToInput(written.to)).toBe('2026-11-15')
  })

  it('offers no drag to a viewer', async () => {
    const onPatchCard = vi.fn().mockResolvedValue(undefined)
    await act(async () => { view = renderElement(createElement(TimelineView, { cards: [card('c1', 'Sprint', new Date(2026, 10, 10))], properties, links: [], gantt: false, onOpenCard: vi.fn(), canEdit: false, onPatchCard })) })
    const bar = view.container.querySelector<HTMLButtonElement>('[data-timeline-row="c1"] button')!
    expect(bar.className).not.toContain('cursor-grab')
    const down = new Event('pointerdown', { bubbles: true }) as PointerEvent
    Object.defineProperties(down, { clientX: { value: 100 }, pointerId: { value: 1 } })
    await act(async () => { bar.dispatchEvent(down) })
    const move = new Event('pointermove', { bubbles: true }) as PointerEvent
    Object.defineProperties(move, { clientX: { value: 100 + 3 * PROJECT_TIMELINE_COLUMN_PX.day } })
    await act(async () => { bar.dispatchEvent(move) })
    const up = new Event('pointerup', { bubbles: true }) as PointerEvent
    await act(async () => { bar.dispatchEvent(up) })
    expect(onPatchCard, 'a viewer drag still wrote').not.toHaveBeenCalled()
  })
})

describe('the timeline bar and dependency treatment (R4-3)', () => {
  const coloured: ProjectProperty[] = [
    { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: 'propColorBlue' }] },
    ...properties,
  ]

  it('paints the bar with the card status colour rather than a washed-out tint', async () => {
    const dated = { ...card('c1', 'Sprint', new Date(2026, 10, 10)), values: { ps: 'o1', pd: JSON.stringify({ from: projectDayToStamp(new Date(2026, 10, 10)) }) } }
    await act(async () => { view = renderElement(createElement(TimelineView, { cards: [dated], properties: coloured, links: [], gantt: true, onOpenCard: vi.fn() })) })
    const bar = view.container.querySelector<HTMLElement>('[data-timeline-bar="c1"]')!
    expect(bar.getAttribute('style')).toContain('--kanban-tag-blue-fg')
    expect(bar.className).toContain('text-white')
  })

  it('draws a blocking dependency as an arrow between the two bars', async () => {
    const a = card('a', 'Blocker', new Date(2026, 10, 10))
    const b = card('b', 'Blocked', new Date(2026, 10, 14))
    await act(async () => { view = renderElement(createElement(TimelineView, { cards: [a, b], properties, links: [{ fromCardId: 'a', toCardId: 'b', kind: 'blocks' }], gantt: true, onOpenCard: vi.fn() })) })
    const layer = view.container.querySelector('[data-timeline-dependencies]')
    expect(layer, 'no dependency layer').not.toBeNull()
    expect(layer!.getAttribute('data-timeline-dependencies')).toBe('1')
    expect(layer!.querySelector('path[marker-end]')).not.toBeNull()
  })

  it('draws no arrow when one end is off the drawn rows', async () => {
    const a = card('a', 'Blocker', new Date(2026, 10, 10))
    await act(async () => { view = renderElement(createElement(TimelineView, { cards: [a], properties, links: [{ fromCardId: 'a', toCardId: 'absent', kind: 'blocks' }], gantt: true, onOpenCard: vi.fn() })) })
    expect(view.container.querySelector('[data-timeline-dependencies]')).toBeNull()
  })

  it('marks the weekend columns without flooding the canvas', async () => {
    await act(async () => { view = renderElement(createElement(TimelineView, { cards: [card('c1', 'Sprint', new Date(2026, 10, 10))], properties, links: [], gantt: false, onOpenCard: vi.fn() })) })
    const grid = view.container.querySelector('[data-timeline-grid]')!
    const cells = [...grid.children] as HTMLElement[]
    expect(cells.length).toBeGreaterThan(6)
    expect(cells.every((cell) => cell.className.includes('opacity-60'))).toBe(true)
    expect(cells.some((cell) => (cell.getAttribute('style') ?? '').includes('color-mix'))).toBe(true)
  })
})

describe('dependency edges and collapsed rows (R4-3)', () => {
  it('draws no arrow to a dated card whose row is collapsed away', async () => {
    const parent = card('p', 'Parent', new Date(2026, 10, 10))
    const child = { ...card('c', 'Child', new Date(2026, 10, 14)), parentId: 'p' }
    await act(async () => { view = renderElement(createElement(TimelineView, { cards: [parent, child], properties, links: [{ fromCardId: 'p', toCardId: 'c', kind: 'blocks' }], gantt: true, onOpenCard: vi.fn() })) })
    expect(view.container.querySelector('[data-timeline-dependencies]')?.getAttribute('data-timeline-dependencies')).toBe('1')
    const collapse = view.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.card.collapse_subtasks')}"]`)!
    await act(async () => { collapse.click() })
    expect(view.container.querySelector('[data-timeline-row="c"]')).toBeNull()
    expect(view.container.querySelector('[data-timeline-dependencies]'), 'an edge points at a row that is not drawn').toBeNull()
  })
})

type PatchFn = (id: string, patch: Record<string, unknown>) => Promise<void>

describe('timeline reads, gantt plans (R5-1)', () => {
  const cards = [card('c1', 'Sprint', new Date(2026, 10, 10), new Date(2026, 10, 13))]

  async function dragBar(gantt: boolean, onPatchCard: ReturnType<typeof vi.fn<PatchFn>>) {
    await act(async () => { view = renderElement(createElement(TimelineView, { cards, properties, links: [], gantt, onOpenCard: vi.fn(), canEdit: true, onPatchCard })) })
    const bar = view.container.querySelector<HTMLButtonElement>('[data-timeline-row="c1"] [data-timeline-bar]')!
    const down = new Event('pointerdown', { bubbles: true }) as PointerEvent
    Object.defineProperties(down, { clientX: { value: 100 }, pointerId: { value: 1 }, button: { value: 0 } })
    await act(async () => { bar.dispatchEvent(down) })
    const move = new Event('pointermove', { bubbles: true }) as PointerEvent
    Object.defineProperties(move, { clientX: { value: 100 + 2 * PROJECT_TIMELINE_COLUMN_PX.day } })
    await act(async () => { bar.dispatchEvent(move) })
    await act(async () => { bar.dispatchEvent(new Event('pointerup', { bubbles: true })) })
  }

  it('refuses to reschedule from the timeline overview', async () => {
    const onPatchCard = vi.fn<PatchFn>().mockResolvedValue(undefined)
    await dragBar(false, onPatchCard)
    expect(onPatchCard, 'the read-only overview wrote a date').not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-schedule-mode="timeline"]')).not.toBeNull()
    expect(view.container.querySelector('[data-bar-handle]')).toBeNull()
    expect(view.container.textContent).toContain(t('project.view.timeline_hint'))
  })

  it('offers end handles and auto-fit only in the gantt', async () => {
    const onPatchCard = vi.fn<PatchFn>().mockResolvedValue(undefined)
    await dragBar(true, onPatchCard)
    expect(onPatchCard).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('[data-schedule-mode="gantt"]')).not.toBeNull()
    expect(view.container.querySelectorAll('[data-bar-handle]')).toHaveLength(2)
    expect([...view.container.querySelectorAll('button')].some((button) => button.textContent === t('project.view.auto_fit'))).toBe(true)
  })

  it('resizes only the end whose handle was dragged', async () => {
    const onPatchCard = vi.fn().mockResolvedValue(undefined)
    await act(async () => { view = renderElement(createElement(TimelineView, { cards, properties, links: [], gantt: true, onOpenCard: vi.fn(), canEdit: true, onPatchCard })) })
    const handle = view.container.querySelector<HTMLButtonElement>('[data-bar-handle="end"]')!
    const down = new Event('pointerdown', { bubbles: true }) as PointerEvent
    Object.defineProperties(down, { clientX: { value: 200 } })
    await act(async () => { handle.dispatchEvent(down) })
    const move = new Event('pointermove', { bubbles: true }) as PointerEvent
    Object.defineProperties(move, { clientX: { value: 200 + PROJECT_TIMELINE_COLUMN_PX.day } })
    await act(async () => { window.dispatchEvent(move) })
    await act(async () => { window.dispatchEvent(new Event('pointerup')) })
    const [, patch] = onPatchCard.mock.calls[0]!
    const written = JSON.parse((patch as { values: Record<string, string> }).values.pd!) as { from: number, to: number }
    expect(projectStampToInput(written.from)).toBe('2026-11-10')
    expect(projectStampToInput(written.to)).toBe('2026-11-14')
  })

  it('outlines a card that starts before its blocker ends', async () => {
    const blocker = card('a', 'Blocker', new Date(2026, 10, 10), new Date(2026, 10, 13))
    const dependent = card('b', 'Dependent', new Date(2026, 10, 12))
    await act(async () => { view = renderElement(createElement(TimelineView, { cards: [blocker, dependent], properties, links: [{ fromCardId: 'a', toCardId: 'b', kind: 'blocks' }], gantt: true, onOpenCard: vi.fn(), canEdit: true, onPatchCard: vi.fn().mockResolvedValue(undefined) })) })
    const offender = view.container.querySelector('[data-timeline-bar="b"][data-timeline-conflict]')
    expect(offender).not.toBeNull()
    expect(offender!.className).toContain('outline-[var(--danger)]')
    expect(view.container.querySelector('[data-timeline-bar="a"][data-timeline-conflict]')).toBeNull()
    expect(view.container.textContent).toContain(t('project.view.conflicts', { count: 1 }))
  })
})
