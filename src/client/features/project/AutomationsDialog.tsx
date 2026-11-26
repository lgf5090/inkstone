import { useEffect, useState, type ReactElement } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { ProjectAutomation, ProjectAutomationAction, ProjectAutomationCondition } from '@shared/project/automation'
import type { ProjectProperty } from '@shared/project/model'
import { PROJECT_PROPERTY_CAPABILITIES } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Input } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { confirm, Modal } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { createProjectAutomation, deleteProjectAutomation, fetchProjectAutomations, patchProjectAutomation } from './api'

interface AutomationsDialogProps {
  boardId: string
  properties: readonly ProjectProperty[]
  onClose: () => void
}

function describeFailure(reason: unknown): void {
  useUi.getState().toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
}

export function AutomationsDialog({ boardId, properties, onClose }: AutomationsDialogProps): ReactElement {
  const [rules, setRules] = useState<ProjectAutomation[]>([])
  const [actionType, setActionType] = useState<'setValue' | 'notify'>('setValue')
  const [propertyId, setPropertyId] = useState('')
  const [value, setValue] = useState('')
  const [message, setMessage] = useState('')
  const [conditionPropertyId, setConditionPropertyId] = useState('')
  const [conditionValue, setConditionValue] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const actionProperties = properties.filter((property) => !PROJECT_PROPERTY_CAPABILITIES[property.type].readOnly)
  const actionProperty = actionProperties.find((property) => property.id === propertyId)
  const conditionProperty = properties.find((property) => property.id === conditionPropertyId)

  const valueEditor = (property: ProjectProperty | undefined, current: string, label: string, change: (value: string) => void): ReactElement => {
    if (property?.type === 'select') {
      return (
        <SelectMenu
          className="w-full"
          value={current}
          label={label}
          onChange={change}
          options={[{ value: '', label: t('project.value.empty') }, ...property.options.map((option) => ({ value: option.id, label: option.value }))]}
        />
      )
    }
    if (property?.type === 'checkbox') {
      return <Checkbox label={label} checked={current === 'true'} onChange={(checked) => change(checked ? 'true' : 'false')} />
    }
    return <Input className="w-full" value={current} placeholder={label} aria-label={label} onChange={(event) => change(event.target.value)} />
  }

  const ruleSummary = (rule: ProjectAutomation): string => {
    const conditionProperty = properties.find((entry) => entry.id === rule.condition?.propertyId)
    const conditionValue = conditionProperty?.options.find((option) => option.id === rule.condition?.value)?.value ?? rule.condition?.value ?? ''
    const condition = rule.condition ? `${conditionProperty?.name ?? rule.condition.propertyId} = ${conditionValue}` : ''
    const action = rule.action
    if (action.type === 'setValue') {
      const property = properties.find((entry) => entry.id === action.propertyId)
      const value = property?.options.find((option) => option.id === action.value)?.value ?? action.value
      return `${property?.name ?? action.propertyId} = ${value}${condition ? ` · ${condition}` : ''}`
    }
    return `${action.message}${condition ? ` · ${condition}` : ''}`
  }

  useEffect(() => {
    let alive = true
    fetchProjectAutomations(boardId)
      .then((list) => { if (alive) setRules(list) })
      .catch(() => { if (alive) setRules([]) })
    return () => { alive = false }
  }, [boardId])

  const add = async () => {
    const action: ProjectAutomationAction = actionType === 'setValue'
      ? { type: 'setValue', propertyId: propertyId.trim(), value }
      : { type: 'notify', message: message.trim() }
    const condition: ProjectAutomationCondition | null = conditionPropertyId.trim()
      ? { propertyId: conditionPropertyId.trim(), op: 'equals', value: conditionValue }
      : null
    setBusy(true)
    try {
      const created = await createProjectAutomation(boardId, {
        trigger: { type: 'cardValueChanged' },
        condition,
        action,
        enabled,
      })
      setRules((current) => [...current, created])
    } catch (reason) {
      describeFailure(reason)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    const ok = await confirm({ title: t('project.automations.delete'), tone: 'danger', confirmLabel: t('common.delete') })
    if (!ok) return
    try {
      await deleteProjectAutomation(boardId, id)
      setRules((current) => current.filter((rule) => rule.id !== id))
    } catch (reason) {
      describeFailure(reason)
    }
  }

  const toggle = async (rule: ProjectAutomation) => {
    try {
      const updated = await patchProjectAutomation(boardId, rule.id, { enabled: !rule.enabled })
      setRules((current) => current.map((entry) => (entry.id === rule.id ? updated : entry)))
    } catch (reason) {
      describeFailure(reason)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('project.automations.title')}
      width={560}
      footer={<Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>}
    >
      <div className="space-y-3">
        {rules.length === 0 && <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.automations.empty')}</p>}
        {rules.map((rule) => (
          <div key={rule.id} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
            <Checkbox ariaLabel={t('project.automations.enabled')} checked={rule.enabled} onChange={() => void toggle(rule)} />
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {ruleSummary(rule)}
            </span>
            <IconButton label={t('common.delete')} size="sm" onClick={() => void remove(rule.id)}><Trash2 size={14} /></IconButton>
          </div>
        ))}
        <div className="space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
          <SelectMenu
            className="w-full"
            value={actionType}
            label={t('project.automations.action')}
            onChange={(next) => setActionType(next as 'setValue' | 'notify')}
            options={[
              { value: 'setValue', label: t('project.automations.action_set') },
              { value: 'notify', label: t('project.automations.action_notify') },
            ]}
          />
          {actionType === 'setValue' ? (
            <>
              <SelectMenu
                className="w-full"
                value={propertyId}
                label={t('project.automations.property')}
                onChange={(next) => { setPropertyId(next); setValue('') }}
                options={[{ value: '', label: t('project.automations.property') }, ...actionProperties.map((property) => ({ value: property.id, label: property.name }))]}
              />
              {valueEditor(actionProperty, value, t('project.automations.value'), setValue)}
            </>
          ) : (
            <Input className="w-full" value={message} placeholder={t('project.automations.message')} aria-label={t('project.automations.message')} onChange={(event) => setMessage(event.target.value)} />
          )}
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.automations.condition')}</p>
          <SelectMenu
            className="w-full"
            value={conditionPropertyId}
            label={t('project.automations.property')}
            onChange={(next) => { setConditionPropertyId(next); setConditionValue('') }}
            options={[{ value: '', label: t('project.automations.condition') }, ...properties.map((property) => ({ value: property.id, label: property.name }))]}
          />
          {valueEditor(conditionProperty, conditionValue, t('project.automations.value'), setConditionValue)}
          <Checkbox label={t('project.automations.enabled')} checked={enabled} onChange={setEnabled} />
          <Button size="sm" variant="primary" icon={<Plus size={14} />} disabled={busy || (actionType === 'setValue' && !propertyId)} onClick={() => void add()}>{t('project.automations.add')}</Button>
        </div>
      </div>
    </Modal>
  )
}
