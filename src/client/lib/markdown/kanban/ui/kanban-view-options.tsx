import { memo, useId, useState } from 'react'
import { ArrowDown, ArrowUp, Columns3, Pencil, Plus, Rows3, Settings2, Sliders, Trash2 } from 'lucide-react'
import { t, useLocaleRepaint } from '../../../i18n'
import { formatKanbanPropertyName } from '../i18n-helpers'
import type { KanbanProperty, KanbanPropertyType } from '../types'
import {
  formatKanbanColumnTypeLabel,
  KANBAN_EDITABLE_TYPES,
  type KanbanSchemaOperations,
} from './kanban-column-hooks'
import { Segmented, Select } from '../../../../components/form'
import { CardFieldsSection } from './kanban-card-fields-section'
import { KanbanPanel, PANEL_FIELD } from './kanban-panel'
import { SumBySection } from './kanban-sum-section'
import { kanbanPropertyColumns } from './kanban-property-cell'

export type CardSize = 'small' | 'medium' | 'large'

interface KanbanViewOptionsProps {
  open: boolean
  panelId: string
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement | null>
  columns: KanbanProperty[]
  groupBy?: string
  swimlaneBy?: string
  cardSize?: CardSize
  hiddenColumns?: string[]
  cardFields?: string[]
  sumBy?: string
  onChangeGroupBy?: (propId: string) => void
  onChangeSwimlaneBy?: (propId: string | undefined) => void
  onChangeCardSize?: (size: CardSize) => void
  onChangeSumBy?: (propId: string | undefined) => void
  onToggleHiddenColumn?: (propertyId: string) => void
  onToggleCardField?: (propertyId: string) => void
  schemaOps?: KanbanSchemaOperations
}

const CARD_SIZES: { id: CardSize; labelKey: 'preview.kanban_card_size_small' | 'preview.kanban_card_size_medium' | 'preview.kanban_card_size_large' }[] = [
  { id: 'small', labelKey: 'preview.kanban_card_size_small' },
  { id: 'medium', labelKey: 'preview.kanban_card_size_medium' },
  { id: 'large', labelKey: 'preview.kanban_card_size_large' },
]

function GroupBySection({
  groupBy,
  columns,
  onChangeGroupBy,
}: {
  groupBy: string
  columns: KanbanProperty[]
  onChangeGroupBy: (propId: string) => void
}) {
  const eligibleColumns = columns.filter((c) => c.id !== 'title')
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='flex items-center gap-1.5 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]'>
        <Sliders size={13} />
        <span>{t('preview.kanban_group_by')}</span>
      </div>
      <Select
        value={groupBy}
        onChange={(e) => onChangeGroupBy(e.target.value)}
        aria-label={t('preview.kanban_group_by')}
        className={`${PANEL_FIELD} h-8 md:h-8 bg-[var(--bg-raised)] text-[length:var(--text-12)]`}
      >
        {eligibleColumns.map((col) => (
          <option key={col.id} value={col.id}>
            {formatKanbanPropertyName(col)}
          </option>
        ))}
      </Select>
    </div>
  )
}

/**
 * A band is a named row of the board, so only a field with a list of named values can cut one, and
 * the field the columns already use would give a board where every band holds exactly one column.
 */
function swimlaneCandidates(columns: KanbanProperty[], groupBy: string, current?: string): KanbanProperty[] {
  const eligible = columns.filter(
    (col) => col.id !== groupBy && col.id !== 'title' && (col.options?.length ?? 0) > 0,
  )
  if (!current || eligible.some((col) => col.id === current)) return eligible
  // A field set before it stopped qualifying stays listed, so the board does not read as unbanded
  // while it is still drawing bands off it.
  const pinned = columns.find((col) => col.id === current)
  return pinned ? [...eligible, pinned] : eligible
}

function SwimlaneBySection({
  swimlaneBy,
  groupBy,
  columns,
  onChangeSwimlaneBy,
}: {
  swimlaneBy?: string
  groupBy: string
  columns: KanbanProperty[]
  onChangeSwimlaneBy: (propId: string | undefined) => void
}) {
  const candidates = swimlaneCandidates(columns, groupBy, swimlaneBy)
  const fieldId = useId()
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='flex items-center gap-1.5 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]'>
        <Rows3 size={13} aria-hidden />
        <label htmlFor={fieldId}>{t('preview.kanban_swimlane_by')}</label>
      </div>
      <Select
        id={fieldId}
        value={swimlaneBy ?? ''}
        onChange={(e) => onChangeSwimlaneBy(e.target.value || undefined)}
        className={`${PANEL_FIELD} h-8 md:h-8 bg-[var(--bg-raised)] text-[length:var(--text-12)]`}
      >
        <option value=''>{t('preview.kanban_swimlane_off')}</option>
        {candidates.map((col) => (
          <option key={col.id} value={col.id}>
            {formatKanbanPropertyName(col)}
          </option>
        ))}
      </Select>
    </div>
  )
}

function CardSizeSection({
  cardSize,
  onChangeCardSize,
}: {
  cardSize: CardSize
  onChangeCardSize: (size: CardSize) => void
}) {
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='flex items-center gap-1.5 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]'>
        <Settings2 size={13} />
        <span>{t('preview.kanban_card_size')}</span>
      </div>
      {/* The project's own segmented control: one radio group, so the chosen size is a state the
          browser reads out rather than a colour the reader has to notice. */}
      <Segmented
        value={cardSize}
        onChange={onChangeCardSize}
        size='sm'
        label={t('preview.kanban_card_size')}
        options={CARD_SIZES.map(({ id, labelKey }) => ({ value: id, label: t(labelKey) }))}
      />
    </div>
  )
}

/** A schema column has an entry in `data.columns`; the attachments column the table draws does not. */
function isSchemaColumn(columns: KanbanProperty[], column: KanbanProperty): boolean {
  return column.type !== 'title' && column.type !== 'files' && columns.some((col) => col.id === column.id)
}

const EDITOR_ICON_BUTTON = 'inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:pointer-events-none disabled:opacity-40'
const EDITOR_FIELD = `${PANEL_FIELD} w-full min-w-0 pr-1.5 bg-[var(--bg-raised)] text-[length:var(--text-12)]`

function ColumnTypeSelect({
  label,
  value,
  onChange,
}: {
  label: string
  value: KanbanPropertyType
  onChange: (type: KanbanPropertyType) => void
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as KanbanPropertyType)}
      className={EDITOR_FIELD}
    >
      {KANBAN_EDITABLE_TYPES.map((type) => (
        <option key={type} value={type}>
          {formatKanbanColumnTypeLabel(type)}
        </option>
      ))}
    </Select>
  )
}

// A draft, committed once: every keystroke would put a rewrite of the whole document in the undo
// stack, and typing a name is one edit however long it takes.
function ColumnNameField({
  column,
  onRename,
}: {
  column: KanbanProperty
  onRename: (propertyId: string, name: string) => void
}) {
  const [draft, setDraft] = useState(column.name)
  const commit = () => {
    const next = draft.trim()
    if (next && next !== column.name) onRename(column.id, next)
  }
  return (
    <input
      type='text'
      value={draft}
      data-owns-escape='true'
      aria-label={t('preview.kanban_column_name_field')}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setDraft(column.name)
      }}
      className={EDITOR_FIELD}
    />
  )
}

function ColumnSchemaEditor({
  editorId,
  column,
  canMoveUp,
  canMoveDown,
  schemaOps,
}: {
  editorId: string
  column: KanbanProperty
  canMoveUp: boolean
  canMoveDown: boolean
  schemaOps: KanbanSchemaOperations
}) {
  return (
    <div
      id={editorId}
      role='group'
      aria-label={formatKanbanPropertyName(column)}
      className='m-1 flex flex-col gap-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-1.5'
    >
      <ColumnNameField column={column} onRename={schemaOps.renameColumn} />
      <ColumnTypeSelect
        label={t('preview.kanban_column_type')}
        value={column.type}
        onChange={(type) => schemaOps.changeColumnType(column.id, type)}
      />
      <div className='flex items-center gap-1'>
        <button
          type='button'
          aria-label={t('preview.kanban_move_column_up')}
          disabled={!canMoveUp}
          onClick={() => schemaOps.moveColumn(column.id, -1)}
          className={EDITOR_ICON_BUTTON}
        >
          <ArrowUp size={12} />
        </button>
        <button
          type='button'
          aria-label={t('preview.kanban_move_column_down')}
          disabled={!canMoveDown}
          onClick={() => schemaOps.moveColumn(column.id, 1)}
          className={EDITOR_ICON_BUTTON}
        >
          <ArrowDown size={12} />
        </button>
        <button
          type='button'
          aria-label={t('preview.kanban_delete_this_column')}
          onClick={() => schemaOps.deleteColumn(column.id)}
          className={`${EDITOR_ICON_BUTTON} ml-auto hover:text-[var(--danger)]`}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}

function AddColumnRow({ schemaOps }: { schemaOps: KanbanSchemaOperations }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<KanbanPropertyType>('text')
  const submit = () => {
    const label = name.trim()
    if (!label) return
    schemaOps.addColumn(label, type)
    setName('')
  }
  return (
    <div data-kanban-column-add className='flex items-center gap-1 border-t border-[var(--border-subtle)] pt-1.5'>
      <input
        type='text'
        value={name}
        data-owns-escape='true'
        aria-label={t('preview.kanban_column_name_field')}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
        className={`${EDITOR_FIELD} flex-1`}
      />
      <div className='w-24 shrink-0'>
        <ColumnTypeSelect label={t('preview.kanban_column_type')} value={type} onChange={setType} />
      </div>
      <button
        type='button'
        aria-label={t('preview.kanban_add_column')}
        disabled={!name.trim()}
        onClick={submit}
        className={EDITOR_ICON_BUTTON}
      >
        <Plus size={13} />
      </button>
    </div>
  )
}

function ColumnRow({
  column,
  editable,
  isFirst,
  isLast,
  hiddenColumns,
  onToggleHiddenColumn,
  schemaOps,
}: {
  column: KanbanProperty
  editable: boolean
  isFirst: boolean
  isLast: boolean
  hiddenColumns: string[]
  onToggleHiddenColumn: (propertyId: string) => void
  schemaOps?: KanbanSchemaOperations
}) {
  const editorId = useId()
  const [editing, setEditing] = useState(false)
  const name = formatKanbanPropertyName(column)
  const canEdit = editable && schemaOps !== undefined
  return (
    <div className='flex flex-col'>
      <div className='flex items-center gap-1'>
        <label
          className='flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[var(--r-sm)] px-1 py-1 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
        >
          <input
            type='checkbox'
            checked={!hiddenColumns.includes(column.id)}
            onChange={() => onToggleHiddenColumn(column.id)}
            className='size-3.5 shrink-0 rounded-[var(--r-xs)] border-[var(--border-default)] accent-[var(--accent)]'
          />
          <span className='truncate'>{name}</span>
        </label>
        {canEdit && (
          <button
            type='button'
            aria-label={t('preview.kanban_edit_column_named', { name })}
            aria-expanded={editing}
            {...(editing ? { 'aria-controls': editorId } : {})}
            onClick={() => setEditing((open) => !open)}
            className={EDITOR_ICON_BUTTON}
          >
            <Pencil size={12} />
          </button>
        )}
      </div>
      {editing && schemaOps && (
        <ColumnSchemaEditor
          editorId={editorId}
          column={column}
          canMoveUp={!isFirst}
          canMoveDown={!isLast}
          schemaOps={schemaOps}
        />
      )}
    </div>
  )
}

function ColumnsSection({
  columns,
  hiddenColumns,
  onToggleHiddenColumn,
  schemaOps,
}: {
  columns: KanbanProperty[]
  hiddenColumns: string[]
  onToggleHiddenColumn: (propertyId: string) => void
  schemaOps?: KanbanSchemaOperations
}) {
  const rows = kanbanPropertyColumns(columns)
  const editableIds = rows.filter((col) => isSchemaColumn(columns, col)).map((col) => col.id)
  return (
    <fieldset className='flex min-w-0 flex-col gap-1.5'>
      <legend className='flex items-center gap-1.5 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]'>
        <Columns3 size={13} />
        {t('preview.kanban_columns')}
      </legend>
      <div className='flex max-h-56 flex-col gap-0.5 overflow-auto'>
        {rows.map((column) => (
          <ColumnRow
            key={column.id}
            column={column}
            editable={isSchemaColumn(columns, column)}
            isFirst={editableIds[0] === column.id}
            isLast={editableIds.at(-1) === column.id}
            hiddenColumns={hiddenColumns}
            onToggleHiddenColumn={onToggleHiddenColumn}
            schemaOps={schemaOps}
          />
        ))}
      </div>
      {schemaOps && <AddColumnRow schemaOps={schemaOps} />}
    </fieldset>
  )
}

export const KanbanViewOptions = memo(function KanbanViewOptions({
  open,
  panelId,
  onClose,
  anchorRef,
  columns,
  groupBy,
  swimlaneBy,
  cardSize,
  hiddenColumns,
  cardFields,
  sumBy,
  onChangeGroupBy,
  onChangeSwimlaneBy,
  onChangeCardSize,
  onChangeSumBy,
  onToggleHiddenColumn,
  onToggleCardField,
  schemaOps,
}: KanbanViewOptionsProps) {
  useLocaleRepaint()

  // Each section renders when the caller wired it: the board gets grouping and
  // card size, the table gets column visibility, neither sees the other's controls.
  return (
    <KanbanPanel
      open={open}
      panelId={panelId}
      label={t(onToggleHiddenColumn ? 'preview.kanban_columns' : 'preview.kanban_group_by')}
      anchorRef={anchorRef}
      onClose={onClose}
      className='z-[var(--z-menu)] flex w-60 flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-3 shadow-[var(--shadow-pop)]'
    >
      {onChangeGroupBy && groupBy !== undefined && (
        <GroupBySection groupBy={groupBy} columns={columns} onChangeGroupBy={onChangeGroupBy} />
      )}
      {onChangeSwimlaneBy && groupBy !== undefined && (
        <SwimlaneBySection
          swimlaneBy={swimlaneBy}
          groupBy={groupBy}
          columns={columns}
          onChangeSwimlaneBy={onChangeSwimlaneBy}
        />
      )}
      {onChangeCardSize && cardSize !== undefined && (
        <CardSizeSection cardSize={cardSize} onChangeCardSize={onChangeCardSize} />
      )}
      {onChangeSumBy && <SumBySection sumBy={sumBy} columns={columns} onChangeSumBy={onChangeSumBy} />}
      {onToggleHiddenColumn && (
        <ColumnsSection
          columns={columns}
          hiddenColumns={hiddenColumns ?? []}
          onToggleHiddenColumn={onToggleHiddenColumn}
          schemaOps={schemaOps}
        />
      )}
      {onToggleCardField && cardFields !== undefined && (
        <CardFieldsSection columns={columns} cardFields={cardFields} onToggleCardField={onToggleCardField} />
      )}
    </KanbanPanel>
  )
})
