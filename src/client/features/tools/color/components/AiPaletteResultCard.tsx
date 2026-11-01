import { Bookmark, Copy, Heart } from 'lucide-react'
import type { AiPaletteResult } from '@shared/tools/color/types'
import { recommendedTextColor } from '@shared/tools/color/a11y'
import { t } from '../../../../lib/i18n'
import { Button } from '../../../../components/primitives'
import { useColorStudioStore } from '../store'
import { PaletteHealthSummary } from './PaletteHealthSummary'
import { AiDegradedNotice } from './AiDegradedNotice'
import { SwatchActions } from './SwatchActions'

export interface AiPaletteResultCardProps {
  result: AiPaletteResult
}

export function AiPaletteResultCard({ result }: AiPaletteResultCardProps) {
  const setCurrentColor = useColorStudioStore((s) => s.setCurrentColor)
  const copyColor = useColorStudioStore((s) => s.copyColor)
  const addFavorite = useColorStudioStore((s) => s.addFavorite)
  const savePalette = useColorStudioStore((s) => s.savePalette)

  const handleSave = () => {
    savePalette(
      result.title,
      result.colors.map((c) => ({
        hex: c.hex,
        name: c.name,
      })),
      'ai',
      result.tags,
      result.description,
    )
  }

  return (
    <div className="flex flex-col gap-4 p-5 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[length:var(--text-16)] font-bold text-[var(--text-primary)]">
            {result.title}
          </h3>
          <p className="text-[length:var(--text-13)] text-[var(--text-secondary)] mt-1 max-w-2xl leading-relaxed">
            {result.description}
          </p>
          {result.tags && result.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
              {result.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-2 py-0.5 rounded-full text-[length:var(--text-10)] font-medium bg-[var(--bg-raised)] text-[var(--text-secondary)] border border-[var(--border-subtle)]"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
          <PaletteHealthSummary colors={result.colors.map((color) => color.hex)} />
        </div>

        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          aria-label={t('tools.color.ai.save_scheme')}
        >
          <Bookmark size={14} />
          <span>{t('tools.color.ai.save_scheme')}</span>
        </Button>
      </div>

      {result.degraded && <AiDegradedNotice reason={result.reason ?? 'upstream'} />}

      {/* Colors Ribbon & Details */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 mt-2">
        {result.colors.map((color, idx) => {
          return (
            <div
              key={`${color.hex}-${idx}`}
              className="group relative flex flex-col rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] overflow-hidden hover:shadow-md transition-shadow select-none"
            >
              <button
                type="button"
                aria-label={t('tools.color.swatch.use', { hex: color.hex })}
                onClick={() => setCurrentColor(color.hex, 'palette')}
                className="absolute inset-0 w-full h-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
              />
              {/* Color Box */}
              <div
                style={{ backgroundColor: color.hex, color: recommendedTextColor(color.hex) }}
                className="relative h-20 w-full flex items-end justify-between p-2"
              >
                <SwatchActions
                  className="absolute top-1.5 right-1.5"
                  actions={[
                    {
                      key: 'copy',
                      label: t('tools.color.studio.copy'),
                      icon: <Copy size={11} />,
                      onSelect: () => copyColor(color.hex, color.name),
                    },
                    {
                      key: 'favorite',
                      label: t('tools.color.studio.favorite'),
                      icon: <Heart size={11} />,
                      onSelect: () => addFavorite(color.hex, color.name),
                    },
                  ]}
                />

                <span className="font-mono text-[length:var(--text-10)] uppercase font-semibold">
                  {color.hex}
                </span>
              </div>

              {/* Text Info */}
              <div className="p-2.5 flex flex-col">
                <span className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)] truncate">
                  {color.name}
                </span>
                {color.description && (
                  <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)] truncate mt-0.5">
                    {color.description}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
