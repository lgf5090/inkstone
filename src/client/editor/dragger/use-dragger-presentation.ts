import { useEffect } from 'react'
import type { EditorSettings } from '@shared/types'
import { draggerPresentation, applyDraggerPresentation, clearDraggerPresentation } from './presentation'

/**
 * Puts the reader's dragger settings where the stylesheet can read them: one element, the document
 * root, which every editor and the settings panel's own sample both inherit from.
 *
 * The whole presentation is classes, attributes and custom properties, so a colour or a size change
 * repaints without touching an editor.
 */
export function useDraggerPresentation(settings: EditorSettings, dragMode: boolean): void {
  useEffect(() => {
    const root = document.documentElement
    const presentation = draggerPresentation(settings, { dragModeEnabled: dragMode })
    applyDraggerPresentation(root, presentation)
    return () => clearDraggerPresentation(root, presentation)
  }, [settings, dragMode])
}
