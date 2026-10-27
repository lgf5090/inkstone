/**
 * A table's columns, their constraints, and the four schema edits D1 allows without opening the SQL
 * editor. Each edit is a normal ALTER/DROP statement sent through the query route with writes allowed;
 * nothing here bypasses the route's own guard.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Badge, Button } from '../../../../components/primitives'
import { Checkbox, Field, Input } from '../../../../components/form'
import { Modal, confirm } from '../../../../components/overlay'
import { SelectMenu } from '../../../../components/select-menu'
import { t as uiT } from '../../../../lib/i18n'
import { isSimpleIdent, quoteIdent } from '@shared/cloudflare/sql-utils'
import { cfErrorText } from '../../api/client'
import { storageApi, type D1Column } from '../../api/storage'
import { useCfT } from '../../i18n'
import { useUi } from '../../../../store/ui'
import { Table, TableScroll, TBody, Td, Th, THead, Tr } from '../../components/Table'
import { StorageError } from './StorageError'

const COLUMN_TYPES = ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'BOOLEAN', 'DATETIME'] as const
type ColumnType = typeof COLUMN_TYPES[number]
const TYPE_OPTIONS = COLUMN_TYPES.map((type) => ({ value: type, label: type }))

type EditPanel = 'none' | 'add' | 'rename' | 'drop'

export function D1SchemaDialog({
  open,
  accountId,
  databaseId,
  tableName,
  readOnly,
  onClose,
  onChanged,
}: {
  open: boolean
  accountId: string
  databaseId: string
  tableName: string
  readOnly: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [schema, setSchema] = useState<D1Column[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState<EditPanel>('none')

  const [addName, setAddName] = useState('')
  const [addType, setAddType] = useState<ColumnType>('TEXT')
  const [addNotNull, setAddNotNull] = useState(false)
  const [addDefault, setAddDefault] = useState('')
  const [renameFrom, setRenameFrom] = useState('')
  const [renameTo, setRenameTo] = useState('')
  const [dropColumn, setDropColumn] = useState('')

  const loadSchema = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await storageApi.getD1TableSchema(accountId, databaseId, tableName)
      setSchema(data.schema)
    } catch (reason) {
      setError(cfErrorText(reason))
      setSchema([])
    } finally {
      setLoading(false)
    }
  }, [accountId, databaseId, tableName])

  useEffect(() => {
    if (!open) return
    setPanel('none')
    setAddName('')
    setAddType('TEXT')
    setAddNotNull(false)
    setAddDefault('')
    setRenameFrom('')
    setRenameTo('')
    setDropColumn('')
    void loadSchema()
  }, [open, loadSchema])

  async function alter(sql: string, success: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await storageApi.executeD1Query(accountId, databaseId, sql, true)
      toast({ title: success, tone: 'success' })
      setPanel('none')
      await loadSchema()
      onChanged()
    } catch (reason) {
      setError(cfErrorText(reason))
    } finally {
      setBusy(false)
    }
  }

  async function addColumn(): Promise<void> {
    const name = addName.trim()
    if (!isSimpleIdent(name)) return
    let sql = `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${quoteIdent(name)} ${addType}`
    if (addNotNull) sql += ' NOT NULL'
    if (addDefault.trim()) sql += ` DEFAULT ${addDefault.trim()}`
    await alter(sql, t('cloudflare.storage.msg.column_added', { name }))
  }

  async function renameColumn(): Promise<void> {
    const next = renameTo.trim()
    if (!renameFrom || !isSimpleIdent(next)) return
    await alter(
      `ALTER TABLE ${quoteIdent(tableName)} RENAME COLUMN ${quoteIdent(renameFrom)} TO ${quoteIdent(next)}`,
      t('cloudflare.storage.msg.column_renamed'),
    )
  }

  async function dropSelectedColumn(): Promise<void> {
    if (!dropColumn) return
    const ok = await confirm({
      title: t('cloudflare.storage.drop_column'),
      description: `${tableName}.${dropColumn}`,
      confirmLabel: t('cloudflare.storage.confirm_delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    await alter(
      `ALTER TABLE ${quoteIdent(tableName)} DROP COLUMN ${quoteIdent(dropColumn)}`,
      t('cloudflare.storage.msg.column_deleted', { name: dropColumn }),
    )
  }

  async function dropTable(): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.storage.msg.delete_table_title'),
      description: t('cloudflare.storage.msg.delete_table_confirm', { name: tableName }),
      confirmLabel: t('cloudflare.storage.confirm_delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await storageApi.executeD1Query(accountId, databaseId, `DROP TABLE ${quoteIdent(tableName)}`, true)
      toast({ title: t('cloudflare.storage.msg.table_deleted', { name: tableName }), tone: 'success' })
      onChanged()
      onClose()
    } catch (reason) {
      setError(cfErrorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const columnOptions = schema.map((column) => ({ value: column.name, label: column.name }))

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('cloudflare.storage.table_structure', { name: tableName })}
      width={780}
      dismissible={!busy}
      footer={<Button variant="secondary" onClick={onClose} disabled={busy}>{uiT('common.close')}</Button>}
    >
      <div className="space-y-3">
        {error && <StorageError message={error} onRetry={() => { void loadSchema() }} />}
        {loading ? (
          <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-[var(--text-tertiary)]" /></div>
        ) : (
          <TableScroll label={t('cloudflare.storage.table_structure', { name: tableName })}>
            <Table>
              <THead>
                <Tr>
                  <Th>#</Th>
                  <Th>{t('cloudflare.storage.column_name')}</Th>
                  <Th>{t('cloudflare.storage.column_type')}</Th>
                  <Th>{t('cloudflare.storage.default_value')}</Th>
                  <Th>{t('cloudflare.storage.primary_key')}</Th>
                </Tr>
              </THead>
              <TBody>
                {schema.map((column) => (
                  <Tr key={column.cid}>
                    <Td className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{column.cid}</Td>
                    <Td className="font-mono text-[length:var(--text-12)]">{column.name}</Td>
                    <Td>
                      <span className="flex flex-wrap items-center gap-1 font-mono text-[length:var(--text-12)]">
                        {column.type}
                        {column.notnull ? <Badge tone="warning">NOT NULL</Badge> : null}
                      </span>
                    </Td>
                    <Td className="font-mono text-[length:var(--text-12)]">{column.dflt_value ?? '-'}</Td>
                    <Td>{column.pk ? <Badge tone="accent">{t('cloudflare.storage.primary_key')}</Badge> : null}</Td>
                  </Tr>
                ))}
                {!schema.length && (
                  <Tr>
                    <Td colSpan={5} className="py-6 text-center text-[var(--text-tertiary)]">
                      {t('cloudflare.compact_card.no_data')}
                    </Td>
                  </Tr>
                )}
              </TBody>
            </Table>
          </TableScroll>
        )}

        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPanel((value) => value === 'add' ? 'none' : 'add')}>
              {t('cloudflare.storage.add_column')}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy || !schema.length} onClick={() => setPanel((value) => value === 'rename' ? 'none' : 'rename')}>
              {t('cloudflare.storage.rename_column')}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy || !schema.length} onClick={() => setPanel((value) => value === 'drop' ? 'none' : 'drop')}>
              {t('cloudflare.storage.drop_column')}
            </Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => { void dropTable() }}>
              {t('cloudflare.storage.drop_table')}
            </Button>
          </div>
        )}

        {panel === 'add' && (
          <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
            <p className="mb-2 text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
              {t('cloudflare.storage.add_column')}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <Field label={t('cloudflare.storage.column_name')} className="w-40">
                <Input
                  value={addName}
                  placeholder={t('cloudflare.storage.column_name_placeholder')}
                  invalid={addName.trim().length > 0 && !isSimpleIdent(addName.trim())}
                  onChange={(event) => setAddName(event.target.value)}
                />
              </Field>
              <div className="w-32">
                <SelectMenu
                  label={t('cloudflare.storage.column_type')}
                  value={addType}
                  options={TYPE_OPTIONS}
                  onChange={setAddType}
                />
              </div>
              <Checkbox checked={addNotNull} onChange={setAddNotNull} label="NOT NULL" />
              <Field label={t('cloudflare.storage.default_value')} className="w-40">
                <Input
                  value={addDefault}
                  placeholder={t('cloudflare.storage.default_value_placeholder')}
                  onChange={(event) => setAddDefault(event.target.value)}
                />
              </Field>
              <Button size="sm" variant="primary" loading={busy} disabled={!isSimpleIdent(addName.trim())} onClick={() => { void addColumn() }}>
                {uiT('common.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPanel('none')}>{uiT('common.cancel')}</Button>
            </div>
          </div>
        )}

        {panel === 'rename' && (
          <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
            <p className="mb-2 text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
              {t('cloudflare.storage.rename_column')}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-40">
                <SelectMenu
                  label={t('cloudflare.storage.old_column_name')}
                  value={renameFrom}
                  options={columnOptions}
                  placeholder={t('cloudflare.storage.old_column_name')}
                  onChange={setRenameFrom}
                />
              </div>
              <Field label={t('cloudflare.storage.new_column_name')} className="w-40">
                <Input
                  value={renameTo}
                  placeholder={t('cloudflare.storage.new_column_name')}
                  invalid={renameTo.trim().length > 0 && !isSimpleIdent(renameTo.trim())}
                  onChange={(event) => setRenameTo(event.target.value)}
                />
              </Field>
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                disabled={!renameFrom || !isSimpleIdent(renameTo.trim()) || renameFrom === renameTo.trim()}
                onClick={() => { void renameColumn() }}
              >
                {uiT('common.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPanel('none')}>{uiT('common.cancel')}</Button>
            </div>
          </div>
        )}

        {panel === 'drop' && (
          <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
            <p className="mb-2 text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
              {t('cloudflare.storage.drop_column')}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-48">
                <SelectMenu
                  label={t('cloudflare.storage.select_drop_column')}
                  value={dropColumn}
                  options={columnOptions}
                  placeholder={t('cloudflare.storage.select_drop_column')}
                  onChange={setDropColumn}
                />
              </div>
              <Button size="sm" variant="danger" loading={busy} disabled={!dropColumn} onClick={() => { void dropSelectedColumn() }}>
                {t('cloudflare.storage.confirm_delete')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPanel('none')}>{uiT('common.cancel')}</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
