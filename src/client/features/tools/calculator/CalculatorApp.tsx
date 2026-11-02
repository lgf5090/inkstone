import { Suspense, lazy, useEffect, useRef } from 'react'
import { LoadingBlock } from '../../../components/feedback'
import { useLocaleRepaint } from '../../../lib/i18n'
import { useToolsStore } from '../store'
import { useCalculatorStore } from './store'
import { useCalculatorKeyboard } from './lib/keyboard'
import { StandardView } from './views/StandardView'
import { ScientificView } from './views/ScientificView'
import { ProgrammerView } from './views/ProgrammerView'

const DateView = lazy(() => import('./views/DateView').then((module) => ({ default: module.DateView })))
const UnitView = lazy(() => import('./views/UnitView').then((module) => ({ default: module.UnitView })))
const CurrencyView = lazy(() => import('./views/CurrencyView').then((module) => ({ default: module.CurrencyView })))
const GraphView = lazy(() => import('./views/GraphView').then((module) => ({ default: module.GraphView })))
const KinshipView = lazy(() => import('./views/KinshipView').then((module) => ({ default: module.KinshipView })))
const SettingsView = lazy(() => import('./views/SettingsView').then((module) => ({ default: module.SettingsView })))

function ViewRouter() {
  const view = useToolsStore((state) => state.activeCalculatorView)
  const setView = useCalculatorStore((state) => state.setView)

  useEffect(() => {
    setView(view)
  }, [view, setView])

  switch (view) {
    case 'scientific':
      return <ScientificView />
    case 'programmer':
      return <ProgrammerView />
    case 'date':
      return <DateView />
    case 'unit':
      return <UnitView />
    case 'currency':
      return <CurrencyView />
    case 'graph':
      return <GraphView />
    case 'kinship':
      return <KinshipView />
    case 'settings':
      return <SettingsView />
    default:
      return <StandardView />
  }
}

export function CalculatorApp() {
  useLocaleRepaint()
  const ready = useCalculatorStore((state) => state.ready)
  const boot = useCalculatorStore((state) => state.boot)
  const flush = useCalculatorStore((state) => state.flush)
  const booted = useRef(false)
  const initialView = useRef(useToolsStore.getState().activeCalculatorView)
  const view = useToolsStore((state) => state.activeCalculatorView)
  useCalculatorKeyboard(view)

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void boot().then(() => {
      const settings = useCalculatorStore.getState().settings
      if (settings.defaultView && settings.defaultView !== 'settings' && !useToolsStore.getState().calculatorViewChosen && useToolsStore.getState().activeCalculatorView === initialView.current) {
        useToolsStore.getState().setActiveCalculatorView(settings.defaultView)
      }
    })
  }, [boot])

  useEffect(() => {
    const onHide = () => flush()
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      flush()
    }
  }, [flush])

  return (
    <div
      data-testid="calculator-app-root"
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      {ready ? (
        <Suspense fallback={<LoadingBlock />}>
          <ViewRouter />
        </Suspense>
      ) : (
        <LoadingBlock />
      )}
    </div>
  )
}
