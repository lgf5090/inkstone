import { Copy, Heart } from 'lucide-react'
import type { TraditionalColorItem } from '@shared/tools/color/types'
import { recommendedTextColor } from '@shared/tools/color/a11y'
import { t } from '../../../../lib/i18n'
import { useColorStudioStore } from '../store'
import { SwatchActions } from './SwatchActions'

export interface TraditionalColorCardProps {
  color: TraditionalColorItem
}

/**
 * The plate a solar-term chip sits on, chosen against the ink the swatch earned.
 *
 * A 10% black veil left the 10px label at 3.86–4.11:1 on the mid-tone traditional colours (measured in
 * Chromium over the whole 634-colour set), which is under the floor `AGENTS.md` rule 13 sets. An
 * almost-opaque plate of the ink's own family clears 4.5 whatever is painted underneath: black on 86% white
 * is 15.2:1 against the worst substrate, white on 62% black is 6.3:1.
 */
export function solarTermPlate(ink: string): string {
  return ink === '#ffffff' ? 'rgba(0, 0, 0, 0.62)' : 'rgba(255, 255, 255, 0.86)'
}

export function TraditionalColorCard({ color }: TraditionalColorCardProps) {
  const setCurrentColor = useColorStudioStore((s) => s.setCurrentColor)
  const copyColor = useColorStudioStore((s) => s.copyColor)
  const addFavorite = useColorStudioStore((s) => s.addFavorite)

  const phonetic = color.pinyin || color.romaji || color.kana || ''

  return (
    <div
      className="group relative flex flex-col justify-between p-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] hover:border-[var(--border-strong)] transition-all shadow-xs hover:shadow-md select-none"
    >
      <button
        type="button"
        aria-label={t('tools.color.swatch.use', { hex: color.hex })}
        onClick={() => setCurrentColor(color.hex, 'traditional')}
        className="absolute inset-0 w-full h-full cursor-pointer rounded-[var(--r-lg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      />
      {/* Color Top Banner */}
      <div
        style={{ backgroundColor: color.hex }}
        className="relative h-24 w-full rounded-[var(--r-md)] border border-black/5 overflow-hidden flex items-end p-2"
      >
        <SwatchActions
          className="absolute top-2 right-2"
          actions={[
            {
              key: 'copy',
              label: t('tools.color.studio.copy'),
              icon: <Copy size={12} />,
              onSelect: () => copyColor(color.hex, color.name),
            },
            {
              key: 'favorite',
              label: t('tools.color.studio.favorite'),
              icon: <Heart size={12} />,
              onSelect: () => addFavorite(color.hex, color.name),
            },
          ]}
        />

        {color.solarTerm && (
          <span
            style={{ color: recommendedTextColor(color.hex), backgroundColor: solarTermPlate(recommendedTextColor(color.hex)) }}
            className="text-[length:var(--text-10)] font-medium px-1.5 py-0.5 rounded"
          >
            {color.solarTerm}
          </span>
        )}
      </div>

      {/* Info Section */}
      <div className="flex flex-col mt-2.5">
        <div className="flex items-baseline justify-between">
          <h4 className="text-[length:var(--text-15)] font-bold text-[var(--text-primary)] font-serif">
            {color.name}
          </h4>
          <span className="font-mono text-[length:var(--text-11)] font-medium text-[var(--text-secondary)] uppercase">
            {color.hex}
          </span>
        </div>

        <div className="flex items-center justify-between text-[length:var(--text-11)] text-[var(--text-tertiary)] mt-1">
          <span className="font-sans italic">{phonetic}</span>
          <span className="font-mono text-[length:var(--text-10)]">
            {`C:${color.cmyk[0]} M:${color.cmyk[1]} Y:${color.cmyk[2]} K:${color.cmyk[3]}`}
          </span>
        </div>
      </div>
    </div>
  )
}
