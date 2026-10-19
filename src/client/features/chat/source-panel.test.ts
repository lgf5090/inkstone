// @vitest-environment jsdom
/**
 * The readable list behind the source chips.
 *
 * It is a rendering of what the turn stored: a web source keeps its link and excerpt, a note source keeps
 * its note id and opens the notebook rather than a url. Nothing here fetches anything.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { SourcePanel } from './SourcePanel'

let root: Root
let host: HTMLElement

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('the source panel', () => {
  it('renders a web source, its excerpt and a note source', () => {
    act(() => root.render(createElement(SourcePanel, {
      onClose: vi.fn(),
      sources: [
        { url: 'https://example.com/plan', title: 'The plan', cited: 'A quoted passage.', kind: 'web' },
        { url: 'inkstone://note/01hzzzzzzzzzzzzzzzzzzzzz01', title: 'My note', kind: 'note', id: '01hzzzzzzzzzzzzzzzzzzzzz01' },
      ],
    })))
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog, 'the panel is not a dialog').toBeTruthy()
    expect(dialog!.textContent).toContain(t('assistant.chat.sources'))
    expect(dialog!.textContent).toContain('The plan')
    expect(dialog!.textContent).toContain('A quoted passage.')
    expect(dialog!.textContent).toContain('My note')
    expect(dialog!.textContent).toContain(t('assistant.chat.source_note'))
    const link = dialog!.querySelector<HTMLAnchorElement>('a[href="https://example.com/plan"]')
    expect(link?.rel).toContain('noreferrer')
    // The note is a button, not a link: the notebook opens by id.
    expect(dialog!.querySelector('a[href^="inkstone://"]')).toBeNull()
  })
})
