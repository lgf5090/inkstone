import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { SaveIndicator } from './SaveIndicator'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(async () => {
  await initI18n()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useNotes.setState({
    failedOutbox: [{
      id: 'patch:n1', clientId: 'client', writeId: 'w1', entity: 'note', entityId: 'n1',
      payload: { content: 'draft', rev: 1 }, attempts: 5, createdAt: 1, failed: true, lastError: 'invalid payload',
    }],
    notes: { n1: { id: 'n1', title: 'Failed note' } as never },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('SaveIndicator', () => {
  it('opens the visible sync issue list from the failure indicator', () => {
    act(() => root.render(createElement(SaveIndicator)))
    const trigger = container.querySelector('button')
    expect(trigger).not.toBeNull()
    act(() => trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Sync issues')
    expect(dialog?.textContent).toContain('Failed note')
    expect(dialog?.textContent).toContain('invalid payload')
  })
})
