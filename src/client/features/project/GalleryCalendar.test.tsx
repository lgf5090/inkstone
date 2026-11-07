import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCard, ProjectProperty } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { CalendarView, GalleryView } from './GalleryCalendar'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const properties: ProjectProperty[] = [{ id: 'pd', name: 'Due', type: 'date', options: [] }]

function card(id: string, title: string, due?: number): ProjectCard {
  return { id, boardId: 'b1', parentId: '', title, icon: '', isTemplate: false, contentOrder: [], values: due === undefined ? {} : { pd: JSON.stringify({ from: due }) }, ...stamps }
}

let view: RenderedElement
beforeEach(async () => { await initI18n() })
afterEach(() => { view?.unmount() })

describe('gallery view', () => {
  it('renders a tile per card that opens the card', async () => {
    const onOpen = vi.fn()
    await act(async () => { view = renderElement(createElement(GalleryView, { cards: [card('c1', 'Alpha'), card('c2', 'Beta')], onOpenCard: onOpen })) })
    const tiles = [...view.container.querySelectorAll('[data-project-card]')]
    expect(tiles).toHaveLength(2)
    await act(async () => { tiles[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    expect(onOpen).toHaveBeenCalledWith('c1')
  })
})

describe('calendar view', () => {
  it('places a card on its due day and navigates months', async () => {
    const now = new Date()
    const due = new Date(now.getFullYear(), now.getMonth(), 15).getTime()
    await act(async () => { view = renderElement(createElement(CalendarView, { cards: [card('c1', 'Due card', due)], properties, onOpenCard: vi.fn() })) })
    expect(view.container.textContent).toContain('Due card')
    const next = [...view.container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === t('project.view.next_month'))
    await act(async () => { next?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    expect(view.container.textContent).not.toContain('Due card')
  })
})