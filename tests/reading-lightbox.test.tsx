// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageLightbox } from '../src/client/features/reading/reader/ImageLightbox'
import { installTestGlobals } from '../src/client/lib/test-render'

let root: Root | null = null
let host: HTMLDivElement
afterEach(() => { act(() => root?.unmount()); root = null; host?.remove() })

describe('ImageLightbox', () => {
  it('takes focus and closes with Escape', () => {
    installTestGlobals()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const close = vi.fn()
    act(() => root!.render(createElement(ImageLightbox, { src: 'blob:image', alt: '插图', onClose: close })))
    expect(document.activeElement?.getAttribute('role')).toBe('dialog')
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(close).toHaveBeenCalledTimes(1)
  })
})
