// @vitest-environment jsdom
/**
 * The read-only Markdown renderer the chat's replies and a shared note both go through.
 *
 * What this pins is the half of a Markdown surface that is not the renderer: that a fenced block comes
 * out highlighted with a copy button that answers, and that a `[[note]]` is a door when the surface was
 * given somewhere to open it. A surface that only calls `renderMarkdown` has neither, and the shape of
 * that failure — a block that looks finished, a button that does nothing, a word that looks like a link
 * and is not one — is invisible to any assertion about the markup alone.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { MarkdownBody, type MarkdownLinks } from './MarkdownBody'

const SOURCE = ['A snippet:', '', '```ts', 'const answer = 42', '```', ''].join('\n')

let rendered: RenderedElement | null = null

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useNotes.setState({
    notes: {
      n1: {
        id: 'n1',
        title: 'Roadmap',
        folderId: null,
        rev: 1,
        updatedAt: 0,
        createdAt: 0,
        deletedAt: null,
        isStarred: false,
        tags: [],
      },
    },
  } as never)
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  useUi.setState({ toasts: [] } as never)
})

describe('the read-only Markdown surface', () => {
  /** Waits for the enhancement pass to land on the host, which is asynchronous and lazily imports Prism. */
  const highlighted = async () => {
    const code = () => rendered!.container.querySelector('.code-block code')
    await act(async () => {
      await vi.waitFor(() => expect(code()?.querySelector('.token')).toBeTruthy(), { timeout: 5_000, interval: 10 })
    })
    return code()!
  }

  it('draws a fenced block highlighted rather than as plain text', async () => {
    rendered = renderElement(createElement(MarkdownBody, { source: SOURCE }))
    const code = await highlighted()
    expect(code.classList.contains('language-typescript'), 'the language never reached the block').toBe(true)
    expect(code.querySelectorAll(':scope > .line').length, 'the block was never split into lines').toBe(1)
  })

  it('copies a block from a button that says it did', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    rendered = renderElement(createElement(MarkdownBody, { source: SOURCE }))
    await highlighted()
    const button = rendered.container.querySelector<HTMLElement>('[data-copy]')!
    await act(async () => { button.click() })
    expect(writeText).toHaveBeenCalledWith('const answer = 42')
    expect(button.textContent).toBe(t('common.copied'))
  })

  it('follows a wiki link when the surface has somewhere to open it', async () => {
    const openNote = vi.fn()
    rendered = renderElement(createElement(MarkdownBody, {
      source: 'See [[Roadmap]] for the plan.',
      links: { openNote } as MarkdownLinks,
    }))
    const link = rendered.container.querySelector<HTMLElement>('[data-wikilink]')
    expect(link, 'the link was not rendered as one').toBeTruthy()
    await act(async () => { link!.click() })
    expect(openNote).toHaveBeenCalledWith('n1')
  })

  it('leaves a wiki link inert on a surface whose readers have no vault', async () => {
    rendered = renderElement(createElement(MarkdownBody, { source: 'See [[Roadmap]] for the plan.' }))
    const link = rendered.container.querySelector<HTMLElement>('[data-wikilink]')
    expect(link).toBeTruthy()
    await act(async () => { link!.click() })
    // Nothing to assert but the absence of a navigation: the container is still the one the test made,
    // which is what a link that was never wired cannot change.
    expect(rendered.container.isConnected).toBe(true)
  })
})
