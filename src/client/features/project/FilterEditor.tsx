import { useState, type ReactElement } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { ProjectBoardMember, ProjectFilterClause, ProjectFilterGroup, ProjectProperty, ProjectView, ProjectViewFields } from '@shared/project/model'
import { isProjectFilterGroup, PROJECT_CONDITIONS_BY_VALUE_TYPE, PROJECT_PROPERTY_CAPABILITIES } from '@shared/project/model'
import { projectDayToStamp, projectInputToStamp, projectStampToInput } from '@shared/project/date'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Input, Select } from '../../components/form'
import { DatePicker } from '../../components/date-picker'
import { Modal } from '../../components/overlay'

interface FilterModalProps {
  view: ProjectView
  properties: ProjectProperty[]
  members: ProjectBoardMember[]
  canEdit: boolean
  onClose: () => void
  onPatch: (fields: Partial<ProjectViewFields>) => Promise<void>
}

function cloneGroup(group: ProjectFilterGroup): ProjectFilterGroup {
  return {
    operation: group.operation,
    filters: group.filters.map((entry) => (isProjectFilterGroup(entry) ? cloneGroup(entry) : { ...entry, values: [...entry.values] })),
  }
}

function conditionsFor(property: ProjectProperty | undefined) {
  return PROJECT_CONDITIONS_BY_VALUE_TYPE[property ? PROJECT_PROPERTY_CAPABILITIES[property.type].filterValueType : 'text']
}

/** The value editor the reference dispatches on `filterValueType`, one branch per kind of clause. */
function ClauseValue({ clause, property, members, disabled, onChange }: {
  clause: ProjectFilterClause
  property: ProjectProperty | undefined
  members: ProjectBoardMember[]
  disabled: boolean
  onChange: (values: string[]) => void
}): ReactElement | null {
  const valueType = property ? PROJECT_PROPERTY_CAPABILITIES[property.type].filterValueType : 'text'
  if (['isEmpty', 'isNotEmpty', 'isSet', 'isNotSet'].includes(clause.condition)) return null
  if (valueType === 'boolean') return null
  if (valueType === 'options' || valueType === 'person') {
    const choices = valueType === 'options'
      ? (property?.options ?? []).map((option) => ({ id: option.id, label: option.value }))
      : members.map((member) => ({ id: member.userId, label: member.userId }))
    return (
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('project.view.filter_value')}>
        {choices.length === 0 && <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">—</span>}
        {choices.map((choice) => (
          <Checkbox
            key={choice.id}
            label={choice.label}
            checked={clause.values.includes(choice.id)}
            disabled={disabled}
            onChange={(checked) => onChange(checked ? [...clause.values, choice.id] : clause.values.filter((id) => id !== choice.id))}
          />
        ))}
      </div>
    )
  }
  if (valueType === 'date') {
    const stamp = clause.values[0] === undefined ? null : Number(clause.values[0])
    return (
      <div className="flex items-center gap-2">
        <DatePicker
          className="w-40"
          label={t('project.view.filter_value')}
          value={stamp !== null && Number.isFinite(stamp) ? projectStampToInput(stamp) : ''}
          onChange={(raw) => {
            const next = raw ? projectInputToStamp(raw) : null
            onChange(next === null ? [] : [String(next)])
          }}
        />
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange([String(projectDayToStamp(new Date()))])}>{t('project.view.today')}</Button>
        <Button size="sm" variant="ghost" disabled={disabled || clause.values.length === 0} onClick={() => onChange([])}>{t('project.view.clear')}</Button>
      </div>
    )
  }
  return (
    <Input
      className="min-w-0 flex-1"
      value={clause.values[0] ?? ''}
      type={valueType === 'number' ? 'number' : 'text'}
      placeholder={t('project.view.filter_value')}
      aria-label={t('project.view.filter_value')}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value === '' ? [] : [event.target.value])}
    />
  )
}

function ClauseRow({ clause, properties, members, canEdit, onChange, onDelete }: {
  clause: ProjectFilterClause
  properties: ProjectProperty[]
  members: ProjectBoardMember[]
  canEdit: boolean
  onChange: (clause: ProjectFilterClause) => void
  onDelete: () => void
}): ReactElement {
  const property = properties.find((entry) => entry.id === clause.propertyId)
  const filterable = properties.filter((entry) => PROJECT_PROPERTY_CAPABILITIES[entry.type].canFilter)
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-2" data-project-filter-clause={clause.propertyId}>
      <Select
        className="w-32"
        value={clause.propertyId}
        aria-label={t('project.view.filter')}
        disabled={!canEdit}
        onChange={(event) => {
          const next = properties.find((entry) => entry.id === event.target.value)
          onChange({ propertyId: event.target.value, condition: conditionsFor(next).default, values: [] })
        }}
      >
        {filterable.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </Select>
      <Select
        className="w-32"
        value={clause.condition}
        aria-label={t('project.view.filter_condition')}
        disabled={!canEdit}
        onChange={(event) => onChange({ ...clause, condition: event.target.value as ProjectFilterClause['condition'], values: [] })}
      >
        {conditionsFor(property).conditions.map((condition) => <option key={condition} value={condition}>{t(`project.condition.${condition.toLowerCase()}` as Parameters<typeof t>[0])}</option>)}
      </Select>
      <ClauseValue clause={clause} property={property} members={members} disabled={!canEdit} onChange={(values) => onChange({ ...clause, values })} />
      <IconButton label={t('common.delete')} size="sm" disabled={!canEdit} onClick={onDelete}><Trash2 size={14} /></IconButton>
    </div>
  )
}

function GroupEditor({ group, properties, members, canEdit, depth, onChange, onDelete }: {
  group: ProjectFilterGroup
  properties: ProjectProperty[]
  members: ProjectBoardMember[]
  canEdit: boolean
  depth: number
  onChange: (group: ProjectFilterGroup) => void
  onDelete?: () => void
}): ReactElement {
  const first = properties.find((entry) => PROJECT_PROPERTY_CAPABILITIES[entry.type].canFilter)
  const replace = (index: number, entry: ProjectFilterClause | ProjectFilterGroup) => {
    onChange({ ...group, filters: group.filters.map((current, i) => (i === index ? entry : current)) })
  }
  return (
    <div className={`space-y-2 ${depth > 0 ? 'rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2' : ''}`} data-project-filter-group={depth}>
      <div className="flex items-center gap-2">
        <Select
          className="w-24"
          value={group.operation}
          aria-label={t('project.view.filter_operation')}
          disabled={!canEdit}
          onChange={(event) => onChange({ ...group, operation: event.target.value as 'and' | 'or' })}
        >
          <option value="and">{t('project.view.filter_and')}</option>
          <option value="or">{t('project.view.filter_or')}</option>
        </Select>
        {onDelete && <IconButton label={t('common.delete')} size="sm" disabled={!canEdit} onClick={onDelete}><Trash2 size={14} /></IconButton>}
      </div>
      {group.filters.length === 0 && <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.view.no_filters')}</p>}
      {group.filters.map((entry, index) => (
        isProjectFilterGroup(entry)
          ? <GroupEditor key={index} group={entry} properties={properties} members={members} canEdit={canEdit} depth={depth + 1} onChange={(next) => replace(index, next)} onDelete={() => onChange({ ...group, filters: group.filters.filter((_, i) => i !== index) })} />
          : <ClauseRow key={index} clause={entry} properties={properties} members={members} canEdit={canEdit} onChange={(next) => replace(index, next)} onDelete={() => onChange({ ...group, filters: group.filters.filter((_, i) => i !== index) })} />
      ))}
      {canEdit && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            icon={<Plus size={14} />}
            disabled={!first}
            onClick={() => onChange({ ...group, filters: [...group.filters, { propertyId: first!.id, condition: conditionsFor(first).default, values: [] }] })}
          >
            {t('project.view.add_filter')}
          </Button>
          <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => onChange({ ...group, filters: [...group.filters, { operation: 'and', filters: [] }] })}>
            {t('project.view.add_filter_group')}
          </Button>
        </div>
      )}
    </div>
  )
}

export function FilterModal({ view, properties, members, canEdit, onClose, onPatch }: FilterModalProps): ReactElement {
  const [draft, setDraft] = useState<ProjectFilterGroup>(() => cloneGroup(view.fields.filter))
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      await onPatch({ filter: draft })
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('project.view.filter')}
      width={640}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={saving || !canEdit} onClick={() => void save()}>{t('common.save')}</Button>
      </>}
    >
      <GroupEditor group={draft} properties={properties} members={members} canEdit={canEdit} depth={0} onChange={setDraft} />
    </Modal>
  )
}