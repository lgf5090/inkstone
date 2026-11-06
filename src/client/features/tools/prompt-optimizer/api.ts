/**
 * Client for `/api/tools/prompt-optimizer/*`.
 */

import type { AssistantModel } from '@shared/assistant'
import type {
  ArenaState,
  AssetRecord,
  BackupRecord,
  ContextPackage,
  EvaluationOutcome,
  EvaluationRecord,
  FavoriteCategory,
  FavoritePrompt,
  FavoriteStats,
  FavoriteVersion,
  PromptOptimizerSettings,
  PromptOptimizerStats,
  PromptRecord,
  PromptRecordChain,
  PromptTemplate,
  TestResult,
  VariableEntry,
  Workspace,
  WorkspaceSession,
} from '@shared/tools/prompt-optimizer/types'
import type {
  ArenaSaveInput,
  CategoryInput,
  ContextInput,
  ConversationTestRequest,
  EvaluateRequest,
  FavoriteInput,
  OptimizeRequest,
  SettingsPatch,
  TestRequest,
  VariableInput,
} from '@shared/tools/prompt-optimizer/schemas'
import { ApiError, request } from '../../../lib/api'
import { CLIENT_HEADER } from '@shared/constants'

export interface ModelCatalogue {
  text: AssistantModel[]
  image: AssistantModel[]
  activeModelId: string
}

export interface TemplateCatalogue {
  builtin: PromptTemplate[]
  user: PromptTemplate[]
}

export interface EvaluateResult extends EvaluationOutcome {
  evaluation: EvaluationRecord
}

export interface OptimizeResponse {
  text: string
  modelLabel: string
  modelId: string
  templateId: string
  record: PromptRecord
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheMissTokens: number }
}

export interface IterateResponse {
  text: string
  modelLabel: string
  modelId: string
  templateId: string
  record: PromptRecord
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheMissTokens: number }
}

export const promptOptimizerApi = {
  getSettings: () => request<{ data: PromptOptimizerSettings }>('/api/tools/prompt-optimizer/settings').then((r) => r.data),
  saveSettings: (patch: SettingsPatch) =>
    request<{ data: PromptOptimizerSettings }>('/api/tools/prompt-optimizer/settings', { method: 'PUT', body: patch }).then((r) => r.data),
  getModels: () => request<{ data: ModelCatalogue }>('/api/tools/prompt-optimizer/models').then((r) => r.data),
  getTemplates: (type?: string) =>
    request<{ data: TemplateCatalogue }>(`/api/tools/prompt-optimizer/templates${type ? `?type=${encodeURIComponent(type)}` : ''}`).then((r) => r.data),
  getTemplate: (id: string) => request<{ data: PromptTemplate }>(`/api/tools/prompt-optimizer/templates/${encodeURIComponent(id)}`).then((r) => r.data),
  saveTemplate: (template: PromptTemplate) =>
    request<{ data: PromptTemplate }>(`/api/tools/prompt-optimizer/templates/${encodeURIComponent(template.id)}`, { method: 'PUT', body: template }).then((r) => r.data),
  createTemplate: (template: PromptTemplate) =>
    request<{ data: PromptTemplate }>('/api/tools/prompt-optimizer/templates', { method: 'POST', body: template }).then((r) => r.data),
  deleteTemplate: (id: string) =>
    request<{ data: { deleted: true } }>(`/api/tools/prompt-optimizer/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  importTemplates: (templates: PromptTemplate[]) =>
    request<{ data: { imported: number; templates: PromptTemplate[] } }>('/api/tools/prompt-optimizer/templates/import', { method: 'POST', body: { templates } }).then((r) => r.data),
  exportTemplate: (id: string) =>
    request<{ data: { filename: string; document: PromptTemplate } }>(`/api/tools/prompt-optimizer/templates/${encodeURIComponent(id)}/export`).then((r) => r.data),
  history: (search = '', workspace = '') => {
    const query = new URLSearchParams()
    if (search) query.set('search', search)
    if (workspace) query.set('workspace', workspace)
    return request<{ data: { chains: PromptRecordChain[] } }>(`/api/tools/prompt-optimizer/history${query.size ? `?${query}` : ''}`).then((r) => r.data.chains)
  },
  deleteChain: (chainId: string) => request<{ data: { deleted: true } }>(`/api/tools/prompt-optimizer/history/${encodeURIComponent(chainId)}`, { method: 'DELETE' }),
  clearHistory: () => request<{ data: { cleared: true } }>('/api/tools/prompt-optimizer/history/clear', { method: 'POST' }),
  optimize: (body: OptimizeRequest) => request<{ data: OptimizeResponse }>('/api/tools/prompt-optimizer/optimize', { method: 'POST', body }).then((r) => r.data),
  optimizeStream: async (body: OptimizeRequest, handlers: {
    onText: (delta: string) => void
    onDone: (payload: { text: string; record: PromptRecord; usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheMissTokens: number } }) => void
    onError: (message: string) => void
  }, signal: AbortSignal) => {
    const response = await fetch('/api/tools/prompt-optimizer/optimize/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' },
      body: JSON.stringify(body),
      signal,
      credentials: 'same-origin',
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(text || `Request failed (${response.status})`)
    }
    if (!response.body) throw new Error('The stream had no body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const line = frame.trim()
        if (!line.startsWith('data:')) continue
        const payload = JSON.parse(line.slice(5).trim()) as
          | { type: 'text'; delta: string }
          | { type: 'done'; text: string; record: PromptRecord; usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheMissTokens: number } }
          | { type: 'error'; message: string }
        if (payload.type === 'text') handlers.onText(payload.delta)
        else if (payload.type === 'done') handlers.onDone(payload)
        else handlers.onError(payload.message)
      }
    }
  },
  analyze: (body: { workspace: Workspace; prompt: string; modelId?: string; templateId?: string }) =>
    request<{ data: { text: string; modelLabel: string; usage: { inputTokens: number; outputTokens: number } } }>('/api/tools/prompt-optimizer/analyze', { method: 'POST', body }).then((r) => r.data),
  iterate: (body: { chainId: string; lastOptimizedPrompt: string; iterateInput: string; workspace: Workspace; templateId?: string; modelId?: string }) =>
    request<{ data: IterateResponse }>('/api/tools/prompt-optimizer/iterate', { method: 'POST', body }).then((r) => r.data),
  test: (body: TestRequest, signal?: AbortSignal) => request<{ data: TestResult }>('/api/tools/prompt-optimizer/test', { method: 'POST', body, signal }).then((r) => r.data),
  testConversation: (body: ConversationTestRequest) =>
    request<{ data: TestResult }>('/api/tools/prompt-optimizer/test/conversation', { method: 'POST', body }).then((r) => r.data),
  evaluate: (body: EvaluateRequest) => request<{ data: EvaluateResult }>('/api/tools/prompt-optimizer/evaluate', { method: 'POST', body }).then((r) => r.data),
  rewrite: (body: { workspace: Workspace; originalPrompt: string; optimizedPrompt: string; feedback: string; modelId?: string }) =>
    request<{ data: { text: string; modelLabel: string } }>('/api/tools/prompt-optimizer/evaluate/rewrite', { method: 'POST', body }).then((r) => r.data),
  variables: () => request<{ data: VariableEntry[] }>('/api/tools/prompt-optimizer/variables').then((r) => r.data),
  saveVariable: (input: VariableInput) => request<{ data: VariableEntry }>('/api/tools/prompt-optimizer/variables', { method: 'POST', body: input }).then((r) => r.data),
  deleteVariable: (name: string) => request<{ data: { deleted: true } }>(`/api/tools/prompt-optimizer/variables/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  extractVariables: (prompt: string, modelId?: string) =>
    request<{ data: { variables: { name: string; description: string; sampleValue: string }[]; summary: string } }>('/api/tools/prompt-optimizer/variables/extract', { method: 'POST', body: { prompt, ...(modelId ? { modelId } : {}) } }).then((r) => r.data),
  generateVariables: (prompt: string, variables: { name: string; description: string }[], modelId?: string) =>
    request<{ data: { values: Record<string, string> } }>('/api/tools/prompt-optimizer/variables/generate', { method: 'POST', body: { prompt, variables, ...(modelId ? { modelId } : {}) } }).then((r) => r.data),
  favorites: (query: { search?: string; category?: string; tag?: string } = {}) => {
    const params = new URLSearchParams()
    if (query.search) params.set('search', query.search)
    if (query.category) params.set('category', query.category)
    if (query.tag) params.set('tag', query.tag)
    return request<{ data: FavoritePrompt[] }>(`/api/tools/prompt-optimizer/favorites${params.size ? `?${params}` : ''}`).then((r) => r.data)
  },
  favoriteStats: () => request<{ data: FavoriteStats }>('/api/tools/prompt-optimizer/favorites/stats').then((r) => r.data),
  favorite: (id: string) => request<{ data: { favorite: FavoritePrompt; versions: FavoriteVersion[] } }>(`/api/tools/prompt-optimizer/favorites/${encodeURIComponent(id)}`).then((r) => r.data),
  createFavorite: (input: FavoriteInput) => request<{ data: FavoritePrompt }>('/api/tools/prompt-optimizer/favorites', { method: 'POST', body: input }).then((r) => r.data),
  updateFavorite: (id: string, input: FavoriteInput) => request<{ data: FavoritePrompt }>(`/api/tools/prompt-optimizer/favorites/${encodeURIComponent(id)}`, { method: 'PUT', body: input }).then((r) => r.data),
  deleteFavorite: (id: string) => request<{ data: { deleted: true } }>(`/api/tools/prompt-optimizer/favorites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  useFavorite: (id: string) => request<{ data: { used: true } }>(`/api/tools/prompt-optimizer/favorites/${encodeURIComponent(id)}/use`, { method: 'POST' }),
  categories: () => request<{ data: FavoriteCategory[] }>('/api/tools/prompt-optimizer/categories').then((r) => r.data),
  createCategory: (input: CategoryInput) => request<{ data: FavoriteCategory }>('/api/tools/prompt-optimizer/categories', { method: 'POST', body: input }).then((r) => r.data),
  updateCategory: (id: string, input: CategoryInput) => request<{ data: FavoriteCategory }>(`/api/tools/prompt-optimizer/categories/${encodeURIComponent(id)}`, { method: 'PUT', body: input }).then((r) => r.data),
  deleteCategory: (id: string) => request<{ data: { deleted: true } }>(`/api/tools/prompt-optimizer/categories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  contexts: () => request<{ data: ContextPackage[] }>('/api/tools/prompt-optimizer/contexts').then((r) => r.data),
  createContext: (input: ContextInput) => request<{ data: ContextPackage }>('/api/tools/prompt-optimizer/contexts', { method: 'POST', body: input }).then((r) => r.data),
  deleteContext: (id: string) => request<{ data: { deleted: true } }>(`/api/tools/prompt-optimizer/contexts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  session: (workspace: Workspace) => request<{ data: WorkspaceSession | null }>(`/api/tools/prompt-optimizer/sessions/${workspace}`).then((r) => r.data),
  saveSession: async (workspace: Workspace, rev: number, state: Record<string, unknown>) => {
    try {
      return await request<{ data: WorkspaceSession }>(`/api/tools/prompt-optimizer/sessions/${workspace}`, { method: 'PUT', body: { rev, state } }).then((r) => r.data)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const details = error.details as { conflict?: boolean; current?: WorkspaceSession } | undefined
        if (details?.conflict && details.current) return { conflict: true as const, current: details.current }
      }
      throw error
    }
  },
  arena: () => request<{ data: ArenaState | null }>('/api/tools/prompt-optimizer/arena').then((r) => r.data),
  saveArena: (input: ArenaSaveInput) => request<{ data: { saved: true } }>('/api/tools/prompt-optimizer/arena', { method: 'PUT', body: input }),
  images: () => request<{ data: AssetRecord[] }>('/api/tools/prompt-optimizer/images').then((r) => r.data),
  uploadImage: (dataUrl: string, kind: 'image' = 'image', prompt = '') =>
    request<{ data: AssetRecord }>('/api/tools/prompt-optimizer/images', { method: 'POST', body: { dataUrl, kind, prompt } }).then((r) => r.data),
  deleteImage: (id: string) => request<{ data: { deleted: true } }>(`/api/tools/prompt-optimizer/images/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  generateImage: (prompt: string, size?: string, modelId?: string, kind: 'image' = 'image') =>
    request<{ data: AssetRecord }>('/api/tools/prompt-optimizer/images/generate', { method: 'POST', body: { prompt, ...(size ? { size } : {}), ...(modelId ? { modelId } : {}), kind } }).then((r) => r.data),
  understandImage: (imageId: string, mode: 'text2image' | 'image2image', originalPrompt: string, modelId?: string) =>
    request<{ data: { text: string; modelLabel: string } }>('/api/tools/prompt-optimizer/images/understand', {
      method: 'POST',
      body: { imageId, mode, originalPrompt, ...(modelId ? { modelId } : {}) },
    }).then((r) => r.data),
  backups: () => request<{ data: BackupRecord[] }>('/api/tools/prompt-optimizer/backups').then((r) => r.data),
  createBackup: () => request<{ data: BackupRecord }>('/api/tools/prompt-optimizer/backups', { method: 'POST' }).then((r) => r.data),
  restoreBackup: (id: string) => request<{ data: { imported: Record<string, number> } }>(`/api/tools/prompt-optimizer/backups/${encodeURIComponent(id)}/restore`, { method: 'POST' }).then((r) => r.data),
  deleteBackup: (id: string) => request<{ data: { deleted: true } }>(`/api/tools/prompt-optimizer/backups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  exportData: (format: 'json' | 'txt' = 'json', scope: 'all' | 'history' | 'favorites' = 'all', filter?: { search?: string; workspace?: string }) => {
    const params = new URLSearchParams({ format, scope })
    if (filter?.search) params.set('search', filter.search)
    if (filter?.workspace) params.set('workspace', filter.workspace)
    return request<{ data: { filename: string; contentType: string; text: string } }>(`/api/tools/prompt-optimizer/export?${params}`, { method: 'POST' }).then((r) => r.data)
  },
  importData: (document: unknown) =>
    request<{ data: { imported: Record<string, number> } }>('/api/tools/prompt-optimizer/import', { method: 'POST', body: document }).then((r) => r.data),
  clear: () => request<{ data: { cleared: true } }>('/api/tools/prompt-optimizer/clear', { method: 'POST' }),
  stats: () => request<{ data: PromptOptimizerStats }>('/api/tools/prompt-optimizer/stats').then((r) => r.data),
}

