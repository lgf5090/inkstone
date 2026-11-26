import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectAutomation } from '@shared/project/automation'
import type { ProjectProperty } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { AutomationsDialog } from './AutomationsDialog'
import * as api from './api'

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  fetchProjectAutomations: vi.fn(),
  createProjectAutomation: vi.fn(),
  patchProjectAutomation: vi.fn(),
  deleteProjectAutomation: vi.fn(),
}))

const properties: ProjectProperty[] = [
  { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'done', value: 'Done', color: '', category: 'done' }] },
  { id: 'notes', name: 'Notes', type: 'text', options: [] },
]
let view: RenderedElement

beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(api.fetchProjectAutomations).mockResolvedValue([])
  await initI18n()
})

afterEach(() => { view?.unmount() })

describe('automation read states', () => {
  it('shows a retryable failure instead of an empty rule list', async () => {
    vi.mocked(api.fetchProjectAutomations).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce([])
    await act(async () => { view = renderElement(createElement(AutomationsDialog, { boardId: 'b1', properties, onClose: vi.fn() })) })
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(t('project.common.load_failed'))
    expect(document.body.textContent).not.toContain(t('project.automations.empty'))
    await act(async () => { [...document.body.querySelectorAll('button')].find((button) => button.textContent === t('project.common.retry'))!.click() })
    expect(api.fetchProjectAutomations).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain(t('project.automations.empty'))
  })
})

describe('automation property editors', () => {
  it('creates a rule from property and option selections instead of typed ids', async () => {
    const created: ProjectAutomation = {
      id: 'rule1', boardId: 'b1', trigger: { type: 'cardValueChanged' }, condition: null,
      action: { type: 'setValue', propertyId: 'ps', value: 'done' }, enabled: true,
      createdBy: 'u1', createdAt: 1, updatedAt: 1,
    }
    vi.mocked(api.createProjectAutomation).mockResolvedValue(created)
    await act(async () => {
      view = renderElement(createElement(AutomationsDialog, { boardId: 'b1', properties, onClose: vi.fn() }))
    })
    const property = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.automations.property')}"]`)!
    await act(async () => { property.click() })
    const status = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"], [role="menuitem"]')].find((button) => button.textContent === 'Status')!
    await act(async () => { status.click() })
    const value = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.automations.value')}"]`)!
    await act(async () => { value.click() })
    const done = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"], [role="menuitem"]')].find((button) => button.textContent === 'Done')!
    await act(async () => { done.click() })
    const add = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === t('project.automations.add'))!
    await act(async () => { add.click() })
    expect(api.createProjectAutomation).toHaveBeenCalledWith('b1', expect.objectContaining({
      action: { type: 'setValue', propertyId: 'ps', value: 'done' },
    }))
    expect(document.body.textContent).toContain('Status = Done')
  })
})
