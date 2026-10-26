import { Copy, Heart, Plus } from 'lucide-react'
import { getHarmonies } from '@shared/tools/color/harmonies'
import { t } from '../../../../lib/i18n'
import { Tooltip } from '../../../../components/overlay'
import { IconButton } from '../../../../components/primitives'
import { useColorStudioStore } from '../store'

export interface HarmoniesPanelProps {
  currentHex: string
}

export function HarmoniesPanel({ currentHex }: HarmoniesPanelProps) {
  const setCurrentColor = useColorStudioStore((s) => s.setCurrentColor)
  const copyColor = useColorStudioStore((s) => s.copyColor)
  const addFavorite = useColorStudioStore((s) => s.addFavorite)
  const savePalette = useColorStudioStore((s) => s.savePalette)

  const harmonies = getHarmonies(currentHex)

  return (
    <div className="flex flex-col gap-4 w-full">
      <div className="flex items-center justify-between">
        <h3 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
          {t('tools.color.studio.harmonies')}
        </h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {harmonies.map((harmony) => (
          <div
            key={harmony.type}
            className="flex flex-col gap-2 p-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] hover:border-[var(--border-default)] transition-colors"
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                  {harmony.label}
                </span>
                <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)] line-clamp-1">
                  {harmony.description}
                </p>
              </div>
              <Tooltip label={t('tools.color.algorithm.save_palette')}>
                <IconButton
                  label={t('tools.color.algorithm.save_palette')}
                  size="sm"
                  onClick={() =>
                    savePalette(
                      `${harmony.label} - ${currentHex}`,
                      harmony.colors.map((hex, i) => ({
                        hex,
                        name: `${harmony.label} ${i + 1}`,
                      })),
                      'harmony',
                      [harmony.type],
                    )
                  }
                >
                  <Plus size={14} />
                </IconButton>
              </Tooltip>
            </div>

            <div className="flex h-12 w-full rounded-[var(--r-sm)] overflow-hidden border border-[var(--border-subtle)] shadow-sm">
              {harmony.colors.map((hex, idx) => (
                <div
                  key={`${hex}-${idx}`}
                  style={{ backgroundColor: hex }}
                  className="group relative flex-1 h-full transition-all hover:flex-[1.5]"
                >
                  <button
                    type="button"
                    aria-label={`Select color ${hex}`}
                    onClick={() => setCurrentColor(hex, 'palette')}
                    className="absolute inset-0 w-full h-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  />
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/30 backdrop-blur-[1px] transition-opacity gap-1 pointer-events-none group-hover:pointer-events-auto">
                    <Tooltip label={hex}>
                      <button
                        type="button"
                        aria-label={`Copy ${hex}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          copyColor(hex)
                        }}
                        className="p-1 rounded bg-white/80 hover:bg-white text-zinc-900 transition-colors shadow-sm"
                      >
                        <Copy size={11} />
                      </button>
                    </Tooltip>
                    <Tooltip label={t('tools.color.studio.favorite')}>
                      <button
                        type="button"
                        aria-label={`Favorite ${hex}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          addFavorite(hex, `${harmony.label} ${idx + 1}`)
                        }}
                        className="p-1 rounded bg-white/80 hover:bg-white text-zinc-900 transition-colors shadow-sm"
                      >
                        <Heart size={11} />
                      </button>
                    </Tooltip>
                  </div>
                  <span className="sr-only">{hex}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
