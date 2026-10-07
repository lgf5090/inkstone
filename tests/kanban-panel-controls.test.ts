import fs from 'node:fs'
import path from 'node:path'
import { createElement, type ReactNode, type RefObject } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import type { KanbanFilter, KanbanProperty, KanbanSort } from '../src/client/lib/markdown/kanban/types'
import { KanbanBatchBar } from '../src/client/lib/markdown/kanban/ui/kanban-batch-bar'
import { KanbanFilterPopover } from '../src/client/lib/markdown/kanban/ui/kanban-filter-popover'
import { KanbanSortPopover } from '../src/client/lib/markdown/kanban/ui/kanban-sort-popover'
import { KanbanViewOptions } from '../src/client/lib/markdown/kanban/ui/kanban-view-options'

/**
 * The board's panels were built out of native controls: ten `<select>`s with hand-written borders
 * around the OS arrow, and a card-size picker made of bare buttons whose chosen value was a colour
 * the reader had to notice rather than a state the browser could read out (user report 2026-09-23,
 * where the board was asked to stop drawing the browser's own controls). The panels are dense, but
 * dense is a size — not a reason to leave the component system, which is where the focus ring, the
 * chevron and the token palette live.
 *
 * Two rules, and each one is checked in the place the other cannot see.
 *
 *  1. What a panel actually renders. Every `<select>` in the board's own panels is drawn by the
 *     project's `Select`, which is recognisable from the outside by the two things it adds to the
 *     native element: `appearance-none` and a chevron beside it. A rule row that goes back to a bare
 *     `<select>` fails here.
 *  2. What the source holds. The rendered check can only see the panels a test happens to open, so the
 *     raw elements are also counted where they are written: every `<select` in the kanban UI has to be
 *     listed with its reason and its count, and a file that grows one — or a listed one that goes away
 *     — fails. This is the direction that keeps the next raw control from arriving unnoticed.
 *
 * The reason the tag cell is allowed to keep one is written next to it: it is a chip painted in the
 * option's own colour, where a bordered field and a tertiary chevron would land on top of that colour,
 * and every other cell of that table is a colour or icon affordance rather than an arrow.
 */
const UI_DIR = path.join('src', 'client', 'lib', 'markdown', 'kanban', 'ui')

/** The raw selects the source is allowed to hold, with the reason each one is not a `Select`. */
const RAW_SELECTS: Record<string, { count: number; reason: string }> = {
  'kanban-property-cell.tsx': {
    count: 1,
    reason: 'the table\'s tag chip: painted in the option colour, made non-native rather than bordered',
  },
}

function rawSelectCounts(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const file of fs.readdirSync(UI_DIR)) {
    if (!file.endsWith('.tsx') || file.endsWith('.test.tsx')) continue
    const found = fs.readFileSync(path.join(UI_DIR, file), 'utf8').match(/<select[\s>]/g)
    if (found) counts.set(file, found.length)
  }
  return counts
}

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  document.body.replaceChildren()
})

const COLUMNS: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  { id: 'points', name: 'Points', type: 'number' },
  {
    id: 'stage',
    name: 'Stage',
    type: 'select',
    options: [{ id: 's1', label: 'Alpha', color: 'gray' }, { id: 's2', label: 'Beta', color: 'blue' }],
  },
]

const SORTS: KanbanSort[] = [{ propertyId: 'points', direction: 'asc' }]
const FILTERS: KanbanFilter[] = [{ propertyId: 'stage', operator: 'is', value: 's1' }]

function mount(node: ReactNode) {
  const rendered = renderElement(node)
  mounted.push(rendered)
  return rendered.container
}

const anchorRef: RefObject<HTMLElement | null> = { current: null }

const SCHEMA_OPS = {
  renameColumn: vi.fn(),
  changeColumnType: vi.fn(),
  moveColumn: vi.fn(),
  deleteColumn: vi.fn(),
  addColumn: vi.fn(),
}

/**
 * The panels that hold a form control, each opened the way the board opens it and mounted inside its
 * own test: a mount done while the cases are being collected is undone by the first case's teardown,
 * and the rest of the run then reads an empty container rather than the panel it asked for.
 */
const PANELS: { name: string; build: () => HTMLElement }[] = [
  {
    name: 'the filter panel',
    build: () =>
      mount(
        createElement(KanbanFilterPopover, {
          open: true,
          panelId: 'p',
          onClose: vi.fn(),
          anchorRef,
          columns: COLUMNS,
          filters: FILTERS,
          onChangeFilters: vi.fn(),
        }),
      ),
  },
  {
    name: 'the sort panel',
    build: () =>
      mount(
        createElement(KanbanSortPopover, {
          open: true,
          panelId: 'p',
          onClose: vi.fn(),
          anchorRef,
          columns: COLUMNS,
          sorts: SORTS,
          onChangeSorts: vi.fn(),
        }),
      ),
  },
  {
    name: 'the view options panel',
    build: () =>
      mount(
        createElement(KanbanViewOptions, {
          open: true,
          panelId: 'p',
          onClose: vi.fn(),
          anchorRef,
          columns: COLUMNS,
          groupBy: 'stage',
          onChangeGroupBy: vi.fn(),
          onChangeSwimlaneBy: vi.fn(),
          schemaOps: SCHEMA_OPS,
          hiddenColumns: [],
          onToggleHiddenColumn: vi.fn(),
        }),
      ),
  },
  {
    name: 'the batch bar',
    build: () =>
      mount(
        createElement(KanbanBatchBar, {
          selectedCount: 2,
          groupColumn: COLUMNS[2],
          onBatchGroupChange: vi.fn(),
          onBatchArchive: vi.fn(),
          onBatchDelete: vi.fn(),
          onClearSelection: vi.fn(),
        }),
      ),
  },
]

/** A `Select` from the outside: the arrow is gone and the component's own chevron is beside it. */
function isComponentSelect(select: HTMLSelectElement): boolean {
  const styled = select.className.includes('appearance-none')
  const chevron = select.parentElement?.querySelector(':scope > svg[aria-hidden="true"]')
  return styled && Boolean(chevron)
}

describe('the board draws its panels with the component system', () => {
  it.each(PANELS.map((panel) => [panel.name, panel.build] as const))(
    '%s draws every picker through the shared Select',
    (name, build) => {
      const container = build()
      const selects = [...container.querySelectorAll<HTMLSelectElement>('select')]
      expect(selects.length, `${name} drew no picker at all`).toBeGreaterThan(0)
      const native = selects.filter((select) => !isComponentSelect(select))
      expect(native.map((select) => select.getAttribute('aria-label') ?? select.outerHTML.slice(0, 80))).toEqual([])
    },
  )

  it('draws the card size as a radio group rather than a row of unlabelled buttons', () => {
    const anchorRef: RefObject<HTMLElement | null> = { current: null }
    const container = mount(
      createElement(KanbanViewOptions, {
        open: true,
        panelId: 'p',
        onClose: vi.fn(),
        anchorRef,
        columns: COLUMNS,
        groupBy: 'stage',
        onChangeGroupBy: vi.fn(),
        groupByCardSize: undefined,
        cardSize: 'medium',
        onChangeCardSize: vi.fn(),
      }),
    )
    const group = container.querySelector<HTMLElement>('[role="radiogroup"]')
    expect(group, 'the card size is not a radio group').not.toBeNull()
    expect(group!.getAttribute('aria-label')).toBe(t('preview.kanban_card_size'))
    const radios = [...group!.querySelectorAll<HTMLElement>('[role="radio"]')]
    expect(radios).toHaveLength(3)
    // The chosen size is a state, not a shade: exactly one option reports itself as checked.
    expect(radios.filter((radio) => radio.getAttribute('aria-checked') === 'true')).toHaveLength(1)
  })
})

describe('the kanban UI holds no unaccounted-for raw select', () => {
  it('has exactly the raw selects that are listed with a reason', () => {
    const found = rawSelectCounts()
    const expected = new Map(Object.entries(RAW_SELECTS).map(([file, entry]) => [file, entry.count]))
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(expected))
  })

  it('leaves no listed file standing once its raw select is gone', () => {
    const found = rawSelectCounts()
    for (const file of Object.keys(RAW_SELECTS)) {
      expect(found.has(file), `${file} no longer holds a raw select; drop it from the list`).toBe(true)
    }
  })
})
