/**
 * The table builder: a small list of column definitions, the SQL it would run, and one Execute button.
 *
 * The preview is the statement that is sent, not a separate description of it, so a reader can see the
 * quoting and defaults before anything reaches the database.
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, IconButton } from '../../../../components/primitives'
import { Checkbox, Field, Input } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { SelectMenu } from '../../../../components/select-menu'
import { t as uiT } from '../../../../lib/i18n'
import { buildCreateTableSql, isSimpleIdent, type SqlColumnDefinition } from '@shared/cloudflare/sql-utils'
import { cfErrorText } from '../../api/client'
import { storageApi } from '../../api/storage'
import { useCfT } from '../../i18n'
import { Table, TableScroll, TBody, Td, Th, THead, Tr } from '../../components/Table'
import { SQL_NOT_NULL } from './sql-keywords'

const COLUMN_TYPES = ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'BOOLEAN', 'DATETIME'] as const
type ColumnType = typeof COLUMN_TYPES[number]
const TYPE_OPTIONS = COLUMN_TYPES.map((type) => ({ value: type, label: type }))

interface DraftColumn extends SqlColumnDefinition {
  type: ColumnType
  primaryKey: boolean
  notNull: boolean
  defaultValue: string
}

function emptyColumn(): DraftColumn {
  return { name: '', type: 'TEXT', primaryKey: false, notNull: false, defaultValue: '' }
}

function initialColumns(): DraftColumn[] {
  return [
    { name: 'id', type: 'INTEGER', primaryKey: true, notNull: true, defaultValue: '' },
    emptyColumn(),
  ]
}

export function CreateTableDialog({
  open,
  accountId,
  databaseId,
  onClose,
  onCreated,
}: {
  open: boolean
  accountId: string
  databaseId: string
  onClose: () => void
  onCreated: (name: string) => void
}) {
  const t = useCfT()
  const [tableName, setTableName] = useState('')
  const [columns, setColumns] = useState<DraftColumn[]>(initialColumns)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setTableName('')
    setColumns(initialColumns())
    setError('')
    setCreating(false)
  }, [open])

  const namedColumns = columns.filter((column) => column.name.trim())
  const validNames = namedColumns.every((column) => isSimpleIdent(column.name.trim()))
  const uniqueNames = new Set(namedColumns.map((column) => column.name.trim())).size === namedColumns.length
  const tableValid = isSimpleIdent(tableName.trim())
  const ready = tableValid && namedColumns.length > 0 && validNames && uniqueNames && !creating

  const preview = useMemo(() => {
    if (!tableName.trim()) return t('cloudflare.storage.enter_table_name')
    if (!tableValid) return t('cloudflare.storage.table_name_placeholder')
    if (namedColumns.length === 0) return t('cloudflare.storage.add_at_least_one_col')
    if (!validNames) return t('cloudflare.storage.column_name_placeholder')
    if (!uniqueNames) return t('cloudflare.storage.column_name_placeholder')
    return buildCreateTableSql(tableName.trim(), namedColumns)
  }, [tableName, tableValid, namedColumns, validNames, uniqueNames, t])

  function patchColumn(index: number, patch: Partial<DraftColumn>): void {
    setColumns((current) => current.map((column, position) => (
      position === index ? { ...column, ...patch } : column
    )))
  }

  async function create(): Promise<void> {
    if (!ready) return
    setCreating(true)
    setError('')
    try {
      await storageApi.executeD1Query(accountId, databaseId, buildCreateTableSql(tableName.trim(), namedColumns), true)
      onCreated(tableName.trim())
      onClose()
    } catch (reason) {
      setError(cfErrorText(reason))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('cloudflare.storage.create_table_title')}
      width={780}
      dismissible={!creating}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={creating}>{uiT('common.cancel')}</Button>
          <Button variant="primary" loading={creating} disabled={!ready} onClick={() => { void create() }}>
            {t('cloudflare.storage.execute_create_table')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <Field label={t('cloudflare.storage.table_name')}>
          <Input
            value={tableName}
            autoFocus
            placeholder={t('cloudflare.storage.table_name_placeholder')}
            invalid={tableName.trim().length > 0 && !tableValid}
            onChange={(event) => setTableName(event.target.value)}
          />
        </Field>

        <TableScroll label={t('cloudflare.storage.create_table_title')}>
          <Table>
            <THead>
              <Tr>
                <Th>{t('cloudflare.storage.column_name')}</Th>
                <Th>{t('cloudflare.storage.column_type')}</Th>
                <Th>{t('cloudflare.storage.primary_key')}</Th>
                <Th>{SQL_NOT_NULL}</Th>
                <Th>{t('cloudflare.storage.default_value')}</Th>
                <Th>{uiT('common.more_actions')}</Th>
              </Tr>
            </THead>
            <TBody>
              {columns.map((column, index) => (
                <Tr key={index}>
                  <Td>
                    <Input
                      value={column.name}
                      aria-label={t('cloudflare.storage.column_name')}
                      placeholder={t('cloudflare.storage.column_name_placeholder')}
                      invalid={column.name.trim().length > 0 && !isSimpleIdent(column.name.trim())}
                      onChange={(event) => patchColumn(index, { name: event.target.value })}
                    />
                  </Td>
                  <Td>
                    <SelectMenu
                      label={t('cloudflare.storage.column_type')}
                      value={column.type}
                      options={TYPE_OPTIONS}
                      onChange={(type) => patchColumn(index, { type })}
                    />
                  </Td>
                  <Td>
                    <Checkbox
                      checked={column.primaryKey}
                      onChange={(checked) => patchColumn(index, { primaryKey: checked })}
                      label={t('cloudflare.storage.primary_key')}
                    />
                  </Td>
                  <Td>
                    <Checkbox
                      checked={column.notNull}
                      onChange={(checked) => patchColumn(index, { notNull: checked })}
                      label={SQL_NOT_NULL}
                    />
                  </Td>
                  <Td>
                    <Input
                      value={column.defaultValue}
                      aria-label={t('cloudflare.storage.default_value')}
                      placeholder={t('cloudflare.storage.default_value_placeholder')}
                      onChange={(event) => patchColumn(index, { defaultValue: event.target.value })}
                    />
                  </Td>
                  <Td>
                    <IconButton
                      label={uiT('common.delete')}
                      size="xs"
                      disabled={columns.length === 1}
                      onClick={() => setColumns((current) => current.filter((_, position) => position !== index))}
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>

        <Button
          size="sm"
          variant="secondary"
          icon={<Plus size={14} />}
          onClick={() => setColumns((current) => [...current, emptyColumn()])}
        >
          {t('cloudflare.storage.add_column')}
        </Button>

        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
          <p className="mb-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('cloudflare.storage.preview_sql')}
          </p>
          <pre className="overflow-x-auto font-mono text-[length:var(--text-11-5)] text-[var(--text-primary)]">
            {preview}
          </pre>
        </div>

        {error && (
          <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>
        )}
      </div>
    </Modal>
  )
}
