import { create } from 'zustand'
import { CalculatorEngine } from '@shared/tools/calculator/engine/calc-engine'
import type { CalculatorCommand, CalculatorMode, CalculatorView, AngleMode } from '@shared/tools/calculator/contract'
import { DEFAULT_CALCULATOR_SETTINGS, GRAPH_DEFAULT_VIEWPORT, MAX_EQUATIONS } from '@shared/tools/calculator/contract'
import type {
  CalculatorDisplayState,
  CalculatorSettings,
  CurrencyRates,
  EngineSnapshot,
  GraphEquation,
  GraphSession,
  HistoryEntry,
  MemoryEntry,
  UnitPreference,
} from '@shared/tools/calculator/types'
import { defaultUnitPreferences } from '@shared/tools/calculator/converters/unit-converter'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { calculatorApi } from './api'

const SNAPSHOT_KEY = 'inkstone.calculator.snapshot'

let engine: CalculatorEngine | null = null
let lastSyncedHistoryId: string | null = null
const timers = new Map<string, number>()
let settingsUpdateQueue: Promise<void> = Promise.resolve()

function schedule(key: string, delay: number, work: () => void): void {
  const existing = timers.get(key)
  if (existing) window.clearTimeout(existing)
  timers.set(key, window.setTimeout(() => {
    timers.delete(key)
    work()
  }, delay))
}

function toastFailure(message: string): void {
  useUi.getState().toast({ title: message, tone: 'danger' })
}

function initialDisplay(): CalculatorDisplayState {
  const created = new CalculatorEngine()
  engine = created
  return created.getState()
}

function newEquation(index: number): GraphEquation {
  return {
    id: `eq_${Date.now().toString(36)}_${index}`,
    expression: '',
    colorIndex: index % 14,
    lineStyle: 'solid',
    isEnabled: true,
  }
}

function normalizeGraph(session: GraphSession | null): GraphSession {
  if (!session) return { equations: [newEquation(0)], variables: [], viewport: { ...GRAPH_DEFAULT_VIEWPORT } }
  const equations = session.equations.length > 0 ? session.equations.slice(0, MAX_EQUATIONS) : [newEquation(0)]
  return { equations, variables: session.variables ?? [], viewport: session.viewport ?? { ...GRAPH_DEFAULT_VIEWPORT } }
}

export interface CalculatorClientState {
  ready: boolean
  syncing: boolean
  display: CalculatorDisplayState
  settings: CalculatorSettings
  graph: GraphSession
  unitPreferences: UnitPreference[]
  currencyRates: CurrencyRates | null
  currencyRatesLoading: boolean
  currencyRatesError: boolean
  historyOpen: boolean
  memoryOpen: boolean
  shift: boolean
  hyp: boolean
  boot: () => Promise<void>
  setView: (view: CalculatorView) => void
  setMode: (mode: CalculatorMode) => void
  send: (command: CalculatorCommand) => void
  setAngleMode: (mode: AngleMode) => void
  toggleShift: () => void
  toggleHyp: () => void
  toggleHistory: (open?: boolean) => void
  toggleMemory: (open?: boolean) => void
  remember: () => void
  recallMemory: (index: number) => void
  addMemory: (index: number) => void
  subtractMemory: (index: number) => void
  clearMemory: (index?: number) => void
  clearHistory: (mode?: 'standard' | 'scientific') => Promise<void>
  deleteHistory: (id: string) => Promise<void>
  recallHistory: (index: number) => void
  updateSettings: (partial: Partial<CalculatorSettings>) => Promise<void>
  updateGraph: (patch: Partial<GraphSession>) => void
  addEquation: () => void
  updateEquation: (id: string, patch: Partial<GraphEquation>) => void
  removeEquation: (id: string) => void
  setUnitPreferences: (prefs: UnitPreference[]) => void
  fetchCurrencyRates: (force?: boolean) => Promise<void>
  flush: () => void
}

export const useCalculatorStore = create<CalculatorClientState>((set, get) => {
  const refresh = () => {
    if (!engine) return
    set({ display: engine.getState() })
    const newest = engine.getHistory()[0]
    if (newest && newest.id !== lastSyncedHistoryId) {
      lastSyncedHistoryId = newest.id
      void calculatorApi.appendHistory(newest).catch((error: unknown) => {
        toastFailure(t('tools.calculator.sync_failed'))
        console.warn('[inkstone] Calculator history sync failed:', error instanceof Error ? error.message : error)
      })
    }
    try {
      window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(engine.snapshot()))
    } catch {
      // Best effort: the cloud copy and the in-memory engine remain authoritative.
    }
  }

  const persistMemory = () => {
    if (!engine) return
    schedule('memory', 350, () => {
      void calculatorApi.replaceMemory(engine!.snapshot().memory).catch((error: unknown) => {
        toastFailure(t('tools.calculator.sync_failed'))
        console.warn('[inkstone] Calculator memory sync failed:', error instanceof Error ? error.message : error)
      })
    })
  }

  return {
    ready: false,
    syncing: false,
    display: initialDisplay(),
    settings: { ...DEFAULT_CALCULATOR_SETTINGS },
    graph: normalizeGraph(null),
    unitPreferences: defaultUnitPreferences(),
    currencyRates: null,
    currencyRatesLoading: false,
    currencyRatesError: false,
    historyOpen: false,
    memoryOpen: false,
    shift: false,
    hyp: false,

    boot: async () => {
      if (!engine) engine = new CalculatorEngine()
      let snapshot: EngineSnapshot | null = null
      try {
        const raw = window.localStorage.getItem(SNAPSHOT_KEY)
        if (raw) snapshot = JSON.parse(raw) as EngineSnapshot
      } catch {
        // A corrupt local snapshot is discarded; the cloud copy is read below.
      }
      if (snapshot) {
        engine.restore(snapshot)
        lastSyncedHistoryId = snapshot.history[0]?.id ?? null
        set({ display: engine.getState() })
      }
      set({ syncing: true })
      const results = await Promise.allSettled([
        calculatorApi.getSettings(),
        calculatorApi.listHistory(),
        calculatorApi.listMemory(),
        calculatorApi.getGraph(),
        calculatorApi.listUnitPreferences(),
      ])
      const settings = results[0].status === 'fulfilled' ? results[0].value : { ...DEFAULT_CALCULATOR_SETTINGS }
      const history = results[1].status === 'fulfilled' ? results[1].value : snapshot?.history ?? []
      const memory = results[2].status === 'fulfilled' ? results[2].value : snapshot?.memory ?? []
      const graph = results[3].status === 'fulfilled' ? normalizeGraph(results[3].value) : normalizeGraph(null)
      const prefs = results[4].status === 'fulfilled' ? results[4].value : defaultUnitPreferences()
      const mode: CalculatorMode = settings.defaultView === 'scientific' || settings.defaultView === 'programmer' ? settings.defaultView : 'standard'
      engine.setMode(mode)
      engine.setAngleMode(settings.angleMode)
      engine.restore({
        version: 1,
        mode,
        history,
        memory,
        displayCommands: snapshot?.displayCommands ?? [],
        radix: snapshot?.radix ?? 10,
        wordSize: snapshot?.wordSize ?? 64,
        angleMode: settings.angleMode,
      })
      lastSyncedHistoryId = history[0]?.id ?? null
      set({
        ready: true,
        syncing: false,
        settings,
        graph,
        unitPreferences: prefs,
        display: engine.getState(),
      })
    },

    setView: (view) => {
      if (!engine) return
      if (view === 'standard' || view === 'scientific' || view === 'programmer') engine.setMode(view)
      set({ display: engine.getState() })
    },

    setMode: (mode) => {
      if (!engine) return
      engine.setMode(mode)
      refresh()
    },

    send: (command) => {
      if (!engine) return
      engine.send(command)
      refresh()
    },

    setAngleMode: (mode) => {
      if (!engine) return
      engine.setAngleMode(mode)
      refresh()
      void get().updateSettings({ angleMode: mode })
    },

    toggleShift: () => set((state) => ({ shift: !state.shift })),
    toggleHyp: () => set((state) => ({ hyp: !state.hyp })),
    toggleHistory: (open) => set((state) => ({ historyOpen: open ?? !state.historyOpen, memoryOpen: false })),
    toggleMemory: (open) => set((state) => ({ memoryOpen: open ?? !state.memoryOpen, historyOpen: false })),

    remember: () => {
      engine?.rememberMemory()
      refresh()
      persistMemory()
    },
    recallMemory: (index) => {
      engine?.recallMemory(index)
      refresh()
    },
    addMemory: (index) => {
      if (!engine) return
      if (engine.snapshot().memory.length === 0) engine.rememberMemory()
      else engine.addMemory(index)
      refresh()
      persistMemory()
    },
    subtractMemory: (index) => {
      if (!engine) return
      if (engine.snapshot().memory.length === 0) engine.rememberMemory()
      else engine.subtractMemory(index)
      refresh()
      persistMemory()
    },
    clearMemory: (index) => {
      engine?.clearMemory(index)
      refresh()
      persistMemory()
    },

    clearHistory: async (mode) => {
      engine?.clearHistory(mode)
      refresh()
      try {
        await calculatorApi.clearHistory(mode)
      } catch (error) {
        toastFailure(t('tools.calculator.sync_failed'))
        console.warn('[inkstone] Calculator history clear failed:', error instanceof Error ? error.message : error)
      }
    },

    deleteHistory: async (id) => {
      if (!engine) return
      engine.removeHistoryEntry(id)
      refresh()
      try {
        await calculatorApi.deleteHistory(id)
      } catch (error) {
        toastFailure(t('tools.calculator.sync_failed'))
        console.warn('[inkstone] Calculator history delete failed:', error instanceof Error ? error.message : error)
      }
    },

    recallHistory: (index) => {
      engine?.recallHistory(index)
      refresh()
    },

    updateSettings: (partial) => {
      set({ settings: { ...get().settings, ...partial } })
      settingsUpdateQueue = settingsUpdateQueue.then(async () => {
        try {
          const saved = await calculatorApi.updateSettings(partial)
          set((state) => {
            const accepted = Object.fromEntries(
              Object.keys(partial)
                .filter((key) => Object.is(state.settings[key as keyof CalculatorSettings], partial[key as keyof CalculatorSettings]))
                .map((key) => [key, saved[key as keyof CalculatorSettings]]),
            ) as Partial<CalculatorSettings>
            return { settings: { ...state.settings, ...accepted } }
          })
        } catch (error) {
          toastFailure(t('tools.calculator.sync_failed'))
          console.warn('[inkstone] Calculator settings sync failed:', error instanceof Error ? error.message : error)
        }
      })
      return settingsUpdateQueue
    },

    updateGraph: (patch) => {
      const graph = { ...get().graph, ...patch }
      set({ graph })
      schedule('graph', 700, () => {
        void calculatorApi.updateGraph(graph).catch((error: unknown) => {
          toastFailure(t('tools.calculator.sync_failed'))
          console.warn('[inkstone] Calculator graph sync failed:', error instanceof Error ? error.message : error)
        })
      })
    },

    addEquation: () => {
      const graph = get().graph
      if (graph.equations.length >= MAX_EQUATIONS) return
      const equation = newEquation(graph.equations.length)
      get().updateGraph({ equations: [...graph.equations, equation] })
    },

    updateEquation: (id, patch) => {
      const graph = get().graph
      get().updateGraph({ equations: graph.equations.map((equation) => equation.id === id ? { ...equation, ...patch } : equation) })
    },

    removeEquation: (id) => {
      const graph = get().graph
      const remaining = graph.equations.filter((equation) => equation.id !== id)
      get().updateGraph({ equations: remaining.length ? remaining : [newEquation(0)] })
    },

    fetchCurrencyRates: async (force = false) => {
      if (!force && (get().currencyRates || get().currencyRatesLoading)) return
      set({ currencyRatesLoading: true, currencyRatesError: false })
      try {
        const rates = await calculatorApi.getCurrencyRates(force)
        set({ currencyRates: rates, currencyRatesLoading: false, currencyRatesError: false })
      } catch (error) {
        console.warn('[inkstone] Currency rates load failed:', error instanceof Error ? error.message : error)
        set((state) => ({
          currencyRatesLoading: false,
          currencyRatesError: true,
          currencyRates: state.currencyRates ? { ...state.currencyRates, stale: true } : null,
        }))
      }
    },

    setUnitPreferences: (prefs) => {
      const current = get().unitPreferences
      const merged = [
        ...current.filter((entry) => !prefs.some((next) => next.categoryId === entry.categoryId)),
        ...prefs,
      ]
      set({ unitPreferences: merged })
      schedule('unit-preferences', 350, () => {
        void calculatorApi.replaceUnitPreferences(merged).catch((error: unknown) => {
          toastFailure(t('tools.calculator.sync_failed'))
          console.warn('[inkstone] Calculator unit preferences sync failed:', error instanceof Error ? error.message : error)
        })
      })
    },

    flush: () => {
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
      if (engine) {
        void calculatorApi.replaceMemory(engine.snapshot().memory).catch((error: unknown) => {
          // Unloading a page is not a place to show a toast; the next session re-reads the server copy.
          console.warn('[inkstone] Calculator memory flush failed:', error instanceof Error ? error.message : error)
        })
      }
    },
  }
})

export function getCalculatorEngine(): CalculatorEngine | null {
  return engine
}

export type { HistoryEntry, MemoryEntry }
