import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

const statusColumn = {
  id: 'status',
  name: 'Status',
  type: 'select' as const,
  options: [
    { id: 'done', label: 'Done', color: 'green' as const },
    { id: 'todo', label: 'To Do', color: 'gray' as const },
  ],
}

function item(id: string, status: string): KanbanItem {
  return { id, title: id, properties: { status } }
}

const allItems = [item('a', 'done'), item('b', 'todo')]

const data: KanbanData = {
  columns: [statusColumn],
  items: allItems,
  views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'status' }],
}

type HeaderOverrides = Omit<Partial<ComponentProps<typeof KanbanHeader>>, 'viewPanelId'>

/** The switcher's own contract is covered in kanban-view-tabs.test.ts; here it only has to exist. */
function stubViewOps(): ComponentProps<typeof KanbanHeader>['viewOps'] {
  return {
    createView: vi.fn(),
    renameView: vi.fn(),
    duplicateView: vi.fn(),
    deleteView: vi.fn(),
    moveView: vi.fn(),
  }
}

/** The schema writers only have to reach the panel here; ./kanban-column-schema-editor.test.ts asserts what it does with them. */
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

function headerProps(visibleItems: KanbanItem[], extra: HeaderOverrides = {}): ComponentProps<typeof KanbanHeader> {
  return {
    data,
    visibleItems,
    activeView: data.views[0]!,
    searchQuery: '',
    filters: [],
    sorts: [],
    onSelectView: vi.fn(),
    onSearchChange: vi.fn(),
    onChangeFilters: vi.fn(),
    onChangeSorts: vi.fn(),
    onAddItem: vi.fn(),
    viewOps: stubViewOps(),
    viewPanelId: 'view-panel',
    ...extra,
  }
}

function renderHeader(visibleItems: KanbanItem[], extra: HeaderOverrides = {}) {
  return renderElement(createElement(KanbanHeader, headerProps(visibleItems, extra)))
}

describe('KanbanHeader progress bar scope', () => {
  it('segments reflect the visible (filtered) items, not the whole board', () => {
    const rendered = renderHeader([allItems[0]!])
    try {
      expect(document.querySelector('[title="Done: 1 (100%)"]')).toBeTruthy()
      expect(document.querySelector('[title="To Do: 1 (50%)"]')).toBeNull()
    } finally {
      rendered.unmount()
    }
  })

  it('shows every status when nothing is filtered out', () => {
    const rendered = renderHeader(allItems)
    try {
      expect(document.querySelector('[title="Done: 1 (50%)"]')).toBeTruthy()
      expect(document.querySelector('[title="To Do: 1 (50%)"]')).toBeTruthy()
    } finally {
      rendered.unmount()
    }
  })
})

/**
 * A finger needs a target the project's own scale defines — 36px below `md`, 28px above it — and the
 * labels that make this row readable on a desktop are what makes it overflow on a phone. So each
 * control is measured against that scale, and the labels are dropped on the narrow screen while the
 * accessible name stays: an icon-only button still has to say what it does. The height arrives
 * either as the scale step or as the button-size role token, since both name the same 36/28px pair.
 */
const MOBILE_TARGET = /\bsize-9\b|\bh-9\b|\bmin-h-9\b|h-\[var\(--btn-h-sm\)\]/
const DESKTOP_TARGET = /\bmd:size-7\b|\bmd:h-7\b|md:h-\[var\(--btn-h-sm-compact\)\]/

/**
 * How a control gives up its words when the bar is narrow. The breakpoint is the header's own
 * container (`@4xl` is 56rem), not the window: a note pane beside the editor is a few hundred pixels
 * wide whatever the monitor is, which is why reading the viewport here put three lines of chrome
 * above the canvas (user report 2026-09-23).
 */
const NARROW_LABEL = 'hidden @4xl:inline'

function headerControls(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[data-kanban-header] button')]
}

function controlNamed(container: HTMLElement, label: string): HTMLButtonElement {
  const control = headerControls(container).find((button) => button.getAttribute('aria-label') === label)
  expect(control, `the header has no control named ${label}`).not.toBeNull()
  return control!
}

/**
 * Whether a control is down to its icon on a narrow bar: either it writes nothing at all, or the only
 * text it holds is the label it hides at that breakpoint. Both shapes have to carry the name.
 */
function hasNoWrittenLabel(button: HTMLButtonElement): boolean {
  const written = button.textContent?.trim() ?? ''
  if (written === '') return true
  return [...button.querySelectorAll('span')].some(
    (span) => span.className.includes(NARROW_LABEL) && span.textContent?.trim() === written,
  )
}

function actionsRow(container: HTMLElement): HTMLElement {
  const row = container.querySelector<HTMLElement>('[data-kanban-actions]')
  expect(row, 'the header has no action row to measure').not.toBeNull()
  return row!
}

const rowProps: HeaderOverrides = {
  onUndo: vi.fn(),
  canUndo: true,
  onRedo: vi.fn(),
  canRedo: true,
  onToggleFullscreen: vi.fn(),
  onChangeGroupBy: vi.fn(),
  onChangeCardSize: vi.fn(),
  cardSize: 'medium',
  archive: { items: [item('z', 'done')], deletedItems: [], onRestore: vi.fn(), onDelete: vi.fn(), onRestoreDeleted: vi.fn(), onPurge: vi.fn() },
  csv: { title: 'Gate Board', columns: data.columns, items: data.items, itemCount: data.items.length, commitData: vi.fn() },
}

describe('the sizes a finger needs in the header', () => {
  it('gives every icon-only control in the action row a phone-sized target', () => {
    const rendered = renderHeader(allItems, { ...rowProps, searchQuery: 'gate', unsaved: true, onRetryWrite: vi.fn() })
    try {
      const iconOnly = headerControls(actionsRow(rendered.container)).filter(hasNoWrittenLabel)
      expect(iconOnly.length, 'no icon-only control was found to measure').toBeGreaterThanOrEqual(5)
      for (const control of iconOnly) {
        const name = control.getAttribute('aria-label') ?? '(unnamed)'
        expect(control.className, `${name} is below the touch target for a phone`).toMatch(MOBILE_TARGET)
        expect(control.getAttribute('aria-label'), `${name} hides its words without a name`).toBeTruthy()
      }
    } finally {
      rendered.unmount()
    }
  })

  it('keeps the row on the project scale, 36px on a phone and 28px on a desktop', () => {
    const rendered = renderHeader(allItems, rowProps)
    try {
      for (const label of [
        t('preview.kanban_search'),
        t('preview.kanban_filter'),
        t('preview.kanban_sort'),
        t('preview.kanban_group_by'),
        t('common.undo'),
        t('command.redo'),
        t('preview.kanban_fullscreen'),
      ]) {
        const control = controlNamed(rendered.container, label)
        expect(control.className, `${label} is below the touch target for a phone`).toMatch(MOBILE_TARGET)
        expect(control.className, `${label} grew on a desktop`).toMatch(DESKTOP_TARGET)
      }
    } finally {
      rendered.unmount()
    }
  })

})

describe('the words the header keeps on a narrow bar', () => {
  it('drops the label when its own bar is narrow, keeping the name the control answers to', () => {
    const rendered = renderHeader(allItems, rowProps)
    try {
      for (const label of [
        t('preview.kanban_filter'),
        t('preview.kanban_sort'),
        t('preview.kanban_group_by'),
        t('preview.kanban_new_item'),
      ]) {
        const control = controlNamed(rendered.container, label)
        const written = [...control.querySelectorAll('span')].find(
          (span) => span.textContent === label && span.querySelectorAll('span').length === 0,
        )
        expect(written, `${label} writes its name nowhere`).toBeDefined()
        expect(written!.className, `${label} keeps its label on a narrow bar`).toContain(NARROW_LABEL)
      }
    } finally {
      rendered.unmount()
    }
  })

  it('wraps the row instead of clipping the panels that hang off it', () => {
    const rendered = renderHeader(allItems, rowProps)
    try {
      const row = actionsRow(rendered.container)
      expect(row.className, 'the row does not wrap, so a phone overflows it').toContain('flex-wrap')
      act(() => { controlNamed(rendered.container, t('preview.kanban_filter')).click() })
      const panel = rendered.container.querySelector<HTMLElement>('[role="dialog"]')
      expect(panel, 'the filter control opened no panel').not.toBeNull()
      for (let node = panel!.parentElement; node; node = node.parentElement) {
        expect(node.className, `an ancestor scrolls or clips the panel: ${node.className}`).not.toMatch(
          /overflow-(x-)?(auto|hidden|scroll)/,
        )
        if (node.hasAttribute('data-kanban-header')) break
      }
    } finally {
      rendered.unmount()
    }
  })
})

const tableColumns: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  statusColumn,
  { id: 'spec', name: 'Spec file', type: 'text' },
]

function renderTableHeader(
  hiddenColumns: string[],
  onToggleHiddenColumn = vi.fn(),
  schemaOps: SchemaOps = stubSchemaOps(),
) {
  const tableData: KanbanData = {
    columns: tableColumns,
    items: allItems,
    views: [{ id: 'vt', name: 'Table', type: 'table', groupBy: 'status', hiddenColumns }],
  }
  const rendered = renderElement(
    createElement(KanbanHeader, {
      data: tableData,
      visibleItems: allItems,
      activeView: tableData.views[0]!,
      searchQuery: '',
      filters: [],
      sorts: [],
      onSelectView: vi.fn(),
      onSearchChange: vi.fn(),
      onChangeFilters: vi.fn(),
      onChangeSorts: vi.fn(),
      onAddItem: vi.fn(),
      onToggleHiddenColumn,
      schemaOps,
      viewOps: stubViewOps(),
      viewPanelId: 'view-panel',
    }),
  )
  return { ...rendered, onToggleHiddenColumn, schemaOps }
}

function columnToggle(container: HTMLElement, columnName: string): HTMLInputElement | null {
  const label = [...container.querySelectorAll('label')].find((el) => el.textContent?.includes(columnName))
  return label?.querySelector('input[type="checkbox"]') ?? null
}

function columnName(columnId: string): string {
  const column = tableColumns.find((col) => col.id === columnId)
  if (!column) throw new Error(`no fixture column "${columnId}"`)
  return formatKanbanPropertyName(column)
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes(name))
  if (!button) throw new Error(`no button labelled "${name}"`)
  return button
}

describe('KanbanHeader column visibility', () => {
  it('lists the table columns and reports the one being toggled', () => {
    const { container, unmount, onToggleHiddenColumn } = renderTableHeader(['spec'])
    try {
      act(() => { buttonNamed(container, t('preview.kanban_columns')).click() })
      const panel = container.querySelector<HTMLElement>('[role="dialog"]')!
      expect(columnToggle(panel, columnName('title'))).toBeNull()
      expect(columnToggle(panel, columnName('spec'))?.checked).toBe(false)
      act(() => { columnToggle(panel, columnName('status'))!.click() })
      expect(onToggleHiddenColumn).toHaveBeenCalledWith('status')
    } finally {
      unmount()
    }
  })

  it('keeps the board view options free of the column toggles the table gets', () => {
    const rendered = renderHeader(allItems, {
      cardSize: 'medium',
      onChangeCardSize: vi.fn(),
      onChangeGroupBy: vi.fn(),
      onToggleHiddenColumn: vi.fn(),
    })
    try {
      act(() => { buttonNamed(rendered.container, t('preview.kanban_group_by')).click() })
      const panel = rendered.container.querySelector<HTMLElement>('[role="dialog"]')!
      // The board panel does hold checkboxes of its own — the fields its cards print — so what is
      // asserted is the section being absent by name, not the control being absent by tag.
      expect(panel.querySelector('select')).toBeTruthy()
      expect(panel.textContent).not.toContain(t('preview.kanban_columns'))
    } finally {
      rendered.unmount()
    }
  })
})

const historyProps = { canUndo: true, canRedo: true, onUndo: vi.fn(), onRedo: vi.fn() }

function titlesOf(container: HTMLElement) {
  const undo = container.querySelector<HTMLElement>(`[aria-label="${t('common.undo')}"]`)
  const redo = container.querySelector<HTMLElement>(`[aria-label="${t('command.redo')}"]`)
  expect(undo?.getAttribute('title'), 'the undo button has no hint').toBeTruthy()
  expect(redo?.getAttribute('title'), 'the redo button has no hint').toBeTruthy()
  return { undo: undo!.getAttribute('title'), redo: redo!.getAttribute('title') }
}

// A hint assembled in JSX outlives a locale switch only in its parentheses; reading the expected
// text from the zh-CN resource is what proves the whole message, wrapper included, is translated.
function zhHint(key: 'preview.kanban_undo_shortcut' | 'preview.kanban_redo_shortcut', shortcut: string) {
  return ZH_CN_MESSAGES[key].replace('{shortcut}', shortcut)
}

// `IS_MAC` is frozen when the hotkeys module is first read, so the macOS branch needs a fresh
// module graph with the platform already stubbed — the same resetModules move the store tests use.
async function hintTitlesOnPlatform(platform: string) {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'platform')
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
  vi.resetModules()
  try {
    const { initI18n: initLocale } = await import('../../../../lib/i18n')
    await initLocale()
    const { renderElement: mountHeader } = await import('../../../test-render')
    const { KanbanHeader: PlatformHeader } = await import('./kanban-header')
    const rendered = mountHeader(createElement(PlatformHeader, headerProps(allItems, historyProps)))
    try {
      return titlesOf(rendered.container)
    } finally {
      rendered.unmount()
    }
  } finally {
    if (previous)
      Object.defineProperty(navigator, 'platform', previous)
    else
      Reflect.deleteProperty(navigator, 'platform')
    vi.resetModules()
  }
}

describe('KanbanHeader history shortcut hints', () => {
  afterEach(async () => {
    await setLocale('en-US', false)
  })

  it('promises the chord that actually redoes on every platform', () => {
    const rendered = renderHeader(allItems, historyProps)
    try {
      expect(titlesOf(rendered.container)).toEqual({ undo: 'Undo (Ctrl+Z)', redo: 'Redo (Ctrl+Shift+Z)' })
    } finally {
      rendered.unmount()
    }
  })

  it('renders the command glyph instead of Ctrl on macOS', async () => {
    expect(await hintTitlesOnPlatform('MacIntel')).toEqual({ undo: 'Undo (⌘+Z)', redo: 'Redo (⌘+⇧+Z)' })
  })

  it('keeps the whole hint in one message so zh-CN translates it', async () => {
    await setLocale('zh-CN', false)
    const rendered = renderHeader(allItems, historyProps)
    try {
      expect(titlesOf(rendered.container)).toEqual({
        undo: zhHint('preview.kanban_undo_shortcut', 'Ctrl+Z'),
        redo: zhHint('preview.kanban_redo_shortcut', 'Ctrl+Shift+Z'),
      })
    } finally {
      rendered.unmount()
    }
  })
})

// The tag filter bar sits in the second row of the header, and an unselected chip used to be drawn at
// reduced opacity. The axe pass over the real overlay measured that: the tag colour pair is calibrated
// to AA at full strength (see the `--kanban-tag-*` tokens), so dimming it to 70% put the label at
// 2.9:1. "Not selected" has to be said by the ring the selected chip adds, not by the text's own
// contrast.
describe('KanbanHeader tag filter chips', () => {
  const tagData: KanbanData = {
    columns: [
      statusColumn,
      {
        id: 'tags',
        name: 'Tags',
        type: 'multi-select',
        options: [
          { id: 'tag-a', label: 'Alpha', color: 'green' as const },
          { id: 'tag-b', label: 'Beta', color: 'blue' as const },
        ],
      },
    ],
    items: [{ id: 'a', title: 'a', properties: { status: 'done', tags: ['tag-a'] } }],
    views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'status' }],
  }

  function chip(container: HTMLElement, label: string): HTMLElement {
    const button = [...container.querySelectorAll<HTMLElement>('button')].find((el) => el.textContent.includes(label))
    if (!button) throw new Error(`the filter bar shows no "${label}" chip to measure`)
    return button
  }

  it('states an unselected chip without dimming its text', () => {
    const rendered = renderHeader(allItems, {
      data: tagData,
      activeView: tagData.views[0]!,
      onToggleTag: vi.fn(),
    })
    try {
      for (const label of ['Alpha', 'Beta']) {
        const unselected = chip(rendered.container, label)
        expect(unselected.className, `${label} dims its own label`).not.toMatch(/opacity-\d/)
        const count = unselected.querySelector('span:nth-child(2)')
        expect(count?.className ?? '', `${label} dims its own count`).not.toMatch(/opacity-\d/)
      }
    } finally {
      rendered.unmount()
    }
  })
})
