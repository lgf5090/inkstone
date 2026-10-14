/**
 * Every colour menu in the app draws its ramp through this one component, so the geometry the five
 * call sites depend on lives here and nowhere else. These cases pin the class string each shape
 * renders: a change to the shared component that moves a picker — a size, a radius, the active ring —
 * fails here instead of arriving as a silent redesign in the tag, folder, QuickAdd, editor and
 * property panels. The `md` strings are what those menus rendered before the size prop existed.
 */
import { createElement, type ComponentProps } from 'react'
import { describe, expect, it } from 'vitest'
import { renderElement } from '../lib/test-render'
import { Swatch } from './color-swatch'

/** The rendered button's own attributes: the class the picker draws, and the check inside it. */
function swatch(props: ComponentProps<typeof Swatch>): { className: string; check: string | null; name: string | null; pressed: string | null } {
  const rendered = renderElement(createElement(Swatch, props))
  const button = rendered.container.querySelector('button')!
  const read = {
    className: button.getAttribute('class')!,
    check: button.querySelector('svg')?.getAttribute('width') ?? null,
    name: button.getAttribute('aria-label'),
    pressed: button.getAttribute('aria-pressed'),
  }
  rendered.unmount()
  return read
}

const MEDIUM = 'flex size-7 items-center justify-center transition-transform hover:scale-110'
const SMALL = 'flex size-3.5 items-center justify-center transition-transform hover:scale-110'

describe('colour swatch', () => {
  it('draws the medium round ramp the tag, folder and QuickAdd pickers use', () => {
    expect(swatch({ color: '#059669', label: 'Teal', active: false, background: '#059669', onPick: () => {} }).className)
      .toBe(`${MEDIUM} rounded-full`)
    expect(swatch({ color: '#059669', label: 'Teal', active: true, background: '#059669', onPick: () => {} }).className)
      .toBe(`${MEDIUM} rounded-full ring-2 ring-[var(--accent-ring)] ring-offset-2 ring-offset-[var(--bg-overlay)]`)
  })

  it('draws the medium square ramp the editor and property pickers use', () => {
    expect(swatch({ color: '#059669', label: 'Teal', active: false, variant: 'format', background: '#059669', onPick: () => {} }).className)
      .toBe(`${MEDIUM} rounded-[var(--r-sm)] border border-[var(--border-subtle)]`)
    expect(swatch({ color: '#059669', label: 'Teal', active: true, variant: 'format', background: '#059669', onPick: () => {} }).className)
      .toBe(`${MEDIUM} rounded-[var(--r-sm)] border border-[var(--border-subtle)] ring-2 ring-[var(--accent-ring)] ring-offset-1 ring-offset-[var(--bg-overlay)]`)
  })

  it('draws the no-colour slot with its fill and its own active ring', () => {
    expect(swatch({ color: null, label: 'No colour', active: false, onPick: () => {} }).className)
      .toBe(`${MEDIUM} rounded-full border bg-[var(--bg-base)] border-[var(--border-default)] text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]`)
    expect(swatch({ color: null, label: 'No colour', active: true, onPick: () => {} }).className)
      .toBe(`${MEDIUM} rounded-full border bg-[var(--bg-base)] border-[var(--accent)] text-[var(--accent)] ring-2 ring-[var(--accent-ring)]`)
    expect(swatch({ color: null, label: 'No colour', active: true, noColorBackground: false, onPick: () => {} }).className)
      .toBe(`${MEDIUM} rounded-full border border-[var(--accent)] text-[var(--accent)] ring-2 ring-[var(--accent-ring)]`)
  })

  it('draws the small ramp the graph colour rules use, with the check sized to it', () => {
    expect(swatch({ color: '#059669', label: 'Teal', active: false, size: 'sm', background: '#059669', onPick: () => {} }).className)
      .toBe(`${SMALL} rounded-full`)
    expect(swatch({ color: '#059669', label: 'Teal', active: true, size: 'sm', background: '#059669', onPick: () => {} }).className)
      .toBe(`${SMALL} rounded-full ring-2 ring-[var(--accent)]`)
    expect(swatch({ color: '#059669', label: 'Teal', active: true, size: 'sm', background: '#059669', onPick: () => {} }).check).toBe('9')
    expect(swatch({ color: '#059669', label: 'Teal', active: true, background: '#059669', onPick: () => {} }).check).toBe('13')
  })

  it('names the swatch and carries its pressed state', () => {
    const named = swatch({ color: '#059669', label: 'Teal', active: true, background: '#059669', onPick: () => {} })
    expect(named.name).toBe('Teal')
    expect(named.pressed).toBe('true')
  })
})
