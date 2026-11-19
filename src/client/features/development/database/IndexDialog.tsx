import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Checkbox, Field, Input } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { SelectMenu } from '../../../components/select-menu'
import type { DiagramIndex, DiagramTable } from './diagram'

export interface IndexDialogProps {
  table: DiagramTable
  initial: DiagramIndex | null
  onClose: () => void
  onSubmit: (index: DiagramIndex) => void
}

export function IndexDialog({ table, initial, onClose, onSubmit }: IndexDialogProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [unique, setUnique] = useState(initial?.unique ?? false)
  const [columns, setColumns] = useState<string[]>(() => (initial?.columns.length ? initial.columns : ['']))
  const [error, setError] = useState<string | null>(null)

  const options = table.columns
    .filter((column) => column.name.trim())
    .map((column) => ({ value: column.name, label: column.name }))

  const submit = () => {
    setError(null)
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('development.database.index.name_required'))
      return
    }
    const chosen = columns.map((column) => column.trim()).filter(Boolean)
    if (chosen.length === 0) {
      setError(t('development.database.index.columns_required'))
      return
    }
    if (new Set(chosen.map((column) => column.toLowerCase())).size !== chosen.length) {
      setError(t('development.database.index.duplicate_column'))
      return
    }
    onSubmit({
      id: initial?.id ?? `index-${Date.now()}`,
      name: trimmed,
      unique,
      columns: chosen,
      raw: null,
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? t('development.database.index.edit_title') : t('development.database.index.add_title')}
      width={560}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('development.database.common.cancel')}</Button>
          <Button size="sm" onClick={submit}>{t('development.database.index.save')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('development.database.index.name')} required>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label={t('development.database.index.name')}
          />
        </Field>
        <Checkbox
          checked={unique}
          label={t('development.database.index.unique')}
          ariaLabel={t('development.database.index.unique')}
          onChange={setUnique}
        />
        <div className="space-y-1.5">
          <p className="text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">
            {t('development.database.index.columns')}
          </p>
          {columns.map((column, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <SelectMenu
                  label={`${t('development.database.index.column')} ${index + 1}`}
                  value={column}
                  options={options}
                  onChange={(value) => setColumns((current) => current.map((entry, position) => (
                    position === index ? value : entry
                  )))}
                  width={240}
                />
              </div>
              <IconButton
                label={`${t('development.database.index.remove_column')} ${index + 1}`}
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
            {t('development.database.index.add_column')}
          </Button>
        </div>
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
  )
}