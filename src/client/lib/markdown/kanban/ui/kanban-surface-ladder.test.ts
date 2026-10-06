/**
 * Two things a board has to say with surfaces, and neither of them is a token name for its own sake
 * (user report 2026-09-23: "is every column's background colour the same?") — first that the three
 * depths of a board are three depths rather than three whites, and second that a column's own colour
 * is legible on the board rather than a 10px dot in the corner of its header.
 *
 * The ladder is plane -> column -> card: `--bg-inset` -> `--bg-surface` -> `--bg-raised`. It used to
 * be raised columns with cards on the surface *below* them, which in the dark theme read as a card
 * sunk under its own column, and in the light one as three whites in a row (that pair of tokens is
 * the same colour there). The full screen plane is the same `--bg-inset` as the note's block, so the
 * board is the same object in both places — the rule for it lives in `styles/kanban.css`.
 *
 * A jsdom case can hold the tokens a component paints with and the colour a column declares, which
 * is what is asserted here. What only a browser can show — that the three painted colours really
 * differ, and that two columns' bands really differ from each other and from the column below them —
 * is measured on the real screen by `e2e-visual.mjs`, and the pairs the band's text makes are judged
 * by `check-contrast.mjs` in both themes.
 */
import { createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { getKanbanTintStyle } from '../colors'
import type { KanbanData } from '../types'
import { KanbanRoot } from './kanban-root'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  document.body.replaceChildren()
})

/**
 * Two columns that wear a colour, and the board's own "No Status" column — which wears none, and is
 * therefore the wash the colourless case has to be read on.
 */
function board(): KanbanData {
  return {
    title: 'Board',
    activeViewId: 'v-board',
    views: [{ id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' }],
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      {
        id: 'status',
        name: 'Status',
        type: 'select',
        options: [
          { id: 'todo', label: 'To Do', color: 'blue' },
          { id: 'doing', label: 'Doing', color: 'green' },
        ],
      },
    ],
    items: [
      { id: 'i1', title: 'First card', properties: { status: 'todo' } },
      { id: 'i2', title: 'Second card', properties: { status: 'doing' } },
      { id: 'i3', title: 'Unfiled card', properties: {} },
    ],
  }
}

function mountBoard() {
  const rendered = renderElement(createElement(KanbanRoot, { initialData: board(), onUpdateData: vi.fn() }))
  mounted.push(rendered)
  return rendered
}

function column(groupKey: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-kanban-board] [data-kanban-group="${groupKey}"]`)
  if (!found) throw new Error(`the board draws no "${groupKey}" column`)
  return found
}

/** The header band of a column, which is the row that carries its colour. */
function band(groupKey: string): HTMLElement {
  const found = column(groupKey).querySelector<HTMLElement>('[data-kanban-column-head]')
  if (!found) throw new Error(`the "${groupKey}" column has no header band`)
  return found
}

/** The tokens a class string paints with. */
function tokensOf(node: HTMLElement): string[] {
  return [...(node.className || '').toString().matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]!)
}

/** The column's label, which is the only leaf span in its band that is not the count. */
function labelOf(groupKey: string): HTMLElement {
  const found = [...band(groupKey).querySelectorAll('span')].find(
    (node) => node.children.length === 0 && (node.textContent ?? '').trim() !== '' && !node.closest('[data-kanban-count]'),
  )
  if (!found) throw new Error(`the "${groupKey}" column has no label`)
  return found
}

describe('the board is three surfaces, each one step above the last', () => {
  it('paints a column in the surface the plane is not, and a card one step above both', () => {
    mountBoard()
    const card = document.querySelector<HTMLElement>('[data-kanban-board] [data-item-id="i1"]')!
    const columnTokens = tokensOf(column('todo'))
    const cardTokens = tokensOf(card)
    expect(columnTokens).toContain('--bg-surface')
    expect(columnTokens, 'a column on --bg-raised sits above the card meant to be on top of it').not.toContain('--bg-raised')
    expect(cardTokens).toContain('--bg-raised')
    expect(cardTokens, 'a card on --bg-surface is the same surface as the column under it').not.toContain('--bg-surface')
  })
})

describe('a column wears its own colour', () => {
  it('gives each coloured column the tint of its own colour, so two of them differ', () => {
    mountBoard()
    const blue = band('todo')
    const green = band('doing')
    expect(blue.getAttribute('data-kanban-column-tint')).toBe('blue')
    expect(green.getAttribute('data-kanban-column-tint')).toBe('green')
    expect(blue.style.backgroundColor).toBe('var(--kanban-tag-blue-bg)')
    expect(green.style.backgroundColor).toBe('var(--kanban-tag-green-bg)')
    expect(blue.style.backgroundColor).not.toBe(green.style.backgroundColor)
  })

  it('writes the label of a tinted column in that tint\'s own foreground', () => {
    mountBoard()
    expect(tokensOf(labelOf('todo')), 'a tier of its own would be a pair the tint was never calibrated for').not.toContain(
      '--text-primary',
    )
    expect(band('todo').style.color).toBe('var(--kanban-tag-blue-fg)')
  })

  it('washes the board\'s own "No Status" column in the colour the board gave it', () => {
    mountBoard()
    expect(band('__none__').getAttribute('data-kanban-column-tint'), 'a column nobody filed a colour for is the one case with no band to paint').toBe('gray')
  })

  it('paints nothing at all for a colour it does not know', () => {
    expect(getKanbanTintStyle(undefined)).toBeUndefined()
    expect(getKanbanTintStyle(null)).toBeUndefined()
    expect(getKanbanTintStyle('chartreuse')).toBeUndefined()
    expect(getKanbanTintStyle('blue')).toEqual({
      backgroundColor: 'var(--kanban-tag-blue-bg)',
      color: 'var(--kanban-tag-blue-fg)',
    })
  })

  it('gives every column on a real board a band, so none of them is left with a dot instead', () => {
    mountBoard()
    const tinted = [...document.querySelectorAll('[data-kanban-column-head]')]
    expect(tinted.map((head) => head.getAttribute('data-kanban-column-tint'))).toEqual(['gray', 'blue', 'green'])
  })
})
