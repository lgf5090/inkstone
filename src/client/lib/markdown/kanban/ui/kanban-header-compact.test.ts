/**
 * The top bar is laid out against its **own** width, and the note gives it as little as a few hundred
 * pixels: a panel beside the editor, or a phone. The bar used to decide everything from the window —
 * `hidden md:inline` on every label — so a 1280px monitor with a 400px pane drew the desktop row, which
 * wrapped to three lines above a canvas whose own height is capped at 480px (user report 2026-09-23:
 * the pane's bar was cramped and left blank rows, and icons with tooltips would be a better shape).
 *
 * The fix has two halves, and both are asserted here because either one alone regresses silently.
 * The bar became a `@container`, so every breakpoint inside it reads the bar; and below that
 * breakpoint the actions the bar cannot draw a control for move into one menu — the menu rows open the
 * board's *own* panels, so the compact layout cannot drift away from the wide one.
 *
 * jsdom does not evaluate container queries, so what is asserted is the contract that decides the
 * layout: which class each cluster carries, that each action is written once rather than twice with
 * one hidden, and what the menu does when a row is chosen.
 */
import { act, createElement, type ComponentProps } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { renderElement } from '../../../test-render'
import type { KanbanData, KanbanItem, KanbanProperty } from '../types'
import { KanbanHeader } from './kanban-header'

beforeAll(async () => {
  await initI18n()
})

const statusColumn: KanbanProperty = {
  id: 'status',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'done', label: 'Done', color: 'green' },
    { id: 'todo', label: 'To Do', color: 'gray' },
  ],
}

const items: KanbanItem[] = [
  { id: 'a', title: 'a', properties: { status: 'done', tags: ['tag-a'] } },
  { id: 'b', title: 'b', properties: { status: 'todo' } },
]

const data: KanbanData = {
  columns: [
    statusColumn,
    {
      id: 'tags',
      name: 'Tags',
      type: 'multi-select',
      options: [
        { id: 'tag-a', label: 'Alpha', color: 'green' },
        { id: 'tag-b', label: 'Beta', color: 'blue' },
      ],
    },
  ],
  items,
  views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'status' }],
}

type HeaderOverrides = Omit<Partial<ComponentProps<typeof KanbanHeader>>, 'viewPanelId'>

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function headerProps(extra: HeaderOverrides = {}): ComponentProps<typeof KanbanHeader> {
  return {
    data,
    visibleItems: items,
    activeView: data.views[0]!,
    searchQuery: '',
    filters: [],
    sorts: [],
    onSelectView: vi.fn(),
    onSearchChange: vi.fn(),
    onChangeFilters: vi.fn(),
    onChangeSorts: vi.fn(),
    onAddItem: vi.fn(),
    viewOps: { createView: vi.fn(), renameView: vi.fn(), duplicateView: vi.fn(), deleteView: vi.fn(), moveView: vi.fn() },
    viewPanelId: 'view-panel',
    ...extra,
  }
}

function renderHeader(extra: HeaderOverrides = {}) {
  const rendered = renderElement(createElement(KanbanHeader, headerProps(extra)))
  mounted.push(rendered)
  return rendered
}

/** Every prop the compact bar's menu can act on, so a row is never missing because a writer is. */
const fullBar: HeaderOverrides = {
  cardSize: 'medium',
  onChangeCardSize: vi.fn(),
  onChangeGroupBy: vi.fn(),
  canUndo: true,
  canRedo: true,
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  onToggleFullscreen: vi.fn(),
  archive: { items: [items[1]!], deletedItems: [], onRestore: vi.fn(), onDelete: vi.fn(), onRestoreDeleted: vi.fn(), onPurge: vi.fn() },
  csv: { title: 'Board', columns: data.columns, items, itemCount: items.length, commitData: vi.fn() },
}

function byName(container: HTMLElement, label: string): HTMLElement | null {
  return [...container.querySelectorAll<HTMLElement>('button')]
    .find((button) => (button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '') === label) ?? null
}

function classesOf(node: Element | null): string {
  return node?.className ?? ''
}

/**
 * The two clusters that share one action row, found by the controls they draw rather than by their
 * class: the row also holds a progress bar that carries the same breakpoint classes, so matching on
 * those alone would let a wide cluster that lost its own breakpoint pass unnoticed (measured — the
 * first version of this helper did exactly that, and the mutation stayed green).
 */
function clusterOf(row: Element, node: Element | null): Element | null {
  for (let parent = node?.parentElement; parent && parent !== row; parent = parent.parentElement) {
    if (parent.parentElement === row) return parent
  }
  return null
}

function clusters(container: HTMLElement): { wide: Element | null; compact: Element | null } {
  const row = container.querySelector('[data-kanban-actions]')
  if (!row) return { wide: null, compact: null }
  return {
    wide: clusterOf(row, byName(container, t('preview.kanban_filter'))),
    compact: clusterOf(row, container.querySelector('[data-kanban-overflow]')),
  }
}

function menuRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')]
}

function rowNamed(label: string): HTMLElement {
  const row = menuRows().find((item) => item.textContent?.includes(label))
  expect(row, `the menu offers no "${label}" row`).toBeDefined()
  return row!
}

function openOverflow(container: HTMLElement): HTMLElement {
  const trigger = container.querySelector<HTMLElement>('[data-kanban-overflow]')
  expect(trigger, 'the bar draws no overflow trigger').not.toBeNull()
  act(() => { trigger!.click() })
  return trigger!
}

function panelNamed(container: HTMLElement, label: string): HTMLElement | null {
  return [...container.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((panel) => panel.getAttribute('aria-label') === label) ?? null
}

function tagStrip(container: HTMLElement): HTMLElement | null {
  const chip = container.querySelector('[data-kanban-tags-chip]')
  const id = chip?.getAttribute('aria-controls')
  return id ? container.querySelector<HTMLElement>(`#${CSS.escape(id)}`) : null
}

/** Every row the compact menu offers, with all writers wired so no row is disabled away. */
function menuTexts(extra: HeaderOverrides = {}): string[] {
  const rendered = renderHeader({ ...fullBar, ...extra })
  openOverflow(rendered.container)
  return menuRows().map((row) => row.textContent ?? '')
}

function missingRows(labels: string[], extra: HeaderOverrides = {}): string[] {
  const rows = menuTexts(extra)
  return labels.filter((label) => !rows.some((row) => row.includes(label)))
}

/**
 * Opens the menu and a row of it, and hands back the panel that row was supposed to open. The row and
 * the panel are named differently on purpose — the row says what it is for, the panel names itself
 * after what it holds — so the two are passed separately rather than assumed to match.
 */
function panelFromRow(rowLabel: string, panelLabel: string, extra: HeaderOverrides = {}) {
  const rendered = renderHeader({ ...fullBar, ...extra })
  const trigger = openOverflow(rendered.container)
  act(() => { rowNamed(rowLabel).click() })
  return { rendered, trigger, panel: panelNamed(rendered.container, panelLabel) }
}

describe('the top bar is its own container', () => {
  it('measures the controls against the bar rather than the window', () => {
    const rendered = renderHeader(fullBar)
    const header = rendered.container.querySelector('[data-kanban-header]')
    expect(classesOf(header), 'the bar is not a container, so md:/sm: inside it read the window').toContain('@container')
    // A viewport breakpoint anywhere in the bar is what made a wide window decide a note pane's
    // layout, and the labels are where it showed.
    const viewportNarrowed = [...(header?.querySelectorAll('*') ?? [])]
      .filter((node) => /(^|\s)hidden md:/.test(classesOf(node)))
    expect(viewportNarrowed.map((node) => node.className), 'a control still hides its words by window width').toEqual([])
  })

  it('turns the wide cluster and the compact one on the same breakpoint', () => {
    const { wide, compact } = clusters(renderHeader(fullBar).container)
    expect(classesOf(wide), 'the wide cluster is shown at every width').toContain('hidden @4xl:flex')
    expect(classesOf(compact), 'the compact cluster is shown at every width').toContain('@4xl:hidden')
  })

  it('keeps the pointer-sized toolbar behind the same breakpoint, since the menu carries its actions', () => {
    const rendered = renderHeader(fullBar)
    const undo = byName(rendered.container, t('common.undo'))
    expect(undo, 'the bar draws no undo control at all').not.toBeNull()
    const toolbar = [...rendered.container.querySelectorAll('*')]
      .find((node) => node.contains(undo!) && classesOf(node).includes('@4xl:flex')) ?? null
    expect(classesOf(toolbar), 'the toolbar draws four more controls into a narrow bar').toContain('hidden @4xl:flex')
  })
})

describe('an action is written once, not once per layout', () => {
  it('draws one trigger per panel rather than a hidden copy beside the compact one', () => {
    const container = renderHeader(fullBar).container
    expect(container.querySelectorAll('[data-kanban-csv]').length, 'the CSV door is drawn twice').toBe(1)
    expect(container.querySelectorAll('[data-kanban-archive]').length, 'the shelf is drawn twice').toBe(1)
    for (const label of [t('preview.kanban_filter'), t('preview.kanban_sort'), t('preview.kanban_group_by')]) {
      const drawn = [...container.querySelectorAll('button')].filter((button) => button.getAttribute('aria-label') === label)
      expect(drawn.length, `${label} is drawn ${drawn.length} times`).toBe(1)
    }
    expect(container.querySelectorAll('[data-kanban-overflow]').length, 'the bar has no single way into the rest').toBe(1)
  })
})

describe('the compact menu reaches what the bar cannot draw', () => {
  it('offers every action the wide row draws as a labeled control', () => {
    expect(missingRows([
      t('preview.kanban_filter'),
      t('preview.kanban_sort'),
      t('preview.kanban_group_by'),
      t('preview.kanban_csv'),
      t('preview.kanban_archived_count', { count: 1 }),
    ])).toEqual([])
  })

  it('offers the controls the narrow bar drops, so nothing becomes unreachable', () => {
    expect(missingRows([
      t('preview.kanban_new_item'),
      t('common.undo'),
      t('command.redo'),
      t('preview.kanban_fullscreen'),
      // The keyboard reference is wide-bar furniture too, and a reader on a narrow bar is exactly the
      // reader who cannot afford to guess at the keys.
      t('preview.kanban_shortcuts'),
    ])).toEqual([])
  })

  it('offers the view management the strip keeps beside its tabs', () => {
    expect(missingRows([t('preview.kanban_new_view'), t('preview.kanban_view_actions')])).toEqual([])
  })

  it('names the escape hatch after what it holds', () => {
    const rendered = renderHeader(fullBar)
    const trigger = rendered.container.querySelector('[data-kanban-overflow]')
    expect(trigger?.getAttribute('aria-label')).toBe(t('preview.kanban_more_actions'))
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu')
  })
})

describe('a row of the compact menu opens the board’s own panel', () => {
  it('opens the board’s own panel from the row, closing the menu behind it', () => {
    const { trigger, panel } = panelFromRow(t('preview.kanban_filter'), t('preview.kanban_filter_rules'), { onChangeFilters: vi.fn() })
    expect(panel, 'the row opened no filter panel').not.toBeNull()
    expect(menuRows().length, 'the menu stayed open behind its own panel').toBe(0)
    expect(trigger.getAttribute('aria-expanded'), 'the trigger still claims its menu is open').toBe('false')
  })

  it('sets a rule from the panel a menu row opened, not just drawing it', () => {
    const onChangeFilters = vi.fn()
    const { panel } = panelFromRow(t('preview.kanban_filter'), t('preview.kanban_filter_rules'), { onChangeFilters })
    const add = [...panel!.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(t('preview.kanban_add_condition')))
    expect(add, 'the panel a menu row opened cannot be used').not.toBeNull()
    act(() => { add!.click() })
    expect(onChangeFilters, 'the panel a menu row opened writes nothing').toHaveBeenCalled()
  })

  it('opens the keyboard reference the wide bar keeps beside the toolbar', () => {
    const { panel } = panelFromRow(t('preview.kanban_shortcuts'), t('preview.kanban_shortcuts'))
    expect(panel, 'the row opened no keyboard reference').not.toBeNull()
    expect(panel!.textContent).toContain(t('preview.kanban_key_next_card'))
  })

  it('opens the view options panel the wide bar labels the same way', () => {
    const { panel } = panelFromRow(t('preview.kanban_group_by'), t('preview.kanban_group_by'))
    expect(panel, 'the row opened no group-by panel').not.toBeNull()
  })
})

describe('the tag strip folds away on a narrow bar', () => {
  function renderWithTags(selectedTags: string[] = []) {
    const onToggleTag = vi.fn()
    return { container: renderHeader({ onToggleTag, selectedTags }).container, onToggleTag }
  }

  it('reports how many tags are in force while its strip is folded away', () => {
    const { container } = renderWithTags(['tag-a'])
    const chip = container.querySelector('[data-kanban-tags-chip]')
    expect(chip, 'the bar has no chip to fold onto').not.toBeNull()
    expect(chip!.textContent, 'the chip does not say what is folded away').toContain(
      t('preview.kanban_tags_chip', { selected: 1, total: 2 }),
    )
    expect(chip!.getAttribute('aria-expanded')).toBe('false')
  })

  it('is folded by default and unfolds on the chip, so the strip costs a narrow bar nothing', () => {
    const { container } = renderWithTags()
    const chip = container.querySelector<HTMLElement>('[data-kanban-tags-chip]')!
    const strip = tagStrip(container)
    expect(strip, 'the chip points at no strip').not.toBeNull()
    expect(strip!.className, 'the strip is drawn on a narrow bar whether or not it was asked for').toContain('hidden')
    expect(strip!.className, 'the strip no longer comes back on a wide bar').toContain('@4xl:flex')
    act(() => { chip.click() })
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect(tagStrip(container)!.className, 'the chip does not unfold its strip').not.toContain('hidden')
  })

  it('still filters from the chip’s own chips once they are unfolded', () => {
    const { container, onToggleTag } = renderWithTags()
    act(() => { container.querySelector<HTMLElement>('[data-kanban-tags-chip]')!.click() })
    const alpha = [...tagStrip(container)!.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Alpha'))
    expect(alpha, 'the unfolded strip holds no tag chips').toBeDefined()
    act(() => { alpha!.click() })
    expect(onToggleTag).toHaveBeenCalledWith('tag-a')
  })
})
