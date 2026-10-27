/**
 * Advanced bindings: Workers AI, Durable Objects, service bindings and queues.
 *
 * Pages has no Durable Objects, service or queue bindings, so those rows disappear when the dialog is
 * deploying a Pages project; only the AI switch remains.
 */
import { Trash2 } from 'lucide-react'
import { Input, Switch } from '../../../../components/form'
import { Button, IconButton } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { useCfT } from '../../i18n'
import type { DeployBindingInput } from '../../api/workers'

type AdvancedType = 'durable_object' | 'service' | 'queue'

export function DeployAdvancedTab({
  value,
  onChange,
  isPages,
  aiEnabled,
  onAiEnabledChange,
}: {
  value: DeployBindingInput[]
  onChange: (next: DeployBindingInput[]) => void
  isPages: boolean
  aiEnabled: boolean
  onAiEnabledChange: (next: boolean) => void
}) {
  const t = useCfT()
  const typeOptions: Array<{ value: AdvancedType; label: string }> = [
    { value: 'durable_object', label: t('cloudflare.workers.advanced.durable_object') },
    { value: 'service', label: t('cloudflare.workers.advanced.service_binding') },
    { value: 'queue', label: t('cloudflare.workers.advanced.queue') },
  ]

  function updateRow(index: number, patch: Partial<DeployBindingInput>): void {
    onChange(value.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Switch checked={aiEnabled} label={t('cloudflare.workers.advanced.ai_label')} onChange={onAiEnabledChange} />
        <span className="text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
          {t('cloudflare.workers.advanced.ai_label')}
        </span>
      </div>
      {isPages ? (
        <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {t('cloudflare.workers.advanced.pages_hint')}
        </p>
      ) : (
        <>
          {value.map((row, index) => (
            <div key={index} className="flex flex-wrap items-center gap-1.5">
              <div className="w-40">
                <SelectMenu
                  label={t('cloudflare.workers.advanced.binding_name_placeholder')}
                  value={(row.type as AdvancedType) || 'durable_object'}
                  options={typeOptions}
                  onChange={(next) => updateRow(index, { type: next })}
                  width={220}
                />
              </div>
              <Input
                value={row.name}
                aria-label={t('cloudflare.workers.advanced.binding_name_placeholder')}
                placeholder={t('cloudflare.workers.advanced.binding_name_placeholder')}
                className="w-40"
                onChange={(event) => updateRow(index, { name: event.target.value })}
              />
              {row.type === 'durable_object' && (
                <Input
                  value={row.className ?? ''}
                  aria-label={t('cloudflare.workers.advanced.class_name_placeholder')}
                  placeholder={t('cloudflare.workers.advanced.class_name_placeholder')}
                  className="min-w-40 flex-1"
                  onChange={(event) => updateRow(index, { className: event.target.value })}
                />
              )}
              {row.type === 'service' && (
                <Input
                  value={row.service ?? ''}
                  aria-label={t('cloudflare.workers.advanced.service_placeholder')}
                  placeholder={t('cloudflare.workers.advanced.service_placeholder')}
                  className="min-w-40 flex-1"
                  onChange={(event) => updateRow(index, { service: event.target.value })}
                />
              )}
              {row.type === 'queue' && (
                <Input
                  value={row.queueName ?? ''}
                  aria-label={t('cloudflare.workers.advanced.queue_placeholder')}
                  placeholder={t('cloudflare.workers.advanced.queue_placeholder')}
                  className="min-w-40 flex-1"
                  onChange={(event) => updateRow(index, { queueName: event.target.value })}
                />
              )}
              <IconButton
                label={t('common.delete')}
                size="sm"
                onClick={() => onChange(value.filter((_, rowIndex) => rowIndex !== index))}
              >
                <Trash2 size={13} />
              </IconButton>
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onChange([...value, { type: 'durable_object', name: '' }])}
          >
            {t('cloudflare.workers.advanced.add')}
          </Button>
        </>
      )}
    </div>
  )
}
