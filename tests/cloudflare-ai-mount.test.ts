/**
 * The AI tabs mounted the way the app mounts them — twice.
 *
 * Both tabs keep a liveness flag: `AudioTab` revokes the Blob URL of a clip that lands after the tab
 * is gone, `ChatTab` refuses to commit a stream nobody is watching. React runs a fresh mount's cleanup
 * in StrictMode, so a flag armed only by the ref initializer stays false for the rest of the session —
 * and the answer keeps *looking* fine, because the streamed object is mutated in place and a later
 * render picks it up. What disappears is the clip row and the stored assistant message. A dev-only
 * render cadence with a production-shaped symptom, which is why it needs a mount test.
 */
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AudioTab } from '../src/client/features/cloudflare/screens/ai/AudioTab'
import { ChatTab } from '../src/client/features/cloudflare/screens/ai/ChatTab'
import { cfT } from '../src/client/features/cloudflare/i18n'
import { initI18n } from '../src/client/lib/i18n'
import { installTestGlobals } from '../src/client/lib/test-render'

/** One streamed answer: a content delta, then the terminal `[DONE]` the reader stops on. */
function sseBody(text: string): { body: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } } } {
  const bytes = new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
  )
  let sent = false
  return {
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true }
          sent = true
          return { done: false, value: bytes }
        },
        cancel: async () => undefined,
      }),
    },
  }
}

vi.mock('../src/client/features/cloudflare/api/ai', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/client/features/cloudflare/api/ai')>(),
  aiApi: {
    models: vi.fn(async (task: string) => ({
      data: task === 'text-to-speech'
        ? [{ id: '@cf/deepgram/aura-2-en', label: 'aura-2-en', speakers: ['luna'], default_speaker: 'luna' }]
        : [{ id: '@cf/openai/gpt-oss-120b', label: 'gpt-oss-120b' }],
    })),
    audio: vi.fn(async () => ({
      data: [{ audio: 'AAAAAA==', content_type: 'audio/mpeg', neurons: 3 }],
    })),
    chatStream: vi.fn(async () => sseBody('好的')),
    chat: vi.fn(async () => ({ choices: [{ message: { content: '好的' } }] })),
  },
}))

vi.mock('../src/client/features/cloudflare/api/chat-sessions', () => ({
  chatSessionsApi: {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: 's1', title: '', pinned: 0, favorite: 0, created_at: 1, updated_at: 1 })),
    update: vi.fn(async () => ({ id: 's1', title: '', pinned: 0, favorite: 0, created_at: 1, updated_at: 1 })),
    remove: vi.fn(async () => ({ ok: true })),
    messages: vi.fn(async () => []),
    append: vi.fn(async () => []),
    clear: vi.fn(async () => ({ ok: true })),
    removeLastAssistant: vi.fn(async () => ({ ok: true })),
  },
}))

vi.mock('../src/client/features/cloudflare/screens/ai/use-ai-accounts', () => ({
  useAiAccounts: () => ({ accounts: [], error: null }),
}))

let root: Root
let container: HTMLDivElement

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => { window.setTimeout(resolve, 0) }) })
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')]
    .find((entry) => entry.textContent?.trim() === label)
  if (!match) throw new Error(`no button labelled ${JSON.stringify(label)}`)
  return match
}

function typeInto(text: string): void {
  const box = container.querySelector<HTMLTextAreaElement>('textarea')
  if (!box) throw new Error('the tab drew no text box')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  URL.createObjectURL = vi.fn(() => 'blob:mock-audio') as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.clearAllMocks()
})

describe('the text-to-speech tab', () => {
  it('draws the clip it synthesized, after StrictMode has mounted the tab twice', async () => {
    act(() => { root.render(createElement(StrictMode, null, createElement(AudioTab))) })
    await flush()
    typeInto('The port works.')
    const { aiApi } = await import('../src/client/features/cloudflare/api/ai')
    act(() => { button(cfT('cloudflare.ai_audio.generate')).click() })
    await flush()
    expect((aiApi.audio as Mock).mock.calls.length).toBe(1)
    expect(container.querySelector('audio')).not.toBeNull()
  })

  it('revokes the object URL of a clip that arrives after the tab is gone', async () => {
    const { aiApi } = await import('../src/client/features/cloudflare/api/ai')
    let resolveAudio: ((value: unknown) => void) | null = null
    ;(aiApi.audio as Mock).mockImplementationOnce(() => new Promise((resolve) => { resolveAudio = resolve }))
    act(() => { root.render(createElement(StrictMode, null, createElement(AudioTab))) })
    await flush()
    typeInto('The port works.')
    act(() => { button(cfT('cloudflare.ai_audio.generate')).click() })
    await flush()
    expect(resolveAudio, 'the request never reached the mock').not.toBeNull()
    act(() => { root.unmount() })
    act(() => {
      resolveAudio?.({ data: [{ audio: 'AAAAAA==', content_type: 'audio/mpeg', neurons: 3 }] })
    })
    await flush()
    expect(container.querySelector('audio')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-audio')
  })
})

describe('the chat tab', () => {
  it('stores the answer it streamed, after StrictMode has mounted the tab twice', async () => {
    const { chatSessionsApi } = await import('../src/client/features/cloudflare/api/chat-sessions')
    act(() => { root.render(createElement(StrictMode, null, createElement(ChatTab))) })
    await flush()
    typeInto('只回复两个字：好的')
    const send = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${cfT('cloudflare.ai.send')}"]`,
    )
    if (!send) throw new Error('the tab drew no send control')
    act(() => { send.click() })
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await flush()
      if ((chatSessionsApi.append as Mock).mock.calls.length >= 2) break
    }
    const stored = (chatSessionsApi.append as Mock).mock.calls.map((call) => call[1])
    expect(stored).toEqual([
      [{ role: 'user', content: '只回复两个字：好的' }],
      [{ role: 'assistant', content: '好的' }],
    ])
  })
})
