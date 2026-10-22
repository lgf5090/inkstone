// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { MemoAttachment } from '@shared/memos/types'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { MemoLightbox } from './MemoLightbox'

let view: RenderedElement | null = null
let nextId = 0

function attachment(overrides: Partial<MemoAttachment> = {}): MemoAttachment {
  nextId += 1
  return {
    id: `attachment-${nextId}`,
    filename: `photo-${nextId}.jpg`,
    mime: 'image/jpeg',
    size: 2048,
    width: 1200,
    height: 800,
    url: `/api/memos/files/attachment-${nextId}`,
    thumbnailUrl: null,
    motion: null,
    mediaMetadata: null,
    createdAt: 1_700_000_000,
    ...overrides,
  }
}

function Harness({ images, initial = 0 }: { images: MemoAttachment[]; initial?: number }): ReturnType<typeof createElement> {
  const [index, setIndex] = useState<number | null>(initial)
  return createElement(MemoLightbox, {
    images,
    index,
    onIndexChange: setIndex,
    onClose: () => setIndex(null),
  })
}

function render(images: MemoAttachment[]): HTMLElement {
  view = renderElement(createElement(Harness, { images }))
  return view.container
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

function press(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]')
}

function image(): HTMLImageElement | null {
  return dialog()?.querySelector<HTMLImageElement>('img') ?? null
}

function button(label: string): HTMLButtonElement {
  const found = dialog()?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

function scaleOf(element: HTMLImageElement): string | undefined {
  return /scale\(([^)]+)\)/.exec(element.style.transform)?.[1]
}

beforeAll(async () => {
  await initI18n()
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the image lightbox zoom', () => {
  it('zooms with the toolbar buttons, reports the level and resets it', () => {
    render([attachment({ filename: 'harbour.jpg' })])
    const zoomOut = button(t('memos.media.zoom_out'))
    const zoomIn = button(t('memos.media.zoom_in'))
    const reset = button(t('memos.media.zoom_reset'))
    expect(zoomOut.disabled).toBe(true)
    expect(reset.disabled).toBe(true)

    click(zoomIn)
    expect(scaleOf(image()!)).toBe('1.5')
    expect(dialog()?.querySelector('[data-memo-zoom-status]')?.textContent)
      .toBe(t('memos.media.zoom_status', { percent: 150 }))
    expect(zoomOut.disabled).toBe(false)

    click(zoomIn)
    click(zoomIn)
    click(zoomIn)
    click(zoomIn)
    click(zoomIn)
    expect(scaleOf(image()!)).toBe('4')
    expect(zoomIn.disabled).toBe(true)

    click(reset)
    expect(scaleOf(image()!)).toBe('1')
    expect(reset.disabled).toBe(true)
  })

  it('resets the zoom when the image changes and closes on Escape', () => {
    render([attachment({ filename: 'first.jpg' }), attachment({ filename: 'second.jpg' })])
    click(button(t('memos.media.zoom_in')))
    expect(scaleOf(image()!)).toBe('1.5')

    press('ArrowRight')
    expect(dialog()?.textContent).toContain(t('memos.media.counter', { index: 2, total: 2 }))
    expect(scaleOf(image()!)).toBe('1')

    click(button(t('memos.media.zoom_in')))
    press('Escape')
    expect(dialog()).toBeNull()
  })

  it('toggles a double click between fit and twice the size and zooms with the wheel', () => {
    render([attachment({ filename: 'harbour.jpg' })])
    act(() => {
      image()!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    })
    expect(scaleOf(image()!)).toBe('2')
    act(() => {
      image()!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    })
    expect(scaleOf(image()!)).toBe('1')

    const stage = dialog()?.querySelector<HTMLElement>('[data-memo-lightbox-stage]')
    act(() => {
      stage?.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
    })
    expect(scaleOf(image()!)).toBe('1.25')
    act(() => {
      stage?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))
    })
    expect(scaleOf(image()!)).toBe('1')
  })

  it('falls back to the download row when the image cannot be displayed', () => {
    render([attachment({ filename: 'broken.jpg' })])
    act(() => {
      image()!.dispatchEvent(new Event('error'))
    })
    const alert = dialog()?.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain(t('memos.media.image_failed'))
    expect(dialog()?.querySelector('img')).toBeNull()
    expect(dialog()?.querySelector('a[aria-label="Download broken.jpg"]')).not.toBeNull()
    expect(dialog()?.querySelector('button[aria-label="' + t('memos.media.zoom_in') + '"]')).toBeNull()
  })
})
