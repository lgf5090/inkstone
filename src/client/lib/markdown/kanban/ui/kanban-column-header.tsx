import { useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { t } from '../../../i18n'
import { getKanbanDotColor, getKanbanTintStyle } from '../colors'
import { kanbanWipOver, type KanbanGroup } from '../filter-sort'
import { formatKanbanGroupLabel, formatKanbanSum } from '../i18n-helpers'
import type { KanbanColorName } from '../types'
import { KanbanColumnCount } from './kanban-column-count'
import { KanbanColumnMenu } from './kanban-column-menu'

export function ColumnHeaderTitle({
  label,
  count,
  wipLimit,
  sum,
  sumName,
  isTinted,
}: {
  label: string
  count: number
  wipLimit?: number
  /** The total of the view's number column over this column's cards; absent when the view sums none. */
  sum?: number
  sumName?: string
  isTinted: boolean
}) {
  const sumWords = sum !== undefined && sumName !== undefined
    ? t('preview.kanban_column_sum', { name: sumName, count: sum })
    : undefined
  return (
    <div className='flex min-w-0 items-center gap-[var(--sp-2)]'>
      <span
        className={`truncate text-[length:var(--text-13)] font-semibold ${isTinted ? '' : 'text-[var(--text-primary)]'}`}
      >
        {label}
      </span>
      <KanbanColumnCount
        count={count}
        limit={wipLimit}
        className='shrink-0 rounded-[var(--r-full)] bg-[var(--bg-inset)] px-[var(--sp-2)] py-[var(--sp-0-5)] text-[length:var(--text-11)] font-medium'
      />
      {sum !== undefined && sumWords && (
        // Same surface recipe as the count pill, so the two read as one family. The glyph and figure
        // are for the eye; the sentence is what a screen reader is given, since "Σ 12" alone says
        // nothing about what was added up.
        <span
          data-kanban-sum=''
          title={sumWords}
          className='shrink-0 rounded-[var(--r-full)] bg-[var(--bg-inset)] px-[var(--sp-2)] py-[var(--sp-0-5)] text-[length:var(--text-11)] font-medium tabular-nums text-[var(--text-tertiary)]'
        >
          <span aria-hidden='true'>{t('preview.kanban_column_sum_figure', { count: formatKanbanSum(sum) })}</span>
          <span className='sr-only'>{sumWords}</span>
        </span>
      )}
    </div>
  )
}

/**
 * The column's own menu trigger. It is drawn in the band's colour when the band has one, because that
 * colour is the calibrated foreground for the tint behind it — a tier of its own here would be a pair
 * nothing has measured.
 */
function ColumnMenuButton({
  buttonRef,
  label,
  panelId,
  isTinted,
  isOpen,
  onToggle,
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>
  label: string
  panelId: string
  isTinted: boolean
  isOpen: boolean
  onToggle: () => void
}) {
  return (
    <button
      ref={buttonRef}
      type='button'
      onClick={onToggle}
      className={`rounded-[var(--r-xs)] p-[var(--sp-0-5)] hover:bg-[var(--bg-hover)] ${
        isTinted ? 'hover:text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
      }`}
      aria-label={label}
      aria-haspopup='dialog'
      aria-expanded={isOpen}
      {...(isOpen ? { 'aria-controls': panelId } : {})}
    >
      <MoreHorizontal size={14} />
    </button>
  )
}

/**
 * The header band as it is painted: one row, wearing the column's colour, with the column's title and
 * its own menu trigger inside it, and the menu panel handed in as children so the band stays the
 * element the panel hangs in. It is a component of its own because the band is what a reader sees
 * while the header around it is the menu's wiring — one body for both was mostly a prop list.
 */
function ColumnHeaderBand({
  groupKey,
  label,
  count,
  wipLimit,
  sum,
  sumName,
  color,
  tint,
  menuBtnRef,
  panelId,
  isMenuOpen,
  onToggleMenu,
  onDragStart,
  children,
}: {
  groupKey: string
  label: string
  count: number
  wipLimit?: number
  sum?: number
  sumName?: string
  color?: KanbanColorName
  tint: CSSProperties | undefined
  menuBtnRef: React.RefObject<HTMLButtonElement | null>
  panelId: string
  isMenuOpen: boolean
  onToggleMenu: () => void
  onDragStart: (e: React.DragEvent) => void
  children: ReactNode
}) {
  return (
    <div
      draggable={groupKey !== '__none__'}
      onDragStart={onDragStart}
      style={tint}
      data-kanban-column-head=''
      data-kanban-column-tint={tint ? color : undefined}
      className='relative flex cursor-grab items-center justify-between rounded-[var(--r-sm)] px-[var(--sp-2)] py-[var(--sp-1-5)] active:cursor-grabbing'
    >
      <ColumnHeaderTitle label={label} count={count} wipLimit={wipLimit} sum={sum} sumName={sumName} isTinted={tint !== undefined} />
      <ColumnMenuButton
        buttonRef={menuBtnRef}
        label={label}
        panelId={panelId}
        isTinted={Boolean(tint)}
        isOpen={isMenuOpen}
        onToggle={onToggleMenu}
      />
      {children}
    </div>
  )
}

export function KanbanColumnHeader({
  groupKey,
  label,
  count,
  color,
  wipLimit,
  sum,
  sumName,
  onDragStart,
  onRename,
  onChangeColor,
  onChangeWipLimit,
  onCollapse,
  onDelete,
  onToggleSelectAll,
  isAllSelected,
}: {
  groupKey: string
  label: string
  count: number
  color?: KanbanColorName
  wipLimit?: number
  /** The view's number total over this column's cards, with the column's name to say what it sums. */
  sum?: number
  sumName?: string
  onDragStart: (e: React.DragEvent) => void
  onRename: (newLabel: string) => void
  onChangeColor: (newColor: KanbanColorName) => void
  onChangeWipLimit: (limit: number | undefined) => void
  /** Absent where a column has no narrower form to fold into — the strip of a banded board. */
  onCollapse?: () => void
  onDelete?: () => void
  /** Both are absent together: a host that cannot pick cards grows no select-all row at all. */
  onToggleSelectAll?: () => void
  isAllSelected?: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const localizedLabel = formatKanbanGroupLabel(groupKey, label)
  // The whole band wears the column's colour, which is the board's own answer to "which column is
  // which": it used to be a 10px dot and nothing else, so every column looked alike. Everything else
  // in the band stays on a surface of its own — the count pill is opaque and paints its own tier — so
  // the only text on the tint is text painted in the colour the tint was mixed from.
  const tint = getKanbanTintStyle(color)

  return (
    <ColumnHeaderBand
      groupKey={groupKey}
      label={localizedLabel}
      count={count}
      wipLimit={wipLimit}
      sum={sum}
      sumName={sumName}
      color={color}
      tint={tint}
      menuBtnRef={menuBtnRef}
      panelId={panelId}
      isMenuOpen={menuOpen}
      onToggleMenu={() => setMenuOpen((o) => !o)}
      onDragStart={onDragStart}
    >
      <KanbanColumnMenu
        open={menuOpen}
        panelId={panelId}
        onClose={() => setMenuOpen(false)}
        anchorRef={menuBtnRef}
        groupKey={groupKey}
        label={label}
        color={color}
        wipLimit={wipLimit}
        onRename={onRename}
        onChangeColor={onChangeColor}
        onChangeWipLimit={onChangeWipLimit}
        onCollapse={onCollapse}
        onDelete={onDelete}
        {...(onToggleSelectAll
          ? { selectAll: { count, isAllSelected: Boolean(isAllSelected), onToggle: onToggleSelectAll } }
          : {})}
      />
    </ColumnHeaderBand>
  )
}

export function CollapsedColumn({
  group,
  onExpand,
  onDrop,
  onDragOver,
  isDragOver,
}: {
  group: KanbanGroup
  onExpand: () => void
  onDrop: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  isDragOver: boolean
}) {
  const dotColor = getKanbanDotColor(group.color)
  const localizedLabel = formatKanbanGroupLabel(group.groupKey, group.label)
  // The strip's own label replaces everything inside the button, so the state the pill shows has to
  // be said here too or a screen reader gets the count of no column at all.
  const over = kanbanWipOver(group.items.length, group.wipLimit)

  return (
    <button
      type='button'
      data-kanban-group={group.groupKey}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onExpand}
      aria-label={over > 0
        ? t('preview.kanban_expand_column_over', { name: localizedLabel, over, limit: group.wipLimit ?? 0 })
        : t('preview.kanban_expand_column_named', { name: localizedLabel })}
      className={`flex w-[var(--sp-10)] shrink-0 cursor-pointer flex-col items-center rounded-[var(--r-lg)] border py-[var(--sp-3)] transition-colors ${
        isDragOver
          ? 'border-[var(--accent)] bg-[var(--accent-softer)]'
          : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)]'
      }`}
    >
      <span className='flex flex-col items-center gap-[var(--sp-2)]'>
        {dotColor && <span className='size-2.5 rounded-full' style={{ backgroundColor: dotColor }} />}
        <KanbanColumnCount
          count={group.items.length}
          limit={group.wipLimit}
          className='rounded-[var(--r-full)] bg-[var(--bg-inset)] px-[var(--sp-1)] py-[var(--sp-0-5)] text-[length:var(--text-10)]'
        />
      </span>
      <span className='mt-[var(--sp-4)] flex flex-1 items-center justify-center [writing-mode:vertical-rl] text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]'>
        {localizedLabel}
      </span>
    </button>
  )
}
