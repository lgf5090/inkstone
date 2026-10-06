import { t } from '../../lib/i18n'
import type { TabScope } from './markdown-tabs'

export type BlockToast = (opts: { title: string; tone?: 'default' | 'success' | 'warning' | 'danger' }) => void

export interface BlockOverlaySpec {
  block: string
  panels: Record<string, string>
  triggers: Record<string, string>
  openClasses: Record<string, string>
  onOpen?: (block: HTMLElement, overlay: string | null) => void
  /**
   * Builds a panel the first time it is asked for. A note can hold hundreds of code blocks and the
   * preview is rebuilt on every typing pause, so the panel a reader never opens must cost nothing.
   */
  materialize?: (block: HTMLElement) => void
}

function select(block: HTMLElement, selector: string | undefined): HTMLElement | null {
  return selector ? block.querySelector<HTMLElement>(selector) : null
}

export function openBlockOverlay(spec: BlockOverlaySpec, block: HTMLElement): string | null {
  return Object.keys(spec.panels).find((name) => {
    const openClass = spec.openClasses[name]
    return Boolean(openClass) && block.classList.contains(openClass)
  }) ?? null
}

export function setBlockOverlay(spec: BlockOverlaySpec, block: HTMLElement, overlay: string | null): void {
  if (overlay !== null) spec.materialize?.(block)
  for (const name of Object.keys(spec.panels)) {
    const open = name === overlay
    const panel = select(block, spec.panels[name])
    if (panel) panel.toggleAttribute('hidden', !open)
    const trigger = select(block, spec.triggers[name])
    if (trigger) trigger.setAttribute('aria-expanded', String(open))
    const openClass = spec.openClasses[name]
    if (openClass) block.classList.toggle(openClass, open)
  }
  spec.onOpen?.(block, overlay)
}

export function toggleBlockOverlay(spec: BlockOverlaySpec, block: HTMLElement, overlay: string): void {
  setBlockOverlay(spec, block, openBlockOverlay(spec, block) === overlay ? null : overlay)
}

export function dismissBlockOverlays(spec: BlockOverlaySpec, target: HTMLElement): void {
  const scope = target.closest<HTMLElement>('.ink-prose')
  if (!scope) return
  const own = [...Object.values(spec.panels), ...Object.values(spec.triggers)].join(',')
  scope.querySelectorAll<HTMLElement>(spec.block).forEach((block) => {
    if (!openBlockOverlay(spec, block)) return
    // A press on the block's own trigger is left for `handle` to act on: closing it here would let the
    // toggle find the overlay shut and open it again, so the button that ought to shut a panel would
    // appear to do nothing at all.
    const leftToHandle = target.closest(spec.block) === block && Boolean(own) && Boolean(target.closest(own))
    if (!leftToHandle) setBlockOverlay(spec, block, null)
  })
}

export function closeBlockOverlayFromEvent(spec: BlockOverlaySpec, target: HTMLElement): HTMLButtonElement | null {
  const block = target.closest<HTMLElement>(spec.block)
  if (!block) return null
  const overlay = openBlockOverlay(spec, block)
  if (!overlay) return null
  setBlockOverlay(spec, block, null)
  return (select(block, spec.triggers[overlay]) as HTMLButtonElement | null) ?? null
}

export interface BlockActionContext {
  content: string
  sourceNoteId: string | null
  committedSourceRef: { current: string }
  api: { editContent: (noteId: string, next: string) => void; toast: BlockToast }
}

/**
 * The shared prologue of a toolbar action: the note to edit and the committed text to edit it
 * against, or null when there is nothing to write. Writing while the preview still shows an older
 * document would move the fence the block was drawn from, and the patch would land somewhere else.
 */
export function blockActionSource(ctx: BlockActionContext): { noteId: string; source: string } | null {
  const noteId = ctx.sourceNoteId
  if (!noteId) return null
  if (ctx.content !== ctx.committedSourceRef.current) {
    ctx.api.toast({ title: t('preview.the_preview_is_updating_try_again_in_a_moment'), tone: 'warning' })
    return null
  }
  return { noteId, source: ctx.committedSourceRef.current }
}

/**
 * The account settings that change what a block's toolbar is allowed to offer. A module reads them from
 * here instead of from a caller that knows them, because the preview hands every family the same pass
 * and only the surface holding the note knows which blocks are actually drawn.
 */
export interface BlockToolbarOptions {
  chart: boolean
  /**
   * Whose note the surface is drawing, for the families that remember a choice between visits. A
   * surface that cannot say — a share page, an embed — leaves it out and the choice stays in the page.
   */
  tabScope?: TabScope
}

export interface BlockToolbarModule {
  enhance: (root: HTMLElement, options: BlockToolbarOptions) => void
  dismiss: (target: HTMLElement) => void
  close: (target: HTMLElement) => HTMLButtonElement | null
  handle: (event: { preventDefault: () => void }, target: HTMLElement, ctx: BlockActionContext) => boolean
}
