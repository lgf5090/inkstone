// @vitest-environment jsdom
/**
 * The picture an answer carries.
 *
 * The assistant can draw, and what it draws is a chat attachment rather than a URL in the text — so the
 * reply has to draw the row it carries, the same way the reader's own message draws theirs. Without this
 * half the feature is a chip in the transcript that says a picture was made and shows nothing, which is
 * exactly the state a missing `attachments` prop leaves behind.
 *
 * An id the store cannot resolve stays on screen and says it is unavailable. Saying nothing was the old
 * reading, and it was wrong in both directions: a turn that carried a file then looked like a turn that
 * never did, and the reader had no way to tell a deleted upload from a thread that had no upload at all.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatAttachment } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
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

  it('says an id it cannot resolve is unavailable, rather than drawing nothing', () => {
    useAssistant.setState({ fileIndex: {} })
    const view = render(['missing'])
    const gap = view.querySelector<HTMLElement>('[data-attachment-unavailable]')
    expect(gap, 'a turn that carried an attachment now claims it carried none').toBeTruthy()
    expect(gap!.textContent).toContain(t('assistant.attach.unavailable'))
    // A gap has nothing to open, so it is never a control a reader can press into silence.
    expect(gap!.tagName).not.toBe('BUTTON')
  })
})
