/**
 * The view switcher announces itself as a tablist, but a reader who arrives there is still
 * navigating by accident: every tab is its own Tab stop, so crossing three views takes three
 * presses and the arrow keys do nothing, and nothing points from the selected tab to the region
 * it produced — the panel is reachable only by guessing it is further down the page (review #29).
 * The contract here is the one a horizontal tablist has to keep: one roving stop, Arrow/Home/End
 * moving both focus and selection, and `aria-controls` resolving to a real `role='tabpanel'` that
 * names the selected tab back. The pair is only observable from whoever owns the panel, so the
 * last group mounts the whole board rather than the tabs alone.
 *
 * The strip is also where views are created, named, copied, ordered and removed (F-05), so the
 * groups below cover what those controls offer for the view actually on screen, and the one layout
 * rule the strip exists to keep: it holds a single row as views pile up, because a strip that
 * wraps pushes the whole board down.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import type { PromptOptions } from '../../../../components/overlay'
import { installTestGlobals, renderElement } from '../../../test-render'
import { KANBAN_VIEW_TYPES } from '../view-ops'
import type { KanbanData, KanbanView, KanbanViewType } from '../types'
import { KanbanRoot } from './kanban-root'
import { KanbanViewTabs, type KanbanViewOperations } from './kanban-view-tabs'

// Renaming asks for a name through the app's own prompt dialog. The dialog is hosted by the shell,
// which this suite does not mount, and `Menu` has to stay real — so only `prompt` is replaced, and
// each case decides what the reader typed.
const promptMock = vi.hoisted(() => vi.fn<(options: PromptOptions) => Promise<string | null>>())
vi.mock('../../../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../components/overlay')>()
  return { ...actual, prompt: promptMock }
})

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const VIEW_TYPES: KanbanViewType[] = ['board', 'table', 'list', 'gallery', 'calendar', 'timeline', 'gantt']

const views: KanbanView[] = [
  { id: 'v-board', name: 'Board', type: 'board' },
  { id: 'v-timeline', name: 'Timeline', type: 'timeline' },
  { id: 'v-gantt', name: 'Gantt', type: 'gantt' },
]

const PANEL_ID = 'kanban-view-panel'

const mounted: ReturnType<typeof renderElement>[] = []

function mount(node: Parameters<typeof renderElement>[0]) {
  const rendered = renderElement(node)
  mounted.push(rendered)
  return rendered
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  promptMock.mockReset()
})

function viewOperations(overrides: Partial<KanbanViewOperations> = {}): KanbanViewOperations {
  return {
    createView: vi.fn(),
    renameView: vi.fn(),
    duplicateView: vi.fn(),
    deleteView: vi.fn(),
    moveView: vi.fn(),
    ...overrides,
  }
}

function mountTabs(
  activeViewId: string,
  options: { views?: KanbanView[]; onSelectView?: Mock<(viewId: string) => void>; viewOps?: KanbanViewOperations } = {},
) {
  const onSelectView = options.onSelectView ?? vi.fn<(viewId: string) => void>()
  const viewOps = options.viewOps ?? viewOperations()
  const rendered = mount(
    createElement(KanbanViewTabs, {
      views: options.views ?? views,
      activeViewId,
      panelId: PANEL_ID,
      onSelectView,
      viewOps,
    }),
  )
  const tabs = [...rendered.container.querySelectorAll<HTMLElement>('[role="tab"]')]
  return { ...rendered, tabs, onSelectView, viewOps }
}

function click(node: HTMLElement): void {
  act(() => {
    node.click()
  })
}

function namedControl(root: ParentNode, name: string): HTMLElement {
  const control = root.querySelector<HTMLElement>(`button[aria-label="${name}"]`)
  if (!control) throw new Error(`nothing in the view switcher is named "${name}"`)
  return control
}

/** The menu the switcher last opened. `Menu` paints into `document.body`, outside the strip. */
function openMenu(): HTMLElement {
  const panels = [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
  const panel = panels[panels.length - 1]
  if (!panel) throw new Error('no menu is open')
  return panel
}

function menuItems(): HTMLButtonElement[] {
  return [...openMenu().querySelectorAll<HTMLButtonElement>('button')]
}

function menuItem(label: string): HTMLButtonElement {
  const item = menuItems().find((node) => node.textContent?.includes(label))
  if (!item) throw new Error(`the open menu offers no "${label}" — it lists ${menuItems().map((n) => n.textContent).join(' / ')}`)
  return item
}

function press(node: HTMLElement, key: string): void {
  act(() => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function tabByView(viewId: string, container: ParentNode = document): HTMLButtonElement {
  const tab = container.querySelector<HTMLButtonElement>(`[id$="${viewId}"]`)
  expect(tab, `no tab for view ${viewId}`).not.toBeNull()
  return tab!
}

describe('KanbanViewTabs icons', () => {
  it('draws a distinct icon for the timeline and gantt tabs', () => {
    const { container } = mountTabs('v-board')
    const svgOf = (type: string) =>
      container.querySelector(`button[data-view-type="${type}"] svg`)?.outerHTML
    const timeline = svgOf('timeline')
    const gantt = svgOf('gantt')
    expect(timeline).toBeTruthy()
    expect(gantt).toBeTruthy()
    expect(gantt).not.toBe(timeline)
    expect(gantt).toMatch(/gantt/i)
  })
})

describe('KanbanViewTabs tab order', () => {
  it('keeps the selected tab as the only entry point into the list', () => {
    const { tabs } = mountTabs('v-timeline')
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
  })

  it('points every tab at the panel it controls', () => {
    const { tabs } = mountTabs('v-board')
    for (const tab of tabs) expect(tab.getAttribute('aria-controls')).toBe(PANEL_ID)
  })
})

describe('KanbanViewTabs keyboard', () => {
  it('selects and focuses the next tab on ArrowRight, wrapping at the end', () => {
    const { container, onSelectView } = mountTabs('v-gantt')
    const last = tabByView('v-gantt', container)
    last.focus()
    press(last, 'ArrowRight')
    expect(onSelectView).toHaveBeenCalledWith('v-board')
    expect(document.activeElement).toBe(tabByView('v-board', container))
  })

  it('selects and focuses the previous tab on ArrowLeft, wrapping at the start', () => {
    const { container, onSelectView } = mountTabs('v-board')
    const first = tabByView('v-board', container)
    first.focus()
    press(first, 'ArrowLeft')
    expect(onSelectView).toHaveBeenCalledWith('v-gantt')
    expect(document.activeElement).toBe(tabByView('v-gantt', container))
  })

  it('jumps to either end of the list on Home and End', () => {
    const { container, onSelectView } = mountTabs('v-timeline')
    const middle = tabByView('v-timeline', container)
    middle.focus()
    press(middle, 'Home')
    press(document.activeElement as HTMLElement, 'End')
    expect(onSelectView.mock.calls.map((call) => call[0])).toEqual(['v-board', 'v-gantt'])
    expect(document.activeElement).toBe(tabByView('v-gantt', container))
  })

  it('leaves an unrelated key alone', () => {
    const { container, onSelectView } = mountTabs('v-board')
    const first = tabByView('v-board', container)
    first.focus()
    press(first, 'a')
    expect(onSelectView).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(first)
  })
})

describe('KanbanViewTabs pointer', () => {
  it('selects the view whose tab is clicked', () => {
    const { container, onSelectView } = mountTabs('v-board')
    const target = tabByView('v-gantt', container)
    act(() => target.click())
    expect(onSelectView).toHaveBeenCalledWith('v-gantt')
  })
})

const boardData: KanbanData = {
  columns: [
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
  ],
  items: [{ id: 'a', title: 'Design spec', properties: { status: 'todo' } }],
  views: VIEW_TYPES.map((type) => ({ id: `v-${type}`, name: type, type, groupBy: 'status' })),
}

function mountBoard() {
  const onUpdateData = vi.fn<(next: KanbanData) => void>()
  const rendered = mount(createElement(KanbanRoot, { initialData: boardData, onUpdateData }))
  return { ...rendered, onUpdateData }
}

describe('KanbanRoot view panel', () => {
  it('exposes the rendered view as the panel the selected tab controls', () => {
    const { container } = mountBoard()
    const selected = container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    expect(selected).not.toBeNull()
    const panel = document.getElementById(selected!.getAttribute('aria-controls')!)
    expect(panel?.getAttribute('role')).toBe('tabpanel')
    expect(panel?.getAttribute('aria-labelledby')).toBe(selected!.id)
  })

  it('keeps the panel pointing at the tab the arrow keys moved to', () => {
    const { container } = mountBoard()
    const first = container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!
    first.focus()
    press(first, 'ArrowRight')
    const nowSelected = container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    expect(nowSelected?.textContent).toContain('Table')
    const panel = document.getElementById(nowSelected!.getAttribute('aria-controls')!)
    expect(panel?.getAttribute('aria-labelledby')).toBe(nowSelected!.id)
  })

  it('switches the mounted board to the tab a pointer clicked', () => {
    const { container } = mountBoard()
    const tableTab = container.querySelector<HTMLElement>('[role="tab"][data-view-type="table"]')!
    act(() => tableTab.click())
    const selected = container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    expect(selected?.getAttribute('data-view-type')).toBe('table')
    const panel = document.getElementById(selected!.getAttribute('aria-controls')!)
    expect(panel?.getAttribute('aria-labelledby')).toBe(selected!.id)
  })
})

describe('KanbanRoot view naming', () => {
  // The panel already carries the name of the tab that controls it, and every view used to wrap
  // itself in a named region holding the very same string — a reader entering one view heard it
  // twice. The rest of the app has no such inner landmark (its only other tab surface, the markdown
  // tabs block, names the panel and stops there), so the panel is the one named container.
  it.each(VIEW_TYPES)('the %s view leaves the naming to the panel its tab controls', (type) => {
    const { container } = mountBoard()
    const tab = container.querySelector<HTMLElement>(`[role="tab"][data-view-type="${type}"]`)
    expect(tab, `no tab for the ${type} view`).not.toBeNull()
    act(() => {
      tab!.click()
    })
    const selected = container.querySelector<HTMLElement>(`[role="tab"][data-view-type="${type}"][aria-selected="true"]`)
    expect(selected, `clicking the ${type} tab did not select it`).not.toBeNull()

    const panel = document.getElementById(selected!.getAttribute('aria-controls')!)
    expect(panel?.getAttribute('role'), 'the container the tab controls is no longer the panel').toBe('tabpanel')
    expect(panel?.getAttribute('aria-labelledby')).toBe(selected!.id)
    expect(panel?.firstElementChild, `the ${type} view mounted nothing`).not.toBeNull()
    expect(panel?.querySelectorAll('[role="region"]').length, 'a view named itself again inside the panel').toBe(0)
  })
})

describe('adding a view', () => {
  it('lists every kind of view and creates the one picked', () => {
    const { container, viewOps } = mountTabs('v-board')
    click(namedControl(container, t('preview.kanban_new_view')))
    expect(menuItems()).toHaveLength(KANBAN_VIEW_TYPES.length)
    click(menuItem(t('preview.kanban_view_gantt')))
    expect(viewOps.createView).toHaveBeenCalledWith('gantt')
    expect(document.querySelector('[role="menu"]'), 'the list outlived the pick').toBeNull()
  })

  it('says which list the add control opens', () => {
    const { container } = mountTabs('v-board')
    const trigger = namedControl(container, t('preview.kanban_new_view'))
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded'), 'a closed list must read as closed').toBe('false')
    click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(openMenu().id)
  })
})

describe('renaming the view on screen', () => {
  it('asks for a name and commits what was typed', async () => {
    promptMock.mockResolvedValue('Shipped items')
    const { container, viewOps } = mountTabs('v-timeline')
    click(namedControl(container, t('preview.kanban_view_actions')))
    await act(async () => {
      click(menuItem(t('preview.kanban_view_rename')))
    })
    expect(promptMock.mock.calls[0]?.[0]).toMatchObject({ defaultValue: t('preview.kanban_view_timeline') })
    expect(viewOps.renameView).toHaveBeenCalledWith('v-timeline', 'Shipped items')
  })

  it('keeps the name when the dialog is dismissed', async () => {
    promptMock.mockResolvedValue(null)
    const { container, viewOps } = mountTabs('v-board')
    click(namedControl(container, t('preview.kanban_view_actions')))
    await act(async () => {
      click(menuItem(t('preview.kanban_view_rename')))
    })
    expect(viewOps.renameView).not.toHaveBeenCalled()
  })

  it('keeps the name when the box comes back blank', async () => {
    promptMock.mockResolvedValue('   ')
    const { container, viewOps } = mountTabs('v-board')
    click(namedControl(container, t('preview.kanban_view_actions')))
    await act(async () => {
      click(menuItem(t('preview.kanban_view_rename')))
    })
    expect(viewOps.renameView).not.toHaveBeenCalled()
  })
})

describe('managing the view on screen', () => {
  it('copies and deletes the view the strip is showing', () => {
    const { container, viewOps } = mountTabs('v-gantt')
    click(namedControl(container, t('preview.kanban_view_actions')))
    click(menuItem(t('preview.kanban_view_duplicate')))
    expect(viewOps.duplicateView).toHaveBeenCalledWith('v-gantt')
    click(namedControl(container, t('preview.kanban_view_actions')))
    click(menuItem(t('preview.kanban_view_delete')))
    expect(viewOps.deleteView).toHaveBeenCalledWith('v-gantt')
  })

  it('walks the tab one step each way', () => {
    const { container, viewOps } = mountTabs('v-timeline')
    click(namedControl(container, t('preview.kanban_view_actions')))
    click(menuItem(t('preview.kanban_view_move_earlier')))
    expect(viewOps.moveView).toHaveBeenCalledWith('v-timeline', -1)
    click(namedControl(container, t('preview.kanban_view_actions')))
    click(menuItem(t('preview.kanban_view_move_later')))
    expect(viewOps.moveView).toHaveBeenCalledWith('v-timeline', 1)
  })

  it('offers no step that has nowhere to go', () => {
    const { container } = mountTabs('v-board')
    click(namedControl(container, t('preview.kanban_view_actions')))
    expect(menuItem(t('preview.kanban_view_move_earlier')).disabled, 'the first tab was offered a step left').toBe(true)
    expect(menuItem(t('preview.kanban_view_move_later')).disabled).toBe(false)
  })

  it('refuses to delete the only view a board has', () => {
    const alone = mountTabs('v-board', { views: [views[0]!] })
    click(namedControl(alone.container, t('preview.kanban_view_actions')))
    expect(menuItem(t('preview.kanban_view_delete')).disabled, 'a board would be left with no view at all').toBe(true)

    const pair = mountTabs('v-board', { views })
    click(namedControl(pair.container, t('preview.kanban_view_actions')))
    expect(menuItem(t('preview.kanban_view_delete')).disabled).toBe(false)
  })
})

describe('the strip keeps the header one row tall', () => {
  function classesOf(node: HTMLElement): string[] {
    return node.className.split(/\s+/)
  }

  function tabStrip(container: ParentNode): HTMLElement {
    const strip = container.querySelector<HTMLElement>('[role="tablist"]')
    expect(strip, 'the view switcher is no longer a tablist').not.toBeNull()
    return strip!
  }

  it('scrolls sideways rather than wrapping onto a second row', () => {
    const { container, tabs } = mountTabs('v-board')
    const classes = classesOf(tabStrip(container))
    expect(classes.some((c) => c.includes('flex-wrap')), 'a wrapping strip grows the header as views are added').toBe(false)
    expect(classes.some((c) => c.includes('overflow-x-auto')), 'nothing scrolls, so extra tabs are unreachable').toBe(true)
    expect(classes).toContain('min-w-0')
    for (const tab of tabs) {
      expect(classesOf(tab), `the "${tab.textContent}" tab can be squeezed by the strip`).toContain('shrink-0')
    }
  })

  it('keeps its management controls out of the list of tabs', () => {
    const { container } = mountTabs('v-board')
    const strays = [...tabStrip(container).children].filter((node) => node.getAttribute('role') !== 'tab')
    expect(strays.map((node) => node.textContent), 'a control inside a tablist is announced as a tab').toEqual([])
  })
})

describe('a board whose views are managed', () => {
  beforeEach(() => {
    useUi.setState({ toasts: [] })
  })

  it('gains a tab for the view created from the header and shows it', () => {
    const { container, onUpdateData } = mountBoard()
    const before = container.querySelectorAll('[role="tab"]').length
    click(namedControl(container, t('preview.kanban_new_view')))
    click(menuItem(t('preview.kanban_view_gantt')))
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')]
    expect(tabs).toHaveLength(before + 1)
    const selected = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')
    // The created view stores its type as its name, so the fresh tab reads in the reader's language
    // and the number keeps two tabs of one kind apart.
    expect(selected?.textContent).toBe(`${t('preview.kanban_view_gantt')} 2`)
    const panel = document.getElementById(selected!.getAttribute('aria-controls')!)
    expect(panel?.getAttribute('aria-labelledby')).toBe(selected!.id)
    expect(onUpdateData.mock.calls.at(-1)?.[0].views).toHaveLength(before + 1)
  })

  it('loses the tab of the view deleted from the header, and says so with a way back', () => {
    const { container } = mountBoard()
    click(container.querySelector<HTMLElement>('[role="tab"][data-view-type="table"]')!)
    click(namedControl(container, t('preview.kanban_view_actions')))
    click(menuItem(t('preview.kanban_view_delete')))
    const types = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.dataset.viewType)
    expect(types).not.toContain('table')
    expect(container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.dataset.viewType).toBe('board')
    const toast = useUi.getState().toasts.at(-1)
    expect(toast).toMatchObject({ title: t('preview.kanban_view_deleted'), action: { label: t('common.undo'), run: expect.any(Function) } })
  })

  it('renames the tab it was asked about', async () => {
    promptMock.mockResolvedValue('Ship log')
    const { container } = mountBoard()
    click(namedControl(container, t('preview.kanban_view_actions')))
    await act(async () => {
      click(menuItem(t('preview.kanban_view_rename')))
    })
    const selected = container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    expect(selected?.textContent).toBe('Ship log')
  })
})

describe('the tab marks a view that narrows the cards on its own', () => {
  const DOT = 'span[aria-hidden="true"]'

  function tabFor(rendered: ReturnType<typeof mountTabs>, viewId: string): HTMLElement {
    const tab = rendered.tabs.find((candidate) => candidate.id === `${PANEL_ID}-tab-${viewId}`)
    if (!tab) throw new Error(`no tab for view ${viewId}`)
    return tab
  }

  it('draws the dot and the accessible sentence on a filtered view only', () => {
    const views: KanbanView[] = [
      { id: 'v-plain', name: 'Plain', type: 'board' },
      { id: 'v-filtered', name: 'Filtered', type: 'board', filters: [{ propertyId: 'status', operator: 'equals', value: 'todo' }] },
    ]
    const rendered = mountTabs('v-plain', { views })
    expect(tabFor(rendered, 'v-plain').querySelector(DOT), 'a plain view wore the mark').toBeNull()
    const marked = tabFor(rendered, 'v-filtered')
    expect(marked.querySelector(DOT)).not.toBeNull()
    expect(marked.textContent).toContain(t('preview.kanban_view_carries_state'))
  })

  it('counts sorts, a search query and a tag selection as carried state, but not a blank one', () => {
    const views: KanbanView[] = [
      { id: 'v-sort', name: 'Sorted', type: 'table', sorts: [{ propertyId: 'title', direction: 'asc' }] },
      { id: 'v-search', name: 'Searched', type: 'table', searchQuery: 'alpha' },
      { id: 'v-tags', name: 'Tagged', type: 'gallery', selectedTags: ['feat'] },
      { id: 'v-blank', name: 'Blank', type: 'table', searchQuery: '   ' },
    ]
    const rendered = mountTabs('v-sort', { views })
    expect(tabFor(rendered, 'v-sort').querySelector(DOT)).not.toBeNull()
    expect(tabFor(rendered, 'v-search').querySelector(DOT)).not.toBeNull()
    expect(tabFor(rendered, 'v-tags').querySelector(DOT)).not.toBeNull()
    expect(tabFor(rendered, 'v-blank').querySelector(DOT), 'a whitespace query is not a lens').toBeNull()
  })
})
