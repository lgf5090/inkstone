import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCard, ProjectCardLink, ProjectProperty, ProjectViewFields } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'
import { projectDayToStamp, projectStampToInput } from '@shared/project/date'
import { PROJECT_TIMELINE_COLUMN_PX } from '@shared/project/timeline-layout'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { TimelineView } from './TimelineView'
import { GanttView } from './GanttView'
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
  { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: 'propColorBlue' }, { id: 'o2', value: 'Done', color: 'propColorGreen' }] },
  { id: 'pd', name: 'Due', type: 'date', options: [] },
]

function card(id: string, from?: Date, to?: Date, status = 'o1'): ProjectCard {
  const values: Record<string, string> = { ps: status }
  if (from) values.pd = JSON.stringify(to ? { from: projectDayToStamp(from), to: projectDayToStamp(to) } : { from: projectDayToStamp(from) })
  return { id, boardId: 'b1', parentId: '', title: id, icon: '', isTemplate: false, contentOrder: [], values, ...stamps }
}

const sprint = card('Sprint', new Date(2026, 10, 10), new Date(2026, 10, 13))
const links: ProjectCardLink[] = []
let view: RenderedElement

beforeEach(async () => { await initI18n(); vi.clearAllMocks() })
afterEach(() => { view?.unmount() })

function fields(extra: Partial<ProjectViewFields> = {}): ProjectViewFields {
  return { ...emptyProjectViewFields(), dateDisplayPropertyId: 'pd', ...extra }
}

async function mountTimeline(cards: ProjectCard[], extra: Partial<ProjectViewFields> = {}, edges: ProjectCardLink[] = links): Promise<Record<string, unknown>> {
  const props = { cards, properties, links: edges, fields: fields(extra), subtasksByParent: new Map<string, ProjectCard[]>(), canEdit: true, onOpenCard: vi.fn(), onPatchFields: vi.fn() }
  await act(async () => { view = renderElement(createElement(TimelineView, props)) })
  return props as unknown as Record<string, unknown>
}

async function mountGantt(cards: ProjectCard[], extra: Partial<ProjectViewFields> = {}, edges: ProjectCardLink[] = links): Promise<Record<string, unknown>> {
  const props = {
    cards, boardId: 'b1', properties, links: edges, fields: fields(extra), subtasksByParent: new Map<string, ProjectCard[]>(),
    canEdit: true, onOpenCard: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onPatchFields: vi.fn(), onRefresh: vi.fn().mockResolvedValue(undefined),
  }
  await act(async () => { view = renderElement(createElement(GanttView, props)) })
  return props as unknown as Record<string, unknown>
}

function pointer(type: string, x: number, target: EventTarget = window): void {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 20, button: 0, pointerId: 1, pointerType: 'mouse' })
  target.dispatchEvent(event)
}

describe('the timeline reads', () => {
  it('draws a bar per dated card at the scale the view saved', async () => {
    await mountTimeline([sprint])
    const bar = view.container.querySelector<HTMLElement>('[data-schedule-bar="Sprint"]')!
    expect(bar.style.width).toBe(`${4 * PROJECT_TIMELINE_COLUMN_PX.day}px`)
    expect(view.container.querySelector('[data-bar-handle]')).toBeNull()
    expect(view.container.querySelector('[data-schedule-frame]')).not.toBeNull()
  })

  it('narrows the axis when the reader picks a coarser scale', async () => {
    const props = await mountTimeline([sprint])
    const week = [...view.container.querySelectorAll<HTMLButtonElement>('.pv-seg-btn')].find((button) => button.textContent === t('project.view.scale_week'))!
    await act(async () => { week.click() })
    expect(props.onPatchFields).toHaveBeenCalledWith({ scheduleScale: 'week' })
  })

  it('lists one row per card in board order, never a lane band', async () => {
    await mountTimeline([sprint, card('Shipped', new Date(2026, 10, 11), undefined, 'o2')], { scheduleGroupById: 'ps' })
    expect(view.container.querySelectorAll('.pv-sched-lanehead')).toHaveLength(0)
    expect([...view.container.querySelectorAll('[data-schedule-row]')].map((node) => node.getAttribute('data-schedule-row'))).toEqual(['Sprint', 'Shipped'])
    expect(view.container.querySelector('.pv-sched-head')?.getAttribute('data-axis')).toBe('double')
  })

  it('carries a whole-range strip showing where the viewport sits', async () => {
    await mountTimeline([sprint])
    const strip = view.container.querySelector('.pv-minimap')!
    expect(strip).not.toBeNull()
    expect(strip.querySelectorAll('.pv-minimap-bar')).toHaveLength(1)
    expect(strip.querySelector('.pv-minimap-window')).not.toBeNull()
  })

  it('folds a parent away and takes its children with it', async () => {
    const parent = card('Parent', new Date(2026, 10, 10))
    const child = { ...card('Child', new Date(2026, 10, 12)), parentId: 'Parent' }
    await mountTimeline([parent, child])
    expect(view.container.querySelector('[data-schedule-row="Child"]')).not.toBeNull()
    const toggle = view.container.querySelector<HTMLButtonElement>(`[data-schedule-row="Parent"] button[aria-label]`)!
    await act(async () => { toggle.click() })
    expect(view.container.querySelector('[data-schedule-row="Child"]')).toBeNull()
  })

  it('draws the blocking edge as an elbow between the two bars', async () => {
    const blocker = card('A', new Date(2026, 10, 10))
    const dependent = card('B', new Date(2026, 10, 14))
    await mountTimeline([blocker, dependent], {}, [{ fromCardId: 'A', toCardId: 'B', kind: 'blocks' }])
    const layer = view.container.querySelector('[data-schedule-dependencies]')!
    expect(layer.getAttribute('data-schedule-dependencies')).toBe('1')
    expect(layer.querySelector('path[marker-end]')!.getAttribute('d')).toMatch(/^M [\d.]+ [\d.]+ H /)
  })

  it('keeps undated cards in a tray instead of dropping them', async () => {
    await mountTimeline([sprint, card('Later')])
    const tray = view.container.querySelector('[data-unscheduled]')!
    expect(tray.textContent).toContain('Later')
    expect(tray.textContent).not.toContain('Sprint')
    expect(view.container.querySelector('[data-schedule-row="Later"]')).toBeNull()
  })
})

describe('the gantt writes', () => {
  it('offers both end handles and moves the whole bar by the dragged columns', async () => {
    const props = await mountGantt([sprint])
    expect(view.container.querySelectorAll('[data-bar-handle]')).toHaveLength(2)
    const bar = view.container.querySelector<HTMLElement>('[data-schedule-bar="Sprint"]')!
    await act(async () => { pointer('pointerdown', 100, bar) })
    await act(async () => { pointer('pointermove', 100 + 2 * PROJECT_TIMELINE_COLUMN_PX.day) })
    await act(async () => { pointer('pointerup', 100 + 2 * PROJECT_TIMELINE_COLUMN_PX.day) })
    const patch = (props.onPatchCard as ReturnType<typeof vi.fn>).mock.calls[0]!
    const written = JSON.parse((patch[1] as { values: Record<string, string> }).values.pd!) as { from: number, to: number }
    expect(projectStampToInput(written.from)).toBe('2026-11-12')
    expect(projectStampToInput(written.to)).toBe('2026-11-15')
  })

  it('resizes only the end whose handle was pulled', async () => {
    const props = await mountGantt([sprint])
    const handle = view.container.querySelector<HTMLElement>('[data-bar-handle="end"]')!
    await act(async () => { pointer('pointerdown', 200, handle) })
    await act(async () => { pointer('pointermove', 200 + PROJECT_TIMELINE_COLUMN_PX.day) })
    await act(async () => { pointer('pointerup', 200 + PROJECT_TIMELINE_COLUMN_PX.day) })
    const patch = (props.onPatchCard as ReturnType<typeof vi.fn>).mock.calls[0]!
    const written = JSON.parse((patch[1] as { values: Record<string, string> }).values.pd!) as { from: number, to: number }
    expect(projectStampToInput(written.from)).toBe('2026-11-10')
    expect(projectStampToInput(written.to)).toBe('2026-11-14')
  })

  it('pulls either end by a day from the handle keys', async () => {
    const props = await mountGantt([sprint])
    const start = view.container.querySelector<HTMLElement>('[data-bar-handle="start"]')!
    const end = view.container.querySelector<HTMLElement>('[data-bar-handle="end"]')!
    expect(start.tagName).toBe('BUTTON')
    expect(end.tagName).toBe('BUTTON')
    await act(async () => { end.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
    const grown = JSON.parse(((props.onPatchCard as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { values: Record<string, string> }).values.pd!) as { from: number, to: number }
    expect(projectStampToInput(grown.from)).toBe('2026-11-10')
    expect(projectStampToInput(grown.to)).toBe('2026-11-14')
    await act(async () => { start.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
    const shrunk = JSON.parse(((props.onPatchCard as ReturnType<typeof vi.fn>).mock.calls[1]![1] as { values: Record<string, string> }).values.pd!) as { from: number, to: number }
    expect(projectStampToInput(shrunk.from)).toBe('2026-11-11')
    expect(projectStampToInput(shrunk.to)).toBe('2026-11-13')
  })

  it('creates a card from the canvas keyboard entry', async () => {
    vi.mocked(prompt).mockResolvedValue('Typed')
    vi.mocked(api.createProjectCard).mockResolvedValue(card('Typed'))
    const props = await mountGantt([sprint])
    const canvas = view.container.querySelector<HTMLElement>('.pv-sched-canvas')!
    expect(canvas.getAttribute('tabindex')).toBe('0')
    await act(async () => { canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    const [boardId, input] = vi.mocked(api.createProjectCard).mock.calls[0]!
    expect(boardId).toBe('b1')
    expect(input.title).toBe('Typed')
    const written = JSON.parse(input.values!.pd!) as { from: number, to?: number }
    expect(projectStampToInput(written.from)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(written.to).toBeUndefined()
    expect(props.onRefresh).toHaveBeenCalled()
  })

  it('outlines a card that starts before its blocker ends and counts the conflict', async () => {
    const blocker = card('A', new Date(2026, 10, 10), new Date(2026, 10, 13))
    const dependent = card('B', new Date(2026, 10, 12))
    await mountGantt([blocker, dependent], {}, [{ fromCardId: 'A', toCardId: 'B', kind: 'blocks' }])
    expect(view.container.querySelector('[data-schedule-bar="B"][data-conflict="true"]')).not.toBeNull()
    expect(view.container.querySelector('[data-schedule-bar="A"][data-conflict="true"]')).toBeNull()
    expect(view.container.textContent).toContain(t('project.view.conflicts', { count: 1 }))
  })

  it('draws a ghost while an empty stretch is dragged, then files a card on those dates', async () => {
    vi.mocked(prompt).mockResolvedValue('Drawn')
    vi.mocked(api.createProjectCard).mockResolvedValue(card('Drawn'))
    const props = await mountGantt([sprint])
    const canvas = view.container.querySelector<HTMLElement>('.pv-sched-canvas')!
    const scroller = view.container.querySelector<HTMLElement>('.pv-sched-scroll')!
    scroller.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400, x: 0, y: 0, toJSON: () => ({}) })
    // The axis opens centred on today; start the drag from a known scroll offset.
    scroller.scrollLeft = 0
    const row = [...view.container.querySelectorAll<HTMLElement>('[data-schedule-row]')][0]!
    const y = Number.parseFloat(row.style.top) + 18
    const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 40, clientY: y, button: 0, pointerId: 1 })
    await act(async () => { canvas.dispatchEvent(down) })
    await act(async () => { window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 40 + 3 * PROJECT_TIMELINE_COLUMN_PX.day, clientY: y })) })
    const ghost = view.container.querySelector<HTMLElement>('[data-draw-preview]')!
    expect(ghost).not.toBeNull()
    expect(ghost.style.width).toBe(`${4 * PROJECT_TIMELINE_COLUMN_PX.day}px`)
    await act(async () => { window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 40 + 3 * PROJECT_TIMELINE_COLUMN_PX.day, clientY: y })) })
    expect(view.container.querySelector('[data-draw-preview]')).toBeNull()
    const [boardId, input] = vi.mocked(api.createProjectCard).mock.calls[0]!
    expect(boardId).toBe('b1')
    expect(input.title).toBe('Drawn')
    const written = JSON.parse(input.values!.pd!) as { from: number, to: number }
    expect(projectStampToInput(written.from)).toBe('2026-11-08')
    expect(projectStampToInput(written.to)).toBe('2026-11-11')
    expect(props.onRefresh).toHaveBeenCalled()
  })

  it('moves a bar to another status from the right-click palette', async () => {
    const props = await mountGantt([sprint])
    const bar = view.container.querySelector<HTMLElement>('[data-schedule-bar="Sprint"]')!
    await act(async () => { bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })) })
    const palette = view.container.querySelector('[data-bar-palette]')!
    const done = [...palette.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === 'Done')!
    await act(async () => { done.click() })
    expect(props.onPatchCard).toHaveBeenCalledWith('Sprint', { values: { ps: 'o2' } })
    expect(view.container.querySelector('[data-bar-palette]')).toBeNull()
  })

  it('renames a bar in place on a double click', async () => {
    const props = await mountGantt([sprint])
    const bar = view.container.querySelector<HTMLElement>('[data-schedule-bar="Sprint"]')!
    await act(async () => { bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) })
    const field = view.container.querySelector<HTMLInputElement>('.pv-rename')!
    expect(field).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(field, 'Renamed'); field.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(props.onPatchCard).toHaveBeenCalledWith('Sprint', { title: 'Renamed' })
  })

  it('takes the selected bar off the schedule with Delete rather than deleting the card', async () => {
    const props = await mountGantt([sprint])
    const bar = view.container.querySelector<HTMLElement>('[data-schedule-bar="Sprint"]')!
    await act(async () => { pointer('pointerdown', 100, bar) })
    await act(async () => { pointer('pointerup', 100) })
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })) })
    expect(props.onPatchCard).toHaveBeenCalledWith('Sprint', { values: { pd: null } })
  })

  it('bands rows into lanes, sums lane effort and heads the axis once', async () => {
    const withEffort: ProjectProperty[] = [...properties, { id: 'pn', name: 'Hours', type: 'number', options: [] }]
    const a = { ...sprint, values: { ...sprint.values, pn: '8' } }
    const b = { ...card('Shipped', new Date(2026, 10, 11), undefined, 'o2'), values: { ps: 'o2', pd: card('Shipped', new Date(2026, 10, 11)).values.pd!, pn: '5' } }
    await act(async () => {
      view = renderElement(createElement(GanttView, {
        cards: [a, b], boardId: 'b1', properties: withEffort, links, fields: fields({ scheduleGroupById: 'ps' }),
        subtasksByParent: new Map(), canEdit: true, onOpenCard: vi.fn(), onPatchCard: vi.fn(), onPatchFields: vi.fn(), onRefresh: vi.fn(),
      }))
    })
    expect(view.container.querySelector('.pv-sched-head')?.getAttribute('data-axis')).toBe('single')
    expect(view.container.querySelector('.pv-minimap')).toBeNull()
    const sums = [...view.container.querySelectorAll('.pv-lane-sum')].map((node) => node.textContent)
    expect(sums).toEqual([t('project.view.lane_effort', { value: 8 }), t('project.view.lane_effort', { value: 5 }), t('project.view.lane_effort', { value: 0 })])
    const toggle = view.container.querySelector<HTMLButtonElement>('.pv-sched-lanehead button')!
    await act(async () => { toggle.click() })
    expect(view.container.querySelector('[data-schedule-row="Sprint"]')).toBeNull()
    expect(view.container.querySelector('[data-schedule-row="Shipped"]')).not.toBeNull()
  })

  it('opens on conflicts rather than arrows, and keeps its switches in a drawer', async () => {
    const props = await mountGantt([sprint])
    expect(view.container.querySelector('[data-schedule-dependencies]')).toBeNull()
    expect(view.container.querySelector('[data-gantt-settings]')).toBeNull()
    const gear = view.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.view.gantt_settings')}"]`)!
    await act(async () => { gear.click() })
    const drawer = view.container.querySelector('[data-gantt-settings]')!
    expect(drawer.querySelectorAll('[role="checkbox"]')).toHaveLength(3)
    const deps = [...drawer.querySelectorAll<HTMLElement>('[role="checkbox"]')][2]!
    await act(async () => { deps.click() })
    expect(props.onPatchFields).toHaveBeenCalledWith({ scheduleShowDependencies: true })
  })

  it('offers a viewer no handles and no drawing', async () => {
    const cards = [sprint]
    await act(async () => {
      view = renderElement(createElement(GanttView, {
        cards, boardId: 'b1', properties, links, fields: fields(), subtasksByParent: new Map(),
        canEdit: false, onOpenCard: vi.fn(), onPatchCard: vi.fn(), onPatchFields: vi.fn(), onRefresh: vi.fn(),
      }))
    })
    expect(view.container.querySelector('[data-bar-handle]')).toBeNull()
    const bar = view.container.querySelector<HTMLElement>('[data-schedule-bar="Sprint"]')!
    expect(bar.getAttribute('data-draggable')).toBe('false')
  })
})