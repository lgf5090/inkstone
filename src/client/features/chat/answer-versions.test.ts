/**
 * The answer pager: two arrows over the answers one turn has already displaced.
 *
 * Pinned here is the drive, not the markup — each press has to change what the bubble shows, and only an
 * explicit "use this one" may reach the server. A reader who steps back out of curiosity must not silently
 * rewrite their own thread. Labels come from the catalog, so the case says the same thing in either locale.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantAnswerVersion, AssistantMessage } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { AssistantBubble, answerStats } from './MessageParts'

const PREVIOUS = () => t('assistant.chat.previous')
const NEXT = () => t('assistant.chat.next')
const USE_THIS = () => t('assistant.chat.use_this')
const COPY = () => t('assistant.chat.copy')
const VIEWING = () => t('assistant.chat.viewing_history')

function version(id: string, text: string): AssistantAnswerVersion {
    return {
        id,
        messageId: 'M1',
        conversationId: 'C1',
        content: text,
        tools: [],
        modelLabel: 'deepseek-chat',
        usage: { inputTokens: 100, outputTokens: 50 },
        durationMs: 1000,
        createdAt: 1_700_000_000_000,
    }
}

const LIVE = 'THE LIVE ANSWER'
const OLDER = [version('V1', 'THE FIRST ANSWER'), version('V2', 'THE SECOND ANSWER')]

interface View {
    host: HTMLElement
    text: () => string
    click: (name: string) => void
    step: (name: string) => Promise<void>
    unmount: () => void
}

function render(bubble: Partial<React.ComponentProps<typeof AssistantBubble>>): View {
    installTestGlobals()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root: Root = createRoot(host)
    act(() => {
        root.render(createElement(AssistantBubble, {
            text: LIVE,
            reasoning: '',
            tools: [],
            error: null,
            streaming: false,
            ...bubble,
        }))
    })
    const click = (name: string) => {
        const button = [...host.querySelectorAll('button')]
            .find((node) => (node.getAttribute('aria-label') ?? node.textContent ?? '').includes(name))
        expect(button, `${name} is not rendered`).toBeTruthy()
        act(() => {
            button!.click()
        })
    }
    return {
        host,
        text: () => host.textContent ?? '',
        click,
        step: async (name: string) => {
            click(name)
            // The first step back fetches the history, and the page it lands on is set in that microtask.
            await act(async () => {
                await Promise.resolve()
            })
        },
        unmount: () => {
            act(() => root.unmount())
            host.remove()
        },
    }
}

beforeEach(async () => {
    await initI18n()
    installTestGlobals()
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('the answer pager', () => {
    it('stays away from a turn that has only one answer', () => {
        const view = render({ versionCount: 0, loadVersions: async () => [] })
        expect(view.text()).toContain(LIVE)
        expect([...view.host.querySelectorAll('button')].map((node) => node.getAttribute('aria-label')).filter(Boolean))
            .not.toContain(PREVIOUS())
        view.unmount()
    })
    it('fetches the history on the first step back, then reuses it', async () => {
        const loadVersions = vi.fn(async () => OLDER)
        const view = render({ versionCount: OLDER.length, loadVersions })
        await view.step(PREVIOUS())
        expect(view.text()).toContain('THE SECOND ANSWER')
        expect(view.text()).not.toContain(LIVE)
        await view.step(PREVIOUS())
        expect(view.text()).toContain('THE FIRST ANSWER')
        expect(loadVersions).toHaveBeenCalledTimes(1)
        expect(view.text()).toMatch(/1\/3/)
        await view.step(NEXT())
        expect(view.text()).toMatch(/2\/3/)
        await view.step(NEXT())
        expect(view.text()).toMatch(/3\/3/)
        expect(view.text()).toContain(LIVE)
        view.unmount()
    })
    it('will not step past either end', async () => {
        const loadVersions = vi.fn(async () => OLDER)
        const view = render({ versionCount: OLDER.length, loadVersions })
        await view.step(PREVIOUS())
        await view.step(PREVIOUS())
        await view.step(PREVIOUS())
        expect(view.text()).toMatch(/1\/3/)
        expect(view.text()).toContain('THE FIRST ANSWER')
        view.unmount()
    })
    it('asks the server only when the reader says to keep the older answer', async () => {
        const onActivate = vi.fn()
        const loadVersions = vi.fn(async () => OLDER)
        const view = render({ versionCount: OLDER.length, loadVersions, onActivate })
        await view.step(PREVIOUS())
        expect(onActivate).not.toHaveBeenCalled()
        expect(view.text()).toContain(VIEWING())
        view.click(USE_THIS())
        expect(onActivate).toHaveBeenCalledWith('V2')
        view.unmount()
    })
    it('copies the answer on screen, not the one underneath it', async () => {
        const writeText = vi.fn(async () => undefined)
        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
        const view = render({ versionCount: OLDER.length, loadVersions: async () => OLDER })
        await view.step(PREVIOUS())
        view.click(COPY())
        expect(writeText).toHaveBeenCalledWith('THE SECOND ANSWER')
        view.unmount()
    })
    it('reveals the footer on hover only where a hover exists', () => {
        const view = render({ versionCount: 0, loadVersions: async () => [] })
        const footer = view.host.querySelector('div[class*="group-hover:opacity-100"]')
        expect(footer, 'the footer carries no hover reveal').toBeTruthy()
        expect(footer?.className).toContain('md:opacity-0')
        // …and the phone never inherits that hidden default, because it has no pointer to hover with.
        const tokens = footer!.className.split(/\s+/)
        expect(tokens).toContain('opacity-100')
        expect(tokens).not.toContain('opacity-0')
        view.unmount()
    })
    it('keeps the footer lit while an older answer is on screen', async () => {
        const view = render({ versionCount: 1, loadVersions: async () => [version('V1', 'THE FIRST ANSWER')] })
        await view.step(PREVIOUS())
        const footer = view.host.querySelector('[class*="md:opacity-0"]')
        expect(footer, 'the footer faded away while the reader is looking at history').toBeNull()
        view.unmount()
    })
    it('keeps the regenerate door on the live answer only', async () => {
        const onRetry = vi.fn()
        // ChatView labels the door by the answer's own status: a complete one offers "regenerate".
        const view = render({
            versionCount: 1,
            onRetry,
            retryLabel: 'assistant.chat.regenerate',
            loadVersions: async () => [version('V1', 'THE FIRST ANSWER')],
        })
        expect([...view.host.querySelectorAll('button')].map((node) => node.getAttribute('aria-label')))
            .toContain(t('assistant.chat.regenerate'))
        await view.step(PREVIOUS())
        expect(onRetry).not.toHaveBeenCalled()
        expect([...view.host.querySelectorAll('button')].map((node) => node.getAttribute('aria-label')))
            .not.toContain(t('assistant.chat.regenerate'))
        view.unmount()
    })
})

describe('the answer stats line', () => {
    it('says nothing when the turn reported no usage', () => {
        expect(answerStats(null, 4200)).toBeNull()
        expect(answerStats({ inputTokens: 0, outputTokens: 0 }, 4200)).toBeNull()
    })
    it('divides the output by the seconds it actually took', () => {
        expect(answerStats({ inputTokens: 4000, outputTokens: 340 }, 2450))
            .toBe(`4,340 ${t('assistant.chat.tokens')} · 138.8 ${t('assistant.chat.tokens_per_second')}`)
    })
    it('falls back to the cost when there is no elapsed time to divide by', () => {
        expect(answerStats({ inputTokens: 10, outputTokens: 5 }, 0)).toBe(`15 ${t('assistant.chat.tokens')}`)
    })
})

/** A message row read from the server has to carry the fields the pager branches on. */
it('keeps the transcript fields the pager reads', () => {
    const message = {
        id: 'M1',
        conversationId: 'C1',
        role: 'assistant',
        content: LIVE,
        tools: [],
        status: 'complete',
        error: null,
        source: 'chat',
        createdAt: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        durationMs: 1000,
        modelLabel: 'deepseek-chat',
        versionCount: 2,
    } satisfies AssistantMessage
    expect(message.versionCount).toBe(2)
    expect(message.durationMs).toBe(1000)
    expect(message.modelLabel).toBe('deepseek-chat')
})
