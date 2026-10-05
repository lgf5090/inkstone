import { useCallback, useState, type RefObject } from 'react'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import type { GraphPreferences } from '../../../lib/graph-settings'
import { runGraphExport, type GraphExportKind } from './graph-export'
import type { CanvasState, Palette } from './types'

export interface GraphExportActions {
  isExporting: boolean
  exportPng: () => void
  exportSvg: () => void
}

export function useGraphExport(
  stateRef: RefObject<CanvasState>,
  prefs: GraphPreferences,
  colors: () => Palette,
): GraphExportActions {
  const toast = useUi((state) => state.toast)
  const [isExporting, setIsExporting] = useState(false)
  const run = useCallback(async (kind: GraphExportKind) => {
    if (!stateRef.current.nodes.length) return
    setIsExporting(true)
    try {
      await runGraphExport(stateRef.current, colors(), prefs, kind)
      toast({ title: t('graph.export_done'), tone: 'success' })
    } catch (error) {
      toast({
        title: t('graph.export_failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setIsExporting(false)
    }
  }, [colors, prefs, stateRef, toast])
  return {
    isExporting,
    exportPng: useCallback(() => { void run('png') }, [run]),
    exportSvg: useCallback(() => { void run('svg') }, [run]),
  }
}
