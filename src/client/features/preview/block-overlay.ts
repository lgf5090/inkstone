import { t } from '../../lib/i18n'

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
  const panelSelectors = Object.values(spec.panels).join(',')
  scope.querySelectorAll<HTMLElement>(spec.block).forEach((block) => {
    if (!openBlockOverlay(spec, block)) return
    const inside = target.closest(spec.block) === block
      && Boolean(panelSelectors) && Boolean(target.closest(panelSelectors))
    if (!inside) setBlockOverlay(spec, block, null)
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

export interface BlockToolbarModule {
  enhance: (root: HTMLElement) => void
  dismiss: (target: HTMLElement) => void
  close: (target: HTMLElement) => HTMLButtonElement | null
  handle: (event: { preventDefault: () => void }, target: HTMLElement, ctx: BlockActionContext) => boolean
}
