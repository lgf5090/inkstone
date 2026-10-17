// @vitest-environment jsdom
/**
 * The model list is one choice between several, and it has to say so (UI2-17).
 *
 * Every row already carried `role="radio"`, but with no group around them a reader heard a row of radios
 * belonging to nothing — no name for the set, no "1 of 3", and one Tab stop per model, so walking ten models
 * took ten presses. The group, its name, the single tab stop and the arrows that move the choice are what a
 * `radiogroup` promises, and `useRovingRadio` is the helper the segmented control already uses for them.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantModel, type AssistantProvider, type AssistantSettings } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { ModelTab } from './AssistantModelTab'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    assistant: {
      providerKeys: vi.fn(async () => ({ keys: [] })),
      usage: vi.fn(async () => ({ today: {}, last7Days: {} })),
    },
    files: { upload: vi.fn(async () => ({ url: '', filename: '', mime: '' })) },
  },
}))

const PROVIDER: AssistantProvider = {
  id: 'p1', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', endpoints: {},
  hasKey: true, keyHint: 'abcd', reasoningDialect: null, createdAt: 1, updatedAt: 1,
}

function model(id: string, label: string): AssistantModel {
  return {
    id, providerId: PROVIDER.id, model: `${id}-upstream`, label, temperature: 0.7, maxOutputTokens: 8192,
    enabled: true, reasoning: 'auto', contextTokens: null, vision: true, purpose: 'chat', kind: 'text',
    supportsTools: true, maxInputTokens: null, modalities: [], topP: null, customParams: [], protocol: null,
    fallbackModelId: null, inputPrice: null, outputPrice: null, priceCurrency: '',
  }
}

const MODELS = [model('m1', 'Alpha'), model('m2', 'Beta'), model('m3', 'Gamma')]

let activate: Mock<(id: string) => Promise<void>>
let rendered: RenderedElement | null = null
const original = useAssistant.getState()

const group = () => document.body.querySelector<HTMLElement>('[role="radiogroup"]')
const radios = () => [...(group()?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])]
/** One arrow press, the way the keyboard sends it: a bubbling keydown on the focused radio. */
function pressKey(node: HTMLElement, key: string) {
  act(() => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

beforeEach(async () => {
  await initI18n()
  activate = vi.fn(async () => undefined)
  useAssistant.setState({
    ...original,
    providers: [PROVIDER],
    models: MODELS,
    activateModel: activate,
    updateModel: async () => true,
    removeModel: async () => undefined,
    removeProvider: async () => undefined,
    saveSettings: async () => undefined,
    addModel: async () => true,
  })
  rendered = renderElement(createElement(ModelTab, {
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'm2' } as AssistantSettings,
  }))
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.clearAllMocks()
})

describe('the model list as a radio group', () => {
  it('puts its radios inside a group named by the provider they belong to', () => {
    const node = group()
    expect(node, 'the model rows are not inside a radiogroup').toBeTruthy()
    const labelledBy = node!.getAttribute('aria-labelledby')
    expect(labelledBy, 'the radiogroup has no name of its own').toBeTruthy()
    expect(document.getElementById(labelledBy!)?.textContent?.trim()).toBe(PROVIDER.label)
    expect(radios()).toHaveLength(MODELS.length)
    expect(radios().filter((radio) => radio.getAttribute('aria-checked') === 'true')).toHaveLength(1)
  })

  it('keeps exactly one of the models in the tab order, on the answer the reader has', () => {
    const stops = radios().filter((radio) => radio.getAttribute('tabindex') === '0')
    expect(stops, 'no model radio is a tab stop').toHaveLength(1)
    expect(stops[0]!.getAttribute('aria-checked')).toBe('true')
    expect(stops[0]!.textContent).toContain('Beta')
    expect(radios().filter((radio) => radio.getAttribute('tabindex') === '-1')).toHaveLength(2)
  })

  it('moves the choice with the arrows, and lands the focus where the choice went', () => {
    const active = radios().find((radio) => radio.getAttribute('aria-checked') === 'true')!
    pressKey(active, 'ArrowDown')
    expect(activate).toHaveBeenLastCalledWith('m3')
    expect(document.activeElement).toBe(radios()[2])
    pressKey(active, 'ArrowUp')
    expect(activate).toHaveBeenLastCalledWith('m1')
    // Wrapping, so the first model's ArrowUp is not a dead key: the focus is now on Alpha itself.
    expect(document.activeElement).toBe(radios()[0])
    pressKey(radios()[0], 'ArrowUp')
    expect(activate).toHaveBeenLastCalledWith('m3')
  })

  it('still activates the model a pointer is aimed at', () => {
    act(() => { radios()[0].click() })
    expect(activate).toHaveBeenCalledWith('m1')
  })

  it('leaves the capability switches and the editor buttons out of the group’s own choice', () => {
    // The row holds four toggles and two buttons beside its radio; only the radio is the choice between
    // models, so the group must not read as seven radios.
    expect(group()!.querySelectorAll('[role="radio"]')).toHaveLength(MODELS.length)
    expect(group()!.querySelectorAll('[aria-label]')).toBeTruthy()
    expect(document.body.textContent).toContain(t('assistant.settings.providers'))
  })
})
