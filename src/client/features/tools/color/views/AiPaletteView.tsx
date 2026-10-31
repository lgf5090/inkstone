import { useState } from 'react'
import { Loader2, Sparkles, Wand2 } from 'lucide-react'
import type { AiPaletteResult } from '@shared/tools/color/types'
import { COLOR_AI_PALETTE_MAX, COLOR_AI_PALETTE_MIN } from '@shared/tools/color/contract'
import { t } from '../../../../lib/i18n'
import type { MessageKey } from '@shared/locales/en-US'
import { Button } from '../../../../components/primitives'
import { Select, Slider, Textarea } from '../../../../components/form'
import { useUi } from '../../../../store/ui'
import { colorApi } from '../api'
import { AiPaletteResultCard } from '../components/AiPaletteResultCard'
import { useColorStudioStore } from '../store'

// The value travels to the model as a prompt ingredient, so it stays English; what a reader picks is the
// catalogue's own words for it, named key by key rather than built from the value.
const STYLES: Array<{ value: string; labelKey: MessageKey }> = [
  { value: 'Modern', labelKey: 'tools.color.ai.style_value.modern' },
  { value: 'Vintage', labelKey: 'tools.color.ai.style_value.vintage' },
  { value: 'Cyberpunk', labelKey: 'tools.color.ai.style_value.cyberpunk' },
  { value: 'Morandi', labelKey: 'tools.color.ai.style_value.morandi' },
  { value: 'Nature', labelKey: 'tools.color.ai.style_value.nature' },
  { value: 'Luxury', labelKey: 'tools.color.ai.style_value.luxury' },
  { value: 'Pastel', labelKey: 'tools.color.ai.style_value.pastel' },
]
type ToneKey = 'all' | 'warm' | 'cool' | 'neutral'

const TONES: Array<{ key: ToneKey; labelKey: MessageKey }> = [
  { key: 'all', labelKey: 'tools.color.ai.tone_value.all' },
  { key: 'warm', labelKey: 'tools.color.ai.tone_value.warm' },
  { key: 'cool', labelKey: 'tools.color.ai.tone_value.cool' },
  { key: 'neutral', labelKey: 'tools.color.ai.tone_value.neutral' },
]

export function AiPaletteView() {
  const currentHex = useColorStudioStore((s) => s.currentHex)

  const [prompt, setPrompt] = useState('')
  const [selectedStyle, setSelectedStyle] = useState('Modern')
  const [selectedTone, setSelectedTone] = useState<ToneKey>('all')
  const [colorCount, setColorCount] = useState(5)
  const [isGenerating, setIsGenerating] = useState(false)
  const [result, setResult] = useState<AiPaletteResult | null>(null)

  const handleGenerate = async () => {
    setIsGenerating(true)
    try {
      const data = await colorApi.generateAiPalette({
        prompt: prompt.trim(),
        seedHex: currentHex,
        style: selectedStyle,
        tone: selectedTone,
        count: colorCount,
      })
      setResult(data)
      if (data.degraded) {
        useUi.getState().toast({
          title: t('tools.color.ai.degraded_notice', {
            reason: t(('tools.color.ai.reason.' + (data.reason ?? 'upstream')) as Parameters<typeof t>[0]),
          }),
          tone: 'warning',
        })
      }
    } catch (e: unknown) {
      const err = e as Error
      useUi.getState().toast({
        title: err.message || t('tools.color.toast.ai_failed'),
        tone: 'danger',
      })
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 w-full max-w-5xl mx-auto p-4 md:p-6 overflow-y-auto">
      {/* Header */}
      <div className="flex flex-col gap-1 border-b border-[var(--border-subtle)] pb-4">
        <h2 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          {t('tools.color.ai.title')}
        </h2>
        <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {t('tools.color.ai.subtitle')}
        </p>
      </div>

      {/* Control Card */}
      <div className="flex flex-col gap-4 p-5 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] shadow-sm">
        {/* Prompt Input */}
        <div className="flex flex-col gap-1.5">
          <label
            className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]"
            htmlFor="color-ai-prompt"
          >
            {t('tools.color.ai.prompt_label')}
          </label>
          <Textarea
            id="color-ai-prompt"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('tools.color.ai.prompt_placeholder')}
            maxLength={500}
            className="resize-none"
          />
        </div>

        {/* Filters Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          {/* Seed Color Indicator */}
          <div className="flex flex-col gap-1">
            <span className="text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
              {t('tools.color.studio.seed_color')}
            </span>
            <div className="flex items-center gap-2 h-9 px-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
              <div
                style={{ backgroundColor: currentHex }}
                className="w-4 h-4 rounded-full border border-black/10 shrink-0"
              />
              <span className="font-mono text-[length:var(--text-12)] font-semibold text-[var(--text-primary)] uppercase">
                {currentHex}
              </span>
            </div>
          </div>

          {/* Style */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor="color-ai-style"
              className="text-[length:var(--text-11)] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]"
            >
              {t('tools.color.ai.style')}
            </label>
            <Select
              id="color-ai-style"
              value={selectedStyle}
              onChange={(e) => setSelectedStyle(e.target.value)}
            >
              {STYLES.map((st) => (
                <option key={st.value} value={st.value}>
                  {t(st.labelKey)}
                </option>
              ))}
            </Select>
          </div>

          {/* Tone */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor="color-ai-tone"
              className="text-[length:var(--text-11)] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]"
            >
              {t('tools.color.ai.tone')}
            </label>
            <Select
              id="color-ai-tone"
              value={selectedTone}
              onChange={(e) =>
                setSelectedTone(e.target.value as ToneKey)
              }
            >
              {TONES.map((tn) => (
                <option key={tn.key} value={tn.key}>
                  {t(tn.labelKey)}
                </option>
              ))}
            </Select>
          </div>

          {/* Count */}
          <div className="flex flex-col gap-1">
            <span className="text-[length:var(--text-11)] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
              {t('tools.color.ai.count')}: {colorCount}
            </span>
            <Slider
              value={colorCount}
              min={COLOR_AI_PALETTE_MIN}
              max={COLOR_AI_PALETTE_MAX}
              onChange={setColorCount}
              label={t('tools.color.ai.count')}
            />
          </div>
        </div>

        {/* Generate Button */}
        <div className="flex justify-end pt-2">
          <Button
            variant="primary"
            size="md"
            disabled={isGenerating}
            onClick={handleGenerate}
            aria-label={t('tools.color.ai.generate')}
          >
            {isGenerating ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>{t('tools.color.ai.generating')}</span>
              </>
            ) : (
              <>
                <Wand2 size={16} />
                <span>{t('tools.color.ai.generate')}</span>
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Result Card */}
      {result && <AiPaletteResultCard result={result} />}

      {!result && !isGenerating && (
        <div className="p-12 text-center text-[length:var(--text-13)] text-[var(--text-tertiary)] border border-dashed border-[var(--border-subtle)] rounded-[var(--r-lg)] flex flex-col items-center gap-2">
          <Sparkles size={24} className="opacity-40" />
          <span>
            {t('tools.color.ai.empty_hint')}
          </span>
        </div>
      )}
    </div>
  )
}
