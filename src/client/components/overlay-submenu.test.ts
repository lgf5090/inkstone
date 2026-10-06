import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement as h } from 'react'
import { renderElement } from '../lib/test-render'
import { Menu, SubmenuList, type MenuItem } from './overlay'

/**
 * A list that nests one level deeper: the second row opens a panel of its own, and the
 * third row is disabled — the one the arrow keys have to step over rather than onto.
 */
function nestedItems(): MenuItem[] {
  return [
    { id: 'one', label: 'One' },
    {
      id: 'two',
      label: 'Two',
      submenu: () => h(SubmenuList, { items: [{ id: 'deep', label: 'Deep' }], closeMenu: () => {} }),
    },
    { id: 'three', label: 'Three', disabled: true },
    { id: 'four', label: 'Four' },
  ]
}

/** The menu the nested list hangs off: a plain row, then a row that opens that list. */
function menuItems(): MenuItem[] {
  return [
    { id: 'plain', label: 'Plain' },
    { id: 'nest', label: 'Nest', submenu: () => h(SubmenuList, { items: nestedItems(), closeMenu: () => {} }) },
  ]
}

function row(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-submenu-row="${id}"]`)!
}

function hasRow(id: string): boolean {
  return Boolean(document.querySelector(`[data-submenu-row="${id}"]`))
}

function press(target: HTMLElement, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

async function settle(): Promise<void> {
  await act(async () => {})
}

/** The menu the nested list hangs off, opened at a point. */
function renderMenu(onClose: () => void): void {
  renderElement(h(Menu, { open: true, anchor: { x: 10, y: 10 }, items: menuItems(), onClose }))
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('submenu keyboard navigation', () => {
  it('moves the focus with the arrow keys, over a disabled row and around the ends', () => {
    renderElement(h(SubmenuList, { items: nestedItems(), closeMenu: () => {} }))
    act(() => { row('one').focus() })

    press(row('one'), 'ArrowDown')
    expect(document.activeElement).toBe(row('two'))
    press(row('two'), 'ArrowDown')
    expect(document.activeElement).toBe(row('four'))
    press(row('four'), 'ArrowDown')
    expect(document.activeElement).toBe(row('one'))
    press(row('one'), 'End')
    expect(document.activeElement).toBe(row('four'))
    press(row('four'), 'Home')
    expect(document.activeElement).toBe(row('one'))
  })
})

describe('a submenu on its own', () => {
  it('steps into a row\'s panel on ArrowRight and back out on ArrowLeft', () => {
    renderElement(h(SubmenuList, { items: nestedItems(), closeMenu: () => {} }))
    act(() => { row('two').focus() })

    press(row('two'), 'ArrowRight')
    expect(document.activeElement).toBe(row('deep'))

    press(row('deep'), 'ArrowLeft')
    expect(hasRow('deep')).toBe(false)
    expect(document.activeElement).toBe(row('two'))
  })

  it('names a row\'s panel after the row and points the row at it', () => {
    renderElement(h(SubmenuList, { items: nestedItems(), closeMenu: () => {} }))
    act(() => { row('two').focus() })

    press(row('two'), 'ArrowRight')
    const panel = document.querySelector<HTMLElement>('[role="menu"][aria-label="Two"]')!
    expect(panel.id).toBeTruthy()
    expect(row('two').getAttribute('aria-controls')).toBe(panel.id)
  })

  it('runs the row\'s own action and closes the menu that owns it', () => {
    let selected = 0
    let closed = 0
    renderElement(h(SubmenuList, {
      items: [{ id: 'act', label: 'Act', onSelect: () => { selected += 1 } }],
      closeMenu: () => { closed += 1 },
    }))

    act(() => { row('act').click() })
    expect(selected).toBe(1)
    expect(closed).toBe(1)
  })

  it('puts its rows inside a menu named for the row that opened it', () => {
    renderElement(h(SubmenuList, { items: nestedItems(), closeMenu: () => {}, label: 'Nest' }))
    const list = document.querySelector<HTMLElement>('[data-submenu-row="one"]')!.closest('[role="menu"]')!
    expect(list.getAttribute('aria-label')).toBe('Nest')
  })
})

describe('a submenu inside a menu', () => {
  it('opens the panel from the row and leaves the menu behind it', async () => {
    let closed = 0
    renderMenu(() => { closed += 1 })
    const nestRow = document.querySelector<HTMLElement>('[data-menu-index="1"]')!
    act(() => { nestRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()

    expect(hasRow('one')).toBe(true)
    expect(closed).toBe(0)
  })

  it('closes the open panel on Escape and leaves the menu behind it open', async () => {
    let closed = 0
    renderMenu(() => { closed += 1 })
    const nestRow = document.querySelector<HTMLElement>('[data-menu-index="1"]')!
    act(() => { nestRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()

    act(() => { row('two').focus() })
    press(row('two'), 'ArrowRight')
    await settle()
    expect(hasRow('deep')).toBe(true)

    press(row('deep'), 'Escape')
    await settle()
    expect(hasRow('deep')).toBe(false)
    expect(hasRow('two')).toBe(true)
    expect(closed).toBe(0)
  })
})
