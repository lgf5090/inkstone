// @vitest-environment jsdom
/**
 * The card a template's passages report to.
 *
 * What the reader needs from it is the same three facts the run has: how many passages there are, which
 * one it is on, and — when one stopped — which one, with a way back in that names that passage alone. The
 * three states are asserted as the reader would meet them: nothing at all when there is no run, a step in
 * progress while one is going, and a stopped run that says why and offers the retry.
 *
 * The card is portalled to the document body, so the queries go to the body rather than to a container of
 * the test's own.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import type { AnswerResult } from './editor-ai'
import { TemplateSlotProgress } from './template-progress'
import { discardTemplateSlotFill, startTemplateSlotFill } from './template-fill'
import { peekTemplateSlotJob } from './template-slot-job'

const { asks } = vi.hoisted(() => ({
  asks: [] as { instruction: string, answer: (result: AnswerResult) => void }[],
}))

vi.mock('./note-ai', () => ({
  askAboutNote: (_noteId: string, instruction: string) => new Promise<AnswerResult>((resolve) => {
    asks.push({ instruction, answer: resolve })
  }),
}))

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz02'
const SKELETON = 'Intro\n\nTail\n'
const SLOTS = [
  { at: 0, instruction: 'the top' },
  { at: 'Intro\n\n'.length, instruction: 'the opening' },
  { at: SKELETON.length, instruction: 'the ending' },
]
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()

let root: Root

function card(): Element | null {
  return document.body.querySelector('section[role="status"]')
}

async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await new Promise((resolve) => { setTimeout(resolve, 0) })
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(TemplateSlotProgress))
    await settle()
  })
}

function answer(instruction: string, result: AnswerResult): void {
  const open = asks.find((entry) => entry.instruction === instruction)
  if (!open) throw new Error(`no turn was opened for ${instruction}`)
  open.answer(result)
}

function buttonNamed(label: string): HTMLButtonElement | null {
  return [...document.body.querySelectorAll('button')].find((button) => (button.textContent || button.getAttribute('aria-label') || '').includes(label)) ?? null
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  await initI18n()
  asks.length = 0
  vi.spyOn(useUi.getState(), 'toast')
  useNotes.setState({
    notes: { [NOTE_ID]: { id: NOTE_ID, title: 'Week' } as never },
    contents: { [NOTE_ID]: SKELETON },
    editContent: () => {},
  })
  root = createRoot(document.createElement('div'))
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  // The portal leaves its node on the body, and a card still mounted would answer the next test's query.
  document.body.innerHTML = ''
  if (peekTemplateSlotJob()) discardTemplateSlotFill()
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
  vi.restoreAllMocks()
})

describe('with no run going', () => {
  it('shows nothing at all', async () => {
    await render()
    expect(card()).toBeNull()
  })
})

describe('a run that is going', () => {
  it('says which passage of how many, marks it as the current step, and names what it waits on', async () => {
    await render()
    await act(async () => {
      startTemplateSlotFill(NOTE_ID, SLOTS)
      await settle()
    })
    const section = card()
    expect(section).not.toBeNull()
    expect(section?.getAttribute('aria-label')).toBe(t('assistant.template.progress_label'))
    expect(section?.textContent).toContain(t('assistant.template.progress_count', { current: 1, total: 3 }))
    expect(section?.querySelector('[aria-current="step"]')).not.toBeNull()
    expect(section?.textContent).toContain(t('assistant.template.waiting_answer'))
    // Each row's state is said in words as well as by its icon, which is marked decorative.
    expect(section?.querySelectorAll('ol svg[aria-hidden="true"]').length).toBe(3)
  })

  it('moves the step along as each passage comes back', async () => {
    await render()
    await act(async () => {
      startTemplateSlotFill(NOTE_ID, SLOTS)
      await settle()
    })
    await act(async () => {
      answer('the top', { status: 'ok', text: 'ONE' })
      await settle()
    })
    expect(card()?.textContent).toContain(t('assistant.template.progress_count', { current: 2, total: 3 }))
  })
})

describe('a run that stopped on one passage', () => {
  it('says which passage failed, and offers to retry that one and nothing else', async () => {
    await render()
    await act(async () => {
      startTemplateSlotFill(NOTE_ID, SLOTS)
      await settle()
      answer('the top', { status: 'ok', text: 'ONE' })
      await settle()
      answer('the opening', { status: 'failed', error: 'upstream refused' })
      await settle()
    })
    const section = card()
    expect(section?.textContent).toContain(t('assistant.template.stopped', { current: 2, total: 3 }))
    expect(section?.querySelector('[role="alert"]')?.textContent).toContain('upstream refused')

    asks.length = 0
    const retry = buttonNamed(t('assistant.template.retry_slot'))
    expect(retry).not.toBeNull()
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await settle()
    })
    expect(asks.map((entry) => entry.instruction)).toEqual(['the opening'])
  })

  it('keeps the way out of the run in words, not only in an icon', async () => {
    await render()
    await act(async () => {
      startTemplateSlotFill(NOTE_ID, SLOTS)
      await settle()
      answer('the top', { status: 'empty' })
      await settle()
    })
    expect(buttonNamed(t('assistant.template.discard'))).not.toBeNull()
  })

  it('offers no retry when the note it was writing is gone', async () => {
    await render()
    await act(async () => {
      startTemplateSlotFill(NOTE_ID, SLOTS)
      await settle()
      useNotes.setState((state) => ({ contents: { ...state.contents, [NOTE_ID]: undefined } as never }))
      answer('the top', { status: 'ok', text: 'ONE' })
      await settle()
    })
    expect(card()?.querySelector('[role="alert"]')?.textContent).toContain(t('assistant.template.note_gone'))
    expect(buttonNamed(t('assistant.template.retry_slot'))).toBeNull()
    expect(buttonNamed(t('assistant.template.discard'))).not.toBeNull()
  })
})
