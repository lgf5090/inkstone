/**
 * AGENTS.md rule 10 forbids simulating a control with a div plus a click handler, and a card
 * container that also carries `role='button'` is an axe `nested-interactive` violation the moment
 * anything focusable sits inside it — which is exactly the case for the board, gallery and list
 * cards, all of which hold a checkbox, a tag picker and a subtask expander (review #29). A fake
 * button there is worse than no button: it announces "button" for the whole card while a real
 * control inside may or may not answer Enter. These cases pin the shape the pass moved to — no
 * element in the board claims `role='button'`, and opening an item goes through a real `<button>`
 * in every view that shows cards, so a keyboard reader has one unambiguous target per card.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import type { KanbanData, KanbanViewType } from '../types'
import { CollapsedColumn } from './kanban-column-header'
import { KanbanRoot } from './kanban-root'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const VIEW_TYPES: KanbanViewType[] = ['board', 'table', 'list', 'gallery']

const data: KanbanData = {
  columns: [
    { id: 'title', name: 'Title', type: 'title' },
    {
      id: 'status',
      name: 'Status',
      type: 'select',
      options: [
        { id: 'todo', label: 'To Do', color: 'gray' },
        { id: 'doing', label: 'In Progress', color: 'blue' },
      ],
    },
  ],
  items: [
    {
      id: 'a',
      title: 'Design spec',
      subtasks: [
        { id: 's1', title: 'Draft the outline', completed: false },
        { id: 's2', title: 'Review it', completed: true },
      ],
      properties: { status: 'todo' },
    },
    { id: 'b', title: 'Empty ticket', properties: { status: 'doing' } },
  ],
  views: VIEW_TYPES.map((type) => ({ id: `v-${type}`, name: type, type, groupBy: 'status' })),
} as KanbanData

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mount(node: Parameters<typeof renderElement>[0]) {
  const rendered = renderElement(node)
  mounted.push(rendered)
  return rendered
}

function mountBoard() {
  return mount(createElement(KanbanRoot, { initialData: data, onUpdateData: vi.fn() }))
}

function selectView(container: HTMLElement, type: KanbanViewType): void {
  const tab = container.querySelector<HTMLElement>(`[role="tab"][data-view-type="${type}"]`)
  expect(tab, `no tab for the ${type} view`).not.toBeNull()
  act(() => {
    tab!.click()
  })
  // A view that did not switch would leave the walk measuring the board instead.
  const selected = container.querySelector<HTMLElement>(
    `[role="tab"][data-view-type="${type}"][aria-selected="true"]`,
  )
  expect(selected, `clicking the ${type} tab did not select it`).not.toBeNull()
}

function expandSubtaskPanels(container: HTMLElement): void {
  const label = t('preview.kanban_expand_subtasks')
  const expanders = [...container.querySelectorAll<HTMLElement>('button[aria-expanded="false"]')].filter((button) =>
    (button.getAttribute('aria-label') ?? button.textContent ?? '').includes(label),
  )
  expect(expanders.length, `no ${label.toLowerCase()} control to open`).toBeGreaterThan(0)
  for (const expander of expanders) {
    act(() => {
      expander.click()
    })
  }
}

function labelOf(button: HTMLElement): string {
  return (button.getAttribute('aria-label') ?? button.textContent ?? '').trim()
}

/** The card's own open control: named after the item, or the details button the board card shows. */
function openControl(container: HTMLElement): HTMLElement {
  const cards = container.querySelectorAll<HTMLElement>('[data-item-id="a"]')
  expect(cards.length, 'the item is rendered more than once').toBe(1)
  const candidates = [...cards[0]!.querySelectorAll<HTMLElement>('button')]
  const target = candidates.find(
    (button) => labelOf(button).includes('Design spec') || labelOf(button) === t('preview.kanban_card_details'),
  )
  if (!target) {
    throw new Error(`no real button opens the card: ${candidates.map(labelOf).join(', ')}`)
  }
  return target
}

describe('no element simulates a button', () => {
  for (const type of VIEW_TYPES) {
    it(`renders the ${type} view without a role=button element`, () => {
      const { container } = mountBoard()
      selectView(container, type)
      expandSubtaskPanels(container)
      expect(container.querySelectorAll('[role="button"]')).toHaveLength(0)
    })
  }
})

describe('every card view opens an item through a real control', () => {
  for (const type of ['board', 'list', 'gallery'] as KanbanViewType[]) {
    it(`opens the detail dialog from a button in the ${type} card`, () => {
      const { container } = mountBoard()
      selectView(container, type)
      const control = openControl(container)
      act(() => {
        control.click()
      })
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    })

    it(`keeps the ${type} card body a container rather than a click target of its own`, () => {
      const { container } = mountBoard()
      selectView(container, type)
      // The card's own controls open the item (asserted above); the body they are drawn on does not,
      // which is what keeps a card surface from drifting back into one click target holding controls
      // (SH-107) — the shape the raw-control guard and axe's `nested-interactive` both watch for.
      const body = container.querySelector<HTMLElement>('[data-item-id="a"] > div')
      expect(body, 'the card renders no body element to click').not.toBeNull()
      act(() => {
        body!.click()
      })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
  }
})

describe('the card keyboard move still reaches the card', () => {
  it('moves the item to the next column on Shift+ArrowRight from a control inside the card', () => {
    const onUpdateData = vi.fn()
    const { container } = mount(
      createElement(KanbanRoot, { initialData: data, onUpdateData }),
    )
    // The container is no longer focusable, so the chord is pressed on a control inside it.
    const control = openControl(container)
    control.focus()
    act(() => {
      control.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }),
      )
    })
    expect(onUpdateData, 'Shift+ArrowRight never reached the card handler').toHaveBeenCalledTimes(1)
    const committed = onUpdateData.mock.calls[0]![0] as KanbanData
    expect(committed.items.find((item) => item.id === 'a')?.properties.status).toBe('doing')
  })
})

describe('the collapsed column is a real button', () => {
  const group = { groupKey: 'todo', label: 'To Do', items: [] }

  it('is a native button that expands the column when clicked', () => {
    const onExpand = vi.fn()
    const { container } = mount(
      createElement(CollapsedColumn, {
        group,
        onExpand,
        onDrop: vi.fn(),
        onDragOver: vi.fn(),
        isDragOver: false,
      }),
    )
    const column = container.querySelector<HTMLElement>('button')
    expect(column?.tagName).toBe('BUTTON')
    expect(column?.getAttribute('aria-label')).toBe(t('preview.kanban_expand_column_named', { name: 'To Do' }))
    act(() => {
      column!.click()
    })
    expect(onExpand).toHaveBeenCalledTimes(1)
  })
})

describe('the card subtask bar is a real button', () => {
  /** The bar keeps its visible "1/2" counter, so its action label comes from `aria-label`. */
  function subtaskBar(container: HTMLElement, expanded: boolean): HTMLElement | null {
    const label = t(expanded ? 'preview.kanban_collapse_subtasks' : 'preview.kanban_expand_subtasks')
    return container.querySelector<HTMLElement>(
      `[data-item-id="a"] button[aria-expanded="${expanded}"][aria-label="${label}"]`,
    )
  }

  it('names itself, flips aria-expanded and reveals the subtasks', () => {
    const { container } = mountBoard()
    selectView(container, 'board')
    const bar = subtaskBar(container, false)
    expect(bar, 'the subtask bar is not a button that names its action').not.toBeNull()
    act(() => {
      bar!.click()
    })
    expect(subtaskBar(container, true), 'clicking the bar did not flip it to the collapse label').not.toBeNull()
    expect(container.querySelector('[data-item-id="a"]')?.textContent).toContain('Draft the outline')
  })
})

// Both rules below are things the axe pass over the real overlay found broken: the board's top bar
// was a `<header>`, which inside the board's own region landmark is a second banner of the page, and
// a card title was an `<h4>` under the board title's `<h2>`, which skips the level a reader expects
// between the two. The inline block is measured by the same two assertions, because it is the same
// markup moved to a different host.
describe('the board does not claim landmarks twice', () => {
  it('keeps its top bar out of the banner landmark', () => {
    const { container } = mountBoard()

    expect(container.querySelector('header'), 'the top bar is a second banner inside the board').toBeNull()
    expect(container.querySelector('[role="banner"]')).toBeNull()
    expect(container.querySelector('[data-kanban-header]'), 'the top bar no longer has a hook of its own').not.toBeNull()
  })

  it.each(['board', 'gallery'] as KanbanViewType[])(
    'titles a card one level under the board title in the %s view',
    (type) => {
      const { container } = mountBoard()
      selectView(container, type)

      expect(container.querySelector<HTMLElement>('[data-item-id="a"] h3')?.textContent).toContain('Design spec')
      expect(container.querySelectorAll('h4'), `a ${type} card title skips a level under the board title`).toHaveLength(0)
    },
  )

  it('offers the list row a button rather than a heading', () => {
    const { container } = mountBoard()
    selectView(container, 'list')

    expect(container.querySelector('[data-item-id="a"] h3'), 'the list would need the same level as the cards').toBeNull()
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-item-id="a"] button')].some((button) => button.textContent?.includes('Design spec')),
      'the list row offers no control that opens the item',
    ).toBe(true)
  })
})
