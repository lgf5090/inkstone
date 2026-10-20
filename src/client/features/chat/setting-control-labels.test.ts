// @vitest-environment jsdom
/**
 * The name a reader hears for one control in settings (UI2-16).
 *
 * A settings row's title is the only words belonging to the number box or the select beside it. Until the
 * title was tied to the control by association, a screen reader announced "combo box" or "edit text" with
 * nothing to say which setting it was holding — eleven controls across the assistant's own tabs, and a
 * `label for` that pointed at a wrapper div, or at no element at all, in every `Field` drawn around a box
 * rather than a bare input.
 *
 * What is pinned is the name as a reader gets it: `aria-labelledby`, else `aria-label`, else the `<label>`
 * whose `for` names the control — computed here rather than read off one attribute, because the point is the
 * association and not where the words were written.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, LIMIT_RANGES } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { BehaviourTab } from './AssistantBehaviourTab'
import { BudgetTab } from './AssistantBudgetTab'
import { McpTab } from './AssistantMcpTab'
import { ModelEditorDialog } from './ModelEditorDialog'
import type { AssistantLimits, AssistantModel, AssistantProvider } from '@shared/assistant'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    assistant: {
      usage: vi.fn(async () => ({ today: { requests: 1, inputTokens: 1, outputTokens: 1, toolCalls: 0, scheduledRuns: 0 }, last7Days: { requests: 1, errors: 0 } })),
      providerKeys: vi.fn(async () => ({ keys: [] })),
      mcpServers: vi.fn(async () => ({ servers: [] })),
      mcpTools: vi.fn(async () => ({ servers: [], problems: [] })),
    },
    files: { upload: vi.fn(async () => ({ url: '', filename: '', mime: '' })) },
  },
}))

/** The seven limits the budget tab edits, in the order its own rows draw them. */
const LIMIT_KEYS: (keyof AssistantLimits)[] = Object.keys(LIMIT_RANGES) as (keyof AssistantLimits)[]
/** The words each limit row titles itself with — read after the catalog is loaded, not at import. */
const limitLabel: Partial<Record<keyof AssistantLimits, () => string>> = {
  maxContextTokens: () => t('assistant.settings.limit.context'),
  maxInputTokens: () => t('assistant.settings.limit.input'),
  maxOutputTokens: () => t('assistant.settings.limit.output'),
  maxToolCalls: () => t('assistant.settings.limit.tools'),
  maxAgentSteps: () => t('assistant.settings.limit.steps'),
  maxRequestsPerDay: () => t('assistant.settings.limit.requests'),
  maxScheduledRunsPerDay: () => t('assistant.settings.limit.scheduled'),
}

const MODEL: AssistantModel = {
  id: 'm1', providerId: 'p1', model: 'deepseek-flash', label: 'DeepSeek Flash', temperature: 0.7,
  maxOutputTokens: 8192, enabled: true, reasoning: 'auto', contextTokens: null, vision: true, purpose: 'chat',
  kind: 'text', supportsTools: true, maxInputTokens: null, modalities: [], topP: null, customParams: [],
  protocol: null, fallbackModelId: null, inputPrice: null, outputPrice: null, priceCurrency: '', pricePeriods: [],
}
const PROVIDER: AssistantProvider = {
  id: 'p1', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', endpoints: {},
  hasKey: true, keyHint: 'abcd', reasoningDialect: null, createdAt: 1, updatedAt: 1,
}

/** The elements a reader can be told the name of, as opposed to the containers that hold them. */
const CONTROL_SELECTOR = 'input, select, textarea, button, [role="switch"]'

/**
 * What a screen reader is handed for one element, in the order the platform resolves it.
 *
 * A name computed rather than read from one attribute: the defect was a missing association, so a check
 * that only looked at `aria-label` would have passed the very rows this file exists to catch.
 */
function nameOf(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    return labelledBy.split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim()
  }
  const label = el.getAttribute('aria-label')
  if (label) return label.trim()
  const id = el.getAttribute('id')
  if (id) {
    const forLabel = [...document.querySelectorAll<HTMLLabelElement>('label[for]')].find((node) => node.htmlFor === id)
    if (forLabel) return forLabel.textContent?.trim() ?? ''
  }
  const wrapping = el.closest('label')
  if (wrapping) return wrapping.textContent?.trim() ?? ''
  // Only a button says its own name with its contents; an empty select's options are not its label.
  return el.tagName === 'BUTTON' ? (el.textContent?.trim() ?? '') : ''
}

/** The control a reader would reach by naming it. */
function named(name: string): Element | null {
  return [...document.querySelectorAll(CONTROL_SELECTOR)].find((el) => nameOf(el) === name) ?? null
}

/** Every `<label for>` whose target is missing — the association a reader gets nothing from. */
function orphanLabels(): string[] {
  return [...document.querySelectorAll<HTMLLabelElement>('label[for]')]
    .filter((node) => !node.htmlFor || !document.getElementById(node.htmlFor))
    .map((node) => `${node.textContent?.trim()} → for="${node.htmlFor}"`)
}

const original = useAssistant.getState()
let rendered: RenderedElement | null = null

const click = (node: Element | null | undefined, name: string) => {
  expect(node, `${name} is not rendered`).toBeTruthy()
  act(() => { node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

beforeEach(async () => {
  await initI18n()
  useAssistant.setState({
    ...original,
    providers: [],
    models: [],
    mcpServers: [],
    mcpCatalog: [],
    mcpProblems: [],
    saveSettings: async () => {},
    loadMcp: async () => {},
    addMcpServer: async () => true,
    patchMcpServer: async () => true,
    loadMcpServer: async () => null,
  })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.clearAllMocks()
})

describe('the assistant behaviour tab', () => {
  beforeEach(() => {
    rendered = renderElement(createElement(BehaviourTab, { settings: DEFAULT_ASSISTANT_SETTINGS }))
  })

  it('names the machine-name box, the timezone and the start view by their row titles', () => {
    expect(named(t('assistant.settings.agent_name'))?.tagName, 'the assistant name box has no accessible name').toBe('INPUT')
    expect(named(t('assistant.settings.timezone'))?.tagName, 'the timezone select has no accessible name').toBe('SELECT')
    expect(named(t('assistant.settings.start_view'))?.tagName, 'the start view select has no accessible name').toBe('SELECT')
  })

  it('leaves no row title pointing at a control that is not there', () => {
    expect(orphanLabels()).toEqual([])
  })
})

describe('the budget tab', () => {
  beforeEach(async () => {
    rendered = renderElement(createElement(BudgetTab, { settings: DEFAULT_ASSISTANT_SETTINGS }))
    // The tab asks for its usage numbers when it mounts; let that answer land before the rows are read.
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
  })

  it('names every limit box with the setting it holds', () => {
    // Seven rows, one number each: the count is what makes a silent drop impossible. The eighth limit range
    // is not a row on this tab, so the list is the rows the reader actually sees.
    const rows = LIMIT_KEYS.filter((key) => limitLabel[key])
    expect(rows).toHaveLength(7)
    for (const key of rows) {
      const label = limitLabel[key]!()
      const control = named(label)
      expect(control, `${label} has no control answering to its name`).toBeTruthy()
      expect(control!.tagName).toBe('INPUT')
      expect(control!.getAttribute('type')).toBe('number')
    }
  })

  it('gives each box the id its title points at', () => {
    for (const key of LIMIT_KEYS.filter((entry) => limitLabel[entry])) {
      const control = named(limitLabel[key]!())!
      const forLabel = [...document.querySelectorAll<HTMLLabelElement>('label[for]')].find((node) => node.htmlFor === control.id)
      expect(forLabel, `${limitLabel[key]!()} is named without a label element pointing at it`).toBeTruthy()
    }
  })

  it('leaves no limit title pointing at a control that is not there', () => {
    expect(orphanLabels()).toEqual([])
  })

  it('offers the context ceiling the same picks as the model editor', () => {
    // The small windows are the point: the default is 6000 and a reader who wants 32K used to find no button
    // for it on this tab, because the tab drew a ladder that started at 128K.
    const groups = [...document.body.querySelectorAll<HTMLElement>('[role="group"][aria-label]')]
    const labels = (name: string) => groups.filter((node) => node.getAttribute('aria-label') === name)
      .flatMap((node) => [...node.querySelectorAll<HTMLElement>('button[aria-pressed]')].map((chip) => chip.textContent?.trim()))
    const context = labels(t('assistant.settings.limit.context'))
    expect(context).toContain('32K')
    expect(context).toEqual(labels(t('assistant.settings.limit.input')))
  })
})

describe('the server form’s timeout', () => {
  /** Open the add menu, take quick create, and unfold the section the timeout lives in. */
  function openTimeout() {
    click(document.body.querySelector('button[aria-haspopup="menu"]'), 'the add button')
    click([...document.body.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(t('assistant.mcp.add.quick'))), 'the quick-create row')
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog, 'the server form did not open').toBeTruthy()
    click([...dialog!.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(t('assistant.mcp.advanced'))), 'the advanced door')
  }

  beforeEach(() => {
    rendered = renderElement(createElement(McpTab))
    openTimeout()
  })

  it('names the seconds box, whose row holds a unit and a test button beside it', () => {
    const control = named(t('assistant.mcp.timeout'))
    expect(control, 'the timeout box has no accessible name').toBeTruthy()
    expect(control!.tagName).toBe('INPUT')
  })

  it('names the box’s own group with the field label, and leaves no dangling for', () => {
    const control = named(t('assistant.mcp.timeout'))!
    const group = control.closest('[role="group"]')
    expect(group, 'the timeout field is not a labelled group').toBeTruthy()
    expect(nameOf(group!)).toBe(t('assistant.mcp.timeout'))
    expect(orphanLabels()).toEqual([])
  })
})

describe('the model editor’s token fields', () => {
  beforeEach(() => {
    rendered = renderElement(createElement(ModelEditorDialog, {
      model: MODEL,
      provider: PROVIDER,
      models: [],
      limits: DEFAULT_ASSISTANT_SETTINGS.limits,
      timezone: 'UTC',
      onClose: () => undefined,
      onSave: async () => true,
    }))
    click([...document.body.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(t('assistant.model.more'))), 'the more-settings door')
  })

  it('names the number box and the preset row of each of the three token fields', () => {
    for (const label of [t('assistant.model.context'), t('assistant.model.max_input'), t('assistant.model.max_output')]) {
      const control = named(label)
      expect(control, `${label} has no control answering to its name`).toBeTruthy()
      expect(control!.tagName).toBe('INPUT')
    }
  })

  it('labels the box that holds a field with the field’s own title instead of a dangling for', () => {
    const control = named(t('assistant.model.context'))!
    const group = control.closest('[role="group"]')
    expect(group, 'the context box is not a named group').toBeTruthy()
    expect(nameOf(group!)).toBe(t('assistant.model.context'))
    expect(orphanLabels()).toEqual([])
  })
})
