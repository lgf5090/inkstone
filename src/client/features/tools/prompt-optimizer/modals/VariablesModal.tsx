/**
 * The variable library: add, edit, delete, import and export the values that fill `{{name}}`.
 */

import { useState } from 'react'
import { Download, Plus, Trash2, Upload } from 'lucide-react'
import { Button, IconButton } from '../../../../components/primitives'
import { Field, Input, Textarea } from '../../../../components/form'
import { Modal, confirm } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import { usePromptOptimizerStore } from '../store'
import { validateVariableName } from '@shared/tools/prompt-optimizer/variables'
import { PREDEFINED_VARIABLES } from '@shared/tools/prompt-optimizer/types'
import type { VariableEntry } from '@shared/tools/prompt-optimizer/types'
import { parseCSVRows } from '@shared/tools/password/csv-parser'

export function VariablesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const variables = usePromptOptimizerStore((s) => s.variables)
  const saveVariable = usePromptOptimizerStore((s) => s.saveVariable)
  const importVariables = usePromptOptimizerStore((s) => s.importVariables)
  const refreshVariables = usePromptOptimizerStore((s) => s.refreshVariables)
  const [draft, setDraft] = useState<{ name: string; value: string; description: string }>({ name: '', value: '', description: '' })
  const [error, setError] = useState('')
  const [importText, setImportText] = useState('')
  const [showImport, setShowImport] = useState(false)

  const submit = async () => {
    const problem = validateVariableName(draft.name.trim())
    if (problem) {
      setError(t('tools.prompt_optimizer.variables.invalid_name'))
      return
    }
    setError('')
    await saveVariable({ name: draft.name.trim(), value: draft.value, description: draft.description })
    setDraft({ name: '', value: '', description: '' })
  }

  const importItems = async () => {
    const parsed = parseVariables(importText).filter((variable) => !validateVariableName(variable.name))
    if (!parsed.length) {
      setError(t('tools.prompt_optimizer.variables.import_empty'))
      return
    }
    await importVariables(parsed)
    await refreshVariables()
    setImportText('')
    setShowImport(false)
    setError('')
  }

  const exportVariables = () => {
    const payload = Object.fromEntries(variables.map((variable) => [variable.name, variable.value]))
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'prompt-optimizer-variables.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('tools.prompt_optimizer.variables.title')}
      width={680}
      footer={<Button variant="ghost" onClick={onClose}>{t('tools.prompt_optimizer.common.close')}</Button>}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowImport((current) => !current)}>
            <Upload size={13} />
            {t('tools.prompt_optimizer.variables.import')}
          </Button>
          <Button variant="ghost" size="sm" onClick={exportVariables} disabled={!variables.length}>
            <Download size={13} />
            {t('tools.prompt_optimizer.variables.export')}
          </Button>
        </div>
        {showImport && (
          <div className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-2">
            <Field label={t('tools.prompt_optimizer.variables.import_hint')}>
              <Textarea value={importText} rows={5} onChange={(event) => setImportText(event.target.value)} className="font-mono text-[length:var(--text-12)]" />
            </Field>
            <div className="flex justify-end">
              <Button variant="primary" size="sm" onClick={() => void importItems()} disabled={!importText.trim()}>
                {t('tools.prompt_optimizer.common.import')}
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('tools.prompt_optimizer.variables.predefined')}:
          </span>
          {PREDEFINED_VARIABLES.map((name) => <code key={name} className="rounded bg-[var(--bg-raised)] px-1 py-0.5 font-mono text-[length:var(--text-10)] text-[var(--text-tertiary)]">{`{{${name}}}`}</code>)}
        </div>
        <div className="max-h-[45vh] overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]">
          {variables.length === 0 ? (
            <p className="p-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('tools.prompt_optimizer.variables.empty')}
            </p>
          ) : variables.map((variable) => (
            <VariableRow key={variable.name} variable={variable} onDelete={() => void removeVariable(variable)} />
          ))}
        </div>

        <div className="grid grid-cols-1 gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-3 sm:grid-cols-2">
          <Field label={t('tools.prompt_optimizer.variables.name')}>
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="userName" />
          </Field>
          <Field label={t('tools.prompt_optimizer.variables.value')}>
            <Input value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value })} />
          </Field>
          <Field label={t('tools.prompt_optimizer.variables.description')}>
            <Input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
          </Field>
          <div className="flex items-end">
            <Button variant="secondary" onClick={() => void submit()} disabled={!draft.name.trim()}>
              <Plus size={13} />
              {t('tools.prompt_optimizer.variables.add')}
            </Button>
          </div>
          {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)] sm:col-span-2">{error}</p>}
        </div>
      </div>
    </Modal>
  )
}

function VariableRow({ variable, onDelete }: { variable: VariableEntry; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 last:border-b-0">
      <span className="w-36 shrink-0 truncate font-mono text-[length:var(--text-12)] text-[var(--text-primary)]">{variable.name}</span>
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">{variable.value || '—'}</span>
      <IconButton label={t('tools.prompt_optimizer.common.delete')} size="xs" onClick={onDelete}>
        <Trash2 size={12} />
      </IconButton>
    </div>
  )
}

async function removeVariable(variable: VariableEntry) {
  const ok = await confirm({
    title: t('tools.prompt_optimizer.variables.delete_confirm').replace('{name}', variable.name),
    tone: 'danger',
  })
  if (!ok) return
  await usePromptOptimizerStore.getState().deleteVariable(variable.name)
}

function parseVariables(text: string): { name: string; value: string; description: string }[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => {
            const record = item as Record<string, unknown>
            return {
              name: typeof record.name === 'string' ? record.name : '',
              value: typeof record.value === 'string' ? record.value : '',
              description: typeof record.description === 'string' ? record.description : '',
            }
          })
          .filter((item) => item.name)
      }
      if (parsed && typeof parsed === 'object') {
        return Object.entries(parsed as Record<string, unknown>)
          .map(([name, value]) => ({ name, value: typeof value === 'string' ? value : String(value), description: '' }))
      }
    } catch {
      return []
    }
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean)
  if (lines[0]?.toLowerCase().startsWith('name,')) {
    return parseCSVRows(lines.join('\n'))
      .slice(1)
      .map(([name, value, description]) => ({
        name: (name ?? '').trim(),
        value: (value ?? '').trim(),
        description: (description ?? '').trim(),
      }))
      .filter((item) => item.name)
  }
  return lines.map((line) => {
    const index = line.indexOf('=')
    return index > 0
      ? { name: line.slice(0, index).trim(), value: line.slice(index + 1).trim(), description: '' }
      : { name: line.trim(), value: '', description: '' }
  }).filter((item) => item.name)
}
