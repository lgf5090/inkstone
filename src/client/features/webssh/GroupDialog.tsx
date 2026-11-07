import { useState } from 'react'
import { Check, Pencil, Trash2 } from 'lucide-react'
import type { WebsshHostGroup } from '@shared/webssh/types'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input, Select } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { websshApi } from './api'

export function GroupDialog({ open, onClose, groups, onChanged }: {
  open: boolean
  onClose: () => void
  groups: WebsshHostGroup[]
  onChanged: () => void
}) {
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      await websshApi.createGroup({ name: name.trim(), parentId: parentId || undefined })
      setName('')
      onChanged()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic'))
    } finally {
      setBusy(false)
    }
  }

  const rename = async (group: WebsshHostGroup) => {
    setBusy(true)
    setError(null)
    try {
      await websshApi.updateGroup(group.id, { name: editingName.trim() })
      setEditingId(null)
      setEditingName('')
      onChanged()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (group: WebsshHostGroup) => {
    const approved = await confirm({
      title: t('webssh.group.remove_title'),
      description: t('webssh.group.remove_description', { name: group.name }),
      tone: 'danger',
      confirmLabel: t('webssh.actions.delete'),
    })
    if (!approved) return
    setBusy(true)
    setError(null)
    try {
      await websshApi.deleteGroup(group.id)
      onChanged()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.group.title')}
      description={t('webssh.group.description')}
      width={520}
      dismissible={!busy}
      footer={<Button variant="ghost" onClick={onClose}>{t('webssh.actions.close')}</Button>}
    >
      <div className="space-y-4">
        <div className="space-y-3">
          <Field label={t('webssh.group.name')} required>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
          </Field>
          <Field label={t('webssh.group.parent')}>
            <Select value={parentId} onChange={(event) => setParentId(event.target.value)}>
              <option value="">{t('webssh.group.none')}</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </Select>
          </Field>
          <Button variant="primary" onClick={create} disabled={busy || !name.trim()} loading={busy}>
            {t('webssh.actions.add')}
          </Button>
        </div>
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
        <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)]">
          {groups.length === 0 ? (
            <li className="px-3 py-4 text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t('webssh.group.empty')}</li>
          ) : groups.map((group) => (
            <li key={group.id} className="flex items-center gap-2 px-3 py-2">
              {editingId === group.id ? (
                <>
                  <Input value={editingName} onChange={(event) => setEditingName(event.target.value)} className="min-w-0 flex-1" aria-label={t('webssh.group.name')} />
                  <IconButton label={t('webssh.actions.save')} size="sm" onClick={() => void rename(group)} disabled={busy || !editingName.trim()}>
                    <Check size={13} aria-hidden="true" />
                  </IconButton>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{group.name}</span>
                  <IconButton
                    label={t('webssh.actions.rename')}
                    size="sm"
                    onClick={() => {
                      setEditingId(group.id)
                      setEditingName(group.name)
                    }}
                    disabled={busy}
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </IconButton>
                  <IconButton label={t('webssh.actions.delete')} size="sm" onClick={() => void remove(group)} disabled={busy}>
                    <Trash2 size={13} aria-hidden="true" />
                  </IconButton>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}
