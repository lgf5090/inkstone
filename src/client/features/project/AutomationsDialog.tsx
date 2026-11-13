import { useEffect, useState, type ReactElement } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { ProjectAutomation, ProjectAutomationAction, ProjectAutomationCondition } from '@shared/project/automation'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Input } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { Modal } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { createProjectAutomation, deleteProjectAutomation, fetchProjectAutomations, patchProjectAutomation } from './api'

interface AutomationsDialogProps {
  boardId: string
  onClose: () => void
}

function describeFailure(reason: unknown): void {
  useUi.getState().toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
}

export function AutomationsDialog({ boardId, onClose }: AutomationsDialogProps): ReactElement {
  const [rules, setRules] = useState<ProjectAutomation[]>([])
  const [actionType, setActionType] = useState<'setValue' | 'notify'>('setValue')
  const [propertyId, setPropertyId] = useState('')
  const [value, setValue] = useState('')
  const [message, setMessage] = useState('')
  const [conditionPropertyId, setConditionPropertyId] = useState('')
  const [conditionValue, setConditionValue] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)

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
              {rule.action.type === 'setValue' ? t('project.automations.action_set') : t('project.automations.action_notify')}
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
              <Input className="w-full" value={propertyId} placeholder={t('project.automations.property')} aria-label={t('project.automations.property')} onChange={(event) => setPropertyId(event.target.value)} />
              <Input className="w-full" value={value} placeholder={t('project.automations.value')} aria-label={t('project.automations.value')} onChange={(event) => setValue(event.target.value)} />
            </>
          ) : (
            <Input className="w-full" value={message} placeholder={t('project.automations.message')} aria-label={t('project.automations.message')} onChange={(event) => setMessage(event.target.value)} />
          )}
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.automations.condition')}</p>
          <Input className="w-full" value={conditionPropertyId} placeholder={t('project.automations.property')} aria-label={t('project.automations.property')} onChange={(event) => setConditionPropertyId(event.target.value)} />
          <Input className="w-full" value={conditionValue} placeholder={t('project.automations.value')} aria-label={t('project.automations.value')} onChange={(event) => setConditionValue(event.target.value)} />
          <Checkbox label={t('project.automations.enabled')} checked={enabled} onChange={setEnabled} />
          <Button size="sm" variant="primary" icon={<Plus size={14} />} disabled={busy} onClick={() => void add()}>{t('project.automations.add')}</Button>
        </div>
      </div>
    </Modal>
  )
}
