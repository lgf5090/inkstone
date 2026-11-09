import { useState, type ReactElement } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { ProjectProperty, ProjectSortOption, ProjectView, ProjectViewFields } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Select } from '../../components/form'
import { Modal } from '../../components/overlay'

interface ModalProps {
  view: ProjectView
  properties: ProjectProperty[]
  onClose: () => void
  onPatch: (fields: Partial<ProjectViewFields>) => Promise<void>
}

function Footer({ onClose, onSave }: { onClose: () => void, onSave: () => void }): ReactElement {
  return <><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" onClick={onSave}>{t('common.save')}</Button></>
}

export function SortModal({ view, properties, onClose, onPatch }: ModalProps): ReactElement {
  const [draft, setDraft] = useState<ProjectSortOption[]>(view.fields.sortOptions)
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? '')
  const [reversed, setReversed] = useState(false)
  return (
    <Modal open onClose={onClose} title={t('project.view.sort')} width={480} footer={<Footer onClose={onClose} onSave={async () => { await onPatch({ sortOptions: draft }); onClose() }} />}>
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
          <Select className="min-w-0 flex-1" value={propertyId} aria-label={t('project.view.sort')} onChange={(event) => setPropertyId(event.target.value)}>
            {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Select className="w-28" value={reversed ? 'desc' : 'asc'} aria-label={t('project.view.sort')} onChange={(event) => setReversed(event.target.value === 'desc')}>
            <option value="asc">{t('project.view.asc')}</option>
            <option value="desc">{t('project.view.desc')}</option>
          </Select>
          <Button size="sm" icon={<Plus size={14} />} disabled={!propertyId} onClick={() => setDraft((current) => [...current, { propertyId, reversed }])}>{t('project.view.add_sort')}</Button>
        </div>
      </div>
    </Modal>
  )
}

export function PropertiesModal({ view, properties, onClose, onPatch }: ModalProps): ReactElement {
  const [draft, setDraft] = useState<string[]>(() => (view.fields.visiblePropertyIds.length ? view.fields.visiblePropertyIds : properties.map((p) => p.id)))
  return (
    <Modal open onClose={onClose} title={t('project.view.properties')} width={400} footer={<Footer onClose={onClose} onSave={async () => { await onPatch({ visiblePropertyIds: draft }); onClose() }} />}>
      <div className="space-y-2">
        {properties.map((property) => (
          <Checkbox
            key={property.id}
            label={property.name}
            checked={draft.includes(property.id)}
            onChange={(checked) => setDraft((current) => (checked ? [...current, property.id] : current.filter((id) => id !== property.id)))}
          />
        ))}
      </div>
    </Modal>
  )
}