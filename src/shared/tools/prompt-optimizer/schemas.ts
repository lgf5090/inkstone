/**
 * Zod request schemas for the Prompt Optimizer module.
 *
 * Every field the client sends crosses this boundary; the server never trusts a workspace name, a
 * template id or an asset id it has not validated here.
 */

import { z } from 'zod'
import {
  PROMPT_OPTIMIZER_LIMITS,
  PROMPT_OPTIMIZER_NAV_VIEWS,
  WORKSPACES,
  type PromptTemplate,
} from './types'

export const WorkspaceSchema = z.enum(WORKSPACES as unknown as [string, ...string[]])

export const NavViewSchema = z.enum(PROMPT_OPTIMIZER_NAV_VIEWS as unknown as [string, ...string[]])

export const MessageSchema = z.object({
  id: z.string().max(120).optional(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars),
  originalContent: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars).optional(),
  name: z.string().max(200).optional(),
  tool_calls: z.array(z.object({
    id: z.string().max(120),
    type: z.literal('function'),
    function: z.object({ name: z.string().max(200), arguments: z.string().max(20000) }),
  })).optional(),
  tool_call_id: z.string().max(120).optional(),
})

export const ToolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
})

export const AssetRefSchema = z.object({
  id: z.string().min(1).max(120),
  mime: z.string().max(120).optional(),
  bytes: z.number().int().nonnegative().optional(),
  width: z.number().int().nonnegative().nullable().optional(),
  height: z.number().int().nonnegative().nullable().optional(),
})

export const OptimizeRequestSchema = z.object({
  workspace: WorkspaceSchema,
  prompt: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars),
  templateId: z.string().max(200).optional(),
  modelId: z.string().max(200).optional(),
  messages: z.array(MessageSchema).max(60).optional(),
  selectedMessageId: z.string().max(120).optional(),
  variables: z.record(z.string(), z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars)).optional(),
  tools: z.array(ToolDefinitionSchema).max(20).optional(),
  images: z.array(AssetRefSchema).max(PROMPT_OPTIMIZER_LIMITS.evaluationMediaMax).optional(),
})

export const AnalyzeRequestSchema = z.object({
  workspace: WorkspaceSchema,
  prompt: z.string().min(1).max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars),
  modelId: z.string().max(200).optional(),
  templateId: z.string().max(200).optional(),
})

export const IterateRequestSchema = z.object({
  chainId: z.string().min(1).max(120),
  lastOptimizedPrompt: z.string().min(1).max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars),
  iterateInput: z.string().min(1).max(20000),
  workspace: WorkspaceSchema,
  templateId: z.string().max(200).optional(),
  modelId: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const TestRequestSchema = z.object({
  workspace: WorkspaceSchema.optional(),
  system: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars).default(''),
  user: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars).default(''),
  modelId: z.string().max(200).optional(),
  images: z.array(AssetRefSchema).max(PROMPT_OPTIMIZER_LIMITS.evaluationMediaMax).optional(),
  tools: z.array(ToolDefinitionSchema).max(20).optional(),
})

export const ConversationTestRequestSchema = z.object({
  modelId: z.string().max(200).optional(),
  messages: z.array(MessageSchema).min(1).max(60),
  variables: z.record(z.string(), z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars)).optional(),
  tools: z.array(ToolDefinitionSchema).max(20).optional(),
})

const CompareEntrySchema = z.object({
  label: z.string().max(200),
  prompt: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars).default(''),
  output: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars).default(''),
  modelLabel: z.string().max(200).default(''),
})

export const EvaluateRequestSchema = z.object({
  workspace: WorkspaceSchema,
  type: z.enum(['result', 'compare', 'structured', 'prompt-only']),
  modelId: z.string().max(200).optional(),
  templateId: z.string().max(200).optional(),
  originalPrompt: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars).default(''),
  optimizedPrompt: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars).default(''),
  testInput: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars).default(''),
  testOutput: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars).default(''),
  focus: z.string().max(4000).default(''),
  compare: z.array(CompareEntrySchema).max(6).optional(),
})

export const RewriteRequestSchema = z.object({
  workspace: WorkspaceSchema,
  originalPrompt: z.string().min(1).max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars),
  optimizedPrompt: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars).default(''),
  feedback: z.string().max(20000).default(''),
  modelId: z.string().max(200).optional(),
})

export const ExtractVariablesRequestSchema = z.object({
  prompt: z.string().min(1).max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars),
  modelId: z.string().max(200).optional(),
})

export const GenerateVariablesRequestSchema = z.object({
  prompt: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars).default(''),
  variables: z.array(z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(2000).default(''),
  })).min(1).max(80),
  modelId: z.string().max(200).optional(),
})

export const SettingsPatchSchema = z.object({
  defaultTextModelId: z.string().max(200).optional(),
  evaluationModelId: z.string().max(200).optional(),
  imageRecognitionModelId: z.string().max(200).optional(),
  imageModelId: z.string().max(200).optional(),
  builtinTemplateLanguage: z.enum(['zh', 'en']).optional(),
  templateSelection: z.record(z.string(), z.string().max(200)).optional(),
  workspaceModelSelection: z.record(z.string(), z.string().max(200)).optional(),
  historyRetentionDays: z.number().int().min(0).max(3650).optional(),
  autosaveDrafts: z.boolean().optional(),
  testGroupDefault: z.number().int().min(1).max(PROMPT_OPTIMIZER_LIMITS.testGroupsMax).optional(),
})

const ImportRowsSchema = z.array(z.record(z.string(), z.unknown())).max(20_000)

export const ImportDocumentSchema = z.object({
  format: z.string().max(120).optional(),
  version: z.number().optional(),
  exportedAt: z.number().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  records: ImportRowsSchema.optional(),
  templates: ImportRowsSchema.optional(),
  categories: ImportRowsSchema.optional(),
  favorites: ImportRowsSchema.optional(),
  favoriteTags: ImportRowsSchema.optional(),
  favoriteVersions: ImportRowsSchema.optional(),
  variables: ImportRowsSchema.optional(),
  contexts: ImportRowsSchema.optional(),
  sessions: ImportRowsSchema.optional(),
  evaluations: ImportRowsSchema.optional(),
}).passthrough()

const TemplateContentSchema = z.union([
  z.string().min(1).max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars),
  z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().min(1).max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars),
  })).min(1).max(20),
])

export const PromptTemplateSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  content: TemplateContentSchema,
  metadata: z.object({
    version: z.string().max(40).default('1.0.0'),
    lastModified: z.number().int().default(0),
    author: z.string().max(200).optional(),
    description: z.string().max(4000).optional(),
    templateType: z.enum([
      'optimize',
      'userOptimize',
      'text2imageOptimize',
      'image2imageOptimize',
      'multiimageOptimize',
      'imageIterate',
      'iterate',
      'conversationMessageOptimize',
      'contextUserOptimize',
      'contextIterate',
      'contextSystemOptimize',
      'evaluation',
      'evaluation-rewrite',
      'evaluation-structured-compare',
      'variable-extraction',
      'variable-value-generation',
      'image-prompt-composition',
      'image-prompt-migration',
    ]),
    language: z.enum(['zh', 'en']).optional(),
  }).passthrough(),
})

export const TemplateImportSchema = z.object({
  templates: z.array(PromptTemplateSchema).min(1).max(50),
})

export const FavoriteInputSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars),
  description: z.string().max(4000).default(''),
  functionMode: z.enum(['basic', 'context', 'image']).default('basic'),
  optimizationMode: z.enum(['system', 'user']).optional(),
  imageSubMode: z.enum(['text2image', 'image2image', 'multiimage']).optional(),
  categoryId: z.string().max(120).nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(30).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  examples: z.array(z.object({
    id: z.string().max(120),
    label: z.string().max(200),
    systemPrompt: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars),
    userPrompt: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars),
    output: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars),
    modelId: z.string().max(200),
    modelLabel: z.string().max(200),
    evaluation: z.object({
      score: z.number().nullable(),
      verdict: z.string().max(200),
      feedback: z.string().max(20000),
    }).optional(),
    createdAt: z.number().int(),
  })).max(20).optional(),
  versions: z.array(z.object({
    id: z.string().max(120).optional(),
    version: z.number().int().min(1),
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars),
    description: z.string().max(4000).default(''),
    metadata: z.record(z.string(), z.unknown()).default({}),
    createdAt: z.number().int(),
  })).max(50).optional(),
})

export const CategoryInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).default(''),
  parentId: z.string().max(120).nullable().optional(),
  color: z.string().max(120).default(''),
  sortOrder: z.number().int().min(0).max(10000).default(0),
})

export const VariableInputSchema = z.object({
  name: z.string().min(1).max(80).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Variable names start with a letter or underscore'),
  value: z.string().max(20000).default(''),
  description: z.string().max(1000).default(''),
})

export const ContextInputSchema = z.object({
  title: z.string().min(1).max(200),
  mode: z.enum(['system', 'user']).default('system'),
  messages: z.array(MessageSchema).max(60).default([]),
  variables: z.record(z.string(), z.string().max(20000)).default({}),
  tools: z.array(ToolDefinitionSchema).max(20).default([]),
  tags: z.array(z.string().min(1).max(40)).max(30).default([]),
  description: z.string().max(4000).default(''),
})

export const SessionSaveSchema = z.object({
  rev: z.number().int().min(0),
  state: z.record(z.string(), z.unknown()),
})

export const ArenaSaveSchema = z.object({
  schemaVersion: z.literal(1),
  prompt: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars),
  images: z.array(AssetRefSchema).max(8),
  contestants: z.array(z.object({
    id: z.string().min(1).max(120),
    kind: z.enum(['text', 'image']),
    modelId: z.string().max(200),
  })).min(1).max(6),
  results: z.record(z.string(), z.unknown()).default({}),
  lastActiveAt: z.number().int(),
})

export const ImageUploadSchema = z.object({
  dataUrl: z.string().max(PROMPT_OPTIMIZER_LIMITS.assetMaxBytes * 2),
  kind: z.literal('image').default('image'),
  prompt: z.string().max(4000).default(''),
})

export const ImageGenerateSchema = z.object({
  prompt: z.string().min(1).max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars),
  modelId: z.string().max(200).optional(),
  size: z.string().max(40).optional(),
  kind: z.literal('image').default('image'),
})

export const ImageUnderstandSchema = z.object({
  imageId: z.string().min(1).max(120),
  mode: z.enum(['text2image', 'image2image']).default('text2image'),
  originalPrompt: z.string().max(PROMPT_OPTIMIZER_LIMITS.promptMaxChars).default(''),
  modelId: z.string().max(200).optional(),
})

export type OptimizeRequest = z.infer<typeof OptimizeRequestSchema>
export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>
export type IterateRequest = z.infer<typeof IterateRequestSchema>
export type TestRequest = z.infer<typeof TestRequestSchema>
export type ConversationTestRequest = z.infer<typeof ConversationTestRequestSchema>
export type EvaluateRequest = z.infer<typeof EvaluateRequestSchema>
export type RewriteRequest = z.infer<typeof RewriteRequestSchema>
export type ExtractVariablesRequest = z.infer<typeof ExtractVariablesRequestSchema>
export type GenerateVariablesRequest = z.infer<typeof GenerateVariablesRequestSchema>
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>
export type FavoriteInput = z.infer<typeof FavoriteInputSchema>
export type CategoryInput = z.infer<typeof CategoryInputSchema>
export type VariableInput = z.infer<typeof VariableInputSchema>
export type ContextInput = z.infer<typeof ContextInputSchema>
export type SessionSaveInput = z.infer<typeof SessionSaveSchema>
export type ArenaSaveInput = z.infer<typeof ArenaSaveSchema>
export type ImageUploadInput = z.infer<typeof ImageUploadSchema>
export type ImageGenerateInput = z.infer<typeof ImageGenerateSchema>
export type PromptTemplateInput = PromptTemplate
