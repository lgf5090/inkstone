/**
 * Every panel in this module is dismissed by the pointer today and by nobody with a keyboard:
 * `Escape` reaches the board, finds no handler, and the reader is left inside an open popover
 * with the rest of the board dimmed behind their own focus (review #26/#29). The contract
 * asserted here is the one `components/overlay` already gives the app's other popovers —
 * `useEscape` plus the shared `useClickOutside` — so the panels close the same way, and a click
 * that lands inside the panel is still not a click outside it.
 */
import { act, createElement, type ReactNode, type RefObject } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { KanbanArchiveAction } from './kanban-archive'
import { KanbanColumnMenu } from './kanban-column-menu'
import { KanbanCsvAction } from './kanban-csv'
import { KanbanDatePicker } from './kanban-date-picker'
import { KanbanFilterPopover } from './kanban-filter-popover'
import { KanbanIconPicker } from './kanban-icon-picker'
import { KanbanItemDetail } from './kanban-item-detail'
import { KanbanSortPopover } from './kanban-sort-popover'
import { KanbanSubtaskMenu } from './kanban-subtask-menu'
import { KanbanTagPicker } from './kanban-tag-picker'
import { KanbanViewOptions } from './kanban-view-options'
import type { KanbanItem, KanbanProperty } from '../types'

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
]

/**
 * A test that fails mid-case never reaches its own `unmount()`, and a panel left in `document.body`
 * answers the next case's `querySelector` first — so teardown belongs to the harness.
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

function anchor(): RefObject<HTMLElement | null> {
  return { current: document.createElement('button') }
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

function pressMouseDown(target: Node): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
}

function openPanels(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"], [role="menu"], [role="listbox"]')
}

const PANEL_ID = 'panel-under-test'

/** The panels whose parent owns `open`, so dismissal is one callback to observe. */
const controlled: [string, (onClose: () => void) => ReactNode][] = [
  [
    'KanbanColumnMenu',
    (onClose) => createElement(KanbanColumnMenu, {
      open: true,
      panelId: PANEL_ID,
      onClose,
      anchorRef: anchor(),
      groupKey: 'todo',
      label: 'To Do',
      color: 'gray',
      onRename: vi.fn(),
      onChangeColor: vi.fn(),
      onChangeWipLimit: vi.fn(),
      onCollapse: vi.fn(),
      onDelete: vi.fn(),
    }),
  ],
  [
    'KanbanSortPopover',
    (onClose) => createElement(KanbanSortPopover, {
      open: true, panelId: PANEL_ID, onClose, anchorRef: anchor(), columns: COLUMNS, sorts: [], onChangeSorts: vi.fn(),
    }),
  ],
  [
    'KanbanFilterPopover',
    (onClose) => createElement(KanbanFilterPopover, {
      open: true, panelId: PANEL_ID, onClose, anchorRef: anchor(), columns: COLUMNS, filters: [], onChangeFilters: vi.fn(),
    }),
  ],
  [
    'KanbanViewOptions',
    (onClose) => createElement(KanbanViewOptions, {
      open: true, panelId: PANEL_ID, onClose, anchorRef: anchor(), columns: COLUMNS, groupBy: 'status', onChangeGroupBy: vi.fn(),
    }),
  ],
  [
    'KanbanIconPicker',
    (onClose) => createElement(KanbanIconPicker, {
      open: true, panelId: PANEL_ID, onClose, anchorRef: anchor(), onSelectIcon: vi.fn(),
    }),
  ],
  [
    'KanbanSubtaskMenu',
    (onClose) => createElement(KanbanSubtaskMenu, {
      open: true,
      panelId: PANEL_ID,
      onClose,
      anchorRef: anchor(),
      subtask: { id: 's1', title: 'Step', completed: false },
      onDuplicate: vi.fn(),
      onDelete: vi.fn(),
    }),
  ],
]

describe.each(controlled)('%s dismissal', (_name, build) => {
  it('closes on Escape', () => {
    const onClose = vi.fn()
    mount(build(onClose))
    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a click outside and stays open for a click inside', () => {
    const onClose = vi.fn()
    mount(build(onClose))
    const panel = openPanels()
    expect(panel, 'the panel did not render').not.toBeNull()
    pressMouseDown(panel!)
    expect(onClose, 'a click on the panel itself dismissed it').not.toHaveBeenCalled()
    pressMouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('KanbanDatePicker dismissal', () => {
  function openCalendar(): void {
    const rendered = mount(createElement(KanbanDatePicker, { propertyName: 'Start date', onChange: vi.fn() }))
    const trigger = [...rendered.container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(t('preview.kanban_select_date')))
    if (!trigger) throw new Error('the date trigger was not rendered')
    act(() => {
      trigger.click()
    })
  }

  it('puts the calendar away with Escape', () => {
    openCalendar()
    expect(openPanels(), 'the calendar did not open').not.toBeNull()
    pressEscape()
    expect(openPanels()).toBeNull()
  })

  it('puts the calendar away on a click outside', () => {
    openCalendar()
    pressMouseDown(document.body)
    expect(openPanels()).toBeNull()
  })
})

describe('KanbanTagPicker dismissal', () => {
  function openTagPopover(): void {
    const rendered = mount(createElement(KanbanTagPicker, {
      tags: [],
      options: COLUMNS[1]!.options,
      onChangeTags: vi.fn(),
    }))
    const trigger = rendered.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('preview.kanban_new_tag')}"]`,
    )
    if (!trigger) throw new Error('the tag trigger was not rendered')
    act(() => {
      trigger.click()
    })
  }

  it('puts the tag popover away with Escape', () => {
    openTagPopover()
    expect(openPanels(), 'the tag popover did not open').not.toBeNull()
    pressEscape()
    expect(openPanels()).toBeNull()
  })

  it('puts the tag popover away on a click outside', () => {
    openTagPopover()
    pressMouseDown(document.body)
    expect(openPanels()).toBeNull()
  })
})

describe('KanbanArchiveAction dismissal', () => {
  function openShelf(): void {
    const archived: KanbanItem = { id: 'z', title: 'Filed away', properties: { status: 'todo' }, archived: true }
    mount(createElement(KanbanArchiveAction, { items: [archived], deletedItems: [], onRestore: vi.fn(), onDelete: vi.fn(), onRestoreDeleted: vi.fn(), onPurge: vi.fn() }))
    const trigger = document.querySelector<HTMLButtonElement>('[data-kanban-archive]')
    if (!trigger) throw new Error('the archive trigger was not rendered')
    act(() => {
      trigger.click()
    })
  }

  it('puts the shelf away with Escape', () => {
    openShelf()
    expect(openPanels(), 'the archive panel did not open').not.toBeNull()
    pressEscape()
    expect(openPanels()).toBeNull()
  })

  it('puts the shelf away on a click outside, but not on a click inside it', () => {
    openShelf()
    const panel = openPanels()
    pressMouseDown(panel!)
    expect(openPanels(), 'a click inside the shelf dismissed it').toBe(panel)
    pressMouseDown(document.body)
    expect(openPanels()).toBeNull()
  })
})

describe('KanbanCsvAction dismissal', () => {
  function openDoor(): void {
    mount(createElement(KanbanCsvAction, { title: 'Board', columns: COLUMNS, items: [], itemCount: 0, commitData: vi.fn() }))
    const trigger = document.querySelector<HTMLButtonElement>('[data-kanban-csv]')
    if (!trigger) throw new Error('the CSV trigger was not rendered')
    act(() => {
      trigger.click()
    })
  }

  it('puts the CSV panel away with Escape', () => {
    openDoor()
    expect(openPanels(), 'the CSV panel did not open').not.toBeNull()
    pressEscape()
    expect(openPanels()).toBeNull()
  })

  it('puts the CSV panel away on a click outside, but not on a click inside it', () => {
    openDoor()
    const panel = openPanels()
    pressMouseDown(panel!)
    expect(openPanels(), 'a click inside the panel dismissed it').toBe(panel)
    pressMouseDown(document.body)
    expect(openPanels()).toBeNull()
  })
})

describe('status dropdown inside the card detail', () => {
  const item: KanbanItem = { id: 'i1', title: 'Detail target', properties: { status: 'todo' } }

  function openDropdown(): void {
    mount(createElement(KanbanItemDetail, {
      item,
      columns: COLUMNS,
      onClose: vi.fn(),
      onUpdate: vi.fn(),
      onDelete: vi.fn(),
      onConvertSubtask: vi.fn(),
      onAddColumnOption: vi.fn(),
    }))
    const trigger = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('To Do'))
    if (!trigger) throw new Error('the status trigger was not rendered')
    act(() => {
      trigger.click()
    })
  }

  function listbox(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[role="listbox"]')
  }

  it('closes the dropdown alone, leaving the detail dialog open', () => {
    openDropdown()
    expect(listbox(), 'the status dropdown did not open').not.toBeNull()
    pressEscape()
    expect(listbox()).toBeNull()
    expect(document.querySelector('[role="dialog"]'), 'Escape fell through to the detail dialog').not.toBeNull()
  })

  it('keeps closing on a click outside', () => {
    openDropdown()
    pressMouseDown(document.body)
    expect(listbox()).toBeNull()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})
