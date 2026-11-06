/**
 * Prompt Optimizer API (`/api/tools/prompt-optimizer/*`).
 *
 * The route adapts HTTP, validates with the shared schemas, and hands the work to the store or the AI
 * service. It never talks to a provider directly and never trusts an id without binding `user_id`.
 */

import { Hono, type Context } from 'hono'
import type { z } from 'zod'
import {
  ArenaSaveSchema,
  CategoryInputSchema,
  ContextInputSchema,
  ConversationTestRequestSchema,
  EvaluateRequestSchema,
  ExtractVariablesRequestSchema,
  FavoriteInputSchema,
  GenerateVariablesRequestSchema,
  ImageGenerateSchema,
  ImageUnderstandSchema,
  ImageUploadSchema,
  ImportDocumentSchema,
  IterateRequestSchema,
  OptimizeRequestSchema,
  PromptTemplateSchema,
  RewriteRequestSchema,
  SessionSaveSchema,
  AnalyzeRequestSchema,
  SettingsPatchSchema,
  TestRequestSchema,
  TemplateImportSchema,
  VariableInputSchema,
} from '@shared/tools/prompt-optimizer/schemas'
import { PROMPT_OPTIMIZER_LIMITS, type PromptOptimizerSettings, type TemplateType, type Workspace } from '@shared/tools/prompt-optimizer/types'
import { builtinTemplateSummaries, findBuiltinTemplate } from '@shared/tools/prompt-optimizer/builtin'
import { AssistantStore } from '../assistant/store'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { createMinuteBudget } from '../lib/rate-limit'
import { requireAuth } from '../middleware/auth'
import {
  analyzePrompt,
  evaluatePrompt,
  extractImagePrompt,
  extractVariables,
  generateVariableValues,
  iteratePrompt,
  optimizePrompt,
  rewriteFromEvaluation,
  streamOptimize,
  streamResolvedCall,
  testConversation,
  testPrompt,
  type AiFailure,
} from '../tools/prompt-optimizer/ai'
import { deleteAsset, generateImageAsset, readAsset, uploadAsset, assetDataUrl } from '../tools/prompt-optimizer/assets'
import { createBackup, deleteBackup, exportText, readBackup } from '../tools/prompt-optimizer/export'
import { PromptOptimizerStore, SessionConflictError } from '../tools/prompt-optimizer/store'

export const toolsPromptOptimizerRoutes = new Hono<AppBindings>()

toolsPromptOptimizerRoutes.use('*', requireAuth)

function getUserId(c: Context<AppBindings>): string {
  const user = c.get('user')
  const userId = user?.id || c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  return userId
}

function getStore(c: Context<AppBindings>): PromptOptimizerStore {
  return new PromptOptimizerStore(c.env.DB, getUserId(c))
}

async function parseBody<T>(c: Context<AppBindings>, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw ApiError.badRequest(issue ? `${issue.path.join('.')}: ${issue.message}` : 'Validation failed')
  }
  return result.data
}

const readBudget = createMinuteBudget(240, 'Too many Prompt Optimizer requests. Try again in a minute.')
const writeBudget = createMinuteBudget(120, 'Too many Prompt Optimizer writes. Try again in a minute.')
const aiBudget = createMinuteBudget(40, 'Too many model calls. Try again in a minute.')

const settingsBudget = createMinuteBudget(120, 'Too many settings changes in one minute.')

async function settings(c: Context<AppBindings>): Promise<PromptOptimizerSettings> {
  return getStore(c).getSettings()
}

function mapAiError(error: unknown): never {
  if (error instanceof ApiError) throw error
  const failure = error as { kind?: AiFailure; message?: string }
  const message = failure.message || 'The model call failed'
  const status: 400 | 409 | 429 | 502 | 503 =
    failure.kind === 'no_model' ? 409 : failure.kind === 'quota' ? 429 : failure.kind === 'timeout' ? 503 : 502
  throw new ApiError(status, 'internal', message)
}

function loader(c: Context<AppBindings>, store: PromptOptimizerStore) {
  return (id: string) => assetDataUrl({ env: c.env, store, userId: getUserId(c), id })
}

toolsPromptOptimizerRoutes.get('/settings', async (c) => {
  readBudget(getUserId(c))
  return c.json({ data: await settings(c) })
})

toolsPromptOptimizerRoutes.put('/settings', async (c) => {
  settingsBudget(getUserId(c))
  const patch = await parseBody(c, SettingsPatchSchema)
  return c.json({ data: await getStore(c).saveSettings(patch) })
})

toolsPromptOptimizerRoutes.get('/models', async (c) => {
  readBudget(getUserId(c))
  const store = new AssistantStore(c.env.DB, getUserId(c), c.env)
  const assistant = await store.getSettings()
  const models = (await store.listModels()).filter((model) => model.enabled)
  return c.json({
    data: {
      text: models.filter((model) => model.purpose === 'chat' && model.kind === 'text'),
      image: models.filter((model) => model.purpose === 'image_generate'),
      activeModelId: assistant.activeModelId ?? '',
    },
  })
})

toolsPromptOptimizerRoutes.get('/templates', async (c) => {
  readBudget(getUserId(c))
  const type = c.req.query('type')
  const store = getStore(c)
  const config = await settings(c)
  const userTemplates = await store.listTemplates()
  return c.json({
    data: {
      builtin: builtinTemplateSummaries(config.builtinTemplateLanguage, type as TemplateType | undefined),
      user: userTemplates.filter((template) => !type || template.metadata.templateType === type),
    },
  })
})

toolsPromptOptimizerRoutes.get('/templates/:id', async (c) => {
  readBudget(getUserId(c))
  const store = getStore(c)
  const template = await store.getTemplate(c.req.param('id'))
  if (template) return c.json({ data: template })
  const config = await settings(c)
  const builtin = findBuiltinTemplate(c.req.param('id'), config.builtinTemplateLanguage)
  if (!builtin) throw ApiError.notFound('Template not found')
  return c.json({ data: builtin })
})

toolsPromptOptimizerRoutes.post('/templates', async (c) => {
  writeBudget(getUserId(c))
  const template = await parseBody(c, PromptTemplateSchema)
  const saved = await getStore(c).saveTemplate(template)
  return c.json({ data: saved }, 201)
})

toolsPromptOptimizerRoutes.put('/templates/:id', async (c) => {
  writeBudget(getUserId(c))
  const template = await parseBody(c, PromptTemplateSchema)
  if (template.id !== c.req.param('id')) throw ApiError.badRequest('Template id does not match the address')
  return c.json({ data: await getStore(c).saveTemplate(template) })
})

toolsPromptOptimizerRoutes.delete('/templates/:id', async (c) => {
  writeBudget(getUserId(c))
  await getStore(c).deleteTemplate(c.req.param('id'))
  return c.json({ data: { deleted: true } })
})

toolsPromptOptimizerRoutes.post('/templates/import', async (c) => {
  writeBudget(getUserId(c))
  const body = await parseBody(c, TemplateImportSchema)
  const store = getStore(c)
  const saved = []
  for (const template of body.templates) saved.push(await store.saveTemplate(template))
  return c.json({ data: { imported: saved.length, templates: saved } })
})

toolsPromptOptimizerRoutes.get('/templates/:id/export', async (c) => {
  readBudget(getUserId(c))
  const template = await getStore(c).getTemplate(c.req.param('id'))
  if (!template) throw ApiError.notFound('Template not found')
  return c.json({ data: { filename: `${template.id}.json`, document: template } })
})

toolsPromptOptimizerRoutes.get('/history', async (c) => {
  readBudget(getUserId(c))
  const store = getStore(c)
  const config = await settings(c)
  if (config.historyRetentionDays > 0) {
    await store.pruneHistory(Date.now() - config.historyRetentionDays * 86_400_000)
  }
  const chains = await store.listChains({
    search: c.req.query('search') ?? '',
    workspace: c.req.query('workspace') ?? '',
    limit: PROMPT_OPTIMIZER_LIMITS.historyMaxChains,
    offset: Math.max(0, Number(c.req.query('offset') ?? 0) || 0),
  })
  return c.json({ data: { chains } })
})

toolsPromptOptimizerRoutes.delete('/history/:chainId', async (c) => {
  writeBudget(getUserId(c))
  await getStore(c).deleteChain(c.req.param('chainId'))
  return c.json({ data: { deleted: true } })
})

toolsPromptOptimizerRoutes.post('/history/clear', async (c) => {
  writeBudget(getUserId(c))
  await getStore(c).clearHistory()
  return c.json({ data: { cleared: true } })
})

toolsPromptOptimizerRoutes.get('/variables', async (c) => {
  readBudget(getUserId(c))
  return c.json({ data: await getStore(c).listVariables() })
})

toolsPromptOptimizerRoutes.post('/variables', async (c) => {
  writeBudget(getUserId(c))
  const input = await parseBody(c, VariableInputSchema)
  return c.json({ data: await getStore(c).saveVariable(input) }, 201)
})

toolsPromptOptimizerRoutes.delete('/variables/:name', async (c) => {
  writeBudget(getUserId(c))
  await getStore(c).deleteVariable(c.req.param('name'))
  return c.json({ data: { deleted: true } })
})

toolsPromptOptimizerRoutes.post('/variables/extract', async (c) => {
  aiBudget(getUserId(c))
  const request = await parseBody(c, ExtractVariablesRequestSchema)
  try {
    return c.json({ data: await extractVariables({ env: c.env, userId: getUserId(c), settings: await settings(c), request }) })
  } catch (error) {
    mapAiError(error)
  }
})

toolsPromptOptimizerRoutes.post('/variables/generate', async (c) => {
  aiBudget(getUserId(c))
  const request = await parseBody(c, GenerateVariablesRequestSchema)
  try {
    return c.json({ data: await generateVariableValues({ env: c.env, userId: getUserId(c), settings: await settings(c), request }) })
  } catch (error) {
    mapAiError(error)
  }
})

toolsPromptOptimizerRoutes.get('/favorites', async (c) => {
  readBudget(getUserId(c))
  const store = getStore(c)
  const favorites = await store.listFavorites({
    search: c.req.query('search') ?? '',
    categoryId: c.req.query('category') ?? '',
    tag: c.req.query('tag') ?? '',
    offset: Math.max(0, Number(c.req.query('offset') ?? 0) || 0),
  })
  return c.json({ data: favorites })
})

toolsPromptOptimizerRoutes.get('/favorites/stats', async (c) => {
  readBudget(getUserId(c))
  return c.json({ data: await getStore(c).favoriteStats() })
})

toolsPromptOptimizerRoutes.get('/favorites/:id', async (c) => {
  readBudget(getUserId(c))
  const store = getStore(c)
  const favorite = await store.getFavorite(c.req.param('id'))
  if (!favorite) throw ApiError.notFound('Favorite not found')
  return c.json({ data: { favorite, versions: await store.listFavoriteVersions(favorite.id) } })
})

toolsPromptOptimizerRoutes.post('/favorites', async (c) => {
  writeBudget(getUserId(c))
  const input = await parseBody(c, FavoriteInputSchema)
  return c.json({ data: await getStore(c).saveFavorite(input) }, 201)
})

toolsPromptOptimizerRoutes.put('/favorites/:id', async (c) => {
  writeBudget(getUserId(c))
  const input = await parseBody(c, FavoriteInputSchema)
  return c.json({ data: await getStore(c).saveFavorite(input, c.req.param('id')) })
})

toolsPromptOptimizerRoutes.delete('/favorites/:id', async (c) => {
  writeBudget(getUserId(c))
  await getStore(c).deleteFavorite(c.req.param('id'))
  return c.json({ data: { deleted: true } })
})

toolsPromptOptimizerRoutes.post('/favorites/:id/use', async (c) => {
  writeBudget(getUserId(c))
  await getStore(c).touchFavorite(c.req.param('id'))
  return c.json({ data: { used: true } })
})

toolsPromptOptimizerRoutes.get('/categories', async (c) => {
  readBudget(getUserId(c))
  return c.json({ data: await getStore(c).listCategories() })
})

toolsPromptOptimizerRoutes.post('/categories', async (c) => {
  writeBudget(getUserId(c))
  const input = await parseBody(c, CategoryInputSchema)
  return c.json({ data: await getStore(c).saveCategory(input) }, 201)
})

toolsPromptOptimizerRoutes.put('/categories/:id', async (c) => {
  writeBudget(getUserId(c))
  const input = await parseBody(c, CategoryInputSchema)
  return c.json({ data: await getStore(c).saveCategory(input, c.req.param('id')) })
})

toolsPromptOptimizerRoutes.delete('/categories/:id', async (c) => {
  writeBudget(getUserId(c))
  await getStore(c).deleteCategory(c.req.param('id'))
  return c.json({ data: { deleted: true } })
})

toolsPromptOptimizerRoutes.get('/contexts', async (c) => {
  readBudget(getUserId(c))
  return c.json({ data: await getStore(c).listContexts() })
})

toolsPromptOptimizerRoutes.post('/contexts', async (c) => {
  writeBudget(getUserId(c))
  const input = await parseBody(c, ContextInputSchema)
  return c.json({ data: await getStore(c).saveContext(input) }, 201)
})

toolsPromptOptimizerRoutes.delete('/contexts/:id', async (c) => {
  writeBudget(getUserId(c))
  await getStore(c).deleteContext(c.req.param('id'))
  return c.json({ data: { deleted: true } })
})

toolsPromptOptimizerRoutes.get('/sessions/:workspace', async (c) => {
  readBudget(getUserId(c))
  const session = await getStore(c).getSession(c.req.param('workspace'))
  return c.json({ data: session })
})

toolsPromptOptimizerRoutes.put('/sessions/:workspace', async (c) => {
  writeBudget(getUserId(c))
  const input = await parseBody(c, SessionSaveSchema)
  try {
    const session = await getStore(c).saveSession(c.req.param('workspace'), input.rev, input.state)
    return c.json({ data: session })
  } catch (error) {
    if (error instanceof SessionConflictError) {
      // The shared request helper only surfaces `error.details`, so the conflict payload rides there
      // rather than under `data` where the client can never read a 409 body.
      return c.json({
        error: {
          code: 'conflict',
          message: 'This workspace was changed in another tab.',
          details: { conflict: true, current: error.current },
        },
      }, 409)
    }
    throw error
  }
})

toolsPromptOptimizerRoutes.get('/arena', async (c) => {
  readBudget(getUserId(c))
  return c.json({ data: await getStore(c).getArena() })
})

toolsPromptOptimizerRoutes.put('/arena', async (c) => {
  writeBudget(getUserId(c))
  const input = await parseBody(c, ArenaSaveSchema)
  await getStore(c).saveArena(input)
  return c.json({ data: { saved: true } })
})

toolsPromptOptimizerRoutes.post('/optimize', async (c) => {
  aiBudget(getUserId(c))
  const request = await parseBody(c, OptimizeRequestSchema)
  const store = getStore(c)
  const config = await settings(c)
  const variables = await resolveVariables(store, request.variables)
  const started = Date.now()
  try {
    const result = await optimizePrompt({
      env: c.env,
      userId: getUserId(c),
      store,
      settings: config,
      request,
      variables,
      loadAsset: loader(c, store),
    })
    const record = await store.createRecord({
      chainId: newId(),
      recordType: recordTypeFor(request.workspace),
      workspace: request.workspace as Workspace,
      originalPrompt: request.prompt,
      optimizedPrompt: result.text,
      reasoning: result.reasoning,
      modelId: result.modelId,
      modelLabel: result.modelLabel,
      templateId: result.templateId,
      metadata: { variables: Object.keys(variables), messageId: request.selectedMessageId ?? '', usage: result.usage },
    })
    return c.json({ data: { ...result, record }, timing: { durationMs: Date.now() - started, ...result.usage } })
  } catch (error) {
    mapAiError(error)
  }
})

toolsPromptOptimizerRoutes.post('/optimize/stream', async (c) => {
  aiBudget(getUserId(c))
  const request = await parseBody(c, OptimizeRequestSchema)
  const store = getStore(c)
  const config = await settings(c)
  const variables = await resolveVariables(store, request.variables)
  const abortController = new AbortController()
  const started = Date.now()
  let prepared: Awaited<ReturnType<typeof streamOptimize>>
  try {
    prepared = await streamOptimize({
      env: c.env,
      userId: getUserId(c),
      store,
      settings: config,
      request,
      variables,
      signal: abortController.signal,
      loadAsset: loader(c, store),
    })
  } catch (error) {
    mapAiError(error)
  }
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        } catch {
          abortController.abort()
        }
      }
      void (async () => {
        try {
          let text = ''
          let reasoning = ''
          let usage = { inputTokens: 0, outputTokens: 0 }
          for await (const event of streamResolvedCall(prepared.call, {
            system: prepared.system,
            turns: prepared.turns,
            timeoutMs: 120_000,
            signal: abortController.signal,
          })) {
            if (event.type === 'text') {
              text += event.delta
              send({ type: 'text', delta: event.delta })
            } else if (event.type === 'reasoning') {
              reasoning += event.delta
              send({ type: 'reasoning', delta: event.delta })
            } else if (event.type === 'done') {
              usage = event.usage
              const record = await store.createRecord({
                chainId: newId(),
                recordType: recordTypeFor(request.workspace),
                workspace: request.workspace as Workspace,
                originalPrompt: request.prompt,
                optimizedPrompt: event.text,
                reasoning: reasoning.trim(),
                modelId: prepared.modelId,
                modelLabel: prepared.call.modelLabel,
                templateId: prepared.templateId,
                metadata: { variables: Object.keys(variables), messageId: request.selectedMessageId ?? '', usage },
              })
              send({ type: 'done', text: event.text, record, usage, durationMs: Date.now() - started })
            }
          }
        } catch (error) {
          send({ type: 'error', message: error instanceof Error ? error.message : 'The model call failed' })
        } finally {
          try {
            controller.close()
          } catch {
            // The reader disconnected first.
          }
        }
      })()
    },
    cancel() {
      abortController.abort()
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
    },
  })
})

toolsPromptOptimizerRoutes.post('/analyze', async (c) => {
  aiBudget(getUserId(c))
  const request = await parseBody(c, AnalyzeRequestSchema)
  try {
    return c.json({
      data: await analyzePrompt({
        env: c.env,
        userId: getUserId(c),
        store: getStore(c),
        settings: await settings(c),
        workspace: request.workspace as Workspace,
        prompt: request.prompt,
        modelId: request.modelId,
        templateId: request.templateId,
      }),
    })
  } catch (error) {
    mapAiError(error)
  }
})

toolsPromptOptimizerRoutes.post('/iterate', async (c) => {
  aiBudget(getUserId(c))
  const request = await parseBody(c, IterateRequestSchema)
  const store = getStore(c)
  try {
    const result = await iteratePrompt({
      env: c.env,
      userId: getUserId(c),
      store,
      settings: await settings(c),
      request: {
        chainId: request.chainId,
        lastOptimizedPrompt: request.lastOptimizedPrompt,
        iterateInput: request.iterateInput,
        workspace: request.workspace as Workspace,
        templateId: request.templateId,
        modelId: request.modelId,
        metadata: request.metadata,
      },
    })
    const record = await store.createRecord({
      chainId: request.chainId,
      recordType: 'iterate',
      workspace: request.workspace as Workspace,
      originalPrompt: request.lastOptimizedPrompt,
      optimizedPrompt: result.text,
      reasoning: result.reasoning,
      modelId: result.modelId,
      modelLabel: result.modelLabel,
      templateId: result.templateId,
      iterationNote: request.iterateInput,
      metadata: { ...(request.metadata ?? {}), usage: result.usage },
    })
    return c.json({ data: { ...result, record } })
  } catch (error) {
    mapAiError(error)
  }
})

toolsPromptOptimizerRoutes.post('/test', async (c) => {
  aiBudget(getUserId(c))
  const request = await parseBody(c, TestRequestSchema)
  const store = getStore(c)
  try {
    const result = await testPrompt({
      env: c.env,
      userId: getUserId(c),
      settings: await settings(c),
      request,
      loadAsset: loader(c, store),
    })
    return c.json({ data: result })
  } catch (error) {
    mapAiError(error)
  }
})

toolsPromptOptimizerRoutes.post('/test/conversation', async (c) => {
  aiBudget(getUserId(c))
  const request = await parseBody(c, ConversationTestRequestSchema)
  const store = getStore(c)
  try {
    const variables = await resolveVariables(store, request.variables)
    const result = await testConversation({
      env: c.env,
      userId: getUserId(c),
      settings: await settings(c),
      modelId: request.modelId,
      messages: request.messages,
      variables,
      tools: request.tools,
    })
    return c.json({ data: result })
  } catch (error) {
    mapAiError(error)
  }
})

toolsPromptOptimizerRoutes.post('/evaluate', async (c) => {
  aiBudget(getUserId(c))
  const request = await parseBody(c, EvaluateRequestSchema)
  const store = getStore(c)
  try {
    const result = await evaluatePrompt({
      env: c.env,
      userId: getUserId(c),
      store,
      settings: await settings(c),
      request: { ...request, workspace: request.workspace as Workspace },
    })
    const evaluation = await store.insertEvaluation({
      workspace: request.workspace,
      evaluationType: request.type === 'structured' ? 'structured' : request.type,
      score: result.score,
      verdict: result.verdict,
      payload: { feedback: result.feedback, comparison: result.comparison },
    })
    return c.json({ data: { ...result, evaluation } })
  } catch (error) {
    mapAiError(error)
  }
})

toolsPromptOptimizerRoutes.post('/evaluate/rewrite', async (c) => {
  aiBudget(getUserId(c))
  const request = await parseBody(c, RewriteRequestSchema)
  try {
    return c.json({ data: await rewriteFromEvaluation({ env: c.env, userId: getUserId(c), store: getStore(c), settings: await settings(c), request: { ...request, workspace: request.workspace as Workspace } }) })
  } catch (error) {
    mapAiError(error)
  }
})

toolsPromptOptimizerRoutes.post('/images', async (c) => {
  writeBudget(getUserId(c))
  const input = await parseBody(c, ImageUploadSchema)
  const store = getStore(c)
  if ((await store.listAssets(4000)).length >= PROMPT_OPTIMIZER_LIMITS.assetsPerUser) {
    throw ApiError.badRequest('This account has reached its image storage limit')
  }
  return c.json({ data: await uploadAsset({ env: c.env, store, userId: getUserId(c), dataUrl: input.dataUrl, kind: input.kind, prompt: input.prompt }) }, 201)
})

toolsPromptOptimizerRoutes.get('/images', async (c) => {
  readBudget(getUserId(c))
  return c.json({ data: await getStore(c).listAssets(200) })
})

toolsPromptOptimizerRoutes.delete('/images/:id', async (c) => {
  writeBudget(getUserId(c))
  const deleted = await deleteAsset({ env: c.env, store: getStore(c), id: c.req.param('id') })
  if (!deleted) throw ApiError.notFound('Image not found')
  return c.json({ data: { deleted: true } })
})

toolsPromptOptimizerRoutes.post('/images/generate', async (c) => {
  aiBudget(getUserId(c))
  const input = await parseBody(c, ImageGenerateSchema)
  const config = await settings(c)
  return c.json({
    data: await generateImageAsset({
      env: c.env,
      store: getStore(c),
      userId: getUserId(c),
      prompt: input.prompt,
      modelId: input.modelId || config.imageModelId,
      size: input.size,
      kind: input.kind,
    }),
  }, 201)
})

toolsPromptOptimizerRoutes.post('/images/understand', async (c) => {
  aiBudget(getUserId(c))
  const input = await parseBody(c, ImageUnderstandSchema)
  const store = getStore(c)
  const userId = getUserId(c)
  const config = await settings(c)
  return c.json({
    data: await extractImagePrompt({
      env: c.env,
      store,
      userId,
      settings: config,
      imageId: input.imageId,
      mode: input.mode,
      originalPrompt: input.originalPrompt,
      modelId: input.modelId,
      loadAsset: (id) => assetDataUrl({ env: c.env, store, userId, id }),
    }),
  })
})

toolsPromptOptimizerRoutes.get('/assets/:id', async (c) => {
  readBudget(getUserId(c))
  return readAsset({ env: c.env, store: getStore(c), userId: getUserId(c), id: c.req.param('id') })
})

toolsPromptOptimizerRoutes.get('/backups', async (c) => {
  readBudget(getUserId(c))
  return c.json({ data: await getStore(c).listBackups() })
})

toolsPromptOptimizerRoutes.post('/backups', async (c) => {
  writeBudget(getUserId(c))
  const store = getStore(c)
  const backups = await store.listBackups()
  if (backups.length >= PROMPT_OPTIMIZER_LIMITS.backupsMax) {
    const oldest = backups[backups.length - 1]
    if (oldest) await deleteBackup({ env: c.env, store, id: oldest.id })
  }
  return c.json({ data: await createBackup({ env: c.env, store, userId: getUserId(c), kind: 'manual' }) }, 201)
})

toolsPromptOptimizerRoutes.post('/backups/:id/restore', async (c) => {
  writeBudget(getUserId(c))
  const store = getStore(c)
  const { payload } = await readBackup({ env: c.env, store, id: c.req.param('id') })
  return c.json({ data: await store.importAll(payload) })
})

toolsPromptOptimizerRoutes.delete('/backups/:id', async (c) => {
  writeBudget(getUserId(c))
  const deleted = await deleteBackup({ env: c.env, store: getStore(c), id: c.req.param('id') })
  if (!deleted) throw ApiError.notFound('Backup not found')
  return c.json({ data: { deleted: true } })
})

toolsPromptOptimizerRoutes.post('/export', async (c) => {
  writeBudget(getUserId(c))
  const store = getStore(c)
  const format = c.req.query('format') === 'txt' ? 'txt' : 'json'
  const scopeParam = c.req.query('scope')
  const scope = scopeParam === 'history' || scopeParam === 'favorites' ? scopeParam : 'all'
  const document = await store.exportScope(scope, {
    search: c.req.query('search') ?? '',
    workspace: c.req.query('workspace') ?? '',
  })
  const file = await exportText({ env: c.env, store, userId: getUserId(c), format, document })
  return c.json({ data: { filename: file.filename, contentType: file.contentType, text: file.body } })
})

toolsPromptOptimizerRoutes.post('/import', async (c) => {
  writeBudget(getUserId(c))
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
  const payload = (raw as { document?: unknown }).document ?? raw
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw ApiError.badRequest('Import must be a JSON object')
  const parsed = ImportDocumentSchema.safeParse(payload)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw ApiError.badRequest(`Import document failed validation: ${issue ? `${issue.path.join('.') || 'shape'} — ${issue.message}` : 'shape'}`)
  }
  return c.json({ data: await getStore(c).importAll(parsed.data as Record<string, unknown>) })
})

toolsPromptOptimizerRoutes.post('/clear', async (c) => {
  writeBudget(getUserId(c))
  const store = getStore(c)
  for (const asset of await store.listAssets(4000)) {
    await deleteAsset({ env: c.env, store, id: asset.id })
  }
  for (const backup of await store.listBackups()) {
    await deleteBackup({ env: c.env, store, id: backup.id })
  }
  await store.clearContent()
  return c.json({ data: { cleared: true } })
})

toolsPromptOptimizerRoutes.get('/stats', async (c) => {
  readBudget(getUserId(c))
  return c.json({ data: await getStore(c).stats() })
})

function recordTypeFor(workspace: string) {
  if (workspace === 'basic_user') return 'userOptimize'
  if (workspace === 'pro_multi') return 'conversationMessageOptimize'
  if (workspace === 'pro_variable') return 'contextUserOptimize'
  if (workspace === 'image_text2image') return 'text2imageOptimize'
  if (workspace === 'image_image2image') return 'image2imageOptimize'
  if (workspace === 'image_multiimage') return 'multiimageOptimize'
  return 'optimize'
}

async function resolveVariables(store: PromptOptimizerStore, provided?: Record<string, string>): Promise<Record<string, string>> {
  const stored = await store.listVariables()
  const values: Record<string, string> = {}
  for (const variable of stored) values[variable.name] = variable.value
  for (const [name, value] of Object.entries(provided ?? {})) values[name] = value
  return values
}

export type { AiFailure }
