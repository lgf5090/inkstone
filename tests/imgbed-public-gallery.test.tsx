// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { ImagePreview, PublicApp } from '../src/client/features/imgbed/public/PublicApp'

interface TouchPoint { clientX: number; clientY: number }

function touchEvent(type: string, touches: TouchPoint[], changed: TouchPoint[] = []): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', { value: touches })
  Object.defineProperty(event, 'changedTouches', { value: changed })
  return event
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

let rendered: RenderedElement | null = null

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  installTestGlobals()
  window.history.replaceState({}, '', '/imgbed/browse/')
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.unstubAllGlobals()
})

describe('public gallery', () => {
  it('lays files out in the shared 4/3 grid instead of CSS columns', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/imgbed/public/config')) return jsonResponse({ enabled: true })
      return jsonResponse({
        files: [{ name: 'photo.png', metadata: { FileType: 'image/png', TimeStamp: 1_700_000_000_000, FileSize: '1.2' } }],
        directories: ['sub/'],
        totalCount: 1,
        allowedDirs: [],
      })
    }))
    rendered = renderElement(createElement(PublicApp))
    for (let attempt = 0; attempt < 20 && !rendered.container.querySelector('img'); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    }
    const { container } = rendered
    expect(container.querySelector('.columns-2')).toBeNull()
    const image = container.querySelector('img')
    expect(image).not.toBeNull()
    expect(image?.getAttribute('alt')).toBe('')
    expect(image?.className).toContain('object-cover')
    const media = image?.parentElement
    expect(media?.className).toContain('aspect-[4/3]')
    expect(media?.parentElement?.tagName).toBe('BUTTON')
    expect(container.textContent).toContain('sub')
  })
})

describe('image preview pinch', () => {
  function mountPreview(): { surface: HTMLElement; image: HTMLImageElement; onNext: ReturnType<typeof vi.fn>; onPrev: ReturnType<typeof vi.fn> } {
    const onNext = vi.fn()
    const onPrev = vi.fn()
    rendered = renderElement(createElement(ImagePreview, { url: '/imgbed/file/a.png', alt: 'a.png', onPrev, onNext }))
    const image = rendered.container.querySelector('img') as HTMLImageElement
    return { surface: image.parentElement as HTMLElement, image, onNext, onPrev }
  }

  function pinch(surface: HTMLElement, from: [TouchPoint, TouchPoint], to: [TouchPoint, TouchPoint]): void {
    act(() => { surface.dispatchEvent(touchEvent('touchstart', from)) })
    act(() => { surface.dispatchEvent(touchEvent('touchmove', to)) })
  }

  it('scales with the finger distance, pans by the midpoint and clamps to 0.5–5x', () => {
    const { surface, image } = mountPreview()
    expect(image.style.transform).toContain('scale(1)')
    pinch(surface, [{ clientX: 150, clientY: 200 }, { clientX: 250, clientY: 200 }], [{ clientX: 100, clientY: 200 }, { clientX: 300, clientY: 200 }])
    expect(image.style.transform).toContain('scale(2)')
    expect(image.style.transform).toContain('translate(0px, 0px)')
    act(() => { surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 100, clientY: 200 }, { clientX: 300, clientY: 210 }])) })
    expect(image.style.transform).toContain('translate(0px, 5px)')
    act(() => { surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 225, clientY: 200 }, { clientX: 225, clientY: 200 }])) })
    expect(image.style.transform).toContain('scale(0.5)')
    act(() => { surface.dispatchEvent(touchEvent('touchmove', [{ clientX: 0, clientY: 200 }, { clientX: 2000, clientY: 200 }])) })
    expect(image.style.transform).toContain('scale(5)')
  })

  it('does not treat the end of a pinch as a horizontal swipe', () => {
    const { surface, onNext, onPrev } = mountPreview()
    pinch(surface, [{ clientX: 200, clientY: 200 }, { clientX: 300, clientY: 200 }], [{ clientX: 150, clientY: 200 }, { clientX: 350, clientY: 200 }])
    act(() => {
      surface.dispatchEvent(touchEvent('touchend', [], [{ clientX: 150, clientY: 200 }]))
    })
    expect(onNext).not.toHaveBeenCalled()
    expect(onPrev).not.toHaveBeenCalled()
  })

  it('still swipes between images at 1x', () => {
    const { surface, onNext } = mountPreview()
    act(() => { surface.dispatchEvent(touchEvent('touchstart', [{ clientX: 300, clientY: 200 }])) })
    act(() => { surface.dispatchEvent(touchEvent('touchend', [], [{ clientX: 100, clientY: 200 }])) })
    expect(onNext).toHaveBeenCalledTimes(1)
  })
})
