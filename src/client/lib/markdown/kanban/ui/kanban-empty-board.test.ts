/**
 * F-07. A board that arrives as one blank rectangle tells the reader nothing about what it can hold,
 * so an empty one now answers with the two things they can do next: write the first card, or take a
 * structure — stages, views, a couple of examples — and rename it. These mount the real root, since
 * the guide is a decision about the whole document rather than about one view: what is filtered out,
 * or archived, is still there, and the board should keep showing that.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { KANBAN_TEMPLATE_KINDS, type KanbanTemplateKind } from '../templates'
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

/** A board with the default one-column, one-view shape: everything a template has to replace. */
function board(items: KanbanItem[]): KanbanData {
  return {
    title: 'Untitled board',
    activeViewId: 'v-board',
    views: [{ id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' }],
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      {
        id: 'status',
        name: 'Status',
        type: 'select',
        options: [{ id: 'todo', label: 'To do', color: 'gray' }],
      },
    ],
    items,
  }
}

function mountBoard(data: KanbanData) {
  const onUpdateData = vi.fn()
  const rendered = renderElement(createElement(KanbanRoot, { initialData: data, onUpdateData }))
  mounted.push(rendered)
  return { onUpdateData, ...rendered }
}

function committed(onUpdateData: ReturnType<typeof vi.fn>): KanbanData {
  return (onUpdateData.mock.calls.at(-1) as [KanbanData])[0]
}

function guide(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-kanban-empty]')
}

function click(element: Element | null | undefined, what: string) {
  if (!(element instanceof HTMLElement)) throw new Error(`${what} is not on the page`)
  act(() => {
    element.click()
  })
}

function clickTemplate(kind: KanbanTemplateKind) {
  click(document.querySelector(`[data-kanban-template="${kind}"]`), `the ${kind} template`)
}

function clickUndo() {
  click(document.querySelector(`button[aria-label="${t('common.undo')}"]`), 'undo')
}

describe('what a board with nothing on it says', () => {
  it('offers the guide where the board would be', () => {
    mountBoard(board([]))
    expect(guide()).not.toBeNull()
    expect(document.querySelector('[data-kanban-board]')).toBeNull()
  })

  it('says nothing extra once the board has a card', () => {
    mountBoard(board([{ id: 'i1', title: 'Write the plan', properties: { status: 'todo' } }]))
    expect(guide()).toBeNull()
    expect(document.querySelector('[data-kanban-board]')).not.toBeNull()
  })

  it('stays out of the way of a board that is only empty at the moment', () => {
    mountBoard(board([{ id: 'i1', title: 'Archived on purpose', properties: { status: 'todo' }, archived: true }]))
    expect(guide()).toBeNull()
    expect(document.querySelector('[data-kanban-board]')).not.toBeNull()
  })
})

describe('writing the first card', () => {
  it('adds a card, opens it for a name and gets out of the way', () => {
    const { onUpdateData } = mountBoard(board([]))
    click(document.querySelector('[data-kanban-empty-add]'), 'the first-card button')
    expect(committed(onUpdateData).items).toHaveLength(1)
    expect(guide()).toBeNull()
    expect(document.querySelector('[data-kanban-description]')).not.toBeNull()
  })
})

describe('starting from a structure', () => {
  it.each(KANBAN_TEMPLATE_KINDS)('the %s template leaves a board with stages, views and cards', (kind) => {
    const { onUpdateData } = mountBoard(board([]))
    clickTemplate(kind)
    const next = committed(onUpdateData)
    const status = next.columns.find((column) => column.id === 'status')
    expect(status?.type).toBe('select')
    expect((status?.options ?? []).length).toBeGreaterThan(1)
    expect(next.items.length).toBeGreaterThan(1)
    expect(next.views.length).toBeGreaterThan(1)
    expect(guide()).toBeNull()
    // The board repaints from the document it was just handed, stages and all.
    const painted = [...document.querySelectorAll('[data-kanban-group]')].map((el) => el.getAttribute('data-kanban-group'))
    expect(painted).toEqual((status?.options ?? []).map((option) => option.id))
  })

  it('keeps the board named what it was named', () => {
    const { onUpdateData } = mountBoard(board([]))
    clickTemplate('content')
    expect(committed(onUpdateData).title).toBe('Untitled board')
  })

  it('is one step: a single undo puts the empty board back', () => {
    const { onUpdateData } = mountBoard(board([]))
    clickTemplate('project')
    expect(committed(onUpdateData).items.length).toBeGreaterThan(0)
    clickUndo()
    expect(committed(onUpdateData).items).toEqual([])
    expect(guide()).not.toBeNull()
  })

  it('answers a second pick with that structure alone, not both stacked', () => {
    const { onUpdateData } = mountBoard(board([]))
    clickTemplate('project')
    clickUndo()
    clickTemplate('issues')
    const next = committed(onUpdateData)
    const status = next.columns.find((column) => column.id === 'status')
    expect((status?.options ?? []).map((option) => option.id)).toContain('triage')
    expect((status?.options ?? []).map((option) => option.id)).not.toContain('todo')
    expect(next.items.map((item) => String(item.properties.status))).toEqual(['backlog', 'triage'])
    expect(next.views.some((view) => view.chartGroupBy === 'priority')).toBe(true)
    expect(next.views.some((view) => view.type === 'gantt')).toBe(false)
  })
})

describe('the guide as a keyboard reaches it', () => {
  it('names its group of templates after what they are', () => {
    mountBoard(board([]))
    const group = guide()!.querySelector<HTMLElement>('[role="group"]')
    expect(group).not.toBeNull()
    const labelId = group!.getAttribute('aria-labelledby')
    expect(labelId).toBeTruthy()
    expect(document.getElementById(labelId!)?.textContent).toBe(t('preview.kanban_empty_templates'))
  })

  it('drives every one of its controls with a real button', () => {
    mountBoard(board([]))
    const controls = [...guide()!.querySelectorAll('button')]
    expect(controls).toHaveLength(1 + KANBAN_TEMPLATE_KINDS.length)
    for (const control of controls) {
      expect(control.getAttribute('type')).toBe('button')
      expect(control.textContent?.trim()).not.toBe('')
    }
  })

  it('is readable without a pointer: the why sits next to the what', () => {
    mountBoard(board([]))
    expect(guide()!.textContent).toContain(t('preview.kanban_empty_hint'))
    for (const kind of KANBAN_TEMPLATE_KINDS) {
      expect(guide()!.textContent).toContain(t(`preview.kanban_template_${kind}`))
    }
  })
})
