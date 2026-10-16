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

import { MAX_MESSAGE_CHARS, toolPayloadText } from '@shared/assistant'
import type { AssistantMessage, AssistantModel, AssistantModelModality, AssistantProtocol, AssistantSettings, ChatStreamEvent, ToolActivity } from '@shared/assistant'
import { contextBudgetFor, customParamBody, MAX_CHAT_ATTACHMENTS, MAX_TURN_SCOPES, MAX_TURN_TOOLS, estimateTokens, titleFromMessage, type AssistantTurnScope } from '@shared/assistant'
import { hasHistoricalIntent, memoryTokenBudget } from '@shared/assistant-memory'
import { expandChatAttachments, type AttachmentPayload } from './attachments'
import { resolveNoteMentions } from './note-mentions'
import { loadExternalTools, type ExternalToolsResult } from './mcp-tools'
import { buildSystemPrompt, offlineAnswer, promptCatalog, summarizerPrompt } from '@shared/assistant-prompt'
import { describeLocalTime, localDayBounds } from '@shared/assistant-time'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { newId, isValidId } from '../lib/id'
import type { McpWriteContext } from '../mcp/writes'
import type { AssistantStore, MemoryScope, ProviderRow } from './store'
import { MemoryHistoryService, type ConflictJudge } from './memory-service'
import { AutomationService } from './automations'
import { resolveNoteScope, type NoteScope } from './note-scope'
import { matchVaultFolders, noteTitleIfLive } from './vault'
import { parametersSchema, ToolError, ToolExecutor, type ToolContext } from './tools'
import { AbortError, streamUpstream, UpstreamError, type ModelTurn, type ToolCallRecord, type ToolSchema, type UpstreamRequest, type UpstreamRetry, type UpstreamSource } from './upstream'
import { loadModelAndProvider, modelEndpoint, type ModelEndpoint } from './model-config'
import { fuseMemoryRecall, rankMemoriesByVector, semanticModel } from './semantic'

/** The two protocols with a vendor-side web search that can simply be asked for. */
const SEARCH_NATIVE_PROTOCOLS = new Set(['anthropic', 'gemini'])

/** Summarising costs a model call, so it only runs once enough history has piled up to be worth it. */
export const SUMMARIZE_THRESHOLD = 8

/**
 * The closing advice on every turn whose answer is missing because the model ran out of output room.
 *
 * One sentence, shared by the endings that mean it, because the setting named is the fix in each of them:
 * sending the reader to the model or the key instead is how a turn that merely needed a bigger allowance
 * was reported as a broken setup.
 */
const RAISE_OUTPUT_CAP = 'Raise “Max output tokens” for this model and ask again.'

/**
 * The same advice for a turn whose ceiling came from the account rather than from the model.
 *
 * Two numbers can answer for one turn — the model's own field, and the assistant-wide limit behind it
 * when that field is empty — and the runner names the one that actually cut the answer, because sending
 * the reader to the other field is how a setting that was never involved gets edited.
 */
const RAISE_ACCOUNT_OUTPUT_CAP = 'Raise the assistant’s own “Max output tokens” limit and ask again.'

/**
 * The deadlines on the two model calls that run beside a turn rather than as it.
 *
 * Both abort the request rather than answer for it, so what is being chosen is how long a reader waits
 * before the turn continues without the extra work: the summariser has a whole overflow to read and can
 * afford the most time, the conflict judge is asked about two paragraphs and is the one a writer notices
 * when it is late. A call that runs past its deadline is dropped, not retried, because both are work the
 * turn can proceed without.
 */
const SUMMARIZE_DEADLINE_MS = 45_000
const CONFLICT_JUDGE_DEADLINE_MS = 30_000

/**
 * How many extra attempts a model call gets before the turn reports the failure.
 *
 * Two is enough to ride out the two things that actually happen — a rate limit and a provider blinking —
 * without turning a genuinely broken key into a half-minute of waiting. The retry itself is the wire's
 * (see `streamUpstream`); what the runner supplies is the budget and the key ring behind it.
 */
const UPSTREAM_RETRY_ATTEMPTS = 2

/**
 * How many models a turn may walk down before it gives up.
 *
 * A chain is meant to be a primary and a spare, not a tour of the reader's whole catalogue: each extra
 * model is another round trip the reader waits through, and one that answers on the fourth try has already
 * spent the patience the first three were trying to save.
 */
const MAX_FALLBACK_MODELS = 3

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
  /**
   * What the reader had on screen when they asked: the note they were reading and the folder the
   * notebook was filtered to.
   *
   * The note is the stronger of the two — "summarise this" has to work without the reader naming the
   * note — so it is made readable for this turn, which is the one place a turn may reach past the
   * reader's standing folder scope. The folder is only a hint: it says which list they were looking at,
   * and every listing tool still filters by the scope.
   */
  contextNoteId?: string
  contextFolderId?: string
  /** The composer's web-search switch: ask this model for a live web search. */
  webSearch?: boolean
  /**
   * Start the conversation this turn needs as a temporary one.
   *
   * Only read when the turn creates its own conversation: a temporary thread is one the reader started
   * that way, and a later turn cannot turn a kept conversation into one — or the reverse — because the
   * promise is about the whole thread.
   */
  ephemeral?: boolean
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

/**
 * One model a turn may be answered by, with everything needed to call it already read.
 *
 * The provider is carried beside the model because the fallback chain crosses providers — a spare model
 * is usually another service's — and re-reading it per call would make the chain and the request disagree
 * about which key and address belong to which model.
 */
interface ResolvedCall {
  model: AssistantModel
  provider: ProviderRow
  call: ModelEndpoint
}

export class AssistantRunner {
  private readonly memoryHistory: MemoryHistoryService
  private readonly automations: AutomationService
  private scopePromise: Promise<NoteScope> | null = null
  private turnTools: string[] = []
  private webSearchRequested = false
  private webSearchNative = false
  private turnScopes: AssistantTurnScope[] = []
  /** The pages this turn searched, by url, in the order the vendor named them. */
  private readonly turnSources = new Map<string, UpstreamSource>()
  /** What the reader had on screen, held for the turn so the prompt and the scope agree. */
  private contextNoteId: string | null = null
  private contextFolderId: string | null = null
  private contextPromise: Promise<{ openNote: { id: string, title: string } | null, browsingFolder: string | null }> | null = null
  /** Set with the conversation, before anything asks for the scope or the prompt. */
  private conversationProjectId: string | null = null
  /** Set when a step's model call was cut off at the output cap instead of stopping by itself. */
  private turnTruncated = false

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
    // Also read before the scope is resolved: the note on screen is readable for this turn, and the
    // scope promise is what enforces that.
    // A turn's search results belong to that turn: a retry that searched again must not inherit the
    // pages the answer it replaced was built on.
    this.turnSources.clear()
    this.contextNoteId = isValidId(input.contextNoteId ?? '') ? input.contextNoteId! : null
    this.contextFolderId = isValidId(input.contextFolderId ?? '') ? input.contextFolderId! : null
    let conversation = input.conversationId ? await this.store.getConversation(input.conversationId) : null
    // The project comes from the row that was just read, so a conversation moved between projects is
    // answered under the one it is in now.
    this.conversationProjectId = conversation?.projectId ?? null
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
          reasoning: last.reasoning,
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
      if (message.length > MAX_MESSAGE_CHARS) throw ApiError.badRequest('That message is too long for one turn.')
      if (!conversation) {
        conversation = await this.store.createConversation(titleFromMessage(message), null, input.ephemeral === true)
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
    // Everything the turn has said so far, across its steps. The step's own text is what the model is
    // handed back after a tool call; this is what the reader watched arrive, and a turn filed from its
    // last step alone would drop the words that came before the call.
    let answer = ''
    // The whole turn's thinking, kept across steps because a turn that called a tool thought twice about
    // one question. Only what the model volunteered: a protocol that does not report a trace leaves this
    // empty, and an empty trace is what the fold needs to stay away.
    let reasoning = ''
    const tools: ToolActivity[] = []
    // The files this turn's tools made — an image the reader asked for — so they hang off the answer that
    // produced them rather than only off the call that drew them. This turn owns the array; the tool
    // context carries it, so every tool the executor runs is handed the same one.
    const generatedAttachments: string[] = []
    const finish = async (
      status: AssistantMessage['status'],
      error: string | null,
      usage: { inputTokens: number, outputTokens: number } | null,
    ) => await this.store.addMessage({
      id: assistantId,
      conversationId,
      role: 'assistant',
      content: answer,
      reasoning,
      tools,
      attachments: generatedAttachments,
      status,
      error,
      durationMs: Math.max(0, Date.now() - startedAt),
      modelLabel,
      usage,
      sources: [...this.turnSources.values()],
    })

    try {
      const resolved = await loadModelAndProvider(this.store, this.settings)
      if (!resolved.model || !resolved.provider) {
        throw ApiError.badRequest('No model is configured yet. Pick one under Assistant settings, or turn on offline mode.')
      }
      const primary: ResolvedCall = {
        model: resolved.model,
        provider: resolved.provider,
        call: modelEndpoint(resolved.model, resolved.provider),
      }
      // The reader's own model first, then whatever chain it names. Read once, because the model that
      // answers the first step is the one that answers the whole turn: a reply that changed voice after a
      // tool call would be two answers sold as one.
      const chain = await this.modelChain(primary)
      // Which of the chain is answering right now. Mutated by the failover step rather than returned from
      // it, because a generator's value is not reachable through `for await`.
      const served = { current: primary }
      let { model, provider, call } = primary
      modelLabel = model.label
      const limits = this.settings.limits
      // A 1M model and a 4K model do not get fed the same amount: the reader sets this per model on the
      // composer's context control, and the assistant-wide ceiling is what a model without one falls back
      // to — for the window and for the input ceiling over it alike.
      const contextTokens = contextBudgetFor(model, limits)
      if (!(await this.reserve(1, limits.maxRequestsPerDay, { providerId: provider.id, providerLabel: provider.label }, model.label))) {
        throw ApiError.conflict(`The daily limit of ${limits.maxRequestsPerDay} assistant requests is reached. It is adjustable in Assistant settings.`)
      }

      yield { type: 'stage', stage: 'reading' }
      // The reader's own third-party tools are listed once per turn, and before the prompt is written:
      // the web-search switch works on a protocol with no vendor search by naming one of these tools to
      // the model, which only lands if the prompt has not been built yet. A server that is slow or down is
      // reported to the settings screen rather than failing the answer.
      const external: ExternalToolsResult = await loadExternalTools(this.store)
      this.webSearchNative = this.webSearchRequested && SEARCH_NATIVE_PROTOCOLS.has(call.protocol)
      if (this.webSearchRequested && !this.webSearchNative) {
        // No vendor-side search on this protocol: the next best thing that is actually true is a remote
        // tool that can search, named for the model in the same line the reader's own pins use.
        const searcher = external.definitions.find((definition) => /search|query|web|browse/i.test(definition.name))
        if (searcher && !this.turnTools.includes(searcher.name)) this.turnTools = [...this.turnTools, searcher.name].slice(0, MAX_TURN_TOOLS)
      }
      const selected = await this.recallMemories(userMessage?.content ?? message)
      const memories = this.memoryHistory.promptMemories(selected, memoryTokenBudget(contextTokens))
      const history = await this.contextHistory(conversationId, model.vision, model.modalities)
      const context = await this.contextLabels()
      const project = await this.project()
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
        openNote: context.openNote,
        browsingFolder: context.browsingFolder,
        project: project?.instructions ? { name: project.name, instructions: project.instructions } : null,
      })
      const historyBudget = Math.max(500, contextTokens - estimateTokens(system) - 600)
      let window = buildContextWindow(history, historyBudget, conversation.summaryUpto ?? null)

      if (window.overflow.length >= SUMMARIZE_THRESHOLD) {
        const rolled = await this.summarize(conversationId, conversation.summary ?? null, window.overflow)
        if (rolled) window = buildContextWindow(history, historyBudget, rolled.upto)
      }

      yield { type: 'stage', stage: 'generating' }
      const executor = new ToolExecutor(await this.toolContext(conversationId, generatedAttachments), { maxToolCalls: limits.maxToolCalls }, external.definitions)
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
      // What one step may spend, thinking included. The model's own ceiling is the whole answer here and
      // the account's number answers only for a model the reader has not set: taking the lower of the two
      // let the account default (1024) silently outrank a model the reader had set to 64000. Kept in a
      // name because a turn cut off at it has to say the number that cut it.
      const capFor = (entry: ResolvedCall) => entry.model.maxOutputTokens ?? limits.maxOutputTokens
      let outputCap = capFor(primary)
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
        // Judged per step and only the last step's verdict is kept: a step cut off mid-tool-call is
        // repaired by the step after it, while a cut-off *answer* is what must not be filed as whole.
        this.turnTruncated = false
        // The first step is where a model may be swapped for one further down the chain; every step after
        // it is answered by whichever model got through, so a reply never changes voice halfway.
        const candidates = steps === 1 ? chain : [served.current]
        for await (const event of this.stepWithFailover(candidates, served, (entry, apiKey) => ({
          baseUrl: entry.call.baseUrl,
          apiKey,
          model: entry.model.model,
          system,
          turns,
          // A model that invents tool calls is silenced by not sending the schemas at all.
          tools: entry.model.supportsTools ? schemas : [],
          webSearch: this.webSearchNative,
          maxOutputTokens: capFor(entry),
          temperature: entry.model.temperature,
          topP: entry.model.topP,
          extraBody: customParamBody(entry.model.customParams),
          reasoning: entry.model.reasoning,
          reasoningDialect: entry.call.reasoningDialect,
          retry: this.retryFor(entry.provider),
          signal: input.signal,
        }), calls, usage)) {
          if (event.type === 'text') text += event.delta ?? ''
          if (event.type === 'reasoning') reasoning += event.delta ?? ''
          // A reader who pressed stop released the lease; on a platform that does not report the
          // dropped connection, this is what ends the turn. Every sixteenth event keeps the extra read
          // off the critical path while still stopping within a couple of hundred characters.
          if (++eventsSeen % 16 === 0 && !(await this.store.isRunning(conversationId))) throw new AbortError()
          yield event
        }
        // Everything below is about the model that actually answered, which a failover may have moved.
        model = served.current.model
        provider = served.current.provider
        call = served.current.call
        modelLabel = model.label
        outputCap = capFor(served.current)
        // The step's words go into the answer before anything can end the turn. A step that asked for no
        // tool is the one that wrote the answer, and it ends the turn right here — accumulating after this
        // point filed every plain reply as empty, which is what the reader saw as a finished turn with no
        // answer in it, and the model read back as its own last words on the next question.
        answer += text
        if (!calls.length) break
        for (const call of calls) {
          // What the model asked for travels with the chip, so a thread opened tomorrow can still answer
          // "what did it search for". It is the same text the model produced, clipped by the shared cap.
          const activity: ToolActivity = { id: call.id, name: call.name, status: 'running', args: toolPayloadText(call.args) }
          tools.push(activity)
          yield { type: 'tool', tool: { ...activity } }
          try {
            const result = await executor.execute(call.name, call.args, call.id)
            call.result = JSON.stringify(result ?? null)
            call.error = false
            // What came back, kept beside the arguments above. The `result` sent to the model stays the
            // compact JSON the wire wants; what the reader is shown is the tool's own text where the tool
            // returned text, because a quoted JSON string is not what the search returned.
            activity.result = toolPayloadText(result)
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
        if (!(await this.reserve(1, limits.maxRequestsPerDay, { providerId: provider.id, providerLabel: provider.label }, model.label))) {
          yield { type: 'error', code: 'rate_limited', message: 'The daily assistant request limit was reached during this turn.' }
          break
        }
      }

      if (!usage.inputTokens && !usage.outputTokens) {
        usage.inputTokens = estimateTokens(system) + turns.reduce((total, turn) => total + estimateTokens(turn.content), 0)
        usage.outputTokens = estimateTokens(answer)
      }
      // The label travels with the counters so the day's models can be told apart: a reader with two
      // providers has two prices, and one total cannot be split after the fact. The provider rides along
      // too, so the same counters can be read back per key.
      await this.store.incrementUsage({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        toolCalls: executor.callCount,
      }, undefined, modelLabel, { providerId: provider.id, providerLabel: provider.label })
      if (stopped()) {
        yield { type: 'done', finalMessage: await finish('cancelled', null, usage) }
        return
      }
      // A turn the model never finished, or never started, is an error with a reason rather than an
      // answer: storing the apology as the content made the model read it back as its own last words,
      // and filed a fragment as if the model had chosen to stop there.
      let outcome: AssistantMessage['status'] = 'complete'
      let failure: string | null = null
      // Which of the two ceilings answered for this turn, so the notice sends the reader to that field.
      const capAdvice = model.maxOutputTokens === null ? RAISE_ACCOUNT_OUTPUT_CAP : RAISE_OUTPUT_CAP
      if (this.turnTruncated) {
        outcome = 'error'
        // The cap is a number the reader set somewhere, so it is named; a turn that stops mid-sentence and
        // says nothing leaves them guessing whether the model was finished or merely out of room.
        failure = answer.trim()
          ? `The model was cut off at its ${outputCap}-token output limit, so the answer above stops where it does. ${capAdvice}`
          : `The model spent the whole ${outputCap}-token output allowance thinking and never wrote an answer. ${capAdvice}`
      } else if (!answer.trim()) {
        if (tools.some((tool) => tool.status === 'success')) answer = 'Done.'
        else {
          outcome = 'error'
          // A model that thought and then stopped writes no answer at all, and the trace is the only
          // evidence of why. Telling the reader to check the model or the key sends them to a setting that
          // was never the problem, so the trace is named and the same advice is offered.
          failure = reasoning.trim()
            ? `The model wrote only its thinking and no answer. ${capAdvice}`
            : 'I could not produce an answer this time. Try rephrasing, or check the model in Assistant settings.'
        }
      }
      yield { type: 'usage', usage }
      // Read the signal again here: every `yield` above hands control back to the response writer, and
      // a reader who stopped the turn in the meantime must not have their half answer filed as whole.
      yield { type: 'done', finalMessage: await finish(stopped() ? 'cancelled' : outcome, failure, usage) }
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
      // The cap signal is the runner's own business: the client has no event for it, and what the
      // reader needs to know arrives as the notice on the stored turn.
      if (event.type === 'truncated') {
        this.turnTruncated = true
        continue
      }
      // What a search found. Collected as it arrives rather than at the end because the vendor reports
      // it beside the text it feeds; Gemini repeats its whole list on every frame, so the same page
      // would otherwise be listed a dozen times.
      if (event.type === 'sources') {
        for (const source of event.sources) {
          if (!this.turnSources.has(source.url)) this.turnSources.set(source.url, source)
        }
        continue
      }
      calls.push({ id: event.id, name: event.name, args: event.args, result: '', error: false })
    }
  }

  /**
   * One step, walked down the chain until a model answers it.
   *
   * A model that cannot be reached at all — the vendor has retired it, the service is down, the account's
   * keys are all spent — is the case the reader's fallback exists for, and the next candidate is tried. The
   * two things that stop that are the ones that would make it dishonest: a failure *after* words have been
   * streamed, which cannot be taken back, and a failure that is about the request itself, which the next
   * model would refuse just as flatly.
   *
   * What a failed attempt produced is rolled back with it. A trace, a set of search results or a truncation
   * flag left behind by an attempt that never answered would be attributed to the model that did, and the
   * turn would report a cap it was never cut off at.
   */
  private async *stepWithFailover(
    candidates: readonly ResolvedCall[],
    served: { current: ResolvedCall },
    requestFor: (entry: ResolvedCall, apiKey: string) => UpstreamRequest,
    calls: ToolCallRecord[],
    usage: { inputTokens: number, outputTokens: number },
  ): AsyncGenerator<ChatStreamEvent> {
    let failure: unknown = null
    for (const entry of candidates) {
      const attemptCalls: ToolCallRecord[] = []
      const attemptUsage = { inputTokens: 0, outputTokens: 0 }
      const sourcesBefore = new Set(this.turnSources.keys())
      const truncatedBefore = this.turnTruncated
      let spoke = false
      try {
        const apiKey = await this.signKey(entry.provider)
        for await (const event of this.step(entry.call.protocol, requestFor(entry, apiKey), attemptCalls, attemptUsage)) {
          spoke = true
          yield event
        }
        // Only a call that got through is charged, and only its calls and counters are kept.
        usage.inputTokens += attemptUsage.inputTokens
        usage.outputTokens += attemptUsage.outputTokens
        calls.push(...attemptCalls)
        served.current = entry
        return
      } catch (error) {
        failure = error
        if (spoke || !worthAnotherModel(error)) throw error
        for (const url of this.turnSources.keys()) if (!sourcesBefore.has(url)) this.turnSources.delete(url)
        this.turnTruncated = truncatedBefore
      }
    }
    throw failure ?? new Error('No model in the fallback chain could answer.')
  }

  /**
   * The models this turn may be answered by, in the order they will be tried.
   *
   * The reader's own choice comes first and each model may name the one behind it. The walk stops at a
   * model already in the chain, which is what two models naming each other would otherwise become, and at
   * a model that has since been turned off or deleted — a dangling name is skipped rather than followed
   * into a failure the reader cannot see the cause of.
   */
  private async modelChain(primary: ResolvedCall): Promise<ResolvedCall[]> {
    const chain: ResolvedCall[] = [primary]
    const seen = new Set([primary.model.id])
    while (chain.length < MAX_FALLBACK_MODELS) {
      const nextId = chain[chain.length - 1]!.model.fallbackModelId
      if (!nextId || seen.has(nextId)) break
      seen.add(nextId)
      const model = await this.store.getModel(nextId)
      if (!model || !model.enabled) break
      const provider = await this.store.providerRecord(model.providerId)
      if (!provider) break
      chain.push({ model, provider, call: modelEndpoint(model, provider) })
    }
    return chain
  }

  /**
   * The key this call signs with, taken from the provider's ring and marked as just used.
   *
   * Marking it is what makes the rotation rotate: the next call sorts the least recently used key first,
   * so a turn that takes several steps spreads across the ring instead of pinning the first one.
   */
  private async signKey(provider: ProviderRow): Promise<string> {
    const picked = await this.store.pickProviderKey(provider)
    if (!picked) return ''
    await this.store.markProviderKeyUsed(provider.id, picked.keyId)
    return picked.key
  }

  /**
   * The retry policy every call to a provider is made under.
   *
   * A second attempt is signed with a fresh key, which is the whole point of the reader's ring: a 429 or a
   * 401 on one key is answered by the next one, and the ring hands out the least recently used so a retry
   * does not land on the key that just failed.
   */
  private retryFor(provider: ProviderRow): UpstreamRetry {
    return { attempts: UPSTREAM_RETRY_ATTEMPTS, rotateKey: async () => await this.signKey(provider) }
  }

  /** Charges one or more model calls against the reader's daily ceiling, refusing when it is spent. */
  private async reserve(
    count: number,
    maxPerDay: number,
    keyRef?: { providerId: string, providerLabel: string },
    modelLabel = '',
  ): Promise<boolean> {
    const today = await this.store.todayUsage()
    if (today.requests + count > maxPerDay) return false
    // The request is charged with the model and key that will answer it, so a per-key or per-model view
    // counts calls as well as tokens rather than losing them to an unlabelled row.
    await this.store.incrementUsage({ requests: count }, undefined, modelLabel, keyRef)
    return true
  }

  private async summarize(
    conversationId: string,
    previous: string | null,
    overflow: HistoryEntry[],
  ): Promise<{ upto: number } | null> {
    const resolved = await loadModelAndProvider(this.store, this.settings)
    if (!resolved.model || !resolved.provider) return null
    const call = modelEndpoint(resolved.model, resolved.provider)
    const transcript = overflow
      .map((entry) => `${entry.role === 'user' ? 'Reader' : 'Assistant'}: ${entry.content.slice(0, 1500)}`)
      .join('\n')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SUMMARIZE_DEADLINE_MS)
    let text = ''
    try {
      if (!(await this.reserve(1, this.settings.limits.maxRequestsPerDay))) return null
      for await (const event of streamUpstream(call.protocol, {
        baseUrl: call.baseUrl,
        apiKey: await this.signKey(resolved.provider),
        model: resolved.model.model,
        system: promptCatalog(this.settings.language).summarizer_system,
        turns: [{ role: 'user', content: summarizerPrompt(this.settings.language, previous, transcript) }],
        tools: [],
        maxOutputTokens: 400,
        temperature: 0.2,
        // A summary is arithmetic on text, not a question: thinking only costs the reader's budget.
        reasoning: 'off',
        reasoningDialect: call.reasoningDialect,
        retry: this.retryFor(resolved.provider),
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
    const entries: HistoryEntry[] = messages
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
    // The mentions in the turn being asked are resolved here, once, so the model is handed the note's
    // words rather than a title it would have to guess a lookup for. Only the last user turn: an older
    // one's mentions were answered when it was asked, and re-reading them would spend the budget twice.
    let lastUser: HistoryEntry | undefined
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index]!.role === 'user') { lastUser = entries[index]; break }
    }
    if (lastUser) {
      const block = await resolveNoteMentions(this.deps.env.DB, this.store.userId, lastUser.content, await this.noteScope())
      if (block) lastUser.content = `${lastUser.content}\n\n${block}`
    }
    return entries
  }

  /**
   * Which memories this turn may see: the account's own, plus the project the thread belongs to.
   *
   * Read from the conversation rather than the request, because it is a property of where the thread
   * lives. A thread outside every project sees the account's memories and nothing else — narrower than
   * "no filter", which is why this is a scope and not an optional argument.
   */
  private get memoryScope(): MemoryScope {
    return { projectId: this.conversationProjectId }
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
    for (const memory of await this.store.listMemories({
      category: 'preference',
      status: 'active',
      limit: ALWAYS_INCLUDE_PREFERENCES,
      scope: this.memoryScope,
    })) {
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
    const lexical = await this.store.searchMemories(query, MAX_RELEVANT_MEMORIES, past ? 'all' : 'current', this.memoryScope)
    if (!this.settings.semanticMemory || !this.deps.env.AI) return lexical
    try {
      const semantic = await rankMemoriesByVector(
        this.store,
        this.deps.env,
        query,
        past ? ['active', 'uncertain', 'historical'] : ['active', 'uncertain'],
        MAX_RELEVANT_MEMORIES,
        semanticModel(this.settings),
        this.memoryScope,
      )
      return fuseMemoryRecall(lexical, semantic, MAX_RELEVANT_MEMORIES)
    } catch {
      return lexical
    }
  }

  /** Resolved once per turn: every note tool consults it, and a second read would be a second answer. */
  private async noteScope(): Promise<NoteScope> {
    if (!this.scopePromise) {
      const project = await this.project()
      const base = this.settings.noteScope
      // The project's folders narrow, never widen: where they and the account's scope do not meet, the
      // account's own permission stands and the project contributes no folder of its own.
      const effective = project && project.scopeIds.length
        ? base.filter((id) => project.scopeIds.includes(id))
        : base
      this.scopePromise = resolveNoteScope(this.deps.env.DB, this.store.userId, effective, {
        folderIds: this.turnScopes.filter((entry) => entry.kind === 'folder').map((entry) => entry.id),
        tagIds: this.turnScopes.filter((entry) => entry.kind === 'tag').map((entry) => entry.id),
        // The note the reader had open. This is the one narrowing a turn may widen: "summarise this"
        // is a question about the page in front of them, and refusing it because the folder they
        // excluded happens to hold it would answer a question nobody asked.
        noteIds: this.contextNoteId ? [this.contextNoteId] : [],
      })
    }
    return this.scopePromise
  }

  /**
   * The conversation's project, resolved once per turn.
   *
   * Its brief rides in the prompt and its folders narrow what the note tools may read — the narrow
   * direction only, because a project is the reader telling the assistant what this work is about, not a
   * second permission. When the two scopes do not overlap the project's is dropped rather than left as a
   * set with nothing in it, which would make every tool answer "not found" for a reason the reader
   * cannot see.
   */
  private projectPromise: Promise<{ name: string, instructions: string, scopeIds: string[] } | null> | null = null

  private project() {
    if (!this.projectPromise) {
      this.projectPromise = (async () => {
        const projectId = this.conversationProjectId
        if (!projectId) return null
        const project = await this.store.getProject(projectId)
        if (!project) return null
        const brief = project.instructions.trim()
        if (!project.noteScope.length && !brief) return null
        return { name: project.name, instructions: brief, scopeIds: project.noteScope }
      })()
    }
    return this.projectPromise
  }

  /**
   * The note and folder the reader had on screen, named for the prompt.
   *
   * Both are read rather than taken from the request: the note has to be one they own and have not
   * deleted, and the folder's name is this vault's — a caller that named its own folder would be
   * writing a line of the system prompt.
   */
  private contextLabels() {
    if (!this.contextPromise) {
      this.contextPromise = (async () => {
        const openNote = this.contextNoteId
          ? await noteTitleIfLive(this.deps.env.DB, this.store.userId, this.contextNoteId)
          : null
        const folderMatch = this.contextFolderId
          ? (await matchVaultFolders(this.deps.env.DB, this.store.userId, this.contextFolderId))[0]
          : undefined
        return {
          openNote: openNote ? { id: this.contextNoteId!, title: openNote } : null,
          browsingFolder: folderMatch?.label ?? null,
        }
      })()
    }
    return this.contextPromise
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

  private async toolContext(conversationId?: string, generatedAttachments?: string[]): Promise<ToolContext> {
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
      memoryScope: this.memoryScope,
      automations: this.automations,
      noteScope: () => this.noteScope(),
      ...(generatedAttachments ? { generatedAttachments } : {}),
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
    const call = modelEndpoint(resolved.model, resolved.provider)
    if (!(await this.reserve(1, this.settings.limits.maxRequestsPerDay))) return null
    const catalog = promptCatalog(this.settings.language)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CONFLICT_JUDGE_DEADLINE_MS)
    let text = ''
    try {
      for await (const event of streamUpstream(call.protocol, {
        baseUrl: call.baseUrl,
        apiKey: await this.signKey(resolved.provider),
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
        reasoningDialect: call.reasoningDialect,
        retry: this.retryFor(resolved.provider),
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
    // A routine runs unwatched, so a model the vendor has retired or a service that is down would fail it
    // silently. It walks the same fallback chain a turn does, for the same reason.
    const primary: ResolvedCall = {
      model: resolved.model,
      provider: resolved.provider,
      call: modelEndpoint(resolved.model, resolved.provider),
    }
    const chain = await this.modelChain(primary)
    const served = { current: primary }
    const usage = { inputTokens: 0, outputTokens: 0 }
    let text = ''
    let steps = 0
    for (;;) {
      steps++
      const calls: ToolCallRecord[] = []
      for await (const event of this.stepWithFailover(steps === 1 ? chain : [served.current], served, (entry, apiKey) => ({
        baseUrl: entry.call.baseUrl,
        apiKey,
        model: entry.model.model,
        system,
        turns,
        tools: schemas,
        maxOutputTokens: Math.min(limits.maxOutputTokens, 800),
        temperature: this.settings.temperature,
        reasoning: entry.model.reasoning,
        reasoningDialect: entry.call.reasoningDialect,
        retry: this.retryFor(entry.provider),
        signal,
      }), calls, usage)) {
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
      content: entry.role === 'assistant' ? entry.content : entry.content.slice(0, MAX_MESSAGE_CHARS),
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

/**
 * Whether a failure says something about one model's door rather than about the request.
 *
 * A model the vendor has retired, a service that is down, a key that is out of quota or was refused: all
 * four are answered by trying the reader's spare. A request the provider rejected on its own terms is not,
 * because the next model would reject it too and the reader would only have waited longer to be told.
 * Anything that is not an upstream failure at all — a stop, a bug — is the turn's own to report.
 */
function worthAnotherModel(error: unknown): boolean {
  return error instanceof UpstreamError && error.kind !== 'bad-request'
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
