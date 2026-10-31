// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync('src/client/features/tools/color/ColorApp.tsx', 'utf8')

const VIEWS = [
  'ColorSpaceAlgorithmView',
  'AiPaletteView',
  'UiPaletteView',
  'ImagePaletteView',
  'TraditionalColorView',
  'GradientStudioView',
  'ColorHuntPalettesView',
  'FavoritesView',
  'ColorSettingsView',
]

/**
 * The colour tool stays one chunk per screen.
 *
 * Bundle shape is invisible to every other assertion in this suite: a single re-added static import puts
 * the preset families and the image quantizer back into the chunk that opens with the studio, and all the
 * behaviour tests stay green while the first paint doubles in bytes.
 */
describe('colour view code splitting', () => {
  it.each(VIEWS)('loads %s through a dynamic import only', (view) => {
    expect(SOURCE).toContain(`lazy(() => import('./views/${view}')`)
    expect(SOURCE).not.toMatch(new RegExp(`^import \\{ ${view} \\} from`, 'm'))
  })

  it('keeps the landing view eager so the studio does not open on a spinner', () => {
    expect(SOURCE).toMatch(/^import \{ ColorStudioView \} from '.\/views\/ColorStudioView'$/m)
  })

  it('wraps the outlet in a Suspense boundary', () => {
    expect(SOURCE).toContain('<Suspense fallback={<LoadingBlock />}>')
  })
})
