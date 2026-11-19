import { useEffect, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Checkbox, Field, Input } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { SelectMenu } from '../../../components/select-menu'

export const COMMON_COLUMN_TYPES = [
  'INTEGER',
  'REAL',
  'TEXT',
  'BLOB',
  'NUMERIC',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'JSON',
  'VARCHAR(255)',
  'VARCHAR(64)',
  'DOUBLE',
  'BIGINT',
  'TIMESTAMP',
] as const

export interface CreateTableColumn {
  id: string
  name: string
  type: string
  pk: boolean
  notNull: boolean
  unique: boolean
  default: string
}

export interface TableCreateDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: (name: string, columns: CreateTableColumn[]) => Promise<boolean>
}

function defaultColumns(): CreateTableColumn[] {
  return [
    { id: 'c1', name: 'id', type: 'INTEGER', pk: true, notNull: true, unique: false, default: '' },
    { id: 'c2', name: 'name', type: 'TEXT', pk: false, notNull: false, unique: false, default: '' },
  ]
}

export function TableCreateDialog({ open, onClose, onConfirm }: TableCreateDialogProps) {
  const [name, setName] = useState('')
  const [columns, setColumns] = useState<CreateTableColumn[]>(defaultColumns)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName('')
    setColumns(defaultColumns())
    setBusy(false)
  }, [open])

  const confirm = () => {
    if (busy) return
    setBusy(true)
    void onConfirm(name, columns).then((ok) => {
      if (ok) onClose()
    }).finally(() => setBusy(false))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('development.database.schema.create_table')}
      width={640}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('development.database.common.cancel')}</Button>
          <Button size="sm" disabled={!name.trim() || busy} onClick={confirm}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : null}
            {t('development.database.schema.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('development.database.schema.table_name')} required>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('development.database.schema.table_name_placeholder')}
            aria-label={t('development.database.schema.table_name')}
          />
        </Field>
        <div className="space-y-1.5">
          {columns.map((column, index) => (
            <div key={column.id} className="grid grid-cols-[1fr_1.1fr_auto_auto_1.2fr_auto] items-center gap-1.5">
              <Input
                value={column.name}
                onChange={(event) => setColumns((current) => current.map((entry) => (
                  entry.id === column.id ? { ...entry, name: event.target.value } : entry
                )))}
                placeholder={t('development.database.schema.name')}
                aria-label={`${t('development.database.schema.name')} ${index + 1}`}
                className="h-7"
              />
              <SelectMenu
                label={`${t('development.database.schema.type')} ${column.name || index + 1}`}
                value={column.type}
                options={COMMON_COLUMN_TYPES.map((type) => ({ value: type, label: type }))}
                onChange={(value) => setColumns((current) => current.map((entry) => (
                  entry.id === column.id ? { ...entry, type: value } : entry
                )))}
                size="sm"
              />
              <Checkbox
                checked={column.pk}
                ariaLabel={`${t('development.database.schema.primary_key')} ${column.name || index + 1}`}
                onChange={(next) => setColumns((current) => current.map((entry) => (
                  entry.id === column.id ? { ...entry, pk: next } : entry
                )))}
              />
              <Checkbox
                checked={column.notNull}
                ariaLabel={`${t('development.database.schema.not_null')} ${column.name || index + 1}`}
                onChange={(next) => setColumns((current) => current.map((entry) => (
                  entry.id === column.id ? { ...entry, notNull: next } : entry
                )))}
              />
              <Input
                value={column.default}
                onChange={(event) => setColumns((current) => current.map((entry) => (
                  entry.id === column.id ? { ...entry, default: event.target.value } : entry
                )))}
                placeholder={t('development.database.schema.default')}
                aria-label={`${t('development.database.schema.default')} ${column.name || index + 1}`}
                className="h-7"
              />
              <IconButton
                label={`${t('development.database.schema.delete_column')} ${column.name || index + 1}`}
                size="xs"
                onClick={() => setColumns((current) => current.filter((entry) => entry.id !== column.id))}
              >
                <Trash2 size={12} />
              </IconButton>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => setColumns((current) => [...current, {
              id: `c${Date.now()}`,
              name: '',
              type: 'TEXT',
              pk: false,
              notNull: false,
              unique: false,
              default: '',
            }])}
          >
            <Plus size={13} />
            {t('development.database.schema.add_column')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}