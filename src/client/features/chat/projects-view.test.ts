// @vitest-environment jsdom
/**
 * The projects screen: the standing brief, its knowledge folders, and the model it answers with.
 *
 * A project's whole point is that everything inside it is answered the same way, so what is pinned here is
 * that the three standing choices actually reach the server — a field the editor draws but the save body
 * forgets is a setting that silently reverts on the next open — and that the card hands the reader over to
 * the conversations it governs rather than keeping a second list of them.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantModel, Project } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { ProjectsView } from './ProjectsView'
import { useAssistant } from './assistant-store'

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(async () => ({ project: {} })),
  updateProject: vi.fn(async () => ({ project: {} })),
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    assistant: {
      createProject: mocks.createProject,
      updateProject: mocks.updateProject,
      deleteProject: vi.fn(async () => ({ ok: true })),
      setConversationProject: vi.fn(async () => ({ conversation: {} })),
    },
    // The knowledge picker reads the notebook's own folder tree; empty is enough for a form test.
    folders: { list: vi.fn(async () => ({ folders: [] })) },
  },
}))

const MODEL = { id: 'm1', label: 'Fast model' } as unknown as AssistantModel

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Handbook',
    description: '',
    instructions: 'Be terse.',
    noteScope: [],
    modelId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

const original = useAssistant.getState()
let root: Root
let host: HTMLElement
let mounted = false

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byLabel = (text: string) => buttons().find((node) => node.textContent?.trim() === text)
const click = (node: HTMLElement | undefined) => {
  expect(node, 'the control is not rendered').toBeTruthy()
  act(() => { node!.click() })
}

async function open(over: Partial<Project> = {}) {
  mounted = true
  useAssistant.setState({
    ...original,
    projects: [project(over)],
    models: [MODEL],
    conversations: [],
    loadProjects: vi.fn(async () => undefined),
    bootstrap: vi.fn(async () => undefined),
    setProjectFilter: vi.fn(async () => undefined),
    setView: vi.fn(),
  })
  await act(async () => { root.render(createElement(ProjectsView)) })
  // The list arrives from the mount effect; one microtask turn is enough for a stubbed loader.
  await act(async () => { await Promise.resolve() })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mounted = false
  mocks.createProject.mockClear()
  mocks.updateProject.mockClear()
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.clearAllMocks()
})

describe('the project editor', () => {
  it('sends the preferred model along with the brief and the folders', async () => {
    await open()
    click(byLabel(t('common.edit')))
    const select = document.body.querySelector<HTMLSelectElement>(`select[aria-label="${t('assistant.projects.model')}"]`)
    expect(select, 'the model picker is not rendered').toBeTruthy()
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, 'm1')
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    click(byLabel(t('common.save')))
    await act(async () => { await Promise.resolve() })
    expect(mocks.updateProject).toHaveBeenCalledWith('p1', expect.objectContaining({ modelId: 'm1' }))
  })

  it('leaves the model alone when the reader keeps the account default', async () => {
    await open()
    click(byLabel(t('common.edit')))
    click(byLabel(t('common.save')))
    await act(async () => { await Promise.resolve() })
    // Null, not undefined: the route reads null as "the project has no preferred model", and undefined as
    // "the client did not say" — the second would leave a stale choice in place after the reader cleared it.
    expect(mocks.updateProject).toHaveBeenCalledWith('p1', expect.objectContaining({ modelId: null }))
  })
})

describe('the project card', () => {
  it('names the model it answers with', async () => {
    await open({ modelId: 'm1' })
    expect(document.body.textContent).toContain(t('assistant.projects.model_uses', { model: 'Fast model' }))
  })

  it('hands the reader over to the conversations the brief governs', async () => {
    await open()
    click(byLabel(t('assistant.projects.open_conversations')))
    await act(async () => { await Promise.resolve() })
    expect(useAssistant.getState().setProjectFilter).toHaveBeenCalledWith('p1')
    expect(useAssistant.getState().setView).toHaveBeenCalledWith('chat')
  })
})
