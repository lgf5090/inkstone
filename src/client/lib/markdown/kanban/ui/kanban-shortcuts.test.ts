/**
 * KU-14, the reference half. A board answers to chords that are not written anywhere on it — the arrows
 * walk the focus, `Shift`+arrow moves the card under it, `N` and `/` open the board's two doors — and a
 * reader who does not already know that will never find out by looking. This is the one place that says
 * so.
 *
 * What the cases here are mostly about is *drift*: the navigation rows are rendered from the board's own
 * chord table rather than typed out beside it, so a chord that stops working, or a new one, changes the
 * card in the same edit. The rows for gestures the card and the board's other controls own (its
 * `Shift`+arrow move, `F2` to rename, the title's `Enter`) have no table to be read from; they are held
 * to their behaviour by `kanban-board-keys.test.ts` and `kanban-card-title`'s own cases instead.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { KANBAN_BOARD_CHORDS } from './kanban-board-keys'
import { KANBAN_SHORTCUT_ROWS, KanbanShortcutsAction } from './kanban-shortcuts'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mountAction() {
  const rendered = renderElement(createElement(KanbanShortcutsAction))
  mounted.push(rendered)
  return rendered
}

function trigger(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.getAttribute('aria-label') === t('preview.kanban_shortcuts'),
  )
  if (!button) throw new Error('the board draws no keyboard reference control')
  return button
}

function panel(container: HTMLElement): HTMLElement | null {
  return [...container.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (dialog) => dialog.getAttribute('aria-label') === t('preview.kanban_shortcuts'),
  ) ?? null
}

function openPanel(container: HTMLElement): HTMLElement {
  act(() => { trigger(container).click() })
  const opened = panel(container)
  if (!opened) throw new Error('the control drew no reference panel')
  return opened
}

describe('the reference names the chords the board answers to', () => {
  it('draws a row for every chord in the board’s own table', () => {
    const opened = openPanel(mountAction().container)
    for (const chord of KANBAN_BOARD_CHORDS) {
      expect(opened.textContent, `the reference says nothing about ${chord.key}`).toContain(t(chord.messageKey))
    }
  })

  it('shows the keys themselves beside each row, arrows and letters spelled as keys', () => {
    const opened = openPanel(mountAction().container)
    const drawn = [...opened.querySelectorAll('kbd')].map((key) => key.textContent)
    expect(drawn).toContain('↑')
    expect(drawn).toContain('↓')
    expect(drawn).toContain('←')
    expect(drawn).toContain('→')
    expect(drawn).toContain('N')
    expect(drawn).toContain('/')
  })

  it('lists the gestures the card owns as well, which have no table to be read from', () => {
    const opened = openPanel(mountAction().container)
    // `Shift`+arrow is the card's move; the row is what tells a reader it exists.
    expect(opened.textContent).toContain(t('preview.kanban_key_move_card'))
    expect([...opened.querySelectorAll('kbd')].map((key) => key.textContent)).toContain('Shift')
  })

  it('keeps every row readable in both languages', () => {
    // No row may be an empty string, which is how a row whose key was renamed out from under it reads.
    for (const row of KANBAN_SHORTCUT_ROWS) {
      expect(t(row.messageKey).trim(), `${row.messageKey} renders empty`).not.toBe('')
    }
    expect(KANBAN_SHORTCUT_ROWS).toHaveLength(KANBAN_BOARD_CHORDS.length + 6)
  })
})

describe('the reference opens from its control and closes like a panel', () => {
  it('stays out of the document until the control is pressed', () => {
    const { container } = mountAction()
    expect(panel(container)).toBeNull()
    openPanel(container)
    expect(panel(container)).not.toBeNull()
  })

  it('tells assistive tech whether it is open', () => {
    const { container } = mountAction()
    const button = trigger(container)
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    openPanel(container)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe(panel(container)!.id)
  })

  it('closes on Escape', () => {
    const { container } = mountAction()
    openPanel(container)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(panel(container)).toBeNull()
  })

  it('closes on a press outside it, and stays open for one inside', () => {
    const { container } = mountAction()
    const opened = openPanel(container)
    act(() => {
      opened.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(panel(container), 'a press inside the reference closed it').not.toBeNull()
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(panel(container)).toBeNull()
  })
})
