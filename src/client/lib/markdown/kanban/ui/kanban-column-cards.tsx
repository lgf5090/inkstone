import { useEffect, useRef, useState, type RefObject } from 'react'
import { Plus } from 'lucide-react'
import { t } from '../../../i18n'
import { kanbanQuickAddCommand } from '../quick-add'
import type { KanbanAddFinish, KanbanData, KanbanItem, KanbanOption, KanbanSubtask } from '../types'
import { KanbanCard, type CardMoveDirection } from './kanban-card'
import { KanbanRenderTail, useKanbanRenderWindow } from './kanban-render-window'
import type { CardDropTarget } from './kanban-board-dnd'
import type { CardSize } from './kanban-view-options'

/**
 * What a column draws once its header is behind it: the cards, whatever it is holding back, and the
 * door to add one. It lives apart from the board so the board can stay a description of where columns
 * go — and so the render window (the 30 cards a column mounts at a time) has one owner rather than
 * one per surface that lists cards.
 */
export interface ColumnCardsListProps {
  items: KanbanItem[]
  columns: KanbanData['columns']
  selectedIds: Set<string>
  cardSize?: CardSize
  /** Columns this view prints on each card (see `card-fields.ts`); the board is what reads the view. */
  cardFields?: string[]
  selectedTags?: string[]
  /** How many cards wait on each card; the board computes it once over the whole document. */
  blockedCounts?: Map<string, number>
  cardDropTarget: CardDropTarget | null
  onToggleSelect: (id: string) => void
  onOpenDetail: (item: KanbanItem) => void
  onToggleTag?: (tag: string) => void
  onUpdateTitle: (id: string, newTitle: string) => void
  onUpdateSubtasks?: (itemId: string, nextSubtasks: KanbanSubtask[]) => void
  onDragStartCard: (e: React.DragEvent, id: string) => void
  onDragEnd: () => void
  onDragOverCard: (e: React.DragEvent, id: string) => void
  onDropCard: (e: React.DragEvent, id: string) => void
  onMoveColumn: (itemId: string, dir: CardMoveDirection) => void
  onAddItem: (finish?: KanbanAddFinish) => void
  onUpdateTags?: (itemId: string, nextTags: string[], newOption?: KanbanOption) => void
  onAddColumnOption?: (columnId: string, option: KanbanOption) => void
}

export function ColumnCardsList(props: ColumnCardsListProps) {
  const { visible, hiddenCount, setTailElement, revealMore } = useKanbanRenderWindow(props.items)
  return (
    <div className='mt-2 flex flex-1 flex-col gap-2 overflow-y-auto'>
      {props.items.length === 0 ? (
        <div className='flex h-20 items-center justify-center rounded-[var(--r-lg)] border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface-subtle)]/50 text-[length:var(--text-12)] font-medium text-[var(--text-tertiary)]'>
          {t('preview.kanban_empty_column')}
        </div>
      ) : (
        visible.map((item) => (
          <KanbanCard
            key={item.id}
            item={item}
            columns={props.columns}
            isSelected={props.selectedIds.has(item.id)}
            cardSize={props.cardSize}
            cardFields={props.cardFields}
            selectedTags={props.selectedTags}
            blockedCount={props.blockedCounts?.get(item.id)}
            dropIndicator={props.cardDropTarget?.cardId === item.id ? props.cardDropTarget.position : null}
            onToggleSelect={props.onToggleSelect}
            onOpenDetail={props.onOpenDetail}
            onToggleTag={props.onToggleTag}
            onUpdateTitle={props.onUpdateTitle}
            onUpdateSubtasks={props.onUpdateSubtasks}
            // The card passes its own id, so the column can hand the same handler to all of them.
            onDragStart={props.onDragStartCard}
            onDragEnd={props.onDragEnd}
            onDragOverCard={props.onDragOverCard}
            onDropOnCard={props.onDropCard}
            onMoveColumn={props.onMoveColumn}
            onUpdateTags={props.onUpdateTags}
            onAddColumnOption={props.onAddColumnOption}
          />
        ))
      )}

      <KanbanRenderTail hiddenCount={hiddenCount} setTailElement={setTailElement} onReveal={revealMore} />

      <ColumnQuickAdd onAddItem={props.onAddItem} />
    </div>
  )
}

/**
 * The state behind a column's title field, kept apart from the markup that draws it.
 *
 * Adding used to be "New item → dialog → type the title into it", so a column of nine cards cost nine
 * dialogs and a name typed twice. Here the field keeps the focus, clears itself, and says what it added,
 * so the next title can be typed straight away.
 *
 * The two chords are the two things a reader can want after naming a card: `Enter` adds it and stays for
 * the next one, `Shift+Enter` adds it and opens its window for the rest of the fields. `Enter` on an
 * empty field adds nothing — an empty title is not a card, and the placeholder-title card (with its
 * window open) is what `Shift+Enter` is for. `Escape` puts the field away and hands the focus back to
 * the button that opened it, and a field left empty closes itself when the reader clicks on.
 */
function useColumnQuickAdd(onAddItem: (finish?: KanbanAddFinish) => void) {
  const [isOpen, setIsOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [added, setAdded] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef(false)
  useQuickAddFocus({ isOpen, inputRef, buttonRef, returnFocusRef })

  const close = (returnFocus: boolean) => {
    returnFocusRef.current = returnFocus
    setTitle('')
    setIsOpen(false)
  }

  const submit = (openDetail: boolean) => {
    const text = title.trim()
    if (text === '' && !openDetail) return
    onAddItem({ title: text, openDetail })
    setTitle('')
    setAdded(text === '' ? '' : t('preview.kanban_quick_add_done', { title: text }))
    inputRef.current?.focus()
  }

  return {
    isOpen,
    title,
    added,
    inputRef,
    buttonRef,
    open: () => setIsOpen(true),
    handleChange: (value: string) => setTitle(value),
    handleBlur: () => {
      if (title.trim() === '') close(false)
    },
    handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      const command = kanbanQuickAddCommand(e.key, e.shiftKey)
      if (!command) return
      e.preventDefault()
      if (command.kind === 'dismiss') close(true)
      else submit(command.openDetail)
    },
  }
}

/**
 * Focus follows the field's two lives: into the field when it opens, and back to the button that opened
 * it when the reader put the field away with the keyboard — a control that vanishes under the focus has
 * to hand it back. A field put away by a press somewhere else leaves the focus where the press put it,
 * which is why the return is a flag rather than the default.
 */
function useQuickAddFocus({
  isOpen,
  inputRef,
  buttonRef,
  returnFocusRef,
}: {
  isOpen: boolean
  inputRef: RefObject<HTMLInputElement | null>
  buttonRef: RefObject<HTMLButtonElement | null>
  returnFocusRef: RefObject<boolean>
}) {
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus()
      return
    }
    if (returnFocusRef.current) {
      returnFocusRef.current = false
      buttonRef.current?.focus()
    }
  }, [isOpen, inputRef, buttonRef, returnFocusRef])
}

/** The column's own door to a new card: a button that becomes a title field in place. */
function ColumnQuickAdd({ onAddItem }: { onAddItem: (finish?: KanbanAddFinish) => void }) {
  const field = useColumnQuickAdd(onAddItem)

  return (
    <>
      {/* First rather than last on purpose: the column's own list is read by its last child as "what the
          reader sees at the bottom of this column", and a live region is not that — parked after the
          control it made the footer look like a box with nothing drawn in it. It is `sr-only`, so it is
          out of flow either way, and a region announces its content wherever it sits. */}
      <span role='status' aria-live='polite' className='sr-only'>
        {field.added}
      </span>
      {field.isOpen ? (
        <input
          ref={field.inputRef}
          type='text'
          value={field.title}
          data-owns-escape='true'
          data-kanban-new-item=''
          aria-label={t('preview.kanban_new_item')}
          title={t('preview.kanban_quick_add_hint')}
          onChange={(e) => field.handleChange(e.target.value)}
          onKeyDown={field.handleKeyDown}
          onBlur={field.handleBlur}
          className='w-full rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1.5 text-[length:var(--text-12)] text-[var(--text-primary)] outline-none focus-visible:border-[var(--accent)]'
        />
      ) : (
        <button
          ref={field.buttonRef}
          type='button'
          data-kanban-new-item=''
          onClick={field.open}
          className='flex items-center gap-1.5 self-start rounded-[var(--r-md)] px-2 py-1.5 text-[length:var(--text-12)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
        >
          <Plus size={13} />
          <span>{t('preview.kanban_new_item')}</span>
        </button>
      )}
    </>
  )
}
