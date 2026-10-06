import { memo } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { t, useLocaleRepaint } from '../../../i18n'
import { formatKanbanPropertyName } from '../i18n-helpers'
import { kanbanFilterOperatorsForType } from '../filter-sort'
import type {
  KanbanFilter,
  KanbanFilterOperator,
  KanbanProperty,
  KanbanPropertyType,
} from '../types'
import { Select } from '../../../../components/form'
import { KanbanPanel, PANEL_FIELD } from './kanban-panel'
import { kanbanStableKeys } from './kanban-list-keys'

interface KanbanFilterPopoverProps {
  open: boolean
  panelId: string
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement | null>
  columns: KanbanProperty[]
  filters: KanbanFilter[]
  onChangeFilters: (filters: KanbanFilter[]) => void
}

/** These read the cell itself, so a threshold would be nothing to compare against. */
const OPERATORS_WITHOUT_VALUE: KanbanFilterOperator[] = ['is_empty', 'is_not_empty', 'is_overdue']

function operatorLabel(operator: KanbanFilterOperator): string {
  return t(`preview.kanban_op_${operator}`)
}

function FilterHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className='flex items-center justify-between border-b border-[var(--border-subtle)] pb-2'>
      <span className='text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]'>
        {t('preview.kanban_filter_rules')}
      </span>
      <button
        type='button'
        onClick={onClose}
        className='text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
        aria-label={t('preview.kanban_clear_selection')}
      >
        <X size={14} />
      </button>
    </div>
  )
}

/**
 * A rule can outlive the column it was written against — a saved board may name an operator this
 * kind of column never offers. Keeping it in the list is what stops the row from displaying one
 * operator while filtering by another.
 */
function operatorsForColumn(
  type: KanbanPropertyType | undefined,
  current: KanbanFilterOperator,
): KanbanFilterOperator[] {
  const list = kanbanFilterOperatorsForType(type ?? 'text')
  return list.includes(current) ? list : [...list, current]
}

function FilterOperatorSelect({
  type,
  operator,
  onChange,
}: {
  type: KanbanPropertyType | undefined
  operator: KanbanFilterOperator
  onChange: (operator: KanbanFilterOperator) => void
}) {
  return (
    <Select
      value={operator}
      onChange={(e) => onChange(e.target.value as KanbanFilterOperator)}
      aria-label={t('preview.kanban_filter_operator')}
      className={`${PANEL_FIELD} bg-[var(--bg-raised)]`}
    >
      {operatorsForColumn(type, operator).map((op) => (
        <option key={op} value={op}>
          {operatorLabel(op)}
        </option>
      ))}
    </Select>
  )
}

type ValueFieldKind = 'number' | 'date' | 'choice' | 'text'

function valueFieldKind(column: KanbanProperty | undefined): ValueFieldKind {
  if (column?.type === 'number') return 'number'
  if (column?.type === 'date') return 'date'
  return column?.options?.length ? 'choice' : 'text'
}

const VALUE_FIELD_CLASS = `${PANEL_FIELD} min-w-0 flex-1 bg-[var(--bg-inset)]`

/** The threshold is asked for in the kind the column holds, or the row compares types. */
function FilterValueField({
  column,
  value,
  onChange,
}: {
  column: KanbanProperty | undefined
  value: string
  onChange: (value: string) => void
}) {
  const kind = valueFieldKind(column)
  const label = t('preview.kanban_filter_value')

  if (kind === 'choice') {
    // Choices are picked, not typed: a hand-typed label no option carries filters everything out. A
    // rule saved against an option that has since gone keeps its own value rather than silently
    // becoming the first choice.
    const stale = value && !column?.options?.some((opt) => opt.id === value)
    return (
      <div className='min-w-0 flex-1'>
        <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={VALUE_FIELD_CLASS}>
          {!value && <option value=''>{t('preview.kanban_value_placeholder')}</option>}
          {column?.options?.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
          {stale && <option value={value}>{value}</option>}
        </Select>
      </div>
    )
  }

  return (
    <input
      type={kind}
      value={kind === 'date' ? value.slice(0, 10) : value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={kind === 'text' ? t('preview.kanban_value_placeholder') : undefined}
      aria-label={label}
      className={VALUE_FIELD_CLASS}
    />
  )
}

interface FilterRowProps {
  filter: KanbanFilter
  index: number
  columns: KanbanProperty[]
  onUpdate: (index: number, patch: Partial<KanbanFilter>) => void
  onRemove: (index: number) => void
}

function FilterRow({ filter, index, columns, onUpdate, onRemove }: FilterRowProps) {
  const column = columns.find((c) => c.id === filter.propertyId)
  const needsValue = !OPERATORS_WITHOUT_VALUE.includes(filter.operator)

  return (
    <div className='flex items-center gap-1.5'>
      <div className='min-w-0 flex-1'>
        <Select
          value={filter.propertyId}
          onChange={(e) => onUpdate(index, { propertyId: e.target.value })}
          aria-label={t('preview.kanban_filter_property')}
          className={`${PANEL_FIELD} bg-[var(--bg-raised)]`}
        >
          {columns.map((c) => (
            <option key={c.id} value={c.id}>
              {formatKanbanPropertyName(c)}
            </option>
          ))}
        </Select>
      </div>

      <FilterOperatorSelect
        type={column?.type}
        operator={filter.operator}
        onChange={(operator) => onUpdate(index, { operator })}
      />

      {needsValue && (
        <FilterValueField
          column={column}
          value={filter.value ?? ''}
          onChange={(value) => onUpdate(index, { value })}
        />
      )}

      <button
        type='button'
        onClick={() => onRemove(index)}
        className='text-[var(--text-tertiary)] hover:text-[var(--danger)]'
        aria-label={t('preview.kanban_delete_rule')}
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

function FilterAddButton({ onAdd }: { onAdd: () => void }) {
  return (
    <button
      type='button'
      onClick={onAdd}
      className='flex items-center justify-center gap-1 rounded-[var(--r-md)] border border-dashed border-[var(--border-default)] p-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
    >
      <Plus size={13} />
      <span>{t('preview.kanban_add_condition')}</span>
    </button>
  )
}

function FilterList({
  filters,
  columns,
  onUpdate,
  onRemove,
}: {
  filters: KanbanFilter[]
  columns: KanbanProperty[]
  onUpdate: (index: number, patch: Partial<KanbanFilter>) => void
  onRemove: (index: number) => void
}) {
  if (filters.length === 0) {
    return (
      <p className='py-2 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]'>
        {t('preview.kanban_no_filter_rules')}
      </p>
    )
  }

  const keys = kanbanStableKeys(filters, (f) => [f.propertyId, f.operator, f.value])
  return (
    <div className='flex max-h-60 flex-col gap-2 overflow-y-auto'>
      {filters.map((filter, index) => (
        <FilterRow
          key={keys[index]}
          filter={filter}
          index={index}
          columns={columns}
          onUpdate={onUpdate}
          onRemove={onRemove}
        />
      ))}
    </div>
  )
}

/**
 * Pointing a rule at another column keeps it only while the new column answers the same question;
 * otherwise the rule restarts at that column's first operator, since a threshold carried over from
 * a different kind of column would filter for something the reader never asked.
 */
function withFilterRule(
  filters: KanbanFilter[],
  index: number,
  patch: Partial<KanbanFilter>,
  columns: KanbanProperty[],
): KanbanFilter[] {
  const next = [...filters]
  const rule = { ...next[index]!, ...patch }
  if (!patch.propertyId) {
    next[index] = rule
    return next
  }
  const answers = kanbanFilterOperatorsForType(
    columns.find((c) => c.id === rule.propertyId)?.type ?? 'text',
  )
  next[index] = answers.includes(rule.operator)
    ? rule
    : { propertyId: rule.propertyId, operator: answers[0]!, value: '' }
  return next
}

export const KanbanFilterPopover = memo(function KanbanFilterPopover({
  open,
  panelId,
  onClose,
  anchorRef,
  columns,
  filters,
  onChangeFilters,
}: KanbanFilterPopoverProps) {
  useLocaleRepaint()

  const handleAddFilter = () => {
    const column = columns[0]
    const operator = kanbanFilterOperatorsForType(column?.type ?? 'text')[0]!
    onChangeFilters([...filters, { propertyId: column?.id ?? 'title', operator, value: '' }])
  }

  const handleUpdate = (index: number, patch: Partial<KanbanFilter>) => {
    onChangeFilters(withFilterRule(filters, index, patch, columns))
  }

  return (
    <KanbanPanel
      open={open}
      panelId={panelId}
      label={t('preview.kanban_filter_rules')}
      anchorRef={anchorRef}
      onClose={onClose}
      className='z-[var(--z-menu)] flex w-80 flex-col gap-2 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-3 shadow-[var(--shadow-pop)]'
    >
      <FilterHeader onClose={onClose} />
      <FilterList
        filters={filters}
        columns={columns}
        onUpdate={handleUpdate}
        onRemove={(i) => onChangeFilters(filters.filter((_, idx) => idx !== i))}
      />
      <FilterAddButton onAdd={handleAddFilter} />
    </KanbanPanel>
  )
})
