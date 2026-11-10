import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ProjectProperty } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { BoardPropertiesDialog } from './BoardPropertiesDialog'

const existing: ProjectProperty[] = [{ id: 'p1', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: '' }] }]

type SaveFn = (properties: ProjectProperty[], deletedIds: string[]) => Promise<void>
let view: RenderedElement
let onSave: Mock<SaveFn>
async function mount(): Promise<void> {
  onSave = vi.fn<SaveFn>()
  onSave.mockResolvedValue(undefined)
  await act(async () => {
    view = renderElement(createElement(BoardPropertiesDialog, { boardId: 'b1', properties: existing, onClose: vi.fn(), onSave }))
  })
}
beforeEach(async () => { await initI18n() })
afterEach(() => { view?.unmount() })

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('the property dialog', () => {
  it('adds a property and saves the draft as a whole-array replace', async () => {
    await mount()
    const nameInput = document.body.querySelector(`input[placeholder="${t('project.props.name')}"]`) as HTMLInputElement
    await act(async () => { setInput(nameInput, 'Priority') })
    const addButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === t('project.props.add'))
    await act(async () => { addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    const saveButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === t('common.save'))
    await act(async () => { saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    expect(onSave).toHaveBeenCalledTimes(1)
    const [draft, deleted] = onSave.mock.calls[0]!
    expect(draft).toHaveLength(2)
    expect(draft[1].name).toBe('Priority')
    expect(deleted).toEqual([])
  })

  it('reports removed ids when a property is deleted', async () => {
    await mount()
    const deleteButtons = [...document.body.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === t('common.delete'))
    await act(async () => { deleteButtons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    const saveButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === t('common.save'))
    await act(async () => { saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    const [draft, deleted] = onSave.mock.calls[0]!
    expect(draft).toHaveLength(0)
    expect(deleted).toEqual(['p1'])
  })
})
describe('option colour and name (R3-12)', () => {
  it('writes the reference colour token the archive round trips', async () => {
    await mount()
    const trigger = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.props.option_color')}: Open"]`)
    expect(trigger, 'no colour affordance on the option row').not.toBeNull()
    await act(async () => { trigger!.click() })
    const red = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"], [role="menuitem"]')].find((button) => button.textContent === t('project.color.red'))
    expect(red, 'the palette never opened').toBeDefined()
    await act(async () => { red!.click() })
    const save = [...document.body.querySelectorAll('button')].find((b) => b.textContent === t('common.save'))
    await act(async () => { save!.click() })
    const [draft] = onSave.mock.calls[0]!
    expect(draft[0]!.options[0]).toEqual({ id: 'o1', value: 'Open', color: 'propColorRed' })
  })

  it('renames an option in place without changing its id or colour', async () => {
    await mount()
    const field = document.body.querySelector<HTMLInputElement>(`input[aria-label="${t('project.props.option_value')}: Open"]`)
    expect(field, 'the option name is not editable').not.toBeNull()
    await act(async () => { setInput(field!, 'Backlog') })
    const save = [...document.body.querySelectorAll('button')].find((b) => b.textContent === t('common.save'))
    await act(async () => { save!.click() })
    const [draft] = onSave.mock.calls[0]!
    expect(draft[0]!.options[0]).toEqual({ id: 'o1', value: 'Backlog', color: '' })
  })

  it('names every property type in the interface language instead of the raw identifier', async () => {
    await mount()
    const options = [...document.body.querySelectorAll('select[aria-label]')].flatMap((select) => [...select.querySelectorAll('option')].map((option) => option.textContent))
    expect(options).toContain(t('project.prop.type.multiselect'))
    expect(options).not.toContain('multiSelect')
  })
})
