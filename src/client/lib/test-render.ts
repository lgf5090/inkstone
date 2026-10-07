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
  // jsdom ships no scrollIntoView at all, so a component that scrolls a located row into view
  // throws for reasons that have nothing to do with what the test is about.
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = function scrollIntoView() {}
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