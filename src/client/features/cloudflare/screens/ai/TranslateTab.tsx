/**
 * The translation tab: a language pair, two panels, and the copy control beside the result.
 *
 * IndicTrans2 only translates out of English, so the pair the tab offers follows the model family
 * rather than a fixed list of both sides.
 */
import { useState } from 'react'
import { ArrowLeftRight, Languages, Zap } from 'lucide-react'
import { aiApi } from '../../api/ai'
import { cfErrorText } from '../../api/client'
import { useCfT } from '../../i18n'
import { useUi } from '../../../../store/ui'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { Textarea } from '../../../../components/form'
import { SelectMenu } from '../../../../components/select-menu'
import { CopyButton } from '../../components/CopyButton'
import { useAiAccounts } from './use-ai-accounts'
import {
  AUTO_ACCOUNT,
  DEFAULT_TRANSLATE_MODEL,
  TRANSLATE_MODELS,
  buildTranslateBody,
  defaultTranslationPair,
  isIndicTransModel,
  translationSourceLanguages,
  translationTargetLanguages,
} from './options'
import { AiError } from './AiPanel'

const MAX_TEXT_CHARS = 10_000

export function TranslateTab() {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const { accounts } = useAiAccounts()

  const initialPair = defaultTranslationPair(DEFAULT_TRANSLATE_MODEL)
  const [accountId, setAccountId] = useState(AUTO_ACCOUNT)
  const [model, setModel] = useState<string>(DEFAULT_TRANSLATE_MODEL)
  const [sourceLang, setSourceLang] = useState(initialPair.source)
  const [targetLang, setTargetLang] = useState(initialPair.target)
  const [sourceText, setSourceText] = useState('')
  const [translatedText, setTranslatedText] = useState('')
  const [neurons, setNeurons] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const indic = isIndicTransModel(model)
  const accountOptions = [
    { value: AUTO_ACCOUNT, label: t('cloudflare.ai.auto_assign') },
    ...accounts.map((account) => ({ value: account.value, label: account.label })),
  ]
  const modelOptions = TRANSLATE_MODELS.map((entry) => ({ value: entry.value, label: entry.label }))
  const sourceOptions = indic
    ? translationSourceLanguages(model).map((entry) => ({ value: entry.value, label: entry.label }))
    : [
      { value: AUTO_ACCOUNT, label: t('cloudflare.ai_translate.auto') },
      ...translationSourceLanguages(model).map((entry) => ({ value: entry.value, label: entry.label })),
    ]
  const targetOptions = translationTargetLanguages(model)
    .map((entry) => ({ value: entry.value, label: entry.label }))
  const canTranslate = !!model && !!sourceText.trim() && !!targetLang
  const canSwap = !indic && sourceLang !== AUTO_ACCOUNT

  function changeModel(next: string): void {
    setModel(next)
    const pair = defaultTranslationPair(next)
    setSourceLang(pair.source)
    setTargetLang(pair.target)
    setTranslatedText('')
    setNeurons(0)
    setError(null)
  }

  function swap(): void {
    if (!canSwap) return
    setSourceLang(targetLang)
    setTargetLang(sourceLang)
    setSourceText(translatedText)
    setTranslatedText(sourceText)
  }

  async function translate(): Promise<void> {
    if (!canTranslate || loading) return
    setLoading(true)
    setError(null)
    setNeurons(0)
    try {
      const response = await aiApi.translate(buildTranslateBody({
        model,
        text: sourceText,
        sourceLang,
        targetLang,
        accountId,
      }))
      const item = response.data[0]
      if (!item || typeof item.translated_text !== 'string') {
        throw new Error(t('cloudflare.ai_translate.translate_error'))
      }
      setTranslatedText(item.translated_text)
      setNeurons(item.neurons ?? 0)
    } catch (failure: unknown) {
      const message = cfErrorText(failure)
      setError(message)
      toast({ title: t('cloudflare.ai_translate.translate_error'), description: message, tone: 'danger' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex flex-wrap items-end gap-2">
        <SelectMenu
          label={t('cloudflare.ai_translate.select_account')}
          value={accountId}
          options={accountOptions}
          onChange={setAccountId}
          width={240}
          className="w-48"
        />
        <SelectMenu
          label={t('cloudflare.ai_translate.select_model')}
          value={model}
          options={modelOptions}
          onChange={changeModel}
          width={300}
          className="w-64"
        />
      </div>

      {error ? <AiError message={error} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <SelectMenu
          label={t('cloudflare.ai_translate.source_lang')}
          value={sourceLang}
          options={sourceOptions}
          onChange={setSourceLang}
          disabled={indic}
          width={220}
          className="min-w-40 flex-1"
        />
        <IconButton
          label={`${t('cloudflare.ai_translate.source_lang')} ↔ ${t('cloudflare.ai_translate.target_lang')}`}
          disabled={!canSwap}
          onClick={swap}
        >
          <ArrowLeftRight size={14} />
        </IconButton>
        <SelectMenu
          label={t('cloudflare.ai_translate.target_lang')}
          value={targetLang}
          options={targetOptions}
          onChange={setTargetLang}
          width={220}
          className="min-w-40 flex-1"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="ai-translate-source" className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {t('cloudflare.ai_translate.source_placeholder')}
          </label>
          <Textarea
            id="ai-translate-source"
            rows={8}
            maxLength={MAX_TEXT_CHARS}
            value={sourceText}
            placeholder={t('cloudflare.ai_translate.source_placeholder')}
            onChange={(event) => setSourceText(event.target.value)}
            className="min-h-48 flex-1"
          />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="ai-translate-target" className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {t('cloudflare.ai_translate.result_placeholder')}
          </label>
          <Textarea
            id="ai-translate-target"
            rows={8}
            readOnly
            value={translatedText}
            placeholder={t('cloudflare.ai_translate.result_placeholder')}
            className="min-h-48 flex-1"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            loading={loading}
            disabled={!canTranslate}
            icon={<Languages size={14} />}
            onClick={() => { void translate() }}
          >
            {t('cloudflare.ai_translate.translate_btn')}
          </Button>
          {translatedText ? (
            <CopyButton
              text={translatedText}
              label={t('cloudflare.ai_translate.copy_btn')}
              size="sm"
            />
          ) : null}
        </div>
        {neurons > 0 ? (
          <Badge tone="accent">
            <Zap size={11} aria-hidden="true" className="mr-1" />
            {t('cloudflare.ai_translate.neurons_used', { count: neurons })}
          </Badge>
        ) : null}
      </div>
    </div>
  )
}
