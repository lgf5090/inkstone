import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCard, ProjectProperty, ProjectViewFields } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'
import { projectDayToStamp } from '@shared/project/date'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { ListView } from './ListView'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const properties: ProjectProperty[] = [
  { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'open', value: 'Open', color: '' }, { id: 'done', value: 'Done', color: '' }] },
  { id: 'pp', name: 'Priority', type: 'select', options: [{ id: 'lo', value: 'Low', color: 'propColorGreen' }, { id: 'hi', value: 'High', color: 'propColorRed' }] },
  { id: 'pd', name: 'Due', type: 'date', options: [] },
]

function card(id: string, values: Record<string, string> = {}, parentId = ''): ProjectCard {
  return { id, boardId: 'b1', parentId, title: id, icon: '', isTemplate: false, contentOrder: [], values, ...stamps }
}

let view: RenderedElement
beforeEach(async () => { await initI18n() })
afterEach(() => { view?.unmount() })

async function mount(cards: ProjectCard[], extra: Partial<ProjectViewFields> = {}): Promise<Record<string, unknown>> {
  const props = {
    cards, properties, fields: { ...emptyProjectViewFields(), ...extra }, canEdit: true,
    badgesFor: () => ({ description: false, comments: 0, checked: 0, checkboxes: 0 }),
    onOpenCard: vi.fn(), onCardContextMenu: vi.fn(), onAddSubtask: vi.fn().mockResolvedValue(undefined),
    onToggleCardDone: vi.fn().mockResolvedValue(undefined), onDeleteCard: vi.fn(),
    onPatchCard: vi.fn().mockResolvedValue(undefined), onPatchFields: vi.fn(), onAddCard: vi.fn().mockResolvedValue(undefined),
  }
  await act(async () => { view = renderElement(createElement(ListView, props)) })
  return props as unknown as Record<string, unknown>
}

const row = (id: string): HTMLElement => view.container.querySelector<HTMLElement>(`[data-project-card="${id}"]`)!

describe('the round check', () => {
  it('is a checkbox that reports the done state and flips it', async () => {
    const props = await mount([card('a', { ps: 'done' }), card('b', { ps: 'open' })])
    const done = row('a').querySelector<HTMLButtonElement>('.pv-check')!
    expect(done.getAttribute('role')).toBe('checkbox')
    expect(done.getAttribute('aria-checked')).toBe('true')
    const open = row('b').querySelector<HTMLButtonElement>('.pv-check')!
    expect(open.getAttribute('aria-checked')).toBe('false')
    await act(async () => { open.click() })
    expect(props.onToggleCardDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), true)
  })
})

describe('editing without opening the card', () => {
  it('renames the title in place on a double click', async () => {
    const props = await mount([card('a')])
    await act(async () => { row('a').querySelector<HTMLButtonElement>('.pv-list-title')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) })
    const field = row('a').querySelector<HTMLInputElement>('.pv-list-edit')!
    expect(field).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(field, 'Renamed'); field.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(props.onPatchCard).toHaveBeenCalledWith('a', { title: 'Renamed' })
    expect(row('a').querySelector('.pv-list-edit')).toBeNull()
  })

  it('abandons the rename on Escape', async () => {
    const props = await mount([card('a')])
    await act(async () => { row('a').querySelector<HTMLButtonElement>('.pv-list-title')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) })
    const field = row('a').querySelector<HTMLInputElement>('.pv-list-edit')!
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(props.onPatchCard).not.toHaveBeenCalled()
    expect(row('a').querySelector('.pv-list-edit')).toBeNull()
  })

  it('walks the priority to the next option on a click', async () => {
    const props = await mount([card('a', { pp: 'lo' })])
    const chip = row('a').querySelector<HTMLButtonElement>('[data-priority-cycle]')!
    expect(chip.textContent).toBe('Low')
    await act(async () => { chip.click() })
    expect(props.onPatchCard).toHaveBeenCalledWith('a', { values: { pp: 'hi' } })
  })

  it('wraps from the last option back to the first', async () => {
    const props = await mount([card('a', { pp: 'hi' })])
    await act(async () => { row('a').querySelector<HTMLButtonElement>('[data-priority-cycle]')!.click() })
    expect(props.onPatchCard).toHaveBeenCalledWith('a', { values: { pp: 'lo' } })
  })
})

describe('the trailing columns', () => {
  it('paints a past due date red and leaves a future one alone', async () => {
    await mount([
      card('late', { pd: JSON.stringify({ from: projectDayToStamp(new Date(2020, 0, 2)) }) }),
      card('later', { pd: JSON.stringify({ from: projectDayToStamp(new Date(2099, 0, 2)) }) }),
    ])
    expect(row('late').querySelector('[data-overdue="true"]')).not.toBeNull()
    expect(row('later').querySelector('[data-overdue="true"]')).toBeNull()
  })

  it('shows only the columns the reader picked', async () => {
    const props = await mount([card('a', { ps: 'open', pp: 'hi' })], { visiblePropertyIds: ['pp'] })
    expect(row('a').querySelector('[data-priority-cycle]')).not.toBeNull()
    expect(row('a').textContent).not.toContain('Open')
    const trigger = view.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.view.list_columns')}"]`)!
    await act(async () => { trigger.click() })
    const status = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"], [role="menuitem"]')].find((node) => node.textContent === 'Status')!
    await act(async () => { status.click() })
    expect(props.onPatchFields).toHaveBeenCalledWith({ visiblePropertyIds: ['pp', 'ps'] })
  })
})

describe('hierarchy and drag affordance', () => {
  it('puts the grip before the check and keeps children under their parent', async () => {
    await mount([card('p'), card('c', {}, 'p')])
    const parent = row('p')
    const children = [...parent.children].map((node) => node.className.toString())
    expect(children[0]).toContain('pv-card-grip')
    expect(view.container.querySelector('[data-project-card="c"]')).toBeNull()
    await act(async () => { parent.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.card.expand_subtasks')}"]`)!.click() })
    expect(view.container.querySelector('[data-project-card="c"]')).not.toBeNull()
  })
})