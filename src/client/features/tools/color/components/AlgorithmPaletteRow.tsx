import { Copy, Heart, Plus } from 'lucide-react'
import type { AlgorithmicPalette } from '@shared/tools/color/types'
import { isDarkColor } from '@shared/tools/color/spaces'
import { t } from '../../../../lib/i18n'
import { Tooltip } from '../../../../components/overlay'
import { IconButton } from '../../../../components/primitives'
import { useColorStudioStore } from '../store'

export interface AlgorithmPaletteRowProps {
  palette: AlgorithmicPalette
}

export function AlgorithmPaletteRow({ palette }: AlgorithmPaletteRowProps) {
  const setCurrentColor = useColorStudioStore((s) => s.setCurrentColor)
  const copyColor = useColorStudioStore((s) => s.copyColor)
  const addFavorite = useColorStudioStore((s) => s.addFavorite)
  const savePalette = useColorStudioStore((s) => s.savePalette)

  return (
    <div className="flex flex-col gap-3 p-4 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {palette.name}
          </h3>
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)] mt-0.5">
            {palette.description}
          </p>
        </div>
        <Tooltip label={t('tools.color.algorithm.save_palette')}>
          <IconButton
            label={t('tools.color.algorithm.save_palette')}
            size="sm"
            onClick={() =>
              savePalette(
                palette.name,
                palette.colors.map((hex, i) => ({
                  hex,
                  name: `${palette.name} ${i + 1}`,
                })),
                'mycolorspace',
                [palette.id],
              )
            }
          >
            <Plus size={14} />
          </IconButton>
        </Tooltip>
      </div>

      <div className="flex h-14 w-full rounded-[var(--r-md)] overflow-hidden border border-[var(--border-subtle)] shadow-xs">
        {palette.colors.map((hex, idx) => {
          const isDark = isDarkColor(hex)
          return (
            <div
              key={`${palette.id}-${hex}-${idx}`}
              style={{ backgroundColor: hex }}
              className="group relative flex-1 h-full transition-all hover:flex-[1.4] select-none flex items-end p-1.5"
            >
              <button
                type="button"
                aria-label={`Select color ${hex}`}
                onClick={() => setCurrentColor(hex, 'palette')}
                className="absolute inset-0 w-full h-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              />
              <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                <Tooltip label={hex}>
                  <button
                    type="button"
                    aria-label={`Copy ${hex}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      copyColor(hex)
                    }}
                    className="p-1 rounded bg-black/40 hover:bg-black/60 text-white transition-colors"
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
                      addFavorite(hex, `${palette.name} ${idx + 1}`)
                    }}
                    className="p-1 rounded bg-black/40 hover:bg-black/60 text-white transition-colors"
                  >
                    <Heart size={11} />
                  </button>
                </Tooltip>
              </div>

              <span
                className={`font-mono text-[length:var(--text-10)] uppercase opacity-0 group-hover:opacity-100 transition-opacity ${
                  isDark ? 'text-white' : 'text-zinc-900'
                }`}
              >
                {hex}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
