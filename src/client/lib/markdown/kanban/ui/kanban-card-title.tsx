import { useState, type KeyboardEvent } from 'react'
import { Pencil } from 'lucide-react'
import { t } from '../../../i18n'
import { KanbanIconBadge } from './kanban-icon-badge'

/**
 * The card's title: the one part of a card that is a gesture rather than a value.
 *
 * One click opens the detail, and rename lives on the pencil beside the title and on `F2`. A double
 * click used to rename, and the first click waited a quarter second for the second not to happen —
 * a hold every open paid so a gesture few readers knew could run. The wait is gone: opening is
 * immediate, and the two rename doors the wait existed to protect are still there.
 */

/**
 * The title's pointer and keyboard doors. A keyboard activation and a pointer press open alike;
 * the pencil and `F2` are the doors a rename has that are not the title itself.
 */
export function useCardTitleGestures(onOpenDetail: () => void, startEditing: () => void) {
  const handleTitleClick = () => {
    onOpenDetail()
  }

  const handleTitleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'F2') return
    e.preventDefault()
    startEditing()
  }

  return { handleTitleClick, handleTitleKeyDown }
}

/** The card's own title, and the value behind it: what it says while it is a heading and while it is a field. */
export function useKanbanCardTitle(initialTitle: string, onUpdate: (title: string) => void) {
  const [isEditing, setIsEditing] = useState(false)
  const [text, setText] = useState(initialTitle)

  const handleBlur = () => {
    setIsEditing(false)
    if (text.trim() && text !== initialTitle) onUpdate(text.trim())
    else setText(initialTitle)
  }

  const handleCancel = () => {
    setText(initialTitle)
    setIsEditing(false)
  }

  return { isEditing, text, setText, startEditing: () => setIsEditing(true), handleBlur, handleCancel }
}

/**
 * The door a pointer that does not know about the double click can walk through, drawn on the title's
 * own row: the gesture the board's title offers in its full screen view, and the one a screen reader
 * or a keyboard reaches without knowing any gesture at all. It is hidden until the card is hovered or
 * the button is focused — never from the keyboard, which is what `focus-visible` is for.
 */
function CardRenameButton({ onStartEditing }: { onStartEditing: () => void }) {
  return (
    <button
      type='button'
      onClick={onStartEditing}
      aria-label={t('preview.kanban_rename_card')}
      title={t('preview.kanban_rename_card')}
      data-kanban-rename-card=''
      className='shrink-0 rounded-[var(--r-xs)] p-[var(--sp-0-5)] text-[var(--text-tertiary)] opacity-0 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover/card:opacity-100 pointer-coarse:!opacity-100'
    >
      <Pencil size={12} aria-hidden />
    </button>
  )
}

/** The title's field, which is what the row turns into while the card is being renamed. */
function CardTitleEditor({
  icon,
  titleText,
  onChangeText,
  onBlur,
  onCancel,
}: {
  icon?: string
  titleText: string
  onChangeText: (text: string) => void
  onBlur: () => void
  onCancel: () => void
}) {
  return (
    <div className='flex items-center gap-[var(--sp-1-5)]'>
      {icon && <KanbanIconBadge icon={icon} size={15} />}
      <input
        type='text'
        data-owns-escape='true'
        value={titleText}
        autoFocus
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onChangeText(e.target.value)}
        onBlur={onBlur}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onBlur()
          if (e.key === 'Escape') onCancel()
        }}
        className='w-full rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-inset)] px-[var(--sp-1-5)] py-[var(--sp-0-5)] text-[length:var(--text-14)] font-semibold text-[var(--text-primary)] outline-none'
      />
    </div>
  )
}

/**
 * The title as it reads on the card. A card is a third-level heading under the board's own title: the
 * board's `<h2>` (kanban-header) and then the cards, with no level skipped in between. As an `h4` the
 * card jumped a level, which is what a browser reading this surface reports as heading-order.
 *
 * The heading is the card's heading and nothing else: the card's title gestures live on the
 * button inside it — a click opens the detail — and the rename doors are the pencil beside it and
 * `F2` on the button. The heading carries no type of its own either: the size and weight sit
 * on the wrapper in `CardBody`, because a note's stylesheet owns an `h3` and would win any utility
 * written here (styles/kanban.css hands it back for the board's own markup).
 *
 * The rename button stands beside the heading rather than inside it, and that is not only a matter of
 * taste: the heading is what the browser reads out as the card's name, and it is the box the reveal
 * rows are measured against — a control drawn *within* it would read as a control covering the title
 * it belongs to. Beside it, with the row's gap between them, the two boxes never meet.
 */
function CardTitleView({
  title,
  icon,
  onStartEditing,
  onTitleClick,
  onTitleKeyDown,
}: {
  title: string
  icon?: string
  onStartEditing: () => void
  onTitleClick: () => void
  onTitleKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void
}) {
  return (
    <div className='flex items-start gap-[var(--sp-1-5)] text-[var(--text-primary)]'>
      <h3 className='flex min-w-0 items-start gap-[var(--sp-1-5)]'>
        {icon && (
          <span className='mt-[var(--sp-0-5)] shrink-0'>
            <KanbanIconBadge icon={icon} size={15} />
          </span>
        )}
        <button
          type='button'
          onClick={onTitleClick}
          onKeyDown={onTitleKeyDown}
          className='line-clamp-2 min-w-0 cursor-pointer text-left hover:text-[var(--accent)]'
        >
          {title || t('preview.kanban_untitled')}
        </button>
      </h3>
      <CardRenameButton onStartEditing={onStartEditing} />
    </div>
  )
}

export function CardTitle({
  title,
  icon,
  isEditing,
  titleText,
  onChangeText,
  onStartEditing,
  onTitleClick,
  onTitleKeyDown,
  onBlur,
  onCancel,
}: {
  title: string
  icon?: string
  isEditing: boolean
  titleText: string
  onChangeText: (text: string) => void
  onStartEditing: () => void
  onTitleClick: () => void
  onTitleKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void
  onBlur: () => void
  onCancel: () => void
}) {
  if (isEditing) {
    return <CardTitleEditor icon={icon} titleText={titleText} onChangeText={onChangeText} onBlur={onBlur} onCancel={onCancel} />
  }

  return (
    <CardTitleView
      title={title}
      icon={icon}
      onStartEditing={onStartEditing}
      onTitleClick={onTitleClick}
      onTitleKeyDown={onTitleKeyDown}
    />
  )
}
