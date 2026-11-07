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