// @vitest-environment jsdom
/**
 * The context ring the two assistant headers wear.
 *
 * The ring exists because the app folds a thread's older turns into a summary without saying so, and the
 * control that *sets* the window has always been in the composer while the control that says how full it is
 * used to be drawn inside the box the reader writes in. What is pinned here is the half the reader has to be
 * able to trust: the number is counted from the turns actually loaded, the claim is the same sentence in the
 * tooltip, on the control's name and in the panel, and — the part that was issue 79 — a window nobody has
 * stated is reported as no window rather than as a budget of one, which used to print `189 / 1` and promise
 * the reader that their thread was nearly full when it had simply never been measured.
 *
 * jsdom lays nothing out, so no case here claims a size, a position or a colour: the assertions read the
 * values in the tree, the name a control carries, the words a hover and a keystroke are owed, and the dash
 * offset the reading writes — which is arithmetic on a viewBox, not a box.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, AssistantModel } from '@shared/assistant'
import { DEFAULT_ASSISTANT_SETTINGS, formatTokenStep } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { ContextUsageRing, contextRoom, threadTokens } from './ContextUsageMeter'
import { useAssistant } from './assistant-store'

type AssistantState = ReturnType<typeof useAssistant.getState>
const originalState = useAssistant.getState()

const LIMITS = DEFAULT_ASSISTANT_SETTINGS.limits

function model(over: Partial<AssistantModel> = {}): AssistantModel {
  return {
    id: 'm1', providerId: 'p1', model: 'deepseek-flash', label: 'DeepSeek Flash',
    temperature: 0.7, maxOutputTokens: 8_192, enabled: true, reasoning: 'auto', contextTokens: 65_536, vision: true,
    purpose: 'chat', kind: 'text', supportsTools: true, maxInputTokens: 57_344, modalities: [], topP: null,
    customParams: [], protocol: null, fallbackModelId: null, inputPrice: null, outputPrice: null, priceCurrency: '', pricePeriods: [],
    ...over,
  }
}

/** A model as a provider preset writes it: not one ceiling of its own, in any of the three fields. */
function presetModel(): AssistantModel {
  return model({ contextTokens: null, maxInputTokens: null, maxOutputTokens: null })
}

/**
 * A turn worth a stated number of tokens.
 *
 * The shared estimator takes four characters of a non-Han script for one token, so the fixture's price is
 * written down rather than run back through the function the ring runs it through.
 */
function message(tokens: number, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'a1', conversationId: 'c1', role: 'user', content: 'x'.repeat(tokens * 4), tools: [],
    status: 'complete', error: null, createdAt: 1, source: 'chat',
    ...overrides,
  }
}

let root: Root
let host: HTMLElement

const bar = () => document.body.querySelector<HTMLElement>('[role="progressbar"]')
const trigger = () => bar()?.closest('button') ?? null
const arc = () => document.body.querySelector<HTMLElement>('[data-context-arc]')
const panel = () => document.body.querySelector<HTMLElement>('[role="note"]')
const status = () => document.body.querySelector<HTMLElement>('[role="status"]')
const words = () => document.body.textContent ?? ''

function mount(over: Partial<AssistantState> = {}): void {
  // Wrapped: the ring left up by the previous case is subscribed, and it answers this write with a render.
  act(() => {
    useAssistant.setState({
      ...originalState,
      messages: [message(100), message(100), message(100)],
      messagesHasMore: false,
      messagesReady: true,
      settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'm1' },
      models: [model()],
      ...over,
    } as Partial<AssistantState>)
  })
  // Started from nothing each time, so a case never inherits the panel the one before it left open.
  act(() => { root.unmount() })
  root = createRoot(host)
  act(() => { root.render(createElement(ContextUsageRing)) })
}

async function press(node: Element | null, what: string): Promise<void> {
  expect(node, what).toBeTruthy()
  await act(async () => {
    node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/**
 * What a pointer is told when it arrives, and what a tab stop is told when it lands.
 *
 * `Tooltip` refuses to place a panel on an anchor it cannot measure, so the box is stated first — the same
 * stand-in the composer's own cases use. The keyboard half asks `:focus-visible` for the element under test
 * only, because that is the guard the component reads before it shows anything, and `focusin` is the event
 * React answers for `onFocus`. Each path ends by leaving again, which is how the panel is taken down by the
 * component rather than by the test pulling a portal's node out of the tree.
 */
function toldBy(node: HTMLElement | null, what: string, raise: (node: HTMLElement) => void, lower: (node: HTMLElement) => void): string | null {
  expect(node, what).toBeTruthy()
  node!.getBoundingClientRect = () => ({
    top: 10, left: 10, right: 38, bottom: 38, x: 10, y: 10, width: 28, height: 28, toJSON: () => ({}),
  }) as DOMRect
  vi.useFakeTimers()
  act(() => { raise(node!) })
  act(() => { vi.advanceTimersByTime(600) })
  const told = document.body.querySelector('[role="tooltip"]')?.textContent ?? null
  act(() => { lower(node!) })
  vi.useRealTimers()
  return told
}

const hover = (node: HTMLElement | null, what: string): string | null => toldBy(node, what,
  (target) => { target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) },
  (target) => { target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })

const focus = (node: HTMLElement | null, what: string): string | null => {
  const matches = node?.matches.bind(node) ?? null
  if (node && matches) node.matches = (selector: string) => (selector === ':focus-visible' ? true : matches(selector))
  const told = toldBy(node, what,
    (target) => { target.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) },
    (target) => { target.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
  if (node && matches) node.matches = matches
  return told
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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
  useAssistant.setState(originalState, true)
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('the ring over a window somebody stated', () => {
  // 57 344 tokens in, less the 8 192 the answer is allowed to take: 49 152, which is 48K.
  const ROOM = 49_152

  it('prices the loaded thread and fills the arc by that share', () => {
    mount()
    const used = threadTokens([message(100), message(100), message(100)])
    const percent = Math.min(100, Math.round((used / ROOM) * 100))
    expect(contextRoom(model(), LIMITS)).toBe(ROOM)
    expect(bar()?.getAttribute('aria-valuemin')).toBe('0')
    expect(bar()?.getAttribute('aria-valuemax')).toBe('100')
    expect(bar()?.getAttribute('aria-valuenow'), 'the reading is not on the progressbar').toBe(String(percent))
    expect(bar()?.getAttribute('aria-label')).toBe(t('assistant.context.meter_label'))
    expect(trigger()?.getAttribute('aria-label')).toBe(
      t('assistant.context.ring_summary', { used: formatTokenStep(used), limit: formatTokenStep(ROOM) }),
    )
    // The arc is the reading: a dash cut by the same share the number says.
    const drawn = arc()
    expect(drawn, 'a stated window draws no arc').toBeTruthy()
    const circumference = Number(drawn!.getAttribute('stroke-dasharray'))
    expect(Number(drawn!.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference * (1 - percent / 100), 6)
  })

  it('holds the claim to one sentence, told the same way by hover and by tab', () => {
    mount()
    const used = threadTokens([message(100), message(100), message(100)])
    const summary = t('assistant.context.ring_summary', { used: formatTokenStep(used), limit: formatTokenStep(ROOM) })
    for (const told of [hover(trigger(), 'the ring under a pointer'), focus(trigger(), 'the ring under a tab stop')]) {
      expect(told, 'the tooltip does not say the number').toContain(summary)
      expect(told, 'the tooltip does not say what is counted').toContain(t('assistant.context.meter_scope'))
    }
  })

  it('is the header control that opens the long half, and closes it again', async () => {
    mount()
    expect(panel(), 'the panel was drawn before anything was pressed').toBeNull()
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false')
    await press(trigger(), 'the ring is not drawn')
    expect(panel(), 'the press did not open the panel').toBeTruthy()
    expect(trigger()?.getAttribute('aria-expanded')).toBe('true')
    expect(trigger()?.getAttribute('aria-controls')).toBe(panel()!.id)
    expect(panel()!.textContent).toContain(t('assistant.context.meter_detail', {
      used: formatTokenStep(threadTokens([message(100), message(100), message(100)])),
      limit: formatTokenStep(ROOM),
      turns: 3,
    }))
    expect(panel()!.textContent).toContain(t('assistant.context.meter_scope'))
    await press(trigger(), 'the ring cannot be pressed twice')
    expect(panel(), 'a second press did not take the panel down').toBeNull()
  })

  it('takes the panel down on the keystroke that means close', async () => {
    mount()
    await press(trigger(), 'the ring is not drawn')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(panel(), 'Escape left the panel up').toBeNull()
  })

  it('says so when the thread it counted is only part of the thread', async () => {
    mount({ messagesHasMore: true })
    await press(trigger(), 'the ring is not drawn')
    expect(panel()?.textContent).toContain(t('assistant.context.meter_older'))
    mount({ messagesHasMore: false })
    await press(trigger(), 'the ring is not drawn')
    expect(panel()?.textContent, 'a whole thread was reported as a partial one').not.toContain(t('assistant.context.meter_older'))
  })

  it('warns as the thread nears the room it has, in words and not only in colour', async () => {
    // 804 of 1 000: past four fifths of what the thread was given.
    mount({ models: [model({ contextTokens: 1_000, maxInputTokens: 1_000, maxOutputTokens: 0 })], messages: [message(800)] })
    expect(status(), 'the warning is drawn before the panel is open').toBeNull()
    expect(trigger()?.getAttribute('aria-label')).toContain(t('assistant.context.ring_nearly_full'))
    await press(trigger(), 'the ring is not drawn')
    expect(status(), 'the fold is not said out loud').toBeTruthy()
    expect(status()!.textContent).toContain(t('assistant.context.meter_warning'))

    mount({ models: [model({ contextTokens: 1_000, maxInputTokens: 1_000, maxOutputTokens: 0 })], messages: [message(300)] })
    await press(trigger(), 'the ring is not drawn')
    expect(status(), 'a thread barely started was reported as near its limit').toBeNull()
    expect(words()).not.toContain(t('assistant.context.meter_warning'))
  })
})

describe('the ring over a window nobody stated (issue 79)', () => {
  /** The reading the deployment actually printed: one turn of 189 tokens, no ceiling anywhere. */
  const THREAD = [message(185)]

  it('refuses to print a fraction it invented', () => {
    mount({ models: [presetModel()] })
    expect(contextRoom(presetModel(), LIMITS), 'a window smaller than the reply is not a room').toBeNull()
    expect(bar()?.getAttribute('aria-valuenow'), 'an invented budget was announced as a reading').toBeNull()
    expect(bar()?.getAttribute('aria-valuetext')).toBeNull()
    expect(arc(), 'an unknown window was drawn as a filled ring').toBeNull()
    expect(trigger()?.getAttribute('aria-label')).toBe(t('assistant.context.ring_unknown'))
    // The `189 / 1` the guard value used to become, and the digits of the reading it dressed up.
    expect(words()).not.toContain('/ 1')
    expect(words()).not.toContain('189')
  })

  it('never calls an unmeasured thread nearly full', async () => {
    mount({ models: [presetModel()], messages: THREAD })
    expect(words()).not.toContain(t('assistant.context.ring_nearly_full'))
    await press(trigger(), 'the ring is not drawn')
    expect(status(), 'a thread that was never measured announced a fold').toBeNull()
    expect(words()).not.toContain(t('assistant.context.meter_warning'))
    expect(panel()?.textContent).toContain(t('assistant.context.ring_unknown_hint'))
    expect(panel()?.textContent, 'the panel names no way to set the window').toContain(t('assistant.context.ring_unknown_where'))
  })

  it('keeps the invented budget out of the tooltip too', () => {
    mount({ models: [presetModel()], messages: THREAD })
    const told = hover(trigger(), 'the ring under a pointer')
    expect(told).toContain(t('assistant.context.ring_unknown'))
    expect(told, 'the tooltip repeated the claim the control cannot make').not.toContain('189')
    expect(focus(trigger(), 'the ring under a tab stop')).toContain(t('assistant.context.ring_unknown'))
  })

  it('says nothing at all when there is no model to speak of', () => {
    mount({ models: [], settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: null } })
    expect(bar()).toBeNull()
    expect(trigger()).toBeNull()
  })
})

describe('what the count is made of', () => {
  it('charges a tool answer, because it rides back out on every later prompt', () => {
    const plain = message(100)
    const withTool = message(100, { tools: [{ id: 't1', name: 'search_notes', status: 'success', args: '{}', result: 'y'.repeat(400) }] })
    expect(threadTokens([plain])).toBe(104)
    expect(threadTokens([withTool])).toBe(204)
  })
})
