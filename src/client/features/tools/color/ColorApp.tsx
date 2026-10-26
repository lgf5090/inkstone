import { useEffect } from 'react'
import { useToolsStore } from '../store'
import { useColorStudioStore } from './store'
import { ColorStudioView } from './views/ColorStudioView'
import { ColorSpaceAlgorithmView } from './views/ColorSpaceAlgorithmView'
import { AiPaletteView } from './views/AiPaletteView'
import { UiPaletteView } from './views/UiPaletteView'
import { ImagePaletteView } from './views/ImagePaletteView'
import { TraditionalColorView } from './views/TraditionalColorView'
import { GradientStudioView } from './views/GradientStudioView'
import { ColorHuntPalettesView } from './views/ColorHuntPalettesView'
import { FavoritesView } from './views/FavoritesView'

// Global Modals
import { ContrastCheckerModal } from './components/modals/ContrastCheckerModal'
import { TokenScaleModal } from './components/modals/TokenScaleModal'
import { RealtimeColorsModal } from './components/modals/RealtimeColorsModal'
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
        {renderActiveView()}
      </div>

      {/* Global Modals */}
      <ContrastCheckerModal />
      <TokenScaleModal />
      <RealtimeColorsModal />
      <ColorBlindnessModal />
      <CreateCustomPaletteModal />
      <ExportPaletteModal />
    </div>
  )
}
