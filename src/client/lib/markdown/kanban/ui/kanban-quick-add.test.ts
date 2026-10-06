/**
 * KU-13. Adding a card to a column used to be three steps — press New item, wait for the card's dialog,
 * type the title into it — so filling one column with nine cards meant nine dialogs and the same name
 * typed twice. The column's footer is a title field now: `Enter` adds the card and stays for the next
 * title, `Shift+Enter` adds it and opens its window, `Escape` puts the field away and hands the focus
 * back to the button that opened it.
 *
 * These read the field through the real board rather than through the component alone, because the
 * thing worth asserting is the whole errand: the card lands in the column whose footer was typed in
 * (the group and the lane travel as defaults), nothing opens a dialog behind the reader's back, and the
 * announcement names what arrived — the field keeps the focus, so the new card is off screen and the
 * region is the only thing that says the title landed.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { KanbanRoot } from './kanban-root'
import type { KanbanData, KanbanProperty } from '../types'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const statusColumn: KanbanProperty = {
  id: 'status',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'todo', label: 'To Do', color: 'gray' },
    { id: 'doing', label: 'Doing', color: 'blue' },
  ],
}

function boardData(): KanbanData {
  return {
    columns: [{ id: 'title', name: 'Title', type: 'title' }, statusColumn],
    items: [{ id: 'card-1', title: 'Existing card', properties: { status: 'doing' } }],
    views: [{ id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' }],
  }
}

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mountBoard(onUpdateData = vi.fn()) {
  const rendered = renderElement(createElement(KanbanRoot, { initialData: boardData(), onUpdateData }))
  mounted.push(rendered)
  return { ...rendered, onUpdateData }
}

/** The column's footer button, found by the name every new-card door shares. */
function addButton(container: HTMLElement, groupKey: string): HTMLButtonElement {
  const column = container.querySelector<HTMLElement>(`[data-kanban-group="${groupKey}"]`)
  const button = [...(column?.querySelectorAll('button') ?? [])].find(
    (el) => el.textContent === t('preview.kanban_new_item'),
  )
  if (!button) throw new Error(`no new-item button in the "${groupKey}" column`)
  return button as HTMLButtonElement
}

function titleField(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${t('preview.kanban_new_item')}"]`)
}

function openField(container: HTMLElement, groupKey = 'todo'): HTMLInputElement {
  act(() => {
    addButton(container, groupKey).click()
  })
  const field = titleField(container)
  if (!field) throw new Error('the footer button opened no title field')
  return field
}

/** Types into the field the way a person does: one event, the value on the element. */
function type(field: HTMLInputElement, text: string): void {
  act(() => {
    field.dispatchEvent(new Event('input', { bubbles: true }))
    setValue(field, text)
    field.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/**
 * React owns the input's value, so writing `.value` alone is overwritten on the next render: the native
 * setter is called first, which is what React's own change tracking reads.
 */
function setValue(field: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(field, text)
}

function press(field: HTMLInputElement, key: string, shiftKey = false): void {
  act(() => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }))
  })
}

/** The added card, read off the document the board handed back to its host. */
function addedTitles(onUpdateData: ReturnType<typeof vi.fn>): string[] {
  const commits = onUpdateData.mock.calls.map((call) => call[0] as KanbanData)
  const last = commits.at(-1)
  return (last?.items ?? []).map((item) => item.title)
}

function addedCard(onUpdateData: ReturnType<typeof vi.fn>) {
  const commits = onUpdateData.mock.calls.map((call) => call[0] as KanbanData)
  return commits.at(-1)?.items.at(-1)
}

function statusText(container: HTMLElement): string {
  return container.querySelector('[role="status"]')?.textContent ?? ''
}

/**
 * The card's window, wherever it was drawn: it portals itself onto the body, so a container query would
 * answer no to a dialog that is really open — which is a false negative in exactly the direction that
 * matters here (the whole point of the quick add is that nothing opens).
 */
function openDialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]')
}

/**
 * The card's title, read off the field the window titles it with. The title lives in an input's value
 * rather than in text, so a text query over the dialog answers no to a window that is plainly showing it.
 */
function dialogTitle(): string {
  const field = openDialog()?.querySelector<HTMLInputElement>(
    `input[placeholder="${t('preview.kanban_card_title')}"]`,
  )
  return field?.value ?? ''
}

/**
 * A focus that leaves the field, told to React as it hears it: React's `onBlur` is the `focusout`
 * listener, and a raw `blur` (which does not bubble) reaches the component through no path at all.
 */
function blur(field: HTMLInputElement): void {
  act(() => {
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

describe('a column files a card from its own title field', () => {
  it('shows the field on the button press and writes nothing until a title is committed', () => {
    const { container } = mountBoard()
    const before = container.querySelectorAll('[data-item-id]').length
    expect(titleField(container)).toBeNull()
    const field = openField(container)
    expect(field).toBe(document.activeElement)
    expect(container.querySelectorAll('[data-item-id]').length).toBe(before)
  })

  it('adds the typed card to that column, keeps the field open, and says what it added', () => {
    const { container, onUpdateData } = mountBoard()
    const field = openField(container)
    type(field, 'Write the spec')
    press(field, 'Enter')

    const card = addedCard(onUpdateData)
    expect(card?.title).toBe('Write the spec')
    expect(card?.properties.status).toBe('todo')
    expect(container.querySelector(`[data-item-id="${card!.id}"]`)).not.toBeNull()
    // No dialog: that wait is the thing this door exists to avoid.
    expect(openDialog()).toBeNull()
    expect(titleField(container)).toBe(field)
    expect(field.value).toBe('')
    expect(field).toBe(document.activeElement)
    expect(statusText(container)).toBe(t('preview.kanban_quick_add_done', { title: 'Write the spec' }))
  })

  it('fills two cards from one field without reopening it', () => {
    const { container, onUpdateData } = mountBoard()
    const field = openField(container)
    type(field, 'First')
    press(field, 'Enter')
    type(field, 'Second')
    press(field, 'Enter')
    expect(addedTitles(onUpdateData)).toEqual(['Existing card', 'First', 'Second'])
  })

  it('draws no field in a column the reader has not opened, so the board keeps its shape', () => {
    const { container } = mountBoard()
    openField(container, 'todo')
    expect(container.querySelectorAll('input[data-owns-escape]').length).toBe(1)
    expect(addButton(container, 'doing').textContent).toBe(t('preview.kanban_new_item'))
  })
})

describe('the field is honest about a title it did not file', () => {
  it('adds nothing on Enter over an empty field, and stays for the title the reader meant to type', () => {
    const { container, onUpdateData } = mountBoard()
    const field = openField(container)
    type(field, '   ')
    press(field, 'Enter')
    expect(onUpdateData).not.toHaveBeenCalled()
    expect(titleField(container)).toBe(field)
  })

  it('puts the field away on Escape and hands the focus back to the button that opened it', () => {
    const { container, onUpdateData } = mountBoard()
    const field = openField(container)
    type(field, 'Abandoned')
    press(field, 'Escape')
    expect(titleField(container)).toBeNull()
    expect(onUpdateData).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(addButton(container, 'todo'))
    // The draft goes with the field: the next press of the button starts a new card, not this one again.
    expect(openField(container).value).toBe('')
  })
})

describe('the field is also the door to the new card\'s other fields', () => {
  it('opens the new card on Shift+Enter, which is the door to the rest of its fields', () => {
    const { container, onUpdateData } = mountBoard()
    const field = openField(container)
    type(field, 'Needs dates')
    press(field, 'Enter', true)
    const card = addedCard(onUpdateData)
    expect(card?.title).toBe('Needs dates')
    expect(dialogTitle()).toBe('Needs dates')
  })

  it('closes itself when the reader clicks away from an empty field, and keeps a draft that is not empty', () => {
    const first = mountBoard()
    const field = openField(first.container)
    blur(field)
    expect(titleField(first.container)).toBeNull()

    const second = mountBoard()
    const kept = openField(second.container)
    type(kept, 'Half a title')
    blur(kept)
    expect(titleField(second.container)).toBe(kept)
    expect(titleField(second.container)?.value).toBe('Half a title')
  })
})
