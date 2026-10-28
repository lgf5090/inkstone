import { create } from 'zustand'
import { HISTORY_LIMIT } from '@shared/development/api-tester/limits'
import { newApiTesterId } from '@shared/development/api-tester/ids'
import { defaultState, normalizeState } from '@shared/development/api-tester/state'
import type {
  ApiTesterState,
  CollectionNode,
  EnvVariable,
  Environment,
  HistoryEntry,
  ResponseResult,
  TagNode,
  TestResult,
  ToolsSettings,
  Workspace,
} from '@shared/development/api-tester/types'
import { ApiError } from '../../../lib/api'
import { errorMessage } from './api'
import * as api from './api'
import { StateSaver } from './persistence'
import { canMove, duplicateSubtree, reordered, subtreeIds, tagDescendantIds } from './lib/tree'

const LAST_WORKSPACE_KEY = 'inkstone.development.api-tester.last-workspace'

function readLastWorkspace(): string | null {
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY)
  } catch (error) {
    console.warn('[inkstone] API Tester workspace preference could not be read', error)
    return null
  }
}

function writeLastWorkspace(id: string): void {
  try {
    localStorage.setItem(LAST_WORKSPACE_KEY, id)
  } catch (error) {
    console.warn('[inkstone] API Tester workspace preference could not be saved', error)
  }
}

export interface ApiTesterStore {
  loaded: boolean
  loading: boolean
  loadError: string | null
  saving: boolean
  savedAt: number | null
  saveError: string | null
  conflict: boolean
  workspaces: Workspace[]
  activeWorkspaceId: string
  state: ApiTesterState
  activeId: string | null
  openTabs: string[]
  results: Record<string, ResponseResult>
  loadingTabs: Record<string, boolean>
  testResults: Record<string, { results: TestResult[]; error?: string }>

  initialize: () => Promise<void>
  reloadWorkspace: () => Promise<void>
  switchWorkspace: (id: string) => Promise<void>
  createWorkspace: (name: string, color: string) => Promise<void>
  renameWorkspace: (id: string, name: string) => Promise<void>
  setWorkspaceColor: (id: string, color: string) => Promise<void>
  deleteWorkspace: (id: string) => Promise<void>

  patchState: (updater: (state: ApiTesterState) => ApiTesterState) => void
  updateNode: (id: string, patch: Partial<CollectionNode>) => void
  addNode: (node: CollectionNode) => void
  deleteNode: (id: string) => void
  duplicateNode: (id: string, suffix: string) => void
  moveNode: (id: string, parentId: string | null) => void
  reorderNodes: (parentId: string | null, orderedIds: string[]) => void

  openTab: (id: string) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string | null) => void
  setResult: (id: string, result: ResponseResult | null) => void
  setTabLoading: (id: string, loading: boolean) => void
  setTestResults: (id: string, results: { results: TestResult[]; error?: string } | null) => void
  appendHistoryLocal: (entry: HistoryEntry) => void
  clearHistoryLocal: () => void

  addTag: (name: string, color: string, parentId: string | null) => void
  updateTag: (id: string, patch: Partial<Pick<TagNode, 'name' | 'color' | 'parentId'>>) => void
  deleteTag: (id: string) => void
  addEnvironment: (name: string) => string
  updateEnvironment: (id: string, patch: Partial<Pick<Environment, 'name' | 'variables' | 'color'>>) => void
  deleteEnvironment: (id: string) => void
  setActiveEnvironment: (id: string | null) => void
  setGlobalVariables: (variables: EnvVariable[]) => void
  patchSettings: (patch: Partial<ToolsSettings>) => void

  dismissConflict: () => void
  flush: () => Promise<void>
  dispose: () => void
}

let saver: StateSaver | null = null
let initialization: Promise<void> | null = null
let pagehideInstalled = false

function flushBeforeLeaving(): void {
  saver?.flushOnHide()
}

function installPagehide(): void {
  if (pagehideInstalled || typeof window === 'undefined') return
  pagehideInstalled = true
  window.addEventListener('pagehide', flushBeforeLeaving)
}

export const useApiTesterStore = create<ApiTesterStore>((set, get) => {
  const markDirty = () => saver?.markDirty()

  const ensureSaver = () => {
    if (saver) return saver
    saver = new StateSaver({
      read: () => {
        const snapshot = get()
        return snapshot.activeWorkspaceId ? { state: snapshot.state, workspaceId: snapshot.activeWorkspaceId } : null
      },
      onSaving: () => set({ saving: true, saveError: null }),
      onSaved: (rev, savedAt) => {
        void rev
        set({ saving: false, savedAt })
      },
      onConflict: () => set({ saving: false, conflict: true }),
      onError: (message) => set({ saving: false, saveError: message }),
    })
    installPagehide()
    return saver
  }

  const loadWorkspace = async (id: string) => {
    set({ loading: true, loadError: null })
    const activeSaver = ensureSaver()
    try {
      if (id === get().activeWorkspaceId) await activeSaver.flush()
      const response = await api.getState(id)
      const state = normalizeState({ ...response.data, workspaceId: id, history: response.history }, id)
      activeSaver.setRev(response.rev)
      set({
        state,
        activeWorkspaceId: id,
        loaded: true,
        loading: false,
        conflict: false,
        savedAt: response.updatedAt,
        activeId: null,
        openTabs: [],
        results: {},
        loadingTabs: {},
        testResults: {},
      })
      writeLastWorkspace(id)
      const first = state.nodes.find((node) => node.type === 'request')
      if (first) set({ activeId: first.id, openTabs: [first.id] })
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        const state = defaultState(id)
        activeSaver.setRev(0)
        set({ state, activeWorkspaceId: id, loaded: true, loading: false, conflict: false, activeId: null, openTabs: [] })
        writeLastWorkspace(id)
        return
      }
      set({ loading: false, loaded: true, loadError: errorMessage(error) })
    }
  }

  return {
    loaded: false,
    loading: true,
    loadError: null,
    saving: false,
    savedAt: null,
    saveError: null,
    conflict: false,
    workspaces: [],
    activeWorkspaceId: '',
    state: defaultState(''),
    activeId: null,
    openTabs: [],
    results: {},
    loadingTabs: {},
    testResults: {},

    initialize: () => {
      if (initialization) return initialization
      initialization = (async () => {
      try {
        const workspaces = await api.listWorkspaces()
        const remembered = readLastWorkspace()
        const active = workspaces.find((workspace) => workspace.id === remembered) ?? workspaces[0]
        if (!active) {
          set({ loading: false, loaded: true, loadError: 'No workspace could be created' })
          return
        }
        set({ workspaces, activeWorkspaceId: active.id })
        await loadWorkspace(active.id)
      } catch (error) {
        set({ loading: false, loaded: true, loadError: errorMessage(error) })
      }
      })().finally(() => {
        if (!get().loaded || get().loadError) initialization = null
      })
      return initialization
    },

    reloadWorkspace: async () => {
      const id = get().activeWorkspaceId
      if (!id) return
      await loadWorkspace(id)
    },

    switchWorkspace: async (id) => {
      if (id === get().activeWorkspaceId) return
      await saver?.flush()
      set({ activeWorkspaceId: id })
      await loadWorkspace(id)
    },

    createWorkspace: async (name, color) => {
      const result = await api.createWorkspace(name, color)
      set({ workspaces: result.workspaces })
      await get().switchWorkspace(result.workspace.id)
    },

    renameWorkspace: async (id, name) => {
      set({ workspaces: await api.updateWorkspace(id, { name }) })
    },

    setWorkspaceColor: async (id, color) => {
      set({ workspaces: await api.updateWorkspace(id, { color }) })
    },

    deleteWorkspace: async (id) => {
      const workspaces = await api.deleteWorkspace(id)
      set({ workspaces })
      if (get().activeWorkspaceId === id) {
        const next = workspaces[0]
        if (next) {
          set({ activeWorkspaceId: '' })
          await loadWorkspace(next.id)
        }
      }
    },

    patchState: (updater) => {
      set((snapshot) => ({ state: updater(snapshot.state) }))
      markDirty()
    },

    updateNode: (id, patch) => {
      get().patchState((state) => ({
        ...state,
        nodes: state.nodes.map((node) => (node.id === id ? { ...node, ...patch, updatedAt: Date.now() } : node)),
      }))
    },

    addNode: (node) => {
      get().patchState((state) => ({ ...state, nodes: [...state.nodes, node] }))
      if (node.type === 'request') get().openTab(node.id)
    },

    deleteNode: (id) => {
      const removed = subtreeIds(get().state.nodes, id)
      get().patchState((state) => ({ ...state, nodes: state.nodes.filter((node) => !removed.has(node.id)) }))
      const snapshot = get()
      set({
        openTabs: snapshot.openTabs.filter((tab) => !removed.has(tab)),
        results: Object.fromEntries(Object.entries(snapshot.results).filter(([key]) => !removed.has(key))),
        loadingTabs: Object.fromEntries(Object.entries(snapshot.loadingTabs).filter(([key]) => !removed.has(key))),
        testResults: Object.fromEntries(Object.entries(snapshot.testResults).filter(([key]) => !removed.has(key))),
        activeId: snapshot.activeId && removed.has(snapshot.activeId) ? null : snapshot.activeId,
      })
    },

    duplicateNode: (id, suffix) => {
      const copies = duplicateSubtree(get().state.nodes, id, suffix)
      if (copies.length === 0) return
      get().patchState((state) => ({ ...state, nodes: [...state.nodes, ...copies] }))
      const root = copies[0]
      if (root?.type === 'request') get().openTab(root.id)
    },

    moveNode: (id, parentId) => {
      const nodes = get().state.nodes
      if (!canMove(nodes, id, parentId)) return
      const order = nodes.filter((node) => node.parentId === parentId).reduce((max, node) => Math.max(max, node.order), 0) + 1
      get().updateNode(id, { parentId, order })
    },

    reorderNodes: (parentId, orderedIds) => {
      get().patchState((state) => ({ ...state, nodes: reordered(state.nodes, parentId, orderedIds) }))
    },

    openTab: (id) => {
      set((snapshot) => ({
        openTabs: snapshot.openTabs.includes(id) ? snapshot.openTabs : [...snapshot.openTabs, id],
        activeId: id,
      }))
    },

    closeTab: (id) => {
      const snapshot = get()
      const index = snapshot.openTabs.indexOf(id)
      const openTabs = snapshot.openTabs.filter((tab) => tab !== id)
      const activeId = snapshot.activeId === id ? (openTabs[index] ?? openTabs[index - 1] ?? openTabs[0] ?? null) : snapshot.activeId
      const results = { ...snapshot.results }
      const loadingTabs = { ...snapshot.loadingTabs }
      const testResults = { ...snapshot.testResults }
      delete results[id]
      delete loadingTabs[id]
      delete testResults[id]
      set({ openTabs, activeId, results, loadingTabs, testResults })
    },

    setActiveTab: (id) => set({ activeId: id }),

    setResult: (id, result) => {
      set((snapshot) => {
        const results = { ...snapshot.results }
        if (result) results[id] = result
        else delete results[id]
        return { results }
      })
    },

    setTabLoading: (id, loading) => {
      set((snapshot) => {
        const loadingTabs = { ...snapshot.loadingTabs }
        if (loading) loadingTabs[id] = true
        else delete loadingTabs[id]
        return { loadingTabs }
      })
    },

    setTestResults: (id, results) => {
      set((snapshot) => {
        const testResults = { ...snapshot.testResults }
        if (results) testResults[id] = results
        else delete testResults[id]
        return { testResults }
      })
    },

    appendHistoryLocal: (entry) => {
      set((snapshot) => ({ state: { ...snapshot.state, history: [entry, ...snapshot.state.history].slice(0, HISTORY_LIMIT) } }))
    },

    clearHistoryLocal: () => {
      set((snapshot) => ({ state: { ...snapshot.state, history: [] } }))
    },

    addTag: (name, color, parentId) => {
      get().patchState((state) => ({
        ...state,
        tags: [
          ...state.tags,
          {
            id: newApiTesterId(),
            name,
            color,
            parentId,
            sortOrder: state.tags.length,
            createdAt: Math.floor(Date.now() / 1000),
          },
        ],
      }))
    },

    updateTag: (id, patch) => {
      get().patchState((state) => ({
        ...state,
        tags: state.tags.map((tag) => (tag.id === id ? { ...tag, ...patch } : tag)),
      }))
    },

    deleteTag: (id) => {
      get().patchState((state) => {
        const removed = tagDescendantIds(state.tags, id)
        return {
          ...state,
          tags: state.tags.filter((tag) => !removed.has(tag.id)),
          nodes: state.nodes.map((node) =>
            node.tags.some((tagId) => removed.has(tagId))
              ? { ...node, tags: node.tags.filter((tagId) => !removed.has(tagId)), updatedAt: Date.now() }
              : node,
          ),
        }
      })
    },

    addEnvironment: (name) => {
      const id = newApiTesterId()
      get().patchState((state) => ({
        ...state,
        environments: [...state.environments, { id, name, variables: [] }],
        activeEnvId: state.activeEnvId ?? id,
      }))
      return id
    },

    updateEnvironment: (id, patch) => {
      get().patchState((state) => ({
        ...state,
        environments: state.environments.map((environment) => (environment.id === id ? { ...environment, ...patch } : environment)),
      }))
    },

    deleteEnvironment: (id) => {
      get().patchState((state) => {
        const environments = state.environments.filter((environment) => environment.id !== id)
        return {
          ...state,
          environments,
          activeEnvId: state.activeEnvId === id ? (environments[0]?.id ?? null) : state.activeEnvId,
        }
      })
    },

    setActiveEnvironment: (id) => {
      get().patchState((state) => ({ ...state, activeEnvId: id }))
    },

    setGlobalVariables: (variables) => {
      get().patchState((state) => ({ ...state, globalVariables: variables }))
    },

    patchSettings: (patch) => {
      get().patchState((state) => ({ ...state, settings: { ...state.settings, ...patch } }))
    },

    dismissConflict: () => {
      set({ conflict: false })
      void get().reloadWorkspace()
    },

    flush: async () => {
      await saver?.flush()
    },

    dispose: () => {
      saver?.dispose()
      saver = null
    },
  }
})
