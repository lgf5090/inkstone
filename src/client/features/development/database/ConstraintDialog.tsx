import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Field, Input } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { SelectMenu } from '../../../components/select-menu'
import { makeDiagramId, type DiagramConstraint } from './constraints'
import type { DiagramTable } from './diagram'

export interface ConstraintDialogProps {
  kind: 'unique' | 'check'
  table: DiagramTable
  initial: DiagramConstraint | null
  onClose: () => void
  onSubmit: (constraint: DiagramConstraint) => void
}

export function ConstraintDialog({ kind, table, initial, onClose, onSubmit }: ConstraintDialogProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [columns, setColumns] = useState<string[]>(() => (initial?.uniqueColumns?.length ? initial.uniqueColumns : ['']))
  const [expression, setExpression] = useState(initial?.expression ?? '')
  const [error, setError] = useState<string | null>(null)

  const options = table.columns
    .filter((column) => column.name.trim())
    .map((column) => ({ value: column.name, label: column.name }))

  const submit = () => {
    setError(null)
    if (kind === 'unique') {
      const chosen = columns.map((column) => column.trim()).filter(Boolean)
      if (chosen.length === 0) {
        setError(t('development.database.constraint.columns_required'))
        return
      }
      onSubmit({
        id: initial?.id ?? makeDiagramId('constraint'),
        kind: 'unique',
        ...(name.trim() ? { name: name.trim() } : {}),
        raw: '',
        uniqueColumns: chosen,
      })
      return
    }
    const value = expression.trim()
    if (!value) {
      setError(t('development.database.constraint.expression_required'))
      return
    }
    onSubmit({
      id: initial?.id ?? makeDiagramId('constraint'),
      kind: 'check',
      ...(name.trim() ? { name: name.trim() } : {}),
      raw: '',
      expression: value,
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={kind === 'unique'
        ? t(initial ? 'development.database.constraint.edit_unique' : 'development.database.constraint.add_unique')
        : t(initial ? 'development.database.constraint.edit_check' : 'development.database.constraint.add_check')}
      width={560}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('development.database.common.cancel')}</Button>
          <Button size="sm" onClick={submit}>{t('development.database.constraint.save')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('development.database.constraint.name')}>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label={t('development.database.constraint.name')}
          />
        </Field>
        {kind === 'unique' ? (
          <div className="space-y-1.5">
            <p className="text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">
              {t('development.database.constraint.columns')}
            </p>
            {columns.map((column, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <SelectMenu
                    label={`${t('development.database.constraint.column')} ${index + 1}`}
                    value={column}
                    options={options}
                    onChange={(value) => setColumns((current) => current.map((entry, position) => (
                      position === index ? value : entry
                    )))}
                    width={240}
                  />
                </div>
                <IconButton
                  label={`${t('development.database.constraint.remove_column')} ${index + 1}`}
                  size="xs"
                  disabled={columns.length <= 1}
                  onClick={() => setColumns((current) => current.filter((_, position) => position !== index))}
                >
                  <Trash2 size={12} />
                </IconButton>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => setColumns((current) => [...current, options.find((option) => !current.includes(option.value))?.value ?? ''])}
            >
              <Plus size={13} />
              {t('development.database.constraint.add_column')}
            </Button>
          </div>
        ) : (
          <Field label={t('development.database.constraint.expression')} required>
            <Input
              value={expression}
              onChange={(event) => setExpression(event.target.value)}
              placeholder={t('development.database.constraint.expression_placeholder')}
              aria-label={t('development.database.constraint.expression')}
            />
          </Field>
        )}
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
  )
}