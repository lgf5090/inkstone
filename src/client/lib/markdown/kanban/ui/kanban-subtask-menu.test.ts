/**
 * The subtask row's “…” panel was built by hand, so it opened on a click and did nothing else:
 * the focus stayed on the trigger, no arrow key reached another row, and Enter only worked because
 * the rows were plain buttons with a pointer on them (review #26/#29). It now renders
 * `components/overlay` `Menu`, so the asserted contract is that shared keyboard path — focus in on
 * open, cursor on the rows, Enter runs the highlighted row, Escape gives the focus back — plus the
 * clipboard behaviour the panel exists for. The panel is looked up through the trigger's
 * `aria-controls`, because `Menu` draws it in a portal.
 */
import { act, createElement, type ReactNode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { useUi } from '../../../../store/ui'
import { KanbanSubtaskList } from './kanban-subtask-list'
import type { KanbanSubtask } from '../types'

const SUBTASKS: KanbanSubtask[] = [{ id: 's1', title: 'Write the spec', completed: false }]

function labels() {
  return {
    more: t('common.more_actions'),
    duplicate: t('preview.kanban_duplicate_subitem'),
    copyName: t('preview.kanban_copy_subitem_name'),
    convert: t('preview.kanban_convert_to_item'),
    delete: t('preview.kanban_delete_subitem'),
  }
}

/** A case that fails on its first assertion never reaches its own teardown, and a panel left in `document.body` answers the next case first. */
const mounted: ReturnType<typeof renderElement>[] = []

function mount(node: ReactNode) {
  const rendered = renderElement(node)
  mounted.push(rendered)
  return rendered
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mountList(onConvertToItem?: (subtask: KanbanSubtask) => void) {
  const onUpdateSubtasks = vi.fn()
  const container = mount(createElement(KanbanSubtaskList, { subtasks: SUBTASKS, onUpdateSubtasks, onConvertToItem })).container
  const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="${labels().more}"]`)
  if (!trigger) throw new Error('the subtask menu trigger was not rendered')
  return { trigger, onUpdateSubtasks }
}

function openList(onConvertToItem?: (subtask: KanbanSubtask) => void) {
  const opened = mountList(onConvertToItem)
  opened.trigger.focus()
  act(() => {
    opened.trigger.click()
  })
  return opened
}

function panelOf(trigger: HTMLElement): HTMLElement | null {
  const panelId = trigger.getAttribute('aria-controls')
  return panelId ? document.getElementById(panelId) : null
}

function rowsIn(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

function labelledRow(panel: HTMLElement, label: string): HTMLElement {
  const row = rowsIn(panel).find((node) => node.textContent === label)
  if (!row) throw new Error(`the menu has no "${label}" row`)
  return row
}

function pressKey(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

describe('kanban subtask menu rows', () => {
  it('names the panel after the control that opened it', () => {
    const { trigger } = openList()
    const panel = panelOf(trigger)
    if (!panel) throw new Error('the trigger does not name an open panel')

    expect(panel.getAttribute('role')).toBe('menu')
    expect(panel.getAttribute('aria-label')).toBe(labels().more)
  })

  it('offers convert only to a list that can convert, and keeps delete last behind a separator', () => {
    const without = rowsIn(panelOf(openList().trigger)!)
    const withConvert = rowsIn(panelOf(openList(vi.fn()).trigger)!)

    expect(without.map((row) => row.textContent)).toEqual([labels().duplicate, labels().copyName, labels().delete])
    expect(withConvert.map((row) => row.textContent)).toEqual([labels().duplicate, labels().copyName, labels().convert, labels().delete])
    expect(withConvert.at(-1)!.previousElementSibling?.getAttribute('role')).toBe('separator')
  })

  it('runs the row the reader highlighted and hands the subtask to the converter', () => {
    const onConvertToItem = vi.fn()
    const { trigger } = openList(onConvertToItem)

    pressKey('ArrowDown')
    pressKey('ArrowDown')
    pressKey('Enter')

    expect(onConvertToItem).toHaveBeenCalledWith(SUBTASKS[0])
    expect(panelOf(trigger), 'the menu stayed open after its row ran').toBeNull()
  })
})

describe('kanban subtask menu keyboard path', () => {
  it('puts the focus on the first row as it opens', () => {
    const { trigger } = openList()
    const panel = panelOf(trigger)!

    expect(document.activeElement, 'opening the menu left the focus on the trigger').toBe(rowsIn(panel)[0])
  })

  it('moves the cursor through the rows with the arrow keys', () => {
    const { trigger } = openList()
    const rows = rowsIn(panelOf(trigger)!)

    pressKey('ArrowDown')
    expect(document.activeElement).toBe(rows[1])
    pressKey('ArrowUp')
    expect(document.activeElement).toBe(rows[0])
  })

  it('runs the highlighted row on Enter and closes', () => {
    const { trigger, onUpdateSubtasks } = openList()

    pressKey('Enter')

    expect(onUpdateSubtasks).toHaveBeenCalledTimes(1)
    const next = onUpdateSubtasks.mock.calls[0]![0] as KanbanSubtask[]
    expect(next.map((subtask) => subtask.title)).toEqual(['Write the spec', 'Write the spec'])
    expect(next[1]!.id).not.toBe('s1')
    expect(panelOf(trigger), 'the menu stayed open after Enter').toBeNull()
  })

  it('closes on Escape with the focus back on the trigger', () => {
    const { trigger } = openList()

    pressKey('Escape')

    expect(panelOf(trigger), 'Escape left the menu open').toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('kanban subtask menu copy name', () => {
  beforeEach(() => {
    useUi.setState({ toasts: [] })
    delete (navigator as { clipboard?: unknown }).clipboard
  })

  async function clickCopy() {
    const { trigger } = openList()
    await act(async () => {
      labelledRow(panelOf(trigger)!, labels().copyName).click()
    })
    return { trigger }
  }

  it('copies the subtask title, confirms it, and closes', async () => {
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    const { trigger } = await clickCopy()

    expect(writeText).toHaveBeenCalledWith('Write the spec')
    expect(panelOf(trigger), 'the menu stayed open after the copy').toBeNull()
    expect(useUi.getState().toasts.at(-1)).toMatchObject({ title: t('common.copied'), tone: 'success' })
  })

  it('reports a danger toast instead of an unhandled rejection when the write fails', async () => {
    stubClipboard(vi.fn(async () => {
      throw new Error('denied')
    }))
    await clickCopy()

    expect(useUi.getState().toasts.at(-1)).toMatchObject({ title: t('preview.could_not_copy'), tone: 'danger' })
  })

  it('reports a danger toast when no clipboard is available', async () => {
    await clickCopy()

    expect(useUi.getState().toasts.at(-1)).toMatchObject({ title: t('preview.could_not_copy'), tone: 'danger' })
  })
})
