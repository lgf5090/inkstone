/**
 * A kanban panel that only answers the pointer is half a control: the trigger never says whether
 * it is open, and nothing points from the button to the panel it produced, so a reader pressing
 * Enter hears "button" and no state (review #26/#29). The contract asserted here is the one
 * `components/overlay/submenu.tsx` already keeps for the app's other popovers — `aria-haspopup`
 * with the panel's role, `aria-expanded` following `open`, and `aria-controls` naming a panel that
 * carries that `id` and has an accessible name of its own. The trigger and the panel usually live
 * in two components, so the relation is only observable by mounting whoever owns `open`.
 */
import { act, createElement, type ReactNode } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { formatKanbanGroupLabel, formatKanbanPropertyName } from '../i18n-helpers'
import { KanbanArchiveAction } from './kanban-archive'
import { CardHeader } from './kanban-card-header'
import { KanbanColumnHeader } from './kanban-column-header'
import { KanbanCsvAction } from './kanban-csv'
import { KanbanDatePicker } from './kanban-date-picker'
import { KanbanHeader } from './kanban-header'
import { KanbanItemDetail } from './kanban-item-detail'
import { KanbanPropertyCell } from './kanban-property-cell'
import { KanbanSubtaskList } from './kanban-subtask-list'
import { KanbanTagPicker } from './kanban-tag-picker'
import type { KanbanData, KanbanItem, KanbanProperty } from '../types'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const COLUMNS: KanbanProperty[] = [
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
  { id: 'startDate', name: 'Start date', type: 'date' },
]

const statusColumn = COLUMNS[1]!
const dateColumn = COLUMNS[2]!

const item: KanbanItem = {
  id: 'i1',
  title: 'Detail target',
  properties: { status: 'todo', startDate: '2026-09-19' },
  subtasks: [{ id: 's1', title: 'Step', completed: false }],
}

const data: KanbanData = { columns: COLUMNS, items: [item], views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'status' }] }

/**
 * Teardown belongs to the harness: a case that fails on its first assertion never reaches its own
 * `unmount()`, and the panel it left in `document.body` answers the next case's lookup first.
 */
const mounted: ReturnType<typeof renderElement>[] = []

function mount(node: ReactNode) {
  const rendered = renderElement(node)
  mounted.push(rendered)
  return rendered
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function click(node: HTMLElement): void {
  act(() => {
    node.click()
  })
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

function buttonByText(root: ParentNode, text: string): HTMLElement | null {
  return [...root.querySelectorAll('button')].find((node) => node.textContent?.includes(text)) ?? null
}

function namedButton(root: ParentNode, name: string): HTMLElement | null {
  return root.querySelector(`button[aria-label="${name}"]`)
}

function titledButton(root: ParentNode, title: string): HTMLElement | null {
  return root.querySelector(`button[title="${title}"]`)
}

function headerNode(): ReactNode {
  return createElement(KanbanHeader, {
    data,
    visibleItems: data.items,
    activeView: data.views[0]!,
    searchQuery: '',
    filters: [],
    sorts: [],
    cardSize: 'medium',
    onChangeGroupBy: vi.fn(),
    onChangeCardSize: vi.fn(),
    onSelectView: vi.fn(),
    onSearchChange: vi.fn(),
    onChangeFilters: vi.fn(),
    onChangeSorts: vi.fn(),
    onAddItem: vi.fn(),
    viewOps: {
      createView: vi.fn(),
      renameView: vi.fn(),
      duplicateView: vi.fn(),
      deleteView: vi.fn(),
      moveView: vi.fn(),
    },
    viewPanelId: 'view-panel',
  })
}

function detailNode(): ReactNode {
  return createElement(KanbanItemDetail, {
    item,
    columns: COLUMNS,
    onClose: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onConvertSubtask: vi.fn(),
    onAddColumnOption: vi.fn(),
  })
}

function subtaskListNode(): ReactNode {
  return createElement(KanbanSubtaskList, {
    subtasks: item.subtasks!,
    onUpdateSubtasks: vi.fn(),
  })
}

function cardHeaderNode(): ReactNode {
  return createElement(CardHeader, {
    isSelected: false,
    itemId: item.id,
    tagVals: [],
    tagsCol: statusColumn,
    onToggleSelect: vi.fn(),
    onOpenDetail: vi.fn(),
    onUpdateTags: vi.fn(),
  })
}

type PanelRole = 'dialog' | 'menu' | 'listbox'

interface Pair {
  label: string
  node: () => ReactNode
  trigger: (root: ParentNode) => HTMLElement | null
  panelRole: PanelRole
}

const PAIRS: Pair[] = [
  {
    label: 'column menu',
    node: () => createElement(KanbanColumnHeader, {
      groupKey: 'section',
      label: 'Backlog',
      count: 1,
      onDragStart: vi.fn(),
      onRename: vi.fn(),
      onChangeColor: vi.fn(),
      onChangeWipLimit: vi.fn(),
      onCollapse: vi.fn(),
    }),
    trigger: (root) => namedButton(root, formatKanbanGroupLabel('section', 'Backlog')),
    panelRole: 'dialog',
  },
  { label: 'sort popover', node: headerNode, trigger: (root) => buttonByText(root, t('preview.kanban_sort')), panelRole: 'dialog' },
  { label: 'filter popover', node: headerNode, trigger: (root) => buttonByText(root, t('preview.kanban_filter')), panelRole: 'dialog' },
  {
    label: 'view options popover',
    node: headerNode,
    trigger: (root) => namedButton(root, t('preview.kanban_group_by')),
    panelRole: 'dialog',
  },
  { label: 'icon picker in the card detail', node: detailNode, trigger: (root) => titledButton(root, t('preview.kanban_icon_picker')), panelRole: 'dialog' },
  { label: 'icon picker on a subtask row', node: subtaskListNode, trigger: (root) => titledButton(root, t('preview.kanban_icon_picker')), panelRole: 'dialog' },
  { label: 'subtask action menu', node: subtaskListNode, trigger: (root) => namedButton(root, t('common.more_actions')), panelRole: 'menu' },
  { label: 'new view menu', node: headerNode, trigger: (root) => namedButton(root, t('preview.kanban_new_view')), panelRole: 'menu' },
  { label: 'active view menu', node: headerNode, trigger: (root) => namedButton(root, t('preview.kanban_view_actions')), panelRole: 'menu' },
  { label: 'status dropdown', node: detailNode, trigger: (root) => buttonByText(root, 'To Do'), panelRole: 'listbox' },
  {
    label: 'date calendar',
    node: () => createElement(KanbanDatePicker, {
      propertyName: 'Start date',
      value: '2026-09-19',
      onChange: vi.fn(),
    }),
    trigger: (root) => root.querySelector('button'),
    panelRole: 'dialog',
  },
  {
    label: 'tag popover in the tag field',
    node: () => createElement(KanbanTagPicker, { tags: [], options: statusColumn.options, onChangeTags: vi.fn() }),
    trigger: (root) => namedButton(root, t('preview.kanban_new_tag')),
    panelRole: 'dialog',
  },
  { label: 'tag popover on a card', node: cardHeaderNode, trigger: (root) => namedButton(root, t('preview.kanban_new_tag')), panelRole: 'dialog' },
  {
    label: 'CSV door',
    node: () => createElement(KanbanCsvAction, {
      title: 'Board',
      columns: COLUMNS,
      items: [item],
      itemCount: 1,
      commitData: vi.fn(),
    }),
    trigger: (root) => root.querySelector<HTMLElement>('[data-kanban-csv]'),
    panelRole: 'dialog',
  },
  {
    label: 'archive shelf',
    node: () => createElement(KanbanArchiveAction, {
      items: [{ ...item, archived: true }],
      deletedItems: [],
      onRestore: vi.fn(),
      onDelete: vi.fn(),
      onRestoreDeleted: vi.fn(),
      onPurge: vi.fn(),
    }),
    trigger: (root) => root.querySelector<HTMLElement>('[data-kanban-archive]'),
    panelRole: 'dialog',
  },
]

function requireTrigger(pair: Pair, root: ParentNode): HTMLElement {
  const trigger = pair.trigger(root)
  if (!trigger) throw new Error(`the ${pair.label} trigger was not rendered with that name`)
  return trigger
}

describe.each(PAIRS)('$label', (pair) => {
  it('says whether the panel is open and points at it', () => {
    mount(pair.node())
    const trigger = requireTrigger(pair, document)

    expect(trigger.getAttribute('aria-haspopup'), 'the trigger never says what it opens').toBe(pair.panelRole)
    expect(trigger.getAttribute('aria-expanded'), 'a closed panel must read as closed').toBe('false')

    click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    const panelId = trigger.getAttribute('aria-controls')
    expect(panelId, 'the trigger must name the panel it opened').toBeTruthy()
    const panel = document.getElementById(panelId!)
    expect(panel, `no panel carries id "${panelId}"`).not.toBeNull()
    expect(panel!.getAttribute('role')).toBe(pair.panelRole)
    expect(panel!.getAttribute('aria-label') || panel!.getAttribute('aria-labelledby'), 'the panel has no accessible name').toBeTruthy()
  })

  it('closes on Escape without moving the focus off the trigger', () => {
    mount(pair.node())
    const trigger = requireTrigger(pair, document)

    trigger.focus()
    click(trigger)
    pressEscape()

    expect(trigger.getAttribute('aria-expanded'), 'the panel stayed open under Escape').toBe('false')
    expect(document.activeElement, 'closing dropped the focus somewhere else').toBe(trigger)
  })
})

describe('date trigger naming the property it edits', () => {
  function cellRoot(): HTMLElement {
    return mount(createElement(KanbanPropertyCell, {
      column: dateColumn,
      item,
      onUpdateProperty: vi.fn(),
      onUpdateMultiSelect: vi.fn(),
      onUpdateFiles: vi.fn(),
    })).container
  }

  it('adds the column name to the value the cell already reads out', () => {
    const trigger = cellRoot().querySelector('button')!
    const name = trigger.textContent ?? ''

    expect(name, 'the cell lost the date it shows').toContain('2026-09-19')
    expect(name, 'the cell never says which column it edits').toContain(formatKanbanPropertyName(dateColumn))
  })

  it('keeps the column name out of the painted text', () => {
    const trigger = cellRoot().querySelector('button')!
    const hidden = trigger.querySelector('span.sr-only')

    expect(hidden, 'the column name is visible text, so the cell shows it twice').not.toBeNull()
    expect(hidden!.textContent).toBe(formatKanbanPropertyName(dateColumn))
  })

  it('names the property behind every date trigger in the card detail', () => {
    mount(detailNode())
    const triggers = [...document.querySelectorAll('button')]
      .filter((node) => node.textContent?.includes('2026-09-19'))

    expect(triggers.length, 'the detail renders no date trigger for this item').toBeGreaterThan(0)
    for (const trigger of triggers) {
      const hidden = trigger.querySelector('span.sr-only')
      expect(hidden, `"${trigger.textContent}" is a date with no property attached to it`).not.toBeNull()
      expect(hidden!.textContent!.trim()).not.toBe('')
    }
  })
})
