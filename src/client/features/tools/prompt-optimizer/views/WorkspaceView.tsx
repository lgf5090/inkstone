/**
 * One prompt workspace: the editor, its result, the test bench and the evaluation.
 *
 * The screen is shared by the system, user, variable and image modes; only the editor shape and the
 * template type change, so one implementation keeps the shortcuts and the evaluation identical.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  Check,
  Copy,
  ImagePlus,
  Languages,
  Play,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  StopCircle,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { Button, Badge, IconButton, Spinner } from '../../../../components/primitives'
import { Field, Input, Textarea } from '../../../../components/form'
import { SelectMenu } from '../../../../components/select-menu'
import { Modal, Tooltip, confirm } from '../../../../components/overlay'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { copyText } from '../../../../lib/clipboard'
import { navigateToPath } from '../../../../lib/app-history'
import type { TemplateType, Workspace } from '@shared/tools/prompt-optimizer/types'
import { isPredefinedVariable, missingVariables, variableNames } from '@shared/tools/prompt-optimizer/variables'
import { usePromptOptimizerStore, messageId, isConversationWorkspace, type ImagePromptPreview, type TestGroup } from '../store'
import { useUiStore } from '../../../../lib/ui-store'
import { useBreakpoint } from '../../../../lib/hooks'
import { ToolsPanel } from '../panels/ToolsPanel'
import { TemplateEditor } from '../components/TemplateEditor'
import { SaveFavoriteModal } from '../modals/SaveFavoriteModal'
import { VariablesModal } from '../modals/VariablesModal'
import { ContextModal } from '../modals/ContextModal'

const WORKSPACE_TEMPLATE_TYPE: Record<Workspace, TemplateType> = {
  basic_system: 'optimize',
  basic_user: 'userOptimize',
  pro_multi: 'conversationMessageOptimize',
  pro_variable: 'contextUserOptimize',
  image_text2image: 'text2imageOptimize',
  image_image2image: 'image2imageOptimize',
  image_multiimage: 'multiimageOptimize',
  arena: 'optimize',
}

const WORKSPACE_VIEWS: { value: Workspace; icon: typeof Sparkles }[] = [
  { value: 'basic_system', icon: Sparkles },
  { value: 'basic_user', icon: Languages },
  { value: 'pro_multi', icon: Play },
  { value: 'pro_variable', icon: Wand2 },
  { value: 'image_text2image', icon: ImagePlus },
  { value: 'image_image2image', icon: ImagePlus },
  { value: 'image_multiimage', icon: ImagePlus },
]

export function WorkspaceView() {
  const workspace = usePromptOptimizerStore((s) => s.workspace)
  const models = usePromptOptimizerStore((s) => s.models)
  const templates = usePromptOptimizerStore((s) => s.templates)
  const variables = usePromptOptimizerStore((s) => s.variables)
  const busy = usePromptOptimizerStore((s) => s.busy)
  const draft = usePromptOptimizerStore((s) => s.drafts[workspace])
  const setWorkspace = usePromptOptimizerStore((s) => s.setWorkspace)
  const updateDraft = usePromptOptimizerStore((s) => s.updateDraft)
  const optimize = usePromptOptimizerStore((s) => s.optimize)
  const stop = usePromptOptimizerStore((s) => s.stop)
  const analyze = usePromptOptimizerStore((s) => s.analyze)
  const iterate = usePromptOptimizerStore((s) => s.iterate)
  const runTest = usePromptOptimizerStore((s) => s.runTest)
  const evaluate = usePromptOptimizerStore((s) => s.evaluate)
  const rewrite = usePromptOptimizerStore((s) => s.rewrite)
  const useVersion = usePromptOptimizerStore((s) => s.useVersion)
  const extractVariablesAction = usePromptOptimizerStore((s) => s.extractVariables)
  const generateVariableValues = usePromptOptimizerStore((s) => s.generateVariableValues)
  const uploadImage = usePromptOptimizerStore((s) => s.uploadImage)
  const generateImage = usePromptOptimizerStore((s) => s.generateImage)
  const understandImage = usePromptOptimizerStore((s) => s.understandImage)
  const images = usePromptOptimizerStore((s) => s.images)
  const evaluations = usePromptOptimizerStore((s) => s.evaluations)

  const [saveOpen, setSaveOpen] = useState(false)
  const [variablesOpen, setVariablesOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [imagePreview, setImagePreview] = useState<ImagePromptPreview | null>(null)
  const [imagePreviewDraft, setImagePreviewDraft] = useState('')
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false)
  const [showAnalysis, setShowAnalysis] = useState(true)
  const [mobileRegion, setMobileRegion] = useState<'optimize' | 'test'>('optimize')
  const [splitPct, setSplitPct] = useState(50)
  const breakpoint = useBreakpoint()
  const isCompact = breakpoint !== 'desktop'
  const fileRef = useRef<HTMLInputElement>(null)

  const isPro = isConversationWorkspace(workspace)
  const isImage = workspace.startsWith('image_')
  const isVariable = workspace === 'pro_variable'
  const isEditingMessage = isPro && Boolean(draft.selectedMessageId)

  const templateType = WORKSPACE_TEMPLATE_TYPE[workspace]
  const templateOptions = useMemo(() => [
    { value: '', label: t('tools.prompt_optimizer.workspace.template_default') },
    ...templates.builtin
      .filter((template) => template.metadata.templateType === templateType)
      .map((template) => ({ value: template.id, label: template.name })),
    ...templates.user
      .filter((template) => template.metadata.templateType === templateType)
      .map((template) => ({ value: template.id, label: `${template.name} · ${t('tools.prompt_optimizer.templates.custom')}` })),
  ], [templates, templateType])

  const textModelOptions = useMemo(() => {
    const list = models.text.map((model) => ({ value: model.id, label: model.label || model.model }))
    if (!list.length) list.push({ value: '', label: t('tools.prompt_optimizer.arena.no_model') })
    else list.unshift({ value: '', label: t('tools.prompt_optimizer.settings.default_model') })
    return list
  }, [models.text])

  const missing = useMemo(
    () => missingVariables(isEditingMessage ? draft.messages.find((message) => message.id === draft.selectedMessageId)?.content ?? '' : draft.prompt, Object.fromEntries(variables.map((variable) => [variable.name, variable.value]))),
    [draft.prompt, draft.messages, draft.selectedMessageId, isEditingMessage, variables],
  )

  const workspaceOptions = WORKSPACE_VIEWS.map(({ value, icon: Icon }) => ({
    value,
    label: t(`tools.prompt_optimizer.nav.${value}` as never),
    icon: <Icon size={14} className="text-[var(--text-tertiary)]" aria-hidden="true" />,
  }))

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        if (!busy) void optimize(true)
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [busy, optimize])

  const selectedMessage = draft.messages.find((message) => message.id === draft.selectedMessageId)

  const setMessageContent = (id: string, content: string) => {
    updateDraft({
      messages: draft.messages.map((message) => (message.id === id ? { ...message, content } : message)),
    })
  }

  const addMessage = () => {
    const message = { id: messageId(), role: 'user' as const, content: '' }
    updateDraft({ messages: [...draft.messages, message], selectedMessageId: message.id })
  }

  const applyToResult = (value: string) => updateDraft({ optimized: value })

  const addReference = async (file: File) => {
    if (file.size > 8 * 1024 * 1024) {
      useUiStore.getState().toast(t('tools.prompt_optimizer.image.too_large'), 'error')
      return
    }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif'].includes(file.type)) {
      useUiStore.getState().toast(t('tools.prompt_optimizer.image.unsupported'), 'error')
      return
    }
    const dataUrl = await readFileAsDataUrl(file)
    const asset = await uploadImage(dataUrl, 'image', draft.prompt)
    if (asset) updateDraft({ imageIds: [...draft.imageIds, asset.id] })
  }

  const extractReferencePrompt = async (imageId: string) => {
    const preview = await understandImage(imageId)
    if (!preview) return
    setImagePreview(preview)
    setImagePreviewDraft(preview.prompt || preview.rawText)
    setImagePreviewOpen(true)
  }

  const applyImagePreview = async () => {
    if (!imagePreviewDraft.trim()) return
    await usePromptOptimizerStore.getState().applyImagePromptPreview(imagePreviewDraft, imagePreview?.variableDefaults ?? {})
    setImagePreviewOpen(false)
    setImagePreview(null)
  }

  const generatePicture = async () => {
    const asset = await generateImage(draft.prompt || draft.optimized, undefined)
    if (asset) updateDraft({ imageIds: [...draft.imageIds, asset.id] })
  }

  const referenceAssets = draft.imageIds.map((id) => images.find((asset) => asset.id === id)).filter(Boolean)
  const hasImageModel = models.image.length > 0

  return (
    <div data-testid="tools-prompt-optimizer-workspace" className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2">
        <h1 className="hidden text-[length:var(--text-13)] font-semibold text-[var(--text-primary)] lg:block">
          {t('tools.prompt_optimizer.workspace.title')}
        </h1>
        <SelectMenu
          label={t('tools.prompt_optimizer.workspace.mode')}
          value={workspace}
          options={workspaceOptions}
          onChange={(value) => void setWorkspace(value)}
          width={230}
          size="sm"
          className="w-[190px] shrink-0"
        />
        <SelectMenu
          label={t('tools.prompt_optimizer.workspace.model')}
          value={draft.modelId}
          options={textModelOptions}
          onChange={(value) => updateDraft({ modelId: value })}
          width={250}
          size="sm"
          className="w-[190px] shrink-0"
        />
        <SelectMenu
          label={t('tools.prompt_optimizer.workspace.template')}
          value={draft.templateId}
          options={templateOptions}
          onChange={(value) => updateDraft({ templateId: value })}
          width={300}
          size="sm"
          searchable
          className="w-[220px] shrink-0"
        />
        <div className="ml-auto flex items-center gap-1">
          {!models.text.length && <Badge tone="warning">{t('tools.prompt_optimizer.workspace.no_model')}</Badge>}
          <Tooltip label={t('tools.prompt_optimizer.workspace.analyze')}>
            <IconButton label={t('tools.prompt_optimizer.workspace.analyze')} size="sm" onClick={() => void analyze()} disabled={busy !== null}>
              {busy === 'analyze' ? <Spinner size={13} /> : <BarChart3 size={14} />}
            </IconButton>
          </Tooltip>
          <span className="sr-only" aria-live="polite">
            {busy === 'analyze' ? t('tools.prompt_optimizer.workspace.analyzing') : ''}
          </span>
          <Tooltip label={t('tools.prompt_optimizer.workspace.save_favorite')}>
            <IconButton label={t('tools.prompt_optimizer.workspace.save_favorite')} size="sm" onClick={() => setSaveOpen(true)} disabled={!draft.optimized}>
              <Save size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('tools.prompt_optimizer.variables.manage')}>
            <IconButton label={t('tools.prompt_optimizer.variables.manage')} size="sm" onClick={() => setVariablesOpen(true)}>
              <Wand2 size={14} />
            </IconButton>
          </Tooltip>
          {isPro && (
            <Tooltip label={t('tools.prompt_optimizer.workspace.contexts')}>
              <IconButton label={t('tools.prompt_optimizer.workspace.contexts')} size="sm" onClick={() => setContextOpen(true)}>
                <Languages size={14} />
              </IconButton>
            </Tooltip>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void confirm({ title: t('tools.prompt_optimizer.workspace.clear_confirm') }).then((ok) => {
              if (ok) updateDraft({ prompt: '', optimized: '', analysis: '', chainId: '', versions: [], testGroups: [], iterateInput: '' })
            })}
          >
            <Trash2 size={13} />
            {t('tools.prompt_optimizer.workspace.clear')}
          </Button>
        </div>
      </header>

      {isCompact && (
        <nav
          aria-label={t('tools.prompt_optimizer.workspace.regions')}
          className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1.5 lg:hidden"
        >
          {(['optimize', 'test'] as const).map((region) => (
            <Button
              key={region}
              variant={mobileRegion === region ? 'primary' : 'ghost'}
              size="sm"
              aria-pressed={mobileRegion === region}
              onClick={() => setMobileRegion(region)}
            >
              {region === 'optimize' ? <Sparkles size={13} /> : <Play size={13} />}
              {t(region === 'optimize' ? 'tools.prompt_optimizer.workspace.region_optimize' : 'tools.prompt_optimizer.workspace.region_test')}
            </Button>
          ))}
        </nav>
      )}

      {!models.text.length && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-raised)] px-3 py-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
          <AlertTriangle size={14} className="text-[var(--warning)]" aria-hidden="true" />
          <span>{t('tools.prompt_optimizer.workspace.no_model_hint')}</span>
          <Button variant="ghost" size="sm" onClick={() => navigateToPath('/chat')}>
            {t('tools.prompt_optimizer.workspace.open_model_settings')}
          </Button>
        </div>
      )}

      <div className={cn('flex min-h-0 flex-1', isCompact ? 'flex-col overflow-y-auto' : 'flex-row overflow-hidden')}>
        <section
          className={cn(
            'flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto p-3',
            isCompact && mobileRegion === 'test' ? 'hidden' : 'flex',
          )}
          style={isCompact ? undefined : { width: `${splitPct}%` }}
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
              {isPro ? `${t('tools.prompt_optimizer.workspace.messages')} · ${t('tools.prompt_optimizer.workspace.conversation_context')}` : t('tools.prompt_optimizer.workspace.original')}
            </h2>
            {isPro && (
              <Button variant="ghost" size="sm" onClick={addMessage}>
                <Plus size={13} />
                {t('tools.prompt_optimizer.workspace.add_message')}
              </Button>
            )}
          </div>

          {isPro ? (
            <div className="flex flex-col gap-2">
              {draft.messages.map((message, index) => (
                <div
                  key={message.id ?? index}
                  className={cn(
                    'rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-2',
                    message.id === draft.selectedMessageId && 'border-[var(--accent)] bg-[var(--accent-soft)]',
                  )}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <SelectMenu
                      label={t('tools.prompt_optimizer.workspace.message_role')}
                      value={message.role}
                      options={[
                        { value: 'system', label: 'system' },
                        { value: 'user', label: 'user' },
                        { value: 'assistant', label: 'assistant' },
                        { value: 'tool', label: 'tool' },
                      ]}
                      onChange={(role) => updateDraft({ messages: draft.messages.map((entry) => entry.id === message.id ? { ...entry, role } : entry) })}
                      width={150}
                      size="sm"
                    />
                    <Badge tone={message.id === draft.selectedMessageId ? 'accent' : 'neutral'}>
                      {index + 1}
                    </Badge>
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => updateDraft({ selectedMessageId: message.id === draft.selectedMessageId ? '' : (message.id ?? '') })}
                      >
                        {message.id === draft.selectedMessageId ? <Check size={13} /> : <Play size={13} />}
                        {t('tools.prompt_optimizer.workspace.select_message')}
                      </Button>
                      <IconButton
                        label={t('tools.prompt_optimizer.workspace.remove_message')}
                        size="xs"
                        onClick={() => updateDraft({
                          messages: draft.messages.filter((entry) => entry.id !== message.id),
                          selectedMessageId: draft.selectedMessageId === message.id ? '' : draft.selectedMessageId,
                        })}
                        disabled={draft.messages.length <= 1}
                      >
                        <X size={13} />
                      </IconButton>
                    </div>
                  </div>
                  <Textarea
                    aria-label={`${t('tools.prompt_optimizer.workspace.message_content')} ${index + 1}`}
                    value={message.content}
                    rows={4}
                    onChange={(event) => setMessageContent(message.id ?? '', event.target.value)}
                    placeholder={t('tools.prompt_optimizer.workspace.original_placeholder')}
                    className="w-full font-mono text-[length:var(--text-13)]"
                  />
                </div>
              ))}
            </div>
          ) : (
            <Textarea
              aria-label={t('tools.prompt_optimizer.workspace.original')}
              value={draft.prompt}
              rows={isImage ? 6 : 10}
              onChange={(event) => updateDraft({ prompt: event.target.value })}
              placeholder={workspace === 'basic_system'
                ? t('tools.prompt_optimizer.workspace.system_placeholder')
                : t('tools.prompt_optimizer.workspace.user_placeholder')}
              className="min-h-[150px] w-full shrink-0 font-mono text-[length:var(--text-13)]"
            />
          )}

          {missing.length > 0 && (
            <p role="alert" className="flex items-center gap-1.5 text-[length:var(--text-12)] text-[var(--warning)]">
              <AlertTriangle size={13} aria-hidden="true" />
              {t('tools.prompt_optimizer.variables.missing').replace('{names}', missing.join(', '))}
            </p>
          )}

          {isVariable && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" loading={busy === 'variables'} onClick={() => void extractVariablesAction()}>
                <Wand2 size={13} />
                {busy === 'variables' ? t('tools.prompt_optimizer.variables.extracting') : t('tools.prompt_optimizer.variables.extract')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                loading={busy === 'variables'}
                disabled={!variables.length}
                onClick={() => void generateVariableValues(variables.filter((variable) => !isPredefinedVariable(variable.name)).map((variable) => variable.name))}
              >
                {busy === 'variables' ? t('tools.prompt_optimizer.variables.generating') : t('tools.prompt_optimizer.variables.generate')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setVariablesOpen(true)}>
                {t('tools.prompt_optimizer.variables.manage')}
              </Button>
              {variables.filter((variable) => variableNames(draft.prompt).includes(variable.name)).slice(0, 8).map((variable) => (
                <Badge key={variable.name} tone="neutral">{variable.name}</Badge>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="md"
              loading={busy === 'optimize'}
              disabled={busy !== null || !(isEditingMessage ? selectedMessage?.content ?? '' : draft.prompt).trim()}
              onClick={() => void optimize(true)}
            >
              <Sparkles size={14} />
              {busy === 'optimize' ? t('tools.prompt_optimizer.workspace.optimizing') : isEditingMessage ? t('tools.prompt_optimizer.workspace.optimize_message') : t('tools.prompt_optimizer.workspace.optimize')}
            </Button>
            {busy === 'optimize' && (
              <Button variant="secondary" size="md" onClick={stop}>
                <StopCircle size={14} />
                {t('tools.prompt_optimizer.workspace.stop')}
              </Button>
            )}
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('tools.prompt_optimizer.workspace.shortcut_hint')}
            </span>
          </div>

          {isPro && <ToolsPanel />}

          {(draft.analysis || showAnalysis) && draft.analysis && (
            <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-2">
              <button
                type="button"
                className="flex w-full items-center gap-2 text-left text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]"
                onClick={() => setShowAnalysis((current) => !current)}
                aria-expanded={showAnalysis}
              >
                <BarChart3 size={13} aria-hidden="true" />
                {t('tools.prompt_optimizer.workspace.analysis')}
              </button>
              {showAnalysis && (
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[length:var(--text-12)] text-[var(--text-secondary)]">
                  {draft.analysis}
                </pre>
              )}
            </div>
          )}

          {isImage && (
            <ImageReferences
              assets={referenceAssets}
              onPick={() => fileRef.current?.click()}
              onGenerate={() => void generatePicture()}
              onRemove={(id) => updateDraft({ imageIds: draft.imageIds.filter((entry) => entry !== id) })}
              disabled={busy !== null}
              hasImageModel={hasImageModel}
              supportsGeneration={workspace === 'image_text2image'}
              gallery={images}
              onUseImage={(id) => updateDraft({ imageIds: [...draft.imageIds, id] })}
              onDeleteImage={(id) => void usePromptOptimizerStore.getState().deleteImage(id)}
              onUnderstand={(id) => void extractReferencePrompt(id)}
            />
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
            className="hidden"
            aria-label={t('tools.prompt_optimizer.workspace.add_reference')}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void addReference(file)
              event.target.value = ''
            }}
          />

          <div className="mt-1 flex min-h-[220px] flex-1 flex-col">
            <span role="log" aria-live="polite" className="sr-only">
              {busy === 'optimize' ? t('tools.prompt_optimizer.workspace.optimizing') : draft.optimized ? t('tools.prompt_optimizer.workspace.result_ready') : ''}
            </span>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
                {t('tools.prompt_optimizer.workspace.result')}
              </h2>
              {draft.versions.length > 0 && <Badge tone="accent">{t('tools.prompt_optimizer.workspace.version').replace('{version}', String(draft.versions.length))}</Badge>}
              <div className="ml-auto flex items-center gap-1">
                {draft.optimized && (
                  <Tooltip label={t('tools.prompt_optimizer.workspace.copy')}>
                    <IconButton
                      label={t('tools.prompt_optimizer.workspace.copy')}
                      size="xs"
                      onClick={() => void copyText(draft.optimized).then((ok) => {
                        if (ok) toastCopy()
                      })}
                    >
                      <Copy size={13} />
                    </IconButton>
                  </Tooltip>
                )}
              </div>
            </div>
            <Textarea
              aria-label={t('tools.prompt_optimizer.workspace.result')}
              value={draft.optimized}
              onChange={(event) => applyToResult(event.target.value)}
              placeholder={t('tools.prompt_optimizer.workspace.result_placeholder')}
              className="min-h-[180px] w-full flex-1 font-mono text-[length:var(--text-13)]"
            />
            {draft.usage && (
              <div className="mt-2 flex flex-wrap items-center gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                <Badge tone={draft.usage.cachedInputTokens > 0 ? 'success' : 'neutral'}>
                  {t('tools.prompt_optimizer.usage.cache')}
                </Badge>
                <span>
                  {t('tools.prompt_optimizer.usage.cache_stats')
                    .replace('{hit}', String(draft.usage.cachedInputTokens))
                    .replace('{miss}', String(draft.usage.cacheMissTokens))
                    .replace('{pct}', String(draft.usage.inputTokens ? Math.round((draft.usage.cachedInputTokens / draft.usage.inputTokens) * 100) : 0))}
                </span>
                <span>
                  {t('tools.prompt_optimizer.usage.tokens')
                    .replace('{input}', String(draft.usage.inputTokens))
                    .replace('{output}', String(draft.usage.outputTokens))}
                </span>
              </div>
            )}
            {draft.versions.length > 1 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {draft.versions.map((record) => (
                  <Tooltip key={record.id} label={t('tools.prompt_optimizer.workspace.restore_version')}>
                    <Button
                      variant={record.optimizedPrompt === draft.optimized ? 'primary' : 'ghost'}
                      size="sm"
                      onClick={() => useVersion(record)}
                    >
                      {t('tools.prompt_optimizer.workspace.version').replace('{version}', String(record.version))}
                    </Button>
                  </Tooltip>
                ))}
              </div>
            )}
            {draft.chainId && (
              <div className="mt-2 flex items-end gap-2">
                <Field label={t('tools.prompt_optimizer.workspace.iterate')} hint={t('tools.prompt_optimizer.workspace.iterate_placeholder')}>
                  <Input
                    value={draft.iterateInput}
                    onChange={(event) => updateDraft({ iterateInput: event.target.value })}
                    placeholder={t('tools.prompt_optimizer.workspace.iterate_placeholder')}
                  />
                </Field>
                <Button
                  variant="secondary"
                  loading={busy === 'iterate'}
                  disabled={busy !== null || !draft.iterateInput.trim()}
                  onClick={() => void iterate()}
                >
                  <RefreshCw size={13} />
                  {t('tools.prompt_optimizer.workspace.iterate')}
                </Button>
              </div>
            )}
          </div>
        </section>

        {!isCompact && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('tools.prompt_optimizer.workspace.split')}
            aria-valuemin={25}
            aria-valuemax={50}
            aria-valuenow={Math.round(splitPct)}
            tabIndex={0}
            className="flex w-1.5 shrink-0 cursor-col-resize items-center justify-center border-l border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] outline-none focus-visible:bg-[var(--accent-soft)]"
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              setSplitPct((current) => (
                event.key === 'Home' ? 25 : event.key === 'End' ? 50 : Math.min(50, Math.max(25, current + (event.key === 'ArrowLeft' ? -1 : 1)))
              ))
            }}
          >
            <span aria-hidden="true" className="h-8 w-px bg-[var(--border-subtle)]" />
          </div>
        )}

        <section className={cn('flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3', isCompact && mobileRegion === 'optimize' ? 'hidden' : 'flex')}>
          <TestPanel onRun={(ids) => void runTest(ids)} busy={busy === 'test'} workspace={workspace} />
          <EvaluationPanel
            evaluation={evaluations}
            busy={busy === 'evaluate' || busy === 'rewrite'}
            onEvaluate={(type) => void evaluate(type)}
            onRewrite={() => void rewrite()}
            onFocus={(focus) => updateDraft({ focus })}
            focus={draft.focus}
            hasCompare={draft.testGroups.filter((group) => group.output.trim()).length >= 2}
          />
        </section>
      </div>

      <SaveFavoriteModal open={saveOpen} onClose={() => setSaveOpen(false)} />
      <VariablesModal open={variablesOpen} onClose={() => setVariablesOpen(false)} />
      <ContextModal open={contextOpen} onClose={() => setContextOpen(false)} />
      <Modal
        open={imagePreviewOpen}
        onClose={() => setImagePreviewOpen(false)}
        title={t('tools.prompt_optimizer.image.preview_title')}
        width={780}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setImagePreviewOpen(false)}>
              {t('tools.prompt_optimizer.common.cancel')}
            </Button>
            <Button variant="primary" disabled={!imagePreviewDraft.trim()} onClick={() => void applyImagePreview()}>
              {t('tools.prompt_optimizer.image.apply')}
            </Button>
          </>
        )}
      >
        <div className="flex flex-col gap-2">
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('tools.prompt_optimizer.image.preview_hint')}
          </p>
          {imagePreview && Object.keys(imagePreview.variableDefaults).length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                {t('tools.prompt_optimizer.image.variable_defaults')}:
              </span>
              {Object.entries(imagePreview.variableDefaults).map(([name, value]) => (
                <Badge key={name} tone="accent">{`{{${name}}} = ${value}`}</Badge>
              ))}
            </div>
          )}
          <TemplateEditor
            value={imagePreviewDraft}
            onChange={setImagePreviewDraft}
            ariaLabel={t('tools.prompt_optimizer.image.preview_title')}
          />
        </div>
      </Modal>
    </div>
  )
}

function toastCopy(): void {
  useUiStore.getState().toast(t('tools.prompt_optimizer.workspace.copied'), 'success')
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('Could not read the image'))
    reader.readAsDataURL(file)
  })
}

function TestPanel({ onRun, busy, workspace }: { onRun: (ids?: string[]) => void; busy: boolean; workspace: Workspace }) {
  const draft = usePromptOptimizerStore((s) => s.drafts[workspace])
  const models = usePromptOptimizerStore((s) => s.models)
  const updateDraft = usePromptOptimizerStore((s) => s.updateDraft)
  const isConversation = isConversationWorkspace(workspace)
  const modelOptions = [
    { value: '', label: t('tools.prompt_optimizer.workspace.model_default') },
    ...models.text.map((model) => ({ value: model.id, label: model.label || model.model })),
  ]
  const variants = ['baseline', 'candidate'] as const
  const groupsOf = (variant: TestGroup['variant']) => draft.testGroups.filter((group) => group.variant === variant)
  return (
    <div aria-label={t('tools.prompt_optimizer.workspace.test')} className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('tools.prompt_optimizer.workspace.test_groups')}
        </h2>
        <Button variant="secondary" size="sm" loading={busy} disabled={!draft.optimized || busy} onClick={() => onRun()}>
          <Play size={13} />
          {busy ? t('tools.prompt_optimizer.workspace.testing') : t('tools.prompt_optimizer.workspace.run_test')}
        </Button>
      </div>
      {isConversation ? (
        <div className="flex flex-col gap-2">
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('tools.prompt_optimizer.test.conversation_hint')}
          </p>
          {variants.map((variant) => {
            const group = groupsOf(variant)[0]
            return (
              <div key={variant} className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-2">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge tone={variant === 'baseline' ? 'neutral' : 'accent'}>
                    {t(variant === 'baseline' ? 'tools.prompt_optimizer.workspace.baseline' : 'tools.prompt_optimizer.workspace.candidate')}
                  </Badge>
                  {group?.status === 'done' && <Badge tone="success">{t('tools.prompt_optimizer.test.done')}</Badge>}
                </div>
                {group?.output ? (
                  <pre aria-label={t('tools.prompt_optimizer.workspace.test_output')} className="max-h-48 overflow-auto whitespace-pre-wrap rounded-[var(--r-sm)] bg-[var(--bg-sunken)] p-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
                    {group.output}
                  </pre>
                ) : (
                  <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('tools.prompt_optimizer.test.no_output')}</p>
                )}
                {group?.reasoning ? (
                  <div className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                    {t('tools.prompt_optimizer.test.reasoning')}: {group.reasoning.slice(0, 400)}
                  </div>
                ) : null}
                {group?.toolCalls.length ? (
                  <ul className="mt-1 flex flex-col gap-1" aria-label={t('tools.prompt_optimizer.test.tool_calls')}>
                    {group.toolCalls.map((call, index) => (
                      <li key={`${call.name}-${index}`} className="rounded-[var(--r-sm)] bg-[var(--bg-sunken)] p-1.5 font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]">
                        <span className="font-semibold text-[var(--text-primary)]">{call.name}</span>
                        <span className="ml-1 break-all">{call.arguments.slice(0, 300)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {variants.map((variant) => {
            const groups = groupsOf(variant)
            return (
              <div key={variant} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Badge tone={variant === 'baseline' ? 'neutral' : 'accent'}>
                    {t(variant === 'baseline' ? 'tools.prompt_optimizer.workspace.baseline' : 'tools.prompt_optimizer.workspace.candidate')}
                  </Badge>
                  <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{groups.length}</span>
                </div>
                {groups.length === 0 ? (
                  <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                    {t('tools.prompt_optimizer.workspace.no_variant_groups')}
                  </p>
                ) : groups.map((group) => {
                  const index = draft.testGroups.findIndex((entry) => entry.id === group.id)
                  return (
                    <div key={group.id} className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-2">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Badge tone="neutral">{index + 1}</Badge>
                        <SelectMenu
                          label={t('tools.prompt_optimizer.workspace.variant')}
                          value={group.variant}
                          options={[
                            { value: 'baseline', label: t('tools.prompt_optimizer.workspace.baseline') },
                            { value: 'candidate', label: t('tools.prompt_optimizer.workspace.candidate') },
                          ]}
                          onChange={(value) => updateDraft({
                            testGroups: draft.testGroups.map((entry) => entry.id === group.id ? { ...entry, variant: value === 'candidate' ? 'candidate' : 'baseline' } : entry),
                          })}
                          width={130}
                          size="sm"
                        />
                        <SelectMenu
                          label={t('tools.prompt_optimizer.workspace.group_model')}
                          value={group.modelId}
                          options={modelOptions}
                          onChange={(value) => updateDraft({
                            testGroups: draft.testGroups.map((entry) => entry.id === group.id ? { ...entry, modelId: value } : entry),
                          })}
                          width={190}
                          size="sm"
                        />
                        <div className="ml-auto flex items-center gap-1">
                          <IconButton
                            label={t('tools.prompt_optimizer.workspace.run_all_groups')}
                            size="xs"
                            disabled={busy || !draft.optimized}
                            onClick={() => onRun([group.id])}
                          >
                            <Play size={12} />
                          </IconButton>
                          <IconButton
                            label={t('tools.prompt_optimizer.workspace.remove_group')}
                            size="xs"
                            disabled={draft.testGroups.length <= 1}
                            onClick={() => updateDraft({ testGroups: draft.testGroups.filter((entry) => entry.id !== group.id) })}
                          >
                            <Trash2 size={12} />
                          </IconButton>
                        </div>
                      </div>
                      <Textarea
                        aria-label={`${t('tools.prompt_optimizer.workspace.test_input')} ${index + 1}`}
                        value={group.input}
                        rows={2}
                        onChange={(event) => updateDraft({
                          testGroups: draft.testGroups.map((entry) => entry.id === group.id ? { ...entry, input: event.target.value } : entry),
                        })}
                        placeholder={t('tools.prompt_optimizer.workspace.test_input')}
                        className="w-full text-[length:var(--text-12)]"
                      />
                      {group.output && (
                        <pre aria-label={t('tools.prompt_optimizer.workspace.test_output')} className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-[var(--r-sm)] bg-[var(--bg-sunken)] p-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
                          {group.output}
                        </pre>
                      )}
                      {group.toolCalls.length > 0 && (
                        <div className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                          {t('tools.prompt_optimizer.test.tool_calls')}: {group.toolCalls.map((call) => call.name).join(', ')}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => updateDraft({
              testGroups: [...draft.testGroups, { id: `g${Date.now().toString(36)}`, input: '', output: '', reasoning: '', toolCalls: [], status: 'idle', variant: 'candidate', modelId: '' }],
            })}
          >
            <Plus size={13} />
            {t('tools.prompt_optimizer.workspace.add_group')}
          </Button>
        </div>
      )}
      {draft.testReasoning && (
        <div className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('tools.prompt_optimizer.test.reasoning')}: {draft.testReasoning.slice(0, 400)}
        </div>
      )}
    </div>
  )
}

function EvaluationPanel({ evaluation, busy, onEvaluate, onRewrite, focus, onFocus, hasCompare }: {
  evaluation: ReturnType<typeof usePromptOptimizerStore.getState>['evaluations']
  busy: boolean
  onEvaluate: (type: 'result' | 'compare' | 'structured' | 'prompt-only') => void
  onRewrite: () => void
  focus: string
  onFocus: (focus: string) => void
  hasCompare: boolean
}) {
  const [showRaw, setShowRaw] = useState(false)
  return (
    <div role="region" aria-label={t('tools.prompt_optimizer.workspace.evaluate')} className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('tools.prompt_optimizer.workspace.evaluate')}
        </h2>
        {evaluation?.score !== null && evaluation?.score !== undefined && (
          <Badge tone="success">{t('tools.prompt_optimizer.evaluation.score')} {evaluation.score}</Badge>
        )}
      </div>
      <Input
        aria-label={t('tools.prompt_optimizer.workspace.focus')}
        value={focus}
        onChange={(event) => onFocus(event.target.value)}
        placeholder={t('tools.prompt_optimizer.workspace.focus_placeholder')}
      />
      <div className="flex flex-wrap gap-1">
        <Button variant="secondary" size="sm" loading={busy} onClick={() => onEvaluate('result')}>
          <BarChart3 size={13} />
          {busy ? t('tools.prompt_optimizer.workspace.evaluating') : t('tools.prompt_optimizer.workspace.evaluate')}
        </Button>
        <Tooltip label={hasCompare ? t('tools.prompt_optimizer.workspace.compare') : t('tools.prompt_optimizer.evaluation.compare_hint')}>
          <Button variant="ghost" size="sm" loading={busy} disabled={!hasCompare} onClick={() => onEvaluate('compare')}>
            {t('tools.prompt_optimizer.workspace.compare')}
          </Button>
        </Tooltip>
        <Button variant="ghost" size="sm" loading={busy} disabled={!hasCompare} onClick={() => onEvaluate('structured')}>
          {t('tools.prompt_optimizer.evaluation.structured')}
        </Button>
        <Button variant="ghost" size="sm" loading={busy} disabled={!evaluation} onClick={onRewrite}>
          <Wand2 size={13} />
          {busy ? t('tools.prompt_optimizer.workspace.rewriting') : t('tools.prompt_optimizer.workspace.rewrite')}
        </Button>
      </div>
      {!evaluation ? (
        <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('tools.prompt_optimizer.evaluation.none')}</p>
      ) : (
        <div className="flex flex-col gap-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {evaluation.comparison?.winner && (
            <p className="font-medium text-[var(--text-primary)]">
              {t('tools.prompt_optimizer.evaluation.winner').replace('{label}', evaluation.comparison.winner)}
            </p>
          )}
          {evaluation.verdict && (
            <div>
              <span className="font-medium text-[var(--text-primary)]">{t('tools.prompt_optimizer.evaluation.verdict')}: </span>
              {evaluation.verdict}
            </div>
          )}
          {evaluation.strengths.length > 0 && (
            <div>
              <span className="font-medium text-[var(--text-primary)]">{t('tools.prompt_optimizer.evaluation.strengths')}: </span>
              {evaluation.strengths.join(' · ')}
            </div>
          )}
          {evaluation.weaknesses.length > 0 && (
            <div>
              <span className="font-medium text-[var(--text-primary)]">{t('tools.prompt_optimizer.evaluation.weaknesses')}: </span>
              {evaluation.weaknesses.join(' · ')}
            </div>
          )}
          {evaluation.suggestions.length > 0 && (
            <p className="font-medium text-[var(--text-primary)]">{t('tools.prompt_optimizer.evaluation.suggestions')}</p>
          )}
          {evaluation.suggestions.length > 0 && (
            <ul className="list-disc pl-4">
              {evaluation.suggestions.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          )}
          <button
            type="button"
            className="self-start text-[length:var(--text-11)] text-[var(--text-tertiary)] underline"
            onClick={() => setShowRaw((current) => !current)}
            aria-expanded={showRaw}
          >
            {t('tools.prompt_optimizer.evaluation.raw')}
          </button>
          {showRaw && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-[var(--r-sm)] bg-[var(--bg-base)] p-2 font-mono text-[length:var(--text-11)]">
              {evaluation.raw}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function ImageReferences({ assets, onPick, onGenerate, onRemove, onUnderstand, disabled, hasImageModel, supportsGeneration, gallery, onUseImage, onDeleteImage }: {
  assets: ({ id: string; mime: string } | undefined)[]
  onPick: () => void
  onGenerate: () => void
  onRemove: (id: string) => void
  onUnderstand: (id: string) => void
  disabled: boolean
  hasImageModel: boolean
  supportsGeneration: boolean
  gallery: { id: string; mime: string }[]
  onUseImage: (id: string) => void
  onDeleteImage: (id: string) => void
}) {
  const generateDisabled = disabled || !hasImageModel || !supportsGeneration
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-2">
      <div className="mb-2 flex items-center gap-2">
        <ImagePlus size={13} className="text-[var(--text-tertiary)]" aria-hidden="true" />
        <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.prompt_optimizer.workspace.references')}
        </span>
        <Button variant="ghost" size="sm" onClick={onPick} disabled={disabled}>
          {t('tools.prompt_optimizer.workspace.add_reference')}
        </Button>
      </div>
      {assets.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {assets.map((asset) => asset && (
            <div key={asset.id} className="relative h-16 w-16 overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-subtle)]">
              <img src={`/api/tools/prompt-optimizer/assets/${asset.id}`} alt={t('tools.prompt_optimizer.workspace.reference_image')} className="h-full w-full object-cover" />
              <IconButton
                label={t('tools.prompt_optimizer.workspace.extract_from_image')}
                size="xs"
                className="absolute left-0 top-0"
                onClick={() => onUnderstand(asset.id)}
              >
                <Sparkles size={11} />
              </IconButton>
              <IconButton
                label={t('tools.prompt_optimizer.workspace.remove_message')}
                size="xs"
                className="absolute right-0 top-0"
                onClick={() => onRemove(asset.id)}
              >
                <X size={11} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Button variant="secondary" size="sm" onClick={onGenerate} disabled={generateDisabled}>
          {disabled ? t('tools.prompt_optimizer.workspace.generating_image') : t('tools.prompt_optimizer.workspace.generate_image')}
        </Button>
        <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('tools.prompt_optimizer.image.generate_hint')}
        </span>
      </div>
      {!hasImageModel && (
        <p className="mt-1 text-[length:var(--text-11)] text-[var(--warning)]">
          {t('tools.prompt_optimizer.workspace.image_model_missing')}
        </p>
      )}
      {!supportsGeneration && (
        <p className="mt-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('tools.prompt_optimizer.workspace.image_edit_unavailable')}
        </p>
      )}
      <div className="mt-2 border-t border-[var(--border-subtle)] pt-2">
        <div className="mb-1 text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
          {t('tools.prompt_optimizer.image.title')} · {t('tools.prompt_optimizer.image.gallery')}
        </div>
        {gallery.length === 0 ? (
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('tools.prompt_optimizer.image.empty')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {gallery.slice(0, 12).map((asset) => (
              <div key={asset.id} className="group relative h-14 w-14 overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-subtle)]">
                <button
                  type="button"
                  aria-label={t('tools.prompt_optimizer.workspace.add_reference')}
                  onClick={() => onUseImage(asset.id)}
                  className="h-full w-full"
                >
                  <img src={`/api/tools/prompt-optimizer/assets/${asset.id}`} alt={t('tools.prompt_optimizer.workspace.reference_image')} className="h-full w-full object-cover" />
                </button>
                <IconButton
                  label={t('tools.prompt_optimizer.image.delete_confirm')}
                  size="xs"
                  className="absolute right-0 top-0"
                  onClick={() => {
                    void confirm({ title: t('tools.prompt_optimizer.image.delete_confirm'), tone: 'danger' })
                      .then((ok) => { if (ok) onDeleteImage(asset.id) })
                  }}
                >
                  <X size={10} />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export type { TestGroup }
