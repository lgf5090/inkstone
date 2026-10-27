/**
 * KV, D1 and R2 bindings in the deploy dialog.
 *
 * One selected account can choose from its existing resources; several accounts cannot, because the
 * same resource name may be a different id in each. In that case the binding names a resource and the
 * server creates or reuses it per account.
 */
import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Input } from '../../../../components/form'
import { Button, IconButton } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { workersApi, type DeployBindingInput } from '../../api/workers'
import { useCfT } from '../../i18n'

const AUTO = '__auto__'

export function DeployResourceTab({
  value,
  onChange,
  resourceType,
  accountIds,
}: {
  value: DeployBindingInput[]
  onChange: (next: DeployBindingInput[]) => void
  resourceType: 'kv' | 'd1' | 'r2'
  accountIds: string[]
}) {
  const t = useCfT()
  const [resources, setResources] = useState<Array<{ value: string; label: string }>>([])
  const [r2Disabled, setR2Disabled] = useState(false)
  const isMultiAccount = accountIds.length > 1
  const accountKey = accountIds.join(',')

  useEffect(() => {
    if (isMultiAccount || accountIds.length === 0) {
      setResources([])
      return
    }
    let cancelled = false
    const accountId = accountIds[0]!
    void (async () => {
      try {
        if (resourceType === 'kv') {
          const list = await workersApi.getKvNamespaces(accountId)
          if (!cancelled) setResources(list.map((item) => ({ value: item.id, label: item.title || item.id })))
        } else if (resourceType === 'd1') {
          const list = await workersApi.getD1Databases(accountId)
          if (!cancelled) {
            setResources(list.map((item) => ({
              value: item.uuid || item.name || '',
              label: item.name || item.uuid || '',
            })))
          }
        } else {
          const answer = await workersApi.getR2Buckets(accountId)
          if (cancelled) return
          setR2Disabled(answer.r2_not_enabled)
          setResources(answer.buckets.map((bucket) => ({
            value: bucket.name || '',
            label: bucket.name || '',
          })))
        }
      } catch (error) {
        console.warn('[inkstone] Deploy resource list failed:', error)
        if (!cancelled) setResources([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [resourceType, accountKey, isMultiAccount, accountIds])

  function updateRow(index: number, patch: Partial<DeployBindingInput>): void {
    onChange(value.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
  }

  function chooseResource(index: number, id: string): void {
    if (id === AUTO) updateRow(index, { mode: 'auto', existingId: undefined })
    else updateRow(index, { mode: 'existing', existingId: id })
  }

  const options = [{ value: AUTO, label: t('cloudflare.workers.resources.auto_create') }, ...resources]

  return (
    <div className="space-y-2">
      {isMultiAccount && (
        <p className="rounded-[var(--r-sm)] bg-[var(--bg-sunken)] p-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {t('cloudflare.workers.resources.multi_account_hint')}
        </p>
      )}
      {r2Disabled && (
        <p role="status" className="text-[length:var(--text-11-5)] text-[var(--warning)]">
          {t('cloudflare.pages_settings.msg.r2_not_enabled')}
        </p>
      )}
      {value.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-1.5">
          <Input
            value={row.name}
            aria-label={t('cloudflare.workers.resources.binding_name_placeholder')}
            placeholder={t('cloudflare.workers.resources.binding_name_placeholder')}
            className="w-44"
            onChange={(event) => updateRow(index, { name: event.target.value })}
          />
          {isMultiAccount ? (
            <Input
              value={row.resourceName ?? ''}
              aria-label={t('cloudflare.workers.resources.resource_name_multi_placeholder')}
              placeholder={t('cloudflare.workers.resources.resource_name_multi_placeholder')}
              className="min-w-44 flex-1"
              onChange={(event) => updateRow(index, { resourceName: event.target.value })}
            />
          ) : (
            <>
              <div className="min-w-48 flex-1">
                <SelectMenu
                  label={t('cloudflare.workers.resources.select_placeholder')}
                  value={row.mode === 'existing' && row.existingId ? row.existingId : AUTO}
                  options={options}
                  onChange={(next) => chooseResource(index, next)}
                  placeholder={t('cloudflare.workers.resources.select_placeholder')}
                  width={260}
                />
              </div>
              {row.mode !== 'existing' && (
                <Input
                  value={row.resourceName ?? ''}
                  aria-label={t('cloudflare.workers.resources.resource_name_auto_placeholder')}
                  placeholder={t('cloudflare.workers.resources.resource_name_auto_placeholder')}
                  className="min-w-40 flex-1"
                  onChange={(event) => updateRow(index, { resourceName: event.target.value })}
                />
              )}
            </>
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
        onClick={() => onChange([...value, { type: resourceType, name: '', mode: 'auto' }])}
      >
        {t('cloudflare.workers.resources.add')}
      </Button>
    </div>
  )
}
