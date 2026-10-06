/**
 * KU-23's wiring, driven the way a reader drives it. The pure layer (`dependencies.test.ts`) pins
 * the rules; what is asserted here is that the panel and the views actually use them: adding a
 * blocker from the picker writes the pair the reader chose, a choice that would close a loop is
 * never offered (so the write is guarded before the pointer can reach it), removing a blocker is
 * one click, and the arrows appear on the gantt between the bars the dependencies join. The detail
 * modal renders through a portal into `document.body`, so the panel is read there — the container
 * only holds the board itself.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import type { KanbanData, KanbanItem } from '../types'
import { KanbanRoot } from './kanban-root'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  document.body.replaceChildren()
})

function card(id: string, properties: Record<string, unknown> = {}, dependsOn?: string[]): KanbanItem {
  const base: KanbanItem = { id, title: id.toUpperCase(), properties }
  return dependsOn ? { ...base, dependsOn } : base
}

function boardData(): KanbanData {
  return {
    title: 'Board',
    activeViewId: 'v-gantt',
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
    ],
    items: [
      card('a', { startDate: '2026-09-10', endDate: '2026-09-12' }),
      card('b', { startDate: '2026-09-14', endDate: '2026-09-16' }),
    ],
    views: [
      { id: 'v-gantt', name: 'Gantt', type: 'gantt', startField: 'startDate', endField: 'endDate', progressField: 'progress' },
    ],
  }
}

function openBoard(initialData = boardData()) {
  const onUpdateData = vi.fn()
  const rendered = renderElement(createElement(KanbanRoot, { initialData, onUpdateData }))
  mounted.push(rendered)
  return { ...rendered, onUpdateData }
}

function lastItems(onUpdateData: ReturnType<typeof vi.fn>): KanbanItem[] {
  const call = onUpdateData.mock.calls.at(-1)
  if (!call) throw new Error('the board wrote nothing')
  return (call[0] as KanbanData).items
}

async function openDetail(container: HTMLElement, id: string) {
  const bar = container.querySelector<HTMLElement>(`[data-item-id="${id}"]`)
  if (!bar) throw new Error(`the gantt drew no bar for ${id}`)
  await act(async () => {
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function detailShell(): ParentNode {
  // The card opens through the overlay library's portal, so the panel lives beside the board,
  // directly under body — reading it there is reading what a reader sees.
  const shell = [...document.body.querySelectorAll('[role="dialog"]')].at(-1)
  if (!shell) throw new Error('the detail panel did not open')
  return shell
}

function openDependencyAdder(): ParentNode {
  const shell = detailShell()
  const trigger = [...shell.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.includes('Add a dependency'),
  )
  if (!trigger) throw new Error('the detail panel drew no dependency adder')
  act(() => trigger.click())
  const panel = detailShell().querySelector('[role="listbox"]')
  if (!panel) throw new Error('the dependency picker did not open')
  return panel
}

function choiceButtons(panel: ParentNode): HTMLButtonElement[] {
  return [...panel.querySelectorAll<HTMLButtonElement>('[role="option"]')]
}

describe('the detail panel edits the dependency list', () => {
  it('writes the pair the reader picked from the picker', async () => {
    const { container, onUpdateData } = openBoard()
    await openDetail(container, 'b')
    const panel = openDependencyAdder()
    const optionA = choiceButtons(panel).find((b) => b.textContent?.includes('A'))
    if (!optionA) throw new Error('the picker did not offer card a')
    await act(async () => optionA.click())
    expect(lastItems(onUpdateData).find((item) => item.id === 'b')!.dependsOn).toEqual(['a'])
  })

  it('never offers a choice that would close a loop', async () => {
    const { container, onUpdateData } = openBoard()
    // b takes a as a blocker; opening a's panel then must find nothing named b to click.
    await openDetail(container, 'b')
    const panel = openDependencyAdder()
    const optionA = choiceButtons(panel).find((b) => b.textContent?.includes('A'))
    if (!optionA) throw new Error('the picker did not offer card a')
    await act(async () => optionA.click())
    await openDetail(container, 'a')
    const adder = openDependencyAdder()
    expect(choiceButtons(adder).some((b) => b.textContent?.includes('B'))).toBe(false)
    expect(onUpdateData).toHaveBeenCalledTimes(1)
  })

  it('removes a blocker with its row button', async () => {
    const data = boardData()
    data.items = [
      card('a', { startDate: '2026-09-10', endDate: '2026-09-12' }),
      card('b', { startDate: '2026-09-14', endDate: '2026-09-16' }, ['a']),
    ]
    const { container, onUpdateData } = openBoard(data)
    await openDetail(container, 'b')
    const shell = detailShell()
    const row = [...shell.querySelectorAll('div')].find((d) => d.className.includes('shadow-2xs'))
    if (!row) throw new Error('the panel drew no blocker row')
    await act(async () => row.querySelector('button')!.click())
    expect(lastItems(onUpdateData).find((item) => item.id === 'b')!.dependsOn).toBeUndefined()
  })
})

describe('the gantt draws the arrows its dependencies name', () => {
  /** The link layer, by the aria-hidden SVG only it draws (icons live in buttons, not bare svg). */
  function linkElbows(): SVGPathElement[] {
    return [...document.querySelectorAll<SVGPathElement>('svg[aria-hidden] path[stroke]')]
  }

  it('puts one arrow between the two bars, out of the blocker and into the dependent', () => {
    const data = boardData()
    data.items = [
      card('a', { startDate: '2026-09-10', endDate: '2026-09-12' }),
      card('b', { startDate: '2026-09-14', endDate: '2026-09-16' }, ['a']),
    ]
    openBoard(data)
    const elbows = linkElbows()
    expect(elbows.length).toBe(1)
    expect(elbows[0]!.getAttribute('d')).toMatch(/^M \d/)
    expect(elbows[0]!.getAttribute('d')).toContain('H')
  })

  it('draws nothing for a board with no dependencies', () => {
    openBoard()
    expect(linkElbows().length).toBe(0)
  })
})

describe('the board card footer names its waiters', () => {
  function boardData(): KanbanData {
    return {
      title: 'Board',
      activeViewId: 'v-board',
      columns: [
        { id: 'title', name: 'Title', type: 'title' },
        {
          id: 'status',
          name: 'Status',
          type: 'select',
          options: [{ id: 'todo', label: 'To Do', color: 'gray' }],
        },
      ],
      items: [
        card('a', { status: 'todo' }),
        card('b', { status: 'todo' }, ['a']),
        card('c', { status: 'todo' }, ['a']),
      ],
      views: [{ id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' }],
    }
  }

  it('shows how many cards wait on a blocker and opens its detail when pressed', async () => {
    const { container } = openBoard(boardData())
    const blockerBadge = container.querySelector<HTMLElement>('[data-item-id="a"] [data-kanban-blocks-count]')
    expect(blockerBadge, 'the card two waiters point at drew no badge').not.toBeNull()
    expect(blockerBadge!.getAttribute('aria-label')).toBe(t('preview.kanban_card_blocks_count', { count: 2 }))
    expect(container.querySelector('[data-item-id="b"] [data-kanban-blocks-count]'), 'a card that waits on nothing wore a badge').toBeNull()
    await act(async () => {
      blockerBadge!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // The detail's dependency editor lives in the panel, so the press has to open it — the badge is
    // a door, not a decoration.
    expect([...document.body.querySelectorAll('[role="dialog"]')].length, 'pressing the badge opened nothing').toBeGreaterThan(0)
  })
})
