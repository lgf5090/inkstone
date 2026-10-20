// @vitest-environment jsdom
/**
 * The banner a thread shows when reading it was refused.
 *
 * `assistant-store` keeps the reason in `messagesError` and pops a toast beside it, but the toast expires and
 * the banner stays — and the banner had only the key. `LoadFailure` already prints a detail line under its
 * headline for exactly this (the files tab hands it one), so the refusal a route named the field for reached
 * the reader as "Could not load this conversation", the same sentence for a missing thread, a refused
 * conversation id and a validator that rejected one field.
 *
 * Two things are pinned, because the second is how this kind of fix usually goes wrong. With a reason the
 * banner shows it — as text, since it is the deployment's writing and not the app's. Without one, the banner
 * is the block it has always been: the reason is the headline whenever the route said nothing beyond the
 * code, and a second copy of the sentence the reader has just read above it is not a second fact — it is the
 * empty line the design was written to avoid.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { ChatView } from './ChatView'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    search: async () => ({ results: [] }),
    tags: { list: async () => ({ tags: [] }) },
    folders: { list: async () => ({ folders: [] }) },
    notes: {},
    assistant: {
      skills: async () => ({ skills: [] }),
      conversationBranches: async () => ({ parent: null, siblings: [] }),
      conversationArtifacts: async () => ({ artifacts: [] }),
    },
  },
}))

type AssistantState = ReturnType<typeof useAssistant.getState>

const original = useAssistant.getState()
const openConversation = vi.fn(async () => undefined)
let root: Root
let host: HTMLElement

const alert = () => document.body.querySelector<HTMLElement>('[role="alert"]')
const retry = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
  .find((node) => node.textContent?.trim() === t('common.retry'))

async function mountThread(messagesError: string | null): Promise<void> {
  useAssistant.setState({
    ...original,
    view: 'chat',
    activeId: 'c1',
    conversations: [{ id: 'c1', title: 'First thread', updatedAt: 2 } as AssistantState['conversations'][number]],
    messages: [],
    messagesReady: true,
    messagesError,
    messagesHasMore: false,
    messagesHasNewer: false,
    messagesBefore: null,
    turn: null,
    remoteStreaming: false,
    pending: [],
    turnTools: [],
    turnScopes: [],
    fileIndex: {},
    canvasOpen: false,
    ephemeral: false,
    focusMessageId: null,
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'model-1' },
    artifacts: [],
    artifactsReady: true,
    loadMcpServers: vi.fn(async () => undefined),
    loadSkills: vi.fn(async () => undefined),
    loadTaxonomy: vi.fn(async () => undefined),
    loadFlagged: vi.fn(async () => undefined),
    setConversationQuery: vi.fn(async () => undefined),
    openConversation,
  } as Partial<AssistantState>)
  await act(async () => { root.render(createElement(ChatView)) })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  openConversation.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.restoreAllMocks()
})

describe('a thread whose read was refused', () => {
  it('prints the reason the route gave under the sentence the banner has always said', async () => {
    const reason = 'The reader’s own history was archived, so this thread is no longer readable.'
    await mountThread(reason)

    expect(alert(), 'the refusal is not named').toBeTruthy()
    expect(alert()!.textContent).toContain(t('assistant.chat.load_failed'))
    expect(alert()!.textContent).toContain(reason)
    // The retry has to survive the second line: a banner that explains without offering the way back is worse.
    expect(retry(), 'the refusal offers no retry').toBeTruthy()
  })

  it('prints that reason as text, because it is the deployment’s writing', async () => {
    await mountThread('The name <img src=x onerror=boom()> was refused')

    expect(alert()!.textContent).toContain('The name <img src=x onerror=boom()> was refused')
    expect(document.querySelectorAll('img, script')).toHaveLength(0)
  })

  it('stays the one-line banner it has always been when the route said nothing beyond the code', async () => {
    // What the store holds for a refusal with no field reason: the same sentence the banner's own headline
    // is translated from. Printing it twice would be a second row of nothing.
    await mountThread(t('assistant.chat.load_failed'))

    expect(alert(), 'the refusal is not named').toBeTruthy()
    expect(alert()!.querySelectorAll('p')).toHaveLength(1)
    expect(alert()!.textContent).toBe(`${t('assistant.chat.load_failed')}${t('common.retry')}`)
  })

  it('asks for the thread again when the reader presses retry', async () => {
    await mountThread('The stored thread is on a shelf this account cannot read.')

    act(() => { retry()!.click() })
    await act(async () => { await Promise.resolve() })
    expect(openConversation).toHaveBeenCalledWith('c1')
  })
})
