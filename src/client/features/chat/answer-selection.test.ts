// @vitest-environment jsdom
/**
 * The bar over a piece of an answer the reader highlighted.
 *
 * jsdom has no layout engine: every box it reports is zero, so nothing here claims to have checked where
 * the bar landed. What is checked instead is the structure a screen reader and a keyboard read — the
 * toolbar's name, the four rows, that Escape gives the focus back, and which selections the surface refuses
 * to act on — and the placement arithmetic is proved on its own, as the pure function it is written as
 * (`placeToolbar`), at the two widths that matter.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { copyText } from '../../lib/clipboard'
import { useAssistant } from './assistant-store'
import { AssistantBubble } from './MessageParts'
import {
  placeToolbar,
  SELECTION_GAP,
  TOOLBAR_SIZE,
  VIEWPORT_EDGE,
  type SelectionBox,
} from './answer-selection'

vi.mock('../../lib/clipboard', () => ({ copyText: vi.fn(async () => true) }))

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz11'
const SELECTION = '  the sentence the reader stopped on  '
const RECT: SelectionBox = { top: 220, left: 120, width: 180, height: 18 }

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button[data-answer-action]')]
const byName = (name: string) => buttons()
  .find((node) => (node.getAttribute('aria-label') ?? '') === name)
const answerBody = () => document.body.querySelector<HTMLElement>('[data-answer-body]')

/** Hand the surface a selection whose two ends sit inside this answer, and let it read them. */
function select(text: string, end?: Node): void {
  const root = answerBody()
  expect(root, 'the answer prose never rendered').toBeTruthy()
  const range = {
    startContainer: root as Node,
    endContainer: end ?? (root as Node),
    getBoundingClientRect: () => RECT,
  }
  const selection = { rangeCount: 1, getRangeAt: () => range, toString: () => text }
  vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection)
  act(() => { document.dispatchEvent(new Event('selectionchange')) })
}

let root: Root
let host: HTMLElement

function mount(): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => {
    root.render(createElement(AssistantBubble, {
      text: 'The answer says a sentence.',
      reasoning: '',
      tools: [],
      error: null,
      streaming: false,
      messageId: 'm1',
    }))
  })
}

const originalAssistant = useAssistant.getState()
const originalUi = useUi.getState()
const originalNotes = useNotes.getState()

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useAssistant.setState({ ...originalAssistant, activeId: 'c1', composerSeed: null })
  useUi.setState({ ...originalUi, activeNoteId: NOTE_ID })
  useNotes.setState({
    ...originalNotes,
    notes: { ...originalNotes.notes, [NOTE_ID]: { id: NOTE_ID, title: 'A note' } as never },
    contents: { ...originalNotes.contents, [NOTE_ID]: 'an open note' },
  })
  mount()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(originalAssistant, true)
  useUi.setState(originalUi, true)
  useNotes.setState(originalNotes, true)
  vi.restoreAllMocks()
})

describe('the bar over a selection inside one answer', () => {
  it('names itself and offers the four rows to a reader who has a note open', () => {
    select(SELECTION)
    const bar = document.body.querySelector<HTMLElement>('[role="toolbar"]')
    expect(bar, 'the selection bar never opened').toBeTruthy()
    expect(bar!.getAttribute('aria-label')).toBe(t('assistant.chat.selection_actions'))
    expect(buttons().map((node) => node.dataset.answerAction)).toEqual(['ask', 'translate', 'copy', 'quote-to-note'])
    // The names are the editor AI's own vocabulary plus the copy row every message already wears: one set
    // of words for the same seven acts, not a second one invented here.
    expect(byName(t('assistant.edit.ask'))).toBeTruthy()
    expect(byName(t('assistant.edit.translate'))).toBeTruthy()
    expect(byName(t('assistant.chat.copy'))).toBeTruthy()
    expect(byName(t('assistant.chat.select_quote_to_note'))).toBeTruthy()
  })

  it('leaves the note row away when there is no note to write into', () => {
    act(() => { useUi.setState({ activeNoteId: null }) })
    select(SELECTION)
    expect(buttons().map((node) => node.dataset.answerAction)).toEqual(['ask', 'translate', 'copy'])
  })

  it('draws nothing for a selection that reaches past the answer, or for one that says nothing', () => {
    select('a sentence', document.body as Node)
    expect(document.body.querySelector('[role="toolbar"]')).toBeNull()
    select('   ')
    expect(document.body.querySelector('[role="toolbar"]')).toBeNull()
  })

  it('asks about the passage by quoting it into the composer, and copies the text exactly', async () => {
    select(SELECTION)
    await act(async () => { byName(t('assistant.chat.copy'))!.click() })
    // "the exact selected text" is the untrimmed one: a copy that tidied the reader's bytes is not theirs.
    expect(copyText).toHaveBeenCalledWith(SELECTION)
    // A press uses the selection and takes the bar away, so the next row has to be reached from a
    // selection made again — which is also what the reader does.
    select(SELECTION)

    await act(async () => { byName(t('assistant.edit.ask'))!.click() })
    expect(useAssistant.getState().composerSeed).toBe(
      '>   the sentence the reader stopped on  \n\n',
    )
    // The bar belongs to the selection, and a press has used it: it goes away rather than hovering there.
    expect(document.body.querySelector('[role="toolbar"]')).toBeNull()
  })

  it('quotes the selection into the open note', () => {
    const editContent = vi.fn()
    useNotes.setState({ editContent })
    select('the sentence')
    act(() => { byName(t('assistant.chat.select_quote_to_note'))!.click() })
    const [, written] = editContent.mock.calls[0] as [string, string]
    expect(editContent.mock.calls[0]![0]).toBe(NOTE_ID)
    expect(written).toContain('an open note')
    expect(written).toContain('> the sentence')
  })
})

describe('Escape from the bar', () => {
  it('takes the bar away and hands the focus back to the answer it came from', () => {
    select(SELECTION)
    const ask = byName(t('assistant.edit.ask'))
    expect(ask).toBeTruthy()
    act(() => { ask!.focus() })
    expect(document.activeElement).toBe(ask)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.body.querySelector('[role="toolbar"]')).toBeNull()
    // Nothing before the bar held focus, so the prose the selection was drawn out of is where a keyboard
    // reader is left — not the top of the document.
    expect(document.activeElement).toBe(answerBody())
  })
})

describe('the bar\'s own geometry', () => {
  it('keeps the whole box inside a 360px window, and off its edge', () => {
    const placed = placeToolbar({ top: 200, left: 300, width: 40, height: 18 }, { width: 360, height: 700 })
    expect(placed.left).toBeGreaterThanOrEqual(VIEWPORT_EDGE)
    expect(placed.left + TOOLBAR_SIZE.width).toBeLessThanOrEqual(360 - VIEWPORT_EDGE)
    expect(placed.top).toBe(200 - TOOLBAR_SIZE.height - SELECTION_GAP)
  })

  it('sits above the text in a wide window, where there is room for it', () => {
    const placed = placeToolbar({ top: 400, left: 600, width: 240, height: 18 }, { width: 1280, height: 900 })
    expect(placed.left).toBe(600)
    expect(placed.top).toBe(400 - TOOLBAR_SIZE.height - SELECTION_GAP)
    expect(placed.left + TOOLBAR_SIZE.width).toBeLessThanOrEqual(1280 - VIEWPORT_EDGE)
  })

  it('turns below the selection when the top of the window has taken the space', () => {
    const placed = placeToolbar({ top: 4, left: 40, width: 120, height: 18 }, { width: 1280, height: 700 })
    expect(placed.top).toBe(4 + 18 + SELECTION_GAP)
  })

  it('stays inside the window at both narrow and wide when the selection is at the bottom edge', () => {
    for (const width of [360, 1280]) {
      const placed = placeToolbar({ top: 690, left: 10, width: 100, height: 10 }, { width, height: 700 })
      expect(placed.top).toBeGreaterThanOrEqual(VIEWPORT_EDGE)
      expect(placed.top + TOOLBAR_SIZE.height).toBeLessThanOrEqual(700 - VIEWPORT_EDGE)
      expect(placed.left).toBeGreaterThanOrEqual(VIEWPORT_EDGE)
      expect(placed.left + TOOLBAR_SIZE.width).toBeLessThanOrEqual(width - VIEWPORT_EDGE)
    }
  })
})
