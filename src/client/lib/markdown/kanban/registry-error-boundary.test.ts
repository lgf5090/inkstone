import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { initI18n } from '../../i18n'
import { installTestGlobals } from '../../test-render'
import { registerFenceBodies } from '../fence-bodies'
import { renderMarkdown } from '../renderer'
import { destroyKanbans, mountKanbans } from './index'

let boomOnRender = true

vi.mock('./ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui')>()
  return {
    ...actual,
    KanbanRoot: () => {
      if (boomOnRender) throw new Error('injected board failure')
      return createElement('div', { 'data-board': 'alive' })
    },
  }
})

const SCOPE = 'kanban-boundary-test'

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
  const rendered = renderMarkdown(
    ['# Title', '', '```kanban', '## To Do', '- [ ] First Task', '```'].join('\n'),
  )
  host.innerHTML = rendered.html
  registerFenceBodies(host, rendered.fences)
  document.body.append(host)
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await act(async () => {
      await mountKanbans(host, { scope: SCOPE, noteId: 'note-1', editable: true })
    })
  } finally {
    errors.mockRestore()
  }
  return host
}

describe('kanban instance error boundary', () => {
  it('shows the fence source with a prompt when the board throws while rendering', async () => {
    boomOnRender = true
    const host = await mountBoard()
    const errorBlock = host.querySelector('.kanban-error')
    expect(errorBlock).toBeTruthy()
    expect(errorBlock?.textContent).toContain('First Task')
  })

  it('renders the healthy board when nothing throws', async () => {
    boomOnRender = false
    const host = await mountBoard()
    expect(host.querySelector('[data-board="alive"]')).toBeTruthy()
    expect(host.querySelector('.kanban-error')).toBeNull()
  })
})
