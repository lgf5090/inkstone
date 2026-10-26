import { RefreshCw, Sparkles } from 'lucide-react'
import { generateAlgorithmicPalettes } from '@shared/tools/color/colorspace-algorithms'
import { t } from '../../../../lib/i18n'
import { Button } from '../../../../components/primitives'
import { AlgorithmPaletteRow } from '../components/AlgorithmPaletteRow'
import { useColorStudioStore } from '../store'

export function ColorSpaceAlgorithmView() {
  const currentHex = useColorStudioStore((s) => s.currentHex)
  const setCurrentColor = useColorStudioStore((s) => s.setCurrentColor)

  const palettes = generateAlgorithmicPalettes(currentHex)

  const handleRandomSeed = () => {
    const randomHex =
      '#' +
      Math.floor(Math.random() * 16777215)
        .toString(16)
        .padStart(6, '0')
    setCurrentColor(randomHex, 'random')
  }

  return (
    <div className="flex flex-col gap-6 w-full max-w-5xl mx-auto p-4 md:p-6 overflow-y-auto">
      {/* Header Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
        <div>
          <h2 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
            {t('tools.color.algorithm.title')}
          </h2>
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)] mt-0.5">
            {t('tools.color.algorithm.subtitle')}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Seed indicator */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
            <div
              style={{ backgroundColor: currentHex }}
              className="w-4 h-4 rounded-full border border-black/10 shadow-xs"
            />
            <span className="font-mono text-[length:var(--text-12)] font-semibold uppercase text-[var(--text-primary)]">
              {currentHex}
            </span>
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={handleRandomSeed}
            aria-label={t('tools.color.studio.random_color')}
          >
            <Sparkles size={14} />
            <span>{t('tools.color.studio.random_color')}</span>
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCurrentColor(currentHex, 'picker')}
            aria-label={t('tools.color.algorithm.refresh')}
          >
            <RefreshCw size={14} />
            <span>{t('tools.color.algorithm.refresh')}</span>
          </Button>
        </div>
      </div>

      {/* Palette rows */}
      <div className="flex flex-col gap-4">
        {palettes.map((palette) => (
          <AlgorithmPaletteRow key={palette.id} palette={palette} />
        ))}
      </div>
    </div>
  )
}
