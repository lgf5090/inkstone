import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { useToolsStore, type ColorNavView } from './store'
import type { ColorStudioState } from './color/store'
import { canPickFromScreen, pickColorFromScreen } from './color/lib/screen-pick'
import { useUi } from '../../store/ui'
import { appTab } from '../shell/app-tabs'

/**
 * The colour tool, asked for from outside it.
 *
 * Its ten views, the screen picker, the copy and the token scale were reachable only by clicking the tool's
 * sidebar, which left a keyboard-only reader — and any automation that runs commands — outside the module.
 * These call the same store actions the buttons do, from wherever the palette was opened.
 */

/**
 * The command id each view is reachable by.
 *
 * Keyed by the view type itself, so a view added to the sidebar without a command here stops compiling
 * rather than joining the tool as another mouse-only screen.
 */
export const COLOR_VIEW_COMMANDS: Record<ColorNavView, string> = {
  studio: 'cmd-color-studio',
  algorithm: 'cmd-color-algorithm',
  ai_palette: 'cmd-color-ai',
  ui_palettes: 'cmd-color-ui',
  image_palette: 'cmd-color-image',
  traditional: 'cmd-color-traditional',
  gradient: 'cmd-color-gradient',
  color_hunt: 'cmd-color-hunt',
  favorites: 'cmd-color-favorites',
  settings: 'cmd-color-settings',
}

/** The views in the order the palette lists them, with the id that opens each one. */
export function colorViewCommands(): Array<{ view: ColorNavView; id: string }> {
  return (Object.keys(COLOR_VIEW_COMMANDS) as ColorNavView[]).map((view) => ({ view, id: COLOR_VIEW_COMMANDS[view] }))
}

export function colorViewLabel(view: ColorNavView): string {
  return t(`tools.color.nav.${view}`)
}

/** Show this view of the colour tool, from any screen. */
export function openColorView(view: ColorNavView): void {
  const tools = useToolsStore.getState()
  tools.setActiveSubmodule('color')
  tools.setActiveColorView(view)
  navigateToPath(appTab('tools').path)
}

/**
 * The studio's own state, reached without importing it into this chunk.
 *
 * The colour tool is a lazy chunk and the command list is not: a static import here would put every preset
 * family and colour dictionary back into what the notebook loads before it has shown anything. The type is
 * erased at build time, so it costs nothing to keep the actions checked against the real store.
 */
async function withStudio(run: (studio: ColorStudioState) => void): Promise<void> {
  const { useColorStudioStore } = await import('./color/store')
  run(useColorStudioStore.getState())
}

/** Put the current seed colour on the clipboard in the format the reader's settings name. */
export async function copySeedColor(): Promise<void> {
  await withStudio((studio) => {
    void studio.copyColor(studio.currentHex)
  })
}

/** Open the 50–950 scale built from the current seed colour. */
export async function openSeedTokenScale(): Promise<void> {
  openColorView('studio')
  await withStudio((studio) => studio.openTokenScaleModal())
}

/**
 * Take the colour under the cursor and make it the studio's seed.
 *
 * `EyeDropper` is Chromium-only, so elsewhere the command says so — the same sentence the studio shows on
 * its disabled button — rather than looking like a command that does nothing.
 */
export async function pickSeedFromScreen(): Promise<void> {
  if (!canPickFromScreen()) {
    useUi.getState().toast({ title: t('tools.color.studio.eyedropper_unsupported'), tone: 'warning' })
    return
  }
  const hex = await pickColorFromScreen()
  if (!hex) return
  openColorView('studio')
  await withStudio((studio) => studio.setCurrentHex(hex, 'eyedropper'))
}
