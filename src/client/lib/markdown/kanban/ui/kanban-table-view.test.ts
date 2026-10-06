import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals } from '../../../test-render'
import { KanbanTableView } from './kanban-table-view'
import { formatKanbanPropertyName } from '../i18n-helpers'
import type { KanbanData, KanbanFile, KanbanProperty, KanbanSort } from '../types'

beforeAll(async () => {
  await initI18n()
})

type TableProps = ComponentProps<typeof KanbanTableView>
type TableHandlers = Pick<
  TableProps,
  | 'onAddItem'
  | 'onAddColumn'
  | 'onSortColumn'
  | 'onUpdateProperty'
  | 'onUpdateMultiSelect'
  | 'onUpdateSubtasks'
  | 'onUpdateFiles'
  | 'selectedIds'
  | 'people'
>

function mountTable(data: KanbanData, props: TableHandlers) {
  installTestGlobals()
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(
      createElement(KanbanTableView, {
        data,
        view: data.views[0],
        onToggleSelect: vi.fn(),
        onToggleAll: vi.fn(),
        onOpenDetail: vi.fn(),
        ...props,
      }),
    )
  })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

const data: KanbanData = {
  columns: [
    {
      id: 'status',
      name: 'Status',
      type: 'select',
      options: [
        { id: 'todo', label: 'To Do', color: 'gray' },
        { id: 'in_progress', label: 'In Progress', color: 'blue' },
      ],
    },
  ],
  items: [{ id: 'a', title: 'A', properties: { status: 'todo' } }],
  views: [{ id: 'v', name: 'Table', type: 'table', groupBy: 'status' }],
}

function addGroupButton(container: HTMLElement): HTMLButtonElement {
  const label = t('preview.kanban_add_new_group')
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes(label))
  if (!button) throw new Error(`no button labelled "${label}"`)
  return button
}

describe('KanbanTableView add group', () => {
  it('adds a group option instead of a card', () => {
    const onAddColumn = vi.fn()
    const onAddItem = vi.fn()
    const { container, unmount } = mountTable(data, handlers({ onAddItem, onAddColumn }))
    act(() => { addGroupButton(container).click() })
    expect(onAddColumn).toHaveBeenCalledTimes(1)
    expect(onAddItem).not.toHaveBeenCalled()
    unmount()
  })
})

const schemaColumns: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'todo', label: 'To Do', color: 'gray' },
      { id: 'in_progress', label: 'In Progress', color: 'blue' },
    ],
  },
  {
    id: 'priority',
    name: 'Priority',
    type: 'select',
    options: [
      { id: 'low', label: 'Low', color: 'green' },
      { id: 'high', label: 'High', color: 'red' },
    ],
  },
  { id: 'spec', name: 'Spec file', type: 'text' },
  { id: 'story', name: 'Story points', type: 'number' },
  { id: 'deadline', name: 'Deadline', type: 'date' },
  {
    id: 'tags',
    name: 'Tags',
    type: 'multi-select',
    options: [
      { id: 'bug', label: 'Bug', color: 'red' },
      { id: 'feature', label: 'Feature', color: 'green' },
    ],
  },
  { id: 'reviewer', name: 'Reviewer', type: 'person' },
  { id: 'blocked', name: 'Blocked', type: 'checkbox' },
]

const schemaFile: KanbanFile = {
  id: 'f-1',
  name: 'report.pdf',
  size: 2048,
  mime: 'application/pdf',
  url: 'https://cdn.example.com/report.pdf',
}

const schemaData: KanbanData = {
  columns: schemaColumns,
  items: [
    {
      id: 'a',
      title: 'Design spec',
      files: [schemaFile],
      properties: {
        status: 'todo',
        priority: 'high',
        spec: 'docs/a.md',
        story: 5,
        deadline: '2026-09-30',
        tags: ['bug'],
        reviewer: 'Nora',
        blocked: true,
      },
    },
    { id: 'b', title: 'Empty ticket', properties: { status: 'in_progress' } },
  ],
  views: [{ id: 'v', name: 'Table', type: 'table', groupBy: 'status' }],
}

function headerLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-kanban-column]')]
    .filter((el) => !el.closest('[data-item-id]'))
    .map((el) => el.textContent ?? '')
}

function cellOf(container: HTMLElement, itemId: string, columnId: string): HTMLElement {
  const cell = container.querySelector<HTMLElement>(`[data-item-id="${itemId}"] [data-kanban-column="${columnId}"]`)
  if (!cell) throw new Error(`no cell for item "${itemId}" column "${columnId}"`)
  return cell
}

function cellText(container: HTMLElement, itemId: string, columnId: string): string {
  return cellOf(container, itemId, columnId).textContent ?? ''
}

function handlers(overrides: Partial<TableHandlers> = {}): TableHandlers {
  return {
    selectedIds: new Set<string>(),
    onAddItem: vi.fn(),
    onAddColumn: vi.fn(),
    onSortColumn: vi.fn(),
    onUpdateProperty: vi.fn(),
    onUpdateMultiSelect: vi.fn(),
    onUpdateFiles: vi.fn(),
    people: {},
    ...overrides,
  }
}

describe('KanbanTableView schema columns', () => {
  it('headers every schema column in schema order and appends the attachments column', () => {
    const { container, unmount } = mountTable(schemaData, handlers())
    expect(headerLabels(container)).toEqual([
      ...schemaColumns.map((col) => formatKanbanPropertyName(col)),
      t('preview.kanban_files'),
    ])
    unmount()
  })

  it('renders each property value in its own column', () => {
    const { container, unmount } = mountTable(schemaData, handlers())
    expect(cellInput(container, 'a', 'spec').value).toBe('docs/a.md')
    expect(cellInput(container, 'a', 'story').value).toBe('5')
    expect(personTrigger(container, 'a', 'reviewer').textContent).toContain('Nora')
    expect(cellText(container, 'a', 'deadline')).toContain('2026-09-30')
    expect(cellText(container, 'a', 'priority')).toContain(t('preview.kanban_priority_high'))
    expect(cellText(container, 'a', 'tags')).toContain(t('preview.kanban_tag_bug'))
    unmount()
  })
})

describe('KanbanTableView schema cells', () => {
  it('keeps a select column editable and writes the chosen option id', () => {
    const onUpdateProperty = vi.fn()
    const { container, unmount } = mountTable(schemaData, handlers({ onUpdateProperty }))
    const select = cellOf(container, 'a', 'priority').querySelector<HTMLSelectElement>('select')!
    expect(select.value).toBe('high')
    act(() => {
      select.value = 'low'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onUpdateProperty).toHaveBeenCalledWith('a', 'priority', 'low')
    unmount()
  })

  it('shows the option label when a document stored the label instead of the id', () => {
    const labelValued: KanbanData = {
      ...schemaData,
      items: [{ id: 'a', title: 'Imported', properties: { status: 'In Progress', priority: 'High' } }],
    }
    const { container, unmount } = mountTable(labelValued, handlers())
    expect(cellText(container, 'a', 'status')).toContain(t('preview.kanban_status_in_progress'))
    expect(cellText(container, 'a', 'priority')).toContain(t('preview.kanban_priority_high'))
    unmount()
  })

  it('moves tag chips out of the title cell into their own column', () => {
    const { container, unmount } = mountTable(schemaData, handlers())
    expect(cellText(container, 'a', 'title')).not.toContain(t('preview.kanban_tag_bug'))
    expect(cellText(container, 'a', 'title')).toContain('Design spec')
    unmount()
  })

  it('marks a checked checkbox column and leaves an empty cell as an empty input', () => {
    const { container, unmount } = mountTable(schemaData, handlers())
    expect(cellOf(container, 'a', 'blocked').querySelector<HTMLInputElement>('input')?.checked).toBe(true)
    const text = cellOf(container, 'b', 'spec').querySelector<HTMLInputElement>('input')!
    const number = cellOf(container, 'b', 'story').querySelector<HTMLInputElement>('input')!
    expect(text.type).toBe('text')
    expect(text.value).toBe('')
    expect(number.type).toBe('number')
    expect(number.value).toBe('')
    unmount()
  })
})

describe('KanbanTableView attachments column', () => {
  it('writes attachments through the item files writer', () => {
    const onUpdateFiles = vi.fn()
    const { container, unmount } = mountTable(schemaData, handlers({ onUpdateFiles }))
    expect(cellText(container, 'a', 'files')).toContain('report.pdf')
    const deleteButton = cellOf(container, 'a', 'files').querySelector<HTMLButtonElement>(
      `button[title="${t('preview.kanban_delete_file')}"]`,
    )!
    act(() => { deleteButton.click() })
    expect(onUpdateFiles).toHaveBeenCalledWith('a', [])
    unmount()
  })
})

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function blur(input: HTMLElement) {
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
}

function pressKey(el: HTMLElement, key: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

function cellInput(container: HTMLElement, itemId: string, columnId: string): HTMLInputElement {
  const input = cellOf(container, itemId, columnId).querySelector<HTMLInputElement>('input:not([type=checkbox])')
  if (!input) throw new Error(`no text input in cell "${itemId}"/"${columnId}"`)
  return input
}

function buttonNamed(cell: HTMLElement, name: string): HTMLButtonElement {
  const button = [...cell.querySelectorAll('button')].find((el) => el.getAttribute('aria-label') === name)
  if (!button) throw new Error(`no button named "${name}" in ${cell.dataset.kanbanColumn}`)
  return button
}

function personTrigger(container: HTMLElement, itemId: string, columnId: string): HTMLButtonElement {
  const column = schemaColumns.find((col) => col.id === columnId)
  return buttonNamed(
    cellOf(container, itemId, columnId),
    t('preview.kanban_person_change', { property: formatKanbanPropertyName(column!) }),
  )
}

describe('KanbanTableView inline editing', () => {
  it('commits a text cell once on blur and discards an escaped draft', () => {
    const onUpdateProperty = vi.fn()
    const { container, unmount } = mountTable(schemaData, handlers({ onUpdateProperty }))
    const input = cellInput(container, 'a', 'spec')
    expect(input.value).toBe('docs/a.md')
    act(() => { typeInto(input, 'docs/a.md') })
    expect(onUpdateProperty).not.toHaveBeenCalled()
    act(() => { typeInto(input, 'docs/draft.md') })
    expect(onUpdateProperty).not.toHaveBeenCalled()
    act(() => { blur(input) })
    expect(onUpdateProperty).toHaveBeenCalledTimes(1)
    expect(onUpdateProperty).toHaveBeenCalledWith('a', 'spec', 'docs/draft.md')
    act(() => { typeInto(input, 'Abandoned') })
    act(() => { pressKey(input, 'Escape') })
    act(() => { blur(input) })
    expect(onUpdateProperty).toHaveBeenCalledTimes(1)
    expect(input.value).not.toBe('Abandoned')
    unmount()
  })

  it('commits a text cell on Enter as well', () => {
    const onUpdateProperty = vi.fn()
    const { container, unmount } = mountTable(schemaData, handlers({ onUpdateProperty }))
    const input = cellInput(container, 'a', 'spec')
    act(() => {
      typeInto(input, 'docs/b.md')
      pressKey(input, 'Enter')
    })
    expect(onUpdateProperty).toHaveBeenCalledWith('a', 'spec', 'docs/b.md')
    unmount()
  })
})

describe('KanbanTableView inline number editing', () => {
  it('names the text and number cell controls after their own column', () => {
    const { container, unmount } = mountTable(schemaData, handlers())
    expect(cellInput(container, 'a', 'spec').getAttribute('aria-label')).toBe('Spec file')
    expect(cellInput(container, 'a', 'story').getAttribute('aria-label')).toBe('Story points')
    unmount()
  })

  it('writes a number cell as a number and an emptied one as blank', () => {
    const onUpdateProperty = vi.fn()
    const { container, unmount } = mountTable(schemaData, handlers({ onUpdateProperty }))
    const input = cellInput(container, 'a', 'story')
    expect(input.value).toBe('5')
    act(() => {
      typeInto(input, '8')
      blur(input)
    })
    expect(onUpdateProperty).toHaveBeenCalledWith('a', 'story', 8)
    act(() => {
      typeInto(input, '')
      blur(input)
    })
    expect(onUpdateProperty).toHaveBeenLastCalledWith('a', 'story', '')
    unmount()
  })
})

describe('KanbanTableView inline date editing', () => {
  it('edits a date cell through the calendar and clears it', () => {
    const onUpdateProperty = vi.fn()
    const { container, unmount } = mountTable(schemaData, handlers({ onUpdateProperty }))
    const cell = cellOf(container, 'a', 'deadline')
    expect(cell.textContent).toContain('2026-09-30')
    const trigger = cell.querySelector('button')!
    act(() => { trigger.click() })
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    act(() => { [...dialog.querySelectorAll('button')].find((el) => el.textContent === '15')!.click() })
    expect(onUpdateProperty).toHaveBeenLastCalledWith('a', 'deadline', '2026-09-15')
    act(() => { buttonNamed(cellOf(container, 'a', 'deadline'), t('preview.kanban_clear_date')).click() })
    expect(onUpdateProperty).toHaveBeenLastCalledWith('a', 'deadline', '')
    unmount()
  })
})

function headerCell(container: HTMLElement, columnId: string): HTMLElement {
  const cell = [...container.querySelectorAll<HTMLElement>('[data-kanban-column]')]
    .filter((el) => !el.closest('[data-item-id]'))
    .find((el) => el.dataset.kanbanColumn === columnId)
  if (!cell) throw new Error(`no header cell for column "${columnId}"`)
  return cell
}

function tableWithSorts(sorts: KanbanSort[] | undefined): KanbanData {
  return { ...schemaData, views: [{ ...schemaData.views[0]!, sorts }] }
}

describe('KanbanTableView header sorting', () => {
  it('reports the clicked column so the view can sort by it', () => {
    const onSortColumn = vi.fn()
    const { container, unmount } = mountTable(schemaData, handlers({ onSortColumn }))
    act(() => { headerCell(container, 'priority').querySelector('button')!.click() })
    expect(onSortColumn).toHaveBeenCalledWith('priority')
    act(() => { headerCell(container, 'title').querySelector('button')!.click() })
    expect(onSortColumn).toHaveBeenLastCalledWith('title')
    unmount()
  })

  it('names the header after the column sort stored on the view', () => {
    const column = formatKanbanPropertyName('priority')
    const unset = mountTable(tableWithSorts(undefined), handlers())
    const asc = mountTable(tableWithSorts([{ propertyId: 'priority', direction: 'asc' }]), handlers())
    expect(headerCell(unset.container, 'priority').querySelector('button')?.getAttribute('aria-label'))
      .toBe(t('preview.kanban_sort_by_column', { column }))
    expect(headerCell(asc.container, 'priority').querySelector('button')?.getAttribute('aria-label'))
      .toBe(t('preview.kanban_sorted_ascending', { column }))
    unset.unmount()
    asc.unmount()
  })

  it('names a descending column sort and keeps the attachments column unsortable', () => {
    const { container, unmount } = mountTable(tableWithSorts([{ propertyId: 'story', direction: 'desc' }]), handlers())
    const storyColumn = schemaColumns.find((col) => col.id === 'story')!
    expect(headerCell(container, 'story').querySelector('button')?.getAttribute('aria-label'))
      .toBe(t('preview.kanban_sorted_descending', { column: formatKanbanPropertyName(storyColumn) }))
    expect(headerCell(container, 'files').querySelector('button')).toBeNull()
    unmount()
  })
})

describe('KanbanTableView inline tag editing', () => {
  it('adds and removes tags in place through the multi-select writer', () => {
    const onUpdateMultiSelect = vi.fn()
    const { container, unmount } = mountTable(schemaData, handlers({ onUpdateMultiSelect }))
    const cell = cellOf(container, 'a', 'tags')
    act(() => { buttonNamed(cell, t('preview.kanban_remove_tag_named', { name: t('preview.kanban_tag_bug') })).click() })
    expect(onUpdateMultiSelect).toHaveBeenCalledWith('a', 'tags', [], undefined)
    act(() => { buttonNamed(cellOf(container, 'a', 'tags'), t('preview.kanban_new_tag')).click() })
    const popover = container.querySelector<HTMLElement>('[role="dialog"]')!
    const feature = [...popover.querySelectorAll('button')].find((el) =>
      el.textContent?.includes(t('preview.kanban_tag_feat')),
    )!
    act(() => { feature.click() })
    expect(onUpdateMultiSelect).toHaveBeenLastCalledWith('a', 'tags', ['bug', 'feature'], undefined)
    unmount()
  })

  it('creates a missing tag option from the cell and hands it to the writer', () => {
    const onUpdateMultiSelect = vi.fn()
    const { container, unmount } = mountTable(schemaData, handlers({ onUpdateMultiSelect }))
    const cell = cellOf(container, 'a', 'tags')
    act(() => { buttonNamed(cell, t('preview.kanban_new_tag')).click() })
    const popover = container.querySelector<HTMLElement>('[role="dialog"]')!
    const field = popover.querySelector<HTMLInputElement>('input[type="text"]')!
    act(() => {
      typeInto(field, 'Urgent')
      pressKey(field, 'Enter')
    })
    expect(onUpdateMultiSelect).toHaveBeenCalledWith('a', 'tags', ['bug', 'urgent'], {
      id: 'urgent',
      label: 'Urgent',
      color: 'blue',
    })
    unmount()
  })
})

function tableHiding(hiddenColumns: string[]): KanbanData {
  return { ...schemaData, views: [{ ...schemaData.views[0]!, hiddenColumns }] }
}

function schemaLabel(columnId: string): string {
  const column = schemaColumns.find((col) => col.id === columnId)
  if (!column) throw new Error(`no fixture column "${columnId}"`)
  return formatKanbanPropertyName(column)
}

describe('KanbanTableView column visibility', () => {
  it('drops a hidden column from the header and from every row', () => {
    const { container, unmount } = mountTable(tableHiding(['story']), handlers())
    expect(headerLabels(container)).not.toContain(schemaLabel('story'))
    expect(container.querySelector('[data-kanban-column="story"]')).toBeNull()
    expect(container.querySelector('[data-item-id="a"] [data-kanban-column="priority"]')).toBeTruthy()
    unmount()
  })

  it('hides the attachments column too', () => {
    const { container, unmount } = mountTable(tableHiding(['files']), handlers())
    expect(headerLabels(container)).not.toContain(t('preview.kanban_files'))
    expect(container.querySelector('[data-kanban-column="files"]')).toBeNull()
    unmount()
  })

  it('keeps the title column whatever a document hides', () => {
    const { container, unmount } = mountTable(tableHiding(['title']), handlers())
    expect(headerLabels(container)[0]).toBe(schemaLabel('title'))
    expect(container.querySelector('[data-item-id="a"] [data-kanban-column="title"]')).toBeTruthy()
    unmount()
  })
})
