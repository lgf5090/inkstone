/**
 * Environment variables in the deploy dialog.
 *
 * Secret rows leave `keep` set until the reader types a value: the secret endpoint returns names but
 * never plaintext, so an untouched row means "leave the deployed secret alone".
 */
import { Trash2 } from 'lucide-react'
import { Input, Switch } from '../../../../components/form'
import { Button, IconButton } from '../../../../components/primitives'
import { useCfT } from '../../i18n'
import type { DeployVarInput } from '../../api/workers'

export function DeployEnvVarsTab({
  value,
  onChange,
}: {
  value: DeployVarInput[]
  onChange: (next: DeployVarInput[]) => void
}) {
  const t = useCfT()

  function updateRow(index: number, patch: Partial<DeployVarInput>): void {
    onChange(value.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
  }

  function setSecret(index: number, secret: boolean): void {
    const row = value[index]
    if (!row) return
    updateRow(index, { secret, keep: secret ? row.keep : false })
  }

  function typeValue(index: number, next: string): void {
    const row = value[index]
    if (!row) return
    updateRow(index, { value: next, ...(row.secret && next ? { keep: false } : {}) })
  }

  return (
    <div className="space-y-2">
      {value.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-1.5">
          <Input
            value={row.name}
            aria-label={t('cloudflare.workers.env_vars.name_placeholder')}
            placeholder={t('cloudflare.workers.env_vars.name_placeholder')}
            className="w-44"
            onChange={(event) => updateRow(index, { name: event.target.value })}
          />
          <Input
            value={row.value ?? ''}
            aria-label={t('cloudflare.workers.env_vars.value_placeholder')}
            type={row.secret ? 'password' : 'text'}
            placeholder={row.secret
              ? (row.keep
                  ? t('cloudflare.workers.env_vars.keep_placeholder')
                  : t('cloudflare.workers.env_vars.secret_value_placeholder'))
              : t('cloudflare.workers.env_vars.value_placeholder')}
            className="min-w-40 flex-1"
            onChange={(event) => typeValue(index, event.target.value)}
          />
          <span className="flex items-center gap-1.5">
            <Switch
              checked={row.secret}
              label={row.secret
                ? t('cloudflare.workers.env_vars.secret_label')
                : t('cloudflare.workers.env_vars.plain_label')}
              onChange={(next) => setSecret(index, next)}
            />
            <span className="w-12 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
              {row.secret
                ? t('cloudflare.workers.env_vars.secret_label')
                : t('cloudflare.workers.env_vars.plain_label')}
            </span>
          </span>
          {row.keep && (
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('cloudflare.workers.env_vars.keep_placeholder')}
            </span>
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
        onClick={() => onChange([...value, { name: '', value: '', secret: false }])}
      >
        {t('cloudflare.workers.env_vars.add')}
      </Button>
    </div>
  )
}
