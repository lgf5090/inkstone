import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Field } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { SelectMenu } from '../../../components/select-menu'
import { REF_ACTIONS, type RefAction } from './constraints'
import type { DiagramDraft } from './diagram'

export interface RelationshipInput {
  startTableId: string
  startColumns: string[]
  endTableId: string
  endColumns: string[]
  onUpdate: RefAction
  onDelete: RefAction
  constraintId?: string
  name?: string
}

export interface RelationshipDialogProps {
  draft: DiagramDraft
  initial?: Partial<RelationshipInput>
  onClose: () => void
  onSubmit: (input: RelationshipInput) => void
  onDelete?: (constraintId: string, startTableId: string) => void
}

interface ColumnPair {
  local: string
  remote: string
}

export function RelationshipDialog({ draft, initial, onClose, onSubmit, onDelete }: RelationshipDialogProps) {
  const [startTableId, setStartTableId] = useState(initial?.startTableId ?? draft.tables[0]?.id ?? '')
  const [endTableId, setEndTableId] = useState(initial?.endTableId ?? '')
  const [pairs, setPairs] = useState<ColumnPair[]>(() => {
    const locals = initial?.startColumns ?? []
    const remotes = initial?.endColumns ?? []
    const length = Math.max(locals.length, remotes.length, 1)
    return Array.from({ length }, (_, index) => ({ local: locals[index] ?? '', remote: remotes[index] ?? '' }))
  })
  const [updateAction, setUpdateAction] = useState<RefAction>(initial?.onUpdate ?? 'NO ACTION')
  const [deleteAction, setDeleteAction] = useState<RefAction>(initial?.onDelete ?? 'NO ACTION')
  const [error, setError] = useState<string | null>(null)

  const startTable = draft.tables.find((table) => table.id === startTableId) ?? null
  const endTable = draft.tables.find((table) => table.id === endTableId) ?? null
  const localColumns = startTable?.columns.map((column) => ({ value: column.name, label: column.name })) ?? []
  const remoteColumns = endTable?.columns.map((column) => ({ value: column.name, label: column.name })) ?? []

  const tableOptions = draft.tables.map((table) => ({ value: table.id, label: table.name }))
  const actionOptions = REF_ACTIONS.map((action) => ({ value: action, label: action }))

  const updatePair = (index: number, patch: Partial<ColumnPair>) => {
    setPairs((current) => current.map((pair, position) => (position === index ? { ...pair, ...patch } : pair)))
  }

  const submit = () => {
    setError(null)
    if (!startTable || !endTable) {
      setError(t('development.database.diagram.relation_invalid'))
      return
    }
    const startColumns = pairs.map((pair) => pair.local.trim()).filter(Boolean)
    const endColumns = pairs.map((pair) => pair.remote.trim()).filter(Boolean)
    if (startColumns.length === 0 || endColumns.length === 0) {
      setError(t('development.database.diagram.relation_invalid'))
      return
    }
    if (startColumns.length !== endColumns.length) {
      setError(t('development.database.diagram.relation_invalid'))
      return
    }
    const seen = new Set<string>()
    for (const column of startColumns) {
      const key = column.toLowerCase()
      if (seen.has(key)) {
        setError(t('development.database.diagram.relation_invalid'))
        return
      }
      seen.add(key)
    }
    onSubmit({
      startTableId,
      startColumns,
      endTableId,
      endColumns,
      onUpdate: updateAction,
      onDelete: deleteAction,
      ...(initial?.constraintId ? { constraintId: initial.constraintId } : {}),
      ...(initial?.name ? { name: initial.name } : {}),
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('development.database.diagram.relation_title')}
      width={640}
      footer={
        <>
          {onDelete && initial?.constraintId && initial.startTableId && (
            <Button
              variant="secondary"
              size="sm"
              className="text-[var(--danger)]"
              onClick={() => onDelete(initial.constraintId!, initial.startTableId!)}
            >
              <Trash2 size={13} />
              {t('development.database.diagram.delete_relation')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>{t('development.database.common.cancel')}</Button>
          <Button size="sm" onClick={submit}>{t('development.database.diagram.save_relation')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t('development.database.diagram.source_table')} required>
            <SelectMenu
              label={t('development.database.diagram.source_table')}
              value={startTableId}
              options={tableOptions}
              onChange={(value) => {
                setStartTableId(value)
                setPairs((current) => current.map((pair) => ({ ...pair, local: '' })))
              }}
              width={260}
            />
          </Field>
          <Field label={t('development.database.diagram.target_table')} required>
            <SelectMenu
              label={t('development.database.diagram.target_table')}
              value={endTableId}
              options={tableOptions}
              onChange={(value) => {
                setEndTableId(value)
                setPairs((current) => current.map((pair) => ({ ...pair, remote: '' })))
              }}
              width={260}
            />
          </Field>
        </div>

        <div className="space-y-1.5">
          <p className="text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">
            {t('development.database.diagram.columns')}
          </p>
          {pairs.map((pair, index) => (
            <div key={index} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
              <SelectMenu
                label={`${t('development.database.diagram.source_columns')} ${index + 1}`}
                value={pair.local}
                options={localColumns}
                onChange={(value) => updatePair(index, { local: value })}
                width={220}
              />
              <span aria-hidden="true" className="text-[var(--text-tertiary)]">→</span>
              <SelectMenu
                label={`${t('development.database.diagram.target_columns')} ${index + 1}`}
                value={pair.remote}
                options={remoteColumns}
                onChange={(value) => updatePair(index, { remote: value })}
                width={220}
              />
              <IconButton
                label={t('development.database.diagram.remove_pair')}
                size="xs"
                disabled={pairs.length <= 1}
                onClick={() => setPairs((current) => current.filter((_, position) => position !== index))}
              >
                <Trash2 size={12} />
              </IconButton>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => setPairs((current) => [...current, { local: '', remote: '' }])}
          >
            <Plus size={13} />
            {t('development.database.diagram.add_pair')}
          </Button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t('development.database.diagram.on_update')}>
            <SelectMenu
              label={t('development.database.diagram.on_update')}
              value={updateAction}
              options={actionOptions}
              onChange={(value) => setUpdateAction(value as RefAction)}
              width={220}
            />
          </Field>
          <Field label={t('development.database.diagram.on_delete')}>
            <SelectMenu
              label={t('development.database.diagram.on_delete')}
              value={deleteAction}
              options={actionOptions}
              onChange={(value) => setDeleteAction(value as RefAction)}
              width={220}
            />
          </Field>
        </div>

        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
  )
}