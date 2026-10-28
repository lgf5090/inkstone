import { Plus, Trash2 } from 'lucide-react'
import { MAX_KV_ITEMS } from '@shared/development/api-tester/limits'
import { kv } from '@shared/development/api-tester/state'
import type { KeyValue } from '@shared/development/api-tester/types'
import { Checkbox } from '../../../../components/form'
import { Button, IconButton } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'
import { VariableAutocomplete, type AutocompleteVariable } from './VariableAutocomplete'

export function KvEditor({
  items,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  showCheckbox = true,
  variables = [],
}: {
  items: KeyValue[]
  onChange: (items: KeyValue[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  showCheckbox?: boolean
  variables?: readonly AutocompleteVariable[]
}) {
  const update = (id: string, patch: Partial<KeyValue>) => {
    onChange(items.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  return (
    <div className="space-y-1">
      {items.map((item) => (
        <div key={item.id} className="flex items-center gap-1.5">
          {showCheckbox && (
            <Checkbox
              checked={item.enabled}
              onChange={(enabled) => update(item.id, { enabled })}
              ariaLabel={t('development.apitester.enabled')}
              className="shrink-0"
            />
          )}
          <VariableAutocomplete
            value={item.key}
            variables={variables}
            placeholder={keyPlaceholder ?? t('development.apitester.key_name')}
            ariaLabel={keyPlaceholder ?? t('development.apitester.key_name')}
            wrapperClassName="min-w-0 flex-1"
            className="h-8 font-mono text-[length:var(--text-12)]"
            onValueChange={(key) => update(item.id, { key })}
          />
          <VariableAutocomplete
            value={item.value}
            variables={variables}
            placeholder={valuePlaceholder ?? t('development.apitester.key_value')}
            ariaLabel={valuePlaceholder ?? t('development.apitester.key_value')}
            wrapperClassName="min-w-0 flex-1"
            className="h-8 font-mono text-[length:var(--text-12)]"
            onValueChange={(value) => update(item.id, { value })}
          />
          <IconButton
            label={t('development.apitester.delete')}
            size="sm"
            className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--danger)]"
            onClick={() => onChange(items.filter((entry) => entry.id !== item.id))}
          >
            <Trash2 size={13} />
          </IconButton>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="gap-1 text-[var(--text-secondary)]"
        icon={<Plus size={13} />}
        disabled={items.length >= MAX_KV_ITEMS}
        onClick={() => onChange([...items, kv()])}
      >
        {t('development.apitester.add')}
      </Button>
    </div>
  )
}
