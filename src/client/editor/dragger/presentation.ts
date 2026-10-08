import type { EditorSettings } from '@shared/types'

/** The class, attribute and custom-property names the dragger's stylesheet reads. */
export const DRAGGER_ROOT_CLASS = 'ink-dragger'
export const DRAGGER_EDITOR_CLASS = 'ink-dragger-editor'
export const DRAGGER_DRAGGING_CLASS = 'ink-dragger-dragging'
export const DRAGGER_GESTURE_LOCK_CLASS = 'ink-dragger-gesture-lock'

export type DraggerPresentation = {
  classes: Record<string, boolean>
  attributes: Record<string, string>
  /** An empty value leaves the property unset so the stylesheet's own fallback wins. */
  cssProps: Record<string, string>
}

/**
 * What the reader's dragger settings mean for the document: which handle is drawn, where, in which
 * colour, and how a block that is being carried is painted.
 *
 * Everything is a class, an attribute, or a custom property on one element, so the editor never
 * rebuilds to answer a colour change and the stylesheet keeps the only say over pixels.
 */
export function draggerPresentation(
  settings: EditorSettings,
  state: { dragModeEnabled: boolean },
): DraggerPresentation {
  const side = settings.draggerHandleSide
  const color = settings.draggerHandleColorMode === 'custom' ? settings.draggerHandleColor : 'var(--accent)'
  const size = settings.draggerHandleSize
  return {
    classes: {
      [`${DRAGGER_ROOT_CLASS}-on`]: settings.dragger,
      [`${DRAGGER_ROOT_CLASS}-handles-always`]: settings.draggerHandles === 'always',
      [`${DRAGGER_ROOT_CLASS}-handles-hidden`]: settings.draggerHandles === 'hidden',
      [`${DRAGGER_ROOT_CLASS}-drag-mode`]: state.dragModeEnabled,
    },
    attributes: {
      'data-ink-dragger-icon': settings.draggerHandleIcon,
      'data-ink-dragger-style': settings.draggerSelectionStyle,
      'data-ink-dragger-highlight': settings.draggerHighlight ? 'on' : 'off',
      'data-ink-dragger-side': side,
    },
    cssProps: {
      '--ink-dragger-handle-size': `${size}px`,
      '--ink-dragger-handle-core-size': `${Math.max(4, Math.round(size * 0.55))}px`,
      '--ink-dragger-grip-dots-size': `${Math.max(1.2, Math.round(size * 0.075 * 10) / 10)}px`,
      '--ink-dragger-handle-color': color,
      '--ink-dragger-handle-glyph': quoteForCss(settings.draggerHandleGlyph),
      '--ink-dragger-seam-color': settings.draggerIndicatorColorMode === 'custom'
        ? settings.draggerIndicatorColor
        : '',
    },
  }
}

/** A `content:` value has to arrive as a quoted string, and its own quotes have to survive. */
export function quoteForCss(value: string): string {
  return JSON.stringify(value)
}

export function applyDraggerPresentation(root: HTMLElement, presentation: DraggerPresentation): void {
  for (const [name, on] of Object.entries(presentation.classes)) root.classList.toggle(name, on)
  for (const [name, value] of Object.entries(presentation.attributes)) root.setAttribute(name, value)
  for (const [name, value] of Object.entries(presentation.cssProps)) {
    if (value === '') root.style.removeProperty(name)
    else root.style.setProperty(name, value)
  }
}

/** Used when the feature is switched off for good: nothing the stylesheet can still see. */
export function clearDraggerPresentation(root: HTMLElement, presentation: DraggerPresentation): void {
  for (const name of Object.keys(presentation.classes)) root.classList.remove(name)
  for (const name of Object.keys(presentation.attributes)) root.removeAttribute(name)
  for (const name of Object.keys(presentation.cssProps)) root.style.removeProperty(name)
}
