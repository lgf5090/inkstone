import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardBundle, ProjectViewFields, ProjectViewPatch, ProjectViewType } from '@shared/project/model'
import { emptyProjectViewFields, PROJECT_VIEW_TYPES } from '@shared/project/model'
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
    view = renderElement(createElement(BoardViews, { bundle: bundle(), canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
  })
}
beforeEach(async () => { await initI18n() })
afterEach(() => { view?.unmount() })

describe('the table view', () => {
  it('renders a column per property and a row per card with display values', async () => {
    await mount()
    const headers = [...view.container.querySelectorAll('thead th')].map((th) => th.textContent)
    expect(headers).toContain('Status')
    expect(headers).toContain('Notes')
    const rows = [...view.container.querySelectorAll('tbody tr')]
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
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
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
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn().mockResolvedValue(undefined), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    expect(view.container.querySelector('[role="tab"]')!.textContent).toBe(t('project.view.table'))
  })

  it('keeps a user-typed view title verbatim', async () => {
    const base = bundle()
    base.views = [{ ...base.views[0]!, title: '我的视图' }]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn().mockResolvedValue(undefined), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    expect(view.container.querySelector('[role="tab"]')!.textContent).toBe('我的视图')
  })
})

describe('board column hide and cross-column drag (C-2)', () => {
  async function mountBoard(onPatch: ReturnType<typeof vi.fn<(id: string, patch: ProjectViewPatch) => Promise<void>>>, onPatchCard: ReturnType<typeof vi.fn<(id: string, patch: Record<string, unknown>) => Promise<void>>>) {
    const base = bundle()
    base.views = [base.views[1]!]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: onPatch, onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard, onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
  }

  it('hide column persists hiddenOptionIds', async () => {
    const onPatch = vi.fn<(id: string, patch: ProjectViewPatch) => Promise<void>>().mockResolvedValue(undefined)
    await mountBoard(onPatch, vi.fn<(id: string, patch: Record<string, unknown>) => Promise<void>>().mockResolvedValue(undefined))
    const hide = view.container.querySelector(`button[aria-label="${t('project.view.hide_column')}"]`) as HTMLButtonElement
    expect(hide).not.toBeNull()
    await act(async () => { hide.click() })
    expect(onPatch).toHaveBeenCalledWith('v2', { fields: { hiddenOptionIds: ['o1'] } })
  })

  it('dropping a card on a column patches its group value', async () => {
    const onPatchCard = vi.fn<(id: string, patch: Record<string, unknown>) => Promise<void>>().mockResolvedValue(undefined)
    await mountBoard(vi.fn<(id: string, patch: ProjectViewPatch) => Promise<void>>().mockResolvedValue(undefined), onPatchCard)
    const column = view.container.querySelector('section[aria-label="Done"]')!
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { getData: () => 'c1' } })
    await act(async () => { column.dispatchEvent(event) })
    expect(onPatchCard).toHaveBeenCalledWith('c1', { values: { ps: 'o2' } })
  })
})

describe('table group rows, collapse, inline edit, column reorder (C-3/C-22)', () => {
  async function mountTable(fields: Partial<ProjectViewFields>, onPatchView: (id: string, patch: ProjectViewPatch) => Promise<void>, onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>) {
    const base = bundle()
    base.views = [{ ...base.views[0]!, fields: { ...emptyProjectViewFields(), ...fields } }]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView, onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard, onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
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
    const cell = view.container.querySelector('[data-project-card="c1"] td:nth-child(2) button') as HTMLButtonElement
    await act(async () => { cell.click() })
    const select = view.container.querySelector('[data-project-card="c1"] select') as HTMLSelectElement
    expect(select).not.toBeNull()
    await act(async () => { select.value = 'o2'; select.dispatchEvent(new Event('change', { bubbles: true })) })
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
      view = renderElement(createElement(BoardViews, { bundle: bundle(), canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn().mockResolvedValue(undefined), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh }))
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

describe('select option color chip (R2-6)', () => {
  it('renders a colored chip for a select value with a color', async () => {
    localStorage.clear()
    const base = bundle()
    base.properties = base.properties.map((p) => (p.id === 'ps' ? { ...p, options: p.options.map((o) => (o.id === 'o1' ? { ...o, color: '#ff0000' } : o)) } : p))
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn().mockResolvedValue(undefined), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    const chip = view.container.querySelector('[data-project-card="c1"] td span[style]') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.getAttribute('style')).toContain('background-color')
    expect(chip.textContent).toBe('Open')
  })
})

describe('column resize grip (C-17)', () => {
  it('ArrowRight on the grip persists a wider columnWidth', async () => {
    localStorage.clear()
    const onPatchView = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: bundle(), canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView, onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
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
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
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
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
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
    const rows = [...view.container.querySelectorAll('tbody tr')]
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
      view = renderElement(createElement(BoardViews, { bundle: bundle(), canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView, onDuplicateView, onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
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
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
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
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    const select = view.container.querySelector(`select[aria-label="${t('project.view.display_by')}"]`) as HTMLSelectElement
    expect(select).not.toBeNull()
    expect([...select.options].map((option) => option.textContent)).toContain('Due')
  })

  it('groups by every groupable type, not only select and person', async () => {
    const base = bundle()
    base.properties = [...base.properties, { id: 'pn', name: 'Estimate', type: 'number', options: [] }]
    base.views = [{ ...base.views[1]!, id: 'vb' }]
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) }))
    })
    const select = view.container.querySelector(`select[aria-label="${t('project.view.group_by')}"]`) as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toContain('Estimate')
  })
})