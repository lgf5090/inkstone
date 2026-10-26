import { Copy, Heart, Plus } from 'lucide-react'
import { isDarkColor } from '@shared/tools/color/spaces'
import type { UiPaletteGroup } from '@shared/tools/color/presets'
import { t } from '../../../../lib/i18n'
import { Tooltip } from '../../../../components/overlay'
import { IconButton } from '../../../../components/primitives'
import { useColorStudioStore } from '../store'

export interface PaletteSwatchGridProps {
  groups: UiPaletteGroup[]
}

export function PaletteSwatchGrid({ groups }: PaletteSwatchGridProps) {
  const setCurrentColor = useColorStudioStore((s) => s.setCurrentColor)
  const copyColor = useColorStudioStore((s) => s.copyColor)
  const addFavorite = useColorStudioStore((s) => s.addFavorite)
  const savePalette = useColorStudioStore((s) => s.savePalette)

  return (
    <div className="flex flex-col gap-6 w-full">
      {groups.map((group) => (
        <div
          key={group.id}
          className="flex flex-col gap-3 p-4 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] shadow-sm"
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
                {group.name}
              </h3>
              <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                {t('tools.color.ui.shades', { count: group.colors.length })}
              </p>
            </div>
            <Tooltip label={t('tools.color.algorithm.save_palette')}>
              <IconButton
                label={t('tools.color.algorithm.save_palette')}
                size="sm"
                onClick={() =>
                  savePalette(
                    group.name,
                    group.colors.map((c) => ({ hex: c.hex, name: c.name })),
                    'custom',
                    [group.id],
                  )
                }
              >
                <Plus size={14} />
              </IconButton>
            </Tooltip>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-10 gap-2">
            {group.colors.map((color) => {
              const dark = isDarkColor(color.hex)
              return (
                <div
                  key={`${group.id}-${color.hex}-${color.name}`}
                  style={{ backgroundColor: color.hex }}
                  className="group relative flex flex-col justify-between h-20 p-2 rounded-[var(--r-md)] border border-black/5 shadow-xs transition-transform hover:scale-105 select-none"
                >
                  <button
                    type="button"
                    aria-label={`Select ${color.name} ${color.hex}`}
                    onClick={() => setCurrentColor(color.hex, 'palette')}
                    className="absolute inset-0 w-full h-full cursor-pointer rounded-[var(--r-md)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  />
                  <div className="flex items-center justify-between w-full opacity-0 group-hover:opacity-100 transition-opacity z-10">
                    <Tooltip label={color.hex}>
                      <button
                        type="button"
                        aria-label={`Copy ${color.hex}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          copyColor(color.hex, color.name)
                        }}
                        className="p-1 rounded bg-black/40 hover:bg-black/60 text-white transition-colors"
                      >
                        <Copy size={11} />
                      </button>
                    </Tooltip>
                    <Tooltip label={t('tools.color.studio.favorite')}>
                      <button
                        type="button"
                        aria-label={`Favorite ${color.hex}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          addFavorite(color.hex, color.name)
                        }}
                        className="p-1 rounded bg-black/40 hover:bg-black/60 text-white transition-colors"
                      >
                        <Heart size={11} />
                      </button>
                    </Tooltip>
                  </div>

                  <div className={dark ? 'text-white' : 'text-zinc-900'}>
                    <span className="block text-[length:var(--text-10)] font-medium truncate leading-tight">
                      {color.name}
                    </span>
                    <span className="block text-[length:var(--text-10)] font-mono opacity-85 uppercase">
                      {color.hex}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
