/**
 * The keys a column's title field answers to, as a rule rather than as branches inside the field's
 * handler — the same shape `column-width.ts` gives the resize handle's chords, and for the same reason:
 * the decision is the part worth testing on its own, away from the markup that hears the key.
 *
 * `Enter` files the title; `Shift+Enter` files it and opens the card, which is the door to the rest of
 * its fields. Over an empty field `Enter` files nothing (an empty title is not a card) while
 * `Shift+Enter` still files one under the placeholder title — that card exists precisely so the reader
 * can name it in its own window, so refusing it would close the only door it has.
 */
export type KanbanQuickAddCommand = { kind: 'file'; openDetail: boolean } | { kind: 'dismiss' }

export function kanbanQuickAddCommand(key: string, shiftKey: boolean): KanbanQuickAddCommand | null {
  if (key === 'Enter') return { kind: 'file', openDetail: shiftKey }
  if (key === 'Escape') return { kind: 'dismiss' }
  return null
}
