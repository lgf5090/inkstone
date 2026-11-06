/**
 * Client state for the Prompt Optimizer.
 *
 * A workspace is a draft: prompt text, the result, its chain, the test cases and the evaluation. Drafts
 * are persisted per workspace with an optimistic revision so a second tab cannot silently overwrite the
 * first one's edits.
 */

import { create } from 'zustand'
import type {
  AssetRecord,
  BackupRecord,
  ConversationMessage,
  EvaluationOutcome,
  FavoriteCategory,
  FavoritePrompt,
  PromptOptimizerSettings,
  PromptOptimizerStats,
  PromptRecord,
  PromptRecordChain,
  PromptTemplate,
  ToolDefinition,
  VariableEntry,
  Workspace,
} from '@shared/tools/prompt-optimizer/types'
import { PROMPT_OPTIMIZER_NAV_VIEWS, WORKSPACES, type PromptOptimizerNavView } from '@shared/tools/prompt-optimizer/types'
import { applyVariables, missingVariables, variableNames } from '@shared/tools/prompt-optimizer/variables'
import { promptOptimizerApi, type EvaluateResult, type ModelCatalogue } from './api'
import { t, translateApiError } from '../../../lib/i18n'
import { useUiStore } from '../../../lib/ui-store'
import { navigateToAddress } from '../../../lib/app-history'

const toast = (message: string, tone: 'success' | 'error' | 'warning' | 'default' = 'default') =>
  useUiStore.getState().toast(message, tone)

export interface TestGroup {
  id: string
  input: string
  output: string
  reasoning: string
  toolCalls: { name: string; arguments: string }[]
  status: 'idle' | 'running' | 'done' | 'failed'
  /** Baseline is the reference run; candidate is what the current prompt produces. */
  variant: 'baseline' | 'candidate'
  modelId: string
}

export interface WorkspaceDraft {
  prompt: string
  optimized: string
  chainId: string
  versions: PromptRecord[]
  analysis: string
  iterateInput: string
  testOutput: string
  testReasoning: string
  testGroups: TestGroup[]
  messages: ConversationMessage[]
  selectedMessageId: string
  tools: ToolDefinition[]
  imageIds: string[]
  focus: string
  templateId: string
  modelId: string
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheMissTokens: number } | null
}

function emptyDraft(workspace: Workspace): WorkspaceDraft {
  return {
    prompt: '',
    optimized: '',
    chainId: '',
    versions: [],
    analysis: '',
    iterateInput: '',
    testOutput: '',
    testReasoning: '',
    testGroups: [{ id: 'g1', input: '', output: '', reasoning: '', toolCalls: [], status: 'idle', variant: 'baseline', modelId: '' }],
    messages: workspace === 'pro_multi' ? [{ id: 'm1', role: 'system', content: '' }] : [],
    selectedMessageId: '',
    tools: [],
    imageIds: [],
    focus: '',
    templateId: '',
    modelId: '',
    usage: null,
  }
}

function emptyDrafts(): Record<Workspace, WorkspaceDraft> {
  return Object.fromEntries(WORKSPACES.map((workspace) => [workspace, emptyDraft(workspace)])) as Record<Workspace, WorkspaceDraft>
}

function defaultTestGroups(count: number): TestGroup[] {
  return Array.from({ length: Math.max(1, count) }, (_, index) => ({
    id: `g${index + 1}`,
    input: '',
    output: '',
    reasoning: '',
    toolCalls: [],
    status: 'idle' as const,
    variant: index === 0 ? 'baseline' as const : 'candidate' as const,
    modelId: '',
  }))
}

function normalizeTestGroup(group: Partial<TestGroup>, index: number): TestGroup {
  return {
    id: group.id || `g${index + 1}`,
    input: typeof group.input === 'string' ? group.input : '',
    output: typeof group.output === 'string' ? group.output : '',
    reasoning: typeof group.reasoning === 'string' ? group.reasoning : '',
    toolCalls: Array.isArray(group.toolCalls) ? group.toolCalls : [],
    status: group.status ?? 'idle',
    variant: group.variant === 'candidate' ? 'candidate' : 'baseline',
    modelId: typeof group.modelId === 'string' ? group.modelId : '',
  }
}

function withDefaultGroups(draft: WorkspaceDraft, count: number, sessionHadGroups: boolean): WorkspaceDraft {
  if (sessionHadGroups || count <= 1) return draft
  if (draft.testGroups.length !== 1 || draft.testGroups[0]?.input) return draft
  return { ...draft, testGroups: defaultTestGroups(count) }
}

function mergeDraft(workspace: Workspace, state: Record<string, unknown> | null | undefined): WorkspaceDraft {
  const base = emptyDraft(workspace)
  if (!state || typeof state !== 'object') return base
  const source = state as Partial<WorkspaceDraft>
  return {
    ...base,
    ...source,
    testGroups: Array.isArray(source.testGroups) && source.testGroups.length
      ? source.testGroups.map((group, index) => normalizeTestGroup(group, index))
      : base.testGroups,
    messages: workspace === 'pro_multi'
      ? (Array.isArray(source.messages) && source.messages.length ? source.messages : base.messages)
      : [],
    tools: Array.isArray(source.tools) ? source.tools : [],
    imageIds: Array.isArray(source.imageIds) ? source.imageIds : [],
  }
}

const persistTimers = new Map<Workspace, ReturnType<typeof setTimeout>>()

function schedulePersist(workspace: Workspace, rev: number, state: Record<string, unknown>): void {
  const timer = persistTimers.get(workspace)
  if (timer) clearTimeout(timer)
  persistTimers.set(workspace, setTimeout(() => {
    persistTimers.delete(workspace)
    void promptOptimizerApi.saveSession(workspace, rev, state).then((result) => {
      if ('conflict' in result) {
        usePromptOptimizerStore.setState({ conflictWorkspace: workspace, conflictSession: result.current })
      } else {
        usePromptOptimizerStore.setState((current) => ({ revs: { ...current.revs, [workspace]: result.rev } }))
      }
    }).catch((error: unknown) => {
      toast(error instanceof Error ? error.message : t('tools.prompt_optimizer.errors.save_failed').replace('{message}', 'draft'), 'error')
    })
  }, 700))
}

export interface PromptOptimizerState {
  activeView: PromptOptimizerNavView
  workspace: Workspace
  settings: PromptOptimizerSettings | null
  models: ModelCatalogue
  templates: { builtin: PromptTemplate[]; user: PromptTemplate[] }
  variables: VariableEntry[]
  categories: FavoriteCategory[]
  favorites: FavoritePrompt[]
  favoriteSearch: string
  favoriteCategory: string
  favoriteTag: string
  history: PromptRecordChain[]
  historySearch: string
  historyWorkspace: string
  stats: PromptOptimizerStats | null
  backups: BackupRecord[]
  images: AssetRecord[]
  evaluations: EvaluationOutcome | null
  drafts: Record<Workspace, WorkspaceDraft>
  revs: Record<Workspace, number>
  conflictWorkspace: Workspace | null
  conflictSession: { rev: number; state: Record<string, unknown>; updatedAt: number } | null
  loading: boolean
  busy: 'optimize' | 'analyze' | 'iterate' | 'test' | 'evaluate' | 'rewrite' | 'variables' | null
  streaming: boolean
  hydrate: () => Promise<void>
  setActiveView: (view: PromptOptimizerNavView) => Promise<void>
  setWorkspace: (workspace: Workspace, draftOverride?: Partial<WorkspaceDraft>) => Promise<void>
  updateDraft: (patch: Partial<WorkspaceDraft>) => void
  persistWorkspace: () => void
  reloadWorkspace: () => Promise<void>
  optimize: (stream: boolean) => Promise<void>
  stop: () => void
  analyze: () => Promise<void>
  iterate: () => Promise<void>
  runTest: (groupIds?: string[]) => Promise<void>
  evaluate: (type: 'result' | 'compare' | 'structured' | 'prompt-only') => Promise<void>
  rewrite: () => Promise<void>
  useVersion: (record: PromptRecord) => void
  loadChain: (chain: PromptRecordChain) => void
  setFavoriteSearch: (search: string) => Promise<void>
  setFavoriteCategory: (category: string) => Promise<void>
  setFavoriteTag: (tag: string) => Promise<void>
  refreshFavorites: () => Promise<void>
  saveFavorite: (input: Parameters<typeof promptOptimizerApi.createFavorite>[0], id?: string) => Promise<void>
  deleteFavorite: (id: string) => Promise<void>
  refreshCategories: () => Promise<void>
  saveCategory: (input: Parameters<typeof promptOptimizerApi.createCategory>[0], id?: string) => Promise<void>
  deleteCategory: (id: string) => Promise<void>
  refreshVariables: () => Promise<void>
  saveVariable: (input: Parameters<typeof promptOptimizerApi.saveVariable>[0]) => Promise<void>
  importVariables: (items: Parameters<typeof promptOptimizerApi.saveVariable>[0][]) => Promise<number>
  deleteVariable: (name: string) => Promise<void>
  extractVariables: () => Promise<void>
  generateVariableValues: (names: string[]) => Promise<void>
  refreshTemplates: () => Promise<void>
  saveTemplate: (template: PromptTemplate, editing: boolean) => Promise<void>
  deleteTemplate: (id: string) => Promise<void>
  refreshHistory: () => Promise<void>
  setHistorySearch: (search: string) => Promise<void>
  setHistoryWorkspace: (workspace: string) => Promise<void>
  deleteChain: (chainId: string) => Promise<void>
  clearHistory: () => Promise<void>
  refreshSettings: () => Promise<void>
  saveSettings: (patch: Parameters<typeof promptOptimizerApi.saveSettings>[0]) => Promise<void>
  refreshBackups: () => Promise<void>
  createBackup: () => Promise<void>
  restoreBackup: (id: string) => Promise<void>
  deleteBackup: (id: string) => Promise<void>
  refreshImages: () => Promise<void>
  uploadImage: (dataUrl: string, kind?: 'image', prompt?: string) => Promise<AssetRecord | null>
  generateImage: (prompt: string, size?: string) => Promise<AssetRecord | null>
  understandImage: (imageId: string) => Promise<string | null>
  deleteImage: (id: string) => Promise<void>
  refreshStats: () => Promise<void>
  exportData: (format: 'json' | 'txt', scope?: 'all' | 'history' | 'favorites') => Promise<void>
  importData: (document: unknown) => Promise<void>
  clearAll: () => Promise<void>
  dismissConflict: () => void
  overwriteConflict: () => Promise<void>
}

let optimizeAbort: AbortController | null = null

const defaultModels: ModelCatalogue = { text: [], image: [], activeModelId: '' }

export function messageId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message
    try {
      const parsed = JSON.parse(message) as { error?: { code?: string; message?: string } | string }
      if (typeof parsed.error === 'string') return parsed.error
      if (parsed.error?.message) {
        return parsed.error.code ? translateApiError(parsed.error.code, parsed.error.message) : parsed.error.message
      }
    } catch {
      // Plain text, which is what the API returns when the request never reached the router.
    }
    return message
  }
  return t('tools.prompt_optimizer.errors.upstream').replace('{message}', 'unknown')
}

export const usePromptOptimizerStore = create<PromptOptimizerState>((set, get) => {
  const patchDraft = (workspace: Workspace, patch: Partial<WorkspaceDraft>) => {
    const next = { ...get().drafts[workspace], ...patch }
    set((state) => ({
      drafts: { ...state.drafts, [workspace]: next },
    }))
    if (get().settings?.autosaveDrafts !== false) {
      schedulePersist(workspace, get().revs[workspace] ?? 0, next as unknown as Record<string, unknown>)
    }
  }

  return {
    activeView: 'basic_system',
    workspace: 'basic_system',
    settings: null,
    models: defaultModels,
    templates: { builtin: [], user: [] },
    variables: [],
    categories: [],
    favorites: [],
    favoriteSearch: '',
    favoriteCategory: '',
    favoriteTag: '',
    history: [],
    historySearch: '',
    historyWorkspace: '',
    stats: null,
    backups: [],
    images: [],
    evaluations: null,
    drafts: emptyDrafts(),
    revs: Object.fromEntries(WORKSPACES.map((workspace) => [workspace, 0])) as Record<Workspace, number>,
    conflictWorkspace: null,
    conflictSession: null,
    loading: false,
    busy: null,
    streaming: false,

    hydrate: async () => {
      set({ loading: true })
      try {
        const [settings, models, templates, variables, categories, stats, images] = await Promise.all([
          promptOptimizerApi.getSettings(),
          promptOptimizerApi.getModels(),
          promptOptimizerApi.getTemplates(),
          promptOptimizerApi.variables(),
          promptOptimizerApi.categories(),
          promptOptimizerApi.stats(),
          promptOptimizerApi.images(),
        ])
        set({ settings, models, templates, variables, categories, stats, images })
        const workspace = get().workspace
        const session = await promptOptimizerApi.session(workspace).catch(() => null)
        const hasGroups = Array.isArray((session?.state as { testGroups?: unknown } | undefined)?.testGroups)
        const merged = withDefaultGroups(mergeDraft(workspace, session?.state), get().settings?.testGroupDefault ?? 2, hasGroups)
        set((state) => ({
          drafts: { ...state.drafts, [workspace]: merged },
          revs: { ...state.revs, [workspace]: session?.rev ?? 0 },
        }))
      } catch (error) {
        toast(errorText(error), 'error')
      } finally {
        set({ loading: false })
      }
    },

    setActiveView: async (view) => {
      set({ activeView: view })
      const workspace = WORKSPACES.includes(view as Workspace) ? (view as Workspace) : null
      if (workspace) await get().setWorkspace(workspace)
      else if (view === 'favorites') await get().refreshFavorites()
      else if (view === 'history') await get().refreshHistory()
      else if (view === 'settings') {
        await Promise.all([get().refreshSettings(), get().refreshBackups(), get().refreshStats()])
      }
    },

    setWorkspace: async (workspace, draftOverride) => {
      const current = get().workspace
      const draft = get().drafts[current]
      if (get().settings?.autosaveDrafts !== false) {
        schedulePersist(current, get().revs[current] ?? 0, draft as unknown as Record<string, unknown>)
      }
      set({ workspace, activeView: workspace })
      navigateToAddress('/tools/prompt_optimizer', `view=${workspace}`)
      const settings = get().settings
      if (!settings) return
      const session = await promptOptimizerApi.session(workspace).catch(() => null)
      const hasGroups = Array.isArray((session?.state as { testGroups?: unknown } | undefined)?.testGroups)
      const state = withDefaultGroups(mergeDraft(workspace, session?.state), settings.testGroupDefault, hasGroups)
      const templateId = state.templateId || settings.templateSelection[workspace] || ''
      const modelId = state.modelId || settings.workspaceModelSelection[workspace] || settings.defaultTextModelId
      const next = { ...state, templateId, modelId, ...(draftOverride ?? {}) }
      const rev = session?.rev ?? 0
      set((s) => ({
        drafts: { ...s.drafts, [workspace]: next },
        revs: { ...s.revs, [workspace]: rev },
      }))
      // A caller-supplied override (favorite reuse, history open) must win over the persisted
      // session and be written back immediately, otherwise the next workspace load replaces it.
      if (draftOverride && settings.autosaveDrafts !== false) {
        schedulePersist(workspace, rev, next as unknown as Record<string, unknown>)
      }
    },

    updateDraft: (patch) => {
      const workspace = get().workspace
      patchDraft(workspace, patch)
      const settings = get().settings
      if (!settings || (patch.templateId === undefined && patch.modelId === undefined)) return
      // Remember the per-workspace template/model choice so a fresh browser restores it even before
      // the workspace session arrives.
      const templateSelection = patch.templateId === undefined
        ? settings.templateSelection
        : { ...settings.templateSelection, [workspace]: patch.templateId }
      const workspaceModelSelection = patch.modelId === undefined
        ? settings.workspaceModelSelection
        : { ...settings.workspaceModelSelection, [workspace]: patch.modelId }
      set({ settings: { ...settings, templateSelection, workspaceModelSelection } })
      void promptOptimizerApi.saveSettings({ templateSelection, workspaceModelSelection }).catch(() => {
        // The draft itself is persisted; a failed default selection must not interrupt editing.
      })
    },

    persistWorkspace: () => {
      const workspace = get().workspace
      if (get().settings?.autosaveDrafts === false) return
      schedulePersist(workspace, get().revs[workspace] ?? 0, get().drafts[workspace] as unknown as Record<string, unknown>)
    },

    reloadWorkspace: async () => {
      const workspace = get().workspace
      const session = await promptOptimizerApi.session(workspace).catch(() => null)
      set((s) => ({
        drafts: { ...s.drafts, [workspace]: mergeDraft(workspace, session?.state) },
        revs: { ...s.revs, [workspace]: session?.rev ?? 0 },
        conflictWorkspace: null,
        conflictSession: null,
      }))
    },

    optimize: async (stream) => {
      const state = get()
      const workspace = state.workspace
      const draft = state.drafts[workspace]
      const selectedContent = workspace === 'pro_multi' && draft.selectedMessageId
        ? draft.messages.find((message) => message.id === draft.selectedMessageId)?.content ?? ''
        : ''
      const prompt = selectedContent || draft.prompt
      if (!prompt.trim()) {
        toast(t('tools.prompt_optimizer.errors.bad_request').replace('{message}', 'prompt'), 'warning')
        return
      }
      const variables = Object.fromEntries(state.variables.map((variable) => [variable.name, variable.value]))
      const missing = missingVariables(prompt, variables)
      if (missing.length) toast(t('tools.prompt_optimizer.variables.missing').replace('{names}', missing.join(', ')), 'warning')
      // Defined variables become their real values in the text the model reads; an undefined
      // placeholder stays literal so the reader can see what is still missing.
      const replacedPrompt = applyVariables(prompt, variables)
      const request = {
        workspace,
        prompt: replacedPrompt,
        ...(draft.templateId ? { templateId: draft.templateId } : {}),
        ...(draft.modelId ? { modelId: draft.modelId } : {}),
        messages: draft.messages.map((message) => ({ ...message, content: applyVariables(message.content, variables) })),
        selectedMessageId: draft.selectedMessageId,
        tools: draft.tools,
        images: draft.imageIds.map((id) => ({ id })),
        variables,
      }
      set({ busy: 'optimize', streaming: stream })
      if (stream) {
        const controller = new AbortController()
        optimizeAbort = controller
        let text = ''
        try {
          await promptOptimizerApi.optimizeStream(request as never, {
            onText: (delta) => {
              text += delta
              patchDraft(workspace, { optimized: text })
            },
            onDone: (payload) => {
              patchDraft(workspace, {
                optimized: payload.text,
                chainId: payload.record.chainId,
                versions: [payload.record],
                usage: payload.usage,
              })
              set({ busy: null, streaming: false })
              toast(t('tools.prompt_optimizer.workspace.optimize_done'), 'success')
              void get().refreshStats()
            },
            onError: (message) => {
              set({ busy: null, streaming: false })
              toast(message, 'error')
            },
          }, controller.signal)
        } catch (error) {
          set({ busy: null, streaming: false })
          if (!controller.signal.aborted) toast(errorText(error), 'error')
        } finally {
          optimizeAbort = null
        }
        return
      }
      try {
        const result = await promptOptimizerApi.optimize(request as never)
        patchDraft(workspace, { optimized: result.text, chainId: result.record.chainId, versions: [result.record], usage: result.usage })
        toast(t('tools.prompt_optimizer.workspace.optimize_done'), 'success')
        void get().refreshStats()
      } catch (error) {
        toast(errorText(error), 'error')
      } finally {
        set({ busy: null, streaming: false })
      }
    },

    stop: () => {
      optimizeAbort?.abort()
      set({ busy: null, streaming: false })
    },

    analyze: async () => {
      const state = get()
      const draft = state.drafts[state.workspace]
      if (!draft.prompt.trim()) {
        toast(t('tools.prompt_optimizer.errors.bad_request').replace('{message}', 'prompt'), 'warning')
        return
      }
      set({ busy: 'analyze' })
      try {
        const result = await promptOptimizerApi.analyze({
          workspace: state.workspace,
          prompt: draft.prompt,
          ...(draft.modelId ? { modelId: draft.modelId } : {}),
          ...(draft.templateId ? { templateId: draft.templateId } : {}),
        })
        patchDraft(state.workspace, { analysis: result.text })
        toast(t('tools.prompt_optimizer.workspace.analysis'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      } finally {
        set({ busy: null })
      }
    },

    iterate: async () => {
      const state = get()
      const draft = state.drafts[state.workspace]
      if (!draft.optimized.trim() || !draft.chainId) {
        toast(t('tools.prompt_optimizer.errors.bad_request').replace('{message}', 'iterate'), 'warning')
        return
      }
      if (!draft.iterateInput.trim()) {
        toast(t('tools.prompt_optimizer.errors.bad_request').replace('{message}', 'iterate'), 'warning')
        return
      }
      set({ busy: 'iterate' })
      const variables = Object.fromEntries(state.variables.map((variable) => [variable.name, variable.value]))
      const missing = missingVariables(`${draft.optimized}\n${draft.iterateInput}`, variables)
      if (missing.length) toast(t('tools.prompt_optimizer.variables.missing').replace('{names}', missing.join(', ')), 'warning')
      try {
        const result = await promptOptimizerApi.iterate({
          chainId: draft.chainId,
          lastOptimizedPrompt: applyVariables(draft.optimized, variables),
          iterateInput: applyVariables(draft.iterateInput, variables),
          workspace: state.workspace,
          ...(draft.templateId ? { templateId: draft.templateId } : {}),
          ...(draft.modelId ? { modelId: draft.modelId } : {}),
        })
        patchDraft(state.workspace, {
          optimized: result.text,
          versions: [...draft.versions, result.record],
          iterateInput: '',
          usage: result.usage,
        })
        toast(t('tools.prompt_optimizer.workspace.iterate_done'), 'success')
        void get().refreshStats()
      } catch (error) {
        toast(errorText(error), 'error')
      } finally {
        set({ busy: null })
      }
    },

    runTest: async (groupIds) => {
      const state = get()
      const draft = state.drafts[state.workspace]
      if (!draft.optimized.trim()) {
        toast(t('tools.prompt_optimizer.errors.bad_request').replace('{message}', 'test'), 'warning')
        return
      }
      const targets = draft.testGroups.filter((group) => !groupIds || groupIds.includes(group.id))
      if (!targets.length) return
      set({ busy: 'test' })
      const variables = Object.fromEntries(state.variables.map((variable) => [variable.name, variable.value]))
      try {
        if (state.workspace === 'pro_multi') {
          const messages = draft.messages.map((message) => ({
            ...message,
            content: message.role === 'system' ? draft.optimized : message.content,
          }))
          const result = await promptOptimizerApi.testConversation({
            messages: messages.map((message) => ({ ...message, content: applyVariables(message.content, variables) })),
            variables,
            tools: draft.tools,
            ...(draft.modelId ? { modelId: draft.modelId } : {}),
          } as never)
          patchDraft(state.workspace, {
            testOutput: result.text,
            testReasoning: result.reasoning,
            testGroups: draft.testGroups.map((group) => ({ ...group, output: result.text, reasoning: result.reasoning, toolCalls: result.toolCalls, status: 'done' })),
          })
        } else {
          const results: TestGroup[] = []
          for (const group of targets) {
            try {
              const groupPrompt = group.variant === 'baseline' ? draft.prompt : draft.optimized
              const result = await promptOptimizerApi.test({
                workspace: state.workspace,
                system: state.workspace === 'basic_system' ? applyVariables(groupPrompt, variables) : '',
                user: group.input || (state.workspace === 'basic_system' ? '' : applyVariables(groupPrompt, variables)),
                ...(group.modelId || draft.modelId ? { modelId: group.modelId || draft.modelId } : {}),
                tools: undefined,
              })
              results.push({ ...group, output: result.text, reasoning: result.reasoning, toolCalls: result.toolCalls, status: 'done' })
            } catch (error) {
              results.push({ ...group, output: errorText(error), reasoning: '', toolCalls: [], status: 'failed' })
            }
          }
          patchDraft(state.workspace, {
            testGroups: draft.testGroups.map((group) => results.find((result) => result.id === group.id) ?? group),
            testOutput: results[0]?.output ?? draft.testOutput,
            testReasoning: results[0]?.reasoning ?? draft.testReasoning,
          })
        }
        toast(t('tools.prompt_optimizer.workspace.test_done'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      } finally {
        set({ busy: null })
      }
    },

    evaluate: async (type) => {
      const state = get()
      const draft = state.drafts[state.workspace]
      if (!draft.optimized.trim()) {
        toast(t('tools.prompt_optimizer.errors.bad_request').replace('{message}', 'evaluate'), 'warning')
        return
      }
      if (type === 'compare' && draft.testGroups.filter((group) => group.output.trim()).length < 2) {
        toast(t('tools.prompt_optimizer.evaluation.compare_hint'), 'warning')
        return
      }
      set({ busy: 'evaluate' })
      try {
        const compare = type === 'compare' || type === 'structured'
          ? draft.testGroups.filter((group) => group.output.trim()).map((group, index) => ({
              label: t('tools.prompt_optimizer.workspace.test_label').replace('{index}', String(index + 1)),
              prompt: group.variant === 'baseline' ? draft.prompt : draft.optimized,
              input: group.input,
              variant: group.variant,
              output: group.output,
              modelLabel: group.modelId || draft.modelId,
            }))
          : undefined
        // The result/evaluation fallback follows the candidate run, not whichever group happens to be
        // first in the list (the default first group is the baseline).
        const primary = draft.testGroups.find((group) => group.variant === 'candidate' && group.output.trim())
          ?? draft.testGroups.find((group) => group.output.trim())
          ?? draft.testGroups[0]
        const result = await promptOptimizerApi.evaluate({
          workspace: state.workspace,
          type,
          originalPrompt: draft.prompt,
          optimizedPrompt: draft.optimized,
          testInput: primary?.input ?? '',
          testOutput: primary?.output ?? draft.testOutput,
          focus: draft.focus,
          ...(draft.modelId ? { modelId: draft.modelId } : {}),
          ...(compare?.length ? { compare } : {}),
        } as never)
        set({ evaluations: result })
        toast(
          result.score === null
            ? t('tools.prompt_optimizer.evaluation.done')
            : t('tools.prompt_optimizer.evaluation.result_score').replace('{score}', String(result.score)),
          'success',
        )
      } catch (error) {
        toast(errorText(error), 'error')
      } finally {
        set({ busy: null })
      }
    },

    rewrite: async () => {
      const state = get()
      const draft = state.drafts[state.workspace]
      const evaluation = state.evaluations
      if (!draft.optimized.trim()) {
        toast(t('tools.prompt_optimizer.errors.bad_request').replace('{message}', 'prompt'), 'warning')
        return
      }
      if (!evaluation?.raw) {
        toast(t('tools.prompt_optimizer.errors.bad_request').replace('{message}', 'evaluate'), 'warning')
        return
      }
      set({ busy: 'rewrite' })
      try {
        const result = await promptOptimizerApi.rewrite({
          workspace: state.workspace,
          originalPrompt: draft.prompt,
          optimizedPrompt: draft.optimized,
          feedback: evaluation.raw,
          ...(draft.modelId ? { modelId: draft.modelId } : {}),
        })
        patchDraft(state.workspace, { optimized: result.text })
        toast(t('tools.prompt_optimizer.workspace.rewrite'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      } finally {
        set({ busy: null })
      }
    },

    useVersion: (record) => {
      patchDraft(get().workspace, { optimized: record.optimizedPrompt })
    },

    loadChain: (chain) => {
      const workspace = chain.currentRecord.workspace
      void get().setWorkspace(workspace, {
        prompt: chain.rootRecord.originalPrompt,
        optimized: chain.currentRecord.optimizedPrompt,
        chainId: chain.chainId,
        versions: chain.versions,
      })
    },

    setFavoriteSearch: async (search) => {
      set({ favoriteSearch: search })
      await get().refreshFavorites()
    },
    setFavoriteCategory: async (category) => {
      set({ favoriteCategory: category })
      await get().refreshFavorites()
    },
    setFavoriteTag: async (tag) => {
      set({ favoriteTag: tag })
      await get().refreshFavorites()
    },
    refreshFavorites: async () => {
      try {
        const favorites = await promptOptimizerApi.favorites({
          search: get().favoriteSearch,
          category: get().favoriteCategory,
          tag: get().favoriteTag,
        })
        set({ favorites })
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    saveFavorite: async (input, id) => {
      try {
        if (id) await promptOptimizerApi.updateFavorite(id, input)
        else await promptOptimizerApi.createFavorite(input)
        await get().refreshFavorites()
        toast(t('tools.prompt_optimizer.favorites.saved'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    deleteFavorite: async (id) => {
      try {
        await promptOptimizerApi.deleteFavorite(id)
        await get().refreshFavorites()
        toast(t('tools.prompt_optimizer.common.delete'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    refreshCategories: async () => {
      try {
        set({ categories: await promptOptimizerApi.categories() })
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    saveCategory: async (input, id) => {
      try {
        if (id) await promptOptimizerApi.updateCategory(id, input)
        else await promptOptimizerApi.createCategory(input)
        await get().refreshCategories()
        toast(t(id ? 'tools.prompt_optimizer.favorites.category_updated' : 'tools.prompt_optimizer.favorites.category_added'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    deleteCategory: async (id) => {
      try {
        await promptOptimizerApi.deleteCategory(id)
        await get().refreshCategories()
        await get().refreshFavorites()
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },

    refreshVariables: async () => {
      try {
        set({ variables: await promptOptimizerApi.variables() })
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    saveVariable: async (input) => {
      try {
        await promptOptimizerApi.saveVariable(input)
        await get().refreshVariables()
        toast(t('tools.prompt_optimizer.variables.saved'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    importVariables: async (items) => {
      let count = 0
      try {
        for (const item of items) {
          await promptOptimizerApi.saveVariable(item)
          count += 1
        }
        await get().refreshVariables()
        toast(t('tools.prompt_optimizer.variables.imported').replace('{count}', String(count)), 'success')
        return count
      } catch (error) {
        toast(errorText(error), 'error')
        return count
      }
    },
    deleteVariable: async (name) => {
      try {
        await promptOptimizerApi.deleteVariable(name)
        await get().refreshVariables()
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    extractVariables: async () => {
      const state = get()
      const draft = state.drafts[state.workspace]
      if (!draft.prompt.trim()) {
        toast(t('tools.prompt_optimizer.errors.bad_request').replace('{message}', 'prompt'), 'warning')
        return
      }
      set({ busy: 'variables' })
      try {
        const result = await promptOptimizerApi.extractVariables(draft.prompt, draft.modelId || undefined)
        const existing = new Set(state.variables.map((variable) => variable.name))
        const added: VariableEntry[] = []
        for (const variable of result.variables) {
          if (existing.has(variable.name) || variableNames(draft.prompt).includes(variable.name)) continue
          added.push(await promptOptimizerApi.saveVariable({
            name: variable.name,
            value: variable.sampleValue,
            description: variable.description,
          }))
        }
        await get().refreshVariables()
        toast(added.length ? t('tools.prompt_optimizer.variables.extracted').replace('{count}', String(added.length)) : t('tools.prompt_optimizer.variables.none_extracted'), added.length ? 'success' : 'default')
      } catch (error) {
        toast(errorText(error), 'error')
      } finally {
        set({ busy: null })
      }
    },
    generateVariableValues: async (names) => {
      const state = get()
      const draft = state.drafts[state.workspace]
      const selected = state.variables.filter((variable) => names.includes(variable.name))
      if (!selected.length) return
      set({ busy: 'variables' })
      try {
        const result = await promptOptimizerApi.generateVariables(
          draft.prompt,
          selected.map((variable) => ({ name: variable.name, description: variable.description })),
          draft.modelId || undefined,
        )
        for (const [name, value] of Object.entries(result.values)) {
          await promptOptimizerApi.saveVariable({ name, value, description: selected.find((entry) => entry.name === name)?.description ?? '' })
        }
        await get().refreshVariables()
        toast(t('tools.prompt_optimizer.variables.saved'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      } finally {
        set({ busy: null })
      }
    },

    refreshTemplates: async () => {
      try {
        set({ templates: await promptOptimizerApi.getTemplates() })
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    saveTemplate: async (template, editing) => {
      try {
        if (editing) await promptOptimizerApi.saveTemplate(template)
        else await promptOptimizerApi.createTemplate(template)
        await get().refreshTemplates()
        toast(t('tools.prompt_optimizer.templates.saved'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    deleteTemplate: async (id) => {
      try {
        await promptOptimizerApi.deleteTemplate(id)
        await get().refreshTemplates()
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },

    refreshHistory: async () => {
      try {
        set({ history: await promptOptimizerApi.history(get().historySearch, get().historyWorkspace) })
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    setHistorySearch: async (search) => {
      set({ historySearch: search })
      await get().refreshHistory()
    },
    setHistoryWorkspace: async (workspace) => {
      set({ historyWorkspace: workspace })
      await get().refreshHistory()
    },
    deleteChain: async (chainId) => {
      try {
        await promptOptimizerApi.deleteChain(chainId)
        await get().refreshHistory()
        toast(t('tools.prompt_optimizer.common.delete'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    clearHistory: async () => {
      try {
        await promptOptimizerApi.clearHistory()
        await get().refreshHistory()
        toast(t('tools.prompt_optimizer.common.delete'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },

    refreshSettings: async () => {
      try {
        const settings = await promptOptimizerApi.getSettings()
        set({ settings })
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    saveSettings: async (patch) => {
      try {
        const settings = await promptOptimizerApi.saveSettings(patch)
        set({ settings })
        toast(t('tools.prompt_optimizer.settings.saved'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },

    refreshBackups: async () => {
      try {
        set({ backups: await promptOptimizerApi.backups() })
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    createBackup: async () => {
      try {
        await promptOptimizerApi.createBackup()
        await get().refreshBackups()
        toast(t('tools.prompt_optimizer.settings.backup_created'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    restoreBackup: async (id) => {
      try {
        await promptOptimizerApi.restoreBackup(id)
        await Promise.all([get().hydrate(), get().refreshHistory(), get().refreshBackups()])
        toast(t('tools.prompt_optimizer.settings.restored'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    deleteBackup: async (id) => {
      try {
        await promptOptimizerApi.deleteBackup(id)
        await get().refreshBackups()
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },

    refreshImages: async () => {
      try {
        set({ images: await promptOptimizerApi.images() })
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    uploadImage: async (dataUrl, kind = 'image', prompt = '') => {
      try {
        const asset = await promptOptimizerApi.uploadImage(dataUrl, kind, prompt)
        await get().refreshImages()
        toast(t('tools.prompt_optimizer.image.uploaded'), 'success')
        return asset
      } catch (error) {
        toast(errorText(error), 'error')
        return null
      }
    },
    generateImage: async (prompt, size) => {
      try {
        const asset = await promptOptimizerApi.generateImage(prompt, size, get().settings?.imageModelId || undefined)
        await get().refreshImages()
        toast(t('tools.prompt_optimizer.image.generated'), 'success')
        return asset
      } catch (error) {
        toast(errorText(error), 'error')
        return null
      }
    },
    understandImage: async (imageId) => {
      try {
        const workspace = get().workspace
        const draft = get().drafts[workspace]
        const result = await promptOptimizerApi.understandImage(
          imageId,
          workspace === 'image_image2image' || workspace === 'image_multiimage' ? 'image2image' : 'text2image',
          draft.prompt,
          get().settings?.imageRecognitionModelId || undefined,
        )
        return result.text
      } catch (error) {
        toast(errorText(error), 'error')
        return null
      }
    },
    deleteImage: async (id) => {
      try {
        await promptOptimizerApi.deleteImage(id)
        await get().refreshImages()
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },

    refreshStats: async () => {
      try {
        set({ stats: await promptOptimizerApi.stats() })
      } catch {
        // Stats are a convenience; a failure must not interrupt the editor.
      }
    },

    exportData: async (format, scope) => {
      try {
        const state = get()
        const filter = scope === 'history'
          ? { search: state.historySearch, workspace: state.historyWorkspace }
          : undefined
        const file = await promptOptimizerApi.exportData(format, scope ?? 'all', filter)
        const blob = new Blob([file.text], { type: file.contentType })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = file.filename
        link.click()
        URL.revokeObjectURL(url)
        toast(t('tools.prompt_optimizer.common.export'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    importData: async (document) => {
      try {
        const result = await promptOptimizerApi.importData(document)
        const total = Object.values(result.imported).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0)
        await Promise.all([get().hydrate(), get().refreshHistory(), get().refreshStats()])
        toast(t('tools.prompt_optimizer.settings.imported_count').replace('{count}', String(total)), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
    clearAll: async () => {
      try {
        await promptOptimizerApi.clear()
        await Promise.all([get().hydrate(), get().refreshHistory(), get().refreshStats()])
        toast(t('tools.prompt_optimizer.common.delete'), 'success')
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },

    dismissConflict: () => set({ conflictWorkspace: null, conflictSession: null }),
    overwriteConflict: async () => {
      const workspace = get().workspace
      const session = get().conflictSession
      if (!session) return
      try {
        const result = await promptOptimizerApi.saveSession(workspace, session.rev, get().drafts[workspace] as unknown as Record<string, unknown>)
        if ('conflict' in result) {
          set({ conflictSession: result.current })
          toast(t('tools.prompt_optimizer.common.conflict'), 'warning')
        } else {
          set((state) => ({ revs: { ...state.revs, [workspace]: result.rev }, conflictWorkspace: null, conflictSession: null }))
        }
      } catch (error) {
        toast(errorText(error), 'error')
      }
    },
  }
})


export function promptOptimizerViewFromSearch(search: string): PromptOptimizerNavView | null {
  const candidate = new URLSearchParams(search).get('view')
  if (!candidate) return null
  return PROMPT_OPTIMIZER_NAV_VIEWS.includes(candidate as PromptOptimizerNavView) ? (candidate as PromptOptimizerNavView) : null
}


export type { EvaluateResult, ModelCatalogue }
