import { useState } from 'react'
import { Loader2, Sparkles, Wand2 } from 'lucide-react'
import type { AiPaletteResult } from '@shared/tools/color/types'
import { t } from '../../../../lib/i18n'
import { Button } from '../../../../components/primitives'
import { useUi } from '../../../../store/ui'
import { colorApi } from '../api'
import { AiPaletteResultCard } from '../components/AiPaletteResultCard'
import { useColorStudioStore } from '../store'

const STYLES = ['Modern', 'Vintage', 'Cyberpunk', 'Morandi', 'Nature', 'Luxury', 'Pastel']
const TONES: Array<{ key: 'all' | 'warm' | 'cool' | 'neutral'; label: string }> = [
  { key: 'all', label: 'Balanced' },
  { key: 'warm', label: 'Warm' },
  { key: 'cool', label: 'Cool' },
  { key: 'neutral', label: 'Neutral' },
]

export function AiPaletteView() {
  const currentHex = useColorStudioStore((s) => s.currentHex)

  const [prompt, setPrompt] = useState('')
  const [selectedStyle, setSelectedStyle] = useState('Modern')
  const [selectedTone, setSelectedTone] = useState<'all' | 'warm' | 'cool' | 'neutral'>('all')
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
    } catch (e: unknown) {
      const err = e as Error
      useUi.getState().toast({
        title: err.message || 'AI Generation failed',
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
          <label className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
            {t('tools.color.ai.prompt_label')}
          </label>
          <textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('tools.color.ai.prompt_placeholder')}
            aria-label={t('tools.color.ai.prompt_aria')}
            className="w-full p-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] text-[length:var(--text-13)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] resize-none"
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
            <span className="text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
              {t('tools.color.ai.style')}
            </span>
            <select
              value={selectedStyle}
              onChange={(e) => setSelectedStyle(e.target.value)}
              aria-label={t('tools.color.ai.style')}
              className="h-9 px-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] text-[length:var(--text-12)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] cursor-pointer"
            >
              {STYLES.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
          </div>

          {/* Tone */}
          <div className="flex flex-col gap-1">
            <span className="text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
              {t('tools.color.ai.tone')}
            </span>
            <select
              value={selectedTone}
              onChange={(e) =>
                setSelectedTone(e.target.value as 'all' | 'warm' | 'cool' | 'neutral')
              }
              aria-label={t('tools.color.ai.tone')}
              className="h-9 px-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] text-[length:var(--text-12)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] cursor-pointer"
            >
              {TONES.map((tn) => (
                <option key={tn.key} value={tn.key}>
                  {tn.label}
                </option>
              ))}
            </select>
          </div>

          {/* Count */}
          <div className="flex flex-col gap-1">
            <span className="text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
              {t('tools.color.ai.count')}: {colorCount}
            </span>
            <input
              type="range"
              min={3}
              max={8}
              value={colorCount}
              onChange={(e) => setColorCount(Number(e.target.value))}
              aria-label={t('tools.color.ai.count')}
              className="h-9 w-full cursor-pointer accent-[var(--accent)]"
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
