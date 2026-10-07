/**
 * `t()` reads the live locale, so a label only has to be *rendered* again to change language — but
 * `memo` stops exactly that render, and a stopped render takes its whole subtree with it. Nothing in
 * the app tree re-renders a mounted board, and a component mounted on its own has no parent to
 * re-render it either, so the only thing that keeps a memoized surface in the reader's language is
 * that surface subscribing to the locale itself.
 *
 * This mounts each memoized board surface once, with props that never change (the way a stabilized
 * callback would leave them), switches the language underneath it, and requires every message the
 * surface had printed to come back in the new one — collected from the rendered text and the naming
 * attributes rather than from a hand-tallied list of labels, so a surface that grows a new label
 * later is covered without this file being touched.
 */
import { act, createElement, type ReactElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EN_US_MESSAGES } from '../../../../../shared/locales/en-US'
import { ZH_CN_MESSAGES } from '../../../../../shared/locales/zh-CN'
import { initI18n, setLocale } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import type { KanbanData, KanbanView, KanbanViewType } from '../types'
import { KanbanBatchBar } from './kanban-batch-bar'
import { KanbanColumnMenu } from './kanban-column-menu'
import { KanbanEmptyBoard } from './kanban-empty-board'
import { KanbanFilterPopover } from './kanban-filter-popover'
import { KanbanGalleryView } from './kanban-gallery-view'
import { KanbanListView } from './kanban-list-view'
import { KanbanRoot } from './kanban-root'
import { KanbanSortPopover } from './kanban-sort-popover'
import { KanbanTableView } from './kanban-table-view'
import { KanbanViewOptions } from './kanban-view-options'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(async () => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  await act(async () => {
    await setLocale('en-US', false)
  })
  document.body.replaceChildren()
})

const noop = () => {}
const anchorRef = { current: null as HTMLElement | null }

/**
 * Authored board content deliberately avoids any string a message also produces: a group named after
 * a label would read as a stale translation that never was one.
 */
const columns: KanbanData['columns'] = [
  { id: 'title', name: 'Zeta', type: 'title' },
  {
    id: 'status',
    name: 'Iota',
    type: 'select',
    options: [
      { id: 'p1', label: 'Kappa', color: 'blue' },
      { id: 'p2', label: 'Lambda', color: 'green' },
    ],
  },
  { id: 'tags', name: 'Mu', type: 'multi-select', options: [{ id: 'm1', label: 'Nu', color: 'slate' }] },
  { id: 'done', name: 'Xi', type: 'checkbox' },
  { id: 'startDate', name: 'Omicron', type: 'date' },
  { id: 'endDate', name: 'Pi', type: 'date' },
  { id: 'progress', name: 'Rho', type: 'number' },
] as KanbanData['columns']

const items: KanbanData['items'] = [
  {
    id: 'a',
    title: 'Upsilon',
    content: 'Phi',
    files: [{ id: 'f1', name: 'chi.md', url: '/api/kanban/file/a/chi.md', size: 9, mime: 'text/markdown' }],
    subtasks: [{ id: 's1', title: 'Psi', completed: false }],
    properties: {
      status: 'p1',
      tags: ['m1'],
      done: true,
      startDate: '2026-09-01',
      endDate: '2026-09-12',
      progress: 40,
    },
  },
]

const VIEWS: { id: string, type: KanbanViewType }[] = [
  { id: 'v-board', type: 'board' },
  { id: 'v-table', type: 'table' },
  { id: 'v-list', type: 'list' },
  { id: 'v-gallery', type: 'gallery' },
  { id: 'v-calendar', type: 'calendar' },
  { id: 'v-timeline', type: 'timeline' },
  { id: 'v-gantt', type: 'gantt' },
  { id: 'v-chart', type: 'chart' },
]

const views: KanbanView[] = VIEWS.map((view) => ({
  id: view.id,
  name: `View ${view.type}`,
  type: view.type,
  groupBy: 'status',
  startField: 'startDate',
  endField: 'endDate',
}))

const data: KanbanData = { columns, items, views, activeViewId: 'v-board' }

const dataProps = { data, view: views[1]!, selectedIds: new Set(['a']) }
const controlProps = { onToggleSelect: noop, onOpenDetail: noop, onAddItem: noop }

const SUBJECTS: { name: string, element: ReactElement }[] = [
  {
    name: 'KanbanBatchBar',
    element: createElement(KanbanBatchBar, {
      selectedCount: 2,
      groupColumn: columns[1],
      onBatchGroupChange: noop,
      onBatchArchive: noop,
      onBatchDelete: noop,
      onClearSelection: noop,
    }),
  },
  {
    name: 'KanbanColumnMenu',
    element: createElement(KanbanColumnMenu, {
      open: true,
      panelId: 'column-menu-panel',
      onClose: noop,
      anchorRef,
      groupKey: 'p1',
      label: 'Kappa',
      color: 'blue',
      onRename: noop,
      onChangeColor: noop,
      onChangeWipLimit: noop,
      onCollapse: noop,
      onDelete: noop,
    }),
  },
  {
    name: 'KanbanEmptyBoard',
    element: createElement(KanbanEmptyBoard, { onAddItem: noop, onApplyTemplate: noop }),
  },
  {
    name: 'KanbanFilterPopover',
    element: createElement(KanbanFilterPopover, {
      open: true,
      panelId: 'filter-panel',
      onClose: noop,
      anchorRef,
      columns,
      // One rule per kind of column, so the operator lists a reader can pick from are all painted
      // before the language changes underneath them.
      filters: [
        { propertyId: 'status', operator: 'equals', value: 'Kappa' },
        { propertyId: 'progress', operator: 'greater_than', value: '40' },
        { propertyId: 'startDate', operator: 'is_overdue' },
      ],
      onChangeFilters: noop,
    }),
  },
  {
    name: 'KanbanSortPopover',
    element: createElement(KanbanSortPopover, {
      open: true,
      panelId: 'sort-panel',
      onClose: noop,
      anchorRef,
      columns,
      sorts: [{ propertyId: 'status', direction: 'asc' }],
      onChangeSorts: noop,
    }),
  },
  {
    name: 'KanbanViewOptions',
    element: createElement(KanbanViewOptions, {
      open: true,
      panelId: 'view-options-panel',
      onClose: noop,
      anchorRef,
      columns,
      groupBy: 'status',
      cardSize: 'small',
      hiddenColumns: [],
      onChangeGroupBy: noop,
      onChangeCardSize: noop,
      onToggleHiddenColumn: noop,
    }),
  },
  {
    name: 'KanbanTableView',
    element: createElement(KanbanTableView, {
      ...dataProps,
      ...controlProps,
      onToggleAll: noop,
      onUpdateProperty: noop,
      onUpdateMultiSelect: noop,
      onUpdateFiles: noop,
      onAddColumn: noop,
      people: {},
      onSortColumn: noop,
    }),
  },
  { name: 'KanbanListView', element: createElement(KanbanListView, { ...dataProps, ...controlProps }) },
  { name: 'KanbanGalleryView', element: createElement(KanbanGalleryView, { ...dataProps, ...controlProps }) },
]

// ---------------------------------------------------------------------------
// Which of the rendered strings came from a message
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The kanban and shared messages whose two locales differ, with `{param}` slots turned into captures. */
const TRANSLATED = Object.entries(EN_US_MESSAGES)
  .filter(([key, en]) => {
    const zh = (ZH_CN_MESSAGES as Record<string, string | undefined>)[key]
    return typeof zh === 'string' && zh !== en && (key.startsWith('preview.kanban') || key.startsWith('common.'))
  })
  .map(([key, en]) => ({
    key,
    en,
    zh: (ZH_CN_MESSAGES as Record<string, string>)[key]!,
    // The names the English template asks its values by, in the order its captures arrive.
    params: [...en.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]!),
    pattern: new RegExp(`^${en.split(/\{[A-Za-z0-9_]+\}/).map(escapeRegExp).join('([\\s\\S]+?)')}$`),
  }))

/**
 * The same rendering with the captured slot values put into another locale's template.
 *
 * Matched by name rather than by position: a language is free to ask the values of a sentence in
 * another order than English does, and filling by position would predict a reading no locale draws.
 */
function renderIn(template: string, captured: string[], params: string[]): string {
  return template.replace(
    /\{([A-Za-z0-9_]+)\}/g,
    (_match, name: string) => captured[params.indexOf(name)] ?? '',
  )
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Every text node and naming attribute in `root`, collapsed the way a reader hears it. */
function renderedStrings(root: ParentNode): string[] {
  const out: string[] = []
  const walker = document.createTreeWalker(root, 4)
  let node: Node | null = walker.nextNode()
  while (node) {
    const text = collapse(node.textContent ?? '')
    if (text) out.push(text)
    node = walker.nextNode()
  }
  for (const el of [...root.querySelectorAll<HTMLElement>('[title],[aria-label],[placeholder],[alt]')]) {
    for (const attr of ['title', 'aria-label', 'placeholder', 'alt']) {
      const value = collapse(el.getAttribute(attr) ?? '')
      if (value) out.push(value)
    }
  }
  return out
}

/** English resource text, collapsed, so a slot that carries a label of its own can be recognised. */
const EN_RESOURCE_TEXT = [...new Set(Object.values(EN_US_MESSAGES).map(collapse))].filter((value) => value.length > 1)
const LABEL_WORD = new RegExp(`(^|[^A-Za-z0-9])(${EN_RESOURCE_TEXT.filter((v) => !v.includes(' ')).map(escapeRegExp).join('|')})([^A-Za-z0-9]|$)`)
const LABEL_PHRASES = EN_RESOURCE_TEXT.filter((value) => value.includes(' '))

/**
 * Whether a slot holds text a component itself translated.
 *
 * Such a string has no predictable new-language reading: `Sort by {column}` regenerates the column name
 * in the same repaint, and the chart's aria label appends `{label}: {count}` pairs after the sentence.
 * The old-language half of the check still applies to them — see `messagesIn`.
 */
function slotCarriesLabel(slot: string): boolean {
  return LABEL_WORD.test(slot) || LABEL_PHRASES.some((phrase) => slot.includes(phrase))
}

/** One rendered string, the message keys it can be, and the readings it has to offer in zh. */
interface Seen {
  en: string
  keys: string[]
  zh: string[]
}

/**
 * The messages `strings` are showing.
 *
 * Two things keep the expectation honest. Where two keys share one English literal ('Medium' is both a
 * priority and a card size) any of their readings counts, or the probe would demand text the board never
 * claimed to draw. Where a slot carries a label of its own no reading is predicted, but the string is
 * still watched for the old language lingering.
 */
function messagesIn(strings: string[]): Seen[] {
  const found: Seen[] = []
  for (const value of strings) {
    const matched = TRANSLATED
      .map((entry) => ({ entry, slots: entry.pattern.exec(value)?.slice(1) }))
      .filter((match): match is { entry: (typeof TRANSLATED)[number], slots: string[] } => !!match.slots)
    if (matched.length === 0) continue
    found.push({
      en: value,
      keys: matched.map((match) => match.entry.key),
      zh: [...new Set(
        matched
          .filter((match) => !match.slots.some(slotCarriesLabel))
          .map((match) => renderIn(match.entry.zh, match.slots, match.entry.params)),
      )],
    })
  }
  return found
}

/**
 * After the language changed under a mounted surface: nothing it showed in the old language may still
 * be showing, and every label with a predictable reading has to show it.
 */
function assertRepainted(before: Seen[], root: ParentNode, subject: string): void {
  const after = new Set(renderedStrings(root))
  const predictable = before.filter((match) => match.zh.length > 0)
  expect(
    predictable.length,
    `${subject} offered only ${predictable.length} predictable label(s) to read in the new language: ${predictable.map((match) => match.keys.join('|')).join(', ')}`,
  ).toBeGreaterThanOrEqual(3)
  const stale = before.filter((match) => after.has(match.en))
  expect(stale.map((match) => `${match.keys.join('|')}: ${match.en}`), `${subject} kept labels in the previous language`).toEqual([])
  const missing = before.filter((match) => match.zh.length > 0 && !match.zh.some((value) => after.has(value)))
  expect(
    missing.map((match) => `${match.keys.join('|')}: none of ${match.zh.join(' / ')}`),
    `${subject} drew no label in the new language`,
  ).toEqual([])
}

async function switchToChinese(): Promise<void> {
  await act(async () => {
    await setLocale('zh-CN', false)
  })
}

describe('a memoized board surface holds its own subscription', () => {
  it.each(SUBJECTS)('$name repaints when the language changes underneath it', async ({ name, element }) => {
    const rendered = renderElement(element)
    mounted.push(rendered)
    const before = messagesIn(renderedStrings(document.body))
    expect(before.length, `${name} renders no translatable label, so this case would prove nothing`).toBeGreaterThan(0)

    await switchToChinese()
    assertRepainted(before, document.body, name)
  })
})

describe('the mounted board repaints every view', () => {
  it.each(VIEWS)('$type', async (view) => {
    const rendered = renderElement(createElement(KanbanRoot, { initialData: data, onUpdateData: vi.fn() }))
    mounted.push(rendered)
    const tab = rendered.container.querySelector<HTMLElement>(`[role="tab"][data-view-type="${view.type}"]`)
    expect(tab, `the board rendered no tab for the ${view.type} view`).not.toBeNull()
    act(() => {
      tab!.click()
    })
    const selected = rendered.container.querySelector<HTMLElement>(
      `[role="tab"][data-view-type="${view.type}"][aria-selected="true"]`,
    )
    expect(selected, `clicking the ${view.type} tab did not select it`).not.toBeNull()

    const before = messagesIn(renderedStrings(document.body))
    expect(before.length, `the ${view.type} view renders no translatable label`).toBeGreaterThan(0)

    await switchToChinese()
    assertRepainted(before, document.body, `the ${view.type} view`)
  })
})
