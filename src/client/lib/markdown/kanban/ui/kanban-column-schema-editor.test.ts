import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps } from 'react'
import { initI18n, setLocale, t } from '../../../../lib/i18n'
import { renderElement } from '../../../test-render'
import { formatKanbanPropertyName } from '../i18n-helpers'
import { ZH_CN_MESSAGES } from '../../../../../shared/locales/zh-CN'
import { KanbanHeader } from './kanban-header'
import type { KanbanSchemaOperations } from './kanban-column-hooks'
import type { KanbanData, KanbanItem, KanbanProperty } from '../types'

beforeAll(async () => {
  await initI18n()
})

// The panel lists the columns the table draws: the title and the attachments column come from the
// renderer, the other two from the document's own schema.
const tableColumns: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'done', label: 'Done', color: 'green' as const },
      { id: 'todo', label: 'To Do', color: 'gray' as const },
    ],
  },
  { id: 'spec', name: 'Spec file', type: 'text' },
]

const allItems: KanbanItem[] = [
  { id: 'a', title: 'a', properties: { status: 'done' } },
  { id: 'b', title: 'b', properties: { status: 'todo' } },
]

type SchemaOps = KanbanSchemaOperations

function stubSchemaOps(): SchemaOps {
  return {
    addColumn: vi.fn(),
    renameColumn: vi.fn(),
    changeColumnType: vi.fn(),
    deleteColumn: vi.fn(),
    moveColumn: vi.fn(),
    resizeColumn: vi.fn(),
  }
}

function stubViewOps(): ComponentProps<typeof KanbanHeader>['viewOps'] {
  return {
    createView: vi.fn(),
    renameView: vi.fn(),
    duplicateView: vi.fn(),
    deleteView: vi.fn(),
    moveView: vi.fn(),
  }
}

function renderTableHeader(schemaOps: SchemaOps = stubSchemaOps()) {
  const data: KanbanData = {
    columns: tableColumns,
    items: allItems,
    views: [{ id: 'vt', name: 'Table', type: 'table', groupBy: 'status' }],
  }
  const rendered = renderElement(
    createElement(KanbanHeader, {
      data,
      visibleItems: allItems,
      activeView: data.views[0]!,
      searchQuery: '',
      filters: [],
      sorts: [],
      onSelectView: vi.fn(),
      onSearchChange: vi.fn(),
      onChangeFilters: vi.fn(),
      onChangeSorts: vi.fn(),
      onAddItem: vi.fn(),
      onToggleHiddenColumn: vi.fn(),
      schemaOps,
      viewOps: stubViewOps(),
      viewPanelId: 'view-panel',
    }),
  )
  return { ...rendered, ops: schemaOps }
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes(name))
  if (!button) throw new Error(`no button labelled "${name}"`)
  return button
}

function columnName(columnId: string): string {
  const column = tableColumns.find((col) => col.id === columnId)
  if (!column) throw new Error(`no fixture column "${columnId}"`)
  return formatKanbanPropertyName(column)
}

function openColumnsPanel(container: HTMLElement): HTMLElement {
  act(() => { buttonNamed(container, t('preview.kanban_columns')).click() })
  const panel = container.querySelector<HTMLElement>('[role="dialog"]')
  if (!panel) throw new Error('the columns panel did not open')
  return panel
}

function openSchemaPanel(schemaOps?: SchemaOps) {
  const rendered = renderTableHeader(schemaOps)
  return { ...rendered, panel: openColumnsPanel(rendered.container) }
}

// The message with an empty name is the stable prefix of every editor toggle.
const EDITOR_TOGGLE_PREFIX = () => t('preview.kanban_edit_column_named', { name: '' }).trim()

function editToggle(panel: HTMLElement, columnId: string): HTMLButtonElement {
  const label = t('preview.kanban_edit_column_named', { name: columnName(columnId) })
  const toggle = [...panel.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === label)
  if (!toggle) throw new Error(`no editor toggle for column "${columnId}" (${label})`)
  return toggle
}

function openEditor(panel: HTMLElement, columnId: string): HTMLElement {
  const toggle = editToggle(panel, columnId)
  act(() => { toggle.click() })
  const editorId = toggle.getAttribute('aria-controls')
  const editor = editorId ? document.getElementById(editorId) : null
  if (!editor) throw new Error(`no editor for column "${columnId}"`)
  expect(editor.closest('[role="dialog"]'), 'the editor opened outside the panel').toBe(panel)
  return editor
}

function editorButton(scope: HTMLElement, label: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === label)
  if (!button) throw new Error(`no button labelled "${label}"`)
  return button
}

function fieldOf<T extends HTMLElement>(scope: HTMLElement, selector: string, what: string): T {
  const el = scope.querySelector<T>(selector)
  if (!el) throw new Error(`no ${selector} for ${what}`)
  return el
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(node: HTMLElement, key: string) {
  act(() => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

function nameField(editor: HTMLElement): HTMLInputElement {
  return fieldOf<HTMLInputElement>(editor, 'input[type="text"]', `the name of ${columnName('spec')}`)
}

describe('column editors the panel offers', () => {
  it('names the editor after the column it edits and opens only that one', () => {
    const { unmount, panel } = openSchemaPanel()
    try {
      expect(editToggle(panel, 'status').getAttribute('aria-expanded')).toBe('false')
      const specEditor = openEditor(panel, 'spec')
      expect(specEditor.getAttribute('aria-label')).toBe(columnName('spec'))
      expect(editToggle(panel, 'status').getAttribute('aria-expanded')).toBe('false')
      expect(editToggle(panel, 'spec').getAttribute('aria-expanded')).toBe('true')
    } finally {
      unmount()
    }
  })

  it('offers no editor for the columns the table renders either way', () => {
    const { container, unmount } = renderTableHeader()
    try {
      const panel = openColumnsPanel(container)
      expect([...panel.querySelectorAll<HTMLButtonElement>('button')].filter(
        (b) => b.getAttribute('aria-label')?.startsWith(EDITOR_TOGGLE_PREFIX()),
      ).map((b) => b.getAttribute('aria-label'))).toEqual([
        t('preview.kanban_edit_column_named', { name: columnName('status') }),
        t('preview.kanban_edit_column_named', { name: columnName('spec') }),
      ])
    } finally {
      unmount()
    }
  })
})

describe('renaming a column from its editor', () => {
  it('writes the name once on Enter, under the id its values are stored against', () => {
    const { unmount, ops, panel } = openSchemaPanel()
    try {
      const editor = openEditor(panel, 'spec')
      const field = nameField(editor)
      expect(field.value).toBe('Spec file')
      typeInto(field, 'Spec filename')
      expect(ops.renameColumn).not.toHaveBeenCalled()
      press(field, 'Enter')
      expect(ops.renameColumn).toHaveBeenCalledWith('spec', 'Spec filename')
    } finally {
      unmount()
    }
  })

  it('commits a name the reader left by clicking elsewhere', () => {
    const { unmount, ops, panel } = openSchemaPanel()
    try {
      const editor = openEditor(panel, 'spec')
      const field = nameField(editor)
      act(() => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
      expect(ops.renameColumn, 'a blur that changed nothing has nothing to write').not.toHaveBeenCalled()
      typeInto(field, 'Spec sheet')
      act(() => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
      expect(ops.renameColumn).toHaveBeenCalledWith('spec', 'Spec sheet')
    } finally {
      unmount()
    }
  })

  // The name field owns its Escape the way a table cell does: canceling a rename must not be the
  // gesture that closes the whole panel.
  it('discards a draft name on Escape and leaves the panel open', () => {
    const { unmount, ops, panel } = openSchemaPanel()
    try {
      const editor = openEditor(panel, 'spec')
      const field = nameField(editor)
      typeInto(field, 'Never typed')
      press(field, 'Escape')
      expect(field.value).toBe('Spec file')
      expect(ops.renameColumn).not.toHaveBeenCalled()
      expect(panel.isConnected, 'the panel closed with the draft').toBe(true)
    } finally {
      unmount()
    }
  })
})

describe('retyping, moving and deleting from the editor', () => {
  it('changes the type of a column', () => {
    const { unmount, ops, panel } = openSchemaPanel()
    try {
      const choice = fieldOf<HTMLSelectElement>(openEditor(panel, 'spec'), 'select', 'the type picker')
      expect(choice.value).toBe('text')
      act(() => {
        choice.value = 'number'
        choice.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(ops.changeColumnType).toHaveBeenCalledWith('spec', 'number')
    } finally {
      unmount()
    }
  })

  it('moves a column and refuses the direction with nowhere to go', () => {
    const { unmount, ops, panel } = openSchemaPanel()
    try {
      const statusEditor = openEditor(panel, 'status')
      expect(editorButton(statusEditor, t('preview.kanban_move_column_up')).disabled, 'the first column should not move earlier').toBe(true)
      expect(editorButton(statusEditor, t('preview.kanban_move_column_down')).disabled).toBe(false)
      const specEditor = openEditor(panel, 'spec')
      expect(editorButton(specEditor, t('preview.kanban_move_column_down')).disabled, 'spec is the last column').toBe(true)
      act(() => { editorButton(specEditor, t('preview.kanban_move_column_up')).click() })
      expect(ops.moveColumn).toHaveBeenCalledWith('spec', -1)
    } finally {
      unmount()
    }
  })

  it('deletes the column the editor belongs to', () => {
    const { unmount, ops, panel } = openSchemaPanel()
    try {
      const editor = openEditor(panel, 'spec')
      act(() => { editorButton(editor, t('preview.kanban_delete_this_column')).click() })
      expect(ops.deleteColumn).toHaveBeenCalledWith('spec')
    } finally {
      unmount()
    }
  })
})

describe('adding a column from the panel', () => {
  it('adds a column of the chosen type and clears the field for the next one', () => {
    const { unmount, ops, panel } = openSchemaPanel()
    try {
      const addRow = panel.querySelector<HTMLElement>('[data-kanban-column-add]')!
      const field = fieldOf<HTMLInputElement>(addRow, 'input[type="text"]', 'the new column name')
      const choice = fieldOf<HTMLSelectElement>(addRow, 'select', 'the new column type')
      const submit = editorButton(addRow, t('preview.kanban_add_column'))
      expect(submit.disabled, 'nothing typed yet').toBe(true)
      typeInto(field, 'Sprint')
      act(() => {
        choice.value = 'date'
        choice.dispatchEvent(new Event('change', { bubbles: true }))
        submit.click()
      })
      expect(ops.addColumn).toHaveBeenCalledWith('Sprint', 'date')
      expect(field.value).toBe('')
    } finally {
      unmount()
    }
  })
})

// Reading the phrase out of the zh-CN resource is what proves the toggle's name is a message and
// not a string assembled in JSX, which no locale could reach.
describe('the schema panel in another language', () => {
  it('names the editors in Chinese when the app speaks Chinese', async () => {
    await setLocale('zh-CN', false)
    const { container, unmount } = renderTableHeader()
    try {
      const panel = openColumnsPanel(container)
      const label = ZH_CN_MESSAGES['preview.kanban_edit_column_named']!
        .replace('{name}', ZH_CN_MESSAGES['preview.kanban_prop_status']!)
      expect(panel.querySelector(`[aria-label="${label}"]`)).toBeTruthy()
    } finally {
      unmount()
      await setLocale('en-US', false)
    }
  })
})
