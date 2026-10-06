/**
 * The layer every pixel export goes through: an element is serialized into an SVG that carries the
 * document's stylesheet, loaded as an image, and drawn into a canvas. What has to travel inside that
 * SVG is not only its markup — a canvas's pixels are not markup at all, and an `<img>`'s bytes are
 * in another document — and N-24 measured both of those failing quietly: the exported page drew a
 * broken-image glyph where the slide had a picture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElementPng } from './element-image'

const GEOMETRY = { width: 1280, height: 720 }
const DATA_URL_PREFIX = 'data:image/svg+xml;charset=utf-8,'

let handed: string[] = []
let drawn: { canvas: HTMLCanvasElement; width: number; height: number }[] = []

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(value: string) {
    handed.push(value)
    window.setTimeout(() => this.onload?.(), 0)
  }
}

/**
 * The SVG the layer handed the browser, back out of the URL it travelled in. A data URL specifically:
 * an object URL was tried and measured (N-24) — an SVG loaded from `blob:` counts as cross-origin to
 * the canvas, which then refuses to encode a thing.
 */
function svgOf(index: number): string {
  const url = handed[index]
  if (!url) throw new Error(`no picture was handed to the browser (only ${handed.length})`)
  if (!url.startsWith(DATA_URL_PREFIX)) throw new Error(`the picture travelled as ${url.slice(0, 24)}`)
  return decodeURIComponent(url.slice(DATA_URL_PREFIX.length))
}

// Everything the layer serializes is a container with content inside it — a page, a board — and the
// clone walks the element's *descendants*, so the fixture has to wrap what it asks about.
function page(markup: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = `<section>${markup}</section>`
  return host.firstElementChild as HTMLElement
}

beforeEach(() => {
  handed = []
  drawn = []
  vi.stubGlobal('Image', FakeImage)
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    drawn.push({ canvas: this, width: this.width, height: this.height })
    return { drawImage: vi.fn() } as never
  } as typeof HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.toBlob = ((callback: (blob: Blob | null) => void) => {
    callback(new Blob(['png-bytes'], { type: 'image/png' }))
  }) as never
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('renderElementPng — what travels into the picture', () => {
  it('hands the browser an svg of the element with the stylesheet beside it', async () => {
    const blob = await renderElementPng(page('<p class="hello">Text</p>'), GEOMETRY, '.hello { color: red }')
    expect(blob).toBeInstanceOf(Blob)
    const svg = svgOf(0)
    expect(svg).toContain('Text')
    expect(svg).toContain('.hello { color: red }')
    expect(svg).toContain('width="1280"')
  })

  it('carries an image on the page as bytes, not as a url', async () => {
    await renderElementPng(page('<p>x</p><img src="/icons/app.png" alt="Icon">'), GEOMETRY, '')
    const svg = svgOf(0)
    expect(svg).not.toContain('src="/icons/app.png"')
    expect(svg).toContain('src="data:')
  })

  // An image that cannot be read keeps its URL, which the SVG cannot resolve: the export loses that
  // one picture and says so in the log, rather than failing the whole export over a broken link.
  it('leaves an image it could not read alone, and says so', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'))
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await renderElementPng(page('<img src="/icons/app.png" alt="Icon">'), GEOMETRY, '')
    expect(svgOf(0)).toContain('src="/icons/app.png"')
    expect(warned).toHaveBeenCalled()
  })

  // An inline image is already bytes. Fetching it again would be the export paying to re-read
  // what it is holding, and a data URL is not something `fetch` can answer.
  it('does not go looking for an image that is already in the markup', async () => {
    await renderElementPng(page('<img src="data:image/png;base64,INLINE" alt="Icon">'), GEOMETRY, '')
    expect(fetch).not.toHaveBeenCalled()
    expect(svgOf(0)).toContain('src="data:image/png;base64,INLINE"')
  })

})

describe('renderElementPng — the canvas it draws into', () => {
    it('swaps a canvas for a still of itself', async () => {
    const host = document.createElement('div')
    host.innerHTML = '<canvas width="10" height="10"></canvas>'
    const live = host.querySelector('canvas')
    if (!live) throw new Error('the fixture lost its canvas')
    live.toDataURL = () => 'data:image/png;base64,STILL'
    await renderElementPng(host, GEOMETRY, '')
    const svg = svgOf(0)
    expect(svg).toContain('data:image/png;base64,STILL')
    expect(svg).not.toContain('<canvas')
  })

  it('draws the page into a canvas of its own, at twice the page box', async () => {
    await renderElementPng(page('<p>Text</p>'), GEOMETRY, '')
    expect(drawn).toHaveLength(1)
    expect(drawn[0]?.width).toBe(2560)
    expect(drawn[0]?.height).toBe(1440)
  })
})
