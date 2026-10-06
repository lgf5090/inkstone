/**
 * Which of the board's own columns a card prints under its title.
 *
 * It lives beside the view options rather than inside them because the panel was already at the file
 * limit, and it is its own section rather than a second list beside "Columns" because the two answer
 * different questions: that one decides what the surface draws at all, this one what a single card
 * says about itself. A field for a column the reader has since hidden still prints on the card, which
 * is the point of the two being separate — and it is offered to a board alone, since a table draws
 * every column already.
 */
import { t } from '../../../i18n'
import { kanbanCardFieldOptions } from '../card-fields'
import { formatKanbanPropertyName } from '../i18n-helpers'
import type { KanbanProperty } from '../types'

export function CardFieldsSection({
  columns,
  cardFields,
  onToggleCardField,
}: {
  columns: KanbanProperty[]
  cardFields: string[]
  onToggleCardField: (propertyId: string) => void
}) {
  const rows = kanbanCardFieldOptions(columns)
  if (rows.length === 0) return null
  return (
    <fieldset className='flex min-w-0 flex-col gap-1.5'>
      <legend className='flex flex-col gap-0.5'>
        <span className='text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]'>
          {t('preview.kanban_card_fields')}
        </span>
        <span className='text-[length:var(--text-11)] text-[var(--text-tertiary)]'>
          {t('preview.kanban_card_fields_hint')}
        </span>
      </legend>
      <div data-kanban-card-field-list className='flex max-h-56 flex-col gap-0.5 overflow-auto'>
        {rows.map((column) => {
          const name = formatKanbanPropertyName(column)
          return (
            <label
              key={column.id}
              className='flex min-w-0 cursor-pointer items-center gap-2 rounded-[var(--r-sm)] px-1 py-1 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            >
              <input
                type='checkbox'
                checked={cardFields.includes(column.id)}
                onChange={() => onToggleCardField(column.id)}
                className='size-3.5 shrink-0 rounded-[var(--r-xs)] border-[var(--border-default)] accent-[var(--accent)]'
              />
              <span className='truncate'>{name}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
