import { vi } from 'vitest'
import type { PresentationMenuItemsOptions } from './presentation-context-menu'

/** The rows' whole input, with every toggle off and no link under the pointer. Three test files build
 * menus — the menu itself, the narrow-screen door that carries its rows, and the key card that names
 * the same keystrokes — and a field one of them forgot is a menu that reads differently in one of the
 * three, which is the divergence all three are written to rule out. */
export function menuOptions(overrides: Partial<PresentationMenuItemsOptions> = {}): PresentationMenuItemsOptions {
  return {
    linkUrl: null,
    slideIndex: 1,
    slideCount: 5,
    subPage: 0,
    pageCount: 1,
    step: 0,
    steps: 0,
    railOpen: false,
    overview: false,
    following: false,
    followLost: false,
    isFullscreen: false,
    laser: false,
    spotlight: false,
    screenCover: null,
    keyGuide: false,
    audienceFollowing: false,
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onToggleRail: vi.fn(),
    onToggleOverview: vi.fn(),
    onToggleFollowing: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onToggleKeyGuide: vi.fn(),
    onToggleAudience: vi.fn(),
    onOpenPresenter: vi.fn(),
    onToggleLaser: vi.fn(),
    onToggleSpotlight: vi.fn(),
    onToggleBlackout: vi.fn(),
    onToggleWhiteout: vi.fn(),
    onExit: vi.fn(),
    ...overrides,
  }
}
