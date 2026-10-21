// @vitest-environment jsdom
/**
 * A `[[sub:…]]` mention in a surface that has both a vault and a money app.
 *
 * The renderer resolves a wiki link by title, so before the prefix meant anything a click on a plan the
 * reader already pays for was answered with "create a note called `sub:Netflix`" — a junk document made out
 * of one click, and the label in the bubble showed the syntax rather than the name. Both halves are pinned
 * here: what the reader reads, and what the click is allowed to do.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { decodeDataValue } from '../../lib/markdown/data-attr'
import { useNotes } from '../../store/notes'
import { MarkdownBody, type MarkdownLinks } from './MarkdownBody'

let rendered: RenderedElement | null = null
const openNote = vi.fn()
const createNote = vi.fn()
const openSubscription = vi.fn()

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useNotes.setState({
    notes: {
      n1: { id: 'n1', title: 'Roadmap', folderId: null, rev: 1, updatedAt: 0, createdAt: 0, deletedAt: null },
    },
  } as never)
  openNote.mockClear()
  createNote.mockClear()
  openSubscription.mockClear()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
})

function links(): MarkdownLinks {
  return { openNote, createNote, openSubscription }
}

function linkAt(index: number): HTMLElement {
  const link = rendered!.container.querySelectorAll<HTMLElement>('[data-wikilink]')[index]
  expect(link, `the ${index}th wiki link was not rendered as one`).toBeTruthy()
  return link
}

describe('a subscription mention in a chat body', () => {
  it('is labelled with the plan\'s name, not the syntax', () => {
    rendered = renderElement(createElement(MarkdownBody, { source: '看 [[sub:Netflix]] 什么时候到期', links: links() }))
    const link = linkAt(0)
    expect(link.textContent).toBe('Netflix')
    // The attribute is stored encoded, so the test reads it back with the same decoder the click uses.
    expect(decodeDataValue(link.dataset.wikilink), 'the target keeps the prefix, the click needs it').toBe('sub:Netflix')
  })

  it('hands the click to the money app instead of inventing a note', async () => {
    rendered = renderElement(createElement(MarkdownBody, { source: '看 [[sub:Netflix]] 什么时候到期', links: links() }))
    await act(async () => { linkAt(0).click() })
    expect(openSubscription).toHaveBeenCalledWith('Netflix')
    expect(createNote, 'a subscription mention must never become a note titled with its own syntax').not.toHaveBeenCalled()
    expect(openNote, 'and not a note lookup either').not.toHaveBeenCalled()
  })

  it('still opens a real note beside it', async () => {
    rendered = renderElement(createElement(MarkdownBody, { source: '[[sub:Netflix]] 与 [[Roadmap]]', links: links() }))
    await act(async () => { linkAt(1).click() })
    expect(openNote).toHaveBeenCalledWith('n1')
    expect(openSubscription).not.toHaveBeenCalled()
  })

  it('says nothing at all on a surface that was never given the money app', async () => {
    // The notebook's preview passes no links, so a mention there is a word rather than a broken door.
    rendered = renderElement(createElement(MarkdownBody, { source: '看 [[sub:Netflix]]', links: { openNote } }))
    await act(async () => { linkAt(0).click() })
    expect(createNote).not.toHaveBeenCalled()
    expect(openNote).not.toHaveBeenCalled()
  })
})
