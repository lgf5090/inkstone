import { createElement } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../../../lib/i18n'
import { renderElement } from '../../../test-render'
import { useKanbanItemMutations } from './kanban-root-hooks'
import type { KanbanData, KanbanView } from '../types'
import type { CommitKanbanData } from './kanban-history'

beforeAll(async () => {
  await initI18n()
})

const view: KanbanView = { id: 'v', name: 'Board', type: 'board', groupBy: 'status' }

const baseData: KanbanData = {
  columns: [
    { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
    { id: 'labels', name: 'Labels', type: 'multi-select', options: [{ id: 'bug', label: 'Bug', color: 'red' }] },
    { id: 'tags', name: 'Tags', type: 'multi-select', options: [{ id: 'bug', label: 'Bug', color: 'red' }] },
  ],
  items: [{ id: 'a', title: 'A', properties: { status: 'todo' } }],
  views: [view],
}

type Mutations = ReturnType<typeof useKanbanItemMutations>

function renderMutations(data: KanbanData): { api: Mutations; commits: KanbanData[] } {
  let api: Mutations | null = null
  const commits: KanbanData[] = []
  const commitData: CommitKanbanData = (next) => {
    commits.push(typeof next === 'function' ? next(data) : next)
  }
  function Probe() {
    api = useKanbanItemMutations(commitData, view, vi.fn())
    return null
  }
  renderElement(createElement(Probe)).unmount()
  if (!api) throw new Error('probe did not expose the hook api')
  return { api, commits }
}

describe('useKanbanItemMutations multi-select writes', () => {
  it('writes the values onto the named property and appends the new option to that column', () => {
    const { api, commits } = renderMutations(baseData)
    api.handleUpdateMultiSelect('a', 'labels', ['bug', 'urgent'], {
      id: 'urgent',
      label: 'Urgent',
      color: 'blue',
    })
    const committed = commits[0]!
    expect(committed.items[0]!.properties.labels).toEqual(['bug', 'urgent'])
    expect(committed.items[0]!.properties.tags).toBeUndefined()
    expect(committed.columns.find((col) => col.id === 'labels')!.options?.map((opt) => opt.id)).toEqual([
      'bug',
      'urgent',
    ])
    expect(committed.columns.find((col) => col.id === 'tags')!.options!.map((opt) => opt.id)).toEqual(['bug'])
  })

  it('leaves the column list untouched when no new option arrives', () => {
    const { api, commits } = renderMutations(baseData)
    api.handleUpdateMultiSelect('a', 'labels', ['bug'])
    expect(commits[0]!.columns).toBe(baseData.columns)
    expect(commits[0]!.items[0]!.properties.labels).toEqual(['bug'])
  })

  it('keeps the board tag writer pointed at the tags property', () => {
    const { api, commits } = renderMutations(baseData)
    api.handleUpdateTags('a', ['bug'])
    expect(commits[0]!.items[0]!.properties.tags).toEqual(['bug'])
  })
})

describe('useKanbanItemMutations item-level writers', () => {
  it('stores attachments on the item rather than inside properties', () => {
    const { api, commits } = renderMutations(baseData)
    const file = { id: 'f-1', name: 'a.txt', size: 1, mime: 'text/plain', url: '/api/kanban/file/x/a.txt' }
    api.handleUpdateFiles('a', [file])
    expect(commits[0]!.items[0]!.files).toEqual([file])
    expect(commits[0]!.items[0]!.properties.files).toBeUndefined()
  })
})
