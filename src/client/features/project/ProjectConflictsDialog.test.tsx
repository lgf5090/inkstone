import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboxItem } from '../../lib/db'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { ProjectConflictsDialog } from './ProjectConflictsDialog'

let view: RenderedElement
const item: OutboxItem = {
  id: 'pw1', clientId: 'client', writeId: 'pw1', entity: 'project', entityId: 'b1',
  payload: { path: '/api/project/cards/c1', method: 'PATCH', body: { title: 'Local' } },
  attempts: 1, createdAt: 1, lastError: 'Card changed on another device', failed: true, conflict: true,
}
beforeEach(async () => { await initI18n() })
afterEach(() => { view?.unmount() })

describe('project write conflicts', () => {
  it('shows the rejected path and keeps discarding an explicit choice', async () => {
    const onDiscard = vi.fn()
    await act(async () => {
      view = renderElement(createElement(ProjectConflictsDialog, { items: [item], onDiscard, onClose: vi.fn() }))
    })
    expect(document.body.textContent).toContain('/api/project/cards/c1')
    expect(document.body.textContent).toContain('Card changed on another device')
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === t('project.offline.conflict_discard'))!.click() })
    expect(onDiscard).toHaveBeenCalledWith(item)
  })
})
