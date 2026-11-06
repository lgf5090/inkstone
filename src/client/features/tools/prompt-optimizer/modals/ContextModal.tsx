/**
 * Saved conversation contexts for the multi-message workspace.
 */

import { useEffect, useState } from 'react'
import { FolderOpen, Plus, Trash2 } from 'lucide-react'
import { Button, IconButton, Spinner } from '../../../../components/primitives'
import { Field, Input, Textarea } from '../../../../components/form'
import { SelectMenu } from '../../../../components/select-menu'
import { Modal, confirm } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import { promptOptimizerApi } from '../api'
import { useUiStore } from '../../../../lib/ui-store'
import { usePromptOptimizerStore } from '../store'
import type { ContextPackage } from '@shared/tools/prompt-optimizer/types'

export function ContextModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const workspace = usePromptOptimizerStore((s) => s.workspace)
  const draft = usePromptOptimizerStore((s) => s.drafts[workspace])
  const variables = usePromptOptimizerStore((s) => s.variables)
  const updateDraft = usePromptOptimizerStore((s) => s.updateDraft)
  const setWorkspace = usePromptOptimizerStore((s) => s.setWorkspace)
  const [contexts, setContexts] = useState<ContextPackage[]>([])
  const [loading, setLoading] = useState(false)
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<'system' | 'user'>(workspace === 'pro_variable' ? 'user' : 'system')
  const [tags, setTags] = useState('')
  const [description, setDescription] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      setContexts(await promptOptimizerApi.contexts())
    } catch {
      useUiStore.getState().toast(t('tools.prompt_optimizer.errors.load_failed'), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      setMode(workspace === 'pro_variable' ? 'user' : 'system')
      void load()
    }
  }, [open, workspace])

  const save = async () => {
    if (!title.trim()) return
    await promptOptimizerApi.createContext({
      title: title.trim(),
      mode,
      messages: draft.messages,
      variables: Object.fromEntries(variables.map((variable) => [variable.name, variable.value])),
      tools: draft.tools,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      description: description.trim(),
    })
    setTitle('')
    setTags('')
    setDescription('')
    await load()
    useUiStore.getState().toast(t('tools.prompt_optimizer.workspace.context_saved'), 'success')
  }

  const use = async (context: ContextPackage) => {
    // The package records which conversation family it came from; restore that workspace before
    // applying its messages, otherwise a user-mode package lands in the system workspace.
    const target = context.mode === 'user' ? 'pro_variable' : 'pro_multi'
    if (target !== usePromptOptimizerStore.getState().workspace) await setWorkspace(target)
    updateDraft({ messages: context.messages, tools: context.tools, selectedMessageId: context.messages[0]?.id ?? '' })
    if (Object.keys(context.variables).length) {
      // A context carries variable overrides; apply them in memory so optimization uses them without
      // overwriting the user's saved global values.
      usePromptOptimizerStore.setState((state) => ({
        variables: state.variables.map((variable) => (
          context.variables[variable.name] !== undefined ? { ...variable, value: context.variables[variable.name]! } : variable
        )),
      }))
    }
    onClose()
  }

  const remove = async (context: ContextPackage) => {
    const ok = await confirm({
      title: t('tools.prompt_optimizer.workspace.context_delete_confirm').replace('{title}', context.title),
      tone: 'danger',
    })
    if (!ok) return
    await promptOptimizerApi.deleteContext(context.id)
    await load()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('tools.prompt_optimizer.workspace.contexts')}
      width={620}
      footer={<Button variant="ghost" onClick={onClose}>{t('tools.prompt_optimizer.common.close')}</Button>}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-end gap-2">
          <Field label={t('tools.prompt_optimizer.workspace.context_title')}>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Button variant="secondary" onClick={() => void save()} disabled={!title.trim()}>
            <Plus size={13} />
            {t('tools.prompt_optimizer.workspace.save_context')}
          </Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <SelectMenu
            label={t('tools.prompt_optimizer.workspace.context_mode')}
            value={mode}
            options={[
              { value: 'system', label: t('tools.prompt_optimizer.workspace.context_mode_system') },
              { value: 'user', label: t('tools.prompt_optimizer.workspace.context_mode_user') },
            ]}
            onChange={(value) => setMode(value === 'user' ? 'user' : 'system')}
            width={240}
          />
          <Field label={t('tools.prompt_optimizer.workspace.context_tags')}>
            <Input value={tags} onChange={(event) => setTags(event.target.value)} />
          </Field>
        </div>
        <Field label={t('tools.prompt_optimizer.workspace.context_description')}>
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
        </Field>
        {loading ? (
          <div className="flex justify-center py-6"><Spinner size={16} /></div>
        ) : contexts.length === 0 ? (
          <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('tools.prompt_optimizer.workspace.no_contexts')}
          </p>
        ) : (
          <div className="max-h-[45vh] overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]">
            {contexts.map((context) => (
              <div key={context.id} className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 last:border-b-0">
                <FolderOpen size={13} className="text-[var(--text-tertiary)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{context.title}</span>
                <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{context.messages.length}</span>
                <Button variant="ghost" size="sm" onClick={() => void use(context)}>
                  {t('tools.prompt_optimizer.workspace.load_context')}
                </Button>
                <IconButton label={t('tools.prompt_optimizer.common.delete')} size="xs" onClick={() => void remove(context)}>
                  <Trash2 size={12} />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
