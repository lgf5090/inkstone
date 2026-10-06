import { memo, useId, useState } from 'react'
import { ChevronLeft, Palette, Trash2 } from 'lucide-react'
import { t, useLocaleRepaint } from '../../../i18n'
import { getKanbanDotColor } from '../colors'
import { normalizeKanbanWipLimit } from '../filter-sort'
import { formatKanbanColorName } from '../i18n-helpers'
import type { KanbanColorName } from '../types'
import { KanbanPanel } from './kanban-panel'

interface KanbanColumnMenuProps {
  open: boolean
  panelId: string
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement | null>
  groupKey: string
  label: string
  color?: KanbanColorName
  wipLimit?: number
  onRename: (newLabel: string) => void
  onChangeColor: (newColor: KanbanColorName) => void
  onChangeWipLimit: (limit: number | undefined) => void
  onCollapse?: () => void
  onDelete?: () => void
  /** Absent where nothing above this menu can answer for a whole column — a band's own header. */
  selectAll?: KanbanColumnSelectAll
}

export interface KanbanColumnSelectAll {
  /** How many cards the column draws, so the row is not offered over an empty one. */
  count: number
  isAllSelected: boolean
  onToggle: () => void
}

/**
 * Picking a whole column is the gesture the batch bar was waiting for, and a checkbox is the control
 * that can say whether the column is already picked: ticking it settles every card of the column to
 * that state, and unticking it gives the column back to the board untouched.
 */
function ColumnSelectAllRow({ count, isAllSelected, onToggle }: KanbanColumnSelectAll) {
  const fieldId = useId()
  return (
    <label
      htmlFor={fieldId}
      className='flex items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
    >
      <input
        id={fieldId}
        type='checkbox'
        checked={isAllSelected}
        disabled={count === 0}
        onChange={onToggle}
        className='size-3.5 rounded-[var(--r-xs)] border-[var(--border-default)] accent-[var(--accent)]'
      />
      <span>{t('preview.kanban_select_group')}</span>
    </label>
  )
}

const AVAILABLE_COLORS: KanbanColorName[] = [
  'gray',
  'blue',
  'green',
  'yellow',
  'orange',
  'purple',
  'pink',
  'red',
]

function ColorPaletteRow({
  activeColor,
  onChangeColor,
}: {
  activeColor?: KanbanColorName
  onChangeColor: (color: KanbanColorName) => void
}) {
  return (
    <div className='flex items-center gap-1.5 px-2 py-1'>
      <Palette size={13} className='text-[var(--text-tertiary)]' />
      <span className='text-[length:var(--text-11)] text-[var(--text-secondary)]'>
        {t('preview.kanban_column_color')}
      </span>
      <div className='ml-auto flex items-center gap-1'>
        {AVAILABLE_COLORS.map((c) => (
          <button
            key={c}
            type='button'
            onClick={() => onChangeColor(c)}
            style={{ backgroundColor: getKanbanDotColor(c) }}
            className={`size-3.5 rounded-full transition-transform hover:scale-125 ${
              activeColor === c ? 'ring-2 ring-[var(--accent)] ring-offset-1' : ''
            }`}
            aria-label={formatKanbanColorName(c)}
          />
        ))}
      </div>
    </div>
  )
}

function ColumnRenameInput({
  initialName,
  onRename,
  onClose,
}: {
  initialName: string
  onRename: (newLabel: string) => void
  onClose: () => void
}) {
  const [editingName, setEditingName] = useState(initialName)

  const handleRenameSubmit = () => {
    if (editingName.trim() && editingName !== initialName) {
      onRename(editingName.trim())
    }
  }

  return (
    <div className='px-1 py-1'>
      <input
        type='text'
        value={editingName}
        onChange={(e) => setEditingName(e.target.value)}
        onBlur={handleRenameSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleRenameSubmit()
            onClose()
          }
        }}
        placeholder={t('preview.kanban_column_name_placeholder')}
        className='w-full rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 py-1 text-[length:var(--text-12)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]'
      />
    </div>
  )
}

/** Below this the field is not asking for a count of cards, so nothing is written. */
const WIP_LIMIT_MIN = 1

type WipLimitDraft = { ok: true; value: number | undefined } | { ok: false }

function parseWipLimitDraft(draft: string): WipLimitDraft {
  const text = draft.trim()
  if (text === '') return { ok: true, value: undefined }
  const limit = normalizeKanbanWipLimit(Number(text))
  return limit === undefined ? { ok: false } : { ok: true, value: limit }
}

/**
 * A limit is a count of cards, so a draft that is not one is refused where it is typed, and the
 * notice sits in the dialog rather than in a popup. Blank means no rule, which is what the hint
 * says. The same number is validated again by the writer and again by the reader, because it may
 * also have arrived in a fence someone wrote by hand.
 */
function ColumnWipLimitField({
  initialLimit,
  onChangeLimit,
  onClose,
}: {
  initialLimit?: number
  onChangeLimit: (limit: number | undefined) => void
  onClose: () => void
}) {
  const fieldId = useId()
  const noticeId = useId()
  const [draft, setDraft] = useState(initialLimit === undefined ? '' : String(initialLimit))
  const parsed = parseWipLimitDraft(draft)
  const invalid = !parsed.ok

  const submit = (close: boolean) => {
    if (!parsed.ok) return
    if (parsed.value !== initialLimit) onChangeLimit(parsed.value)
    if (close) onClose()
  }

  return (
    <div className='flex flex-col gap-1 px-2 py-1'>
      <label htmlFor={fieldId} className='flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-secondary)]'>
        <span className='shrink-0'>{t('preview.kanban_wip_limit')}</span>
        <input
          id={fieldId}
          type='number'
          min={WIP_LIMIT_MIN}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => submit(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit(true)
          }}
          aria-invalid={invalid || undefined}
          aria-describedby={noticeId}
          className='w-16 rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 py-1 text-[length:var(--text-12)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]'
        />
      </label>
      <span id={noticeId} role='status' className='text-[length:var(--text-10)] text-[var(--text-tertiary)]'>
        {invalid ? t('preview.kanban_wip_limit_invalid') : t('preview.kanban_wip_limit_hint')}
      </span>
    </div>
  )
}

function ColumnActionButtons({
  onCollapse,
  onDelete,
  onClose,
  isNoneGroup,
}: {
  onCollapse?: () => void
  onDelete?: () => void
  onClose: () => void
  isNoneGroup: boolean
}) {
  return (
    <>
      {onCollapse && (
        <button
          type='button'
          onClick={() => {
            onCollapse()
            onClose()
          }}
          className='flex items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
        >
          <ChevronLeft size={14} />
          <span>{t('preview.kanban_collapse_column')}</span>
        </button>
      )}

      {onDelete && !isNoneGroup && (
        <button
          type='button'
          onClick={() => {
            onDelete()
            onClose()
          }}
          className='flex items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-[length:var(--text-12)] text-[var(--danger)] hover:bg-[var(--bg-hover)]'
        >
          <Trash2 size={14} />
          <span>{t('preview.kanban_delete_column')}</span>
        </button>
      )}
    </>
  )
}

export const KanbanColumnMenu = memo(function KanbanColumnMenu({
  open,
  onClose,
  anchorRef,
  groupKey,
  label,
  color,
  wipLimit,
  onRename,
  onChangeColor,
  onChangeWipLimit,
  onCollapse,
  onDelete,
  selectAll,
  panelId,
}: KanbanColumnMenuProps) {
  useLocaleRepaint()

  // No Status is not a workflow state the board owns — it is wherever the cards that named none
  // landed — so there is no option to write a name, a colour or a limit onto.
  const isNoneGroup = groupKey === '__none__'

  return (
    <KanbanPanel
      open={open}
      panelId={panelId}
      label={t('preview.kanban_column_options')}
      anchorRef={anchorRef}
      onClose={onClose}
      className='z-[var(--z-menu)] flex w-56 flex-col gap-1 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-1.5 shadow-[var(--shadow-pop)]'
    >
      {!isNoneGroup && (
        <ColumnRenameInput initialName={label} onRename={onRename} onClose={onClose} />
      )}
      {!isNoneGroup && (
        <ColumnWipLimitField initialLimit={wipLimit} onChangeLimit={onChangeWipLimit} onClose={onClose} />
      )}
      {!isNoneGroup && (
        <ColorPaletteRow activeColor={color} onChangeColor={onChangeColor} />
      )}
      {selectAll && <ColumnSelectAllRow {...selectAll} />}
      <ColumnActionButtons
        onCollapse={onCollapse}
        onDelete={onDelete}
        onClose={onClose}
        isNoneGroup={isNoneGroup}
      />
    </KanbanPanel>
  )
})
