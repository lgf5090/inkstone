import { act, createElement } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../../../lib/i18n'
import { renderElement } from '../../../test-render'
import { useKanbanItemLifecycle } from './kanban-root-hooks'
import { KanbanItemDetail } from './kanban-item-detail'
import type { KanbanData, KanbanItem, KanbanView } from '../types'

beforeAll(async () => {
  await initI18n()
})

const boardView: KanbanView = { id: 'v', name: 'Board', type: 'board', groupBy: 'status' }

function parentItem(overrides: Partial<KanbanItem> = {}): KanbanItem {
  return {
    id: 'p1',
    title: 'Parent',
    properties: { status: 'doing' },
    subtasks: [
      { id: 's1', title: 'Draft outline', completed: false, description: 'with notes', dueDate: '2026-09-20', tags: ['doc'] },
      { id: 's2', title: 'Review', completed: true, status: 'todo' },
    ],
    ...overrides,
  }
}

function makeData(items: KanbanItem[]): KanbanData {
  return {
    columns: [
      { id: 'status', name: 'Status', type: 'select', options: [
        { id: 'todo', label: 'To Do', color: 'gray' },
        { id: 'doing', label: 'Doing', color: 'blue' },
      ] },
    ],
    items,
    views: [boardView],
  }
}

type MutationsApi = ReturnType<typeof useKanbanItemLifecycle>

function renderMutationsHook(data: KanbanData, detailItem: KanbanItem | null): {
  api: MutationsApi
  commits: KanbanData[]
  setDetailItem: ReturnType<typeof vi.fn>
} {
  let api: MutationsApi | null = null
  const commits: KanbanData[] = []
  const setDetailItem = vi.fn()
  function Probe() {
    api = useKanbanItemLifecycle(
      data,
      // mirrors useKanbanHistory: functional updaters resolve against the latest data
      (nextOrUpdater) => {
        const next = typeof nextOrUpdater === 'function' ? nextOrUpdater(commits.at(-1) ?? data) : nextOrUpdater
        commits.push(next)
      },
      detailItem,
      setDetailItem,
      () => {},
    )
    return null
  }
  const rendered = renderElement(createElement(Probe))
  rendered.unmount()
  if (!api) throw new Error('probe did not expose the hook api')
  return { api, commits, setDetailItem }
}

describe('useKanbanItemMutations convert subtask to item', () => {
  it('promotes the subtask to a top-level card right after its parent', () => {
    const data = makeData([parentItem()])
    const { api, commits } = renderMutationsHook(data, null)
    api.handleConvertSubtaskToItem('p1', 's1')
    const items = commits[0]!.items
    expect(items.map((i) => i.id)).toEqual(['p1', expect.any(String)])
    expect(items[1]!.title).toBe('Draft outline')
    expect(items[0]!.subtasks?.map((s) => s.id)).toEqual(['s2'])
  })

  it('carries the subtask description, dates, tags and the parent status over to the new card', () => {
    const data = makeData([parentItem()])
    const { api, commits } = renderMutationsHook(data, null)
    api.handleConvertSubtaskToItem('p1', 's1')
    const converted = commits[0]!.items[1]!
    expect(converted.content).toBe('with notes')
    expect(converted.description).toBe('with notes')
    expect(converted.properties).toMatchObject({ status: 'doing', dueDate: '2026-09-20', tags: ['doc'] })
  })

  it('prefers the subtask own status over the parent status', () => {
    const data = makeData([parentItem()])
    const { api, commits } = renderMutationsHook(data, null)
    api.handleConvertSubtaskToItem('p1', 's2')
    expect(commits[0]!.items[1]!.properties.status).toBe('todo')
  })

  it('keeps the committed detail item free of the converted subtask', () => {
    const detail = parentItem()
    const data = makeData([detail])
    const { api, setDetailItem } = renderMutationsHook(data, detail)
    api.handleConvertSubtaskToItem('p1', 's1')
    const updated = setDetailItem.mock.calls.at(-1)![0] as KanbanItem
    expect(updated.subtasks?.map((s) => s.id)).toEqual(['s2'])
  })

  it('commits nothing when the item or subtask does not exist', () => {
    const data = makeData([parentItem()])
    const { api, commits } = renderMutationsHook(data, null)
    api.handleConvertSubtaskToItem('missing', 's1')
    api.handleConvertSubtaskToItem('p1', 'missing')
    expect(commits).toHaveLength(0)
  })
})

describe('KanbanItemDetail convert wiring', () => {
  function mountDetail(onConvertSubtask: (subtaskId: string) => void) {
    const rendered = renderElement(
      createElement(KanbanItemDetail, {
        item: parentItem(),
        columns: makeData([]).columns,
        onClose: vi.fn(),
        onUpdate: vi.fn(),
        onDelete: vi.fn(),
        onConvertSubtask,
      }),
    )
    // the detail modal portals onto document.body, so query the whole document
    const menuTrigger = [...document.querySelectorAll('button')].find(
      (b) => b.querySelector('svg.lucide-ellipsis'),
    )!
    expect(menuTrigger).toBeTruthy()
    act(() => { menuTrigger.click() })
    const items = [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
    return { rendered, items }
  }

  it('asks the host to convert the subtask when the menu item is used', () => {
    const onConvertSubtask = vi.fn()
    const { rendered, items } = mountDetail(onConvertSubtask)
    const convert = items.find((b) => b.textContent === 'Convert to item')!
    expect(convert).toBeTruthy()
    act(() => { convert.click() })
    expect(onConvertSubtask).toHaveBeenCalledWith('s1')
    rendered.unmount()
  })

  it('never shows an Open subitem entry', () => {
    const { rendered, items } = mountDetail(vi.fn())
    expect(items.map((b) => b.textContent)).not.toContain('Open subitem')
    rendered.unmount()
  })
})
