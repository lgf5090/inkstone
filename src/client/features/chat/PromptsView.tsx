/**
 * The reader's own prompt library.
 *
 * A prompt is a piece of the reader's work, not a setting: it is written once and pasted into many
 * conversations, so it gets its own view, its own search, and a delete that asks first. The composer
 * reads the same list through the store, which is why nothing here keeps a copy.
 */
import { useEffect, useMemo, useState } from 'react'
import { FileText, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import type { ChatPrompt } from '@shared/assistant'
import { MAX_PROMPT_CONTENT_CHARS, MAX_PROMPT_TITLE_CHARS } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { useDebounced } from '../../lib/hooks'
import { Button, IconButton } from '../../components/primitives'
import { Input, Textarea } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { useAssistant } from './assistant-store'

const UNGROUPED = '__none__'

function PromptEditor({ prompt, onClose, onSubmit }: {
  prompt: ChatPrompt | null
  onClose: () => void
  onSubmit: (input: { title: string, content: string, group: string }) => void
}) {
  const [title, setTitle] = useState(prompt?.title ?? '')
  const [content, setContent] = useState(prompt?.content ?? '')
  const [group, setGroup] = useState(prompt?.group ?? '')
  const canSave = title.trim().length > 0 || content.trim().length > 0
  return (
    <Modal
      open
      onClose={onClose}
      title={prompt ? t('assistant.prompts.edit') : t('assistant.prompts.new')}
      width={620}
      bodyClassName="p-4 space-y-3"
      footer={(
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button size="sm" variant="primary" disabled={!canSave} onClick={() => onSubmit({ title: title.trim(), content, group: group.trim() })}>
            {t('assistant.prompts.save')}
          </Button>
        </div>
      )}
    >
      <Input autoFocus value={title} maxLength={MAX_PROMPT_TITLE_CHARS} aria-label={t('assistant.prompts.field_title')} placeholder={t('assistant.prompts.field_title')} onChange={(event) => setTitle(event.target.value)} />
      <Input value={group} maxLength={60} aria-label={t('assistant.prompts.group')} placeholder={t('assistant.prompts.group')} onChange={(event) => setGroup(event.target.value)} />
      <Textarea
        value={content}
        maxLength={MAX_PROMPT_CONTENT_CHARS}
        rows={9}
        aria-label={t('assistant.prompts.field_content')}
        placeholder={t('assistant.prompts.field_content')}
        className="w-full resize-y font-mono text-[12.5px]"
        onChange={(event) => setContent(event.target.value)}
      />
      <p className="text-[11px] text-[var(--text-quaternary)]">{content.length} / {MAX_PROMPT_CONTENT_CHARS}</p>
    </Modal>
  )
}

export function PromptsView() {
  const prompts = useAssistant((state) => state.prompts)
  const loadPrompts = useAssistant((state) => state.loadPrompts)
  const createPrompt = useAssistant((state) => state.createPrompt)
  const savePrompt = useAssistant((state) => state.savePrompt)
  const removePrompt = useAssistant((state) => state.removePrompt)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<ChatPrompt | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => { void loadPrompts() }, [loadPrompts])
  const settledQuery = useDebounced(query, 180)
  useEffect(() => {
    void loadPrompts(settledQuery.trim() || undefined)
  }, [settledQuery, loadPrompts])

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

  const submit = async (input: { title: string, content: string, group: string }) => {
    if (editing) await savePrompt(editing.id, input)
    else await createPrompt(input)
    setEditing(null)
    setCreating(false)
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
        <div className="relative min-w-0 flex-1">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" />
          <Input value={query} aria-label={t('assistant.prompts.search')} placeholder={t('assistant.prompts.search')} className="pl-7" onChange={(event) => setQuery(event.target.value)} />
        </div>
        <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>{t('assistant.prompts.new')}</Button>
      </div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!prompts.length && <p className="px-2 py-6 text-center text-[12.5px] text-[var(--text-quaternary)]">{t('assistant.prompts.empty')}</p>}
        {groups.map((bucket) => (
          <section key={bucket.key} className="mb-2">
            <h3 className="px-2 py-1 text-[11px] uppercase tracking-wide text-[var(--text-quaternary)]">{bucket.label}</h3>
            <ul className="space-y-1">
              {bucket.rows.map((prompt) => (
                <li key={prompt.id} className="group flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-2 hover:border-[var(--border-default)]">
                  <FileText size={13} className="mt-0.5 shrink-0 text-[var(--text-quaternary)]" />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(prompt)}>
                    <span className="block truncate text-[12.5px] text-[var(--text-primary)]">{prompt.title}</span>
                    <span className={cn('block truncate text-[11.5px] text-[var(--text-quaternary)]')}>{prompt.content.replace(/\s+/g, ' ')}</span>
                  </button>
                  <IconButton label={t('assistant.prompts.edit')} size="xs" onClick={() => setEditing(prompt)}><Pencil size={12} /></IconButton>
                  <IconButton label={t('assistant.prompts.delete')} size="xs" onClick={() => void remove(prompt)}><Trash2 size={12} /></IconButton>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {(editing || creating) && (
        <PromptEditor prompt={editing} onClose={() => { setEditing(null); setCreating(false) }} onSubmit={(input) => void submit(input)} />
      )}
    </div>
  )
}
