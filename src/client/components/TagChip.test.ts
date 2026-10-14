/**
 * Five surfaces wrote this chip by hand and landed on five different boxes, so these cases hold the one
 * shape they converge on: a real `<button>` (a chip filters, so it has to be reachable and answer
 * Enter), the pressed state where a screen reader looks for it, the count lined up on its digits rather
 * than their widths, and the `#` kept out of the announced name — a strip of tags read aloud would
 * otherwise start every item with "hash". The colour a kanban tag wears is data from the note, so it
 * arrives as a style; the corner radius is the one thing a surface genuinely owns.
 */
import { act, createElement, type ComponentProps, type ReactNode } from 'react'
import { Folder } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { renderElement } from '../lib/test-render'
import { TagChip } from './TagChip'

type Props = ComponentProps<typeof TagChip>

/** Render a chip and hand back its element; the caller unmounts once it has read what it came for. */
function chip(props: Props): { button: HTMLButtonElement; rendered: ReturnType<typeof renderElement> } {
  const rendered = renderElement(createElement(TagChip, props))
  const button = rendered.container.querySelector('button')
  if (!button) throw new Error('TagChip drew no button')
  return { button, rendered }
}

/** Read one thing off a chip and take it down again, so a case that only checks an attribute leaks no tree. */
function read<T>(props: Props, take: (button: HTMLButtonElement) => T): T {
  const { button, rendered } = chip(props)
  const value = take(button)
  rendered.unmount()
  return value
}

const PRESS = () => {}

describe('tag chip', () => {
  it('is a real button that answers a press', () => {
    const onPress = vi.fn()
    const { button, rendered } = chip({ label: 'urgent', onPress })
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.getAttribute('role')).toBeNull()
    act(() => { button.click() })
    expect(onPress).toHaveBeenCalledTimes(1)
    rendered.unmount()
  })

  it('exposes the pressed state as aria-pressed, and only for a toggle', () => {
    expect(read({ label: 'urgent', onPress: PRESS, pressed: true }, (b) => b.getAttribute('aria-pressed'))).toBe('true')
    expect(read({ label: 'urgent', onPress: PRESS, pressed: false }, (b) => b.getAttribute('aria-pressed'))).toBe('false')
    // The sidebar's removable chips are not a toggle: a chip that cannot be switched off must not
    // announce a state that never changes.
    expect(read({ label: 'urgent', onPress: PRESS }, (b) => b.hasAttribute('aria-pressed'))).toBe(false)
  })

  it('marks the pressed chip with the accent wash and leaves the rest on the hairline border', () => {
    const on = read({ label: 'urgent', onPress: PRESS, pressed: true }, (b) => b.className)
    expect(on).toContain('bg-[var(--accent-soft)]')
    expect(on).toContain('border-[var(--accent)]')
    const off = read({ label: 'urgent', onPress: PRESS, pressed: false }, (b) => b.className)
    expect(off).toContain('border-[var(--border-subtle)]')
    expect(off).not.toContain('bg-[var(--accent-soft)]')
  })

  it('shows the sigil only when the surface asks for one', () => {
    expect(read({ label: 'urgent', onPress: PRESS }, (b) => b.textContent)).toBe('urgent')
    expect(read({ label: 'urgent', onPress: PRESS, sigil: true }, (b) => b.textContent)).toBe('#urgent')
  })

  it('keeps the sigil out of the name it announces', () => {
    read({ label: 'urgent', onPress: PRESS, sigil: true }, (button) => {
      const mark = button.querySelector('span.truncate > span')
      expect(mark?.textContent).toBe('#')
      expect(mark?.getAttribute('aria-hidden')).toBe('true')
      // The label span itself stays readable: it is the name.
      expect(button.getAttribute('aria-hidden')).toBeNull()
    })
  })

  it('lines the count up on tabular digits and brackets it only where the strip does', () => {
    expect(read({ label: 'urgent', onPress: PRESS, count: 12 }, (b) => b.querySelector('span.tabular')?.textContent)).toBe('12')
    expect(read({ label: 'urgent', onPress: PRESS, count: 12, countFormat: 'paren' }, (b) => b.querySelector('span.tabular')?.textContent)).toBe('(12)')
    expect(read({ label: 'urgent', onPress: PRESS, count: 12 }, (b) => b.querySelector('span.tabular')?.className)).toContain('tabular')
  })

  it('draws no count node when the surface has nothing to report', () => {
    for (const given of [undefined, null] as const) {
      expect(read({ label: 'urgent', onPress: PRESS, count: given }, (b) => b.querySelector('span.tabular'))).toBeNull()
      expect(read({ label: 'urgent', onPress: PRESS, count: given }, (b) => b.textContent)).toBe('urgent')
    }
  })

  it('names itself from the label, and takes an override when the label alone is not enough', () => {
    expect(read({ label: 'urgent', onPress: PRESS }, (b) => [b.hasAttribute('aria-label'), b.textContent])).toEqual([false, 'urgent'])
    expect(read({ label: 'urgent', onPress: PRESS, ariaLabel: 'Filter by tag urgent' }, (b) => b.getAttribute('aria-label')))
      .toBe('Filter by tag urgent')
  })

  it('paints the colour dot and hides both leading marks from the name', () => {
    read({ label: 'urgent', onPress: PRESS, color: '#7c3aed', glyph: createElement(Folder, { size: 11 }) }, (button) => {
      const dot = button.firstElementChild as HTMLElement
      expect(dot.getAttribute('aria-hidden')).toBe('true')
      expect(dot.style.backgroundColor).toBe('rgb(124, 58, 237)')
      expect(dot.className).toContain('size-[var(--sp-1-5)]')
      // The glyph slot is hidden too, so neither mark reaches the name — and the icon inside it is the
      // one lucide hides itself.
      expect(button.children[1]?.getAttribute('aria-hidden')).toBe('true')
      expect(button.textContent).toBe('urgent')
    })
  })

  it('carries a palette that is data, the way a kanban tag colour arrives', () => {
    const style = { backgroundColor: 'var(--kanban-tag-blue-bg)', color: 'var(--kanban-tag-blue-fg)' }
    expect(read({ label: 'now', onPress: PRESS, style }, (b) => b.getAttribute('style'))).toContain('--kanban-tag-blue-bg')
  })

  it('forwards the context menu', () => {
    const onPress = vi.fn()
    const onContextMenu = vi.fn()
    const { button, rendered } = chip({ label: 'urgent', onPress, onContextMenu })
    act(() => { button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect(onContextMenu).toHaveBeenCalledTimes(1)
    rendered.unmount()
  })

  it('hands the trailing affordance through untouched', () => {
    const cross: ReactNode = createElement('span', { 'data-remove': 'true' })
    expect(read({ label: 'urgent', onPress: PRESS, trailing: cross }, (b) => b.lastElementChild?.getAttribute('data-remove'))).toBe('true')
  })

  it('sizes and colours itself from tokens, leaving the radius to the surface', () => {
    const base = read({ label: 'urgent', onPress: PRESS, count: 3 }, (b) => b.className)
    // No hand-picked pixel literal in the layer every chip copies from: a sixth chip would otherwise
    // copy whichever one it happened to land on.
    expect(base).not.toMatch(/\[\d+(?:\.\d+)?(?:px|rem)\]/)
    expect(base).not.toMatch(/(?:^|\s)(?:p[xy]?|gap|size|text|leading|rounded)-\d/)
    expect(base).toContain('text-[length:var(--text-11)]')
    expect(base).toContain('rounded-[var(--r-full)]')
    // The kanban strip and the sidebar's filter row own their corner and their padding; the override wins.
    const tuned = read({
      label: 'urgent',
      onPress: PRESS,
      className: 'rounded-[var(--r-xs)] px-[var(--sp-2)] text-[length:var(--text-11-5)]',
    }, (b) => b.className)
    expect(tuned).toContain('rounded-[var(--r-xs)]')
    expect(tuned).toContain('px-[var(--sp-2)]')
    expect(tuned).not.toContain('rounded-[var(--r-full)]')
    expect(tuned).not.toContain('text-[length:var(--text-11)]')
  })
})
