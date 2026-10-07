/**
 * What the deck adds to the shared pixel layer: the box a page is drawn in.
 *
 * The box is the part that broke. The export sheet declares its page width and height on itself
 * (`[data-deck-print] { --deck-page-width: … }`), and the layer serializes *one page* — an element
 * whose size came from an ancestor that is not in the picture. The page then had no box, its
 * `overflow: hidden` clipped it to nothing, and every exported PNG came out empty (N-24, measured).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as elementImage from '../../lib/element-image'
import { renderDeckPagePng } from './deck-image'

vi.mock('../../lib/element-image', () => ({
  collectDocumentCss: vi.fn(async () => 'body { color: red }'),
  renderElementPng: vi.fn(async () => new Blob(['png'])),
  saveImage: vi.fn(),
}))

const GEOMETRY = { width: 1280, height: 720, padX: 56, padY: 44 }

function page(): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = '<div class="deck-print-page"><p>Text</p></div>'
  return host.firstElementChild as HTMLElement
}

beforeEach(() => {
  vi.mocked(elementImage.renderElementPng).mockClear()
})

describe('renderDeckPagePng — the box a page is drawn in', () => {
  it('names the page box and its pads in the stylesheet the layer is handed', async () => {
    await renderDeckPagePng(page(), GEOMETRY, 'body { color: red }')
    const css = vi.mocked(elementImage.renderElementPng).mock.calls[0]?.[2] ?? ''
    expect(css).toContain('--deck-page-width:1280px')
    expect(css).toContain('--deck-page-height:720px')
    expect(css).toContain('--deck-pad-x:56px')
    expect(css).toContain('--deck-pad-y:44px')
  })
})
