import {
  Copy,
  Download,
  Eye,
  Heart,
  Layers,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { hslToRgb, rgbToHex } from '@shared/tools/color/spaces'
import { t } from '../../../../lib/i18n'
import { Button, IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { Tooltip } from '../../../../components/overlay'
import { ColorWheel } from '../components/ColorWheel'
import { ColorSlider } from '../components/ColorSlider'
import { EyedropperButton } from '../components/EyedropperButton'
import { HarmoniesPanel } from '../components/HarmoniesPanel'
import { ColorSpaceDisplay } from '../components/ColorSpaceDisplay'
import { useColorStudioStore } from '../store'

export function ColorStudioView() {
  const currentHex = useColorStudioStore((s) => s.currentHex)
  const colorSpaceValues = useColorStudioStore((s) => s.colorSpaceValues)
  const setCurrentColor = useColorStudioStore((s) => s.setCurrentColor)
  const copyColor = useColorStudioStore((s) => s.copyColor)
  const addFavorite = useColorStudioStore((s) => s.addFavorite)
  const openContrastModal = useColorStudioStore((s) => s.openContrastModal)
  const openTokenScaleModal = useColorStudioStore((s) => s.openTokenScaleModal)
  const openColorBlindnessModal = useColorStudioStore((s) => s.openColorBlindnessModal)
  const openExportPaletteModal = useColorStudioStore((s) => s.openExportPaletteModal)

  const { h, s, l } = colorSpaceValues.hsl

  const handleWheelChange = (newHue: number, newSat: number) => {
    const rgb = hslToRgb({ h: newHue, s: newSat, l })
    setCurrentColor(rgbToHex(rgb, true), 'picker')
  }

  const handleHueChange = (newHue: number) => {
    const rgb = hslToRgb({ h: newHue, s, l })
    setCurrentColor(rgbToHex(rgb, true), 'picker')
  }

  const handleSatChange = (newSat: number) => {
    const rgb = hslToRgb({ h, s: newSat, l })
    setCurrentColor(rgbToHex(rgb, true), 'picker')
  }

  const handleLightnessChange = (newLightness: number) => {
    const rgb = hslToRgb({ h, s, l: newLightness })
    setCurrentColor(rgbToHex(rgb, true), 'picker')
  }

  const handleRandomColor = () => {
    const randomHex =
      '#' +
      Math.floor(Math.random() * 16777215)
        .toString(16)
        .padStart(6, '0')
    setCurrentColor(randomHex, 'random')
  }

  const handleHexInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = e.target.value.trim()
    if (!val.startsWith('#')) val = '#' + val
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      setCurrentColor(val, 'input')
    }
  }

  // Slider gradients
  const hueGradient =
    'linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)'
  const satGradient = `linear-gradient(to right, hsl(${h}, 0%, ${l}%), hsl(${h}, 100%, ${l}%))`
  const lightGradient = `linear-gradient(to right, #000000 0%, hsl(${h}, ${s}%, 50%) 50%, #ffffff 100%)`

  return (
    <div className="flex flex-col gap-6 w-full max-w-5xl mx-auto p-4 md:p-6 overflow-y-auto">
      {/* Studio Header Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
        <div>
          <h2 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
            {t('tools.color.nav.studio')}
          </h2>
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)] mt-0.5">
            {t('tools.color.studio.seed_color')} {'· '} {t('tools.color.studio.subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <EyedropperButton onPick={(hex) => setCurrentColor(hex, 'picker')} />
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRandomColor}
            aria-label={t('tools.color.studio.random_color')}
          >
            <Sparkles size={14} />
            <span>{t('tools.color.studio.random_color')}</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={openContrastModal}
            aria-label={t('tools.color.contrast.title')}
          >
            <ShieldCheck size={14} />
            <span>{t('tools.color.contrast.ratio')}</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={openTokenScaleModal}
            aria-label={t('tools.color.token.title')}
          >
            <Layers size={14} />
            <span>{t('tools.color.studio.token_scale_btn')}</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={openColorBlindnessModal}
            aria-label={t('tools.color.blindness.title')}
          >
            <Eye size={14} />
            <span>{t('tools.color.studio.cvd_btn')}</span>
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              openExportPaletteModal({
                title: `Palette ${currentHex}`,
                colors: [currentHex],
              })
            }
            aria-label={t('tools.color.export.title')}
          >
            <Download size={14} />
            <span>{t('tools.color.studio.export')}</span>
          </Button>
        </div>
      </div>

      {/* Main Color Picker Card */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6 p-4 md:p-6 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] shadow-sm">
        {/* Left: 360 Color Wheel */}
        <div className="md:col-span-5 flex flex-col items-center justify-center p-2">
          <ColorWheel
            hue={h}
            saturation={s}
            lightness={l}
            size={220}
            onChange={handleWheelChange}
          />
        </div>

        {/* Right: Sliders & Seed Preview */}
        <div className="md:col-span-7 flex flex-col justify-between gap-4">
          {/* Color Preview & Hex Input Box */}
          <div className="flex items-center gap-3 p-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
            <div
              style={{ backgroundColor: currentHex }}
              className="w-14 h-14 rounded-[var(--r-md)] border border-[var(--border-subtle)] shadow-inner shrink-0 transition-colors"
            />
            <div className="flex-1 min-w-0">
              <label className="block text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
                {t('tools.color.studio.seed_color')}
              </label>
              <div className="flex items-center gap-2 mt-1">
                <Input
                  defaultValue={currentHex.toUpperCase()}
                  key={currentHex}
                  onChange={handleHexInputChange}
                  className="w-28 font-mono text-[length:var(--text-14)] font-semibold uppercase h-8"
                  maxLength={7}
                  aria-label={t('tools.color.studio.hex_input_label')}
                />
                <Tooltip label={t('tools.color.studio.copy_all')}>
                  <IconButton
                    label={t('tools.color.studio.copy_all')}
                    size="sm"
                    onClick={() => copyColor(currentHex, 'HEX')}
                  >
                    <Copy size={13} />
                  </IconButton>
                </Tooltip>
                <Tooltip label={t('tools.color.studio.favorite')}>
                  <IconButton
                    label={t('tools.color.studio.favorite')}
                    size="sm"
                    onClick={() => addFavorite(currentHex)}
                  >
                    <Heart size={13} />
                  </IconButton>
                </Tooltip>
              </div>
            </div>
          </div>

          {/* HSL Range Sliders */}
          <div className="flex flex-col gap-3">
            <ColorSlider
              label={t('tools.color.studio.hue')}
              value={h}
              min={0}
              max={360}
              unit="°"
              gradient={hueGradient}
              onChange={handleHueChange}
            />
            <ColorSlider
              label={t('tools.color.studio.saturation')}
              value={s}
              min={0}
              max={100}
              unit="%"
              gradient={satGradient}
              onChange={handleSatChange}
            />
            <ColorSlider
              label={t('tools.color.studio.lightness')}
              value={l}
              min={0}
              max={100}
              unit="%"
              gradient={lightGradient}
              onChange={handleLightnessChange}
            />
          </div>
        </div>
      </div>

      {/* Color Space Display */}
      <ColorSpaceDisplay spaces={colorSpaceValues} />

      {/* Harmonies Panel */}
      <HarmoniesPanel currentHex={currentHex} />
    </div>
  )
}
