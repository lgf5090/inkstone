/**
 * Every control the board renders has to say what it does: an icon-only button with no name reads
 * as "Button" in a screen reader, which is the same gap the popover pass closed for panels
 * (review #29). Rather than trusting a hand-tallied list of suspects, this mounts the real board,
 * walks every interactive element of each view and of the detail dialog, and fails with the
 * offending markup — so a new control that forgets its name is named by the suite, not by a review.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { KanbanRoot } from './kanban-root'
import { KanbanSortPopover } from './kanban-sort-popover'
import type { KanbanData, KanbanViewType } from '../types'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const VIEW_TYPES: KanbanViewType[] = ['board', 'table', 'list', 'gallery', 'calendar', 'timeline', 'gantt', 'chart']

const columns = [
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
  { id: 'labels', name: 'Labels', type: 'multi-select', options: [{ id: 'x', label: 'Spec', color: 'green' }] },
  { id: 'done', name: 'Done', type: 'checkbox' },
  { id: 'startDate', name: 'Start date', type: 'date' },
  { id: 'endDate', name: 'End date', type: 'date' },
  { id: 'progress', name: 'Progress', type: 'number' },
  { id: 'owner', name: 'Owner', type: 'text' },
] as KanbanData['columns']

const data: KanbanData = {
  columns,
  items: [
    {
      id: 'a',
      title: 'Design spec',
      content: 'Body text',
      files: [{ id: 'f1', name: 'plan.md', url: '/api/kanban/file/a/plan.md', size: 12, mime: 'text/markdown' }],
      subtasks: [
        { id: 's1', title: 'Draft the outline', completed: false },
        { id: 's2', title: 'Review it', completed: true },
      ],
      properties: {
        status: 'todo',
        labels: ['x'],
        done: true,
        startDate: '2026-09-01',
        endDate: '2026-09-12',
        progress: 40,
        owner: 'ada',
      },
    },
    { id: 'b', title: 'Empty ticket', properties: { status: 'doing', startDate: '2026-09-05' } },
  ],
  views: VIEW_TYPES.map((type) => ({
    id: `v-${type}`,
    name: type,
    type,
    groupBy: 'status',
    progressField: 'progress',
  })) as KanbanData['views'],
}

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mountBoard() {
  const rendered = renderElement(createElement(KanbanRoot, { initialData: data, onUpdateData: vi.fn() }))
  mounted.push(rendered)
  return rendered
}

/** A control is unnamed when none of the ways HTML and ARIA give it a name produce text. */
function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim()
    if (text) return text
  }
  for (const attr of ['aria-label', 'title', 'alt', 'placeholder']) {
    const value = el.getAttribute(attr)?.trim()
    if (value) return value
  }
  const label = (el as HTMLInputElement).labels?.[0] ?? el.closest('label')
  if (label?.textContent?.trim()) return label.textContent.trim()
  // A select's text is the list of values it offers, which is its contents rather than a name — an
  // unlabeled choice control would otherwise read as named by every option it contains.
  if (el.tagName === 'SELECT') return ''
  const image = el.querySelector('img[alt]')
  if (image?.getAttribute('alt')?.trim()) return image.getAttribute('alt')!.trim()
  return el.textContent?.trim() ?? ''
}

const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="checkbox"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="slider"]'

function unnamedControls(root: ParentNode): string[] {
  return [...root.querySelectorAll<HTMLElement>(INTERACTIVE)]
    .filter((el) => !el.hasAttribute('aria-hidden'))
    .filter((el) => accessibleName(el) === '')
    .map((el) => {
      const icon = el.querySelector('svg[class]')?.getAttribute('class')?.replace('lucide ', '') ?? ''
      const text = (el.textContent ?? '').trim().slice(0, 24)
      return `<${el.tagName.toLowerCase()}${icon ? ` icon=${icon}` : ''} class="${el.getAttribute('class') ?? ''}">${text}`
    })
}

function selectView(container: HTMLElement, type: KanbanViewType): void {
  const tab = container.querySelector<HTMLElement>(`[role="tab"][data-view-type="${type}"]`)
  expect(tab, `no tab for the ${type} view`).not.toBeNull()
  act(() => {
    tab!.click()
  })
  // Without this the walk would silently re-measure whichever view mounted first.
  const selected = container.querySelector<HTMLElement>(
    `[role="tab"][data-view-type="${type}"][aria-selected="true"]`,
  )
  expect(selected, `clicking the ${type} tab did not select it`).not.toBeNull()
}

describe.each(VIEW_TYPES)('%s view controls are named', (type) => {
  it(`gives every interactive element of the ${type} view an accessible name`, () => {
    const { container } = mountBoard()
    selectView(container, type)
    expect(unnamedControls(container)).toEqual([])
  })
})

/** The subtask panels of a row are only in the document once its expander is open. */
function expandSubtasks(container: HTMLElement): void {
  const expanders = [...container.querySelectorAll<HTMLElement>(
    `[aria-expanded="false"][aria-label="${t('preview.kanban_expand_subtasks')}"]`,
  )]
  expect(expanders.length, 'no subtask expander to open').toBeGreaterThan(0)
  for (const expander of expanders) {
    act(() => {
      expander.click()
    })
  }
}

describe('expanded subtask panels', () => {
  for (const type of ['table', 'list'] as const) {
    it(`names every control of the ${type} view with its subtasks expanded`, () => {
      const { container } = mountBoard()
      selectView(container, type)
      expandSubtasks(container)
      expect(unnamedControls(container)).toEqual([])
    })
  }
})

/**
 * A rule row is a line of bare choice controls, and the header only mounts one after its trigger is
 * clicked — so the walks above never see it.
 */
describe('rule popovers', () => {
  it('names the field and the direction of a sort rule', () => {
    const rendered = renderElement(createElement(KanbanSortPopover, {
      open: true,
      panelId: 'sort-panel',
      onClose: () => {},
      anchorRef: { current: null as HTMLElement | null },
      columns,
      sorts: [{ propertyId: 'status', direction: 'asc' }],
      onChangeSorts: () => {},
    }))
    mounted.push(rendered)
    expect(unnamedControls(rendered.container)).toEqual([])
  })
})

/**
 * The columns panel and whatever it discloses are only in the document once the reader opens them,
 * so the view walks above never see those controls either.
 */
describe('column schema panel', () => {
  it('names every control of the columns panel with a column editor open', () => {
    const { container } = mountBoard()
    selectView(container, 'table')
    const trigger = [...container.querySelectorAll<HTMLElement>('button')].find(
      (b) => b.textContent?.includes(t('preview.kanban_columns')),
    )
    expect(trigger, 'the table view has no columns trigger').toBeTruthy()
    act(() => { trigger!.click() })
    const panel = container.querySelector<HTMLElement>('[role="dialog"]')
    if (!panel) throw new Error('the columns panel did not open')
    const toggle = panel.querySelector<HTMLElement>('button[aria-expanded]')
    expect(toggle, 'the panel lists no editable column').toBeTruthy()
    act(() => { toggle!.click() })
    expect(document.getElementById(toggle!.getAttribute('aria-controls')!), 'the editor did not mount').toBeTruthy()
    expect(unnamedControls(panel)).toEqual([])
  })
})

describe('item detail controls', () => {
  it('names every control of the detail dialog opened from a card', () => {
    const { container } = mountBoard()
    const card = container.querySelector<HTMLElement>('[data-item-id="a"]')
    expect(card).not.toBeNull()
    act(() => {
      // The card is a container of controls (SH-107): its title button is what opens the detail.
      card!.querySelector<HTMLButtonElement>('h3 button')!.click()
    })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    if (!dialog) throw new Error('the card click did not open the detail dialog')
    expect(unnamedControls(dialog)).toEqual([])
  })
})
