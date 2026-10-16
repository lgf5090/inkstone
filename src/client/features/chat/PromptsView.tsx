/**
 * The reader's own prompt library.
 *
 * A prompt is a piece of the reader's work, not a setting: it is written once and pasted into many
 * conversations, so it gets its own view, its own search, and a delete that asks first. The composer
 * reads the same list through the store, which is why nothing here keeps a copy.
 *
 * A prompt may also carry the arrangement around its words — the tools it wants, the folders it reads,
 * the model that answers — because a phrase the reader types twice a week is rarely only a phrase: half
 * of what they retype each time is "and look in my work folder with the big model". Those three travel
 * with the text and are applied together when the prompt is picked, which is what makes it a skill
 * rather than a snippet.
 */
import { useEffect, useMemo, useState } from 'react'
import { FileText, Folder, Pencil, Plus, Search, Trash2, Wrench } from 'lucide-react'
import type { AssistantModel, AssistantTurnScope, ChatPrompt } from '@shared/assistant'
import { MAX_PROMPT_CONTENT_CHARS, MAX_PROMPT_TITLE_CHARS, MAX_TURN_SCOPES, MAX_TURN_TOOLS } from '@shared/assistant'
import { ASSISTANT_TOOL_BY_NAME } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { useDebounced } from '../../lib/hooks'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input, Select, Textarea } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { useAssistant } from './assistant-store'
import { NoteScopePicker, useVaultFolders } from './NoteScopePicker'

const UNGROUPED = '__none__'

/** What the editor holds while it is open: the saved row, or an empty one being written. */
interface Draft {
  id: string | null
  title: string
  content: string
  group: string
  tools: string[]
  scopes: AssistantTurnScope[]
  modelId: string | null
}

const EMPTY: Draft = { id: null, title: '', content: '', group: '', tools: [], scopes: [], modelId: null }

const draftOf = (prompt: ChatPrompt): Draft => ({
  id: prompt.id,
  title: prompt.title,
  content: prompt.content,
  group: prompt.group,
  tools: prompt.tools,
  scopes: prompt.scopes,
  modelId: prompt.modelId,
})

/** The binding summary one row shows under its words, or nothing when the prompt is only words. */
function bindingHint(prompt: ChatPrompt, models: AssistantModel[]): string {
  const parts: string[] = []
  if (prompt.tools.length) parts.push(t('assistant.prompts.tools_count', { count: prompt.tools.length }))
  if (prompt.scopes.length) parts.push(t('assistant.prompts.knowledge_count', { count: prompt.scopes.length }))
  const model = prompt.modelId ? models.find((entry) => entry.id === prompt.modelId) : null
  if (model) parts.push(model.label || model.model)
  return parts.join(' · ')
}

function PromptEditor({ draft, models, busy, onChange, onSubmit, onClose }: {
  draft: Draft
  models: AssistantModel[]
  busy: boolean
  onChange: (draft: Draft) => void
  onSubmit: (draft: Draft) => void
  onClose: () => void
}) {
  const patch = (part: Partial<Draft>) => onChange({ ...draft, ...part })
  const folders = useVaultFolders()
  // The built-in registry is what a reader may pin by name; a remote tool they have not listed here would
  // be a name nothing can resolve later, so the picker offers only what the assistant always has.
  const tools = useMemo(() => [...ASSISTANT_TOOL_BY_NAME.keys()], [])
  const toggleTool = (name: string) => {
    if (draft.tools.includes(name)) patch({ tools: draft.tools.filter((entry) => entry !== name) })
    else if (draft.tools.length < MAX_TURN_TOOLS) patch({ tools: [...draft.tools, name] })
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={draft.id ? t('assistant.prompts.edit') : t('assistant.prompts.new')}
      width={620}
      bodyClassName="p-4 space-y-3"
      footer={(
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={!draft.title.trim() && !draft.content.trim()}
            onClick={() => onSubmit(draft)}
          >
            {t('assistant.prompts.save')}
          </Button>
        </>
      )}
    >
      <Input autoFocus value={draft.title} maxLength={MAX_PROMPT_TITLE_CHARS} aria-label={t('assistant.prompts.field_title')} placeholder={t('assistant.prompts.field_title')} onChange={(event) => patch({ title: event.target.value })} />
      <Input value={draft.group} maxLength={60} aria-label={t('assistant.prompts.group')} placeholder={t('assistant.prompts.group')} onChange={(event) => patch({ group: event.target.value })} />
      <Textarea
        value={draft.content}
        maxLength={MAX_PROMPT_CONTENT_CHARS}
        rows={9}
        aria-label={t('assistant.prompts.field_content')}
        placeholder={t('assistant.prompts.field_content')}
        className="w-full resize-y font-mono text-[length:var(--text-12-5)]"
        onChange={(event) => patch({ content: event.target.value })}
      />
      <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{draft.content.length} / {MAX_PROMPT_CONTENT_CHARS}</p>

      <Field label={t('assistant.prompts.tools')} hint={t('assistant.prompts.tools_hint')}>
        <div className="flex flex-wrap gap-1">
          {tools.map((name) => {
            const spec = ASSISTANT_TOOL_BY_NAME.get(name)!
            const on = draft.tools.includes(name)
            return (
              <button
                key={name}
                type="button"
                aria-pressed={on}
                onClick={() => toggleTool(name)}
                className={cn(
                  'rounded-[var(--r-sm)] border px-2 py-0.5 text-[length:var(--text-11-5)] transition-colors duration-[var(--dur-fast)]',
                  on
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                    : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                {t(spec.labelKey)}
              </button>
            )
          })}
        </div>
      </Field>

      <Field label={t('assistant.prompts.knowledge')} hint={t('assistant.prompts.knowledge_hint')}>
        <NoteScopePicker
          value={draft.scopes.map((entry) => entry.id)}
          onChange={(ids) => patch({
            scopes: ids.slice(0, MAX_TURN_SCOPES).map((id) => ({
              kind: 'folder' as const,
              id,
              name: folders.find((folder) => folder.id === id)?.path ?? '',
            })),
          })}
          disabled={busy}
        />
      </Field>

      <Field label={t('assistant.prompts.model')} hint={t('assistant.prompts.model_hint')}>
        <Select
          aria-label={t('assistant.prompts.model')}
          value={draft.modelId ?? ''}
          onChange={(event) => patch({ modelId: event.target.value || null })}
        >
          <option value="">{t('assistant.prompts.model_follow')}</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>{model.label || model.model}</option>
          ))}
        </Select>
      </Field>
    </Modal>
  )
}

export function PromptsView() {
  const prompts = useAssistant((state) => state.prompts)
  const loadPrompts = useAssistant((state) => state.loadPrompts)
  const createPrompt = useAssistant((state) => state.createPrompt)
  const savePrompt = useAssistant((state) => state.savePrompt)
  const removePrompt = useAssistant((state) => state.removePrompt)
  const models = useAssistant((state) => state.models)
  const loadSettings = useAssistant((state) => state.loadSettings)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { void loadPrompts() }, [loadPrompts])
  // The model bound to a prompt is named by id, so the list has to be there before the editor can offer it.
  useEffect(() => { void loadSettings() }, [loadSettings])
  const settledQuery = useDebounced(query, 180)
  useEffect(() => {
    void loadPrompts(settledQuery.trim() || undefined)
  }, [settledQuery, loadPrompts])

  const chatModels = useMemo(() => models.filter((model) => model.enabled && model.purpose === 'chat'), [models])

  const groups = useMemo(() => {
    const order: string[] = []
    const buckets = new Map<string, ChatPrompt[]>()
    for (const prompt of prompts) {
      const key = prompt.group || UNGROUPED
      if (!buckets.has(key)) { buckets.set(key, []); order.push(key) }
      buckets.get(key)!.push(prompt)
    }
    return order.map((key) => ({ key, label: key === UNGROUPED ? t('assistant.prompts.ungrouped') : key, rows: buckets.get(key)! }))
  }, [prompts])

  const submit = async (next: Draft) => {
    setBusy(true)
    try {
      const input = {
        title: next.title.trim() || next.content.trim().slice(0, 40),
        content: next.content,
        group: next.group.trim(),
        tools: next.tools,
        scopes: next.scopes,
        modelId: next.modelId,
      }
      if (next.id) await savePrompt(next.id, input)
      else await createPrompt(input)
      setDraft(null)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (prompt: ChatPrompt) => {
    const ok = await confirm({
      title: t('assistant.prompts.delete'),
      description: prompt.title,
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (ok) await removePrompt(prompt.id)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2.5">
        {/* The wrapper carries the row's growth: the field hands its own `className` to the `<input>`, which
            cannot size the box around it. */}
        <div className="min-w-0 flex-1">
          <Input
            value={query}
            aria-label={t('assistant.prompts.search')}
            placeholder={t('assistant.prompts.search')}
            leading={<Search size={13} />}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setDraft(EMPTY)}>{t('assistant.prompts.new')}</Button>
      </div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!prompts.length && <p className="px-2 py-6 text-center text-[length:var(--text-12-5)] text-[var(--text-quaternary)]">{t('assistant.prompts.empty')}</p>}
        {groups.map((bucket) => (
          <section key={bucket.key} className="mb-2">
            <h3 className="px-2 py-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">{bucket.label}</h3>
            <ul className="space-y-1">
              {bucket.rows.map((prompt) => {
                const hint = bindingHint(prompt, chatModels)
                return (
                  <li key={prompt.id} className="group flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-2 hover:border-[var(--border-default)]">
                    <FileText size={13} className="mt-0.5 shrink-0 text-[var(--text-quaternary)]" />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setDraft(draftOf(prompt))}>
                      <span className="block truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{prompt.title}</span>
                      <span className={cn('block truncate text-[length:var(--text-11-5)] text-[var(--text-quaternary)]')}>{prompt.content.replace(/\s+/g, ' ')}</span>
                      {hint && (
                        <span className="mt-0.5 flex items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                          {prompt.tools.length > 0 && <Wrench size={10} aria-hidden />}
                          {prompt.scopes.length > 0 && <Folder size={10} aria-hidden />}
                          {hint}
                        </span>
                      )}
                    </button>
                    <IconButton label={t('assistant.prompts.edit')} size="xs" onClick={() => setDraft(draftOf(prompt))}><Pencil size={12} /></IconButton>
                    <IconButton label={t('assistant.prompts.delete')} size="xs" onClick={() => void remove(prompt)}><Trash2 size={12} /></IconButton>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
      {draft && (
        <PromptEditor
          draft={draft}
          models={chatModels}
          busy={busy}
          onChange={setDraft}
          onSubmit={(next) => void submit(next)}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  )
}
