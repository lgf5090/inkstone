// @vitest-environment jsdom
/**
 * The page a visitor with no account reads.
 *
 * It shares its renderer with the chat now, so what this pins is the half that is this page's own: the
 * access rules it folds into the markup before anything draws it, and that the body still arrives
 * enhanced — highlighted code behind a copy button — rather than as paragraphs of plain text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { PublicNote } from '@shared/types'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { SharePage } from './SharePage'

const NOTE: PublicNote = {
  title: 'Shared note',
  content: ['A snippet:', '', '```ts', 'const answer = 42', '```', '', '![[A private note]]', ''].join('\n'),
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
})
