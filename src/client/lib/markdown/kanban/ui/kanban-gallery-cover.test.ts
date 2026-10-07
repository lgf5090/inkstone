/**
 * The gallery is a scrolling grid of cards whose covers are full-size files stored per card, so a
 * board with fifty image cards used to ask the browser for fifty downloads the moment it painted the
 * first row. These cases pin the two attributes that make the grid load what the reader can reach —
 * the same pair `lib/markdown/renderer/media.ts` sets for images in a note body — and keep the
 * no-image case rendering a placeholder rather than an `<img>`, so the assertions cannot pass on a
 * grid that simply never drew a cover.
 *
 * A cover is a URL out of the same untrusted document the prose images come from, so one case here
 * pins the referrer policy that keeps an external cover from naming the page it was drawn on.
 */
import { createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { KanbanGalleryView } from './kanban-gallery-view'
import type { KanbanData, KanbanItem } from '../types'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const rendered: { unmount: () => void }[] = []

afterEach(() => {
  while (rendered.length)
    rendered.pop()!.unmount()
})

function galleryWith(items: KanbanItem[]): HTMLElement {
  const data: KanbanData = {
    columns: [{ id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] }],
    items,
    views: [{ id: 'v-gallery', name: 'Gallery', type: 'gallery', groupBy: 'status' }],
  }
  const view = renderElement(createElement(KanbanGalleryView, {
    data,
    selectedIds: new Set<string>(),
    onToggleSelect: vi.fn(),
    onOpenDetail: vi.fn(),
    onAddItem: vi.fn(),
  }))
  rendered.push(view)
  return view.container
}

function itemWith(overrides: Partial<KanbanItem>): KanbanItem {
  return { id: overrides.id ?? 'card', title: 'Cover card', properties: { status: 'todo' }, ...overrides }
}

describe('kanban gallery cover loading', () => {
  it('defers a set cover until the card is near the viewport', () => {
    const image = galleryWith([itemWith({ cover: '/api/kanban/file/default/a.png' })])
      .querySelector('img')
    expect(image, 'the card has a cover but no image was rendered').not.toBeNull()
    expect(image!.getAttribute('loading')).toBe('lazy')
    expect(image!.getAttribute('decoding')).toBe('async')
    expect(image!.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('defers the cover picked off the card’s files just the same', () => {
    const image = galleryWith([itemWith({ files: [{ id: 'f1', name: 'shot.jpg', size: 2048, mime: 'image/jpeg', url: '/api/kanban/file/default/b.jpg' }] })])
      .querySelector('img')
    expect(image, 'an image file is the cover but no image was rendered').not.toBeNull()
    expect(image!.getAttribute('loading')).toBe('lazy')
    expect(image!.getAttribute('decoding')).toBe('async')
  })

  it('hands a cover on another origin no referrer', () => {
    const image = galleryWith([itemWith({ cover: 'https://tracker.example.test/pixel.png' })])
      .querySelector('img')
    expect(image, 'an external cover was not rendered at all').not.toBeNull()
    expect(image!.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('renders a same-origin cover too', () => {
    const grid = galleryWith([itemWith({ cover: '/api/kanban/file/default/self.png' })])
    expect(grid.querySelector('img')).not.toBeNull()
  })

  it('keeps a card without any image free of an img element', () => {
    const grid = galleryWith([itemWith({ title: 'Text only' })])
    expect(grid.querySelector('img')).toBeNull()
    expect(grid.textContent).toContain('Text only')
  })
})
