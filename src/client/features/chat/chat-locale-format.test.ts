// @vitest-environment jsdom
/**
 * Numbers and clocks written in the reader's own notation.
 *
 * The rest of this container already asks the assistant's configured timezone and the interface's own
 * locale, and two places in a reply did not: a token count spelled with a hardcoded `en-US`, and the date
 * stamped on an answer the reader paged back to, written with the machine's zone. On a machine set to
 * another zone the version's clock and the thread's clock disagreed by hours, which is the one thing a
 * version comparison is supposed to tell apart.
 *
 * A grouping rule is hard to see from the output alone — this app ships two locales and both write a comma
 * — so the number case reads which tag the formatter was asked for rather than the digits it produced.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantAnswerVersion } from '@shared/assistant'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/assistant'
import { getLocale, initI18n, setLocaleAsync, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { answerStats, AssistantBubble } from './MessageParts'
import { full } from './usage-format'
import { formatInZone } from './time-format'
import { useAssistant } from './assistant-store'

const original = useAssistant.getState()
const CREATED_AT = Date.UTC(2026, 9, 16, 3, 30, 0)
const ZONE = 'Pacific/Honolulu'

let root: Root
let host: HTMLElement

const byName = (name: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
  .find((node) => (node.getAttribute('aria-label') ?? node.textContent ?? '').includes(name))

function version(over: Partial<AssistantAnswerVersion> = {}): AssistantAnswerVersion {
  return {
    id: 'v1',
    messageId: 'm1',
    conversationId: 'c1',
    content: 'the older answer',
    reasoning: '',
    tools: [],
    modelLabel: 'deepseek-chat',
    usage: null,
    durationMs: 900,
    createdAt: CREATED_AT,
    ...over,
  }
}

/**
 * Which locale tag a run asked `Intl.NumberFormat` for.
 *
 * A hardcoded `en-US` and a locale the interface actually speaks print the same digits for both of this
 * app's languages, so the digits prove nothing — but the tag the formatter was handed does.
 */
function tagsSeenWhile<T>(run: () => T): { result: T, tags: unknown[] } {
  const tags: unknown[] = []
  const Real = Intl.NumberFormat
  const Stub = function (this: unknown, ...args: unknown[]) {
    tags.push(args[0])
    return Reflect.construct(Real, args as never)
  } as unknown as typeof Intl.NumberFormat
  Object.defineProperty(Intl, 'NumberFormat', { value: Stub, configurable: true, writable: true })
  try {
    return { result: run(), tags }
  } finally {
    Object.defineProperty(Intl, 'NumberFormat', { value: Real, configurable: true, writable: true })
  }
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useAssistant.setState({ settings: { ...DEFAULT_ASSISTANT_SETTINGS, timezone: ZONE } })
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
})

describe('the answer that was displaced', () => {
  it('is dated in the assistant\'s zone, the same clock as the live row', async () => {
    const loadVersions = vi.fn<() => Promise<AssistantAnswerVersion[]>>(async () => [version(), version({ id: 'v2' })])
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => {
      root.render(createElement(AssistantBubble, {
        text: 'The newest answer.',
        reasoning: '',
        tools: [],
        error: null,
        streaming: false,
        messageId: 'm1',
        versionCount: 3,
        loadVersions,
      }))
    })
    await act(async () => {
      byName(t('assistant.chat.previous'))!.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const expected = formatInZone(CREATED_AT, ZONE)
    expect(document.body.textContent).toContain(t('assistant.chat.viewing_history'))
    expect(document.body.textContent, `the history stamp is not dated in ${ZONE}`).toContain(expected)
    // The machine's own clock was the bug: an older page dated in the browser's zone sits beside a thread
    // dated in the assistant's and reads as though the two were written in the same hour.
    expect(expected).not.toBe(new Date(CREATED_AT).toLocaleString())
  })
})

describe('a token count', () => {
  it('is grouped by the interface locale rather than by a hardcoded one', async () => {
    const previous = getLocale()
    await setLocaleAsync('zh-CN', false)
    try {
      const { tags } = tagsSeenWhile(() => answerStats({ inputTokens: 1_230_000, outputTokens: 4_567 }, 1000))
      expect(tags).toContain('zh-CN')
      expect(tags).not.toContain('en-US')
    } finally {
      await setLocaleAsync(previous, false)
    }
  })

  it('writes the same figure through the shared formatter', () => {
    expect(full(1_234_567)).toBe(new Intl.NumberFormat(getLocale()).format(1_234_567))
    expect(answerStats({ inputTokens: 1_230_000, outputTokens: 4_567 }, 1000)).toContain(full(1_234_567))
  })
})
