/**
 * Tool definitions for function-calling tests in the multi-message workspace.
 */

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, IconButton } from '../../../../components/primitives'
import { Field, Input, Textarea } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import type { ToolDefinition } from '@shared/tools/prompt-optimizer/types'
import { usePromptOptimizerStore } from '../store'

export function ToolsPanel() {
  const workspace = usePromptOptimizerStore((s) => s.workspace)
  const draft = usePromptOptimizerStore((s) => s.drafts[workspace])
  const updateDraft = usePromptOptimizerStore((s) => s.updateDraft)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [parameters, setParameters] = useState('{"type":"object","properties":{}}')
  const [error, setError] = useState('')

  const add = () => {
    if (!name.trim()) return
    let parsed: Record<string, unknown>
    try {
      const value = JSON.parse(parameters) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object')
      parsed = value as Record<string, unknown>
    } catch {
      setError(t('tools.prompt_optimizer.workspace.tool_invalid'))
      return
    }
    setError('')
    const tool: ToolDefinition = {
      type: 'function',
      function: { name: name.trim(), description: description.trim(), parameters: parsed },
    }
    updateDraft({ tools: [...draft.tools, tool] })
    setName('')
    setDescription('')
  }

  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-2">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.prompt_optimizer.workspace.tools')}
        </span>
      </div>
      {draft.tools.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1">
          {draft.tools.map((tool, index) => (
            <li key={`${tool.function.name}-${index}`} className="flex items-center gap-2 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-2 py-1">
              <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-12)] text-[var(--text-primary)]">{tool.function.name}</span>
              <span className="min-w-0 max-w-[50%] truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{tool.function.description}</span>
              <IconButton
                label={t('tools.prompt_optimizer.common.delete')}
                size="xs"
                onClick={() => updateDraft({ tools: draft.tools.filter((_, at) => at !== index) })}
              >
                <Trash2 size={12} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label={t('tools.prompt_optimizer.workspace.tool_name')}>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="search_notes" />
        </Field>
        <Field label={t('tools.prompt_optimizer.workspace.tool_description')}>
          <Input value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <Field label={t('tools.prompt_optimizer.workspace.tool_parameters')}>
          <Textarea value={parameters} rows={3} onChange={(event) => setParameters(event.target.value)} className="font-mono text-[length:var(--text-11)]" />
        </Field>
        <div className="flex items-end">
          <Button variant="secondary" size="sm" disabled={!name.trim()} onClick={add}>
            <Plus size={13} />
            {t('tools.prompt_optimizer.workspace.add_tool')}
          </Button>
        </div>
      </div>
      {error && <p role="alert" className="mt-1 text-[length:var(--text-11)] text-[var(--danger)]">{error}</p>}
    </div>
  )
}
