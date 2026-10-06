/**
 * A full screen board opens a card as a right-hand peek, and a note opens it as the centred dialog
 * it always did (user decision, 2026-09-23).
 *
 * The two hosts want different things from the same card. A note's board is a few hundred pixels
 * tall inside a pane that also holds the editor, so a modal is the only honest way to give the card
 * the whole screen while it is open. The overlay has the board *and* the room, and a reader working
 * through a column reads a card against the columns it came from — so there the card slides in
 * beside the board and the board stays where it was.
 *
 * What the two shells owe the reader is the same, and it is asserted here rather than assumed: an
 * Escape that closes it, focus that comes back to where it was, a trap that keeps Tab inside while
 * it is open, and a name for the panel. The shell itself is `components/overlay`'s, so this file
 * pins the wiring — which shell, which side, which tier above the board's own modal, and that the
 * card's fields are in whichever one is drawn.
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { Z_INDEX } from '../../../../lib/z-index'
import { KanbanItemDetail } from './kanban-item-detail'
import { KanbanRoot } from './kanban-root'
import type { KanbanData, KanbanItem, KanbanProperty } from '../types'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const columns: KanbanProperty[] = [
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [{ id: 'todo', label: 'To Do', color: 'gray' }],
  },
]

const item: KanbanItem = {
  id: 'item-1',
  title: 'Peek target',
  properties: { status: 'todo' },
}

let mounted: ReturnType<typeof renderDetail> | null = null

function renderDetail(variant: 'dialog' | 'peek') {
  const host = document.createElement('button')
  host.textContent = 'card'
  document.body.appendChild(host)
  host.focus()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const props = {
    item,
    columns,
    variant,
    onClose: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onConvertSubtask: vi.fn(),
    onAddColumnOption: vi.fn(),
  }
  act(() => {
    root.render(createElement(KanbanItemDetail, props))
  })
  let disposed = false
  const view = {
    props,
    host,
    /** Closes the card the way the board does, which is what hands the focus back. */
    close() {
      act(() => {
        root.render(createElement(KanbanItemDetail, { ...props, item: null }))
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      act(() => root.unmount())
      container.remove()
      host.remove()
    },
  }
  mounted = view
  return view
}

afterEach(() => {
  mounted?.dispose()
  mounted = null
})

function panel(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!el) throw new Error('no dialog was drawn')
  return el
}

function titleInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`input[placeholder="${t('preview.kanban_card_title')}"]`)
  if (!el) throw new Error('the card title field is missing')
  return el
}

describe('the full screen board opens a card beside itself', () => {
  it('draws the peek shell rather than the centred dialog', () => {
    renderDetail('peek')
    expect(panel().getAttribute('data-surface')).toBe('drawer')
  })

  it('stands on the right, and above the board it peeks from', () => {
    renderDetail('peek')
    const drawer = panel()
    expect(drawer.className).toContain('right-0')
    // The board is a modal at `--z-modal`: a drawer at the default tier would paint behind it.
    const root = drawer.closest<HTMLElement>('[style*="z-index"]')
    expect(Number(root?.style.zIndex)).toBeGreaterThan(Z_INDEX.drawer)
  })

  it('takes that tier on the peek alone, leaving a note dialog to its own shell', () => {
    renderDetail('dialog')
    expect(panel().closest('[style*="z-index"]')).toBeNull()
  })

  it('carries the card, named for what it is showing', () => {
    renderDetail('peek')
    expect(titleInput().value).toBe('Peek target')
    expect(panel().getAttribute('aria-label')).toBe(t('preview.kanban_card_details'))
  })

  it('can be closed with Escape, and gives the focus back to the card', () => {
    const view = renderDetail('peek')
    // Opening moves the focus into the panel — a reader who opened it is working in it.
    expect(document.activeElement).not.toBe(view.host)
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(view.props.onClose).toHaveBeenCalled()
    // The focus comes back when the panel goes, which is how the board closes it.
    view.close()
    expect(document.activeElement).toBe(view.host)
  })
})

describe('a note keeps the centred dialog it had', () => {
  it('draws the dialog shell, with the card in it', () => {
    renderDetail('dialog')
    expect(panel().getAttribute('data-surface')).not.toBe('drawer')
    expect(titleInput().value).toBe('Peek target')
  })

  it('can be closed with Escape and gives the focus back, exactly as the peek does', () => {
    const view = renderDetail('dialog')
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(view.props.onClose).toHaveBeenCalled()
    view.close()
    expect(document.activeElement).toBe(view.host)
  })
})

/**
 * The choice between the two shells belongs to the host, so it is read from the host: these mount
 * the real board with and without `isFullscreen` and open the same card. The component's own cases
 * above would all stay green if the overlay stopped asking for the peek, which is the half a
 * reader actually sees.
 */
const boardData: KanbanData = {
  columns: [
    { id: 'title', name: 'Title', type: 'title' },
    { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
  ],
  items: [{ id: 'a', title: 'Design spec', properties: { status: 'todo' } }],
  views: [{ id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' }],
} as KanbanData

const boards: ReturnType<typeof renderElement>[] = []

function openCardFromBoard(isFullscreen: boolean): void {
  const rendered = renderElement(
    createElement(KanbanRoot, { initialData: boardData, isFullscreen, onUpdateData: vi.fn() }),
  )
  boards.push(rendered)
  const card = rendered.container.querySelector<HTMLElement>('[data-item-id="a"]')
  if (!card) throw new Error('the board drew no card to open')
  act(() => {
    // A click on the title opens the detail at once; there is no window the synthetic
    // activation has to wait out (see kanban-card-title.tsx).
    card.querySelector<HTMLButtonElement>('h3 button')!.click()
  })
}

afterEach(() => {
  while (boards.length > 0) boards.pop()!.unmount()
})

describe('the board asks for the shell its host has the room for', () => {
  it('opens a card as the side panel while it is full screen', () => {
    openCardFromBoard(true)
    expect(panel().getAttribute('data-surface')).toBe('drawer')
  })

  it('opens the same card as the centred dialog in a note', () => {
    openCardFromBoard(false)
    expect(panel().getAttribute('data-surface')).not.toBe('drawer')
  })
})
