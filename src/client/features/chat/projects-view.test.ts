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
import { MAX_PROJECT_NOTES, type AssistantModel, type Project } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
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
    // The named-notes picker searches the vault the same way the composer's does.
    search: vi.fn(async () => ({ results: [] })),
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
    noteIds: [],
    modelId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

const original = useAssistant.getState()
const notesOriginal = useNotes.getState()
let root: Root
let host: HTMLElement
let mounted = false

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byLabel = (text: string) => buttons().find((node) => node.textContent?.trim() === text)
const byName = (name: string) => buttons().find((node) => (node.getAttribute('aria-label') ?? '') === name)
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
  useNotes.setState(notesOriginal, true)
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

describe('the pages a project names by hand', () => {
  beforeEach(() => {
    useNotes.setState({ ...notesOriginal, notes: { n1: { id: 'n1', title: 'Quarterly plan' } as never } })
  })

  it('shows each named page by title and saves the list minus the one taken off', async () => {
    await open({ noteIds: ['n1', 'n2'] })
    click(byLabel(t('common.edit')))
    expect(document.body.textContent).toContain('Quarterly plan')
    // A page the vault no longer holds keeps its id on the chip: the row names what the project reads, and
    // hiding one would show a selection that is not the one that saves.
    expect(document.body.textContent).toContain('n2')
    click(byName(t('assistant.projects.note_drop', { name: 'Quarterly plan' })))
    click(byLabel(t('common.save')))
    await act(async () => { await Promise.resolve() })
    expect(mocks.updateProject).toHaveBeenCalledWith('p1', expect.objectContaining({ noteIds: ['n2'] }))
  })

  it('reaches the vault search from the add button', async () => {
    // Without this the column would be saved and read by the server while no screen could fill it — the
    // shape of defect that has already bitten this module twice.
    await open()
    click(byLabel(t('common.edit')))
    click(byLabel(t('assistant.projects.note_add')))
    expect(document.querySelector('[role="combobox"]'), 'the add button opens nothing').toBeTruthy()
  })

  it('says in text when the project has named all it may', async () => {
    await open({ noteIds: Array.from({ length: MAX_PROJECT_NOTES }, (_entry, index) => `n${index}`) })
    click(byLabel(t('common.edit')))
    const add = byLabel(t('assistant.projects.note_add'))
    expect(add?.hasAttribute('disabled'), 'the button stayed pressable past the cap').toBe(true)
    expect(document.body.textContent).toContain(t('assistant.projects.notes_full', { count: MAX_PROJECT_NOTES }))
  })
})
