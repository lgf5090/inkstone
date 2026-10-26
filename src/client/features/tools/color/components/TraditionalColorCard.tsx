import { Copy, Heart } from 'lucide-react'
import type { TraditionalColorItem } from '@shared/tools/color/types'
import { isDarkColor } from '@shared/tools/color/spaces'
import { t } from '../../../../lib/i18n'
import { Tooltip } from '../../../../components/overlay'
import { useColorStudioStore } from '../store'

export interface TraditionalColorCardProps {
  color: TraditionalColorItem
}

export function TraditionalColorCard({ color }: TraditionalColorCardProps) {
  const setCurrentColor = useColorStudioStore((s) => s.setCurrentColor)
  const copyColor = useColorStudioStore((s) => s.copyColor)
  const addFavorite = useColorStudioStore((s) => s.addFavorite)

  const isDark = isDarkColor(color.hex)
  const phonetic = color.pinyin || color.romaji || color.kana || ''

  return (
    <div
      className="group relative flex flex-col justify-between p-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] hover:border-[var(--border-strong)] transition-all shadow-xs hover:shadow-md select-none"
    >
      <button
        type="button"
        aria-label={`Select ${color.name} ${color.hex}`}
        onClick={() => setCurrentColor(color.hex, 'traditional')}
        className="absolute inset-0 w-full h-full cursor-pointer rounded-[var(--r-lg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]"
      />
      {/* Color Top Banner */}
      <div
        style={{ backgroundColor: color.hex }}
        className="relative h-24 w-full rounded-[var(--r-md)] border border-black/5 overflow-hidden flex items-end p-2 pointer-events-none"
      >
        <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-auto">
          <Tooltip label={color.hex}>
            <button
              type="button"
              aria-label={`Copy ${color.name} ${color.hex}`}
              onClick={(e) => {
                e.stopPropagation()
                copyColor(color.hex, color.name)
              }}
              className="p-1 rounded bg-black/40 hover:bg-black/60 text-white transition-colors"
            >
              <Copy size={12} />
            </button>
          </Tooltip>
          <Tooltip label={t('tools.color.studio.favorite')}>
            <button
              type="button"
              aria-label={`Favorite ${color.name}`}
              onClick={(e) => {
                e.stopPropagation()
                addFavorite(color.hex, color.name)
              }}
              className="p-1 rounded bg-black/40 hover:bg-black/60 text-white transition-colors"
            >
              <Heart size={12} />
            </button>
          </Tooltip>
        </div>

        {color.solarTerm && (
          <span
            className={`text-[length:var(--text-10)] font-medium px-1.5 py-0.5 rounded backdrop-blur-xs ${
              isDark ? 'bg-white/20 text-white' : 'bg-black/20 text-zinc-900'
            }`}
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
