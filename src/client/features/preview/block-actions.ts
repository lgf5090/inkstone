import { chartToolbar } from './chart-block-toolbar'
import { codeBlockToolbar } from './code-block-toolbar'
import { exampleToolbar } from './example-layout'
import { mediaLayoutToolbar } from './media-layout'
import { mindmapToolbar } from './mindmap-block-toolbar'
import { panelBlockToolbar } from './panel-toolbar'
import { tabsBlockToolbar } from './tabs-toolbar'
import { enhanceJsExampleControlsInRoot, handleJsExampleRun, handleJsExampleSwitch } from './js-runner'
import type { BlockActionContext, BlockToolbarModule, BlockToolbarOptions } from './block-overlay'

/**
 * The preview's entry point for the block settings toolbars and the runnable JavaScript block: one
 * enhancer and one click route, so a block family costs no new branch in the preview's handlers.
 *
 * The runnable block's controls come from `enhanceJsExampleControlsInRoot`, which only this surface
 * calls — a share page draws the same block with no run button.
 */
const MODULES: BlockToolbarModule[] = [exampleToolbar, codeBlockToolbar, chartToolbar, mindmapToolbar, panelBlockToolbar, tabsBlockToolbar, mediaLayoutToolbar]

export function enhanceBlockToolbars(root: HTMLElement, options: BlockToolbarOptions): void {
  enhanceJsExampleControlsInRoot(root)
  MODULES.forEach((module) => module.enhance(root, options))
}

export function handleBlockToolbarClick(event: { preventDefault: () => void }, target: HTMLElement, ctx: BlockActionContext): boolean {
  MODULES.forEach((module) => module.dismiss(target))
  if (MODULES.some((module) => module.handle(event, target, ctx))) return true

  const jsSwitch = target.closest<HTMLButtonElement>('[data-js-switch]')
  if (jsSwitch) {
    event.preventDefault()
    handleJsExampleSwitch(jsSwitch)
    return true
  }
  const jsRun = target.closest<HTMLButtonElement>('[data-js-run]')
  if (jsRun) {
    event.preventDefault()
    handleJsExampleRun(jsRun, ctx.committedSourceRef.current, ctx.api.toast)
    return true
  }
  return false
}

export function closeBlockToolbarOverlay(target: HTMLElement): HTMLButtonElement | null {
  for (const module of MODULES) {
    const trigger = module.close(target)
    if (trigger) return trigger
  }
  return null
}
