/**
 * The text-to-speech tab.
 *
 * A model answers with base64 audio; the page plays it from a Blob URL because the app's CSP does
 * not allow `data:` as a media source. Every URL made here is revoked when its row goes away or the
 * tab unmounts.
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Download, Trash2 } from 'lucide-react'
import type { AiModel } from '../../api/ai'
import { aiApi } from '../../api/ai'
import { cfErrorText } from '../../api/client'
import { useCfT, type CloudflareMessageKey } from '../../i18n'
import { downloadDataUrl } from '../../lib/download'
import { useUi } from '../../../../store/ui'
import { cn } from '../../../../lib/cn'
import { Button, Spinner } from '../../../../components/primitives'
import { Input, Textarea } from '../../../../components/form'
import { SelectMenu } from '../../../../components/select-menu'
import { useAiAccounts } from './use-ai-accounts'
import {
  AUTO_ACCOUNT,
  audioAdvancedFields,
  audioFieldChoices,
  buildAudioBody,
  initialAudioValues,
  shortModelId,
} from './options'
import { AiError } from './AiPanel'

const MAX_TEXT_CHARS = 5000

interface GeneratedAudio {
  id: string
  base64: string
  contentType: string
  text: string
  model: string
  voice: string
  neurons?: number
  url: string
}

function audioId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: contentType })
}

export function AudioTab() {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const { accounts } = useAiAccounts()

  const [accountId, setAccountId] = useState(AUTO_ACCOUNT)
  const [models, setModels] = useState<AiModel[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [voice, setVoice] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [text, setText] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [results, setResults] = useState<GeneratedAudio[]>([])
  const [error, setError] = useState<string | null>(null)

  const urls = useRef(new Set<string>())
  const mounted = useRef(true)
  const currentModel = models.find((model) => model.id === selectedModel)
  const fields = audioAdvancedFields(currentModel)
  const speakers = currentModel?.speakers ?? []

  const accountOptions = [
    { value: AUTO_ACCOUNT, label: t('cloudflare.ai.auto_assign') },
    ...accounts.map((account) => ({ value: account.value, label: account.label })),
  ]
  const modelOptions = models.map((model) => ({ value: model.id, label: shortModelId(model.id) }))
  const voiceOptions = speakers.map((speaker) => ({ value: speaker, label: speaker }))
  const canGenerate = !!selectedModel && !!text.trim()

  useEffect(() => {
    let cancelled = false
    setModels([])
    setSelectedModel('')
    aiApi.models('text-to-speech', accountId === AUTO_ACCOUNT ? undefined : accountId)
      .then((response) => {
        if (cancelled) return
        setModels(response.data)
        setSelectedModel((current) => (
          response.data.some((model) => model.id === current) ? current : response.data[0]?.id ?? ''
        ))
      })
      .catch((failure: unknown) => {
        if (cancelled) return
        setModels([])
        setSelectedModel('')
        toast({ title: t('common.action_failed'), description: cfErrorText(failure), tone: 'danger' })
      })
    return () => { cancelled = true }
  }, [accountId, t, toast])

  useEffect(() => {
    const model = models.find((entry) => entry.id === selectedModel)
    setVoice(model?.default_speaker ?? model?.speakers?.[0] ?? '')
    setValues(initialAudioValues(audioAdvancedFields(model)))
  }, [models, selectedModel])

  useEffect(() => {
    const urlsRef = urls.current
    return () => {
      mounted.current = false
      for (const url of urlsRef) URL.revokeObjectURL(url)
      urlsRef.clear()
    }
  }, [])

  function fieldLabel(name: string): string {
    const key = `cloudflare.ai_audio.param.${name}` as CloudflareMessageKey
    const label = t(key)
    return label === key ? name : label
  }

  async function generate(): Promise<void> {
    if (!canGenerate || generating) return
    setGenerating(true)
    setError(null)
    try {
      const response = await aiApi.audio(buildAudioBody({
        model: selectedModel,
        text,
        voice,
        accountId,
        fields,
        values,
      }))
      const first = response.data[0]
      if (!first?.audio) throw new Error(t('cloudflare.ai_audio.generate_failed'))
      const contentType = first.content_type || 'audio/mpeg'
      const url = URL.createObjectURL(base64ToBlob(first.audio, contentType))
      if (!mounted.current) {
        URL.revokeObjectURL(url)
        return
      }
      urls.current.add(url)
      setResults((previous) => [{
        id: audioId(),
        base64: first.audio,
        contentType,
        text,
        model: selectedModel,
        voice,
        neurons: first.neurons,
        url,
      }, ...previous])
      toast({ title: t('cloudflare.ai_audio.generate_success'), tone: 'success' })
    } catch (failure: unknown) {
      const message = cfErrorText(failure)
      setError(message)
      toast({ title: t('cloudflare.ai_audio.generate_failed'), description: message, tone: 'danger' })
    } finally {
      setGenerating(false)
    }
  }

  function download(audio: GeneratedAudio): void {
    const extension = audio.contentType.includes('wav') ? 'wav' : 'mp3'
    downloadDataUrl(`data:${audio.contentType};base64,${audio.base64}`, `ai-audio-${Date.now()}.${extension}`)
  }

  function reuse(audio: GeneratedAudio): void {
    setText(audio.text)
    setSelectedModel(audio.model)
    setVoice(audio.voice)
  }

  function remove(audio: GeneratedAudio): void {
    URL.revokeObjectURL(audio.url)
    urls.current.delete(audio.url)
    setResults((previous) => previous.filter((entry) => entry.id !== audio.id))
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <section className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-b border-[var(--border-subtle)] p-3 lg:w-80 lg:border-r lg:border-b-0">
        <SelectMenu
          label={t('cloudflare.ai.account')}
          value={accountId}
          options={accountOptions}
          onChange={setAccountId}
          width={240}
        />
        <SelectMenu
          label={t('cloudflare.ai_audio.select_model')}
          value={selectedModel}
          options={modelOptions}
          onChange={setSelectedModel}
          placeholder={t('cloudflare.ai_audio.select_model')}
          disabled={modelOptions.length === 0}
          width={320}
        />
        <div className="space-y-1.5">
          <SelectMenu
            label={t('cloudflare.ai_audio.select_voice')}
            value={voice}
            options={voiceOptions}
            onChange={setVoice}
            placeholder={speakers.length > 0 ? t('cloudflare.ai_audio.select_voice') : t('cloudflare.ai_audio.no_speaker')}
            disabled={voiceOptions.length === 0}
            width={240}
          />
          {speakers.length === 0 ? (
            <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
              {t('cloudflare.ai_audio.no_speaker_hint')}
            </p>
          ) : null}
        </div>

        <div>
          <Button
            variant="ghost"
            size="sm"
            block
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((value) => !value)}
          >
            {t('cloudflare.ai_audio.show_advanced')}
            <ChevronDown
              size={13}
              aria-hidden="true"
              className={cn('transition-transform', showAdvanced && 'rotate-180')}
            />
          </Button>
          {showAdvanced ? (
            <div className="mt-2 space-y-2 rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-2.5">
              {fields.length === 0 ? (
                <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {t('cloudflare.ai_audio.no_advanced_hint')}
                </p>
              ) : fields.map((field) => {
                const choices = audioFieldChoices(field)
                return (
                  <div key={field.name} className="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-2">
                    <span className="min-w-0 truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]" title={fieldLabel(field.name)}>
                      {fieldLabel(field.name)}
                    </span>
                    {choices ? (
                      <SelectMenu
                        label={fieldLabel(field.name)}
                        value={values[field.name] ?? ''}
                        options={choices.map((choice) => ({ value: choice.value, label: choice.label }))}
                        onChange={(next) => setValues((current) => ({ ...current, [field.name]: next }))}
                        placeholder={field.defaultValue}
                        width={200}
                        align="end"
                        size="sm"
                      />
                    ) : (
                      <Input
                        type={field.kind === 'number' ? 'number' : 'text'}
                        value={values[field.name] ?? ''}
                        aria-label={fieldLabel(field.name)}
                        min={field.min}
                        max={field.max}
                        onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>

        <div className="space-y-1">
          <Textarea
            rows={6}
            maxLength={MAX_TEXT_CHARS}
            value={text}
            disabled={generating}
            aria-label={t('cloudflare.ai_audio.text_placeholder')}
            placeholder={t('cloudflare.ai_audio.text_placeholder')}
            onChange={(event) => setText(event.target.value)}
          />
          <p className="text-right text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">
            {text.length} / {MAX_TEXT_CHARS}
          </p>
        </div>

        <div className="mt-auto">
          <Button
            variant="primary"
            block
            loading={generating}
            disabled={!canGenerate}
            onClick={() => { void generate() }}
          >
            {generating ? t('cloudflare.ai_audio.generating') : t('cloudflare.ai_audio.generate')}
          </Button>
        </div>
      </section>

      <section className="min-w-0 flex-1 overflow-y-auto p-3">
        {error ? <div className="mb-3"><AiError message={error} /></div> : null}
        {generating ? (
          <p className="mb-3 flex items-center gap-2 rounded-[var(--r-md)] bg-[var(--bg-raised)] px-3 py-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            <Spinner size={12} />
            {t('cloudflare.ai_audio.generating')}
          </p>
        ) : null}
        {results.length === 0 && !generating ? (
          <p className="flex min-h-48 items-center justify-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('cloudflare.ai_audio.empty_hint')}
          </p>
        ) : (
          <ul className="mx-auto flex max-w-2xl flex-col gap-3">
            {results.map((audio) => (
              <li
                key={audio.id}
                className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-3"
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <p className="line-clamp-2 min-w-0 flex-1 text-[length:var(--text-12)] text-[var(--text-primary)]">
                    {audio.text}
                  </p>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {audio.neurons ? (
                      <span className="rounded-[var(--r-xs)] bg-[var(--bg-sunken)] px-1.5 py-0.5 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-tertiary)]">
                        ⚡ {audio.neurons}
                      </span>
                    ) : null}
                    <span className="text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                      {audio.voice || shortModelId(audio.model)}
                    </span>
                  </div>
                </div>
                <audio
                  controls
                  src={audio.url}
                  aria-label={t('cloudflare.ai_audio.title')}
                  className="w-full"
                />
                <div className="mt-2 flex flex-wrap justify-end gap-1">
                  <Button size="sm" variant="ghost" icon={<Download size={12} />} onClick={() => download(audio)}>
                    {t('cloudflare.ai_audio.download')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => reuse(audio)}>
                    {t('cloudflare.ai_audio.reuse')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-[var(--danger)] hover:text-[var(--danger)]"
                    icon={<Trash2 size={12} />}
                    onClick={() => remove(audio)}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
