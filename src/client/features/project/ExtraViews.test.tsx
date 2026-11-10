import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCard, ProjectProperty } from '@shared/project/model'
import { projectDayToStamp } from '@shared/project/date'
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
beforeEach(async () => { await initI18n() })
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