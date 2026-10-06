import fs from 'node:fs'
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import type { KanbanData } from '../src/client/lib/markdown/kanban/types'
import { KanbanRoot } from '../src/client/lib/markdown/kanban/ui/kanban-root'

/**
 * The block used to be a fixed 480px box, and a board of three short columns filled it by stretching
 * every column to the box's height: the reader saw two or three rows of their own column's background
 * under the last card, and the horizontal scrollbar sat at the bottom of that emptiness rather than
 * under the columns (user report 2026-09-23). The board is now as tall as its columns need and no
 * taller, and the columns are not stretched at all.
 *
 * The ceiling belongs to the **board**, not to the canvas. It was written on the canvas — which is the
 * block's whole box, header and notice strip included — so the chrome above the board spent the board's
 * own budget: with the overdue-notice strip drawn and a column of cards, the canvas stopped at 480px
 * while the tree inside it needed 614, and the bottom 134px of the board (its horizontal scrollbar with
 * it) was cut off by the canvas's `overflow: hidden`. A `max-height` on the canvas cannot bound the
 * board anyway: the canvas's height is auto, so its children are laid out against the height the content
 * asks for and the clamp only takes effect after they have been placed.
 *
 * Two halves of one rule, and neither can be read from the other. The stylesheet holds the caps —
 * `styles/kanban.css` carries no comments by policy, so the reasoning reads here, next to the only
 * assertions that look at it. The stretch itself is a class on the board's own root, so that half is
 * asserted on what the component actually renders.
 *
 * What jsdom cannot do is lay any of this out, so nothing here measures a column. That the columns are
 * in fact as tall as their cards, that the canvas covers the chrome and the board it draws with nothing
 * clipped, is measured on real pixels in `scripts/e2e-visual.mjs` (`assertKanbanColumnHeights`).
 */
const KANBAN_CSS = fs.readFileSync('src/client/styles/kanban.css', 'utf8')

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  document.body.replaceChildren()
})

/** The declarations of the one block whose selector is exactly this, so scoping is part of the read. */
function blockOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = KANBAN_CSS.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))
  if (!found) throw new Error(`kanban.css declares no block for ${selector}`)
  return found[1]!
}

function declaration(selector: string, property: string): string | null {
  const found = blockOf(selector).match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'm'))
  return found ? found[1]!.trim() : null
}

describe('the block stops at what the board needs', () => {
  it('leaves the canvas to hug the chrome and the board it draws', () => {
    const canvas = blockOf('.ink-prose .kanban-canvas')
    expect(declaration('.ink-prose .kanban-canvas', 'max-height')).toBeNull()
    expect(canvas).not.toMatch(/(?:^|;)\s*height\s*:/)
  })

  it('caps the board, which is the half that scrolls', () => {
    expect(declaration('.ink-prose .kanban-canvas [data-kanban-board]', 'max-height')).toBe(
      'var(--kanban-canvas-cap)',
    )
  })

  it('caps a column one padding step shorter, which is what keeps it scrolling inside itself', () => {
    const column = declaration(
      '.ink-prose .kanban-canvas [data-kanban-board] > [data-kanban-group]',
      'max-height',
    )
    // The board's own padding, twice: the room the cap leaves is the board's content box.
    expect(column).toBe('calc(var(--kanban-canvas-cap) - var(--sp-4) * 2)')
  })

  it('keeps the ceiling in one place, so the board and the columns cannot drift apart', () => {
    const declared = KANBAN_CSS.match(/--kanban-canvas-cap\s*:\s*([^;]+)/)
    expect(declared?.[1]?.trim()).toBe('480px')
    expect(KANBAN_CSS.match(/--kanban-canvas-cap\s*:/g)).toHaveLength(1)
  })
})

describe('the block keeps its place while the overlay has the board', () => {
  it('gives the stand-in the ceiling instead of collapsing to nothing', () => {
    expect(declaration('.kanban-canvas.is-reserve', 'height')).toBe('var(--kanban-canvas-cap)')
  })
})

describe('the overlay measures the board from itself, not from the block', () => {
  it('lets the board fill the overlay again, which is a definite height', () => {
    expect(declaration('.kanban-canvas.is-fullscreen [data-kanban-board]', 'height')).toBe('100%')
    expect(declaration('.kanban-canvas.is-fullscreen [data-kanban-board]', 'max-height')).toBe('none')
    expect(declaration('.kanban-canvas.is-fullscreen [data-kanban-board] > [data-kanban-group]', 'max-height')).toBe('100%')
  })
})

function boardData(): KanbanData {
  return {
    title: 'Height',
    activeViewId: 'v-board',
    views: [{ id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' }],
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      { id: 'status', name: 'Status', type: 'select', options: [{ id: 's1', label: 'To Do', color: 'gray' }] },
    ],
    items: [{ id: 'i1', title: 'Card', properties: { status: 's1' } }],
  }
}

function renderBoard(): HTMLElement {
  const rendered = renderElement(createElement(KanbanRoot, { initialData: boardData(), onUpdateData: vi.fn() }))
  mounted.push(rendered)
  return rendered.container
}

describe('the board does not stretch the columns it draws', () => {
  it('lines the columns up at the top of the plane instead of to its full height', () => {
    const board = renderBoard().querySelector<HTMLElement>('[data-kanban-board]')
    expect(board, 'the board view drew no board').not.toBeNull()
    expect(board!.className).toContain('items-start')
    expect(board!.className).not.toContain('h-full')
  })

  it('lets the board own both axes, so the plane is what scrolls rather than a row that clips', () => {
    const board = renderBoard().querySelector<HTMLElement>('[data-kanban-board]')!
    expect(board.className).toContain('overflow-auto')
    // A column keeps its own scroll area, which is what the height cap keeps reachable.
    expect(renderBoard().querySelector('[data-kanban-group] [data-item-id]')).not.toBeNull()
  })
})
