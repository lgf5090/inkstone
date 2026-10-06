import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { vi } from 'vitest'

/** Idempotent jsdom shims needed to render React components in unit tests. */
export function installTestGlobals(): void {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  if (typeof globalThis.ResizeObserver === 'undefined') {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
  }
  // jsdom ships no `matchMedia`, so anything reading a breakpoint would throw on its first render.
  // This answers each `and`-separated condition against the viewport jsdom reports, because the
  // compound queries are load-bearing: `(pointer: coarse) and (max-height: 600px) and
  // (max-width: 1179px)` is how the app detects a landscape phone, and an OR over those parts would
  // call every test run one. `hover: hover` / `pointer: fine` answer true for the machine the tests
  // were written against — several surfaces gate a hover affordance on it, and answering false would
  // silently unmount every tooltip in the suite.
  if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string): MediaQueryList => {
      const width = window.innerWidth
      const height = window.innerHeight
      const holds = (part: string): boolean => {
        const px = /^\((min|max)-(width|height):\s*(\d+)px\)$/.exec(part.trim())
        if (px) {
          const value = px[2] === 'width' ? width : height
          return px[1] === 'min' ? value >= Number(px[3]) : value <= Number(px[3])
        }
        if (/\(pointer:\s*fine\)/.test(part) || /\(hover:\s*hover\)/.test(part)) return true
        if (/\(pointer:\s*coarse\)/.test(part) || /\(hover:\s*none\)/.test(part)) return false
        return false
      }
      const matches = query.split(/\s+and\s+/).every(holds)
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList
    }) as typeof window.matchMedia
  }
  // jsdom has no IntersectionObserver either. Installed only when nothing else has: a test that
  // wants its cards to report as visible stubs one itself, and this must not win over that.
  // A stub that never reports says "nothing is near the viewport", which is the honest answer for a
  // layout engine that does not exist.
  if (typeof globalThis.IntersectionObserver === 'undefined') {
    class IntersectionObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] {
        return []
      }
    }
    globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver
  }
  // jsdom implements no scrolling at all, so `scrollIntoView` is simply absent. A surface that keeps
  // the reader's place on every page turn calls it, and a missing method is a render crash rather than
  // a no-op. Guarded, because a test that wants to count the calls stubs its own.
  if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = () => {}
  }
}


// jsdom answers every media query with `false`, which the app reads as a phone, so a case written
// about what a wide window draws has to say which room it is describing. Only width queries answer the
// call: a stub that also claimed `prefers-reduced-motion` or `(hover: hover)` would change what
// unrelated readers of `matchMedia` see. Teardown is `vi.unstubAllGlobals()`.
export function stubBreakpoint(wide: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide && query.includes('min-width'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

// The show as a wide window draws it: `useBreakpoint` reads desktop (jsdom answers every media query
// with false, which is the phone layout — one door and no controls), and the two browser objects the
// slide rail needs once it opens are stood up, the same way the rail's own cases do it. Teardown is
// `vi.unstubAllGlobals()`.
export function stubWideShow(): void {
  stubBreakpoint(true)
  // jsdom defines no `scrollIntoView` at all, so it is assigned rather than spied — the same
  // stand-in the rail's own cases use.
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  class ObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('IntersectionObserver', ObserverStub)
}

export interface RenderedElement {
  container: HTMLElement
  rerender: (node: ReactNode) => void
  unmount: () => void
}

/** Render a React node into a fresh container appended to document.body (portals land on body as usual). */
export function renderElement(node: ReactNode): RenderedElement {
  installTestGlobals()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(node); })
  return {
    container,
    rerender: (next: ReactNode) => { act(() => { root.render(next); }); },
    unmount: () => {
      act(() => { root.unmount(); })
      container.remove()
    },
  }
}