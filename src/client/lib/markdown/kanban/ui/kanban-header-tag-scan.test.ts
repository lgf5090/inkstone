/**
 * The header counts the board's live tags to offer the reader the values they could filter down to, and
 * what it counts them over is `kanbanActiveItems(data.items)` — a scan of every card. What made that
 * scan expensive was not its size but *when* it ran: the call was in the render body, so every repaint
 * of the header handed the tag bar a brand-new array, which is the memo key the bar counts on. The bar
 * then walked the whole board again for a language switch, a drag highlight landing, or any commit at
 * all — none of which move a tag.
 *
 * What is pinned here is that the scan belongs to the document rather than to the render: the header is
 * re-rendered with an unchanged board, and the bar must not repaint. The wrapper counts the bar's own
 * renders the way `kanban-repaint-scope.test.ts` counts a card's — a `memo` around the real component,
 * so the count is reached only when the props actually changed, and the DOM under it is the shipping
 * one.
 */
import { createElement, memo, type ComponentProps } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import type { KanbanData } from '../types'
import { KanbanHeader } from './kanban-header'
import type { KanbanSchemaOperations } from './kanban-column-hooks'

const painted = vi.hoisted(() => [] as string[])

vi.mock('./kanban-tag-filter-bar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./kanban-tag-filter-bar')>()
  return {
    ...actual,
    KanbanTagFilterBar: memo((props: Parameters<typeof actual.KanbanTagFilterBar>[0]) => {
      painted.push('tag bar')
      return createElement(actual.KanbanTagFilterBar, props)
    }),
  }
})

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  painted.length = 0
})

const schemaOps: KanbanSchemaOperations = {
  addColumn: vi.fn(),
  renameColumn: vi.fn(),
  changeColumnType: vi.fn(),
  deleteColumn: vi.fn(),
  moveColumn: vi.fn(),
  resizeColumn: vi.fn(),
}

const data: KanbanData = {
  title: 'Gate Board',
  columns: [
    { id: 'title', name: 'Title', type: 'title' },
    {
      id: 'status',
      name: 'Status',
      type: 'select',
      options: [{ id: 'todo', label: 'To Do', color: 'gray' }],
    },
    { id: 'tags', name: 'Tags', type: 'multi-select', options: [{ id: 'urgent', label: 'Urgent', color: 'red' }] },
  ],
  items: [
    { id: 'a', title: 'A', properties: { status: 'todo', tags: ['urgent'] } },
    { id: 'b', title: 'B', properties: { status: 'todo' } },
  ],
  views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'status' }],
}

/**
 * The props the bar reads, held identical across the renders below, so what the bar repaints for is
 * the board's scan and nothing else.
 */
const stable = {
  onToggleTag: vi.fn(),
  onClearTags: vi.fn(),
  onSelectView: vi.fn(),
  onSearchChange: vi.fn(),
  onChangeFilters: vi.fn(),
  onChangeSorts: vi.fn(),
  onAddItem: vi.fn(),
  onUpdateBoardTitle: vi.fn(),
  onToggleHiddenColumn: vi.fn(),
  onChangeCardSize: vi.fn(),
  onChangeGroupBy: vi.fn(),
  onChangeSwimlaneBy: vi.fn(),
  onToggleCardField: vi.fn(),
  onToggleFullscreen: vi.fn(),
  viewOps: { createView: vi.fn(), renameView: vi.fn(), duplicateView: vi.fn(), deleteView: vi.fn(), moveView: vi.fn() },
  schemaOps,
}

/**
 * The list-valued props, held at one identity each: `filters`, `sorts` and `selectedTags` are memo
 * keys of their own children, so building them per call would re-render those children for a reason
 * this file is not about — and the bar under test sits in the same tree.
 */
const EMPTY_FILTERS: ComponentProps<typeof KanbanHeader>['filters'] = []
const EMPTY_SORTS: ComponentProps<typeof KanbanHeader>['sorts'] = []
const EMPTY_TAGS: ComponentProps<typeof KanbanHeader>['selectedTags'] = []

function headerProps(overrides: Record<string, unknown> = {}): ComponentProps<typeof KanbanHeader> {
  return {
    ...stable,
    data,
    visibleItems: data.items,
    activeView: data.views[0]!,
    searchQuery: '',
    filters: EMPTY_FILTERS,
    sorts: EMPTY_SORTS,
    viewPanelId: 'view-panel',
    selectedTags: EMPTY_TAGS,
    ...overrides,
  } as ComponentProps<typeof KanbanHeader>
}

function mountHeader() {
  const rendered = renderElement(createElement(KanbanHeader, headerProps()))
  mounted.push(rendered)
  return rendered
}

describe('the header scans the board for tags when the board changes', () => {
  it('does not scan it again for a repaint that moved no card', () => {
    const rendered = mountHeader()
    expect(painted.length, 'the tag bar was not painted on the first render').toBe(1)

    // An unrelated prop moving is what re-renders the real header in practice: a keystroke in the
    // search box, a drag highlight, a commit that touched the view rather than the cards.
    rendered.rerender(createElement(KanbanHeader, headerProps({ searchQuery: 'a' })))
    expect(painted, 'a repaint that moved no card re-counted the board').toHaveLength(1)
  })

  it('scans it again as soon as the board itself changes', () => {
    const rendered = mountHeader()
    const edited: KanbanData = { ...data, items: [...data.items, { id: 'c', title: 'C', properties: { status: 'todo', tags: ['urgent'] } }] }
    rendered.rerender(createElement(KanbanHeader, headerProps({ data: edited, visibleItems: edited.items })))
    expect(painted.length, 'a new card left the tag counts stale').toBe(2)
  })

  it('counts the board once for the first paint rather than once per tag', () => {
    mountHeader()
    // The count itself is asserted by `kanban-header.test.ts`; what matters here is that the memo is
    // the thing producing it, so an unchanged board is answered from one scan.
    expect(painted).toHaveLength(1)
  })
})
