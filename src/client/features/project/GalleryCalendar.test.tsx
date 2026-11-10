import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCard, ProjectProperty } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { projectDayToStamp } from '@shared/project/date'
import { projectCardBadges } from '@shared/project/badges'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { CalendarView, GalleryView } from './GalleryCalendar'
import * as api from './api'
import { prompt } from '../../components/overlay'

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  createProjectCard: vi.fn(),
}))
vi.mock('../../components/overlay', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../components/overlay')>(),
  prompt: vi.fn(),
}))

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
    await act(async () => { view = renderElement(createElement(GalleryView, { cards: [card('c1', 'Alpha'), card('c2', 'Beta')], badgesFor: () => ({ description: false, comments: 0, checked: 0, checkboxes: 0 }), properties: [], showTitle: true, showBadges: true, onOpenCard: onOpen })) })
    const tiles = [...view.container.querySelectorAll('[data-project-card]')]
    expect(tiles).toHaveLength(2)
    await act(async () => { tiles[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    expect(onOpen).toHaveBeenCalledWith('c1')
  })

  it('shows description/comment/task badges on a tile (B-6)', async () => {
    const contents = [{ id: 'a1', cardId: 'c1', boardId: 'b1', type: 'text' as const, title: '- [x] done\n- [ ] todo', fields: {}, position: 0, ...stamps }]
    const comments = [{ id: 'm1', cardId: 'c1', boardId: 'b1', authorId: 'u1', body: 'hi', createAt: 1, updateAt: 1, deleteAt: 0 }]
    await act(async () => { view = renderElement(createElement(GalleryView, { cards: [card('c1', 'Alpha'), card('c2', 'Beta')], badgesFor: (id) => (id === 'c1' ? projectCardBadges(contents, comments) : { description: false, comments: 0, checked: 0, checkboxes: 0 }), properties: [], showTitle: true, showBadges: true, onOpenCard: vi.fn() })) })
    const tiles = [...view.container.querySelectorAll('[data-project-card]')]
    expect(tiles[0]!.textContent).toContain('1/2')
    expect(tiles[0]!.textContent).toContain('1')
    expect(tiles[1]!.textContent).not.toContain('1/2')
  })
})

describe('calendar view', () => {
  it('places a card on its due day and navigates months', async () => {
    const now = new Date()
    const due = new Date(now.getFullYear(), now.getMonth(), 15).getTime()
    await act(async () => { view = renderElement(createElement(CalendarView, { boardId: 'b1', cards: [card('c1', 'Due card', due)], properties, canEdit: true, onOpenCard: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined) })) })
    expect(view.container.textContent).toContain('Due card')
    const next = [...view.container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === t('project.view.next_month'))
    await act(async () => { next?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    expect(view.container.textContent).not.toContain('Due card')
  })

  it('dropping a card on a day reschedules its date property (C-5)', async () => {
    const now = new Date()
    const due = new Date(now.getFullYear(), now.getMonth(), 15).getTime()
    const onPatchCard = vi.fn().mockResolvedValue(undefined)
    await act(async () => { view = renderElement(createElement(CalendarView, { boardId: 'b1', cards: [card('c1', 'Due card', due)], properties, canEdit: true, onOpenCard: vi.fn(), onPatchCard })) })
    const cells = [...view.container.querySelectorAll('div.min-h-16')]
    const target = cells.find((cell) => cell.firstElementChild?.textContent === '20')!
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { getData: () => 'c1' } })
    await act(async () => { target.dispatchEvent(event) })
    expect(onPatchCard).toHaveBeenCalledWith('c1', { values: { pd: JSON.stringify({ from: projectDayToStamp(new Date(now.getFullYear(), now.getMonth(), 20)) }) } })
  })

  it('highlights today and offers a jump-back-to-today control (R2-4)', async () => {
    await act(async () => { view = renderElement(createElement(CalendarView, { boardId: 'b1', cards: [], properties, canEdit: true, onOpenCard: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined) })) })
    const todayButton = [...view.container.querySelectorAll('button')].find((b) => b.textContent === t('project.view.today'))
    expect(todayButton).toBeTruthy()
    const highlighted = [...view.container.querySelectorAll('div.min-h-16')].filter((c) => c.className.includes('border-[var(--accent)]'))
    expect(highlighted).toHaveLength(1)
  })

  it('switches between month and week view modes via Segmented control', async () => {
    await act(async () => { view = renderElement(createElement(CalendarView, { boardId: 'b1', cards: [], properties, canEdit: true, onOpenCard: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined) })) })
    const weekBtn = [...view.container.querySelectorAll('button')].find((b) => b.textContent === t('preview.kanban_calendar_week'))
    expect(weekBtn).toBeTruthy()
    await act(async () => { weekBtn?.click() })
    const cells = [...view.container.querySelectorAll('div.min-h-16')]
    expect(cells).toHaveLength(7)
  })

  it('preserves multi-day duration when dropped on a new day', async () => {
    const now = new Date()
    const from = new Date(now.getFullYear(), now.getMonth(), 10).getTime()
    const to = new Date(now.getFullYear(), now.getMonth(), 13).getTime()
    const duration = to - from
    const onPatchCard = vi.fn().mockResolvedValue(undefined)
    const multiCard: ProjectCard = {
      ...card('c1', 'Sprint', from),
      values: { pd: JSON.stringify({ from, to }) },
    }
    await act(async () => { view = renderElement(createElement(CalendarView, { boardId: 'b1', cards: [multiCard], properties, canEdit: true, onOpenCard: vi.fn(), onPatchCard })) })
    const cells = [...view.container.querySelectorAll('div.min-h-16')]
    const target = cells.find((cell) => cell.firstElementChild?.textContent === '20')!
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { getData: () => 'c1' } })
    await act(async () => { target.dispatchEvent(event) })
    const newFrom = projectDayToStamp(new Date(now.getFullYear(), now.getMonth(), 20))
    expect(onPatchCard).toHaveBeenCalledWith('c1', { values: { pd: JSON.stringify({ from: newFrom, to: newFrom + duration }) } })
  })
})

describe('gallery display toggles (C-4)', () => {
  it('hides titles and badges when toggled off', async () => {
    await act(async () => { view = renderElement(createElement(GalleryView, { cards: [card('c1', 'Alpha')], badgesFor: () => ({ description: false, comments: 0, checked: 0, checkboxes: 0 }), properties: [], showTitle: false, showBadges: false, onOpenCard: vi.fn() })) })
    const tile = view.container.querySelector('[data-project-card="c1"]')!
    expect(tile.textContent).not.toContain('Alpha')
  })
  it('shows titles when toggled on', async () => {
    await act(async () => { view = renderElement(createElement(GalleryView, { cards: [card('c1', 'Alpha')], badgesFor: () => ({ description: false, comments: 0, checked: 0, checkboxes: 0 }), properties: [], showTitle: true, showBadges: true, onOpenCard: vi.fn() })) })
    expect(view.container.querySelector('[data-project-card="c1"]')!.textContent).toContain('Alpha')
  })
})
describe('calendar quick add (R3-6)', () => {
  it('files a new card on the pressed day even when the view is filtered empty', async () => {
    vi.mocked(prompt).mockResolvedValue('Fresh task')
    vi.mocked(api.createProjectCard).mockResolvedValue({ ...card('cnew', 'Fresh task'), boardId: 'b1' })
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    await act(async () => { view = renderElement(createElement(CalendarView, { boardId: 'b1', cards: [], properties, canEdit: true, onOpenCard: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onRefresh })) })
    const add = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === t('project.board.new_card'))
    expect(add, 'no quick-add affordance on an empty calendar').toBeDefined()
    await act(async () => { add!.click() })
    expect(api.createProjectCard).toHaveBeenCalledTimes(1)
    const [boardId, input] = vi.mocked(api.createProjectCard).mock.calls[0]!
    expect(boardId).toBe('b1')
    expect(input.title).toBe('Fresh task')
    expect(Object.keys(input.values ?? {})).toEqual(['pd'])
    expect(onRefresh).toHaveBeenCalled()
  })

  it('offers no quick-add affordance when the board has no date property to file against', async () => {
    await act(async () => { view = renderElement(createElement(CalendarView, { boardId: 'b1', cards: [], properties: [{ id: 'pt', name: 'Notes', type: 'text', options: [] }], canEdit: true, onOpenCard: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined) })) })
    const add = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === t('project.board.new_card'))
    expect(add).toBeUndefined()
  })
})

describe('the grouped gallery (R3-21)', () => {
  const grouped: ProjectProperty[] = [
    { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: '' }, { id: 'o2', value: 'Done', color: '' }] },
  ]
  const withStatus = (id: string, title: string, option: string): ProjectCard => ({ ...card(id, title), values: { ps: option } })

  it('splits the tiles into a section per option with its count', async () => {
    await act(async () => { view = renderElement(createElement(GalleryView, { cards: [withStatus('c1', 'Alpha', 'o1'), withStatus('c2', 'Beta', 'o2')], badgesFor: () => ({ description: false, comments: 0, checked: 0, checkboxes: 0 }), properties: [], showTitle: true, showBadges: false, onOpenCard: vi.fn(), groupById: 'ps', allProperties: grouped })) })
    const sections = [...view.container.querySelectorAll('[data-gallery-group]')]
    expect(sections.map((node) => node.getAttribute('data-gallery-group'))).toEqual(['o1', 'o2', ''])
    expect(sections[0]!.textContent).toContain('Alpha')
    expect(sections[0]!.textContent).not.toContain('Beta')
    expect(sections[0]!.querySelector('[aria-expanded]')?.textContent).toContain('1')
  })

  it('hides a collapsed group tiles but keeps its header', async () => {
    await act(async () => { view = renderElement(createElement(GalleryView, { cards: [withStatus('c1', 'Alpha', 'o1')], badgesFor: () => ({ description: false, comments: 0, checked: 0, checkboxes: 0 }), properties: [], showTitle: true, showBadges: false, onOpenCard: vi.fn(), groupById: 'ps', allProperties: grouped, collapsedOptionIds: ['o1'] })) })
    expect(view.container.querySelector('[data-project-card="c1"]')).toBeNull()
    expect(view.container.querySelector('[data-gallery-group="o1"]')).not.toBeNull()
  })

  it('uses the cover the caller resolves instead of the icon placeholder', async () => {
    await act(async () => { view = renderElement(createElement(GalleryView, { cards: [card('c1', 'Alpha')], badgesFor: () => ({ description: false, comments: 0, checked: 0, checkboxes: 0 }), properties: [], showTitle: true, showBadges: false, onOpenCard: vi.fn(), coverFor: () => '/api/project/files/i1' })) })
    expect(view.container.querySelector('[data-project-card="c1"] img')?.getAttribute('src')).toBe('/api/project/files/i1')
  })

  it('files a new card into the group whose tile was used', async () => {
    const onAddCard = vi.fn().mockResolvedValue(undefined)
    await act(async () => { view = renderElement(createElement(GalleryView, { cards: [], badgesFor: () => ({ description: false, comments: 0, checked: 0, checkboxes: 0 }), properties: [], showTitle: true, showBadges: false, onOpenCard: vi.fn(), groupById: 'ps', allProperties: grouped, canEdit: true, onAddCard })) })
    const tiles = [...view.container.querySelectorAll<HTMLButtonElement>('[data-gallery-group] button')].filter((button) => button.textContent === t('project.board.new_card'))
    expect(tiles).toHaveLength(3)
    await act(async () => { tiles[1]!.click() })
    const field = view.container.querySelector<HTMLInputElement>(`input[aria-label="${t('project.board.new_card')}"]`)
    expect(field).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(field!, 'Fresh'); field!.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { field!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(onAddCard).toHaveBeenCalledWith('Fresh', 'o2')
  })
})
