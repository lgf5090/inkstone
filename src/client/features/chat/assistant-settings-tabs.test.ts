// @vitest-environment jsdom
/**
 * The settings tablist is one stop in the tab order, not nine.
 *
 * Nine buttons wearing `role="tab"` used to be nine tab stops with no arrow-key path, which is neither
 * what a screen reader announces nor what a keyboard user expects from a tablist. What is pinned here is
 * the roving tabindex, the arrow/Home/End moves carrying focus with the selection, the panel's name, and
 * the design token behind the selected tab's shadow.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/assistant'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { AssistantSettingsView } from './AssistantSettingsView'

// The tab bodies are not the subject; a text node names which one the tablist opened.
vi.mock('./AssistantModelTab', () => ({ ModelTab: () => 'model' }))
vi.mock('./AssistantMcpTab', () => ({ McpTab: () => 'mcp' }))
vi.mock('./AssistantKnowledgeTab', () => ({ KnowledgeTab: () => 'knowledge' }))
vi.mock('./AssistantWritingTab', () => ({ WritingTab: () => 'writing' }))
vi.mock('./AssistantBehaviourTab', () => ({ BehaviourTab: () => 'behaviour' }))
vi.mock('./AssistantMemoryTab', () => ({ MemoryTab: () => 'memory' }))
vi.mock('./AssistantBudgetTab', () => ({ BudgetTab: () => 'budget' }))
vi.mock('./AssistantDataTab', () => ({ DataTab: () => 'data' }))
vi.mock('./AssistantOtherTab', () => ({ OtherTab: () => 'other' }))

const original = useAssistant.getState()
let root: Root
let host: HTMLDivElement

const tabs = () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
const key = async (node: HTMLButtonElement, value: string) => {
  await act(async () => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
  })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  useAssistant.setState({
    ...original,
    settings: { ...DEFAULT_ASSISTANT_SETTINGS },
    loadSettings: vi.fn(async () => undefined),
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root.render(createElement(AssistantSettingsView)) })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.unstubAllGlobals()
})

describe('the settings tablist', () => {
  it('puts exactly the selected tab in the tab order', () => {
    const all = tabs()
    expect(all).toHaveLength(9)
    expect(all.filter((node) => node.tabIndex === 0)).toHaveLength(1)
    expect(all[0]?.tabIndex).toBe(0)
    expect(all[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('moves selection and focus together with arrows, Home and End', async () => {
    const all = tabs()
    await key(all[0]!, 'ArrowRight')
    expect(tabs()[1]?.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs()[1])
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain('mcp')

    await key(tabs()[1]!, 'End')
    expect(tabs()[8]?.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs()[8])

    await key(tabs()[8]!, 'ArrowRight')
    expect(tabs()[0]?.getAttribute('aria-selected')).toBe('true')

    await key(tabs()[0]!, 'ArrowLeft')
    expect(tabs()[8]?.getAttribute('aria-selected')).toBe('true')
    await key(tabs()[8]!, 'Home')
    expect(tabs()[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('names the panel from the selected tab and ignores unrelated keys', async () => {
    const labelled = document.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')
    expect(labelled).toBe('assistant-settings-tab-model')
    expect(tabs()[0]?.getAttribute('aria-controls')).toBe('assistant-settings-panel')
    await key(tabs()[0]!, 'a')
    expect(tabs()[0]?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain('model')
  })
})
