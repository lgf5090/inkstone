// @vitest-environment jsdom
/**
 * The chip that says where a fact is recalled.
 *
 * A fact filed under a project is only recalled inside it, which is invisible from the memory page unless
 * the row says so — and the reader who wonders why the assistant forgot something is looking at exactly
 * this line. The names live on a slice another page loads, so the chip also pins that the page fetches
 * them: an id printed where a name belongs would be the failure this test exists to catch.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMemory } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { MemoryView } from './MemoryView'
import { useAssistant } from './assistant-store'

const PROJECT = '01m52yzp6y97z2xpgsd5p5e0k9'

const filed: AssistantMemory = {
  id: 'm1',
  content: 'The budget review is monthly',
  category: 'fact',
  source: 'assistant',
  status: 'active',
  supersededBy: null,
  validFrom: null,
  validUntil: null,
  projectId: PROJECT,
  noteId: null,
  createdAt: 1,
  updatedAt: 2,
}

const shared: AssistantMemory = {
  ...filed,
  id: 'm2',
  content: 'Prefers morning meetings',
  category: 'preference',
  projectId: null,
}

const original = useAssistant.getState()
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
  useAssistant.setState(original, true)
  vi.clearAllMocks()
})

async function show(state: Partial<ReturnType<typeof useAssistant.getState>>): Promise<void> {
  useAssistant.setState({
    ...original,
    memories: [],
    memoryCounts: { active: 0, historical: 0, review: 0 },
    memoryTotal: 0,
    memoryQuery: '',
    memoryStatus: 'all',
    reviews: [],
    projects: [],
    loadMemories: vi.fn(async () => {}),
    loadProjects: vi.fn(async () => {}),
    ...state,
  })
  await act(async () => { root.render(createElement(MemoryView)) })
}

const chips = () => [...document.body.querySelectorAll('[title]')]
  .filter((node) => node.getAttribute('title') === t('assistant.memory.in_project', { name: 'Client A' }))

describe('the memory page, on a fact filed under a project', () => {
  it('names the project it is recalled in', async () => {
    await show({
      memories: [filed],
      memoryTotal: 1,
      projects: [{ id: PROJECT, name: 'Client A', description: '', instructions: '', noteScope: [], modelId: null, createdAt: 1, updatedAt: 1 }],
    })
    expect(chips()).toHaveLength(1)
    expect(document.body.textContent).toContain('Client A')
  })

  it('loads the names when another page has not already', async () => {
    await show({ memories: [filed], memoryTotal: 1, projects: [] })
    // Without the request the chip would print an id, or nothing at all.
    expect(useAssistant.getState().loadProjects).toHaveBeenCalled()
  })

  it('leaves the account\'s own facts unlabelled', async () => {
    await show({
      memories: [shared],
      memoryTotal: 1,
      projects: [{ id: PROJECT, name: 'Client A', description: '', instructions: '', noteScope: [], modelId: null, createdAt: 1, updatedAt: 1 }],
    })
    // An account-wide fact is recalled everywhere, so a chip on it would be a claim about a restriction
    // that does not exist.
    expect(chips()).toHaveLength(0)
    expect(document.body.textContent).toContain('Prefers morning meetings')
  })
})
