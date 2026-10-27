/**
 * The image tab: text-to-image and image-to-image against the model family the reader picked.
 *
 * The family decides which controls exist — Stable Diffusion takes width, height, guidance and a
 * negative prompt, FLUX does not — and the request builder is what turns that into the body.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { ChevronDown, Download, Trash2 } from 'lucide-react'
import type { AiModel } from '../../api/ai'
import { aiApi } from '../../api/ai'
import { cfErrorText } from '../../api/client'
import { useCfT } from '../../i18n'
import { downloadDataUrl } from '../../lib/download'
import { useUi } from '../../../../store/ui'
import { cn } from '../../../../lib/cn'
import { Button, IconButton, Spinner } from '../../../../components/primitives'
import { Input, Segmented, Slider, Textarea } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { SelectMenu } from '../../../../components/select-menu'
import { useAiAccounts } from './use-ai-accounts'
import {
  AUTO_ACCOUNT,
  IMAGE_SIZE_PRESETS,
  buildImageBody,
  isFluxModel,
  isSdModel,
  resolveImageSize,
  shortModelId,
  supportsImageToImage,
  type ImageMode,
  type ImageSizePresetValue,
} from './options'
import { AiError } from './AiPanel'

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

interface GeneratedImage {
  id: string
  b64: string
  prompt: string
  model: string
  mode: ImageMode
  neurons?: number
}

function imageId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function ImageTab() {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const { accounts } = useAiAccounts()

  const [accountId, setAccountId] = useState(AUTO_ACCOUNT)
  const [models, setModels] = useState<AiModel[]>([])
  const [textModels, setTextModels] = useState<string[]>([])
  const [editModels, setEditModels] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [mode, setMode] = useState<ImageMode>('text-to-image')
  const [prompt, setPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [uploadedImage, setUploadedImage] = useState('')
  const [uploadPreview, setUploadPreview] = useState('')
  const [uploadName, setUploadName] = useState('')
  const [steps, setSteps] = useState(4)
  const [guidance, setGuidance] = useState(7.5)
  const [strength, setStrength] = useState(0.6)
  const [size, setSize] = useState<ImageSizePresetValue>('1024')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [images, setImages] = useState<GeneratedImage[]>([])
  const [preview, setPreview] = useState<GeneratedImage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const editSet = new Set(editModels)
  const canEdit = supportsImageToImage(selectedModel, editSet)
  const canText = textModels.length > 0 ? textModels.includes(selectedModel) : !canEdit
  const effectiveMode: ImageMode = canEdit && !canText
    ? 'image-to-image'
    : canText && !canEdit
      ? 'text-to-image'
      : mode
  const preset = resolveImageSize(size)
  const isSd = isSdModel(selectedModel)
  const isFlux = isFluxModel(selectedModel)
  const needsSource = effectiveMode === 'image-to-image' && canEdit
  const canGenerate = !!selectedModel && !!prompt.trim() && (!needsSource || !!uploadedImage)

  const accountOptions = [
    { value: AUTO_ACCOUNT, label: t('cloudflare.ai.auto_assign') },
    ...accounts.map((account) => ({ value: account.value, label: account.label })),
  ]
  const modelOptions = models.map((model) => ({ value: model.id, label: shortModelId(model.id) }))
  const sizeOptions = IMAGE_SIZE_PRESETS.map((entry) => ({ value: entry.value, label: entry.label }))

  useEffect(() => {
    let cancelled = false
    setModels([])
    setTextModels([])
    setEditModels([])
    setSelectedModel('')
    Promise.allSettled([
      aiApi.models('text-to-image', accountId === AUTO_ACCOUNT ? undefined : accountId),
      aiApi.models('image-to-image', accountId === AUTO_ACCOUNT ? undefined : accountId),
    ]).then(([text, edit]) => {
      if (cancelled) return
      const textIds = text.status === 'fulfilled' ? text.value.data.map((model) => model.id) : []
      const editIds = edit.status === 'fulfilled' ? edit.value.data.map((model) => model.id) : []
      const merged = new Map<string, AiModel>()
      if (text.status === 'fulfilled') for (const model of text.value.data) merged.set(model.id, model)
      if (edit.status === 'fulfilled') for (const model of edit.value.data) merged.set(model.id, model)
      const list = [...merged.values()]
      setTextModels(textIds)
      setEditModels(editIds)
      setModels(list)
      setSelectedModel((current) => (list.some((model) => model.id === current) ? current : list[0]?.id ?? ''))
      const firstFailure = [text, edit].find((result) => result.status === 'rejected')
      if (firstFailure && firstFailure.status === 'rejected') {
        toast({ title: t('common.action_failed'), description: cfErrorText(firstFailure.reason), tone: 'danger' })
      }
    })
    return () => { cancelled = true }
  }, [accountId, t, toast])

  useEffect(() => {
    if (selectedModel && !canEdit && mode === 'image-to-image') setMode('text-to-image')
    if (selectedModel && !canText && mode === 'text-to-image') setMode('image-to-image')
  }, [selectedModel, canEdit, canText, mode])

  function applyModelDefaults(model: string): void {
    if (isSdModel(model)) {
      setSteps(20)
      setGuidance(7.5)
      setSize('1024')
      return
    }
    if (isFluxModel(model)) setSteps(4)
  }

  function changeModel(next: string): void {
    setSelectedModel(next)
    applyModelDefaults(next)
    if (!supportsImageToImage(next, editSet)) {
      setMode('text-to-image')
      resetUpload()
    }
  }

  function resetUpload(): void {
    setUploadedImage('')
    setUploadPreview('')
    setUploadName('')
    if (fileRef.current) fileRef.current.value = ''
  }

  function changeMode(next: ImageMode): void {
    setMode(next)
    resetUpload()
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0]
    if (!file) {
      resetUpload()
      return
    }
    if (!file.type.startsWith('image/')) {
      toast({ title: t('common.action_failed'), description: file.type || file.name, tone: 'danger' })
      event.target.value = ''
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast({ title: t('common.action_failed'), description: file.name, tone: 'danger' })
      event.target.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      setUploadedImage(result.split(',')[1] ?? '')
      setUploadPreview(result)
      setUploadName(file.name)
    }
    reader.onerror = () => {
      toast({ title: t('common.action_failed'), description: file.name, tone: 'danger' })
    }
    reader.readAsDataURL(file)
  }

  async function generate(): Promise<void> {
    if (!canGenerate || generating) return
    setGenerating(true)
    setError(null)
    const currentPrompt = prompt
    try {
      const response = await aiApi.image(buildImageBody({
        model: selectedModel,
        prompt: currentPrompt,
        mode: effectiveMode,
        accountId,
        image: uploadedImage || undefined,
        strength,
        numSteps: steps,
        width: preset.width,
        height: preset.height,
        guidance,
        negativePrompt,
      }))
      const first = response.data[0]
      if (!first?.b64_json) throw new Error(t('cloudflare.ai_image.generate_failed'))
      setImages((previous) => [{
        id: imageId(),
        b64: first.b64_json,
        prompt: currentPrompt,
        model: selectedModel,
        mode: effectiveMode,
        neurons: first.neurons,
      }, ...previous])
      toast({ title: t('cloudflare.ai_image.generate_success'), tone: 'success' })
    } catch (failure: unknown) {
      const message = cfErrorText(failure)
      setError(message)
      toast({ title: t('cloudflare.ai_image.generate_failed'), description: message, tone: 'danger' })
    } finally {
      setGenerating(false)
    }
  }

  function download(image: GeneratedImage): void {
    downloadDataUrl(`data:image/png;base64,${image.b64}`, `ai-image-${Date.now()}.png`)
  }

  function reuse(image: GeneratedImage): void {
    setPrompt(image.prompt)
    setSelectedModel(image.model)
    applyModelDefaults(image.model)
    if (supportsImageToImage(image.model, editSet)) {
      setMode('image-to-image')
      setUploadedImage(image.b64)
      setUploadPreview(`data:image/png;base64,${image.b64}`)
      setUploadName('reuse.png')
    } else {
      setMode('text-to-image')
      resetUpload()
    }
  }

  function remove(image: GeneratedImage): void {
    setImages((previous) => previous.filter((entry) => entry.id !== image.id))
    if (preview?.id === image.id) setPreview(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 lg:flex-row lg:overflow-hidden">
      <section className="flex w-full shrink-0 flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-3 lg:w-80 lg:overflow-y-auto">
        <SelectMenu
          label={t('cloudflare.ai.account')}
          value={accountId}
          options={accountOptions}
          onChange={setAccountId}
          width={240}
        />
        <SelectMenu
          label={t('cloudflare.ai_image.select_model')}
          value={selectedModel}
          options={modelOptions}
          onChange={changeModel}
          placeholder={t('cloudflare.ai_image.select_model')}
          disabled={modelOptions.length === 0}
          width={300}
        />

        {canText && canEdit ? (
          <Segmented<ImageMode>
            value={effectiveMode}
            options={[
              { value: 'text-to-image', label: t('cloudflare.ai_image.text_to_image') },
              { value: 'image-to-image', label: t('cloudflare.ai_image.image_to_image') },
            ]}
            onChange={changeMode}
            size="sm"
            label={t('cloudflare.ai_image.title')}
            className="w-full"
          />
        ) : null}

        {needsSource ? (
          <div className="space-y-2">
            <label className="block text-[length:var(--text-11-5)] text-[var(--text-tertiary)]" htmlFor="ai-image-upload">
              {t('cloudflare.ai_image.upload_image')}
            </label>
            <Input
              ref={fileRef}
              id="ai-image-upload"
              type="file"
              accept="image/*"
              onChange={onFileChange}
              className="cursor-pointer text-[length:var(--text-11-5)]"
            />
            {uploadedImage ? (
              <div className="flex min-w-0 items-center gap-2">
                <img
                  src={uploadPreview}
                  alt={uploadName}
                  className="size-10 shrink-0 rounded-[var(--r-sm)] border border-[var(--border-subtle)] object-cover"
                />
                <span className="min-w-0 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{uploadName}</span>
                <IconButton
                  label={t('common.remove')}
                  size="xs"
                  onClick={resetUpload}
                >
                  <Trash2 size={12} />
                </IconButton>
              </div>
            ) : null}
          </div>
        ) : null}

        <Textarea
          value={prompt}
          aria-label={t('cloudflare.ai_image.prompt_placeholder')}
          placeholder={t('cloudflare.ai_image.prompt_placeholder')}
          rows={4}
          disabled={generating}
          onChange={(event) => setPrompt(event.target.value)}
        />

        <Button
          variant="ghost"
          size="sm"
          block
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((value) => !value)}
        >
          {showAdvanced ? t('cloudflare.ai_image.hide_advanced') : t('cloudflare.ai_image.show_advanced')}
          <ChevronDown
            size={13}
            aria-hidden="true"
            className={cn('transition-transform', showAdvanced && 'rotate-180')}
          />
        </Button>

        {showAdvanced ? (
          <div className="space-y-3 rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-2.5">
            <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2">
              <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                {t('cloudflare.ai_image.steps')}
              </span>
              <Input
                type="number"
                min={1}
                max={isFlux ? 8 : isSd ? 50 : 20}
                value={steps}
                aria-label={t('cloudflare.ai_image.steps')}
                onChange={(event) => setSteps(Number(event.target.value))}
              />
            </div>
            {isSd ? (
              <>
                <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2">
                  <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                    {t('cloudflare.ai_image.width')} / {t('cloudflare.ai_image.height')}
                  </span>
                  <SelectMenu
                    label={`${t('cloudflare.ai_image.width')} / ${t('cloudflare.ai_image.height')}`}
                    value={size}
                    options={sizeOptions}
                    onChange={setSize}
                    width={180}
                    align="end"
                  />
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2">
                  <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                    {t('cloudflare.ai_image.guidance')}
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={20}
                    step={0.5}
                    value={guidance}
                    aria-label={t('cloudflare.ai_image.guidance')}
                    onChange={(event) => setGuidance(Number(event.target.value))}
                  />
                </div>
                {needsSource ? (
                  <div className="space-y-1">
                    <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                      {t('cloudflare.ai_image.strength')}
                    </span>
                    <Slider
                      label={t('cloudflare.ai_image.strength')}
                      value={strength}
                      min={0}
                      max={1}
                      step={0.05}
                      onChange={setStrength}
                    />
                  </div>
                ) : null}
                <div className="space-y-1">
                  <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                    {t('cloudflare.ai_image.negative_prompt')}
                  </span>
                  <Textarea
                    rows={3}
                    value={negativePrompt}
                    aria-label={t('cloudflare.ai_image.negative_prompt')}
                    placeholder={t('cloudflare.ai_image.negative_prompt_placeholder')}
                    onChange={(event) => setNegativePrompt(event.target.value)}
                  />
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        <div className="mt-auto">
          <Button
            variant="primary"
            block
            loading={generating}
            disabled={!canGenerate}
            onClick={() => { void generate() }}
          >
            {generating ? t('cloudflare.ai_image.generating') : t('cloudflare.ai_image.generate')}
          </Button>
        </div>
      </section>

      <section className="min-w-0 flex-1 overflow-y-auto rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
        {error ? <div className="mb-3"><AiError message={error} /></div> : null}
        {generating ? (
          <p className="mb-3 flex items-center gap-2 rounded-[var(--r-md)] bg-[var(--bg-raised)] px-3 py-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            <Spinner size={12} />
            {t('cloudflare.ai_image.generating')}
          </p>
        ) : null}
        {images.length === 0 && !generating ? (
          <p className="flex min-h-48 items-center justify-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('cloudflare.ai_image.empty_hint')}
          </p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {images.map((image) => (
              <li
                key={image.id}
                className="group relative overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)]"
              >
                <button
                  type="button"
                  onClick={() => setPreview(image)}
                  aria-label={t('cloudflare.ai_image.preview')}
                  className="block aspect-square w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                >
                  <img src={`data:image/png;base64,${image.b64}`} alt={image.prompt} className="size-full object-cover" />
                </button>
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-[var(--media-scrim)] p-2 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                  <p className="line-clamp-2 text-[length:var(--text-10-5)] leading-relaxed text-[var(--media-text-strong)]">{image.prompt}</p>
                  {image.neurons ? (
                    <p className="mt-0.5 text-[length:var(--text-10)] text-[var(--media-text)]">⚡ {image.neurons}</p>
                  ) : null}
                  <div className="pointer-events-auto mt-1.5 flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="bg-[var(--media-control)] text-[var(--media-text-strong)] hover:bg-[var(--media-control-hover)] hover:text-[var(--media-text-strong)]"
                      icon={<Download size={12} />}
                      onClick={() => download(image)}
                    >
                      {t('cloudflare.ai_image.download')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="bg-[var(--media-control)] text-[var(--media-text-strong)] hover:bg-[var(--media-control-hover)] hover:text-[var(--media-text-strong)]"
                      onClick={() => reuse(image)}
                    >
                      {t('cloudflare.ai_image.reuse')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="bg-[var(--media-control)] text-[var(--media-text-strong)] hover:bg-[var(--media-control-hover)] hover:text-[var(--media-text-strong)]"
                      icon={<Trash2 size={12} />}
                      onClick={() => remove(image)}
                    >
                      {t('common.delete')}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview?.prompt || t('cloudflare.ai_image.preview')}
        width={760}
        footer={(
          <>
            {preview ? (
              <Button variant="secondary" icon={<Download size={13} />} onClick={() => download(preview)}>
                {t('cloudflare.ai_image.download')}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => setPreview(null)}>{t('common.close')}</Button>
          </>
        )}
      >
        {preview ? (
          <img
            src={`data:image/png;base64,${preview.b64}`}
            alt={preview.prompt}
            className="mx-auto block max-h-[70vh] max-w-full"
          />
        ) : null}
      </Modal>
    </div>
  )
}
