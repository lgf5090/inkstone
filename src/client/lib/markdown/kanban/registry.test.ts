/**
 * Every kanban block in the preview is a React root of its own, living inside markup React did not
 * make, and those roots are torn down from the host tree's own effects: the pane goes away, or the
 * block leaves the note. A root may not be taken down from inside another root's commit — React
 * says so out loud ("Attempted to synchronously unmount a root while React was already rendering")
 * and then lets the teardown race the commit it interrupted. The unmount is deferred by a
 * microtask, and these cases are what hold it there: the board is still painted when the call
 * returns, and it is gone a microtask later, with no warning raised from inside a commit.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement, useEffect } from 'react'
import { initI18n } from '../../i18n'
import { installTestGlobals, renderElement } from '../../test-render'
import { renderMarkdown } from '../renderer'
import { destroyKanbans, mountKanbans } from './index'

const SCOPE = 'kanban-registry-test'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  destroyKanbans(SCOPE)
  document.body.replaceChildren()
})

async function mountBoard(): Promise<HTMLElement> {
  const host = document.createElement('div')
  host.className = 'ink-prose'
  host.innerHTML = renderMarkdown(
    ['# Title', '', '```kanban', '## To Do', '- [ ] First Task', '```'].join('\n'),
  ).html
  document.body.append(host)
  await act(async () => {
    await mountKanbans(host, {
      scope: SCOPE,
      noteId: 'note-1',
      editable: true,
    })
  })
  return host
}

function canvasOf(host: HTMLElement): HTMLElement {
  const canvas = host.querySelector<HTMLElement>('[data-kanban-canvas]')
  if (!canvas) throw new Error('the kanban block mounted no canvas to draw into')
  return canvas
}

/** The preview's own shape: the teardown runs from the cleaning-up side of the host root's commit. */
function TearDownOnUnmount() {
  useEffect(() => () => destroyKanbans(SCOPE), [])
  return null
}

describe('the kanban registry teardown', () => {
  it('leaves the board painted until the microtask after the call', async () => {
    const host = await mountBoard()
    const canvas = canvasOf(host)
    expect(canvas.children.length).toBeGreaterThan(0)

    await act(async () => {
      destroyKanbans(SCOPE)
      expect(canvas.children.length).toBeGreaterThan(0)
    })
    expect(canvas.children.length).toBe(0)
  })

  it('takes the board down without warning when a commit is the one asking', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = await mountBoard()
    const canvas = canvasOf(host)
    const view = renderElement(createElement(TearDownOnUnmount))

    view.unmount()
    // The deferred unmount is React work of its own, so it is flushed before anything is read.
    await act(async () => {})
    const logged = errors.mock.calls.map((call) => String(call[0])).join('\n')
    errors.mockRestore()
    expect(logged).not.toContain('synchronously unmount')
    expect(canvas.children.length).toBe(0)
  })
})
