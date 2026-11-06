/**
 * The template library: the ported builtin catalogue, read-only, beside the reader's own templates.
 */

import { useEffect, useMemo, useState } from 'react'
import { Copy, Download, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { Field, Input, Textarea } from '../../../../components/form'
import { TemplateEditor } from '../components/TemplateEditor'
import { SelectMenu } from '../../../../components/select-menu'
import { Modal, confirm } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import type { MessageTemplate, PromptTemplate, TemplateType } from '@shared/tools/prompt-optimizer/types'
import { promptOptimizerApi } from '../api'
import { usePromptOptimizerStore } from '../store'
import { renderTemplate, templateContextWithHelpers } from '@shared/tools/prompt-optimizer/template-render'

const TYPES: TemplateType[] = [
  'optimize',
  'userOptimize',
  'text2imageOptimize',
  'image2imageOptimize',
  'multiimageOptimize',
  'iterate',
  'conversationMessageOptimize',
  'contextUserOptimize',
  'contextIterate',
  'evaluation',
  'variable-extraction',
  'variable-value-generation',
]

export function TemplatesView() {
  const templates = usePromptOptimizerStore((s) => s.templates)
  const settings = usePromptOptimizerStore((s) => s.settings)
  const saveSettings = usePromptOptimizerStore((s) => s.saveSettings)
  const refreshTemplates = usePromptOptimizerStore((s) => s.refreshTemplates)
  const saveTemplate = usePromptOptimizerStore((s) => s.saveTemplate)
  const deleteTemplate = usePromptOptimizerStore((s) => s.deleteTemplate)
  const [typeFilter, setTypeFilter] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<PromptTemplate | null>(null)
  const [preview, setPreview] = useState<PromptTemplate | null>(null)
  const openPreview = async (template: PromptTemplate) => {
    setPreview(template)
    if (!template.content) {
      try {
        const full = await promptOptimizerApi.getTemplate(template.id)
        setPreview(full)
      } catch {
        // The summary is still readable when the full body cannot be fetched.
      }
    }
  }
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')

  useEffect(() => {
    void refreshTemplates()
  }, [refreshTemplates])

  const builtin = useMemo(
    () => templates.builtin.filter((template) => !typeFilter || template.metadata.templateType === typeFilter),
    [templates.builtin, typeFilter],
  )
  const user = useMemo(
    () => templates.user.filter((template) => !typeFilter || template.metadata.templateType === typeFilter),
    [templates.user, typeFilter],
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2">
        <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
          {t('tools.prompt_optimizer.templates.title')}
        </h1>
        <SelectMenu
          label={t('tools.prompt_optimizer.templates.type')}
          value={typeFilter}
          options={[{ value: '', label: t('tools.prompt_optimizer.templates.type_all') }, ...TYPES.map((type) => ({ value: type, label: type }))]}
          onChange={setTypeFilter}
          width={220}
          size="sm"
        />
        <SelectMenu
          label={t('tools.prompt_optimizer.templates.language')}
          value={settings?.builtinTemplateLanguage ?? 'zh'}
          options={[
            { value: 'zh', label: t('tools.prompt_optimizer.templates.language_zh') },
            { value: 'en', label: t('tools.prompt_optimizer.templates.language_en') },
          ]}
          onChange={(value) => { void saveSettings({ builtinTemplateLanguage: value }); void refreshTemplates() }}
          width={160}
          size="sm"
        />
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
            <Upload size={13} />
            {t('tools.prompt_optimizer.templates.import')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => { setEditing(null); setEditorOpen(true) }}>
            <Plus size={13} />
            {t('tools.prompt_optimizer.templates.new')}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <h2 className="mb-2 text-[length:var(--text-12)] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
          {t('tools.prompt_optimizer.templates.custom')}
        </h2>
        {user.length === 0 ? (
          <p className="mb-4 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('tools.prompt_optimizer.templates.empty')}</p>
        ) : (
          <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {user.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                onEdit={() => { setEditing(template); setEditorOpen(true) }}
                onPreview={() => void openPreview(template)}
                onDelete={() => void confirm({
                  title: t('tools.prompt_optimizer.templates.delete_confirm').replace('{name}', template.name),
                  tone: 'danger',
                }).then((ok) => { if (ok) void deleteTemplate(template.id) })}
              />
            ))}
          </div>
        )}

        <h2 className="mb-2 text-[length:var(--text-12)] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
          {t('tools.prompt_optimizer.templates.builtin')}
        </h2>
        <p className="mb-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('tools.prompt_optimizer.templates.builtin_readonly')}
        </p>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {builtin.map((template) => (
            <TemplateCard
              key={`${template.id}-${template.metadata.language ?? ''}`}
              template={template}
              onPreview={() => void openPreview(template)}
              onDuplicate={() => {
                setEditing({
                  ...template,
                  id: `${template.id}-copy`,
                  name: `${template.name} (copy)`,
                  isBuiltin: false,
                })
                setEditorOpen(true)
              }}
            />
          ))}
        </div>
      </div>

      <TemplateEditorModal open={editorOpen} editing={editing} onClose={() => setEditorOpen(false)} onSave={saveTemplate} />
      <Modal
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        title={preview?.name ?? ''}
        width={760}
        footer={<Button variant="ghost" onClick={() => setPreview(null)}>{t('tools.prompt_optimizer.common.close')}</Button>}
      >
        {preview && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1">
              <Badge tone="neutral">{preview.metadata.templateType}</Badge>
              {preview.metadata.language && <Badge tone="neutral">{preview.metadata.language}</Badge>}
              <Badge tone="neutral">{`v${preview.metadata.version}`}</Badge>
            </div>
            <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-[var(--r-sm)] bg-[var(--bg-raised)] p-3 font-mono text-[length:var(--text-12)]">
              {preview.content
                ? typeof preview.content === 'string'
                  ? renderTemplate(preview.content, templateContextWithHelpers({ originalPrompt: '<prompt>', toolsContext: '', conversationContext: '', hasInputImages: false }))
                  : preview.content.map((message) => `${message.role.toUpperCase()}:\n${renderTemplate(message.content, templateContextWithHelpers({ originalPrompt: '<prompt>', toolsContext: '', conversationContext: '', hasInputImages: false }))}`).join('\n\n')
                : t('tools.prompt_optimizer.templates.builtin_readonly')}
            </pre>
          </div>
        )}
      </Modal>
      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={t('tools.prompt_optimizer.templates.import')}
        width={560}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>{t('tools.prompt_optimizer.common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={!importText.trim()}
              onClick={() => {
                void (async () => {
                  try {
                    const parsed = JSON.parse(importText) as PromptTemplate | PromptTemplate[]
                    const rows = Array.isArray(parsed) ? parsed : [parsed]
                    await promptOptimizerApi.importTemplates(rows)
                    await refreshTemplates()
                    setImportOpen(false)
                    setImportText('')
                  } catch {
                    // Malformed JSON keeps the dialog open.
                  }
                })()
              }}
            >
              {t('tools.prompt_optimizer.common.import')}
            </Button>
          </>
        )}
      >
        <Field label={t('tools.prompt_optimizer.templates.content')}>
          <Textarea value={importText} rows={10} onChange={(event) => setImportText(event.target.value)} className="font-mono text-[length:var(--text-12)]" />
        </Field>
      </Modal>
    </div>
  )
}

function TemplateCard({ template, onEdit, onPreview, onDelete, onDuplicate }: {
  template: PromptTemplate
  onEdit?: () => void
  onPreview: () => void
  onDelete?: () => void
  onDuplicate?: () => void
}) {
  return (
    <article className="flex flex-col rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2">
      <button type="button" className="min-w-0 truncate text-left text-[length:var(--text-13)] font-medium text-[var(--text-primary)] hover:underline" onClick={onPreview}>
        {template.name}
      </button>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Badge tone="neutral">{template.metadata.templateType}</Badge>
        {template.metadata.language && <Badge tone="neutral">{template.metadata.language}</Badge>}
      </div>
      <div className="mt-2 flex items-center gap-1">
        {onDuplicate && (
          <Button variant="ghost" size="sm" onClick={onDuplicate}>
            <Copy size={12} />
            {t('tools.prompt_optimizer.templates.duplicate')}
          </Button>
        )}
        {onEdit && (
          <IconButton label={t('tools.prompt_optimizer.common.edit')} size="xs" onClick={onEdit}>
            <Pencil size={12} />
          </IconButton>
        )}
        {onDelete && (
          <IconButton label={t('tools.prompt_optimizer.common.delete')} size="xs" onClick={onDelete}>
            <Trash2 size={12} />
          </IconButton>
        )}
        {!template.isBuiltin && (
          <IconButton
            label={t('tools.prompt_optimizer.templates.export')}
            size="xs"
            onClick={() => {
              void promptOptimizerApi.exportTemplate(template.id).then((payload) => {
                const blob = new Blob([JSON.stringify(payload.document, null, 2)], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const link = document.createElement('a')
                link.href = url
                link.download = payload.filename
                link.click()
                URL.revokeObjectURL(url)
              })
            }}
          >
            <Download size={12} />
          </IconButton>
        )}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onPreview}>
          {t('tools.prompt_optimizer.templates.preview')}
        </Button>
      </div>
    </article>
  )
}

function TemplateEditorModal({ open, editing, onClose, onSave }: {
  open: boolean
  editing: PromptTemplate | null
  onClose: () => void
  onSave: (template: PromptTemplate, editing: boolean) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<TemplateType>('optimize')
  const [language, setLanguage] = useState('zh')
  const [messages, setMessages] = useState<MessageTemplate[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(editing?.name ?? '')
    setDescription(editing?.metadata.description ?? '')
    setType(editing?.metadata.templateType ?? 'optimize')
    setLanguage(editing?.metadata.language ?? 'zh')
    setMessages(editing
      ? (typeof editing.content === 'string'
          ? [{ role: 'system', content: editing.content }]
          : editing.content.map((message) => ({ ...message })))
      : [{ role: 'system', content: '' }])
  }, [open, editing])

  const hasContent = messages.some((message) => message.content.trim())
  const patchMessage = (index: number, patch: Partial<MessageTemplate>) => {
    setMessages((current) => current.map((message, position) => position === index ? { ...message, ...patch } : message))
  }

  const submit = async () => {
    if (!name.trim() || !hasContent) return
    setSaving(true)
    try {
      const existing = Boolean(editing && !editing.isBuiltin)
      await onSave({
        id: editing?.id && !editing.isBuiltin ? editing.id : `po-${Date.now().toString(36)}`,
        name: name.trim(),
        content: messages.map((message) => ({ ...message, content: message.content })),
        metadata: {
          version: editing?.metadata.version ?? '1.0.0',
          lastModified: Date.now(),
          description,
          templateType: type,
          language: language === 'en' ? 'en' : 'zh',
        },
        isBuiltin: false,
      }, existing)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t('tools.prompt_optimizer.templates.edit') : t('tools.prompt_optimizer.templates.new')}
      width={720}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('tools.prompt_optimizer.common.cancel')}</Button>
          <Button variant="primary" loading={saving} disabled={!name.trim() || !hasContent} onClick={() => void submit()}>
            {t('tools.prompt_optimizer.common.save')}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <Field label={t('tools.prompt_optimizer.templates.name')} required>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('tools.prompt_optimizer.templates.type')}>
            <SelectMenu label={t('tools.prompt_optimizer.templates.type')} value={type} options={TYPES.map((item) => ({ value: item, label: item }))} onChange={setType} width={240} />
          </Field>
          <Field label={t('tools.prompt_optimizer.templates.language')}>
            <SelectMenu
              label={t('tools.prompt_optimizer.templates.language')}
              value={language}
              options={[
                { value: 'zh', label: t('tools.prompt_optimizer.templates.language_zh') },
                { value: 'en', label: t('tools.prompt_optimizer.templates.language_en') },
              ]}
              onChange={setLanguage}
              width={180}
            />
          </Field>
        </div>
        <Field label={t('tools.prompt_optimizer.templates.description')}>
          <Input value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <Field label={t('tools.prompt_optimizer.templates.content')} hint={t('tools.prompt_optimizer.templates.messages_hint')} required>
          <div className="flex flex-col gap-2">
            {messages.map((message, index) => (
              <div key={index} className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
                <div className="flex items-center gap-2">
                  <SelectMenu
                    label={t('tools.prompt_optimizer.templates.message_role')}
                    value={message.role}
                    options={[
                      { value: 'system', label: 'system' },
                      { value: 'user', label: 'user' },
                      { value: 'assistant', label: 'assistant' },
                      { value: 'tool', label: 'tool' },
                    ]}
                    onChange={(value) => patchMessage(index, { role: value as MessageTemplate['role'] })}
                    width={150}
                  />
                  <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{`#${index + 1}`}</span>
                  <IconButton
                    label={t('tools.prompt_optimizer.templates.remove_message')}
                    size="xs"
                    disabled={messages.length <= 1}
                    className="ml-auto"
                    onClick={() => setMessages((current) => current.filter((_, position) => position !== index))}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
                <TemplateEditor
                  value={message.content}
                  onChange={(content) => patchMessage(index, { content })}
                  ariaLabel={`${t('tools.prompt_optimizer.templates.content')} ${index + 1}`}
                />
              </div>
            ))}
            <Button variant="ghost" size="sm" onClick={() => setMessages((current) => [...current, { role: 'user', content: '' }])}>
              <Plus size={13} />
              {t('tools.prompt_optimizer.templates.add_message')}
            </Button>
          </div>
        </Field>
      </div>
    </Modal>
  )
}


