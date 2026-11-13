import { useState, type ReactElement } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { ProjectMinimumRole, ProjectProperty, ProjectSortOption, ProjectView, ProjectViewFields } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { Modal } from '../../components/overlay'
import { useUi } from '../../store/ui'

interface ModalProps {
  view: ProjectView
  properties: ProjectProperty[]
  canEdit?: boolean
  onClose: () => void
  onPatch: (fields: Partial<ProjectViewFields>) => Promise<boolean>
}

function Footer({ onClose, onSave }: { onClose: () => void, onSave: () => void }): ReactElement {
  return <><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" onClick={onSave}>{t('common.save')}</Button></>
}

async function saveAndClose(onPatch: (fields: Partial<ProjectViewFields>) => Promise<boolean>, fields: Partial<ProjectViewFields>, onClose: () => void): Promise<void> {
  try {
    const ok = await onPatch(fields)
    if (ok !== false) onClose()
  } catch (reason) {
    useUi.getState().toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
  }
}

export function SortModal({ view, properties, onClose, onPatch }: ModalProps): ReactElement {
  const [draft, setDraft] = useState<ProjectSortOption[]>(view.fields.sortOptions)
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? '')
  const [reversed, setReversed] = useState(false)
  return (
    <Modal open onClose={onClose} title={t('project.view.sort')} width={480} footer={<Footer onClose={onClose} onSave={() => { void saveAndClose(onPatch, { sortOptions: draft }, onClose) }} />}>
      <div className="space-y-2">
        {draft.length === 0 && <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.view.no_sorts')}</p>}
        {draft.map((sort, index) => (
          <div key={`${sort.propertyId}-${index}`} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{properties.find((p) => p.id === sort.propertyId)?.name ?? sort.propertyId}</span>
            <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{sort.reversed ? t('project.view.desc') : t('project.view.asc')}</span>
            <IconButton label={t('common.delete')} size="sm" onClick={() => setDraft((current) => current.filter((_, i) => i !== index))}><Trash2 size={14} /></IconButton>
          </div>
        ))}
        <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-2">
          <SelectMenu className="min-w-0 flex-1" value={propertyId} label={t('project.view.sort')} onChange={setPropertyId} options={properties.map((p) => ({ value: p.id, label: p.name }))} />
          <SelectMenu className="w-28" value={reversed ? 'desc' : 'asc'} label={t('project.view.sort')} onChange={(value) => setReversed(value === 'desc')} options={[{ value: 'asc', label: t('project.view.asc') }, { value: 'desc', label: t('project.view.desc') }]} />
          <Button size="sm" icon={<Plus size={14} />} disabled={!propertyId} onClick={() => setDraft((current) => [...current, { propertyId, reversed }])}>{t('project.view.add_sort')}</Button>
        </div>
      </div>
    </Modal>
  )
}

export function PropertiesModal({ view, properties, canEdit = false, onClose, onPatch }: ModalProps): ReactElement {
  const [draft, setDraft] = useState<string[]>(() => (view.fields.visiblePropertyIds.length ? view.fields.visiblePropertyIds : properties.map((p) => p.id)))
  const [minimumRole, setMinimumRole] = useState<ProjectMinimumRole>(view.fields.minimumRole ?? '')
  return (
    <Modal open onClose={onClose} title={t('project.view.properties')} width={400} footer={<Footer onClose={onClose} onSave={() => { void saveAndClose(onPatch, canEdit ? { visiblePropertyIds: draft, minimumRole } : { visiblePropertyIds: draft }, onClose) }} />}>
      <div className="space-y-2">
        {properties.map((property) => (
          <Checkbox
            key={property.id}
            label={property.name}
            checked={draft.includes(property.id)}
            onChange={(checked) => setDraft((current) => (checked ? [...current, property.id] : current.filter((id) => id !== property.id)))}
          />
        ))}
        {canEdit && (
          <label className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-2">
            <span className="min-w-0 flex-1 text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('project.view.visibility')}</span>
            <SelectMenu
              className="w-36"
              value={minimumRole}
              label={t('project.view.visibility')}
              onChange={(next) => setMinimumRole(next as ProjectMinimumRole)}
              options={[
                { value: '', label: t('project.board.minimum_none') },
                { value: 'viewer', label: t('project.role.viewer') },
                { value: 'commenter', label: t('project.role.commenter') },
                { value: 'editor', label: t('project.role.editor') },
                { value: 'admin', label: t('project.role.admin') },
              ]}
            />
          </label>
        )}
      </div>
    </Modal>
  )
}