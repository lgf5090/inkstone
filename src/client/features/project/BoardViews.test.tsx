import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardBundle, ProjectViewFields, ProjectViewPatch, ProjectViewType } from '@shared/project/model'
import { emptyProjectViewFields, PROJECT_VIEW_TYPES } from '@shared/project/model'
import { projectDayToStamp } from '@shared/project/date'
import { initI18n, initI18nForReading, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { BoardViews } from './BoardViews'
import * as api from './api'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }

function bundle(): ProjectBoardBundle {
  return {
    board: { id: 'b1', ownerId: 'u1', type: 'P', minimumRole: '', title: 'B', description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, ...stamps },
    properties: [
      { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: '' }, { id: 'o2', value: 'Done', color: '' }] },
      { id: 'pt', name: 'Notes', type: 'text', options: [] },
    ],
    views: [
      { id: 'v1', boardId: 'b1', title: 'Table', viewType: 'table', fields: emptyProjectViewFields(), position: 0, ...stamps },
      { id: 'v2', boardId: 'b1', title: 'Board', viewType: 'board', fields: { ...emptyProjectViewFields(), groupById: 'ps' }, position: 1, ...stamps },
    ],
    cards: [
      { id: 'c1', boardId: 'b1', parentId: '', title: 'Alpha', icon: '', isTemplate: false, contentOrder: [], values: { ps: 'o1', pt: 'hello' }, ...stamps },
      { id: 'c2', boardId: 'b1', parentId: '', title: 'Beta', icon: '', isTemplate: false, contentOrder: [], values: { ps: 'o2' }, ...stamps },
      { id: 'c3', boardId: 'b1', parentId: '', title: 'Gamma', icon: '', isTemplate: false, contentOrder: [], values: {}, ...stamps },
    ],
    contents: [], comments: [], members: [], role: 'admin', cursor: 1,
  }
}

let view: RenderedElement
async function mount(): Promise<void> {
  await act(async () => {
    view = renderElement(createElement(BoardViews, { bundle: bundle(), canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
  })
}
/** Opens a SelectMenu by its accessible name and reads the rows it offers. */
async function menuLabels(label: string): Promise<string[]> {
  const trigger = view.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(trigger, `no select named ${label}`).not.toBeNull()
  await act(async () => { trigger!.click() })
  return [...document.querySelectorAll('[role="menuitemcheckbox"], [role="menuitem"]')].map((row) => row.textContent ?? '')
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
})
afterEach(() => { view?.unmount() })

describe('the table view', () => {
  it('renders a column per property and a row per card with display values', async () => {
    await mount()
    const headers = [...view.container.querySelectorAll('thead th')].map((th) => th.textContent)
    expect(headers).toContain('Status')
    expect(headers).toContain('Notes')
    const rows = [...view.container.querySelectorAll('tbody tr[data-project-card]')]
    expect(rows).toHaveLength(3)
    expect(rows[0]!.textContent).toContain('Alpha')
    expect(rows[0]!.textContent).toContain('Open')
    expect(rows[0]!.textContent).toContain('hello')
  })
})

describe('the board view', () => {
  it('groups cards into option columns plus a no-value column', async () => {
    await mount()
    const boardTab = [...view.container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === 'Board')
    await act(async () => { boardTab?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    const columns = [...view.container.querySelectorAll('section')]
    const labels = columns.map((column) => column.getAttribute('aria-label'))
    expect(labels).toEqual(['Open', 'Done', t('project.view.no_value')])
    expect(columns[0]!.querySelectorAll('[data-project-card]')).toHaveLength(1)
    expect(columns[0]!.textContent).toContain('Alpha')
    expect(columns[2]!.textContent).toContain('Gamma')
  })
})

describe('view tab labels', () => {
  afterEach(async () => { await initI18nForReading('en-US') })
  it('labels every untitled view tab with its own type, not the table fallback', async () => {
    const base = bundle()
    base.views = PROJECT_VIEW_TYPES.map((viewType: ProjectViewType, index) => ({
      id: `v${index}`, boardId: 'b1', title: '', viewType, fields: emptyProjectViewFields(), position: index, ...stamps,
    }))
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    const labels = [...view.container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
    expect(labels).toEqual(PROJECT_VIEW_TYPES.map((viewType) => t(`project.view.${viewType}` as Parameters<typeof t>[0])))
    expect(labels).toContain(t('project.view.list'))
    expect(labels).toContain(t('project.view.gantt'))
    for (const tab of view.container.querySelectorAll('[role="tab"]')) {
      expect(tab.className).toContain('whitespace-nowrap')
      expect(tab.className).toContain('shrink-0')
    }
    expect(view.container.querySelector('[role="tablist"]')!.className).toContain('overflow-x-auto')
  })

  it('localizes a canonical English template title instead of mixing languages', async () => {
    await initI18nForReading('zh-CN')
    const base = bundle()
    base.views = [{ ...base.views[0]!, title: 'Table' }]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn().mockResolvedValue(undefined), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    expect(view.container.querySelector('[role="tab"]')!.textContent).toBe(t('project.view.table'))
  })

  it('keeps a user-typed view title verbatim', async () => {
    const base = bundle()
    base.views = [{ ...base.views[0]!, title: '我的视图' }]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn().mockResolvedValue(undefined), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    expect(view.container.querySelector('[role="tab"]')!.textContent).toBe('我的视图')
  })
})

describe('board column hide and cross-column drag (C-2)', () => {
  async function mountBoard(onPatch: ReturnType<typeof vi.fn<(id: string, patch: ProjectViewPatch) => Promise<void>>>, onPatchCard: ReturnType<typeof vi.fn<(id: string, patch: Record<string, unknown>) => Promise<void>>>) {
    const base = bundle()
    base.views = [base.views[1]!]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: onPatch, onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard, onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
  }

  it('hide column persists hiddenOptionIds', async () => {
    const onPatch = vi.fn<(id: string, patch: ProjectViewPatch) => Promise<void>>().mockResolvedValue(undefined)
    await mountBoard(onPatch, vi.fn<(id: string, patch: Record<string, unknown>) => Promise<void>>().mockResolvedValue(undefined))
    const menu = view.container.querySelector<HTMLButtonElement>(`button[aria-label="Open ${t('project.view.menu')}"]`)
    expect(menu, 'no column menu').not.toBeNull()
    await act(async () => { menu!.click() })
    const hide = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((row) => row.textContent === t('project.view.hide_column'))
    expect(hide, 'hide is not in the column menu').toBeDefined()
    await act(async () => { hide!.click() })
    expect(onPatch).toHaveBeenCalledWith('v2', { fields: { hiddenOptionIds: ['o1'] } })
  })

  it('dragging a card into another column patches its group value and its manual order', async () => {
    const onPatchCard = vi.fn<(id: string, patch: Record<string, unknown>) => Promise<void>>().mockResolvedValue(undefined)
    const onPatch = vi.fn<(id: string, patch: ProjectViewPatch) => Promise<void>>().mockResolvedValue(undefined)
    await mountBoard(onPatch, onPatchCard)
    // jsdom lays nothing out, so the drag engine is given the geometry a real board would have.
    const zones = [...view.container.querySelectorAll<HTMLElement>('[data-drag-zone]')]
    zones.forEach((zone, index) => {
      zone.getBoundingClientRect = () => ({ left: index * 300, right: index * 300 + 280, top: 0, bottom: 600, width: 280, height: 600, x: index * 300, y: 0, toJSON: () => ({}) })
    })
    for (const id of ['c1', 'c2']) {
      const card = view.container.querySelector<HTMLElement>(`[data-drag-id="${id}"]`)!
      const top = id === 'c1' ? 0 : 0
      const left = id === 'c1' ? 0 : 300
      card.getBoundingClientRect = () => ({ left, right: left + 280, top, bottom: top + 80, width: 280, height: 80, x: left, y: top, toJSON: () => ({}) })
    }
    const grip = view.container.querySelector<HTMLElement>('[data-drag-id="c1"] [data-drag-handle]')!
    const down = new Event('pointerdown', { bubbles: true, cancelable: true }) as PointerEvent
    Object.defineProperties(down, { clientX: { value: 10 }, clientY: { value: 10 }, button: { value: 0 }, pointerType: { value: 'mouse' } })
    await act(async () => { grip.dispatchEvent(down) })
    const move = new Event('pointermove', { bubbles: true, cancelable: true }) as PointerEvent
    Object.defineProperties(move, { clientX: { value: 320 }, clientY: { value: 120 } })
    await act(async () => { window.dispatchEvent(move) })
    await act(async () => { window.dispatchEvent(new Event('pointerup')) })
    expect(onPatchCard).toHaveBeenCalledWith('c1', { values: { ps: 'o2' } })
    const orderPatch = onPatch.mock.calls.find(([, patch]) => patch.fields?.cardOrder)?.[1]
    expect(orderPatch?.fields?.cardOrder).toEqual(['c2', 'c1', 'c3'])
  })
})

describe('table group rows, collapse, inline edit, column reorder (C-3/C-22)', () => {
  async function mountTable(fields: Partial<ProjectViewFields>, onPatchView: (id: string, patch: ProjectViewPatch) => Promise<void>, onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>) {
    const base = bundle()
    base.views = [{ ...base.views[0]!, fields: { ...emptyProjectViewFields(), ...fields } }]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView, onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard, onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
  }

  it('group header collapse persists collapsedOptionIds and hides rows', async () => {
    const onPatchView = vi.fn().mockResolvedValue(undefined)
    await mountTable({ groupById: 'ps' }, onPatchView, vi.fn().mockResolvedValue(undefined))
    const toggle = view.container.querySelector('tbody button[aria-expanded="true"]') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    await act(async () => { toggle.click() })
    expect(onPatchView).toHaveBeenCalledWith('v1', { fields: { collapsedOptionIds: ['o1'] } })
  })

  it('a collapsed group renders no card rows', async () => {
    await mountTable({ groupById: 'ps', collapsedOptionIds: ['o1'] }, vi.fn().mockResolvedValue(undefined), vi.fn().mockResolvedValue(undefined))
    expect(view.container.querySelector('[data-project-card="c1"]')).toBeNull()
    expect(view.container.querySelector('[data-project-card="c2"]')).not.toBeNull()
  })

  it('the no-value group can be collapsed with the empty-string key', async () => {
    await mountTable({ groupById: 'ps', collapsedOptionIds: [''] }, vi.fn().mockResolvedValue(undefined), vi.fn().mockResolvedValue(undefined))
    expect(view.container.querySelector('[data-project-card="c3"]')).toBeNull()
    expect(view.container.querySelector('[data-project-card="c1"]')).not.toBeNull()
  })

  it('clicking a cell opens the inline editor and commits via onPatchCard', async () => {
    const onPatchCard = vi.fn().mockResolvedValue(undefined)
    await mountTable({}, vi.fn().mockResolvedValue(undefined), onPatchCard)
    const cell = view.container.querySelector('[data-project-card="c1"] td:nth-child(3) button') as HTMLButtonElement
    await act(async () => { cell.click() })
    const trigger = view.container.querySelector<HTMLButtonElement>('[data-project-card="c1"] button[aria-label="Status"]')
    expect(trigger).not.toBeNull()
    await act(async () => { trigger!.click() })
    const done = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"], [role="menuitem"]')].find((row) => row.textContent === 'Done')
    expect(done, 'no Done row in the cell picker').toBeDefined()
    await act(async () => { done!.click() })
    expect(onPatchCard).toHaveBeenCalledWith('c1', { values: { ps: 'o2' } })
  })

  it('dropping a header reorders visiblePropertyIds', async () => {
    const onPatchView = vi.fn().mockResolvedValue(undefined)
    await mountTable({}, onPatchView, vi.fn().mockResolvedValue(undefined))
    const headers = [...view.container.querySelectorAll('thead th[draggable="true"]')]
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { getData: () => 'pt' } })
    await act(async () => { headers[0]!.dispatchEvent(event) })
    expect(onPatchView).toHaveBeenCalledWith('v1', { fields: { visiblePropertyIds: ['pt', 'ps'] } })
  })
})

describe('multi-select and batch delete (B-10)', () => {
  it('ctrl-click selects cards and delete-selected calls the batch endpoint', async () => {
    localStorage.clear()
    const batchDelete = vi.spyOn(api, 'batchDeleteProjectBoard').mockResolvedValue(undefined)
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: bundle(), canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn().mockResolvedValue(undefined), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh }))
    })
    for (const id of ['c1', 'c2']) {
      const title = view.container.querySelector(`[data-project-card="${id}"] td button`) as HTMLButtonElement
      await act(async () => { title.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })) })
    }
    expect(view.container.querySelector('[role="toolbar"]')?.textContent).toContain(t('project.view.selected_count', { count: 2 }))
    const del = [...view.container.querySelectorAll('[role="toolbar"] button')].find((b) => b.textContent === t('project.view.delete_selected')) as HTMLButtonElement
    await act(async () => { del.click() })
    expect(batchDelete).toHaveBeenCalledWith('b1', { cardIds: ['c1', 'c2'] })
    expect(onRefresh).toHaveBeenCalled()
    batchDelete.mockRestore()
  })
})

describe('select option color chip (R2-6, R3-12)', () => {
  it('renders a tinted chip for the reference token an archive actually stores', async () => {
    localStorage.clear()
    const base = bundle()
    base.properties = base.properties.map((p) => (p.id === 'ps' ? { ...p, options: p.options.map((o) => (o.id === 'o1' ? { ...o, color: 'propColorRed' } : o)) } : p))
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn().mockResolvedValue(undefined), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    const chip = view.container.querySelector('[data-project-card="c1"] td span[style]') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.getAttribute('style')).toContain('background-color')
    expect(chip.getAttribute('style')).toContain('--kanban-tag-red-fg')
    expect(chip.textContent).toBe('Open')
  })
})

describe('column resize grip (C-17)', () => {
  it('ArrowRight on the grip persists a wider columnWidth', async () => {
    localStorage.clear()
    const onPatchView = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: bundle(), canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView, onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    const grip = view.container.querySelector(`[role="separator"][aria-label="${t('project.view.resize_column')}"]`) as HTMLButtonElement
    expect(grip).not.toBeNull()
    await act(async () => { grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
    expect(onPatchView).toHaveBeenCalledWith('v1', { fields: { columnWidths: { ps: 176 } } })
  })
})

describe('hidden card count (C-18)', () => {
  it('reports how many cards the active filter hides', async () => {
    const base = bundle()
    base.views = [{ ...base.views[0]!, fields: { ...emptyProjectViewFields(), filter: { operation: 'and', filters: [{ propertyId: 'pt', condition: 'contains', values: ['hello'] }] } } }]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    const status = view.container.querySelector('[role="status"]')
    expect(status?.textContent).toBe(t('project.view.hidden_count', { count: 2 }))
  })

  it('shows no hint when nothing is filtered out', async () => {
    await mount()
    expect(view.container.querySelector('[role="status"]')).toBeNull()
  })
})

describe('last opened view memory (E-13)', () => {
  afterEach(() => { localStorage.clear() })

  it('restores the remembered view and persists a new selection', async () => {
    localStorage.setItem('inkstone.project.lastView.b1', 'v2')
    await mount()
    const tabs = [...view.container.querySelectorAll('[role="tab"]')]
    expect(tabs.find((tab) => tab.textContent === 'Board')?.getAttribute('aria-selected')).toBe('true')
    const tableTab = tabs.find((tab) => tab.textContent === 'Table')!
    await act(async () => { tableTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    expect(localStorage.getItem('inkstone.project.lastView.b1')).toBe('v1')
  })
})

describe('view tab order (C-23)', () => {
  it('sorts tabs alphabetically with leading emoji stripped', async () => {
    const base = bundle()
    base.views = [
      { ...base.views[0]!, id: 'vz', title: '🗺️ Zebra' },
      { ...base.views[1]!, id: 'va', title: 'Apple' },
    ]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    const labels = [...view.container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
    expect(labels).toEqual(['Apple', '🗺️ Zebra'])
  })
})

describe('view search (C-12)', () => {
  it('narrows rows by title and by property display text', async () => {
    await mount()
    const input = view.container.querySelector(`input[aria-label="${t('project.view.search')}"]`) as HTMLInputElement
    expect(input).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'open')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const rows = [...view.container.querySelectorAll('tbody tr[data-project-card]')]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('Alpha')
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(t('project.view.hidden_count', { count: 2 }))
  })
})

describe('view actions menu (C-1/C-15)', () => {
  async function openMenu(): Promise<void> {
    const anchor = view.container.querySelector(`button[aria-label="${t('project.view.menu')}"]`) as HTMLButtonElement
    expect(anchor).not.toBeNull()
    await act(async () => { anchor.click() })
  }
  function item(label: string): HTMLButtonElement {
    const entry = [...document.body.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent === label) as HTMLButtonElement
    expect(entry).not.toBeNull()
    return entry
  }

  it('duplicates and deletes the active view through the host', async () => {
    const onDeleteView = vi.fn()
    const onDuplicateView = vi.fn()
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: bundle(), canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView, onDuplicateView, onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    await openMenu()
    await act(async () => { item(t('project.view.duplicate')).click() })
    expect(onDuplicateView).toHaveBeenCalledWith('v1')
    await openMenu()
    await act(async () => { item(t('project.view.delete')).click() })
    expect(onDeleteView).toHaveBeenCalledWith('v1')
  })

  it('offers CSV and archive exports', async () => {
    await mount()
    await openMenu()
    const labels = [...document.body.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent)
    expect(labels).toContain(t('project.view.export_csv'))
    expect(labels).toContain(t('project.view.export_archive'))
  })

  it('keeps the last view undeletable', async () => {
    const base = bundle()
    base.views = [base.views[0]!]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    await openMenu()
    expect(item(t('project.view.delete')).disabled).toBe(true)
  })
})

describe('display by and group by (C-13/C-6)', () => {
  it('offers the date property picker on a calendar view', async () => {
    const base = bundle()
    base.properties = [...base.properties, { id: 'pd', name: 'Due', type: 'date', options: [] }]
    base.views = [{ ...base.views[0]!, id: 'vc', viewType: 'calendar' }]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    expect(await menuLabels(t('project.view.display_by'))).toContain('Due')
  })

  it('groups by every groupable type, not only select and person', async () => {
    const base = bundle()
    base.properties = [...base.properties, { id: 'pn', name: 'Estimate', type: 'number', options: [] }]
    base.views = [{ ...base.views[1]!, id: 'vb' }]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    expect(await menuLabels(t('project.view.group_by'))).toContain('Estimate')
  })
})

describe('subtask hierarchy in views', () => {
  it('hides subtasks from flat root table rows and reveals them on expand', async () => {
    const b = bundle()
    b.cards = [
      { id: 'c1', boardId: 'b1', parentId: '', title: 'Parent Card', icon: '', isTemplate: false, contentOrder: [], values: {}, ...stamps },
      { id: 'c2', boardId: 'b1', parentId: 'c1', title: 'Child Card', icon: '', isTemplate: false, contentOrder: [], values: {}, ...stamps },
    ]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: b, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    expect(view.container.querySelectorAll('tbody tr[data-project-card]')).toHaveLength(1)
    expect(view.container.textContent).toContain('Parent Card')
    expect(view.container.textContent).not.toContain('Child Card')

    const expandBtn = view.container.querySelector(`button[aria-label="${t('project.card.expand_subtasks')}"]`) as HTMLButtonElement
    expect(expandBtn).not.toBeNull()
    await act(async () => {
      expandBtn.click()
    })

    expect(view.container.querySelectorAll('tbody tr[data-project-card]')).toHaveLength(2)
    expect(view.container.textContent).toContain('Child Card')
  })

  it('nests subtasks inside kanban parent cards with progress badge and expandable checklist', async () => {
    const b = bundle()
    b.cards = [
      { id: 'c1', boardId: 'b1', parentId: '', title: 'Parent Kanban', icon: '', isTemplate: false, contentOrder: [], values: { ps: 'o1' }, ...stamps },
      { id: 'c2', boardId: 'b1', parentId: 'c1', title: 'Subtask Kanban', icon: '', isTemplate: false, contentOrder: [], values: { ps: 'o1' }, ...stamps },
    ]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: b, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    const boardTab = [...view.container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === 'Board')
    await act(async () => { boardTab?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })

    const columns = [...view.container.querySelectorAll('section')]
    expect(columns[0]!.querySelectorAll('[data-project-card]')).toHaveLength(1)
    expect(columns[0]!.textContent).toContain('Parent Kanban')
    expect(columns[0]!.textContent).not.toContain('Subtask Kanban')

    const expandBtn = columns[0]!.querySelector(`button[aria-label="${t('project.card.expand_subtasks')}"]`) as HTMLButtonElement
    expect(expandBtn).not.toBeNull()
    await act(async () => {
      expandBtn.click()
    })
    expect(columns[0]!.textContent).toContain('Subtask Kanban')
  })

  it('opens context menu on card right-click with action options', async () => {
    await mount()
    const cardEl = view.container.querySelector('[data-project-card="c1"]')!
    const contextEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 150,
      clientY: 150,
    })
    await act(async () => { cardEl.dispatchEvent(contextEvent) })
    const items = [...document.body.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '')
    expect(items.some((item) => item.includes(t('project.card.open')))).toBe(true)
    expect(items.some((item) => item.includes(t('project.card.mark_done')))).toBe(true)
    expect(items.some((item) => item.includes(t('project.card.add_subtask')))).toBe(true)
    expect(items.some((item) => item.includes(t('project.card.duplicate')))).toBe(true)
    expect(items.some((item) => item.includes(t('project.card.copy_link')))).toBe(true)
    expect(items.some((item) => item.includes(t('project.board.delete_card')))).toBe(true)
  })

  it('renders multi-select option tag chips with hierarchical slash support', async () => {
    const b = bundle()
    b.properties.push({
      id: 'ptags',
      name: 'Tags',
      type: 'multiSelect',
      options: [
        { id: 't1', value: 'feat/auth', color: 'propColorBlue' },
        { id: 't2', value: 'bug/critical', color: '#00ff00' },
      ],
    })
    b.views[0]!.fields.visiblePropertyIds.push('ptags')
    b.cards[0]!.values.ptags = JSON.stringify(['t1', 't2'])
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: b, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    expect(view.container.textContent).toContain('auth')
    expect(view.container.textContent).toContain('critical')
  })

  it('toggles subtask status using project Checkbox component in board view', async () => {
    const b = bundle()
    b.views = [
      { id: 'v2', boardId: 'b1', title: 'Board', viewType: 'board', fields: { ...emptyProjectViewFields(), groupById: 'ps' }, position: 0, ...stamps },
    ]
    const patchCard = vi.fn().mockResolvedValue(undefined)
    b.cards.push({
      id: 'sub1',
      boardId: 'b1',
      title: 'Subtask 1',
      icon: '',
      parentId: 'c1',
      isTemplate: false,
      contentOrder: [],
      values: {},
      ...stamps,
    })
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: b, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: patchCard, onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    const expandBtn = view.container.querySelector(`button[aria-label="${t('project.card.expand_subtasks')}"]`) as HTMLButtonElement
    expect(expandBtn).not.toBeNull()
    await act(async () => { expandBtn.click() })

    const checkbox = view.container.querySelector('button[role="checkbox"]') as HTMLButtonElement
    expect(checkbox).not.toBeNull()
    await act(async () => { checkbox.click() })
    expect(patchCard).toHaveBeenCalledWith('sub1', expect.anything())
  })

  it('renders subtasks with checkboxes and context menus in list view', async () => {
    const b = bundle()
    b.views = [
      { id: 'v_list', boardId: 'b1', title: 'List', viewType: 'list', fields: { ...emptyProjectViewFields(), groupById: '' }, position: 0, ...stamps },
    ]
    b.cards.push({
      id: 'sub_list',
      boardId: 'b1',
      title: 'Nested list subtask',
      icon: '',
      parentId: 'c1',
      isTemplate: false,
      contentOrder: [],
      values: {},
      ...stamps,
    })
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: b, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })

    expect(view.container.textContent).toContain('Alpha')
    const expandBtn = view.container.querySelector('button[aria-label="' + t('project.card.expand_subtasks') + '"]') as HTMLButtonElement
    expect(expandBtn).not.toBeNull()
    await act(async () => { expandBtn.click() })
    expect(view.container.textContent).toContain('Nested list subtask')
  })

  it('opens context menu on card right-click in gallery view', async () => {
    const b = bundle()
    b.views = [
      { id: 'v_gallery', boardId: 'b1', title: 'Gallery', viewType: 'gallery', fields: { ...emptyProjectViewFields(), groupById: '' }, position: 0, ...stamps },
    ]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: b, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })

    const cardEl = view.container.querySelector('[data-project-card="c1"]')!
    expect(cardEl).not.toBeNull()
    const contextEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 120,
    })
    await act(async () => { cardEl.dispatchEvent(contextEvent) })
    const items = [...document.body.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '')
    expect(items.some((item) => item.includes(t('project.card.open')))).toBe(true)
  })
})
describe('calculation labels (R3-14)', () => {
  it('names the summaries in the interface language rather than the raw identifier', async () => {
    localStorage.clear()
    await mount()
    const options = await menuLabels('Status')
    expect(options).toContain(t('project.calc.percentempty'))
    expect(options).not.toContain('percentEmpty')
    expect(options).not.toContain('countUniqueValue')
  })
})

describe('the board card face (R3-19)', () => {
  async function mountBoardWith(extra: Partial<ProjectBoardBundle>): Promise<void> {
    const base = { ...bundle(), ...extra }
    base.views = [{ id: 'v2', boardId: 'b1', title: 'Board', viewType: 'board', fields: { ...emptyProjectViewFields(), groupById: 'ps' }, position: 0, ...stamps }]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
  }

  it('repeats the card set properties as chips but not the one the column already names', async () => {
    const base = bundle()
    base.properties = [...base.properties, { id: 'pd', name: 'Due', type: 'date', options: [] }]
    base.cards = [{ id: 'c1', boardId: 'b1', parentId: '', title: 'Alpha', icon: '', isTemplate: false, contentOrder: [], values: { ps: 'o1', pt: 'a note', pd: JSON.stringify({ from: projectDayToStamp(new Date(2020, 0, 2)) }) }, ...stamps }]
    await mountBoardWith(base)
    const chips = view.container.querySelector('[data-card-properties="c1"]')
    expect(chips, 'the card wears no property row').not.toBeNull()
    expect(chips!.textContent).toContain('a note')
    expect(chips!.textContent).not.toContain('Open')
    expect(chips!.querySelector('[title="Due"]')?.className).toContain('danger')
  })

  it('draws no property row when the card has no values beyond its column', async () => {
    const base = bundle()
    base.cards = [{ id: 'c1', boardId: 'b1', parentId: '', title: 'Alpha', icon: '', isTemplate: false, contentOrder: [], values: { ps: 'o1' }, ...stamps }]
    await mountBoardWith(base)
    expect(view.container.querySelector('[data-card-properties="c1"]')).toBeNull()
  })

  it('files a card into the column it was typed under', async () => {
    const create = vi.spyOn(api, 'createProjectCard').mockResolvedValue({ id: 'cnew', boardId: 'b1', parentId: '', title: 'Fresh', icon: '', isTemplate: false, contentOrder: [], values: {}, ...stamps })
    const base = bundle()
    base.cards = []
    await mountBoardWith(base)
    const adders = [...view.container.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === t('project.board.new_card'))
    expect(adders.length).toBeGreaterThan(0)
    await act(async () => { adders[1]!.click() })
    const field = view.container.querySelector<HTMLInputElement>(`input[aria-label="${t('project.board.new_card')}"]`)
    expect(field, 'the column never opened an input').not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(field!, 'Fresh'); field!.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { field!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(create).toHaveBeenCalledWith('b1', { title: 'Fresh', values: { ps: 'o2' } })
    create.mockRestore()
  })
})

describe('the table row furniture (R3-20)', () => {
  it('numbers the rows and selects every card from the header checkbox', async () => {
    localStorage.clear()
    await mount()
    const numbers = [...view.container.querySelectorAll('tbody tr[data-project-card] td:nth-child(2) span.tabular')].map((node) => node.textContent)
    expect(numbers).toEqual(['1', '2', '3'])
    const all = view.container.querySelector<HTMLButtonElement>(`thead [role="checkbox"][aria-label="${t('project.view.select_all')}"]`)
    expect(all, 'no select-all affordance').not.toBeNull()
    await act(async () => { all!.click() })
    expect(view.container.querySelector('[role="toolbar"]')?.textContent).toContain(t('project.view.selected_count', { count: 3 }))
  })

  it('files a card from the footer add row', async () => {
    localStorage.clear()
    const create = vi.spyOn(api, 'createProjectCard').mockResolvedValue({ id: 'cnew', boardId: 'b1', parentId: '', title: 'Row', icon: '', isTemplate: false, contentOrder: [], values: {}, ...stamps })
    await mount()
    const add = [...view.container.querySelectorAll<HTMLButtonElement>('tfoot, tbody')].flatMap((node) => [...node.querySelectorAll<HTMLButtonElement>('button')]).find((button) => button.textContent === t('project.view.add_row'))
    expect(add, 'no footer add row').toBeDefined()
    await act(async () => { add!.click() })
    const field = view.container.querySelector<HTMLInputElement>(`input[aria-label="${t('project.view.add_row')}"]`)
    expect(field).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(field!, 'Row'); field!.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { field!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(create).toHaveBeenCalledWith('b1', { title: 'Row', values: {} })
    create.mockRestore()
  })
})

describe('the table row budget (R3-16a)', () => {
  it('draws a page at a time and reveals the rest on request', async () => {
    localStorage.clear()
    const base = bundle()
    base.cards = Array.from({ length: 260 }, (_, index) => ({ id: `c${index}`, boardId: 'b1', parentId: '', title: `Card ${index}`, icon: '', isTemplate: false, contentOrder: [], values: {}, ...stamps }))
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    expect(view.container.querySelectorAll('tbody tr[data-project-card]')).toHaveLength(200)
    const more = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === t('project.view.show_more', { count: 60 }))
    expect(more, 'no way to reach the remaining rows').toBeDefined()
    await act(async () => { more!.click() })
    expect(view.container.querySelectorAll('tbody tr[data-project-card]')).toHaveLength(260)
  })
})

describe('the column header stays readable (R4-1)', () => {
  async function mountColoured(): Promise<void> {
    const base = bundle()
    base.properties = base.properties.map((p) => (p.id === 'ps' ? { ...p, options: p.options.map((o) => (o.id === 'o1' ? { ...o, color: 'propColorRed' } : o)) } : p))
    base.views = [{ id: 'v2', boardId: 'b1', title: 'Board', viewType: 'board', fields: { ...emptyProjectViewFields(), groupById: 'ps' }, position: 0, ...stamps }]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
  }

  it('keeps no laid-out-but-invisible control in the title row', async () => {
    await mountColoured()
    const header = view.container.querySelector('section[aria-label="Open"] header')!
    expect(header.querySelector('input')).toBeNull()
    expect(header.querySelector(`button[aria-label="Open ${t('project.view.menu')}"]`)).not.toBeNull()
    expect([...header.querySelectorAll('*')].some((node) => (node.getAttribute('class') ?? '').includes('opacity-0'))).toBe(false)
    const title = header.querySelector('button.pv-col-name')!
    expect(title.className).toContain('pv-col-name')
    expect(title.textContent).toBe('Open')
  })

  it('tints the column with the colour picked for its option', async () => {
    await mountColoured()
    const open = view.container.querySelector<HTMLElement>('section[aria-label="Open"]')!
    expect(open.getAttribute('style')).toContain('--pv-col-color')
    expect(open.getAttribute('style')).toContain('--kanban-tag-red-fg')
    expect(open.querySelector('.pv-col-band')).not.toBeNull()
    const done = view.container.querySelector<HTMLElement>('section[aria-label="Done"]')!
    expect(done.getAttribute('style') ?? '').not.toContain('--kanban-tag-red-fg')
  })

  it('moves the summary choice into the menu and writes it back', async () => {
    const onPatch = vi.fn<(id: string, patch: ProjectViewPatch) => Promise<void>>().mockResolvedValue(undefined)
    const base = bundle()
    base.views = [{ id: 'v2', boardId: 'b1', title: 'Board', viewType: 'board', fields: { ...emptyProjectViewFields(), groupById: 'ps' }, position: 0, ...stamps }]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: onPatch, onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    const menu = view.container.querySelector<HTMLButtonElement>(`button[aria-label="Open ${t('project.view.menu')}"]`)!
    await act(async () => { menu.click() })
    const sum = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"], [role="menuitem"]')].find((row) => row.textContent === t('project.calc.countnotempty'))
    expect(sum, 'the summary choices are not in the menu').toBeDefined()
    await act(async () => { sum!.click() })
    expect(onPatch).toHaveBeenCalledWith('v2', { fields: { kanbanCalculations: { o1: { calculation: 'countNotEmpty', propertyId: 'ps' } } } })
  })
})
