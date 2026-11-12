import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCard, ProjectProperty } from '@shared/project/model'
import { projectDayToStamp, projectStampToInput } from '@shared/project/date'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { buildCardMenu, optionColorItems } from './card-menu'
import { Menu, prompt } from '../../components/overlay'

vi.mock('../../components/overlay', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../components/overlay')>(),
  prompt: vi.fn(),
}))

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const properties: ProjectProperty[] = [
  { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'open', value: 'Open', color: '' }, { id: 'done', value: 'Done', color: '' }] },
  { id: 'pp', name: 'Priority', type: 'select', options: [{ id: 'hi', value: 'High', color: 'propColorRed' }, { id: 'lo', value: 'Low', color: '' }] },
  { id: 'pd', name: 'Due', type: 'date', options: [] },
]

function card(values: Record<string, string> = {}): ProjectCard {
  return { id: 'c1', boardId: 'b1', parentId: '', title: 'Alpha', icon: '', isTemplate: false, contentOrder: [], values, ...stamps }
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    card: card({ ps: 'open' }),
    properties,
    groupById: 'ps',
    canEdit: true,
    publicView: false,
    starred: false,
    pinned: false,
    onOpen: vi.fn(),
    onPatchCard: vi.fn().mockResolvedValue(undefined),
    onAddSubtask: vi.fn().mockResolvedValue(undefined),
    onDuplicate: vi.fn(),
    onCopyLink: vi.fn(),
    onDelete: vi.fn(),
    onToggleDone: vi.fn().mockResolvedValue(undefined),
    onToggleStar: vi.fn(),
    onTogglePin: vi.fn(),
    moveTargets: [],
    onMove: vi.fn(),
    ...overrides,
  }
}

const byId = (items: ReturnType<typeof buildCardMenu>, id: string) => items.find((item) => item.id === id)!

describe('the card menu', () => {
  it('offers rename, the three setters and the destructive action last', () => {
    const items = buildCardMenu(context())
    expect(items.map((item) => item.id)).toEqual([
      'open', 'rename', 'toggle-done', 'star', 'pin',
      'set-group', 'set-priority', 'set-date',
      'add-subtask', 'duplicate', 'copy-link', 'delete',
    ])
    expect(items[items.length - 1]!.tone).toBe('danger')
    expect(items[items.length - 1]!.separatorBefore).toBe(true)
  })

  it('offers a move-to-board submenu naming the editable boards', () => {
    const onMove = vi.fn()
    const items = buildCardMenu(context({ moveTargets: [{ id: 'b2', title: 'Target' }, { id: 'b3', title: '' }], onMove }))
    const move = byId(items, 'move')
    expect(move.subItems?.map((entry) => entry.label)).toEqual(['Target', t('project.boards.untitled')])
    move.subItems![0]!.onSelect!()
    expect(onMove).toHaveBeenCalledWith('c1', 'b2')
  })

  it('hides move when there is no other editable board', () => {
    expect(buildCardMenu(context()).some((item) => item.id === 'move')).toBe(false)
  })

  it('renames through the prompt and skips a blank or unchanged name', async () => {
    const ctx = context()
    vi.mocked(prompt).mockResolvedValue('  Beta  ')
    await act(async () => { byId(buildCardMenu(ctx), 'rename').onSelect!() })
    expect(ctx.onPatchCard).toHaveBeenCalledWith('c1', { title: 'Beta' })
    ctx.onPatchCard.mockClear()
    vi.mocked(prompt).mockResolvedValue('Alpha')
    await act(async () => { byId(buildCardMenu(ctx), 'rename').onSelect!() })
    expect(ctx.onPatchCard).not.toHaveBeenCalled()
    vi.mocked(prompt).mockResolvedValue(null)
    await act(async () => { byId(buildCardMenu(ctx), 'rename').onSelect!() })
    expect(ctx.onPatchCard).not.toHaveBeenCalled()
  })

  it('flips the star and pin labels with the current state', () => {
    const plain = buildCardMenu(context())
    expect(byId(plain, 'star').label).toBe(t('project.card.favorite'))
    expect(byId(plain, 'pin').label).toBe(t('project.card.pin'))
    const markedCtx = context({ starred: true, pinned: true })
    const marked = buildCardMenu(markedCtx)
    expect(byId(marked, 'star').label).toBe(t('project.card.unfavorite'))
    expect(byId(marked, 'pin').label).toBe(t('project.card.unpin'))
    byId(marked, 'star').onSelect!()
    expect(markedCtx.onToggleStar).toHaveBeenCalledWith('c1')
  })

  it('sets a status from the submenu and can clear it', () => {
    const ctx = context()
    const sub = byId(buildCardMenu(ctx), 'set-group').subItems!
    expect(sub.map((item) => item.label)).toEqual(['Open', 'Done', t('project.view.no_value')])
    expect(sub[0]!.checked).toBe(true)
    sub[1]!.onSelect!()
    expect(ctx.onPatchCard).toHaveBeenCalledWith('c1', { values: { ps: 'done' } })
    sub[2]!.onSelect!()
    expect(ctx.onPatchCard).toHaveBeenCalledWith('c1', { values: { ps: null } })
  })

  it('offers priority only when it is a different property from the grouping', () => {
    expect(byId(buildCardMenu(context()), 'set-priority').subItems!.map((item) => item.label)).toEqual(['High', 'Low', t('project.view.no_value')])
    const groupedByPriority = buildCardMenu(context({ groupById: 'pp' }))
    expect(groupedByPriority.some((item) => item.id === 'set-priority')).toBe(false)
  })

  it('writes today, tomorrow, next Monday and a clear through the shared day conversion', () => {
    const ctx = context()
    const sub = byId(buildCardMenu(ctx), 'set-date').subItems!
    const written = (): string => {
      const call = ctx.onPatchCard.mock.calls.at(-1)!
      const raw = (call[1] as { values: Record<string, string | null> }).values.pd
      return raw === null ? 'null' : projectStampToInput((JSON.parse(raw) as { from: number }).from)
    }
    const iso = (day: Date): string => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    sub[0]!.onSelect!()
    expect(written()).toBe(iso(new Date()))
    sub[1]!.onSelect!()
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1)
    expect(written()).toBe(iso(tomorrow))
    sub[2]!.onSelect!()
    const monday = new Date(written())
    expect(monday.getDay()).toBe(1)
    expect(monday.getTime()).toBeGreaterThan(Date.now() - 86_400_000)
    sub[3]!.onSelect!()
    expect(written()).toBe('null')
  })

  it('keeps the stored day on the calendar day it was picked', () => {
    const ctx = context()
    byId(buildCardMenu(ctx), 'set-date').subItems![0]!.onSelect!()
    const raw = (ctx.onPatchCard.mock.calls[0]![1] as { values: Record<string, string> }).values.pd
    const stored = (JSON.parse(raw) as { from: number }).from
    expect(stored).toBe(projectDayToStamp(new Date()))
  })

  it('disables every write for a viewer and the link for a public reader', () => {
    const items = buildCardMenu(context({ canEdit: false, publicView: true }))
    for (const id of ['rename', 'toggle-done', 'set-group', 'set-priority', 'set-date', 'add-subtask', 'duplicate', 'delete']) {
      expect(byId(items, id).disabled, id).toBe(true)
    }
    expect(byId(items, 'copy-link').disabled).toBe(true)
    expect(byId(items, 'open').disabled).toBeFalsy()
    expect(byId(items, 'star').disabled).toBeFalsy()
  })

  it('drops the setters a board has no property for', () => {
    const items = buildCardMenu(context({ properties: [properties[0]!] }))
    expect(items.some((item) => item.id === 'set-priority')).toBe(false)
    expect(items.some((item) => item.id === 'set-date')).toBe(false)
  })
})

describe('the colour submenu', () => {
  it('marks the current colour and reports the picked one', () => {
    const picked: string[] = []
    const items = optionColorItems(['', 'propColorRed', 'propColorBlue'], 'propColorRed', (color) => picked.push(color))
    expect(items.map((item) => item.checked)).toEqual([false, true, false])
    items[2]!.onSelect!()
    expect(picked).toEqual(['propColorBlue'])
  })
})

let view: RenderedElement
beforeEach(async () => { await initI18n() })
afterEach(() => { view?.unmount() })

describe('the menu as rendered', () => {
  it('puts every action in the accessibility tree', async () => {
    const items = buildCardMenu(context())
    await act(async () => { view = renderElement(createElement(Menu, { anchor: { x: 10, y: 10 }, open: true, onClose: vi.fn(), items })) })
    const rows = [...document.querySelectorAll('[role^="menuitem"]')].map((node) => node.textContent)
    expect(rows).toContain(t('project.card.rename'))
    expect(rows).toContain(t('project.card.set_date'))
    expect(rows).toContain(t('project.board.delete_card'))
  })
})