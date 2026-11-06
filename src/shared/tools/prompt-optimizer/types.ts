/**
 * Shared contracts for the Prompt Optimizer tool (`tools/PromptOptimizer`).
 *
 * The shapes mirror the reference project's core records so a ported template or history entry means
 * the same thing here, while identifiers and storage stay scoped to this module.
 */

export type OptimizationMode = 'system' | 'user'

export type FunctionMode = 'basic' | 'pro' | 'image' | 'arena'

export type Workspace =
  | 'basic_system'
  | 'basic_user'
  | 'pro_multi'
  | 'pro_variable'
  | 'image_text2image'
  | 'image_image2image'
  | 'image_multiimage'
  | 'arena'

export type PromptOptimizerNavView =
  | Workspace
  | 'favorites'
  | 'templates'
  | 'history'
  | 'settings'

export const WORKSPACES: readonly Workspace[] = [
  'basic_system',
  'basic_user',
  'pro_multi',
  'pro_variable',
  'image_text2image',
  'image_image2image',
  'image_multiimage',
  'arena',
]

export const PROMPT_OPTIMIZER_NAV_VIEWS: readonly PromptOptimizerNavView[] = [
  'basic_system',
  'basic_user',
  'pro_multi',
  'pro_variable',
  'image_text2image',
  'image_image2image',
  'image_multiimage',
  'arena',
  'favorites',
  'templates',
  'history',
  'settings',
]

export type TemplateType =
  | 'optimize'
  | 'userOptimize'
  | 'text2imageOptimize'
  | 'image2imageOptimize'
  | 'multiimageOptimize'
  | 'imageIterate'
  | 'iterate'
  | 'conversationMessageOptimize'
  | 'contextUserOptimize'
  | 'contextIterate'
  | 'contextSystemOptimize'
  | 'evaluation'
  | 'evaluation-rewrite'
  | 'evaluation-structured-compare'
  | 'variable-extraction'
  | 'variable-value-generation'
  | 'image-prompt-composition'
  | 'image-prompt-migration'

export type RecordType =
  | 'optimize'
  | 'userOptimize'
  | 'iterate'
  | 'test'
  | 'contextUserOptimize'
  | 'contextIterate'
  | 'imageOptimize'
  | 'contextImageOptimize'
  | 'imageIterate'
  | 'text2imageOptimize'
  | 'image2imageOptimize'
  | 'multiimageOptimize'
  | 'conversationMessageOptimize'

export interface MessageTemplate {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export interface TemplateMetadata {
  version: string
  lastModified: number
  author?: string
  description?: string
  templateType: TemplateType
  language?: 'zh' | 'en'
  [key: string]: unknown
}

export interface PromptTemplate {
  id: string
  name: string
  content: string | MessageTemplate[]
  metadata: TemplateMetadata
  isBuiltin?: boolean
  /** Present only on rows read from the database, where the reader owns the template. */
  userId?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface FunctionDefinition {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface ToolDefinition {
  type: 'function'
  function: FunctionDefinition
}

export interface ConversationMessage {
  id?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  originalContent?: string
  name?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface PromptRecord {
  id: string
  chainId: string
  version: number
  previousId: string | null
  recordType: RecordType
  workspace: Workspace
  originalPrompt: string
  optimizedPrompt: string
  reasoning: string
  modelId: string
  modelLabel: string
  templateId: string
  iterationNote: string
  metadata: Record<string, unknown>
  createdAt: number
}

export interface PromptRecordChain {
  chainId: string
  rootRecord: PromptRecord
  currentRecord: PromptRecord
  versions: PromptRecord[]
}

export interface FavoriteCategory {
  id: string
  name: string
  description: string
  parentId: string | null
  color: string
  sortOrder: number
  createdAt: number
}

export interface FavoriteExample {
  id: string
  label: string
  systemPrompt: string
  userPrompt: string
  output: string
  modelId: string
  modelLabel: string
  evaluation?: { score: number | null; verdict: string; feedback: string }
  createdAt: number
}

export interface FavoriteMetadata {
  originalContent?: string
  sourceHistoryId?: string
  modelId?: string
  modelLabel?: string
  templateId?: string
  origin?: 'history' | 'template' | 'import' | 'manual'
  coverAssetId?: string
  [key: string]: unknown
}

export interface FavoritePrompt {
  id: string
  title: string
  content: string
  description: string
  functionMode: string
  optimizationMode: string
  imageSubMode: string
  categoryId: string | null
  tags: string[]
  useCount: number
  metadata: FavoriteMetadata
  examples: FavoriteExample[]
  createdAt: number
  updatedAt: number
}

export interface FavoriteVersion {
  id: string
  favoriteId: string
  version: number
  title: string
  content: string
  description: string
  metadata: FavoriteMetadata
  createdAt: number
}

export interface FavoriteStats {
  total: number
  tags: { tag: string; count: number }[]
  categories: { id: string; name: string; count: number }[]
}

export interface VariableEntry {
  name: string
  value: string
  description: string
  createdAt: number
  updatedAt: number
}

export interface ContextPackage {
  id: string
  title: string
  mode: 'system' | 'user'
  messages: ConversationMessage[]
  variables: Record<string, string>
  tools: ToolDefinition[]
  tags: string[]
  description: string
  createdAt: number
  updatedAt: number
}

export interface PromptOptimizerSettings {
  defaultTextModelId: string
  evaluationModelId: string
  imageRecognitionModelId: string
  imageModelId: string
  builtinTemplateLanguage: 'zh' | 'en'
  templateSelection: Record<string, string>
  workspaceModelSelection: Record<string, string>
  historyRetentionDays: number
  autosaveDrafts: boolean
  testGroupDefault: number
  updatedAt: number
}

export interface WorkspaceSession {
  workspace: Workspace
  rev: number
  state: Record<string, unknown>
  updatedAt: number
}

export interface ArenaContestant {
  id: string
  kind: 'text' | 'image'
  modelId: string
}

export interface ArenaResult {
  runId: string
  fingerprint: string
  prompt: string
  model: ArenaContestant
  status: 'running' | 'success' | 'error' | 'cancelled'
  output: { result: string; reasoning: string; status: 'streaming' | 'complete' | 'cancelled' | 'failed' }
  images: AssetRef[]
  error?: string
  startedAt: number
  durationMs: number
}

export interface ArenaState {
  schemaVersion: 1
  prompt: string
  images: AssetRef[]
  contestants: ArenaContestant[]
  results: Record<string, ArenaResult>
  lastActiveAt: number
}

export interface AssetRef {
  id: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
}

export interface AssetRecord extends AssetRef {
  kind: 'image'
  source: 'upload' | 'generated'
  prompt: string
  createdAt: number
}

export interface EvaluationRecord {
  id: string
  workspace: string
  evaluationType: 'result' | 'compare' | 'structured' | 'prompt-only' | 'rewrite'
  score: number | null
  verdict: string
  payload: Record<string, unknown>
  recordId: string
  createdAt: number
}

export interface BackupRecord {
  id: string
  filename: string
  bytes: number
  kind: 'manual'
  createdAt: number
}

export interface PromptOptimizerStats {
  historyChains: number
  historyRecords: number
  favorites: number
  templates: number
  evaluations: number
  assets: number
  backups: number
}

export interface TimingInfo {
  durationMs: number
  modelLabel: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheMissTokens: number
}

export interface TestResult {
  text: string
  reasoning: string
  toolCalls: { id: string; name: string; arguments: string }[]
  timing: TimingInfo
}

export interface EvaluationOutcome {
  score: number | null
  verdict: string
  feedback: string
  strengths: string[]
  weaknesses: string[]
  suggestions: string[]
  comparison?: {
    winner: string
    scores: { label: string; score: number | null }[]
    synthesis: string
  }
  raw: string
  timing: TimingInfo
}

export interface ExtractedVariable {
  name: string
  description: string
  sampleValue: string
}

export const PROMPT_OPTIMIZER_LIMITS = {
  promptMaxChars: 64_000,
  historyPageSize: 50,
  historyMaxChains: 200,
  favoritesPageSize: 60,
  templatesMax: 200,
  variablesMax: 400,
  contextsMax: 200,
  assetMaxBytes: 8 * 1024 * 1024,
  assetsPerUser: 2000,
  backupsMax: 20,
  testGroupsMax: 8,
  evaluationMediaMax: 4,
} as const

export const PROMPT_OPTIMIZER_R2_PREFIX = 'tools/PromptOptimizer'

export const PREDEFINED_VARIABLES = [
  'originalPrompt',
  'lastOptimizedPrompt',
  'iterateInput',
  'currentPrompt',
  'userQuestion',
  'conversationContext',
  'toolsContext',
] as const

export const DEFAULT_SETTINGS: PromptOptimizerSettings = {
  defaultTextModelId: '',
  evaluationModelId: '',
  imageRecognitionModelId: '',
  imageModelId: '',
  builtinTemplateLanguage: 'zh',
  templateSelection: {},
  workspaceModelSelection: {},
  historyRetentionDays: 0,
  autosaveDrafts: true,
  testGroupDefault: 2,
  updatedAt: 0,
}

export function optimizationModeOfWorkspace(workspace: Workspace): OptimizationMode {
  return workspace === 'basic_user' || workspace === 'pro_variable' ? 'user' : 'system'
}
