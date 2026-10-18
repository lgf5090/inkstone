// @vitest-environment jsdom
/**
 * The transcript a stranger reads.
 *
 * A shared conversation carries four fields per turn — who spoke, what they said, when, which model
 * answered — and deliberately nothing about the vault behind it. So an answer that says
 * "the dates are in ![[Roadmap]]" names something this page can never open: no note body travels in the
 * payload, and there is no session to ask for one with. The renderer draws such a reference as work in
 * progress and only the embed pass, which reads the viewer's own notes, ever ends that; on this page the
 * pass never runs, and before the rule pinned below the box kept saying "Loading" for as long as the
 * reader stayed — a page still arriving, when the truth is a thing that will never arrive.
 *
 * The other half of the file is the reason the box cannot simply be given a vault: this is the second
 * privacy hole of exactly this shape. A published transcript once handed strangers the note citations,
 * private title and id included, in a source card. So what is pinned here is that the answer is a static
 * sentence and nothing else — no read of a note, no read of an attachment, no read of a conversation, no
 * id in the markup, no address into the notebook — while the words around the embed keep arriving.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { PublicConversation } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { ConversationSharePage } from './ConversationSharePage'

const { read } = vi.hoisted(() => ({
  /** Every vault read a share page must not start: a note body, an attachment, another conversation. */
  read: {
    note: vi.fn(async (_id: string) => ({ id: _id, title: 'Private Roadmap', content: '', rev: 1 })),
    fileByName: vi.fn(async () => ({ files: [] })),
    conversation: vi.fn(async () => { throw new Error('a stranger has no conversations to open') }),
    conversationShare: vi.fn(async () => ({} as unknown)),
  },
}))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      notes: { ...actual.api.notes, get: read.note },
      files: { ...actual.api.files, byName: read.fileByName },
      assistant: { ...actual.api.assistant, conversation: read.conversation },
      share: { ...actual.api.share, readConversation: read.conversationShare },
    },
  }
})

/** A note id of the shape the app mints, so a share page is caught by the same reader path the chat uses. */
const PRIVATE_NOTE_ID = '01jqz0000000000000000000zz'
const PRIVATE_TITLE = 'Private Roadmap'
const PRIVATE_BODY = 'Only the owner may read this line.'

const SHARED = [
  'The dates are in ![[Private Roadmap]].',
  '',
  '```ts',
  'const plan = "october"',
  '```',
  '',
  'And the plan itself: ![[Private Roadmap|the plan]].',
].join('\n')

const CONVERSATION: PublicConversation = {
  title: 'Planning the quarter',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  author: { name: 'Owner', avatarUrl: '' },
  site: { name: 'Inkstone' },
  share: { slug: 'abc123' },
  messages: [
    // The question's own words are shown verbatim, so a reference named here is the author's doing; the
    // turn below is the one drawn through the Markdown renderer, and the one that gets an embed box.
    { role: 'user', content: `What about [[${PRIVATE_TITLE}]]?`, createdAt: 1_700_000_000_000, modelLabel: '' },
    { role: 'assistant', content: SHARED, createdAt: 1_700_000_001_000, modelLabel: 'gpt-test' },
  ],
}

/** The viewer's own vault, present in the store: the page that shows a stranger a transcript must not read it. */
const VAULT_NOTE = {
  id: PRIVATE_NOTE_ID,
  title: PRIVATE_TITLE,
  folderId: null,
  rev: 1,
  updatedAt: 0,
  createdAt: 0,
  deletedAt: null,
  isStarred: false,
  tags: [],
}

let rendered: RenderedElement | null = null
let notesOriginal: unknown

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  notesOriginal = useNotes.getState()
  read.note.mockClear().mockImplementation(async (id: string) => ({ id, title: PRIVATE_TITLE, content: PRIVATE_BODY, rev: 1 }))
  read.fileByName.mockClear()
  read.conversation.mockClear()
  read.conversationShare.mockClear().mockImplementation(async () => CONVERSATION)
  // A body the vault really has, un-cached so any resolver that ran would have to reach for `api.notes.get`.
  useNotes.setState({ notes: { [PRIVATE_NOTE_ID]: VAULT_NOTE }, contents: {} } as never)
  rendered = renderElement(createElement(ConversationSharePage, { slug: 'abc123' }))
  // Every check below is taken after this, and the signal is chosen on purpose: `MarkdownBody` runs the
  // embed pass first and the enhancement pass after it, so a highlight that has landed is proof that a
  // page which was going to reach for a note body has already done so. Asserting one frame after the
  // mount would let a resolver that leaks win the race by losing it slowly.
  await vi.waitFor(() => expect(
    rendered!.container.querySelector('.code-block code .token'),
    `the transcript or its passes never arrived; embed boxes on screen: ${boxState()}`,
  ).toBeTruthy(), { timeout: 8_000, interval: 10 })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  useNotes.setState(notesOriginal as never, true)
  vi.restoreAllMocks()
})

/** How every embed box on the page describes itself, so a red case reads without going to find out. */
function boxState(): string {
  const boxes = [...rendered!.container.querySelectorAll<HTMLElement>('.note-embed')]
  if (!boxes.length) return 'none drawn'
  return boxes.map((box) => `${box.className.trim()} :: ${box.querySelector('.note-embed-body')?.textContent?.trim() ?? ''}`).join(' | ')
}

describe('a shared conversation that names a note', () => {
  it('answers the reference with a static sentence instead of a spinner', () => {
    const boxes = [...rendered!.container.querySelectorAll<HTMLElement>('.note-embed')]
    expect(boxes.length, 'the transcript lost the embed it was asked to show').toBe(2)
    for (const box of boxes) {
      expect(box.classList.contains('loading'), `an embed is still waiting: ${boxState()}`).toBe(false)
      expect(box.querySelector('[aria-busy="true"]'), `an embed claims work in progress: ${boxState()}`).toBeNull()
      expect(box.querySelector('.note-embed-body')?.textContent?.trim())
        .toBe(t('share.embedded_private_notes_are_not_included_in_public_shares'))
    }
    expect(rendered!.container.textContent, 'a share page left its reader watching a loader')
      .not.toContain(t('common.loading'))
  })

  it('shows the rest of the answer, aliases included', () => {
    // Only the box is answered; the sentence around it is what the author shared and stays verbatim.
    expect(rendered!.container.textContent).toContain('The dates are in')
    expect(rendered!.container.querySelector('.note-embed-head')?.textContent).toBe(PRIVATE_TITLE)
    expect([...rendered!.container.querySelectorAll('.note-embed-head')].at(-1)?.textContent).toBe('the plan')
  })

  it('never reaches for the viewer\'s vault to fill a reference in', () => {
    expect(read.note.mock.calls, 'a share page read a note body').toHaveLength(0)
    expect(read.fileByName.mock.calls, 'a share page looked up an attachment').toHaveLength(0)
    expect(read.conversation.mock.calls, 'a share page opened another conversation').toHaveLength(0)
  })

  it('keeps the private note out of the markup it hands a stranger', () => {
    const html = rendered!.container.innerHTML
    const text = rendered!.container.textContent ?? ''
    expect(html).not.toContain(PRIVATE_NOTE_ID)
    expect(text).not.toContain(PRIVATE_NOTE_ID)
    expect(text).not.toContain(PRIVATE_BODY)
    expect(rendered!.container.querySelector('a[href*="/n/"]'), 'a dead link into the notebook was published')
      .toBeNull()
    // The resolver hook is what points at a note, and nothing here is allowed to point at one.
    for (const box of rendered!.container.querySelectorAll<HTMLElement>('.note-embed')) {
      expect(box.hasAttribute('data-embed-target'), `an embed kept its target: ${boxState()}`).toBe(false)
    }
  })
})
