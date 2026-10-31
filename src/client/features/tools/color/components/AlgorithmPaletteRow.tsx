import { Copy, Heart, Plus } from 'lucide-react'
import type { AlgorithmicPalette } from '@shared/tools/color/types'
import { recommendedTextColor } from '@shared/tools/color/a11y'
import { t } from '../../../../lib/i18n'
import { Tooltip } from '../../../../components/overlay'
import { IconButton } from '../../../../components/primitives'
import { useColorStudioStore } from '../store'
import { SwatchActions } from './SwatchActions'
import { algorithmDescription, algorithmName } from '../lib/display-names'

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
            {algorithmName(palette.id)}
          </h3>
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)] mt-0.5">
            {algorithmDescription(palette.id)}
          </p>
        </div>
        <Tooltip label={t('tools.color.algorithm.save_palette')}>
          <IconButton
            label={t('tools.color.algorithm.save_palette')}
            size="sm"
            onClick={() =>
              savePalette(
                algorithmName(palette.id),
                palette.colors.map((hex, i) => ({
                  hex,
                  name: `${algorithmName(palette.id)} ${i + 1}`,
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
        {palette.colors.map((hex, idx) => (
          <div
            key={`${palette.id}-${hex}-${idx}`}
            style={{ backgroundColor: hex, color: recommendedTextColor(hex) }}
            className="group relative flex-1 h-full flex items-end p-1.5 transition-[flex] duration-[var(--dur-fast)] hover:flex-[1.4] select-none"
          >
            <button
              type="button"
              aria-label={t('tools.color.swatch.use', { hex })}
              onClick={() => setCurrentColor(hex, 'palette')}
              className="absolute inset-0 w-full h-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
            />
            <SwatchActions
              className="absolute top-1.5 right-1.5"
              actions={[
                {
                  key: 'copy',
                  label: t('tools.color.studio.copy'),
                  icon: <Copy size={11} />,
                  onSelect: () => copyColor(hex, `${algorithmName(palette.id)} ${idx + 1}`),
                },
                {
                  key: 'favorite',
                  label: t('tools.color.studio.favorite'),
                  icon: <Heart size={11} />,
                  onSelect: () => addFavorite(hex, `${algorithmName(palette.id)} ${idx + 1}`),
                },
              ]}
            />

            <span className="font-mono text-[length:var(--text-10)] uppercase opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
              {hex}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
