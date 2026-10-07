import { useId, useRef, useState } from 'react'
import { Keyboard } from 'lucide-react'
import { IconButton, Kbd } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { t, type MessageKey } from '../../../i18n'
import { KANBAN_BOARD_CHORDS } from './kanban-board-keys'
import { KanbanPanel } from './kanban-panel'

/**
 * The board's keyboard reference: what the arrows do to the focus, what Shift does to the card under
 * it, and the chords the board answers to from anywhere in it.
 *
 * Half of it is *derived* from `kanban-board-keys.ts` rather than written out again — the reader is
 * looking at the board's own chord table, so a chord that stops working or a new one that arrives
 * changes this card in the same edit. The other half is the gestures the card and the board's other
 * controls own (`Shift`+arrow moves the card, `F2` renames it, the title's `Enter` opens it), which
 * have no table to be read from and are listed here because a reader looking for them will look here.
 */
interface ShortcutRow {
  combo?: string
  keys?: string[]
  messageKey: MessageKey
}

const DERIVED_ROWS: ShortcutRow[] = KANBAN_BOARD_CHORDS.map((chord) => ({
  combo: chord.key,
  messageKey: chord.messageKey,
}))

const GESTURE_ROWS: ShortcutRow[] = [
  { keys: ['Shift', '↑↓←→'], messageKey: 'preview.kanban_key_move_card' },
  { combo: 'enter', messageKey: 'preview.kanban_key_open_card' },
  { keys: ['F2'], messageKey: 'preview.kanban_key_rename_card' },
  { combo: 'mod+z', messageKey: 'common.undo' },
  { combo: 'mod+shift+z', messageKey: 'command.redo' },
  { combo: 'escape', messageKey: 'preview.kanban_key_dismiss' },
]

/** Exported so a test can hold the card to the chords the board actually answers to. */
export const KANBAN_SHORTCUT_ROWS: ShortcutRow[] = [...DERIVED_ROWS, ...GESTURE_ROWS]

/** The panel itself, drawn by whichever trigger opened it — the toolbar button or a menu row. */
export function KanbanShortcutsPanel({
  open,
  panelId,
  anchorRef,
  onClose,
}: {
  open: boolean
  panelId: string
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}) {
  return (
    <KanbanPanel
      open={open}
      panelId={panelId}
      label={t('preview.kanban_shortcuts')}
      anchorRef={anchorRef}
      onClose={onClose}
      className='z-[var(--z-menu)] w-72 flex-col gap-1.5 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-2.5 shadow-[var(--shadow-pop)]'
    >
      <ul className='flex flex-col gap-1.5'>
        {KANBAN_SHORTCUT_ROWS.map((row, index) => (
          <li
            key={`${row.messageKey}-${index}`}
            className='flex items-center justify-between gap-3 text-[length:var(--text-12)] text-[var(--text-secondary)]'
          >
            <span className='min-w-0'>{t(row.messageKey)}</span>
            {row.combo ? <Kbd combo={row.combo} /> : <Kbd keys={row.keys} />}
          </li>
        ))}
      </ul>
    </KanbanPanel>
  )
}

/**
 * The wide bar's control for it. A reader who has just arrived at a board full of chords is exactly the
 * reader who needs this, so it sits with the other controls rather than behind the palette.
 */
export function KanbanShortcutsAction() {
  const [isOpen, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const label = t('preview.kanban_shortcuts')

  return (
    <>
      <Tooltip label={label}>
        <IconButton
          ref={buttonRef}
          label={label}
          // The default step rather than the small one: it sits in the board's toolbar, where every
          // icon control is sized for a finger on a phone (`kanban-header.test.ts` holds that line).
          active={isOpen}
          onClick={() => setOpen((open) => !open)}
          aria-haspopup='dialog'
          aria-expanded={isOpen}
          {...(isOpen ? { 'aria-controls': panelId } : {})}
        >
          <Keyboard size={14} aria-hidden />
        </IconButton>
      </Tooltip>
      <KanbanShortcutsPanel open={isOpen} panelId={panelId} anchorRef={buttonRef} onClose={() => setOpen(false)} />
    </>
  )
}
