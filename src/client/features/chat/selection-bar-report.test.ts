// @vitest-environment jsdom
/**
 * The bar that acts on the turns a reader ticked, answering when it is pressed.
 *
 * Selection is a mode, so its bar is the only place the reader learns what a press did. Every other copy
 * affordance in this app says so — the reply's own row switches to "Copied", the menu toasts a refusal —
 * while the bar's copy wrote into `navigator.clipboard` through an optional chain and reported nothing:
 * in a non-secure context, where that API does not exist, the press was a silent no-op indistinguishable
 * from a copy that worked. What is pinned is that both answers arrive.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { SelectionBar } from './SelectionBar'

const { copyText } = vi.hoisted(() => ({ copyText: vi.fn() }))

vi.mock('../../lib/clipboard', () => ({ copyText: (text: string) => copyText(text) }))

function message(id: string, content: string): AssistantMessage {
  return {
    id,
    conversationId: 'c1',
    role: 'assistant',
    content,
    tools: [],
    status: 'complete',
    error: null,
    createdAt: 1_700_000_000_000,
    source: 'chat',
  }
}

let root: Root
let host: HTMLElement

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const copyButton = () => buttons().find((node) => node.textContent?.includes(t('assistant.chat.select_copy')))
const toasts = () => useUi.getState().toasts

function mount(): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => {
    root.render(createElement(SelectionBar, {
      picked: [message('m1', 'first answer'), message('m2', 'second answer')],
      title: 'Thread',
      onShare: () => {},
      onDelete: () => {},
      onExit: () => {},
    }))
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  copyText.mockReset()
  useUi.setState({ toasts: [] })
  mount()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('copying the picked turns', () => {
  it('writes them through the shared helper, in thread order, separated', async () => {
    copyText.mockResolvedValue(true)
    await act(async () => { copyButton()!.click() })
    expect(copyText).toHaveBeenCalledWith('first answer\n\nsecond answer')
  })

  it('says how many arrived in the clipboard', async () => {
    copyText.mockResolvedValue(true)
    await act(async () => { copyButton()!.click() })
    expect(toasts().map((entry) => entry.title)).toContain(t('assistant.chat.select_copied', { count: 2 }))
  })

  it('says when the clipboard refused', async () => {
    copyText.mockResolvedValue(false)
    await act(async () => { copyButton()!.click() })
    const last = toasts().at(-1)
    expect(last?.title).toBe(t('preview.could_not_copy'))
    expect(last?.tone).toBe('danger')
  })

  it('refuses a press that has nothing to copy', async () => {
    copyText.mockResolvedValue(true)
    // With no turns ticked the bar says so, and the button is shut rather than pressing into a no-op.
    act(() => { root.render(createElement(SelectionBar, {
      picked: [],
      title: 'Thread',
      onShare: () => {},
      onDelete: () => {},
      onExit: () => {},
    })) })
    expect(copyButton()!.disabled).toBe(true)
    await act(async () => {})
    expect(copyText).not.toHaveBeenCalled()
  })
})
