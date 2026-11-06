/**
 * Saves the current workspace result as a favorite, with the taxonomy the library filters by.
 */

import { useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import { Button } from '../../../../components/primitives'
import { Checkbox, Field, Input, Textarea } from '../../../../components/form'
import { SelectMenu } from '../../../../components/select-menu'
import { Modal } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import { usePromptOptimizerStore } from '../store'

export function SaveFavoriteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const workspace = usePromptOptimizerStore((s) => s.workspace)
  const draft = usePromptOptimizerStore((s) => s.drafts[workspace])
  const categories = usePromptOptimizerStore((s) => s.categories)
  const evaluation = usePromptOptimizerStore((s) => s.evaluations)
  const saveFavorite = usePromptOptimizerStore((s) => s.saveFavorite)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [withExample, setWithExample] = useState(false)

  useEffect(() => {
    if (!open) return
    const record = draft.versions[draft.versions.length - 1]
    setTitle(record ? `${record.workspace} · v${record.version}` : '')
    setContent(draft.optimized)
    setDescription('')
    setTags('')
    setCategoryId('')
    setWithExample(false)
  }, [open, draft.optimized, draft.versions])

  const submit = async () => {
    if (!title.trim() || !content.trim()) return
    setSaving(true)
    try {
      const functionMode = workspace.startsWith('image_') ? 'image' : workspace.startsWith('pro_') ? 'context' : 'basic'
      await saveFavorite({
        title: title.trim(),
        content,
        description,
        functionMode,
        optimizationMode: workspace === 'basic_user' || workspace === 'pro_variable' ? 'user' : 'system',
        ...(workspace.startsWith('image_') ? { imageSubMode: workspace.replace('image_', '') as never } : {}),
        ...(categoryId ? { categoryId } : {}),
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        metadata: {
          originalContent: draft.prompt,
          sourceHistoryId: draft.chainId,
          modelId: draft.modelId,
          templateId: draft.templateId,
          origin: 'history',
        },
        examples: withExample
          ? draft.testGroups
              .map((group, groupIndex) => ({ group, groupIndex }))
              .filter(({ group }) => group.output.trim())
              .map(({ group, groupIndex }, index) => ({
                id: `ex-${Date.now().toString(36)}-${index}`,
                label: `${t('tools.prompt_optimizer.favorites.examples')} ${index + 1}`,
                systemPrompt: draft.optimized,
                userPrompt: group.input,
                output: group.output,
                modelId: draft.modelId,
                modelLabel: '',
                createdAt: Date.now(),
                // The current evaluation only covers the first group; attach it there so other
                // examples do not inherit a score that was never computed for their input.
                ...(evaluation && groupIndex === 0
                  ? { evaluation: { score: evaluation.score, verdict: evaluation.verdict, feedback: evaluation.raw } }
                  : {}),
              }))
          : [],
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('tools.prompt_optimizer.workspace.save_favorite')}
      width={620}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('tools.prompt_optimizer.common.cancel')}</Button>
          <Button variant="primary" loading={saving} disabled={!title.trim() || !content.trim()} onClick={() => void submit()}>
            <Save size={14} />
            {t('tools.prompt_optimizer.common.save')}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <Field label={t('tools.prompt_optimizer.favorites.title_field')} required>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label={t('tools.prompt_optimizer.favorites.content_field')} required>
          <Textarea value={content} rows={8} onChange={(event) => setContent(event.target.value)} className="font-mono text-[length:var(--text-13)]" />
        </Field>
        <Field label={t('tools.prompt_optimizer.favorites.description_field')}>
          <Textarea value={description} rows={2} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <div className="flex items-center justify-between gap-2 rounded-[var(--r-sm)] bg-[var(--bg-raised)] px-2 py-1.5">
          <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {t('tools.prompt_optimizer.favorites.add_example')}
          </span>
          <Checkbox
            checked={withExample}
            disabled={!draft.testGroups.some((group) => group.output.trim())}
            onChange={setWithExample}
            ariaLabel={t('tools.prompt_optimizer.favorites.add_example')}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('tools.prompt_optimizer.favorites.category')}>
            <SelectMenu
              label={t('tools.prompt_optimizer.favorites.category')}
              value={categoryId}
              options={[{ value: '', label: t('tools.prompt_optimizer.favorites.all_categories') }, ...categories.map((category) => ({ value: category.id, label: category.name }))]}
              onChange={setCategoryId}
              width={220}
            />
          </Field>
          <Field label={t('tools.prompt_optimizer.favorites.tags')}>
            <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder={t('tools.prompt_optimizer.favorites.tags')} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
