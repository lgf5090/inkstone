import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectProperty, ProjectView } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { PropertiesModal, SortModal } from './ViewSettingsModals'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const properties: ProjectProperty[] = [
  { id: 'pt', name: 'Notes', type: 'text', options: [] },
  { id: 'ps', name: 'Status', type: 'select', options: [] },
]
const view: ProjectView = { id: 'v1', boardId: 'b1', title: 'V', viewType: 'table', fields: emptyProjectViewFields(), position: 0, ...stamps }

let viewEl: RenderedElement
beforeEach(async () => { await initI18n() })
afterEach(() => { viewEl?.unmount() })

function clickButton(label: string) {
  const button = [...document.body.querySelectorAll('button')].find((b) => b.textContent === label)
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
}

describe('view settings modals', () => {
  it('sort modal saves an added sort', async () => {
    const onPatch = vi.fn().mockResolvedValue(undefined)
    await act(async () => { viewEl = renderElement(createElement(SortModal, { view, properties, onClose: vi.fn(), onPatch })) })
    await act(async () => { clickButton(t('project.view.add_sort')) })
    await act(async () => { clickButton(t('common.save')) })
    expect(onPatch).toHaveBeenCalledWith({ sortOptions: [{ propertyId: 'pt', reversed: false }] })
  })

  it('properties modal saves the unchecked set', async () => {
    const onPatch = vi.fn().mockResolvedValue(undefined)
    await act(async () => { viewEl = renderElement(createElement(PropertiesModal, { view, properties, onClose: vi.fn(), onPatch })) })
    const checkbox = [...document.body.querySelectorAll('[role="checkbox"]')][0] as HTMLButtonElement
    await act(async () => { checkbox.click() })
    await act(async () => { clickButton(t('common.save')) })
    expect(onPatch).toHaveBeenCalledWith({ visiblePropertyIds: ['ps'] })
  })
})