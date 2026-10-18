// @vitest-environment jsdom
/**
 * The page a visitor with no account reads.
 *
 * It shares its renderer with the chat now, so what this pins is the half that is this page's own: the
 * access rules it folds into the markup before anything draws it, and that the body still arrives
 * enhanced — highlighted code behind a copy button — rather than as paragraphs of plain text.
 *
 * The second half is the promise those rules exist for. An author who pastes a mention the composer
 * wrote, or the notebook's own deep link, into a note they then share leaves a 26-character handle on a
 * page anybody can open — and a shared note is drawn by the same `MarkdownBody` as the rest of the app,
 * so nothing would take it out on its own. This is that path: the real page, mounted the way `App.tsx`
 * mounts it, read for the handle in every word and every attribute it hands out. The attachment address
 * is the one handle it must NOT take out, because that is the picture the author chose to share.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { PublicNote } from '@shared/types'
import { initI18n } from '../../lib/i18n'
import { decodeDataValue } from '../../lib/markdown/data-attr'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { SharePage } from './SharePage'

/** A note id of the shape the app mints, and an attachment id of the very same shape. */
const NOTE_ID = '01jqz0000000000000000000zz'
const FILE_ID = '01jqz1111111111111111111aa'

const NOTE: PublicNote = {
  title: 'Shared note',
  content: [
    'A snippet:',
    '',
    '```ts',
    'const answer = 42',
    '```',
    '',
    '![[A private note]]',
    '',
    // The two shapes a handle arrives in once the author picked a note with `@`, plus the address the
    // notebook's own “copy link” writes, plus a picture that really is shared.
    `As [[${NOTE_ID}|the roadmap]] says, and ![[${NOTE_ID}]] too.`,
    '',
    `[the note](/n/${NOTE_ID}) and [the picture](/api/files/${FILE_ID}).`,
    '',
    `![The plan](/api/files/${FILE_ID})`,
  ].join('\n'),
  updatedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  author: { name: 'Owner', avatarUrl: '' },
  site: { name: 'Inkstone' },
  share: { slug: 'abc123' },
}

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {
    status = 500
  },
  api: {
    share: { read: vi.fn(async () => NOTE) },
    files: { byName: vi.fn(async () => ({ files: [] })) },
  },
}))

let rendered: RenderedElement | null = null

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  useUi.setState({ toasts: [] } as never)
  document.body.innerHTML = ''
})

/** The one address a shared note is allowed to hand out: the attachment this very share was opened for. */
const ATTACHMENT_ADDRESS = /\/api\/files\/[0-9a-hjkmnp-tv-z]{26}/gi

/**
 * Every handle-shaped run on the page: its words, and every attribute of every element, read back out of
 * `b64.` first because that is how the renderer writes a wiki target.
 */
function handlesOnPage(): string[] {
  const found = new Set<string>()
  const values = [
    rendered!.container.textContent ?? '',
    ...[...rendered!.container.querySelectorAll<HTMLElement>('*')]
      .flatMap((element) => [...element.attributes].flatMap((attribute) => [attribute.value, decodeDataValue(attribute.value)])),
  ]
  for (const value of values) {
    for (const part of value.replace(ATTACHMENT_ADDRESS, '').split(/[^0-9a-hjkmnp-tv-z]+/i)) {
      if (part.length === 26) found.add(part)
    }
  }
  return [...found]
}

describe('a shared note', () => {
  it('draws its code highlighted, from the same renderer the chat uses', async () => {
    rendered = renderElement(createElement(SharePage, { slug: 'abc123' }))
    const code = () => rendered!.container.querySelector('.code-block code')
    await act(async () => { await Promise.resolve() })
    await vi.waitFor(() => expect(code()?.querySelector('.token')).toBeTruthy(), { timeout: 5_000, interval: 10 })
    expect(code()!.classList.contains('language-typescript')).toBe(true)
    expect(rendered.container.querySelector('[data-copy]'), 'the copy button went missing').toBeTruthy()
  })

  it('still answers an embedded note with the rule that a visitor has no vault', async () => {
    rendered = renderElement(createElement(SharePage, { slug: 'abc123' }))
    const embed = () => rendered!.container.querySelector<HTMLElement>('.note-embed')
    await act(async () => { await Promise.resolve() })
    await vi.waitFor(() => expect(embed()).toBeTruthy(), { timeout: 5_000, interval: 10 })
    expect(embed()!.classList.contains('error'), 'the embed was left waiting for something').toBe(true)
    expect(embed()!.hasAttribute('data-embed-target')).toBe(false)
  })

  it('hands a stranger no handle, in its words or in any attribute', async () => {
    rendered = renderElement(createElement(SharePage, { slug: 'abc123' }))
    await act(async () => { await Promise.resolve() })
    await vi.waitFor(() => expect(
      rendered!.container.querySelector('.code-block code .token'),
      'the shared body never arrived, so there is nothing to read',
    ).toBeTruthy(), { timeout: 8_000, interval: 10 })
    expect(handlesOnPage(), `a note handle reached the page: ${handlesOnPage().join(', ')}`).toEqual([])
    // Nothing left standing can be handed back to a resolver, and the notebook's own deep link is gone.
    expect(rendered.container.querySelector('a[href*="/n/"]')).toBeNull()
    for (const link of rendered.container.querySelectorAll<HTMLElement>('.wikilink')) {
      expect(link.hasAttribute('data-wikilink'), 'a mention kept the handle a resolver reads').toBe(false)
    }
    for (const box of rendered.container.querySelectorAll<HTMLElement>('.note-embed')) {
      expect(box.hasAttribute('data-embed-target'), 'an embed kept the handle a resolver reads').toBe(false)
    }
    // The alias the author wrote is what tells a reader which note was meant, so it stays.
    expect(rendered.container.querySelector('.wikilink')?.textContent?.trim()).toBe('the roadmap')
  })

  /**
   * The other half of the same rule: `addShareAccess` stamps the attachment address with the slug so the
   * visitor may read the file, and a privacy pass that erased every 26-character run would have erased
   * the picture with it.
   */
  it('keeps the attachment address it was asked to stamp', async () => {
    rendered = renderElement(createElement(SharePage, { slug: 'abc123' }))
    await act(async () => { await Promise.resolve() })
    await vi.waitFor(() => expect(
      rendered!.container.querySelector('img[src*="/api/files/"]'),
      'the shared picture did not arrive',
    ).toBeTruthy(), { timeout: 8_000, interval: 10 })
    const stamped = `/api/files/${FILE_ID}?share=abc123`
    // The author's own avatar is an <img> too, so this asks about the file the note names, not about
    // however many pictures the page happens to draw.
    const image = rendered!.container.querySelector<HTMLImageElement>('img[src*="/api/files/"]')
    expect(image?.getAttribute('src'), 'the share gate never reached the attachment address').toContain(stamped)
    const linked = [...rendered!.container.querySelectorAll<HTMLAnchorElement>('a[href]')]
      .find((anchor) => anchor.getAttribute('href')?.includes('/api/files/'))
    expect(linked?.getAttribute('href'), 'a shared file link was dropped or left unstamped').toContain(stamped)
  })
})
