import { useState } from 'react'
import { Copy, Download, Heart, Palette, Pipette } from 'lucide-react'
import type { ColorHuntPalette } from '@shared/tools/color/types'
import { IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import { useColorStudioStore } from '../store'

export interface ColorHuntCardProps {
  palette: ColorHuntPalette
}

export function ColorHuntCard({ palette }: ColorHuntCardProps) {
  const [likes, setLikes] = useState(palette.likes)
  const [isLiked, setIsLiked] = useState(false)

  const setCurrentHex = useColorStudioStore((s) => s.setCurrentHex)
  const copyColor = useColorStudioStore((s) => s.copyColor)
  const savePalette = useColorStudioStore((s) => s.savePalette)
  const openExportPaletteModal = useColorStudioStore((s) => s.openExportPaletteModal)

  const handleLike = () => {
    if (isLiked) {
      setLikes((n) => Math.max(0, n - 1))
      setIsLiked(false)
    } else {
      setLikes((n) => n + 1)
      setIsLiked(true)
    }
  }

  const handleSavePalette = async () => {
    await savePalette(
      palette.title,
      palette.colors.map((hex) => ({ hex })),
      'colorhunt',
      palette.tags,
      `Curated Color Hunt palette: ${palette.title}`,
    )
  }

  // Classic Color Hunt vertical proportions
  const heights = ['h-24', 'h-16', 'h-12', 'h-10']

  return (
    <div className="group flex flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-xs transition-all duration-[var(--dur-base)] hover:shadow-md hover:border-[var(--accent)]">
      {/* 4-Color Stacked Swatches */}
      <div className="flex flex-col w-full overflow-hidden">
        {palette.colors.map((hex, index) => {
          const heightClass = heights[index] || 'h-12'
          return (
            <div
              key={`${palette.id}-${hex}-${index}`}
              className={`relative ${heightClass} w-full flex items-center justify-between px-3 transition-opacity hover:opacity-95`}
              style={{ backgroundColor: hex }}
            >
              <button
                type="button"
                aria-label={`Copy color ${hex}`}
                onClick={() => copyColor(hex, palette.title)}
                className="absolute inset-0 w-full h-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
              />
              <div className="opacity-0 group-hover:opacity-100 flex items-center justify-between w-full transition-opacity z-10 pointer-events-none group-hover:pointer-events-auto">
                <span className="font-mono text-[length:var(--text-12)] font-bold text-white drop-shadow-sm uppercase">
                  {hex}
                </span>
                <div className="flex items-center gap-1 bg-black/30 rounded-full px-1.5 py-0.5">
                  <Tooltip label={t('tools.color.studio.seed_color')}>
                    <button
                      type="button"
                      aria-label={t('tools.color.studio.seed_color')}
                      onClick={(e) => {
                        e.stopPropagation()
                        setCurrentHex(hex, 'colorhunt')
                      }}
                      className="text-white hover:text-[var(--accent)] p-0.5"
                    >
                      <Pipette size={12} />
                    </button>
                  </Tooltip>
                  <Tooltip label={t('tools.color.studio.copy')}>
                    <button
                      type="button"
                      aria-label={t('tools.color.studio.copy')}
                      onClick={(e) => {
                        e.stopPropagation()
                        copyColor(hex, palette.title)
                      }}
                      className="text-white hover:text-[var(--accent)] p-0.5"
                    >
                      <Copy size={12} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Card Info & Actions */}
      <div className="p-3.5 flex flex-col space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {palette.title}
          </span>
          <button
            type="button"
            onClick={handleLike}
            className={`flex items-center gap-1 text-[length:var(--text-12)] font-medium rounded-full px-2 py-0.5 border transition-colors ${
              isLiked
                ? 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]'
                : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--danger)] hover:border-[var(--danger)]'
            }`}
            aria-label={`${t('tools.color.hunt.like')}: ${likes}`}
          >
            <Heart size={12} className={isLiked ? 'fill-current' : ''} />
            <span>{likes}</span>
          </button>
        </div>

        <div className="flex items-center justify-between pt-1 border-t border-[var(--border-subtle)]">
          {/* Tags */}
          <div className="flex flex-wrap gap-1">
            {palette.tags.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="text-[length:var(--text-10)] text-[var(--text-tertiary)] bg-[var(--bg-sunken)] px-1.5 py-0.5 rounded-sm capitalize"
              >
                {tag}
              </span>
            ))}
          </div>

          {/* Quick Actions */}
          <div className="flex items-center gap-1">
            <Tooltip label={t('tools.color.create_palette.save')}>
              <IconButton
                size="xs"
                label={t('tools.color.create_palette.save')}
                onClick={handleSavePalette}
              >
                <Palette size={12} />
              </IconButton>
            </Tooltip>
            <Tooltip label={t('tools.color.export.title')}>
              <IconButton
                size="xs"
                label={t('tools.color.export.title')}
                onClick={() =>
                  openExportPaletteModal({
                    title: palette.title,
                    colors: palette.colors,
                  })
                }
              >
                <Download size={12} />
              </IconButton>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  )
}
