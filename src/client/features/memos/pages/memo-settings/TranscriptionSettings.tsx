import { useEffect, useId, useState } from 'react'
import type { MemoPreferencesPatch } from '@shared/memos/types'
import { Button } from '../../../../components/primitives'
import { Input, Select, SettingRow, Textarea } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import {
  MEMO_TRANSCRIPTION_PROTOCOLS,
  memoAi,
  type MemoAiProvider,
} from '../../ai-client'
import { MEMO_SETTINGS_SECTION_IDS } from './sections'
import { SettingsCard } from './SettingsCard'
import { settingsErrorMessage } from './error'
import type { MemoSettingsSectionProps } from './types'

const LANGUAGE_MAX_LENGTH = 16
const PROMPT_MAX_LENGTH = 2000

function usableProviders(providers: readonly MemoAiProvider[]): MemoAiProvider[] {
  return providers.filter((provider) => (
    (MEMO_TRANSCRIPTION_PROTOCOLS as readonly string[]).includes(provider.protocol)
    && provider.models.length > 0
  ))
}

export function TranscriptionSettings({ preferences, saving, save }: MemoSettingsSectionProps) {
  const providerControlId = useId()
  const modelControlId = useId()
  const languageControlId = useId()
  const promptControlId = useId()
  const [providers, setProviders] = useState<MemoAiProvider[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [language, setLanguage] = useState(preferences.transcriptionLanguage)
  const [prompt, setPrompt] = useState(preferences.transcriptionPrompt)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    setLanguage(preferences.transcriptionLanguage)
    setPrompt(preferences.transcriptionPrompt)
  }, [preferences.transcriptionLanguage, preferences.transcriptionPrompt])

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setLoadError(null)
    memoAi.providers(controller.signal)
      .then((listed) => {
        if (controller.signal.aborted) return
        setProviders(usableProviders(listed))
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setStatus('error')
        setLoadError(settingsErrorMessage(error))
      })
    return () => controller.abort()
  }, [reloadKey])

  const update = async (patch: MemoPreferencesPatch): Promise<void> => {
    setFailure(null)
    try {
      await save(patch)
    } catch (error) {
      setFailure(settingsErrorMessage(error))
      setLanguage(preferences.transcriptionLanguage)
      setPrompt(preferences.transcriptionPrompt)
    }
  }

  const selected = providers.find((provider) => provider.id === preferences.transcriptionProviderId)
  const selectedModel = selected && preferences.transcriptionModel
    && selected.models.includes(preferences.transcriptionModel)
    ? preferences.transcriptionModel
    : ''

  const commitLanguage = (): void => {
    const next = language.trim()
    if (next === preferences.transcriptionLanguage) return
    void update({ transcriptionLanguage: next })
  }

  const commitPrompt = (): void => {
    const next = prompt.trim()
    if (next === preferences.transcriptionPrompt) return
    void update({ transcriptionPrompt: next })
  }

  return (
    <SettingsCard
      id={MEMO_SETTINGS_SECTION_IDS.transcription}
      title={t('memos.settings.transcription')}
      description={t('memos.settings.transcription_description')}
    >
      {failure ? (
        <div role="alert" className="mb-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-2">
          <p className="text-[length:var(--text-11-5)] font-medium text-[var(--danger)]">
            {t('memos.settings.save_failed')}
          </p>
          <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
            {failure}
          </p>
        </div>
      ) : null}
      {status === 'error' ? (
        <div role="status" className="mb-2 flex flex-wrap items-center gap-2 rounded-[var(--r-sm)] bg-[var(--bg-raised)] px-2.5 py-2">
          <p className="min-w-0 flex-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {t('memos.settings.transcription_providers_failed')}
            {loadError ? ` ${loadError}` : ''}
          </p>
          <Button size="sm" variant="ghost" className="h-7 shrink-0 px-1.5" onClick={() => setReloadKey((value) => value + 1)}>
            {t('memos.common.retry')}
          </Button>
        </div>
      ) : null}
      {status === 'ready' && providers.length === 0 ? (
        <p role="status" className="mb-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {t('memos.settings.transcription_no_provider')}
        </p>
      ) : null}
      <SettingRow
        title={t('memos.settings.transcription_provider')}
        description={t('memos.settings.transcription_provider_hint')}
        controlId={providerControlId}
      >
        <Select
          id={providerControlId}
          value={selected?.id ?? ''}
          disabled={saving || status !== 'ready'}
          onChange={(event) => void update({
            transcriptionProviderId: event.target.value || null,
            transcriptionModel: null,
          })}
        >
          <option value="">{t('memos.settings.transcription_provider_auto')}</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>{provider.label}</option>
          ))}
        </Select>
      </SettingRow>
      <SettingRow
        title={t('memos.settings.transcription_model')}
        description={t('memos.settings.transcription_model_hint')}
        controlId={modelControlId}
      >
        <Select
          id={modelControlId}
          value={selectedModel}
          disabled={saving || !selected}
          onChange={(event) => void update({ transcriptionModel: event.target.value || null })}
        >
          <option value="">{t('memos.settings.transcription_model_auto')}</option>
          {selected?.models.map((model) => (
            <option key={model} value={model}>{model}</option>
          ))}
        </Select>
      </SettingRow>
      <SettingRow
        title={t('memos.settings.transcription_language')}
        description={t('memos.settings.transcription_language_hint')}
        controlId={languageControlId}
      >
        <Input
          id={languageControlId}
          value={language}
          maxLength={LANGUAGE_MAX_LENGTH}
          placeholder={t('memos.settings.transcription_language_auto')}
          disabled={saving}
          onChange={(event) => setLanguage(event.target.value)}
          onBlur={commitLanguage}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.currentTarget.blur()
            }
          }}
        />
      </SettingRow>
      <SettingRow
        title={t('memos.settings.transcription_prompt')}
        description={t('memos.settings.transcription_prompt_hint')}
        controlId={promptControlId}
      >
        <Textarea
          id={promptControlId}
          value={prompt}
          rows={3}
          maxLength={PROMPT_MAX_LENGTH}
          placeholder={t('memos.settings.transcription_prompt_placeholder')}
          disabled={saving}
          className="w-full md:w-[320px]"
          onChange={(event) => setPrompt(event.target.value)}
          onBlur={commitPrompt}
        />
      </SettingRow>
    </SettingsCard>
  )
}
