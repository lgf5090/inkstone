/**
 * The network panel's page state: the saved settings, the address list and the running test.
 *
 * The engine lives outside React on purpose. The sidebar opens four screens over one panel, and a
 * measurement that stopped every time the reader looked at the history would be the reference project's
 * one behaviour this port does not need; leaving the panel is handled by the background setting instead.
 */
import { create } from 'zustand'
import {
  DEFAULT_NETWORK_PANEL_SETTINGS,
  DOWNLOAD_PATH,
  NETWORK_PANEL_LIMITS,
  type NetworkPanelNode,
  type NetworkPanelRunInput,
  type NetworkPanelSettings,
  type SpeedSeriesPoint,
  type StopReason,
} from '@shared/tools/network-panel/types'
import type { SettingsPatch } from '@shared/tools/network-panel/schemas'
import {
  formatBytes,
  formatSpeed,
  nodeLabelFromUrl,
  parseNodeUrl,
} from '@shared/tools/network-panel/engine'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { networkPanelApi } from './api'
import { createSpeedEngine, type SpeedEngineError } from './speed-engine'

export type NetworkPanelView = 'speed' | 'info' | 'history' | 'settings'

export interface NetworkPanelRuntime {
  running: boolean
  bytesUsed: number
  speedBps: number
  elapsedMs: number
  series: SpeedSeriesPoint[]
  stopReason: StopReason | null
  error: SpeedEngineError | null
  activeLabel: string | null
  activeUrl: string | null
}

export interface PasteImportResult {
  status: 'added' | 'selected'
  label: string
}

const EMPTY_RUNTIME: NetworkPanelRuntime = {
  running: false,
  bytesUsed: 0,
  speedBps: 0,
  elapsedMs: 0,
  series: [],
  stopReason: null,
  error: null,
  activeLabel: null,
  activeUrl: null,
}

export interface NetworkPanelState {
  settings: NetworkPanelSettings
  nodes: NetworkPanelNode[]
  loaded: boolean
  loadError: boolean
  saveError: boolean
  runtime: NetworkPanelRuntime
  load: () => Promise<void>
  updateSettings: (patch: SettingsPatch) => void
  flushSettings: () => Promise<void>
  resetSettings: () => Promise<void>
  addNode: (label: string, url: string) => Promise<NetworkPanelNode | null>
  removeNode: (id: string) => Promise<boolean>
  importPastedUrl: (text: string) => Promise<PasteImportResult | null>
  selectNode: (id: string) => void
  setThreads: (threads: number) => void
  start: () => void
  stop: (reason?: StopReason) => void
  handleBackgroundPolicy: (hidden: boolean) => void
  clearError: () => void
}

let engine: ReturnType<typeof createSpeedEngine> | null = null
let activeNode: { label: string; url: string } | null = null
let titleBeforeRun: string | null = null
let saveTimer = 0
let savePending: SettingsPatch = {}
let saveInFlight = false

export const useNetworkPanelStore = create<NetworkPanelState>((set, get) => {
  const applyTitle = () => {
    const { runtime, settings } = get()
    if (runtime.running && settings.background && typeof document !== 'undefined' && document.hidden) {
      titleBeforeRun ??= document.title
      document.title = `${formatBytes(runtime.bytesUsed)} · ${formatSpeed(runtime.speedBps)}`
      return
    }
    if (titleBeforeRun !== null && typeof document !== 'undefined') {
      document.title = titleBeforeRun
      titleBeforeRun = null
    }
  }

  const persist = async (patch: SettingsPatch) => {
    try {
      const saved = await networkPanelApi.saveSettings(patch)
      set({ settings: saved, saveError: false })
    } catch {
      set({ saveError: true })
      useUi.getState().toast({ title: t('tools.network_panel.settings.save_failed'), tone: 'danger' })
    }
  }

  const queueSave = (patch: SettingsPatch) => {
    savePending = { ...savePending, ...patch }
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      void flush()
    }, 400)
  }

  const flush = async () => {
    if (saveInFlight) {
      saveTimer = window.setTimeout(() => {
        void flush()
      }, 200)
      return
    }
    const patch = savePending
    savePending = {}
    if (Object.keys(patch).length === 0) return
    saveInFlight = true
    await persist(patch)
    saveInFlight = false
    if (Object.keys(savePending).length > 0) void flush()
  }

  const resolveNode = (settings: NetworkPanelSettings, nodes: NetworkPanelNode[]) => {
    if (settings.nodeId !== 'builtin') {
      const saved = nodes.find((node) => node.id === settings.nodeId)
      if (saved) return { label: saved.label, url: saved.url, id: saved.id }
    }
    return {
      label: t('tools.network_panel.node.builtin'),
      url: DOWNLOAD_PATH,
      id: 'builtin',
    }
  }

  const recordRun = async (input: NetworkPanelRunInput) => {
    try {
      await networkPanelApi.recordRun(input)
    } catch {
      useUi.getState().toast({ title: t('tools.network_panel.history.save_failed'), tone: 'danger' })
    }
  }

  const start = () => {
    const state = get()
    if (state.runtime.running) return
    const node = resolveNode(state.settings, state.nodes)
    activeNode = { label: node.label, url: node.url }
    const chunk = NETWORK_PANEL_LIMITS.downloadBytesPreferred
    engine = createSpeedEngine({
      buildUrl: (thread, nonce) => {
        if (node.url === DOWNLOAD_PATH) {
          return `${DOWNLOAD_PATH}?bytes=${chunk}&_np=${nonce}-${thread}`
        }
        const url = new URL(node.url, location.origin)
        url.searchParams.set('_np', `${nonce}-${thread}`)
        return url.toString()
      },
      onProgress: (bytesUsed, elapsedMs) => {
        set((current) => ({ runtime: { ...current.runtime, bytesUsed, elapsedMs } }))
        applyTitle()
      },
      onSample: (sample) => {
        set((current) => ({
          runtime: {
            ...current.runtime,
            bytesUsed: sample.bytesUsed,
            elapsedMs: sample.elapsedMs,
            speedBps: sample.speedBps,
            series: sample.series,
          },
        }))
        applyTitle()
      },
      onError: (error) => {
        set((current) => ({ runtime: { ...current.runtime, error } }))
      },
      onStop: (outcome, reason) => {
        set((current) => ({
          runtime: {
            ...current.runtime,
            running: false,
            bytesUsed: outcome.bytesUsed,
            elapsedMs: outcome.durationMs,
            speedBps: outcome.avgSpeedBps,
            stopReason: reason,
          },
        }))
        applyTitle()
        const settings = get().settings
        if (settings.saveHistory && outcome.bytesUsed > 0 && outcome.durationMs >= 500 && activeNode) {
          void recordRun({
            node_label: activeNode.label.slice(0, NETWORK_PANEL_LIMITS.maxLabel),
            node_url: activeNode.url.slice(0, NETWORK_PANEL_LIMITS.maxUrl),
            bytes_used: Math.round(outcome.bytesUsed),
            avg_speed_bps: Math.round(outcome.avgSpeedBps),
            duration_ms: Math.round(outcome.durationMs),
            threads: settings.threads,
            stop_reason: reason,
          })
        }
        engine = null
      },
    })
    set({ runtime: { ...EMPTY_RUNTIME, running: true, activeLabel: node.label, activeUrl: node.url } })
    engine.start({
      threads: state.settings.threads,
      maxBytes: state.settings.maxDataBytes,
      maxSpeedBps: state.settings.maxSpeedBps,
    })
  }

  return {
    settings: DEFAULT_NETWORK_PANEL_SETTINGS,
    nodes: [],
    loaded: false,
    loadError: false,
    saveError: false,
    runtime: EMPTY_RUNTIME,

    load: async () => {
      if (get().loaded) return
      try {
        const [settings, nodes] = await Promise.all([
          networkPanelApi.getSettings(),
          networkPanelApi.listNodes(),
        ])
        set({ settings, nodes, loaded: true, loadError: false })
        if (settings.autoStart) start()
      } catch {
        set({ loaded: true, loadError: true })
      }
    },

    updateSettings: (patch) => {
      set((current) => ({ settings: { ...current.settings, ...patch } }))
      queueSave(patch)
      if (patch.background !== undefined) applyTitle()
    },

    flushSettings: () => flush(),

    resetSettings: async () => {
      const patch: SettingsPatch = { ...DEFAULT_NETWORK_PANEL_SETTINGS }
      set({ settings: DEFAULT_NETWORK_PANEL_SETTINGS })
      window.clearTimeout(saveTimer)
      savePending = {}
      await persist(patch)
    },

    addNode: async (label, url) => {
      const parsed = parseNodeUrl(url)
      if (!parsed.ok) return null
      try {
        const node = await networkPanelApi.createNode(label.trim().slice(0, NETWORK_PANEL_LIMITS.maxLabel), parsed.url)
        set((current) => ({
          nodes: [node, ...current.nodes],
          settings: { ...current.settings, nodeId: node.id },
        }))
        queueSave({ nodeId: node.id })
        return node
      } catch {
        useUi.getState().toast({ title: t('tools.network_panel.nodes.add_failed'), tone: 'danger' })
        return null
      }
    },

    removeNode: async (id) => {
      const wasSelected = get().settings.nodeId === id
      try {
        await networkPanelApi.deleteNode(id)
      } catch {
        useUi.getState().toast({ title: t('tools.network_panel.nodes.remove_failed'), tone: 'danger' })
        return false
      }
      set((current) => ({
        nodes: current.nodes.filter((node) => node.id !== id),
        settings: wasSelected ? { ...current.settings, nodeId: 'builtin' } : current.settings,
      }))
      if (wasSelected) queueSave({ nodeId: 'builtin' })
      return true
    },

    importPastedUrl: async (text) => {
      const parsed = parseNodeUrl(text)
      if (!parsed.ok) return null
      const existing = get().nodes.find((node) => node.url === parsed.url)
      if (existing) {
        get().selectNode(existing.id)
        return { status: 'selected', label: existing.label }
      }
      const label = nodeLabelFromUrl(parsed.url).slice(0, NETWORK_PANEL_LIMITS.maxLabel)
      const node = await get().addNode(label, parsed.url)
      return node ? { status: 'added', label } : null
    },

    selectNode: (id) => {
      set((current) => ({ settings: { ...current.settings, nodeId: id } }))
      queueSave({ nodeId: id })
    },

    setThreads: (threads) => {
      const clamped = Math.max(
        NETWORK_PANEL_LIMITS.minThreads,
        Math.min(NETWORK_PANEL_LIMITS.maxThreads, Math.floor(threads)),
      )
      set((current) => ({ settings: { ...current.settings, threads: clamped } }))
      queueSave({ threads: clamped })
      engine?.updateThreads(clamped)
    },

    start,

    stop: (reason = 'manual') => {
      engine?.stop(reason)
      if (!engine) {
        set((current) => ({ runtime: { ...current.runtime, running: false } }))
        applyTitle()
      }
    },

    handleBackgroundPolicy: (hidden) => {
      const state = get()
      if (hidden && state.runtime.running && !state.settings.background) {
        state.stop('hidden')
      }
      applyTitle()
    },

    clearError: () => {
      set((current) => ({ runtime: { ...current.runtime, error: null } }))
    },
  }
})
