// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoLinkMetadata } from '@shared/memos/types'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { MemoLinkPreviews, type MemoLinkPreviewsProps } from './MemoLinkPreviews'

const linkMeta = vi.hoisted(() => ({ fetchMemoLinkMetadata: vi.fn() }))

vi.mock('../link-meta-client', () => linkMeta)

let view: RenderedElement | null = null

function render(props: MemoLinkPreviewsProps): RenderedElement {
  view = renderElement(createElement(MemoLinkPreviews, props))
  return view
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function previewLink(container: HTMLElement, url: string): HTMLAnchorElement | null {
  return container.querySelector<HTMLAnchorElement>(`a[href="${url}"]`)
}

beforeEach(async () => {
  await initI18n()
  linkMeta.fetchMemoLinkMetadata.mockReset()
  linkMeta.fetchMemoLinkMetadata.mockResolvedValue([])
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the memo link previews', () => {
  it('fetches bare URLs and renders a compact card', async () => {
    const item: MemoLinkMetadata = {
      url: 'https://example.com/post',
      title: 'Example post',
      description: 'What the page is about',
      image: 'https://cdn.example.com/og.png',
    }
    linkMeta.fetchMemoLinkMetadata.mockResolvedValue([item])
    const rendered = render({ content: 'Read https://example.com/post today' })

    expect(linkMeta.fetchMemoLinkMetadata).toHaveBeenCalledWith(
      ['https://example.com/post'],
      expect.any(AbortSignal),
    )
    await flush()

    const anchor = previewLink(rendered.container, item.url)
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('target')).toBe('_blank')
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(anchor?.textContent).toContain('Example post')
    expect(anchor?.textContent).toContain('What the page is about')
    expect(anchor?.textContent).toContain('example.com')
    expect(anchor?.querySelector('img')?.getAttribute('src')).toBe(item.image)
  })

  it('shows a skeleton until metadata arrives', async () => {
    let resolveFetch!: (items: MemoLinkMetadata[]) => void
    linkMeta.fetchMemoLinkMetadata.mockReturnValue(new Promise((resolve) => {
      resolveFetch = resolve
    }))
    const rendered = render({ content: 'https://slow.test/page' })

    expect(rendered.container.textContent).toContain(t('memos.link_preview.loading'))
    expect(rendered.container.querySelector('.skeleton')).not.toBeNull()

    await act(async () => {
      resolveFetch([{ url: 'https://slow.test/page', title: 'Slow page', description: '', image: '' }])
    })
    expect(rendered.container.textContent).toContain('Slow page')
    expect(rendered.container.querySelector('.skeleton')).toBeNull()
  })

  it('falls back to a plain link when the fetch fails', async () => {
    linkMeta.fetchMemoLinkMetadata.mockRejectedValue(new Error('offline'))
    const rendered = render({ content: 'https://failed.test/page' })
    await flush()

    const anchor = previewLink(rendered.container, 'https://failed.test/page')
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('target')).toBe('_blank')
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(anchor?.textContent).toContain('https://failed.test/page')
    expect(anchor?.querySelector('img')).toBeNull()
  })

  it('falls back per URL when the page has no metadata', async () => {
    linkMeta.fetchMemoLinkMetadata.mockResolvedValue([
      { url: 'https://empty.test/page', title: '', description: '', image: '' },
    ])
    const rendered = render({ content: 'https://empty.test/page' })
    await flush()

    expect(rendered.container.textContent).toContain('https://empty.test/page')
    expect(rendered.container.querySelector('img')).toBeNull()
  })

  it('never loads a non-https preview image', async () => {
    linkMeta.fetchMemoLinkMetadata.mockResolvedValue([
      {
        url: 'https://mixed.test/page',
        title: 'Mixed',
        description: '',
        image: 'http://insecure.test/og.png',
      },
    ])
    const rendered = render({ content: 'https://mixed.test/page' })
    await flush()

    expect(rendered.container.textContent).toContain('Mixed')
    expect(rendered.container.querySelector('img')).toBeNull()
  })

  it('hides itself when the preference is off and when the content has no URL', async () => {
    const content = 'https://example.com/post'
    const rendered = render({ content, enabled: false })
    await flush()
    expect(linkMeta.fetchMemoLinkMetadata).not.toHaveBeenCalled()
    expect(rendered.container.querySelector('[data-memo-link-previews]')).toBeNull()

    rendered.rerender(createElement(MemoLinkPreviews, { content, enabled: true }))
    await flush()
    expect(rendered.container.querySelector('[data-memo-link-previews]')).not.toBeNull()

    rendered.rerender(createElement(MemoLinkPreviews, { content, enabled: false }))
    expect(rendered.container.querySelector('[data-memo-link-previews]')).toBeNull()

    linkMeta.fetchMemoLinkMetadata.mockClear()
    rendered.rerender(createElement(MemoLinkPreviews, { content: '`https://inline.test/a`' }))
    await flush()
    expect(linkMeta.fetchMemoLinkMetadata).not.toHaveBeenCalled()
    expect(rendered.container.querySelector('[data-memo-link-previews]')).toBeNull()
  })

  it('does not preview a URL already shown as an attachment', async () => {
    const rendered = render({
      content: 'https://a.test/file.png https://b.test/page',
      excludeUrls: ['https://a.test/file.png'],
    })
    await flush()

    expect(linkMeta.fetchMemoLinkMetadata).toHaveBeenCalledWith(
      ['https://b.test/page'],
      expect.any(AbortSignal),
    )
    expect(rendered.container.textContent).not.toContain('https://a.test/file.png')
  })
})
