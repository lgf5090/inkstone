import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectAttachment, ProjectCard, ProjectProperty } from '@shared/project/model'
import { projectDayToStamp } from '@shared/project/date'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { DashboardView } from './DashboardView'
import { CollectionView } from './CollectionView'
import * as api from '../api'

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  fetchBoardActivity: vi.fn().mockResolvedValue([]),
  listBoardFiles: vi.fn().mockResolvedValue([]),
}))

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, deleteAt: 0 }
const properties: ProjectProperty[] = [
  { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'open', value: 'Open', color: 'propColorBlue' }, { id: 'done', value: 'Done', color: 'propColorGreen' }] },
  { id: 'pp', name: 'Priority', type: 'select', options: [{ id: 'hi', value: 'High', color: 'propColorRed' }, { id: 'lo', value: 'Low', color: 'propColorGreen' }] },
  { id: 'pd', name: 'Due', type: 'date', options: [] },
  { id: 'pn', name: 'Hours', type: 'number', options: [] },
]

function card(id: string, values: Record<string, string> = {}, updateAt = Date.now()): ProjectCard {
  return { id, boardId: 'b1', parentId: '', title: id, icon: '', isTemplate: false, contentOrder: [], values, updateAt, ...stamps }
}

let view: RenderedElement
beforeEach(async () => { await initI18n() })
afterEach(() => { view?.unmount() })

async function mountDashboard(cards: ProjectCard[]): Promise<void> {
  await act(async () => {
    view = renderElement(createElement(DashboardView, { boardId: 'b1', cards, properties, onOpenCard: vi.fn() }))
  })
}

describe('the report panels the reference Stats view draws', () => {
  const soon = new Date()
  soon.setDate(soon.getDate() + 1)
  const cards = [
    card('done1', { ps: 'done', pp: 'hi', pn: '8' }),
    card('done2', { ps: 'done', pp: 'lo', pn: '4' }),
    card('soon', { ps: 'open', pp: 'hi', pn: '6', pd: JSON.stringify({ from: projectDayToStamp(soon) }) }),
  ]

  it('draws a completion ring with the done fraction', async () => {
    await mountDashboard(cards)
    const ring = view.container.querySelector('.pv-ring')!
    expect(ring).not.toBeNull()
    expect(ring.querySelector('.pv-ring-inner')?.textContent).toBe('67%')
    expect(ring.getAttribute('style')).toContain('conic-gradient')
  })

  it('draws one stacked status bar plus a row per option', async () => {
    await mountDashboard(cards)
    const segments = [...view.container.querySelectorAll('.pv-stack-seg')]
    expect(segments).toHaveLength(2)
    expect(view.container.querySelectorAll('.pv-meter')).toHaveLength(3)
  })

  it('buckets priorities high first and counts them', async () => {
    await mountDashboard(cards)
    const tiles = [...view.container.querySelectorAll('.pv-prio-tile')]
    expect(tiles.map((tile) => tile.textContent)).toEqual(['2High67%', '1Low33%'])
  })

  it('draws four weekly bars and puts this week\'s completions in the last one', async () => {
    await mountDashboard(cards)
    const weeks = [...view.container.querySelectorAll('.pv-week')]
    expect(weeks).toHaveLength(4)
    expect(weeks[3]!.textContent?.endsWith('2')).toBe(true)
  })

  it('sums and averages the numeric property and names the largest card', async () => {
    await mountDashboard(cards)
    const panel = view.container.querySelector(`[aria-label="${t('project.dashboard.effort', { name: 'Hours' })}"]`)!
    expect(panel.textContent).toContain('18')
    expect(panel.textContent).toContain('6.0')
    expect(panel.textContent).toContain('done1 — 8')
  })

  it('lists the next seven days without a click and names tomorrow', async () => {
    await mountDashboard(cards)
    const panel = view.container.querySelector(`[aria-label="${t('project.dashboard.due_soon')}"]`)!
    expect(panel.textContent).toContain('soon')
    expect(panel.textContent).toContain(t('project.dashboard.tomorrow'))
  })

  it('says so when nothing is due rather than drawing an empty list', async () => {
    await mountDashboard([card('a', { ps: 'open' })])
    expect(view.container.textContent).toContain(t('project.dashboard.nothing_due'))
  })
})

describe('the file preview pane', () => {
  const file: ProjectAttachment = {
    id: 'f1', userId: 'u1', boardId: 'b1', cardId: 'c1', filename: 'notes.txt', mime: 'text/plain',
    size: 12, storage: 'r2', objectKey: 'k', width: null, height: null, thumbnailKey: null, createdAt: 1, updatedAt: 1,
  }

  it('opens beside the shelf with the file text and a way back to its card', async () => {
    vi.mocked(api.listBoardFiles).mockResolvedValue([file])
    const original = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({ text: async () => 'hello preview' }) as unknown as typeof fetch
    const onOpenCard = vi.fn()
    try {
      await act(async () => { view = renderElement(createElement(CollectionView, { boardId: 'b1', canEdit: true, onOpenCard })) })
      expect(view.container.querySelector('[data-file-preview]')).toBeNull()
      await act(async () => { view.container.querySelector<HTMLButtonElement>('.pv-file-thumb')!.click() })
      const pane = view.container.querySelector('[data-file-preview="f1"]')!
      expect(pane).not.toBeNull()
      expect(pane.textContent).toContain('hello preview')
      const open = [...pane.querySelectorAll('button')].find((button) => button.textContent === t('project.card.open'))!
      await act(async () => { open.click() })
      expect(onOpenCard).toHaveBeenCalledWith('c1')
      const close = [...pane.querySelectorAll('button')].find((button) => button.textContent === t('common.close'))!
      await act(async () => { close.click() })
      expect(view.container.querySelector('[data-file-preview]')).toBeNull()
    } finally { globalThis.fetch = original }
  })
})