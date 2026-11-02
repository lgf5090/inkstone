import { useCallback, useMemo, useRef, useState } from 'react'
import { CloudUpload, Copy, Crosshair, Download, RotateCcw, Settings, ZoomIn, ZoomOut } from 'lucide-react'
import { parseGraphExpression } from '@shared/tools/calculator/graphing/parser'
import { analyzeFunction } from '@shared/tools/calculator/graphing/analyze'
import type { GraphAnalysisResult, GraphEquation, GraphVariable, TrigMode } from '@shared/tools/calculator/types'
import { useBreakpoint, useMediaQuery } from '../../../../lib/hooks'
import { IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { calculatorApi } from '../api'
import { useCalculatorStore } from '../store'
import { calcT } from '../lib/calc-i18n'
import { copyToClipboard } from '../lib/clipboard'
import { GraphCanvas } from '../graph/GraphCanvas'
import { EquationList } from '../graph/EquationList'
import { VariablePanel } from '../graph/VariablePanel'
import { KeyFeaturesPanel } from '../graph/KeyFeaturesPanel'
import { GraphSettings } from '../graph/GraphSettings'

export function GraphView() {
  const graph = useCalculatorStore((state) => state.graph)
  const settings = useCalculatorStore((state) => state.settings)
  const updateGraph = useCalculatorStore((state) => state.updateGraph)
  const addEquation = useCalculatorStore((state) => state.addEquation)
  const updateEquation = useCalculatorStore((state) => state.updateEquation)
  const removeEquation = useCalculatorStore((state) => state.removeEquation)
  const updateSettings = useCalculatorStore((state) => state.updateSettings)
  const breakpoint = useBreakpoint()
  const shortLandscape = useMediaQuery('(max-height: 520px) and (min-width: 720px)')
  const sideBySide = breakpoint === 'desktop' || shortLandscape
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [tracing, setTracing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [featuresOpen, setFeaturesOpen] = useState(false)
  const [analysis, setAnalysis] = useState<GraphAnalysisResult | null>(null)
  const [analysisExpression, setAnalysisExpression] = useState('')
  const [trigMode, setTrigMode] = useState<TrigMode>('rad')

  const parsed = useMemo(
    () => graph.equations.map((equation) => ({ equation, result: parseGraphExpression(equation.expression) })),
    [graph.equations],
  )
  const errors = useMemo(() => {
    const map: Record<string, string> = {}
    for (const entry of parsed) {
      if (!entry.result.ok && entry.equation.expression.trim()) map[entry.equation.id] = `${calcT('tools.calculator.graph.equation_error')} ${entry.result.message}`
    }
    return map
  }, [parsed])
  const plots = useMemo(
    () => parsed
      .filter((entry): entry is typeof entry & { result: Extract<typeof entry.result, { ok: true }> } => entry.result.ok && entry.equation.isEnabled && entry.equation.expression.trim().length > 0)
      .map((entry) => ({ equation: entry.equation, node: entry.result.node })),
    [parsed],
  )

  const detectedVariables = useMemo(() => {
    const names = new Set<string>()
    for (const entry of parsed) {
      if (!entry.result.ok) continue
      for (const name of entry.result.variables) if (name !== 'x' && name !== 'y') names.add(name)
    }
    return [...names].sort()
  }, [parsed])

  const variables: GraphVariable[] = useMemo(
    () => detectedVariables.map((name) => graph.variables.find((variable) => variable.name === name) ?? {
      name,
      value: 1,
      min: -10,
      max: 10,
      step: 0.1,
    }),
    [detectedVariables, graph.variables],
  )
  const variableValues = useMemo(
    () => Object.fromEntries(variables.map((variable) => [variable.name, variable.value])),
    [variables],
  )

  const updateVariables = (name: string, patch: Partial<GraphVariable>) => {
    const next = variables.map((variable) => variable.name === name ? { ...variable, ...patch } : variable)
    updateGraph({ variables: next })
  }

  const zoom = (factor: number) => {
    const viewport = graph.viewport
    const centerX = (viewport.xMin + viewport.xMax) / 2
    const centerY = (viewport.yMin + viewport.yMax) / 2
    const halfX = ((viewport.xMax - viewport.xMin) / 2) * factor
    const halfY = ((viewport.yMax - viewport.yMin) / 2) * factor
    updateGraph({ viewport: { xMin: centerX - halfX, xMax: centerX + halfX, yMin: centerY - halfY, yMax: centerY + halfY } })
  }

  const analyze = (equation: GraphEquation) => {
    const result = parseGraphExpression(equation.expression)
    setAnalysisExpression(equation.expression)
    if (!result.ok) {
      setAnalysis({ error: 'could_not_analyze', features: [] })
      setFeaturesOpen(true)
      return
    }
    const target = result.relation && result.relation.left.kind === 'variable' && result.relation.left.name === 'y'
      ? result.relation.right
      : result.node
    setAnalysis(analyzeFunction(target, graph.viewport, variableValues, trigMode))
    setFeaturesOpen(true)
  }

  const onReady = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas
  }, [])

  const downloadPng = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'calculator-graph.png'
      anchor.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  const uploadPng = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (!blob) return
      const reader = new FileReader()
      reader.onload = () => {
        const dataBase64 = String(reader.result ?? '')
        void calculatorApi.uploadAsset({ kind: 'graph_png', fileFormat: 'png', dataBase64, metadata: { viewport: graph.viewport } })
          .then(() => useUi.getState().toast({ title: calcT('tools.calculator.common.save'), tone: 'success' }))
          .catch((error: unknown) => useUi.getState().toast({ title: error instanceof Error ? error.message : calcT('tools.calculator.sync_failed'), tone: 'danger' }))
      }
      reader.readAsDataURL(blob)
    }, 'image/png')
  }

  const copyEquations = () => {
    const text = graph.equations.map((equation) => equation.expression).filter(Boolean).join('\n')
    void copyToClipboard(text).then((ok) => {
      if (!ok) useUi.getState().toast({ title: calcT('tools.calculator.error.invalid_input'), tone: 'danger' })
    })
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex h-11 shrink-0 items-center justify-end gap-0.5 border-b border-[var(--border-subtle)] px-2">
        <Tooltip label={calcT(tracing ? 'tools.calculator.graph.trace_off' : 'tools.calculator.graph.trace_on')}>
          <IconButton label={calcT('tools.calculator.graph.trace')} size="sm" active={tracing} onClick={() => setTracing((value) => !value)}>
            <Crosshair size={14} />
          </IconButton>
        </Tooltip>
        <Tooltip label={calcT('tools.calculator.graph.zoom_in')}>
          <IconButton label={calcT('tools.calculator.graph.zoom_in')} size="sm" onClick={() => zoom(0.8)}><ZoomIn size={14} /></IconButton>
        </Tooltip>
        <Tooltip label={calcT('tools.calculator.graph.zoom_out')}>
          <IconButton label={calcT('tools.calculator.graph.zoom_out')} size="sm" onClick={() => zoom(1.25)}><ZoomOut size={14} /></IconButton>
        </Tooltip>
        <Tooltip label={calcT('tools.calculator.graph.reset_view')}>
          <IconButton label={calcT('tools.calculator.graph.reset_view')} size="sm" onClick={() => updateGraph({ viewport: { xMin: settings.graphXMin, xMax: settings.graphXMax, yMin: settings.graphYMin, yMax: settings.graphYMax } })}><RotateCcw size={14} /></IconButton>
        </Tooltip>
        <Tooltip label={calcT('tools.calculator.graph.settings')}>
          <IconButton label={calcT('tools.calculator.graph.settings')} size="sm" onClick={() => setSettingsOpen(true)}><Settings size={14} /></IconButton>
        </Tooltip>
        <Tooltip label={calcT('tools.calculator.graph.export_png')}>
          <IconButton label={calcT('tools.calculator.graph.export_png')} size="sm" onClick={downloadPng}><Download size={14} /></IconButton>
        </Tooltip>
        <Tooltip label={calcT('tools.calculator.graph.save_cloud')}>
          <IconButton label={calcT('tools.calculator.graph.save_cloud')} size="sm" onClick={uploadPng}><CloudUpload size={14} /></IconButton>
        </Tooltip>
        <Tooltip label={calcT('tools.calculator.graph.copy_equations')}>
          <IconButton label={calcT('tools.calculator.graph.copy_equations')} size="sm" onClick={copyEquations}><Copy size={14} /></IconButton>
        </Tooltip>
      </div>
      <div className={sideBySide ? 'flex min-h-0 flex-1' : 'flex min-h-0 flex-1 flex-col'}>
        <div className="min-h-0 min-w-0 flex-1 p-2">
          <GraphCanvas
            plots={plots}
            viewport={graph.viewport}
            variables={variableValues}
            trigMode={trigMode}
            lineWidth={settings.graphLineWidth}
            theme={settings.graphTheme}
            tracing={tracing}
            onViewportChange={(viewport) => updateGraph({ viewport })}
            onToggleTracing={() => setTracing((value) => !value)}
            onReady={onReady}
          />
        </div>
        <aside className={sideBySide ? 'w-[380px] shrink-0 border-l border-[var(--border-subtle)]' : 'h-[42%] min-h-[180px] shrink-0 border-t border-[var(--border-subtle)]'}>
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <EquationList
                equations={graph.equations}
                errors={errors}
                onAdd={addEquation}
                onUpdate={updateEquation}
                onRemove={removeEquation}
                onAnalyze={analyze}
              />
            </div>
            <div className="shrink-0 border-t border-[var(--border-subtle)] p-2">
              <VariablePanel variables={variables} onChange={updateVariables} />
            </div>
          </div>
        </aside>
      </div>
      <KeyFeaturesPanel open={featuresOpen} expression={analysisExpression} result={analysis} onClose={() => setFeaturesOpen(false)} />
      <GraphSettings
        open={settingsOpen}
        viewport={graph.viewport}
        trigMode={trigMode}
        lineWidth={settings.graphLineWidth}
        theme={settings.graphTheme}
        onViewportChange={(viewport) => updateGraph({ viewport })}
        onTrigModeChange={setTrigMode}
        onLineWidthChange={(width) => { void updateSettings({ graphLineWidth: width }) }}
        onThemeChange={(theme) => { void updateSettings({ graphTheme: theme }) }}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}
