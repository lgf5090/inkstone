import { useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, Globe, Plus, Trash2 } from 'lucide-react'
import { newApiTesterId } from '@shared/development/api-tester/ids'
import type { EnvVariable, Environment } from '@shared/development/api-tester/types'
import { Modal, confirm } from '../../../../components/overlay'
import { Button, IconButton } from '../../../../components/primitives'
import { Checkbox, Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { useApiTesterStore } from '../store'

const GLOBAL = '__global__'

function VariableRow({
  variable,
  onChange,
  onRemove,
}: {
  variable: EnvVariable
  onChange: (patch: Partial<EnvVariable>) => void
  onRemove: () => void
}) {
  const [revealed, setRevealed] = useState(false)
  return (
    <div className="flex items-center gap-1.5">
      <Checkbox checked={variable.enabled} onChange={(next) => onChange({ enabled: next })} ariaLabel={t('development.apitester.enabled')} className="shrink-0" />
      <Input
        value={variable.key}
        onChange={(event) => onChange({ key: event.target.value })}
        placeholder={t('development.apitester.var_name_placeholder')}
        aria-label={t('development.apitester.variable_name')}
        className="h-7 min-w-0 flex-1 font-mono text-[length:var(--text-11-5)]"
      />
      <Input
        value={variable.value}
        type={variable.secret && !revealed ? 'password' : 'text'}
        onChange={(event) => onChange({ value: event.target.value })}
        placeholder={t('development.apitester.var_value_placeholder')}
        aria-label={t('development.apitester.variable_value')}
        className="h-7 min-w-0 flex-1 font-mono text-[length:var(--text-11-5)]"
      />
      <IconButton
        label={variable.secret ? t('development.apitester.show_sensitive') : t('development.apitester.hide_sensitive')}
        size="sm"
        onClick={() => onChange({ secret: variable.secret ? undefined : true })}
        className={cn(variable.secret && 'text-[var(--warning)]')}
      >
        {variable.secret ? <EyeOff size={13} /> : <Eye size={13} />}
      </IconButton>
      {variable.secret && (
        <IconButton label={t('development.apitester.show_sensitive')} size="sm" onClick={() => setRevealed((value) => !value)}>
          {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
        </IconButton>
      )}
      <IconButton label={t('development.apitester.delete')} size="sm" onClick={onRemove} className="text-[var(--text-tertiary)] hover:text-[var(--danger)]">
        <Trash2 size={13} />
      </IconButton>
    </div>
  )
}

function VariableEditor({
  variables,
  onChange,
}: {
  variables: EnvVariable[]
  onChange: (variables: EnvVariable[]) => void
}) {
  return (
    <div className="space-y-1 p-2">
      <div className="flex items-center gap-1.5 px-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
        <span className="w-[15px]" />
        <span className="flex-1">{t('development.apitester.variable_name')}</span>
        <span className="flex-1">{t('development.apitester.variable_value')}</span>
        <span className="w-[72px]" />
      </div>
      {variables.map((variable) => (
        <VariableRow
          key={variable.id}
          variable={variable}
          onChange={(patch) => onChange(variables.map((entry) => (entry.id === variable.id ? { ...entry, ...patch } : entry)))}
          onRemove={() => onChange(variables.filter((entry) => entry.id !== variable.id))}
        />
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1 text-[length:var(--text-11-5)]"
        onClick={() => onChange([...variables, { id: newApiTesterId(), key: '', value: '', enabled: true }])}
      >
        <Plus size={13} /> {t('development.apitester.add_variable')}
      </Button>
    </div>
  )
}

export function EnvironmentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const environments = useApiTesterStore((s) => s.state.environments)
  const activeEnvId = useApiTesterStore((s) => s.state.activeEnvId)
  const globalVariables = useApiTesterStore((s) => s.state.globalVariables)
  const updateEnvironment = useApiTesterStore((s) => s.updateEnvironment)
  const addEnvironment = useApiTesterStore((s) => s.addEnvironment)
  const deleteEnvironment = useApiTesterStore((s) => s.deleteEnvironment)
  const setActiveEnvironment = useApiTesterStore((s) => s.setActiveEnvironment)
  const setGlobalVariables = useApiTesterStore((s) => s.setGlobalVariables)
  const [selectedId, setSelectedId] = useState<string>(GLOBAL)

  useEffect(() => {
    if (!open) return
    setSelectedId(activeEnvId ?? environments[0]?.id ?? GLOBAL)
    // Opening the dialog starts on the active environment; later environment edits must not steal
    // the selection back from a newly created one.
  }, [open])

  const selected = useMemo(() => environments.find((environment) => environment.id === selectedId), [environments, selectedId])
  const isGlobal = selectedId === GLOBAL

  const removeEnvironment = async (environment: Environment) => {
    const ok = await confirm({
      title: t('development.apitester.delete_environment_title'),
      description: t('development.apitester.delete_environment_confirm', { name: environment.name }),
      tone: 'danger',
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    })
    if (ok) deleteEnvironment(environment.id)
  }

  return (
    <Modal open={open} onClose={onClose} title={t('development.apitester.env_dialog_title')} description={t('development.apitester.env_dialog_desc')} width={760}>
      <div className="flex min-h-[360px] flex-col gap-2 sm:flex-row">
        <div className="flex w-full shrink-0 flex-col border-b border-[var(--border-subtle)] pb-2 sm:w-56 sm:border-r sm:border-b-0 sm:pr-2 sm:pb-0">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">{t('development.apitester.environments')}</span>
            <IconButton label={t('development.apitester.new_env')} size="sm" onClick={() => setSelectedId(addEnvironment(`${t('development.apitester.new_env')} ${environments.length + 1}`))}>
              <Plus size={14} />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            <button
              type="button"
              onClick={() => setSelectedId(GLOBAL)}
              className={cn('flex w-full items-center gap-1.5 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[length:var(--text-12)]', isGlobal ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}
            >
              <Globe size={13} className="shrink-0 text-[var(--accent)]" />
              <span className="truncate">{t('development.apitester.global_variables')}</span>
              <span className="ml-auto text-[length:var(--text-10)] text-[var(--text-quaternary)]">{globalVariables.length}</span>
            </button>
            {environments.map((environment) => (
              <button
                key={environment.id}
                type="button"
                onClick={() => setSelectedId(environment.id)}
                className={cn('flex w-full items-center gap-1.5 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[length:var(--text-12)]', selectedId === environment.id ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}
              >
                <span className={cn('size-2 shrink-0 rounded-full', activeEnvId === environment.id ? 'bg-[var(--success)]' : 'bg-[var(--text-quaternary)]/40')} />
                <span className="truncate">{environment.name}</span>
              </button>
            ))}
            {environments.length === 0 && <p className="px-2 py-4 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.apitester.no_env_hint')}</p>}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          {isGlobal ? (
            <>
              <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-2 py-1.5">
                <Globe size={14} className="text-[var(--accent)]" />
                <span className="flex-1 text-[length:var(--text-12)] font-medium">{t('development.apitester.global_variables')}</span>
                <span className="text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{t('development.apitester.global_vars_hint')}</span>
              </div>
              <VariableEditor variables={globalVariables} onChange={setGlobalVariables} />
            </>
          ) : selected ? (
            <>
              <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-2 py-1.5">
                <Input
                  value={selected.name}
                  onChange={(event) => updateEnvironment(selected.id, { name: event.target.value })}
                  aria-label={t('development.apitester.environments')}
                  className="h-7 min-w-0 flex-1 text-[length:var(--text-12)]"
                />
                <Button size="sm" variant={activeEnvId === selected.id ? 'secondary' : 'ghost'} onClick={() => setActiveEnvironment(activeEnvId === selected.id ? null : selected.id)}>
                  {activeEnvId === selected.id ? t('development.apitester.active') : t('development.apitester.set_active')}
                </Button>
                <IconButton label={t('development.apitester.delete')} size="sm" onClick={() => void removeEnvironment(selected)} className="text-[var(--text-tertiary)] hover:text-[var(--danger)]">
                  <Trash2 size={14} />
                </IconButton>
              </div>
              <VariableEditor variables={selected.variables} onChange={(variables) => updateEnvironment(selected.id, { variables })} />
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.apitester.new_or_select_env')}</div>
          )}
        </div>
      </div>
    </Modal>
  )
}
