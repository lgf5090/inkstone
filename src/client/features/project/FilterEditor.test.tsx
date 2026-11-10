import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardMember, ProjectProperty, ProjectView, ProjectViewFields } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'
import { projectDayToStamp } from '@shared/project/date'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { FilterModal } from './FilterEditor'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const properties: ProjectProperty[] = [
  { id: 'pt', name: 'Notes', type: 'text', options: [] },
  { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: '' }, { id: 'o2', value: 'Done', color: '' }] },
  { id: 'pd', name: 'Due', type: 'date', options: [] },
  { id: 'pp', name: 'Assignee', type: 'person', options: [] },
  { id: 'pb', name: 'Done', type: 'checkbox', options: [] },
  { id: 'pn', name: 'Estimate', type: 'number', options: [] },
]
const members: ProjectBoardMember[] = [{ boardId: 'b1', userId: 'u1', role: 'admin', createdAt: 1, updatedAt: 1 }, { boardId: 'b1', userId: 'u2', role: 'editor', createdAt: 1, updatedAt: 1 }]
const view: ProjectView = { id: 'v1', boardId: 'b1', title: 'V', viewType: 'table', fields: emptyProjectViewFields(), position: 0, ...stamps }

let viewEl: RenderedElement
let onPatch: ReturnType<typeof vi.fn<(fields: Partial<ProjectViewFields>) => Promise<void>>>
async function mount(fields = view.fields): Promise<void> {
  onPatch = vi.fn<(fields: Partial<ProjectViewFields>) => Promise<void>>().mockResolvedValue(undefined)
  await act(async () => {
    viewEl = renderElement(createElement(FilterModal, { view: { ...view, fields }, properties, members, canEdit: true, onClose: vi.fn(), onPatch }))
  })
}
beforeEach(async () => { await initI18n() })
afterEach(() => { viewEl?.unmount() })

function button(label: string): HTMLButtonElement {
  const entry = [...document.body.querySelectorAll('button')].find((node) => node.textContent === label) as HTMLButtonElement
  expect(entry).not.toBeUndefined()
  return entry
}
async function click(label: string): Promise<void> {
  await act(async () => { button(label).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
}
async function save(): Promise<void> {
  await click(t('common.save'))
}
function clauseRow(index = 0): HTMLElement {
  return document.body.querySelectorAll('[data-project-filter-clause]')[index] as HTMLElement
}
function selectIn(row: HTMLElement, label: string): HTMLButtonElement {
  return row.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement
}
/** The row a stored value is offered under: a property name, a join word, or a condition's own label. */
function labelFor(value: string): string {
  const property = properties.find((entry) => entry.id === value)
  if (property) return property.name
  if (value === 'and') return t('project.view.filter_and')
  if (value === 'or') return t('project.view.filter_or')
  return t(`project.condition.${value.toLowerCase()}` as Parameters<typeof t>[0])
}
async function choose(trigger: HTMLButtonElement, value: string): Promise<void> {
  await act(async () => { trigger.click() })
  const row = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"], [role="menuitem"]')].find((item) => item.textContent === labelFor(value))
  expect(row, `no menu row for ${value}`).toBeDefined()
  await act(async () => { row!.click() })
}
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the nested filter editor (C-9)', () => {
  it('adds a top-level clause on the reference default condition and saves the whole group', async () => {
    await mount()
    await click(t('project.view.add_filter'))
    const row = clauseRow()
    expect(selectIn(row, t('project.view.filter_condition')).textContent).toBe(t('project.condition.is'))
    await type(row.querySelector('input') as HTMLInputElement, 'abc')
    await save()
    expect(onPatch).toHaveBeenCalledWith({ filter: { operation: 'and', filters: [{ propertyId: 'pt', condition: 'is', values: ['abc'] }] } })
  })

  it('nests a group and switches the parent to or', async () => {
    await mount()
    await click(t('project.view.add_filter_group'))
    const parent = document.body.querySelector('[data-project-filter-group="0"]') as HTMLElement
    await choose(parent.querySelector(`button[aria-label="${t('project.view.filter_operation')}"]`) as HTMLButtonElement, 'or')
    const nested = document.body.querySelector('[data-project-filter-group="1"]') as HTMLElement
    await click(t('project.view.add_filter'))
    expect(nested.querySelector('[data-project-filter-clause]')).not.toBeNull()
    await save()
    const saved = onPatch.mock.calls[0]![0] as { filter: { operation: string, filters: unknown[] } }
    expect(saved.filter.operation).toBe('or')
    expect(saved.filter.filters).toHaveLength(1)
    expect(saved.filter.filters[0]).toMatchObject({ operation: 'and', filters: [{ propertyId: 'pt', condition: 'is', values: [] }] })
  })

  it('keeps an existing nested group when reopened', async () => {
    const fields = {
      ...emptyProjectViewFields(),
      filter: { operation: 'or' as const, filters: [{ operation: 'and' as const, filters: [{ propertyId: 'pt', condition: 'contains' as const, values: ['x'] }] }] },
    }
    await mount(fields)
    expect(document.body.querySelector('[data-project-filter-group="1"]')).not.toBeNull()
    expect((clauseRow().querySelector('input') as HTMLInputElement).value).toBe('x')
    await save()
    expect(onPatch).toHaveBeenCalledWith({ filter: fields.filter })
  })

  it('deletes a clause and a whole subgroup', async () => {
    await mount()
    await click(t('project.view.add_filter'))
    await click(t('project.view.add_filter_group'))
    const nested = document.body.querySelector('[data-project-filter-group="1"]') as HTMLElement
    await act(async () => { (nested.querySelector(`button[aria-label="${t('common.delete')}"]`) as HTMLButtonElement).click() })
    expect(document.body.querySelector('[data-project-filter-group="1"]')).toBeNull()
    await act(async () => { (clauseRow().querySelector(`button[aria-label="${t('common.delete')}"]`) as HTMLButtonElement).click() })
    await save()
    expect(onPatch).toHaveBeenCalledWith({ filter: { operation: 'and', filters: [] } })
  })

  it('resets the condition and values when the property type changes', async () => {
    await mount()
    await click(t('project.view.add_filter'))
    await type(clauseRow().querySelector('input') as HTMLInputElement, 'abc')
    await choose(selectIn(clauseRow(), t('project.view.filter')), 'ps')
    expect(selectIn(clauseRow(), t('project.view.filter_condition')).textContent).toBe(t('project.condition.includes'))
    await save()
    expect(onPatch).toHaveBeenCalledWith({ filter: { operation: 'and', filters: [{ propertyId: 'ps', condition: 'includes', values: [] }] } })
  })
})

describe('typed filter values (C-10/C-11)', () => {
  it('offers option checkboxes for a select and stores option ids', async () => {
    await mount()
    await click(t('project.view.add_filter'))
    await choose(selectIn(clauseRow(), t('project.view.filter')), 'ps')
    const open = [...clauseRow().querySelectorAll('[role="checkbox"]')].find((node) => node.textContent?.includes('Open')) as HTMLButtonElement
    await act(async () => { open.click() })
    await save()
    expect(onPatch).toHaveBeenCalledWith({ filter: { operation: 'and', filters: [{ propertyId: 'ps', condition: 'includes', values: ['o1'] }] } })
  })

  it('offers member checkboxes for a person clause', async () => {
    await mount()
    await click(t('project.view.add_filter'))
    await choose(selectIn(clauseRow(), t('project.view.filter')), 'pp')
    const member = [...clauseRow().querySelectorAll('[role="checkbox"]')].find((node) => node.textContent?.includes('u2')) as HTMLButtonElement
    await act(async () => { member.click() })
    await save()
    expect(onPatch).toHaveBeenCalledWith({ filter: { operation: 'and', filters: [{ propertyId: 'pp', condition: 'includes', values: ['u2'] }] } })
  })

  it('stores a date clause as a bare millisecond string and can clear it', async () => {
    await mount()
    await click(t('project.view.add_filter'))
    await choose(selectIn(clauseRow(), t('project.view.filter')), 'pd')
    await click(t('project.view.today'))
    await save()
    const saved = onPatch.mock.calls[0]![0] as { filter: { filters: { values: string[] }[] } }
    const stamp = Number(saved.filter.filters[0]!.values[0])
    expect(Number.isFinite(stamp)).toBe(true)
    expect(new Date(stamp).getUTCHours()).toBe(12)
    expect(projectDayToStamp(new Date())).toBe(stamp)
  })

  it('hides the value editor for isSet and for a boolean property', async () => {
    await mount()
    await click(t('project.view.add_filter'))
    await choose(selectIn(clauseRow(), t('project.view.filter')), 'pb')
    expect(selectIn(clauseRow(), t('project.view.filter_condition')).textContent).toBe(t('project.condition.isset'))
    expect(clauseRow().querySelector('input')).toBeNull()
    expect(clauseRow().querySelector('[role="checkbox"]')).toBeNull()
    await save()
    expect(onPatch).toHaveBeenCalledWith({ filter: { operation: 'and', filters: [{ propertyId: 'pb', condition: 'isSet', values: [] }] } })
  })

  it('uses a numeric input for a number clause', async () => {
    await mount()
    await click(t('project.view.add_filter'))
    await choose(selectIn(clauseRow(), t('project.view.filter')), 'pn')
    await choose(selectIn(clauseRow(), t('project.view.filter_condition')), 'greaterThan')
    const input = clauseRow().querySelector('input') as HTMLInputElement
    expect(input.type).toBe('number')
    await type(input, '5')
    await save()
    expect(onPatch).toHaveBeenCalledWith({ filter: { operation: 'and', filters: [{ propertyId: 'pn', condition: 'greaterThan', values: ['5'] }] } })
  })
})