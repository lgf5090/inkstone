// @vitest-environment jsdom
/**
 * The find loop over an open thread, told as the four things a reader can ask it for.
 *
 * The panel is the only surface in the chat that answers "where is the word I read five minutes ago", and
 * every one of its answers is a claim: how many hits there are, which one is being pointed at, what the
 * phrase the reader typed is matched against, and where their hands end up when the box closes. A claim
 * painted only in colour is not an answer a screen reader hears, and a page that reports no match while
 * the thread still has turns that were never loaded is an answer the reader acts on wrongly — the same
 * shape as the control that 404s when it is pointed at a page that is not the newest one.
 *
 * jsdom lays nothing out, so nothing here claims a scroll position was reached: every assertion is about
 * the marks in the tree, the text the live region speaks, the accessible name a control carries and the
 * callback a press is owed.
 */
import { act, createElement, type ReactNode, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantMessage } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { MAX_FIND_HITS } from './thread-find'
import { ThreadFinder } from './ThreadFinder'
import { ChatView } from './ChatView'
import { useAssistant } from './assistant-store'

type FinderProps = Parameters<typeof ThreadFinder>[0]

let root: Root
let host: HTMLElement
let scroller: HTMLDivElement
let scrollerRef: RefObject<HTMLElement | null>
let opener: HTMLButtonElement

function finderProps(over: Partial<FinderProps> = {}): FinderProps {
  return {
    scroller: scrollerRef,
    revision: 0,
    hasEarlier: false,
    hasLater: false,
    loadingEarlier: false,
    onLoadEarlier: () => undefined,
    onJumpLatest: () => undefined,
    onClose: () => undefined,
    ...over,
  }
}

function transcript(html: string): void {
  scroller.innerHTML = html
}

const field = () => host.querySelector<HTMLInputElement>('input[aria-label]')!
const region = () => host.querySelector<HTMLElement>('[aria-live="polite"]')
/** What the panel says out loud: the sentence assistive tech is handed, not the fraction it is shown. */
const spoken = () => region()?.querySelector('.sr-only')?.textContent ?? region()?.textContent ?? ''
// The marks live in the thread, which is the element the panel was handed — not in the panel itself.
const marks = () => [...scroller.querySelectorAll<HTMLElement>('[data-find-hit]')]
const currentMarks = () => marks().filter((mark) => mark.classList.contains('is-current'))
const stepper = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.getAttribute('aria-label') === label)
const named = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(text))

async function mount(props: FinderProps): Promise<void> {
  await act(async () => { root.render(createElement(ThreadFinder, props)) })
}

async function type(text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field(), text)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(key: string, init: KeyboardEventInit = {}): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => { field().dispatchEvent(event) })
}

async function click(node: Element | null | undefined, where: string): Promise<void> {
  expect(node, `${where} is not drawn`).toBeTruthy()
  await act(async () => { node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

/** Closes the panel the way its owner does: the box is unmounted, and the marks go with it. */
async function close(): Promise<void> {
  await act(async () => { root.unmount() })
  host.remove()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  scroller = document.createElement('div')
  document.body.append(scroller)
  scrollerRef = { current: scroller }
  opener = document.createElement('button')
  opener.type = 'button'
  opener.setAttribute('aria-label', 'the control that raised find')
  document.body.append(opener)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  scroller.remove()
  opener.remove()
  document.body.innerHTML = ''
  useAssistant.setState(originalState, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('what the panel claims about the hits', () => {
  it('counts them, and says out loud which one it is pointing at', async () => {
    transcript('<p>a plan here</p><p>another plan</p><p>the plan again</p>')
    await mount(finderProps())
    await type('plan')
    expect(marks(), 'the hits are not marked').toHaveLength(3)
    expect(region()?.getAttribute('aria-live'), 'the count is not a live region').toBe('polite')
    expect(region()?.textContent).toContain('1/3')
    expect(spoken(), 'the current hit is only told in colour').toBe(
      t('assistant.chat.find_position', { index: 1, count: 3 }),
    )
    await click(stepper(t('assistant.chat.find_next')), 'the next stepper')
    expect(currentMarks(), 'the second hit is not the one being pointed at').toHaveLength(1)
    expect(region()?.textContent).toContain('2/3')
    expect(spoken()).toBe(t('assistant.chat.find_position', { index: 2, count: 3 }))
  })

  it('says the count is a ceiling once it stopped marking, instead of passing it off as the total', async () => {
    transcript(`<p>${'plan '.repeat(MAX_FIND_HITS + 5)}</p>`)
    await mount(finderProps())
    await type('plan')
    expect(marks(), 'the panel marked past its own ceiling').toHaveLength(MAX_FIND_HITS)
    expect(spoken(), 'a capped count presented as a total').toBe(t('assistant.chat.find_capped', { count: MAX_FIND_HITS }))
    expect(region()?.textContent).toContain(`${MAX_FIND_HITS}+`)
  })

  it('says nothing until there is a phrase, and says no result for a phrase with no hit', async () => {
    transcript('<p>nothing here</p>')
    await mount(finderProps())
    expect(spoken(), 'an empty box is already reporting a result').toBe('')
    await type('  ')
    expect(spoken(), 'spaces are not a search').toBe('')
    await type('plan')
    expect(spoken()).toBe(t('assistant.chat.find_none'))
  })

  it('says so when the thread has turns that were never loaded, and hands over the way to reach them', async () => {
    transcript('<p>the first page, nothing the reader asked about</p>')
    const onLoadEarlier = vi.fn()
    await mount(finderProps({ hasEarlier: true, onLoadEarlier }))
    await type('plan')
    expect(spoken(), 'a page that is not the whole conversation was reported as no result').toBe(
      t('assistant.chat.find_unloaded'),
    )
    await click(named(t('assistant.chat.load_earlier')), 'the load-earlier control inside the panel')
    expect(onLoadEarlier, 'the panel’s load-earlier control reached nothing').toHaveBeenCalledTimes(1)
  })

  it('offers the newest page when the reader is standing in the middle of a thread', async () => {
    transcript('<p>a page from the middle of the thread</p>')
    const onJumpLatest = vi.fn()
    await mount(finderProps({ hasLater: true, onJumpLatest }))
    await type('plan')
    await click(named(t('assistant.chat.jump_latest')), 'the jump-to-latest control inside the panel')
    expect(onJumpLatest, 'the panel’s jump-latest control reached nothing').toHaveBeenCalledTimes(1)
  })

  it('claims nothing extra when the page on screen is the whole conversation', async () => {
    transcript('<p>the only page there is</p>')
    await mount(finderProps())
    await type('plan')
    expect(spoken()).toBe(t('assistant.chat.find_none'))
    expect(named(t('assistant.chat.load_earlier')), 'offered to load a page that does not exist').toBeUndefined()
    expect(named(t('assistant.chat.jump_latest')), 'offered to jump to a page that does not exist').toBeUndefined()
  })

  it('reaches the hit that lives on the page behind the one on screen', async () => {
    transcript('<p>the first page, nothing the reader asked about</p>')
    const props = finderProps({
      hasEarlier: true,
      onLoadEarlier: () => {
        transcript('<p>a plan from the older page</p><p>the first page, nothing the reader asked about</p>')
      },
    })
    await mount(props)
    await type('plan')
    expect(marks(), 'searched a page that holds nothing').toHaveLength(0)
    await click(named(t('assistant.chat.load_earlier')), 'the load-earlier control inside the panel')
    // The thread grew, so the view hands over a new revision — the same handoff a settled answer arrives on.
    await mount({ ...props, hasEarlier: false, revision: 1 })
    expect(marks(), 'the older page was loaded but never searched').toHaveLength(1)
    expect(spoken()).toBe(t('assistant.chat.find_position', { index: 1, count: 1 }))
  })
})

describe('stepping, and the keys that step', () => {
  it('walks forward on Enter and back on Shift+Enter, wrapping at both ends', async () => {
    transcript('<p>plan</p><p>plan</p>')
    await mount(finderProps())
    await type('plan')
    press('Enter')
    expect(region()?.textContent).toContain('2/2')
    press('Enter')
    expect(region()?.textContent).toContain('1/2')
    press('Enter', { shiftKey: true })
    expect(region()?.textContent).toContain('2/2')
  })

  it('names the two steppers, and takes them away when there is nothing to step through', async () => {
    transcript('<p>nothing here</p>')
    const props = finderProps()
    await mount(props)
    await type('plan')
    expect(stepper(t('assistant.chat.find_previous'))?.disabled, 'stepping with no hits is offered').toBe(true)
    expect(stepper(t('assistant.chat.find_next'))?.disabled, 'stepping with no hits is offered').toBe(true)
    // The older page arrived, so the thread handed the panel a new revision and the same phrase now hits.
    transcript('<p>a plan, and the plan below it</p>')
    await mount({ ...props, revision: 1 })
    expect(stepper(t('assistant.chat.find_previous'))?.disabled, 'the hits that arrived left the steppers off').toBe(false)
    await click(stepper(t('assistant.chat.find_previous')), 'the previous stepper')
    expect(region()?.textContent, 'stepping back from the first hit did not wrap to the last').toContain('2/2')
    expect(currentMarks(), 'the wrapped hit is not the one being pointed at').toHaveLength(1)
  })

  it('leaves a keystroke an input method is holding to the input method', async () => {
    transcript('<p>plan</p><p>plan</p>')
    await mount(finderProps())
    await type('plan')
    press('Enter', { isComposing: true })
    expect(region()?.textContent, 'a composing Enter moved the page under the reader').toContain('1/2')
  })
})

describe('what the box looks for', () => {
  it('ignores case, the way the conversation search the server runs ignores case', async () => {
    transcript('<p>The PLAN, and a plan.</p>')
    await mount(finderProps())
    await type('plan')
    expect(marks()).toHaveLength(2)
    await type('PLAN')
    expect(marks()).toHaveLength(2)
  })

  it('takes the phrase between its outer spaces, and nothing else off it', async () => {
    transcript('<p>a plan here</p>')
    await mount(finderProps())
    await type('  plan  ')
    expect(marks()).toHaveLength(1)
  })

  it('reads the phrase literally: no wildcard, no pattern, no reading of the Han', async () => {
    // The server answers a conversation search with a LIKE whose wildcards are escaped, and the app's
    // readings cover titles, headings and tags and never a body. The box has to be told the same way, or
    // the transcript and the list that led here disagree about what one phrase means.
    transcript('<p>abc a% and 演示模式</p>')
    await mount(finderProps())
    await type('a.c')
    expect(marks(), 'a dot was read as a wildcard').toHaveLength(0)
    await type('a%')
    expect(marks(), 'a percent was read as a wildcard').toHaveLength(1)
    await type('演示模式')
    expect(marks(), 'the words themselves are not matched').toHaveLength(1)
    await type('ysms')
    expect(marks(), 'a body is matched by reading, which the rest of the app only does for labels').toHaveLength(0)
  })
})

describe('closing the panel', () => {
  it('hands the keystroke back to the control that raised it', async () => {
    transcript('<p>plan</p>')
    opener.focus()
    await mount(finderProps())
    expect(document.activeElement, 'the box never took the keystroke').toBe(field())
    await close()
    expect(document.activeElement, 'closing left the reader nowhere to go on').toBe(opener)
  })

  it('hands it back when the close control is what closed it', async () => {
    transcript('<p>plan</p>')
    const onClose = vi.fn()
    opener.focus()
    await mount(finderProps({ onClose }))
    await click(stepper(t('common.close')), 'the close button')
    expect(onClose, 'the close control was not wired').toHaveBeenCalled()
    await close()
    expect(document.activeElement).toBe(opener)
  })

  it('does not chase focus into a control that is gone', async () => {
    transcript('<p>plan</p>')
    opener.focus()
    await mount(finderProps())
    // The thread was switched while the panel was open, and the header row that held the opener went with it.
    opener.remove()
    await close()
    expect(document.activeElement, 'focus was thrown at a detached node').toBe(document.body)
  })

  it('takes its marks out of the page it leaves behind', async () => {
    transcript('<p>a plan here</p>')
    await mount(finderProps())
    await type('plan')
    expect(marks()).toHaveLength(1)
    await close()
    expect(scroller.querySelectorAll('[data-find-hit]'), 'the reader closed onto a highlighted page').toHaveLength(0)
    expect(scroller.textContent).toBe('a plan here')
  })
})

// ---------------------------------------------------------------------------
// The same loop where a reader actually meets it: the whole view, the header's own control, and the
// store's pagination behind it.

const asked = vi.fn(async (_options: { title?: string, tone?: string }) => true)
vi.mock('../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/overlay')>()
  return { ...actual, confirm: (options: { title?: string, tone?: string }) => asked(options) }
})

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

// The stored answers are replaced by their own text: what is searched here is the transcript the view
// lays out, and a real bubble would drag half the reading surface in to say the same thing.
vi.mock('./MessageParts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./MessageParts')>()
  const AssistantBubble = ((props: { content?: string }): ReactNode =>
    createElement('div', { 'data-found-answer': true }, props.content ?? '')) as unknown as typeof actual.AssistantBubble
  return { ...actual, AssistantBubble }
})

vi.mock('../share/ConversationSharePanel', () => ({
  ConversationSharePanel: (() => null) as unknown,
}))

type AssistantState = ReturnType<typeof useAssistant.getState>
const originalState = useAssistant.getState()

function message(over: Partial<AssistantMessage>): AssistantMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'user',
    content: '',
    reasoning: '',
    tools: [],
    attachments: [],
    status: 'complete',
    error: null,
    createdAt: 1_700_000_000_000,
    source: 'chat',
    ...over,
  }
}

async function mountView(over: Partial<AssistantState> = {}): Promise<void> {
  useAssistant.setState({
    ...originalState,
    view: 'chat',
    activeId: 'c1',
    conversations: [
      { id: 'c1', title: 'First thread', updatedAt: 2 } as AssistantState['conversations'][number],
    ],
    messages: [message({ id: 'm-page', content: 'the first page has nothing the reader asked about' })],
    messagesReady: true,
    messagesHasMore: true,
    messagesHasNewer: false,
    messagesLoadingMore: false,
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
    loadMcpServers: vi.fn(async () => undefined),
    loadSkills: vi.fn(async () => undefined),
    loadTaxonomy: vi.fn(async () => undefined),
    loadFlagged: vi.fn(async () => undefined),
    setConversationQuery: vi.fn(async () => undefined),
    openConversation: vi.fn(async () => undefined),
    loadEarlierMessages: vi.fn(async () => undefined),
    ...over,
  } as Partial<AssistantState>)
  await act(async () => { root.render(createElement(ChatView)) })
}

const viewButtons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const findToggle = () => viewButtons().find((node) => node.getAttribute('aria-label') === t('assistant.chat.find'))
const findField = () =>
  document.body.querySelector<HTMLInputElement>(`input[aria-label="${t('assistant.chat.find')}"]`)
// The thread keeps its own polite region for a finished answer, so the panel's is read from the panel.
const viewRegion = () => document.querySelector<HTMLElement>('[role="search"] [aria-live="polite"]')

/** Opens the panel from the header control, the way a keyboard reader does it. */
async function raiseFind(): Promise<void> {
  const toggle = findToggle()
  expect(toggle, 'the header has no find control').toBeTruthy()
  toggle!.focus()
  await act(async () => {
    toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

async function typeIntoView(text: string): Promise<void> {
  expect(findField(), 'the find box is not up').toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(findField(), text)
    findField()!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the panel inside the thread it searches', () => {
  beforeEach(async () => {
    // The view owns the whole body, so this block starts from an empty one and its own root.
    act(() => root.unmount())
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  it('opens on the reader’s own chord and reports the header control as holding the panel', async () => {
    await mountView()
    const toggle = findToggle()
    expect(toggle, 'the header has no find control').toBeTruthy()
    expect(toggle?.getAttribute('aria-pressed'), 'the control does not say it is holding the panel').toBe('false')
    const chord = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })
    await act(async () => { document.querySelector('section')!.dispatchEvent(chord) })
    expect(findField(), 'the chord did not raise the panel').toBeTruthy()
    expect(findToggle()?.getAttribute('aria-pressed')).toBe('true')
  })

  it('returns the keystroke to the header control that raised it, through the panel’s own Escape', async () => {
    await mountView()
    const toggle = findToggle()!
    await raiseFind()
    expect(document.activeElement, 'the panel never took the keystroke').toBe(findField())
    await typeIntoView('plan')
    await act(async () => {
      findField()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(findField(), 'Escape left the panel up').toBeNull()
    expect(document.activeElement, 'the reader was dropped at the top of the document').toBe(toggle)
  })

  it('says the conversation is bigger than the page it searched, and pages through the store', async () => {
    const loadEarlierMessages = vi.fn(async () => {
      useAssistant.setState({
        messages: [
          message({ id: 'm-older', content: 'a plan from the older page' }),
          message({ id: 'm-page', content: 'the first page has nothing the reader asked about' }),
        ],
        messagesHasMore: false,
      })
    })
    await mountView({ loadEarlierMessages })
    await raiseFind()
    await typeIntoView('plan')
    expect(viewRegion()?.textContent, 'a longer conversation was reported as no result').toContain(
      t('assistant.chat.find_unloaded'),
    )
    const earlier = viewButtons().find((node) => node.textContent?.includes(t('assistant.chat.load_earlier')))
    await act(async () => {
      earlier!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(loadEarlierMessages, 'the panel’s load-earlier control is not the store’s').toHaveBeenCalled()
    const found = [...document.body.querySelectorAll<HTMLElement>('[data-find-hit]')]
    expect(found.map((mark) => mark.textContent), 'the page that was loaded was never searched again').toEqual(['plan'])
  })
})
