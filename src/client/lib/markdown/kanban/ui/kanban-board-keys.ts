import { useEffect, type RefObject } from 'react'
import { isEditableTarget } from '../../../hotkeys'
import type { MessageKey } from '../../../i18n'

/**
 * The board's own keyboard, as one table: the chords the board answers to, what each one does, and the
 * sentence the keyboard reference names it with. One table rather than three because the reference is
 * drawn from it — a card that listed chords the board does not answer to, or left one out, is the kind
 * of drift a hand-written list grows within a release.
 *
 * These are read from a listener on the board's own container rather than registered in the app's
 * global hotkey registry (`lib/hotkeys`), which is how undo and redo already work here. The difference
 * matters: a global chord would add a card to a note's board while the reader was typing in a *different*
 * note, since the registry cannot tell which board the reader means. Focus is the scope — a key press
 * only reaches this listener when it happened inside this board.
 */
export type KanbanBoardCommand = 'prevCard' | 'nextCard' | 'prevColumn' | 'nextColumn' | 'newCard' | 'search' | 'deleteCard'

export interface KanbanBoardChord {
  /** The `KeyboardEvent.key` the board answers to. */
  key: string
  command: KanbanBoardCommand
  messageKey: MessageKey
}

export const KANBAN_BOARD_CHORDS: KanbanBoardChord[] = [
  { key: 'ArrowUp', command: 'prevCard', messageKey: 'preview.kanban_key_prev_card' },
  { key: 'ArrowDown', command: 'nextCard', messageKey: 'preview.kanban_key_next_card' },
  { key: 'ArrowLeft', command: 'prevColumn', messageKey: 'preview.kanban_key_prev_column' },
  { key: 'ArrowRight', command: 'nextColumn', messageKey: 'preview.kanban_key_next_column' },
  { key: 'n', command: 'newCard', messageKey: 'preview.kanban_key_add_card' },
  { key: '/', command: 'search', messageKey: 'preview.kanban_key_search' },
  { key: 'Delete', command: 'deleteCard', messageKey: 'preview.kanban_key_delete_card' },
  { key: 'Backspace', command: 'deleteCard', messageKey: 'preview.kanban_key_delete_card' },
]

/**
 * The chords the board answers to, or nothing. A modified arrow is not one of them: `Shift`+arrow is
 * the board's own *move this card* gesture (read by the card) and `mod`/`alt`+arrow belong to the
 * browser and to text editing, so all of them are left alone here.
 */
export function kanbanBoardCommand(key: string, event: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): KanbanBoardCommand | null {
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null
  const chord = KANBAN_BOARD_CHORDS.find((item) => item.key.toLowerCase() === key.toLowerCase())
  return chord?.command ?? null
}

/** The cards a reader can walk with the arrows: every card drawn in one column, in reading order. */
function cardsIn(column: Element): HTMLElement[] {
  return [...column.querySelectorAll<HTMLElement>('[data-item-id]')]
}

/** The columns of one row of the board. A banded board has several rows; a plain one has a single. */
function columnsIn(row: Element): Element[] {
  return [...row.children].filter((child) => child.matches('[data-kanban-group]'))
}

/** The row a card stands in: its band, or the board itself when the board is one row of columns. */
function rowOf(card: Element): Element | null {
  return card.closest('[data-kanban-band]') ?? card.closest('[data-kanban-board]')
}

/**
 * What the arrows focus next, given the card the key came from: the neighbouring card in the same
 * column, or the card nearest the same position in the neighbouring column. The title button is what
 * takes the focus — that is the card's own control and the thing whose Enter opens the detail, so
 * walking a board with the arrows leaves the reader one press from any card they land on.
 *
 * `null` means the board has nothing that way, and the key is left to the browser: at the first column
 * or past the last card, the arrow scrolls the board instead of being swallowed.
 */
export function kanbanCardFocusTarget(from: Element, command: KanbanBoardCommand): HTMLElement | null {
  const card = from.closest('[data-item-id]')
  const column = card?.closest('[data-kanban-group]')
  if (!card || !column) return null

  if (command === 'prevCard' || command === 'nextCard') {
    const cards = cardsIn(column)
    const at = cards.indexOf(card as HTMLElement) + (command === 'nextCard' ? 1 : -1)
    return titleButtonOf(cards[at])
  }
  if (command !== 'prevColumn' && command !== 'nextColumn') return null

  const row = rowOf(card)
  if (!row) return null
  const columns = columnsIn(row)
  const own = columns.indexOf(column)
  const neighbour = columns[own + (command === 'nextColumn' ? 1 : -1)]
  if (!neighbour) return null
  const cards = cardsIn(neighbour)
  if (cards.length === 0) return null
  // The same card index where the column is long enough, its last card where it is not: a reader who
  // walks a board sideways stays in the part of it they were reading.
  return titleButtonOf(cards[Math.min(cardsIn(column).indexOf(card as HTMLElement), cards.length - 1)])
}

/** The one control in a card that carries the card's own name. */
function titleButtonOf(card: HTMLElement | undefined): HTMLElement | null {
  return card?.querySelector<HTMLElement>('h3 button') ?? null
}

/** The search control of this board, and whether one could be found to put the reader in. */
function focusSearch(container: HTMLElement): boolean {
  const open = container.querySelector<HTMLInputElement>('[data-kanban-search-input]')
  if (open) {
    open.focus()
    return true
  }
  // The collapsed box is a button, and so is the chip a query leaves behind: pressing either is the
  // same press the reader would make, and the field it opens takes the focus on its own.
  const trigger = container.querySelector<HTMLButtonElement>('[data-kanban-search]')
  if (!trigger) return false
  trigger.click()
  return true
}

/**
 * Opens the column's own composer, the way the reader would: the door KU-13 put at the bottom of every
 * column is a title field, so the chord presses the control that opens it rather than filing a card of
 * its own. That is why `N` does not open a card window — a card filed from the header's button lands in
 * its detail dialog, and a keyboard reader who wanted to type a title would be looking at the board
 * through a modal. What they get instead is the same field the footer gives them, with the focus in it.
 *
 * The column the reader is standing in wins, so `N` between two cards of a column adds there; with the
 * focus anywhere else (the top bar, the board itself) it is the first column, which is where a reader
 * with no context would look for it.
 */
function openNewCardField(container: HTMLElement): boolean {
  const standing = document.activeElement?.closest('[data-kanban-group]')
  const group = standing ?? container.querySelector('[data-kanban-group]')
  const control = group?.querySelector<HTMLElement>('[data-kanban-new-item]')
  if (!control) return false
  control.focus()
  if (control instanceof HTMLButtonElement) control.click()
  return true
}

/**
 * Wires the table above onto the board's container. Nothing here reads the board's data or calls into
 * its render cycle: every command either moves the focus through what is already drawn, presses a
 * control that is already on screen, or (for the delete) hands the focused card's id to the writer the
 * root passed in — the card is flagged out of the views, and the history's undo is the way back.
 */
export function useKanbanBoardKeys(
  containerRef: RefObject<HTMLElement | null>,
  onDeleteCard?: (id: string) => void,
): void {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handleKeyDown = (e: KeyboardEvent) => {
      // A key press that started in a field is the field's: typing `n` in a title is not a request for
      // a new card, and the arrows are how the caret is moved inside one.
      if (isEditableTarget(e.target)) return
      const command = kanbanBoardCommand(e.key, e)
      if (!command) return

      if (command === 'search') {
        if (!focusSearch(container)) return
        e.preventDefault()
        return
      }
      if (command === 'newCard') {
        if (!openNewCardField(container)) return
        e.preventDefault()
        return
      }
      if (command === 'deleteCard') {
        const card = (e.target as Element | null)?.closest('[data-item-id]')
        const id = card?.getAttribute('data-item-id')
        if (!id || !onDeleteCard) return
        e.preventDefault()
        onDeleteCard(id)
        return
      }
      const target = kanbanCardFocusTarget(e.target as Element, command)
      if (!target) return
      e.preventDefault()
      target.focus()
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [containerRef, onDeleteCard])
}
