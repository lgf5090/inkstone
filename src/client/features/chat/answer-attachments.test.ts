// @vitest-environment jsdom
/**
 * The picture an answer carries.
 *
 * The assistant can draw, and what it draws is a chat attachment rather than a URL in the text — so the
 * reply has to draw the row it carries, the same way the reader's own message draws theirs. Without this
 * half the feature is a chip in the transcript that says a picture was made and shows nothing, which is
 * exactly the state a missing `attachments` prop leaves behind.
 *
 * An id the store cannot resolve draws nothing at all, which is the honest reading: a broken-image icon
 * would claim a picture exists and that this app lost it.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatAttachment } from '@shared/assistant'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { AssistantBubble } from './MessageParts'
import { useAssistant } from './assistant-store'

const DRAWN: ChatAttachment = {
  id: 'a1', kind: 'image', filename: 'a cat on a keyboard.png', mime: 'image/png', size: 2048, key: 'chat/images/u/a1.png', createdAt: 1,
}

const original = useAssistant.getState()
let root: Root
let host: HTMLElement

function render(attachments: string[]): HTMLElement {
  root = createRoot(host)
  act(() => {
    root.render(createElement(AssistantBubble, {
      text: 'Here is the picture you asked for.',
      reasoning: '',
      tools: [],
      error: null,
      streaming: false,
      attachments,
    }))
  })
  return host
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  act(() => root?.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
})

describe('an answer that drew something', () => {
  it('draws the picture it carries', () => {
    useAssistant.setState({ fileIndex: { a1: DRAWN } })
    const view = render(['a1'])
    const image = view.querySelector('img')
    expect(image, 'the picture the answer carries is not drawn').toBeTruthy()
    // Served from this app's own route, under the reader's own session — never from the vendor, whose link
    // expires and who would otherwise learn when the thread is opened.
    expect(image!.getAttribute('src')).toBe('/api/assistant/files/a1')
  })

  it('draws nothing for an id it cannot resolve', () => {
    useAssistant.setState({ fileIndex: {} })
    const view = render(['missing'])
    expect(view.querySelector('img')).toBeNull()
  })
})
