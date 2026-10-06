import { act, createElement, type ReactNode, type RefObject } from 'react'
import { describe, expect, it } from 'vitest'
import { renderElement } from '../../lib/test-render'
import { usePresentationNav } from './use-presentation-session'

// The slide level of the show's position, at the level a presenter feels it: the deck under the show
// changes — an edit, a follow that re-splits the note, another writer deleting the second half — and the
// show has to stay on a slide that exists rather than hold a number that indexes nothing (L-12).
type Nav = ReturnType<typeof usePresentationNav>

function Host({ deck, initial, navRef, seen }: {
  deck: string[]
  initial: number
  navRef: RefObject<Nav | null>
  seen?: number[]
}) {
  const nav = usePresentationNav(deck, deck.map((slide) => `hash:${slide}`), initial)
  navRef.current = nav
  // Recorded during the render itself, before any effect has had a turn: a show that opens past the end
  // of the deck paints one frame of a slide that does not exist, and only this reading can see it.
  seen?.push(nav.index)
  return null
}

function render(props: { deck: string[]; initial: number; navRef: RefObject<Nav | null>; seen?: number[] }): { rerender: (node: ReactNode) => void; unmount: () => void } {
  return renderElement(createElement(Host, props))
}

const at = (nav: Nav) => nav.index

describe('the show stays on a slide the deck has', () => {
  it('opens on the last slide when the remembered one is gone', () => {
    const navRef = { current: null } as RefObject<Nav | null>
    const seen: number[] = []
    const view = render({ deck: ['# One', '# Two', '# Three'], initial: 7, navRef, seen })
    expect(at(navRef.current!)).toBe(2)
    expect(seen[0], 'the first render must not be at a slide the deck does not have').toBe(2)
    view.unmount()
  })

  it('pulls the presenter back when the deck shrinks mid-talk', () => {
    const navRef = { current: null } as RefObject<Nav | null>
    const five = ['# One', '# Two', '# Three', '# Four', '# Five']
    const view = render({ deck: five, initial: 4, navRef })
    expect(at(navRef.current!)).toBe(4)

    act(() => {
      view.rerender(createElement(Host, { deck: five.slice(0, 2), initial: 4, navRef }))
    })
    expect(at(navRef.current!), 'two slides left: the show is on the one that ends the deck').toBe(1)

    act(() => {
      view.rerender(createElement(Host, { deck: [], initial: 4, navRef }))
    })
    expect(at(navRef.current!), 'a deck with nothing in it is not a negative index').toBe(0)
    view.unmount()
  })

  // `jumpTo` is what a slide-list click, a key and the overview grid all go through.
  it('will not jump past either end', () => {
    const navRef = { current: null } as RefObject<Nav | null>
    const view = render({ deck: ['# One', '# Two', '# Three'], initial: 0, navRef })
    act(() => {
      navRef.current!.jumpTo(99)
    })
    expect(at(navRef.current!)).toBe(2)
    act(() => {
      navRef.current!.jumpTo(-3)
    })
    expect(at(navRef.current!)).toBe(0)
    view.unmount()
  })
})
