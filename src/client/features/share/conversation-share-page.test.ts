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
 *
 * The third hole of the same shape is the one a box does not explain: an author's `@` pick is written as
 * `[[<id>|Title]]`, so a user turn shown verbatim and an assistant wikilink shown as an alias both left
 * the 26-character handle on a public page — in text, or in `data-wikilink`. An id is not a word a reader
 * needed, and it is exactly what another entry point can be aimed with, so the handle goes and the alias
 * the author already wrote stays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { PublicConversation } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { decodeDataValue } from '../../lib/markdown/data-attr'
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
/** The one sentence a mention whose only name is its id is allowed to be answered with. */
const PRIVATE_REFERENCE_KEY = 'share.private_note_reference_is_not_included_in_public_shares'

const SHARED = [
  'The dates are in ![[Private Roadmap]].',
  '',
  '```ts',
  'const plan = "october"',
  '```',
  '',
  'And the plan itself: ![[Private Roadmap|the plan]].',
  '',
  // The same reference aimed at a note by its id instead of its title, with and without an alias. The
  // alias is a word the reader can use; the handle is what another entry point can be attacked with.
  `The roadmap is [[${PRIVATE_NOTE_ID}|the roadmap]], see also [[${PRIVATE_NOTE_ID}]].`,
  '',
  // Three things the fix must leave alone: a wiki-link-looking string inside a code span, an ordinary
  // Markdown link, and brackets that name nothing.
  'A literal `[[Private Roadmap]]` stays, [the roadmap](https://example.com/roadmap) stays a link, and a bracket [note] is text.',
  '',
  // A box whose only name is the handle: the renderer shows the target as its own heading, and that
  // heading is the part which has to change.
  `The schedule: ![[${PRIVATE_NOTE_ID}]].`,
  '',
  // Positions the two structural passes never see: a mention quoted in a code span, one with a heading
  // glued to the handle, and the notebook's own deep link pasted as an ordinary address.
  `Quoted: \`[[${PRIVATE_NOTE_ID}|the roadmap]]\`, headed: [[${PRIVATE_NOTE_ID}#Heading]], deep link: [the note](/n/${PRIVATE_NOTE_ID}).`,
].join('\n')

const CONVERSATION: PublicConversation = {
  title: 'Planning the quarter',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  author: { name: 'Owner', avatarUrl: '' },
  site: { name: 'Inkstone' },
  share: { slug: 'abc123' },
  messages: [
    // A user turn is shown verbatim, so a mention the author typed themselves carries whatever they put
    // in it — including the id the composer writes for an `@` pick. The turn below is the one drawn
    // through the Markdown renderer, and the one that gets an embed box.
    {
      role: 'user',
      content: `What about [[${PRIVATE_NOTE_ID}|${PRIVATE_TITLE}]]? And [[${PRIVATE_TITLE}]] itself? `
        + `The bare one: [[${PRIVATE_NOTE_ID}]] and the headed one: [[${PRIVATE_NOTE_ID}#Heading]].`,
      createdAt: 1_700_000_000_000,
      modelLabel: '',
    },
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

/**
 * Every handle-shaped run the page hands a stranger, read out of its words and out of every attribute.
 *
 * A shape rather than the one id this file happens to use, because the promise is about the kind of thing
 * that must not go out: 26 characters of the alphabet the app mints its note addresses from. `b64.` values
 * are read back first, since that is how the renderer writes a wiki target and a handle inside base64 is
 * the same handle — and an attribute is as much a leak as a sentence, whatever it is called.
 */
function handlesOnPage(): string[] {
  const found = new Set<string>()
  for (const value of [
    rendered!.container.textContent ?? '',
    ...[...rendered!.container.querySelectorAll<HTMLElement>('*')]
      .flatMap((element) => [...element.attributes].flatMap((attribute) => [attribute.value, decodeDataValue(attribute.value)])),
  ]) {
    for (const part of value.split(/[^0-9a-hjkmnp-tv-z]+/i)) {
      if (part.length === 26) found.add(part)
    }
  }
  return [...found]
}

describe('a shared conversation that names a note', () => {
  it('answers the reference with a static sentence instead of a spinner', () => {
    const boxes = [...rendered!.container.querySelectorAll<HTMLElement>('.note-embed')]
    expect(boxes.length, 'the transcript lost the embed it was asked to show').toBe(3)
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
    const heads = [...rendered!.container.querySelectorAll('.note-embed-head')].map((head) => head.textContent?.trim())
    // A box named by title keeps the title; one whose only name was the handle is answered with the
    // sentence, because a heading reading `01jq…` is a handle painted where a name should be.
    expect(heads, 'a box named by title lost its title').toContain(PRIVATE_TITLE)
    expect(heads, 'a box that carried its alias lost it').toContain('the plan')
    expect(heads, 'a box named only by its handle kept the handle').toContain(t(PRIVATE_REFERENCE_KEY))
  })

  it('never reaches for the viewer\'s vault to fill a reference in', () => {
    expect(read.note.mock.calls, 'a share page read a note body').toHaveLength(0)
    expect(read.fileByName.mock.calls, 'a share page looked up an attachment').toHaveLength(0)
    expect(read.conversation.mock.calls, 'a share page opened another conversation').toHaveLength(0)
  })

  it('keeps the private note out of the markup it hands a stranger', () => {
    expect(handlesOnPage(), `a note handle reached the page: ${handlesOnPage().join(', ')}`).toEqual([])
    expect(rendered!.container.innerHTML, 'a note id was published in the markup').not.toContain(PRIVATE_NOTE_ID)
    expect(rendered!.container.textContent, 'a note body was published').not.toContain(PRIVATE_BODY)
    expect(rendered!.container.querySelector('a[href*="/n/"]'), 'a dead link into the notebook was published')
      .toBeNull()
    // The resolver hook is what points at a note, and nothing here is allowed to point at one.
    for (const box of rendered!.container.querySelectorAll<HTMLElement>('.note-embed')) {
      expect(box.hasAttribute('data-embed-target'), `an embed kept its target: ${boxState()}`).toBe(false)
    }
    for (const link of rendered!.container.querySelectorAll<HTMLElement>('.wikilink')) {
      expect(link.hasAttribute('data-wikilink'), 'a wikilink kept its target').toBe(false)
    }
  })

  it('keeps the words a reader could already use when the handle goes', () => {
    // The alias is what the author wrote for a human to read, so redacting the id must not take it too —
    // and it has to survive in the link that carried it, not merely somewhere on the page.
    const labels = [...rendered!.container.querySelectorAll<HTMLElement>('.wikilink')]
      .map((link) => link.textContent?.trim())
    expect(labels, 'an id-named mention lost the alias the author wrote').toContain('the roadmap')
    // A mention with no human-readable name is answered with one honest sentence, not a bare handle.
    expect(labels, 'a bare id mention was left with its handle').toContain(t(PRIVATE_REFERENCE_KEY))
    const question = [...rendered!.container.querySelectorAll<HTMLElement>('li')]
      .find((item) => item.className.includes('justify-end'))?.textContent ?? ''
    // The question is drawn as text, not Markdown, so every shape there is redacted in place: the alias
    // stays, a mention with nothing but the handle is answered, and one named by title is left alone.
    expect(question, 'a mention the author named by title was rewritten too').toContain(`[[${PRIVATE_TITLE}]]`)
    expect(question, 'an alias the author wrote was taken with the handle').toContain(PRIVATE_TITLE)
    expect(question, 'a bare handle survived the user turn').not.toContain('[[01jqz')
    expect(question, 'a handle with a heading glued to it survived the user turn').not.toContain('#Heading]]')
    expect(question).toContain(t(PRIVATE_REFERENCE_KEY))
    // A deep link pasted as ordinary prose is the notebook's own address; the words describing it are not.
    const code = [...rendered!.container.querySelectorAll('.ink-chat-prose code')]
    expect(code.some((node) => (node.textContent ?? '').includes('01jqz')), 'a code block kept the handle')
      .toBe(false)
    const quoted = code.find((node) => node.textContent?.includes('the roadmap'))
    expect(quoted, 'a quoted mention lost its alias along with the handle').toBeTruthy()
    const deep = [...rendered!.container.querySelectorAll<HTMLAnchorElement>('.ink-chat-prose a')]
      .find((anchor) => anchor.textContent?.trim() === 'the note')
    expect(deep, 'the words of the pasted deep link were eaten with the address').toBeTruthy()
    expect(deep?.hasAttribute('href'), 'a share page still points into the notebook').toBe(false)
  })

  it('leaves content that is not a private reference alone', () => {
    const text = rendered!.container.textContent ?? ''
    expect(text, 'a code span lost the wiki-link-looking text it quotes').toContain('[[Private Roadmap]]')
    expect(text).toContain('const plan = "october"')
    expect(text, 'an ordinary link lost its words').toContain('a bracket [note] is text')
    const external = rendered!.container.querySelector<HTMLAnchorElement>('a[href="https://example.com/roadmap"]')
    expect(external, 'a public share rewrote or ate an ordinary markdown link').toBeTruthy()
    expect(external!.getAttribute('href')).toBe('https://example.com/roadmap')
    // A reference the author named by title is theirs and stays; only the id is the thing that goes.
    expect(rendered!.container.querySelector('.note-embed-head')?.textContent).toBe(PRIVATE_TITLE)
  })
})
