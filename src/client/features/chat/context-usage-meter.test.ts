// @vitest-environment jsdom
/**
 * The context-usage meter beside the composer.
 *
 * The bar exists because the app folds a thread's older turns into a summary without saying so, and the
 * composer has always shown the control that *sets* the window and never one that says how full it is. What
 * is pinned is the half the reader has to be able to trust: the value is bounded, it is counted from the
 * turns actually loaded plus what is being typed, it says out loud what it cannot see, and the warning that
 * comes with it is drawn as text rather than left for a hover to reveal.
 */
import { createElement, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantLimits, AssistantMessage, AssistantModel } from '@shared/assistant'
import { DEFAULT_ASSISTANT_SETTINGS, estimateTokens, formatTokenStep } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { ContextUsageMeter, threadTokens } from './ContextUsageMeter'

/** A 10 000 token window with 2 000 of it kept for the answer, so the thread has 8 000. */
const LIMITS: AssistantLimits = { ...DEFAULT_ASSISTANT_SETTINGS.limits, maxContextTokens: 10_000, maxOutputTokens: 2_000 }
const ROOM = 8_000

function model(over: Partial<AssistantModel> = {}): AssistantModel {
  return {
    id: 'm1', providerId: 'p1', model: 'deepseek-flash', label: 'DeepSeek Flash',
    temperature: 0.7, maxOutputTokens: 2_000, enabled: true, reasoning: 'auto', contextTokens: 10_000, vision: true,
    purpose: 'chat', kind: 'text', supportsTools: true, maxInputTokens: null, modalities: [], topP: null,
    customParams: [], protocol: null, fallbackModelId: null, inputPrice: null, outputPrice: null, priceCurrency: '',
    ...over,
  }
}

/**
 * A turn worth 100 tokens.
 *
 * The shared estimator takes four characters of a non-Han script for one token, so 400 of them are exactly
 * 100 — a fixture whose price the test can state rather than one it has to run through the same function the
 * meter runs it through.
 */
function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'a1', conversationId: 'c1', role: 'user', content: 'x'.repeat(400), tools: [],
    status: 'complete', error: null, createdAt: 1, source: 'chat',
    ...overrides,
  }
}

let rendered: RenderedElement | null = null

const text = () => rendered!.container.textContent ?? ''
const bar = () => rendered!.container.querySelector('[role="progressbar"]')
const warn = () => rendered!.container.querySelector('[role="status"]')

/** Mounts the meter, replacing whatever the last case left up. */
function mount(props: Partial<ComponentProps<typeof ContextUsageMeter>> = {}): void {
  rendered?.unmount()
  rendered = renderElement(createElement(ContextUsageMeter, {
    messages: [],
    hasMore: false,
    draft: '',
    model: model(),
    limits: LIMITS,
    ...props,
  }))
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('the context meter', () => {
  it('prices the thread it can see, and never past the room it is measured against', () => {
    mount({ messages: [message(), message()], draft: 'y'.repeat(400) })
    const used = threadTokens([message(), message()]) + estimateTokens('y'.repeat(400))
    expect(bar()!.getAttribute('aria-valuenow')).toBe(String(Math.round((used / ROOM) * 100)))
    expect(text()).toContain(`${formatTokenStep(used)} / ${formatTokenStep(ROOM)}`)

    // Twelve 1 000-token turns are more than the thread can be given, and the reading is held at 100
    // rather than running on into double digits.
    mount({ messages: Array.from({ length: 12 }, (_unused, index) => message({ id: `m${index}`, content: 'x'.repeat(4_000) })) })
    expect(bar()!.getAttribute('aria-valuenow')).toBe('100')
    expect(bar()!.querySelector('span')!.getAttribute('style')).toContain('width: 100%')
  })

  it('says where its number comes from, and what it cannot see', () => {
    mount({ messages: [message(), message(), message()] })
    // The visible line is the short claim; the whole claim travels with the bar's own value.
    expect(text()).toContain(t('assistant.context.meter_scope'))
    const used = threadTokens([message(), message(), message()])
    expect(bar()!.getAttribute('aria-valuetext')).toBe(t('assistant.context.meter_detail', {
      used: formatTokenStep(used),
      limit: formatTokenStep(ROOM),
      turns: 3,
    }))
  })

  it('warns as the thread nears the room it has, without asking anyone to hover', () => {
    mount({ messages: [message(), message()] })
    expect(warn(), 'a thread barely started is not reported as near its limit').toBeNull()

    // 7 004 of 8 000 is past four fifths of what the thread can be given.
    mount({ messages: [message({ content: 'x'.repeat(28_000) })] })
    expect(bar()!.getAttribute('aria-valuenow')).toBe('88')
    expect(warn(), 'the warning is not in the document, so only a pointer could find it').toBeTruthy()
    expect(warn()!.textContent).toContain(t('assistant.context.meter_warning'))
  })

  it('says when the thread it counted is only part of the thread', () => {
    mount({ messages: [message()], hasMore: true })
    expect(text()).toContain(t('assistant.context.meter_older'))
    mount({ messages: [message()], hasMore: false })
    expect(text()).not.toContain(t('assistant.context.meter_older'))
  })

  it('takes the room its answer may spend out of the window first', () => {
    // A model that may write 8 000 tokens into a 10 000 window leaves 2 000 for the thread, and the bar is
    // measured against that rather than against a window the turn was never given.
    mount({ model: model({ maxOutputTokens: 8_000 }), messages: [message()] })
    expect(text()).toContain(`/ ${formatTokenStep(2_000)}`)
  })
})
