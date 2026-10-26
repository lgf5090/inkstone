import { useState } from 'react'
import { Check, Copy, Palette } from 'lucide-react'
import { buildCssGradient } from '@shared/tools/color/oklab'
import { GRADIENT_PRESETS, type GradientPresetItem } from '@shared/tools/color/presets/gradients'
import type { GradientConfig } from '@shared/tools/color/types'
import { Button, IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { useColorStudioStore } from '../store'
import { GradientBarController } from '../components/GradientBarController'

export function GradientStudioView() {
  const [gradientConfig, setGradientConfig] = useState<GradientConfig>({
    type: 'linear',
    angle: 135,
    stops: [
      { id: '1', color: '#ff512f', offset: 0 },
      { id: '2', color: '#dd2476', offset: 100 },
    ],
    useOklabInterpolation: true,
  })

  const [activeStopId, setActiveStopId] = useState<string>('1')
  const [selectedTag, setSelectedTag] = useState<string>('all')
  const [hasCopied, setHasCopied] = useState<boolean>(false)

  const savePalette = useColorStudioStore((s) => s.savePalette)

  const cssCode = `background: ${buildCssGradient(gradientConfig)};`

  const handleCopyCss = async () => {
    try {
      await navigator.clipboard.writeText(cssCode)
      setHasCopied(true)
      useUi.getState().toast({
        title: t('tools.color.toast.copied', {
          label: 'CSS Gradient',
          value: cssCode.slice(0, 30) + '...',
        }),
        tone: 'success',
      })
      setTimeout(() => setHasCopied(false), 2000)
    } catch {
      useUi.getState().toast({
        title: t('tools.color.toast.copy_failed'),
        tone: 'danger',
      })
    }
  }

  const handleLoadPreset = (preset: GradientPresetItem) => {
    setGradientConfig(preset.config)
    setActiveStopId(preset.config.stops[0]?.id || '')
  }

  const handleSavePalette = async () => {
    const items = gradientConfig.stops.map((stop) => ({
      hex: stop.color,
      name: `Stop ${stop.offset}%`,
      ratio: stop.offset,
    }))
    await savePalette(
      'Gradient Scheme',
      items,
      'custom',
      ['gradient', gradientConfig.type],
      `Gradient palette with ${gradientConfig.stops.length} stops`,
    )
  }

  // Tags filter
  const allTags = [
    'all',
    ...Array.from(new Set(GRADIENT_PRESETS.flatMap((p) => p.tags))),
  ]
  const filteredPresets =
    selectedTag === 'all'
      ? GRADIENT_PRESETS
      : GRADIENT_PRESETS.filter((p) => p.tags.includes(selectedTag))

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6 space-y-6 bg-[var(--bg-base)]">
      {/* Header */}
      <div>
        <h2 className="text-[length:var(--text-18)] font-bold text-[var(--text-primary)]">
          {t('tools.color.gradient.title')}
        </h2>
        <p className="mt-1 text-[length:var(--text-13)] text-[var(--text-secondary)]">
          {t('tools.color.gradient.subtitle')}
        </p>
      </div>

      {/* Main Studio Area */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Live Preview Stage */}
        <div className="lg:col-span-5 flex flex-col space-y-3">
          <div
            className="relative flex h-72 sm:h-80 w-full items-center justify-center rounded-[var(--radius-xl)] border border-[var(--border-subtle)] shadow-md transition-all"
            style={{ backgroundImage: buildCssGradient(gradientConfig) }}
          >
            <div className="absolute top-3 right-3 flex items-center gap-1.5 rounded-full bg-black/40 backdrop-blur-md px-3 py-1 text-white text-[length:var(--text-12)] font-mono">
              <span>{gradientConfig.type}</span>
              {gradientConfig.type !== 'radial' && <span>{gradientConfig.angle}°</span>}
              {gradientConfig.useOklabInterpolation && (
                <span className="text-[var(--color-primary-300)] font-semibold">{'OKLab'}</span>
              )}
            </div>
          </div>

          {/* Quick CSS Code Output */}
          <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5">
            <code className="truncate font-mono text-[length:var(--text-12)] text-[var(--text-secondary)] pr-2">
              {cssCode}
            </code>
            <Button size="sm" variant="secondary" onClick={handleCopyCss}>
              {hasCopied ? (
                <Check size={12} className="mr-1 text-[var(--color-success-500)]" />
              ) : (
                <Copy size={12} className="mr-1" />
              )}
              {t('tools.color.gradient.copy_css')}
            </Button>
          </div>
        </div>

        {/* Studio Controls */}
        <div className="lg:col-span-7 flex flex-col justify-between rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 shadow-xs">
          <div className="space-y-6">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
              <span className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
                {t('tools.color.gradient.config_title')}
              </span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={handleSavePalette}>
                  <Palette size={14} className="mr-1.5" />
                  {t('tools.color.create_palette.save')}
                </Button>
              </div>
            </div>

            <GradientBarController
              config={gradientConfig}
              onChange={setGradientConfig}
              activeStopId={activeStopId}
              onSelectStop={setActiveStopId}
            />
          </div>
        </div>
      </div>

      {/* Preset Inspirations Gallery */}
      <div className="pt-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
            {t('tools.color.gradient.curated_title')}
          </h3>

          {/* Tag filters */}
          <div className="flex flex-wrap items-center gap-1.5">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setSelectedTag(tag)}
                className={`px-2.5 py-1 text-[length:var(--text-12)] font-medium capitalize rounded-full transition-colors ${
                  selectedTag === tag
                    ? 'bg-[var(--brand-primary)] text-white'
                    : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:border-[var(--brand-primary)]'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        {/* Grid of presets */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {filteredPresets.map((preset) => {
            const previewCss = buildCssGradient(preset.config)
            return (
              <div
                key={preset.id}
                className="group flex flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] transition-all hover:border-[var(--brand-primary)] hover:shadow-xs"
              >
                <button
                  type="button"
                  aria-label={preset.name}
                  className="h-24 w-full cursor-pointer relative focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand-primary)]"
                  style={{ backgroundImage: previewCss }}
                  onClick={() => handleLoadPreset(preset)}
                >
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/20 transition-opacity">
                    <span className="text-[length:var(--text-11)] font-semibold text-white bg-black/40 px-2 py-0.5 rounded-full">
                      {t('tools.color.gradient.apply')}
                    </span>
                  </div>
                </button>
                <div className="p-2 flex items-center justify-between">
                  <span className="truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
                    {preset.name}
                  </span>
                  <Tooltip label={t('tools.color.gradient.copy_css')}>
                    <IconButton
                      size="xs"
                      label={t('tools.color.gradient.copy_css')}
                      onClick={() => {
                        const code = `background: ${previewCss};`
                        navigator.clipboard.writeText(code)
                        useUi.getState().toast({
                          title: t('tools.color.toast.copied', {
                            label: preset.name,
                            value: code.slice(0, 30) + '...',
                          }),
                          tone: 'success',
                        })
                      }}
                    >
                      <Copy size={12} />
                    </IconButton>
                  </Tooltip>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
