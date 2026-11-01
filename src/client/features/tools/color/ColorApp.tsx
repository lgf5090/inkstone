import { lazy, Suspense, useEffect } from 'react'
import { LoadingBlock } from '../../../components/feedback'
import { useToolsStore } from '../store'
import { useColorStudioStore } from './store'
import { ColorStudioView } from './views/ColorStudioView'

/**
 * One chunk per view, because only one view is on screen.
 *
 * All ten used to be static imports, so opening the studio also parsed the four preset families, the
 * ColorHunt data, the two traditional-colour dictionaries and the image quantizer — 80 KB of source that
 * the first screen never touches. The studio stays eager because it is where the tool opens; a lazy studio
 * would show a spinner instead of a colour wheel.
 */
const ColorSpaceAlgorithmView = lazy(() => import('./views/ColorSpaceAlgorithmView').then((m) => ({ default: m.ColorSpaceAlgorithmView })))
const AiPaletteView = lazy(() => import('./views/AiPaletteView').then((m) => ({ default: m.AiPaletteView })))
const UiPaletteView = lazy(() => import('./views/UiPaletteView').then((m) => ({ default: m.UiPaletteView })))
const ImagePaletteView = lazy(() => import('./views/ImagePaletteView').then((m) => ({ default: m.ImagePaletteView })))
const TraditionalColorView = lazy(() => import('./views/TraditionalColorView').then((m) => ({ default: m.TraditionalColorView })))
const GradientStudioView = lazy(() => import('./views/GradientStudioView').then((m) => ({ default: m.GradientStudioView })))
const ColorHuntPalettesView = lazy(() => import('./views/ColorHuntPalettesView').then((m) => ({ default: m.ColorHuntPalettesView })))
const FavoritesView = lazy(() => import('./views/FavoritesView').then((m) => ({ default: m.FavoritesView })))
const ColorSettingsView = lazy(() => import('./views/ColorSettingsView').then((m) => ({ default: m.ColorSettingsView })))

// Global Modals
import { ContrastCheckerModal } from './components/modals/ContrastCheckerModal'
import { TokenScaleModal } from './components/modals/TokenScaleModal'
import { ColorBlindnessModal } from './components/modals/ColorBlindnessModal'
import { CreateCustomPaletteModal } from './components/modals/CreateCustomPaletteModal'
import { ExportPaletteModal } from './components/modals/ExportPaletteModal'

export function ColorApp() {
  const activeColorView = useToolsStore((s) => s.activeColorView)

  const fetchSettings = useColorStudioStore((s) => s.fetchSettings)
  const fetchFavorites = useColorStudioStore((s) => s.fetchFavorites)
  const fetchPalettes = useColorStudioStore((s) => s.fetchPalettes)
  const fetchHistory = useColorStudioStore((s) => s.fetchHistory)

  useEffect(() => {
    fetchSettings()
    fetchFavorites()
    fetchPalettes()
    fetchHistory()
  }, [fetchSettings, fetchFavorites, fetchPalettes, fetchHistory])

  const renderActiveView = () => {
    switch (activeColorView) {
      case 'studio':
        return <ColorStudioView />
      case 'algorithm':
        return <ColorSpaceAlgorithmView />
      case 'ai_palette':
        return <AiPaletteView />
      case 'ui_palettes':
        return <UiPaletteView />
      case 'image_palette':
        return <ImagePaletteView />
      case 'traditional':
        return <TraditionalColorView />
      case 'gradient':
        return <GradientStudioView />
      case 'color_hunt':
        return <ColorHuntPalettesView />
      case 'favorites':
        return <FavoritesView />
      case 'settings':
        return <ColorSettingsView />
      default:
        return <ColorStudioView />
    }
  }

  return (
    <div
      data-testid="color-app-root"
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      {/* Active Sub-view */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Suspense fallback={<LoadingBlock />}>{renderActiveView()}</Suspense>
      </div>

      {/* Global Modals */}
      <ContrastCheckerModal />
      <TokenScaleModal />
      <ColorBlindnessModal />
      <CreateCustomPaletteModal />
      <ExportPaletteModal />
    </div>
  )
}
