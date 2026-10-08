import { act, createElement, StrictMode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PromptRequest } from '../../lib/quickadd/format'
import { initI18n } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import {
  askQuickAddPrompts,
  currentPromptGroup,
  resetQuickAddPrompts,
  submitQuickAddPrompts,
  type PromptAnswers,
} from './prompt-queue'
import { QuickAddPromptHost } from './prompts'

function request(over: Partial<PromptRequest> = {}): PromptRequest {
  return {
    kind: 'text',
    key: 'who',
    label: 'Who',
    defaultValue: '',
    options: [],
    displayOptions: null,
    allowCustom: false,
    multiSelect: false,
    multiFormat: 'auto',
    optional: false,
    trim: false,
    caseStyle: null,
    numeric: {},
    dateFormat: null,
    withTime: false,
    ...over,
  }
}

function ask(): Promise<PromptAnswers | null> {
  let asking: Promise<PromptAnswers | null> | undefined
  act(() => {
    asking = askQuickAddPrompts({
      requests: [request()],
      onePage: false,
      choiceId: 'qa-claim',
      choiceName: 'Claim test',
    })
  })
  if (!asking) throw new Error('the ask never started')
  return asking
}

async function settled(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

function dialogText(): string {
  return document.querySelector('[role="dialog"]')?.textContent ?? ''
}

let mounted: RenderedElement | null = null

function mount(element: ReturnType<typeof createElement>): RenderedElement {
  mounted = renderElement(element)
  return mounted
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  act(() => {
    resetQuickAddPrompts()
  })
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  act(() => {
    resetQuickAddPrompts()
  })
})

describe('the claim a prompt host holds over the queue', () => {
  it('answers the reader when React mounts the host, cleans up and mounts it again', async () => {
    const asking = ask()
    let answered = false
    void asking.then(() => { answered = true })
    mount(createElement(StrictMode, null, createElement(QuickAddPromptHost)))
    await settled()
    expect(currentPromptGroup(), 'a remounted host must not answer the run itself').not.toBeNull()
    expect(answered, 'the run must still be waiting for the reader').toBe(false)
    expect(dialogText()).toContain('Who')
    act(() => {
      submitQuickAddPrompts(new Map([['who', 'the reader']]))
    })
    const answers = await asking
    expect(answers?.get('who')).toBe('the reader')
  })

  it('releases the run once the last host has really gone away', async () => {
    mount(createElement(QuickAddPromptHost))
    const asking = ask()
    await settled()
    expect(currentPromptGroup()).not.toBeNull()
    act(() => {
      mounted?.unmount()
      mounted = null
    })
    await settled()
    expect(currentPromptGroup(), 'a host that is gone cannot answer the run').toBeNull()
    expect(await asking, 'a host that is gone answers nothing').toBeNull()
  })
})
