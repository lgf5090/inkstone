import { useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import { t } from '../../../i18n'

/**
 * The board's own name, and the one place it is written from. Both hosts draw it — the note's block
 * and the full screen overlay — because the board is the same board in either, and a reader who
 * titled it in the overlay was until now unable to see that name beside the note.
 *
 * The name is not the block's own label: the markup a fence renders says which syntax the body holds
 * and nothing about the board, so the title can only come from here. That is also why the fallback is
 * the board's type name rather than the cards' "untitled" wording — an unnamed board is a kanban, not
 * an unnamed task.
 *
 * It lives beside the header rather than inside it because the two halves of the edit — a heading that
 * turns into an input and back — are a control of their own: the header only decides where it stands.
 */
function KanbanBoardTitleEditor({
  value,
  onChange,
  onFinish,
  onCancel,
}: {
  value: string
  onChange: (v: string) => void
  onFinish: () => void
  onCancel: () => void
}) {
  return (
    <input
      type='text'
      data-owns-escape='true'
      value={value}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onFocus={(e) => e.target.select()}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onFinish}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onFinish()
        else if (e.key === 'Escape') onCancel()
      }}
      className='min-w-28 max-w-56 rounded-[var(--r-md)] border border-[var(--accent)] bg-[var(--bg-inset)] px-2 py-0.5 text-[length:var(--text-14)] font-bold text-[var(--text-primary)] outline-none'
    />
  )
}

function KanbanBoardTitleView({
  title,
  canEdit,
  onStartEdit,
}: {
  title?: string
  canEdit: boolean
  onStartEdit: (e?: React.MouseEvent) => void
}) {
  return (
    // `shrink-0`: the title is the one thing in the bar that may not be given away. It was `min-w-0`
    // while the view strip beside it kept its whole width, so a wide bar ellipsized the board's own
    // name (56px of "Gate Board" in a 1280px bar) — and a clipped text run is also what a11y tooling
    // reads as "partially obscured", which is how the squeeze surfaced. The strip is the half that
    // gives way instead: it scrolls sideways, and the title keeps its own width up to its own cap.
    //
    // That cap follows the bar's width, which is what the header's own `@container` is for: in the
    // note's pane — a few hundred pixels — 176px of name left the strip 26px, narrower than the tab it
    // had to scroll into view (read by the visual gate's tab assertion, 2026-09-23). The name still
    // keeps its whole width up to the cap; only the cap is smaller where the room is.
    <div className='group flex shrink-0 items-center gap-1'>
      <h2
        onDoubleClick={onStartEdit}
        className={`text-[length:var(--text-14)] font-bold tracking-[var(--tracking-title)] text-[var(--text-primary)] max-w-28 @4xl:max-w-44 truncate select-none ${
          canEdit ? 'cursor-pointer hover:opacity-80' : ''
        }`}
        title={title || t('preview.kanban')}
      >
        {title || t('preview.kanban')}
      </h2>
      {canEdit && (
        <button
          type='button'
          onClick={onStartEdit}
          className='opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:!opacity-100 transition-opacity p-0.5 rounded-[var(--r-xs)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
          title={t('common.edit')}
          aria-label={t('common.edit')}
        >
          <Pencil size={11} aria-hidden />
        </button>
      )}
    </div>
  )
}

export function KanbanBoardTitle({
  title,
  onUpdateTitle,
}: {
  title?: string
  onUpdateTitle?: (title: string) => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [val, setVal] = useState(title || '')

  useEffect(() => {
    if (!isEditing) setVal(title || '')
  }, [title, isEditing])

  const handleFinish = () => {
    setIsEditing(false)
    const trimmed = val.trim()
    if (trimmed && trimmed !== title) onUpdateTitle?.(trimmed)
    else setVal(title || '')
  }

  const startEditing = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!onUpdateTitle) return
    setVal(title || '')
    setIsEditing(true)
  }

  if (isEditing && onUpdateTitle) {
    return (
      <KanbanBoardTitleEditor
        value={val}
        onChange={setVal}
        onFinish={handleFinish}
        onCancel={() => {
          setVal(title || '')
          setIsEditing(false)
        }}
      />
    )
  }

  return (
    <KanbanBoardTitleView
      title={title}
      canEdit={Boolean(onUpdateTitle)}
      onStartEdit={startEditing}
    />
  )
}
