import { useRef, useState, type ReactElement } from 'react'
import type { ProjectBoardMember, ProjectPeople, ProjectProperty } from '@shared/project/model'
import { PROJECT_PROPERTY_CAPABILITIES } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { SelectMenu } from '../../components/select-menu'
import { PropertyValueEditor } from './PropertyValueEditor'

/** A property a bulk write can actually carry; server stamps and opaque file cells are read-only here. */
function editableProperty(property: ProjectProperty): boolean {
  const capability = PROJECT_PROPERTY_CAPABILITIES[property.type]
  return !capability.readOnly && property.type !== 'file' && property.type !== 'unknown'
}

export function BatchEditDialog({ count, properties, members, people, onClose, onApply }: {
  count: number
  properties: readonly ProjectProperty[]
  members: readonly ProjectBoardMember[]
  people: ProjectPeople
  onClose: () => void
  onApply: (values: Record<string, string | null>) => Promise<void>
}): ReactElement {
  const choices = properties.filter(editableProperty)
  const [propertyId, setPropertyId] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const latest = useRef('')
  const property = choices.find((entry) => entry.id === propertyId)

  const choose = (next: string): void => {
    latest.current = ''
    setValue('')
    setPropertyId(next)
  }
  const change = (next: string | null): void => {
    latest.current = next ?? ''
    setValue(next ?? '')
  }
  const apply = async (next: string | null): Promise<void> => {
    if (!property || busy) return
    setBusy(true)
    try {
      await onApply({ [property.id]: next })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('project.view.batch_edit', { count })} width={460}>
      <div className="space-y-3">
        <SelectMenu
          className="w-full"
          value={propertyId}
          label={t('project.view.set_property')}
          onChange={choose}
          options={[{ value: '', label: t('project.view.set_property') }, ...choices.map((entry) => ({ value: entry.id, label: entry.name }))]}
        />
        {property && (
          <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
            <PropertyValueEditor
              key={property.id}
              property={property}
              value={value}
              members={[...members]}
              people={people}
              disabled={busy}
              onChange={change}
            />
          </div>
        )}
        <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.view.batch_edit_hint')}</p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button size="sm" variant="ghost" disabled={!property || busy} onClick={() => void apply(null)}>{t('project.view.batch_clear')}</Button>
          <Button size="sm" variant="primary" disabled={!property || busy} onClick={() => void apply(latest.current === '' ? null : latest.current)}>{t('common.save')}</Button>
        </div>
      </div>
    </Modal>
  )
}
