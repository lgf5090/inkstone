/**
 * One assistant turn, start to finish.
 *
 * The shape is the reference project's — assemble context, stream, run tools, loop — with three
 * differences that only appear once the data is shared rather than private to one owner:
 *  - the conversation is claimed before the first await, so a second message cannot start a second run
 *    writing into the same assistant message;
 *  - every model call is charged against the reader's own daily budget *before* it is made, including
 *    the summary call and each reasoning step, because the ceiling is the reader's and the meter is
 *    ours;
 *  - the assistant message is written whether the turn finished, failed or was stopped, so a reader
 *    who closes the tab still finds the half-answer and the reason.
 */

import type { AssistantMessage, AssistantModelModality, AssistantProtocol, AssistantSettings, ChatStreamEvent, ToolActivity } from '@shared/assistant'
import { customParamBody, MAX_CHAT_ATTACHMENTS, MAX_TURN_SCOPES, MAX_TURN_TOOLS, estimateTokens, titleFromMessage, type AssistantTurnScope } from '@shared/assistant'
import { hasHistoricalIntent, memoryTokenBudget } from '@shared/assistant-memory'
import { expandChatAttachments, type AttachmentPayload } from './attachments'
import { loadExternalTools, type ExternalToolsResult } from './mcp-tools'
import { buildSystemPrompt, offlineAnswer, promptCatalog, summarizerPrompt } from '@shared/assistant-prompt'
import { describeLocalTime, localDayBounds } from '@shared/assistant-time'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import type { McpWriteContext } from '../mcp/writes'
import type { AssistantStore } from './store'
import { MemoryHistoryService, type ConflictJudge } from './memory-service'
import { AutomationService } from './automations'
import { resolveNoteScope, type NoteScope } from './note-scope'
import { parametersSchema, ToolError, ToolExecutor, type ToolContext } from './tools'
import { AbortError, streamUpstream, type ModelTurn, type ToolCallRecord, type ToolSchema, type UpstreamError, type UpstreamRequest } from './upstream'
import { loadModelAndProvider } from './model-config'
import { fuseMemoryRecall, rankMemoriesByVector, semanticModel } from './semantic'

/** The two protocols with a vendor-side web search that can simply be asked for. */
const SEARCH_NATIVE_PROTOCOLS = new Set(['anthropic', 'gemini'])

/** Summarising costs a model call, so it only runs once enough history has piled up to be worth it. */
export const SUMMARIZE_THRESHOLD = 8

const MAX_RELEVANT_MEMORIES = 8
const ALWAYS_INCLUDE_PREFERENCES = 4
const VERDICT_RELATIONSHIPS = ['supersedes', 'refines', 'contradicts', 'complements', 'unrelated']

export interface RunnerDeps {
  store: AssistantStore
  env: Env
  ftsEnabled: boolean
  origin: string
  executionCtx?: ExecutionContext
  settings: AssistantSettings
}

export interface TurnInput {
  conversationId?: string
  message: string
  /** Attachment ids the reader added to this turn. */
  attachments?: string[]
  /** Tool names the reader pinned to this turn with `/`. */
  tools?: string[]
  /** Note tags and folders the reader pinned to this turn with `#`. */
  scopes?: AssistantTurnScope[]
  /** The composer's web-search switch: ask this model for a live web search. */
  webSearch?: boolean
  retry?: boolean
  signal: AbortSignal
  /** True once a write to the reader has failed, which is the only disconnect some platforms surface. */
  readerGone?: () => boolean
}

interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  calls?: ToolCallRecord[]
  images?: { mime: string, dataUrl: string }[]
}

export class AssistantRunner {
  private readonly memoryHistory: MemoryHistoryService
  private readonly automations: AutomationService
  private scopePromise: Promise<NoteScope> | null = null
  private turnTools: string[] = []
  private webSearchRequested = false
  private webSearchNative = false
  private turnScopes: AssistantTurnScope[] = []

  constructor(private readonly deps: RunnerDeps) {
    this.automations = new AutomationService(deps.store, deps.settings)
    this.memoryHistory = new MemoryHistoryService(
      deps.store,
      { judge: deps.settings.aiConflictCheck ? this.judgeConflict : undefined },
      deps.settings.conflictReview,
    )
  }

  private get store(): AssistantStore {
    return this.deps.store
  }

  private get settings(): AssistantSettings {
    return this.deps.settings
  }

  async *chat(input: TurnInput): AsyncGenerator<ChatStreamEvent> {
    const message = input.message.trim()
    // Read before the scope is resolved for the first time: `noteScope()` caches, so a scope pinned
    // for this turn has to be in place before anything asks for it.
    this.turnTools = [...new Set(input.tools ?? [])].slice(0, MAX_TURN_TOOLS)
    // The switch means different things per protocol, so it is resolved after the model is known:
    // `webSearchNative` sends the vendor's own tool, otherwise a search-capable remote tool is pinned.
    this.webSearchRequested = input.webSearch === true
    this.webSearchNative = false
    this.turnScopes = (input.scopes ?? []).slice(0, MAX_TURN_SCOPES)
    let conversation = input.conversationId ? await this.store.getConversation(input.conversationId) : null
    if (input.conversationId && !conversation) throw ApiError.notFound('Conversation not found')

    // The turn's existing answer, when this is a regeneration of a turn that already has one. The row
    // keeps its id and its place in the transcript; what the model said before goes to the version table
    // so the reader can page back to it.
    // The row this turn writes into. A retry always lands on the turn's own row — including when the
    // attempt it replaces had failed — because that row is what the displaced answers are filed under.
    let reuseId: string | null = null
    if (input.retry) {
      if (!conversation) throw ApiError.badRequest('There is nothing to retry without a conversation.')
      // Drop the failed reply, then answer the reader's own last message again.
      const last = await this.store.lastMessage(conversation.id)
      if (last && last.role === 'assistant' && last.status === 'complete') {
        reuseId = last.id
        // Only the row goes: the answers this turn already displaced have to outlive this one.
        await this.store.deleteMessageRow(last.id)
        await this.store.archiveAnswerVersion({
          messageId: last.id,
          conversationId: conversation.id,
          content: last.content,
          tools: last.tools,
          modelLabel: last.modelLabel ?? '',
          usage: last.usage,
          durationMs: last.durationMs,
          createdAt: last.createdAt,
        })
      } else if (last && last.role === 'assistant') {
        reuseId = last.id
        // The failed or stopped attempt loses its row, but the answers already behind it stay: they
        // belong to this turn, not to the attempt that went wrong.
        await this.store.deleteMessageRow(last.id)
      }
      const previous = await this.store.lastMessage(conversation.id)
      if (!previous || previous.role !== 'user') throw ApiError.conflict('Nothing to retry.')
      if (previous.source === 'import') {
        throw ApiError.conflict('A message restored from a backup cannot be retried. Send a new one instead.')
      }
    } else {
      if (!message) throw ApiError.badRequest('Write something first.')
      if (message.length > 16_000) throw ApiError.badRequest('That message is too long for one turn.')
      if (!conversation) {
        conversation = await this.store.createConversation(titleFromMessage(message))
        // The route had no id to claim yet, so the lease is taken here: without it a second tab could
        // open a parallel turn on the conversation this one has just made.
        if (!(await this.store.claimRun(conversation.id))) {
          throw ApiError.conflict('A reply is already being generated in this conversation.')
        }
        yield { type: 'title', conversationId: conversation.id, title: conversation.title }
      }
      const attached = (input.attachments ?? []).slice(0, MAX_CHAT_ATTACHMENTS)
      // Only the reader's own words are stored. What a file contributes is worked out on every turn,
      // against the model that is actually being used, so a row never claims a picture was shown to a
      // model that cannot see one — and switching models changes what is sent, not what was said.
      await this.store.addMessage({
        conversationId: conversation.id,
        role: 'user',
        content: message,
        attachments: attached,
      })
    }
    const conversationId = conversation.id
    const assistantId = reuseId ?? newId()
    const startedAt = Date.now()
    // The label is only known once the model resolves, and a turn that never got that far stores an
    // answer with no model named — which is the honest reading, not a blank one claiming a model.
    let modelLabel = ''
    // Either the request was aborted or the reader stopped taking bytes; both mean the answer
    // on screen is a fragment, and filing it as complete would let it look like the model stopped.
    const stopped = () => input.signal.aborted || (input.readerGone?.() ?? false)
    const userMessage = await this.store.lastMessage(conversationId)
    yield {
      type: 'start',
      conversationId,
      userMessageId: userMessage?.id ?? '',
      assistantMessageId: assistantId,
    }

    let text = ''
    const tools: ToolActivity[] = []
    const finish = async (
      status: AssistantMessage['status'],
      error: string | null,
      usage: { inputTokens: number, outputTokens: number } | null,
    ) => await this.store.addMessage({
      id: assistantId,
      conversationId,
      role: 'assistant',
      content: text,
      tools,
      status,
      error,
      durationMs: Math.max(0, Date.now() - startedAt),
      modelLabel,
      usage,
    })

    try {
      const resolved = await loadModelAndProvider(this.store, this.settings)
      if (!resolved.model || !resolved.provider) {
        throw ApiError.badRequest('No model is configured yet. Pick one under Assistant settings, or turn on offline mode.')
      }
      const { model, provider } = resolved
      modelLabel = model.label
      const apiKey = await this.store.providerKey(provider)
      const limits = this.settings.limits
      // A 1M model and a 4K model do not get fed the same amount: the reader sets this per model on the
      // composer's context control, and the global limit is what a model without one falls back to.
      // A model's own budget, and never more than the input it says it can take.
      const contextTokens = Math.min(
        model.contextTokens ?? limits.maxContextTokens,
        model.maxInputTokens ?? Number.POSITIVE_INFINITY,
      )
      if (!(await this.reserve(1, limits.maxRequestsPerDay))) {
        throw ApiError.conflict(`The daily limit of ${limits.maxRequestsPerDay} assistant requests is reached. It is adjustable in Assistant settings.`)
      }

      yield { type: 'stage', stage: 'reading' }
      // The reader's own third-party tools are listed once per turn, and before the prompt is written:
      // the web-search switch works on a protocol with no vendor search by naming one of these tools to
      // the model, which only lands if the prompt has not been built yet. A server that is slow or down is
      // reported to the settings screen rather than failing the answer.
      const external: ExternalToolsResult = await loadExternalTools(this.store)
      this.webSearchNative = this.webSearchRequested && SEARCH_NATIVE_PROTOCOLS.has(provider.protocol)
      if (this.webSearchRequested && !this.webSearchNative) {
        // No vendor-side search on this protocol: the next best thing that is actually true is a remote
        // tool that can search, named for the model in the same line the reader's own pins use.
        const searcher = external.definitions.find((definition) => /search|query|web|browse/i.test(definition.name))
        if (searcher && !this.turnTools.includes(searcher.name)) this.turnTools = [...this.turnTools, searcher.name].slice(0, MAX_TURN_TOOLS)
      }
      const selected = await this.recallMemories(userMessage?.content ?? message)
      const memories = this.memoryHistory.promptMemories(selected, memoryTokenBudget(contextTokens))
      const history = await this.contextHistory(conversationId, model.vision, model.modalities)
      const system = buildSystemPrompt({
        agentName: this.settings.agentName,
        language: this.settings.language,
        timezone: this.settings.timezone,
        localTime: describeLocalTime(new Date(), this.settings.timezone),
        autoMemory: this.settings.autoMemory,
        memories,
        conversationSummary: conversation.summary,
        noteScope: this.settings.noteScope,
        noteScopeLabels: await this.scopeLabels(),
        noteTagLabels: this.scopeTagLabels(),
        turnTools: this.turnTools,
      })
      const historyBudget = Math.max(500, contextTokens - estimateTokens(system) - 600)
      let window = buildContextWindow(history, historyBudget, conversation.summaryUpto ?? null)

      if (window.overflow.length >= SUMMARIZE_THRESHOLD) {
        const rolled = await this.summarize(conversationId, conversation.summary ?? null, window.overflow)
        if (rolled) window = buildContextWindow(history, historyBudget, rolled.upto)
      }

      yield { type: 'stage', stage: 'generating' }
      const executor = new ToolExecutor(await this.toolContext(conversationId), { maxToolCalls: limits.maxToolCalls }, external.definitions)
      const schemas: ToolSchema[] = executor.available().map((definition) => ({
        name: definition.name,
        description: definition.description,
        // A remote tool's own JSON Schema, because this file has no FieldSpec list for it.
        parameters: external.schemas[definition.name] ?? parametersSchema(definition.fields),
      }))
      // A server the reader added that will not answer is their business, not a silent absence: without
      // this the tool list just looks shorter than it should be.
      for (const problem of external.problems) {
        yield { type: 'mcp_problem', server: problem.label, error: problem.error }
      }
      const turns: ModelTurn[] = window.messages.map((entry) => ({
        role: entry.role,
        content: entry.content,
        calls: entry.calls,
        images: entry.images,
      }))
      const usage = { inputTokens: 0, outputTokens: 0 }
      let steps = 0

      for (;;) {
        steps++
        // A turn that walks several steps outlives the lease it was claimed with, and an expired lease
        // lets another device open a second run over the top of this one.
        await this.store.renewRun(conversationId)
        // The row is also how a stop reaches this generator: the reader's tab closing only fails a
        // write on some platforms, and a turn nobody is watching must not keep spending their budget.
        if (!(await this.store.isRunning(conversationId))) throw new AbortError()
        const calls: ToolCallRecord[] = []
        let eventsSeen = 0
        for await (const event of this.step(provider.protocol, {
          baseUrl: provider.base_url,
          apiKey,
          model: model.model,
          system,
          turns,
          // A model that invents tool calls is silenced by not sending the schemas at all.
          tools: model.supportsTools ? schemas : [],
          webSearch: this.webSearchNative,
          maxOutputTokens: Math.min(limits.maxOutputTokens, model.maxOutputTokens),
          temperature: model.temperature,
          topP: model.topP,
          extraBody: customParamBody(model.customParams),
          reasoning: model.reasoning,
          signal: input.signal,
        }, calls, usage)) {
          if (event.type === 'text') text += event.delta ?? ''
          // A reader who pressed stop released the lease; on a platform that does not report the
          // dropped connection, this is what ends the turn. Every sixteenth event keeps the extra read
          // off the critical path while still stopping within a couple of hundred characters.
          if (++eventsSeen % 16 === 0 && !(await this.store.isRunning(conversationId))) throw new AbortError()
          yield event
        }
        if (!calls.length) break
        for (const call of calls) {
          const activity: ToolActivity = { id: call.id, name: call.name, status: 'running' }
          tools.push(activity)
          yield { type: 'tool', tool: { ...activity } }
          try {
            const result = await executor.execute(call.name, call.args, call.id)
            call.result = JSON.stringify(result ?? null)
            call.error = false
            const approval = executor.approvalFor(call.id)
            if (approval) activity.approval = (await this.store.getPendingAction(approval.id)) ?? undefined
          } catch (error) {
            const reason = error instanceof Error ? error.message : 'The tool failed.'
            call.result = JSON.stringify({ error: reason })
            call.error = true
            call.args = call.args ?? {}
            activity.error = reason.slice(0, 300)
          }
          activity.status = call.error ? 'error' : 'success'
          activity.detail = detailFor(call.args)
          yield { type: 'tool', tool: { ...activity } }
        }
        turns.push({ role: 'assistant', content: text, calls })
        text = ''
        if (steps >= limits.maxAgentSteps || executor.budgetExhausted()) break
        if (!(await this.reserve(1, limits.maxRequestsPerDay))) {
          yield { type: 'error', code: 'rate_limited', message: 'The daily assistant request limit was reached during this turn.' }
          break
        }
      }

      if (!usage.inputTokens && !usage.outputTokens) {
        usage.inputTokens = estimateTokens(system) + turns.reduce((total, turn) => total + estimateTokens(turn.content), 0)
        usage.outputTokens = estimateTokens(text)
      }
      await this.store.incrementUsage({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        toolCalls: executor.callCount,
      })
      if (stopped()) {
        yield { type: 'done', finalMessage: await finish('cancelled', null, usage) }
        return
      }
      if (!text.trim()) {
        text = tools.some((tool) => tool.status === 'success')
          ? 'Done.'
          : 'I could not produce an answer this time. Try rephrasing, or check the model in Assistant settings.'
      }
      yield { type: 'usage', usage }
      // Read the signal again here: every `yield` above hands control back to the response writer, and
      // a reader who stopped the turn in the meantime must not have their half answer filed as whole.
      yield { type: 'done', finalMessage: await finish(stopped() ? 'cancelled' : 'complete', null, usage) }
    } catch (error) {
      if (error instanceof AbortError || stopped()) {
        yield { type: 'done', finalMessage: await finish('cancelled', null, null) }
        return
      }
      await this.store.incrementUsage({ errors: 1 })
      const reason = describeUpstreamFailure(error)
      yield { type: 'error', code: errorCode(error), message: reason }
      yield { type: 'done', finalMessage: await finish('error', reason, null) }
    }
  }

  /**
   * One model call.
   *
   * Text and reasoning are yielded straight through so the reader watches the answer arrive, while the
   * calls are collected into the array the caller inspects afterwards — a tool call cannot be run in
   * the middle of its own stream, because the arguments are still arriving.
   */
  private async *step(
    protocol: AssistantProtocol,
    request: UpstreamRequest,
    calls: ToolCallRecord[],
    usage: { inputTokens: number, outputTokens: number },
  ): AsyncGenerator<ChatStreamEvent> {
    for await (const event of streamUpstream(protocol, request)) {
      if (event.type === 'text') {
        yield { type: 'text', delta: event.delta }
        continue
      }
      if (event.type === 'reasoning') {
        yield { type: 'reasoning', delta: event.delta }
        continue
      }
      if (event.type === 'usage') {
        usage.inputTokens += event.inputTokens
        usage.outputTokens += event.outputTokens
        continue
      }
      calls.push({ id: event.id, name: event.name, args: event.args, result: '', error: false })
    }
  }

  /** Charges one or more model calls against the reader's daily ceiling, refusing when it is spent. */
  private async reserve(count: number, maxPerDay: number): Promise<boolean> {
    const today = await this.store.todayUsage()
    if (today.requests + count > maxPerDay) return false
    await this.store.incrementUsage({ requests: count })
    return true
  }

  private async summarize(
    conversationId: string,
    previous: string | null,
    overflow: HistoryEntry[],
  ): Promise<{ upto: number } | null> {
    const resolved = await loadModelAndProvider(this.store, this.settings)
    if (!resolved.model || !resolved.provider) return null
    const transcript = overflow
      .map((entry) => `${entry.role === 'user' ? 'Reader' : 'Assistant'}: ${entry.content.slice(0, 1500)}`)
      .join('\n')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45_000)
    let text = ''
    try {
      if (!(await this.reserve(1, this.settings.limits.maxRequestsPerDay))) return null
      for await (const event of streamUpstream(resolved.provider.protocol, {
        baseUrl: resolved.provider.base_url,
        apiKey: await this.store.providerKey(resolved.provider),
        model: resolved.model.model,
        system: promptCatalog(this.settings.language).summarizer_system,
        turns: [{ role: 'user', content: summarizerPrompt(this.settings.language, previous, transcript) }],
        tools: [],
        maxOutputTokens: 400,
        temperature: 0.2,
        // A summary is arithmetic on text, not a question: thinking only costs the reader's budget.
        reasoning: 'off',
        signal: controller.signal,
      })) {
        if (event.type === 'text') text += event.delta
      }
    } catch (error) {
      // A conversation that cannot be summarised still answers; the window just stays short.
      console.warn('[inkstone] assistant summarization skipped:', error instanceof Error ? error.name : error)
      return null
    } finally {
      clearTimeout(timer)
    }
    const summary = text.trim().slice(0, 2000)
    if (!summary) return null
    const upto = overflow.at(-1)?.createdAt ?? Date.now()
    await this.store.setSummary(conversationId, summary, upto)
    return { upto }
  }

  /** Recent turns, oldest first, with the tool outcomes and approval results the model must see. */
  private async contextHistory(conversationId: string, vision: boolean, modalities: readonly AssistantModelModality[]): Promise<HistoryEntry[]> {
    const messages = await this.store.messages(conversationId, 200)
    const actions = await this.store.actionStatesForConversation(conversationId)
    const payloads = new Map<string, AttachmentPayload>()
    for (const entry of messages) {
      const ids = entry.attachments ?? []
      if (entry.role !== 'user' || !ids.length || payloads.has(entry.id)) continue
      payloads.set(entry.id, await expandChatAttachments(this.store, this.deps.env, ids, vision, modalities))
    }
    return messages
      .filter((entry) => entry.role === 'user' || entry.status === 'complete')
      .map((entry) => ({
        role: entry.role,
        content: withEntryAttachments(withApprovalOutcomes(entry, actions), entry.role, payloads.get(entry.id)),
        ...(entry.role === 'user' && payloads.get(entry.id)?.images.length
          ? { images: payloads.get(entry.id)!.images }
          : {}),
        createdAt: entry.createdAt,
        ...(entry.role === 'assistant'
          ? {
              calls: entry.tools.filter((tool) => tool.status !== 'running').map((tool) => ({
                id: tool.id,
                name: tool.name,
                args: {},
                result: tool.error ? JSON.stringify({ error: tool.error }) : '{"ok":true}',
                error: tool.status === 'error',
              })),
            }
          : {}),
      }))
  }

  private async recallMemories(query: string): Promise<Awaited<ReturnType<AssistantStore['searchMemories']>>> {
    const past = hasHistoricalIntent(query)
    const selected = new Map<string, Awaited<ReturnType<AssistantStore['searchMemories']>>[number]>()
    for (const memory of await this.fusedMemoryRecall(query, past)) selected.set(memory.id, memory)
    if (past) {
      for (const memory of [...selected.values()]) {
        for (const parent of await this.store.predecessors(memory.id)) {
          if (selected.size >= MAX_RELEVANT_MEMORIES) break
          selected.set(parent.id, parent)
        }
      }
    }
    for (const memory of await this.store.listMemories({ category: 'preference', status: 'active', limit: ALWAYS_INCLUDE_PREFERENCES })) {
      if (selected.size >= MAX_RELEVANT_MEMORIES) break
      selected.set(memory.id, memory)
    }
    return [...selected.values()]
  }

  /**
   * The words the reader used, and the vectors that agree with them.
   *
   * Word overlap is exact and free, so it stays the base list; the vector list adds the memory that
   * says the same thing in other words, which is the case the reference project's LIKE search missed.
   * A failed or absent embedding leaves the word list standing, so a Workers AI outage costs recall
   * quality rather than the answer.
   */
  private async fusedMemoryRecall(query: string, past: boolean) {
    const lexical = await this.store.searchMemories(query, MAX_RELEVANT_MEMORIES, past ? 'all' : 'current')
    if (!this.settings.semanticMemory || !this.deps.env.AI) return lexical
    try {
      const semantic = await rankMemoriesByVector(
        this.store,
        this.deps.env,
        query,
        past ? ['active', 'uncertain', 'historical'] : ['active', 'uncertain'],
        MAX_RELEVANT_MEMORIES,
        semanticModel(this.settings),
      )
      return fuseMemoryRecall(lexical, semantic, MAX_RELEVANT_MEMORIES)
    } catch {
      return lexical
    }
  }

  /** Resolved once per turn: every note tool consults it, and a second read would be a second answer. */
  private noteScope(): Promise<NoteScope> {
    if (!this.scopePromise) {
      this.scopePromise = resolveNoteScope(this.deps.env.DB, this.store.userId, this.settings.noteScope, {
        folderIds: this.turnScopes.filter((entry) => entry.kind === 'folder').map((entry) => entry.id),
        tagIds: this.turnScopes.filter((entry) => entry.kind === 'tag').map((entry) => entry.id),
      })
    }
    return this.scopePromise
  }

  /** The tags this turn was narrowed to, spelled the way the reader named them. */
  private scopeTagLabels(): string[] {
    return this.turnScopes.filter((entry) => entry.kind === 'tag').map((entry) => entry.name).slice(0, 8)
  }

  private async scopeLabels(): Promise<string[]> {
    if (!this.settings.noteScope.length) return []
    const placeholders = this.settings.noteScope.map((_, index) => `?${index + 2}`).join(', ')
    const { results } = await this.deps.env.DB.prepare(
      `SELECT name FROM folders WHERE user_id = ?1 AND id IN (${placeholders})`,
    ).bind(this.store.userId, ...this.settings.noteScope).all<{ name: string }>()
    return (results ?? []).map((row) => row.name)
  }

  private async toolContext(conversationId?: string): Promise<ToolContext> {
    const bounds = localDayBounds(this.settings.timezone)
    const store = this.store
    return {
      store,
      env: this.deps.env,
      ftsEnabled: this.deps.ftsEnabled,
      origin: this.deps.origin,
      settings: this.settings,
      timezone: this.settings.timezone,
      dayEnd: bounds.end,
      mode: conversationId ? 'chat' : 'scheduled',
      ...(conversationId ? { conversationId } : {}),
      memoryHistory: this.memoryHistory,
      automations: this.automations,
      noteScope: () => this.noteScope(),
      ...(conversationId
        ? {
            writeContext: {
              env: this.deps.env,
              userId: store.userId,
              ftsEnabled: this.deps.ftsEnabled,
              executionCtx: this.deps.executionCtx ?? syntheticContext(),
            } satisfies McpWriteContext,
          }
        : {}),
    }
  }

  private judgeConflict: ConflictJudge = async (older, newer) => {
    const resolved = await loadModelAndProvider(this.store, this.settings)
    if (!resolved.model || !resolved.provider) return null
    if (!(await this.reserve(1, this.settings.limits.maxRequestsPerDay))) return null
    const catalog = promptCatalog(this.settings.language)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    let text = ''
    try {
      for await (const event of streamUpstream(resolved.provider.protocol, {
        baseUrl: resolved.provider.base_url,
        apiKey: await this.store.providerKey(resolved.provider),
        model: resolved.model.model,
        system: catalog.conflict_system,
        turns: [{
          role: 'user',
          content: catalog.conflict_user
            .replace('{older}', JSON.stringify(older.slice(0, 500)))
            .replace('{newer}', JSON.stringify(newer.slice(0, 500))),
        }],
        tools: [],
        maxOutputTokens: 600,
        temperature: 0,
        reasoning: 'off',
        signal: controller.signal,
      })) {
        if (event.type === 'text') text += event.delta
      }
    } catch {
      await this.store.incrementUsage({ errors: 1 })
      return null
    } finally {
      clearTimeout(timer)
    }
    return parseVerdict(text)
  }

  /**
   * A scheduled routine: no conversation, read-only tools, and a reply that becomes a notification.
   *
   * The reader is not watching, so nothing here may write. That is enforced by the executor's mode
   * rather than by the prompt, because a routine that has drifted is exactly the case where a model
   * reaches for a write tool.
   */
  async runScheduledPrompt(prompt: string, signal: AbortSignal): Promise<string> {
    const resolved = await loadModelAndProvider(this.store, this.settings)
    if (!resolved.model || !resolved.provider) throw ApiError.badRequest('No model is configured for the assistant.')
    const limits = this.settings.limits
    if (!(await this.reserve(1, limits.maxRequestsPerDay))) {
      throw ApiError.conflict('The daily assistant request limit was reached.')
    }
    const selected = await this.recallMemories(prompt)
    const system = buildSystemPrompt({
      agentName: this.settings.agentName,
      language: this.settings.language,
      timezone: this.settings.timezone,
      localTime: describeLocalTime(new Date(), this.settings.timezone),
      autoMemory: false,
      memories: this.memoryHistory.promptMemories(selected, memoryTokenBudget(limits.maxContextTokens)),
      noteScope: this.settings.noteScope,
      noteScopeLabels: await this.scopeLabels(),
      scheduled: true,
    })
    const executor = new ToolExecutor(await this.toolContext(), { maxToolCalls: Math.min(limits.maxToolCalls, 4) })
    const schemas = executor.available().map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: parametersSchema(definition.fields),
    }))
    const turns: ModelTurn[] = [{ role: 'user', content: prompt }]
    const usage = { inputTokens: 0, outputTokens: 0 }
    let text = ''
    let steps = 0
    for (;;) {
      steps++
      const calls: ToolCallRecord[] = []
      for await (const event of this.step(resolved.provider.protocol, {
        baseUrl: resolved.provider.base_url,
        apiKey: await this.store.providerKey(resolved.provider),
        model: resolved.model.model,
        system,
        turns,
        tools: schemas,
        maxOutputTokens: Math.min(limits.maxOutputTokens, 800),
        temperature: this.settings.temperature,
        reasoning: resolved.model.reasoning,
        signal,
      }, calls, usage)) {
        if (event.type === 'text') text += event.delta ?? ''
      }
      if (!calls.length) break
      for (const call of calls) {
        try {
          call.result = JSON.stringify(await executor.execute(call.name, call.args, call.id) ?? null)
          call.error = false
        } catch (error) {
          call.result = JSON.stringify({ error: error instanceof Error ? error.message : 'failed' })
          call.error = true
        }
      }
      turns.push({ role: 'assistant', content: text, calls })
      text = ''
      if (steps >= Math.min(limits.maxAgentSteps, 3) || executor.budgetExhausted()) break
    }
    await this.store.incrementUsage({ toolCalls: executor.callCount, scheduledRuns: 1, ...usage })
    return text.trim() || '(no output)'
  }

  /**
   * Offline mode: an answer that costs nothing.
   *
   * It exists so the whole surface — conversations, tools, the settings screen — can be exercised
   * before a key is configured, and it says plainly that no model was called rather than pretending.
   */
  async offlineTurn(conversationId: string, content: string): Promise<AssistantMessage> {
    await this.store.addMessage({ conversationId, role: 'user', content })
    return await this.store.addMessage({
      conversationId,
      role: 'assistant',
      content: offlineAnswer(this.settings.language, `> ${content.slice(0, 400)}`),
    })
  }
}

/** The fragment a tool acted on, taken from its own arguments rather than invented. */
function detailFor(args: unknown): string | undefined {
  const record = (args ?? {}) as Record<string, unknown>
  const candidate = record.title ?? record.task ?? record.query ?? record.message ?? record.name ?? record.content
  if (typeof candidate !== 'string') return undefined
  return candidate.replace(/\s+/g, ' ').trim().slice(0, 90) || undefined
}

const APPROVAL_OUTCOME: Record<string, string> = {
  pending: 'waiting for the reader to approve it',
  approved: 'approved by the reader and done',
  cancelled: 'declined by the reader',
  expired: 'expired without an answer',
  failed: 'approved but failed',
}

/** Lets the model see what happened to the actions it proposed in an earlier turn. */
function withApprovalOutcomes(message: AssistantMessage, actions: Map<string, { status: string }>): string {
  const notes = message.tools.flatMap((tool) => {
    const approval = tool.approval ? actions.get(tool.approval.id) : undefined
    if (!approval) return []
    return [`[${tool.name} ${tool.approval?.targetLabel ?? ''}: ${APPROVAL_OUTCOME[approval.status] ?? approval.status}]`]
  })
  return notes.length ? `${message.content}\n\n${notes.join('\n')}`.trim() : message.content
}

export interface ContextWindow {
  messages: HistoryEntry[]
  overflow: HistoryEntry[]
}

/**
 * Fits the newest turns into `maxTokens`.
 *
 * The newest turn is always kept even when it does not fit: dropping the question the reader just
 * asked would produce an answer to nothing, which is worse than one oversized prompt.
 */
export function buildContextWindow(history: HistoryEntry[], maxTokens: number, summaryUpto: number | null): ContextWindow {
  const eligible = history.filter((entry) => entry.content.trim().length > 0 && (!summaryUpto || entry.createdAt > summaryUpto))
  const kept: HistoryEntry[] = []
  let used = 0
  for (let index = eligible.length - 1; index >= 0; index--) {
    const entry = eligible[index]!
    const cost = estimateTokens(entry.content) + 4
    if (kept.length > 0 && used + cost > maxTokens) break
    kept.unshift(entry)
    used += cost
  }
  // A conversation is expected to open with the reader's turn.
  while (kept.length > 1 && kept[0]!.role !== 'user') kept.shift()
  return {
    messages: kept.map((entry) => ({
      ...entry,
      content: entry.role === 'assistant' ? entry.content : entry.content.slice(0, 16_000),
    })),
    overflow: eligible.slice(0, Math.max(0, eligible.length - kept.length)),
  }
}

/** A user turn is the reader's text plus whatever their attachments contribute to this particular model. */
function withEntryAttachments(content: string, role: 'user' | 'assistant', payload: AttachmentPayload | undefined): string {
  if (role !== 'user' || !payload?.block) return content
  return `${content}\n\n${payload.block}`
}

function parseVerdict(text: string): { relationship: string, confidence: number, reason: string } | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed: unknown = JSON.parse(match[0])
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    const relationship = typeof record.relationship === 'string' ? record.relationship : ''
    if (!VERDICT_RELATIONSHIPS.includes(relationship)) return null
    const confidence = typeof record.confidence === 'number' ? record.confidence : 0
    return { relationship, confidence, reason: typeof record.reason === 'string' ? record.reason : '' }
  } catch {
    return null
  }
}

function errorCode(error: unknown): string {
  const status = (error as { status?: number })?.status
  if (status === 401 || status === 403) return 'forbidden'
  if (status === 429) return 'rate_limited'
  if ((error as UpstreamError)?.kind === 'quota' || (error as UpstreamError)?.kind === 'rate') return 'rate_limited'
  return 'internal'
}

function describeUpstreamFailure(error: unknown): string {
  if (error instanceof ToolError) return error.message
  if (error instanceof ApiError) return error.message
  if (error instanceof Error && (error as UpstreamError).kind) return error.message
  // A plain Error here is the platform, not the provider: a socket that would not open, an object
  // store that refused a read. Naming the key sends the reader to change a setting that was never the
  // problem, so the reason that actually happened is printed instead.
  const reason = error instanceof Error ? error.message.trim() : ''
  if (reason) return `The assistant could not finish this turn: ${reason.slice(0, 200)}`
  return 'The assistant could not answer. Check the model and key in Assistant settings.'
}

/**
 * A stand-in for the request's execution context when a turn runs outside one.
 *
 * The note tools hand background work to the platform; with no request to attach it to, running it
 * immediately is the only honest option, and it keeps a scheduled routine from dropping an index
 * update because nobody passed the context through.
 */
function syntheticContext(): ExecutionContext {
  return {
    waitUntil: (task: Promise<unknown>) => {
      void task.catch((error: unknown) => {
        console.warn('[inkstone] assistant background task failed:', error instanceof Error ? error.message : error)
      })
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
}
