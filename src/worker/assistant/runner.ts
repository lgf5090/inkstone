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

import { MAX_MESSAGE_CHARS, SEARCH_NATIVE_PROTOCOLS, WEB_SEARCH_TOOL_NAME, looksLikeSearchTool, toolModeFor, toolPayloadText, webSearchConfigured } from '@shared/assistant'
import { webSearchEngineFor } from '@shared/web-search-engines'
import type { AssistantMessage, AssistantModel, AssistantModelModality, AssistantProtocol, AssistantSettings, AssistantSource, ChatStreamEvent, ToolActivity } from '@shared/assistant'
import { contextBudgetFor, customParamBody, MAX_CHAT_ATTACHMENTS, MAX_CONVERSATION_TITLE_CHARS, MAX_TURN_SCOPES, MAX_TURN_TOOLS, clipSuggestionList, estimateTokens, titleFromMessage, type AssistantTurnScope } from '@shared/assistant'
import { hasHistoricalIntent, memoryTokenBudget } from '@shared/assistant-memory'
import { ATTACHMENT_MARKER, expandChatAttachments, type AttachmentPayload } from './attachments'
import { resolveNoteMentions } from './note-mentions'
import { loadExternalTools, type ExternalToolsResult } from './mcp-tools'
import { buildSystemPrompt, namingPrompt, offlineAnswer, promptCatalog, summarizerPrompt } from '@shared/assistant-prompt'
import { describeLocalTime, localDayBounds } from '@shared/assistant-time'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { newId, isValidId } from '../lib/id'
import type { McpWriteContext } from '../mcp/writes'
import type { AssistantStore, MemoryScope, ProviderRow } from './store'
import { MemoryHistoryService, type ConflictJudge } from './memory-service'
import { AutomationService } from './automations'
import { resolveNoteScope, turnNoteIds, type NoteScope } from './note-scope'
import { noteCitationsFromTool } from './note-citations'
import { matchVaultFolders, noteTitleIfLive } from './vault'
import { parametersSchema, ToolError, ToolExecutor, type ToolContext } from './tools'
import { AbortError, streamUpstream, UpstreamError, type ChatAudioPart, type ModelTurn, type ToolCallRecord, type ToolSchema, type UpstreamRequest, type UpstreamRetry, type UpstreamStopReason } from './upstream'
import { webSearchSources } from './web-search'
import { loadModelAndProvider, modelEndpoint, type ModelEndpoint } from './model-config'
import { pickModelForTurn } from '@shared/assistant-routing'
import { fuseMemoryRecall, rankMemoriesByVector, semanticModel } from './semantic'

/** Summarising costs a model call, so it only runs once enough history has piled up to be worth it. */
export const SUMMARIZE_THRESHOLD = 8

/**
 * The room a turn keeps in its prompt for what the prompt itself cannot know yet.
 *
 * The window was cut against the model's whole context minus a slack figure, so a turn that also meant to
 * use its output allowance — and then appended the tool results a step reads back — went past the ceiling
 * by exactly those two numbers, and nothing could take the prompt back down: the provider's refusal was
 * what the reader saw. The reserve is not one result's worth but several, which is what a multi-step turn
 * carries by the time it answers.
 */
const TOOL_RESULT_RESERVE_TOKENS = 1_000

/**
 * How much of one old tool answer the model is shown again.
 *
 * Smaller than the bound the reader's own chip is kept under (`MAX_TOOL_PAYLOAD_CHARS`), because this text
 * goes back out on every step of every later turn: a listing from forty messages ago is worth its beginning,
 * not its payload.
 */
const MAX_HISTORY_TOOL_RESULT_CHARS = 1_500

/**
 * How many citations one turn may carry, and how long each address may be.
 *
 * The same bounds a stored row is read back under (`decodeSources`), applied where the list is built rather
 * than where it is parsed: which pages a vendor names is the vendor's decision, and a row that answers to it
 * is carried every time the thread is opened.
 */
export const MAX_TURN_SOURCES = 20
export const MAX_SOURCE_URL_CHARS = 2_000

/**
 * What the reader is told when the roll-up of their older turns could not be written.
 *
 * The answer still arrives and is still good, so this is not a failure of the turn; it is the one thing
 * about it the reader cannot otherwise see — that the thread behind the answer was left un-condensed, and
 * the window is shorter than they believe it to be.
 */
const SUMMARY_UNAVAILABLE = 'The assistant could not condense this conversation’s older turns, so this answer sees less of the thread than it should.'

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
 * What a turn says when a provider rule, not the model, stopped the answer.
 *
 * A refusal is the model's own decision and a filter is the service's, so they are named apart: the reader
 * needs to know whether the model would not answer or was not allowed to. Neither is a cap that can be
 * raised, so both are answered by rephrasing or by another model.
 */
const TURN_REFUSED = 'The model declined to answer, so the reply above stops where it does. Try rephrasing it, or ask a different model.'
const TURN_FILTERED = 'The provider cut this reply short under its own content rules, so the answer above stops where it does. Try rephrasing it, or ask a different model.'

/**
 * The deadlines on the model calls that run beside a turn rather than as it.
 *
 * All of them abort the request rather than answer for it, so what is being chosen is how long a reader waits
 * before the turn proceeds without the extra work: the summariser has a whole overflow to read and can
 * afford the most time, the conflict judge is asked about two paragraphs and is the one a writer notices
 * when it is late. The naming pass runs after the reader's answer is already on screen and filed, so it is
 * the shortest leash here — a title that has not arrived by now is not worth making the isolate wait for. A
 * call that runs past its deadline is dropped, not retried, because all three are work the turn can proceed
 * without.
 */
const SUMMARIZE_DEADLINE_MS = 45_000
const CONFLICT_JUDGE_DEADLINE_MS = 30_000
/** The naming pass reads one short exchange and writes a dozen words; a quarter of a minute is generous. */
const NAMING_DEADLINE_MS = 25_000
/**
 * The output ceiling on the naming call, in tokens.
 *
 * A title and at most three follow-up questions do not need the model's whole allowance, and asking for less
 * is the one lever that actually makes this second call cheaper than the turn it follows. Bounded well above
 * the words it means to emit so a chatty model is cut off rather than allowed to run, and the JSON is read
 * from whatever arrived.
 */
const NAMING_MAX_OUTPUT_TOKENS = 200

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

/**
 * How many of one step's tool calls run at the same time.
 *
 * The calls a model asks for in one step are usually independent lookups, and running them back-to-back
 * made the reader pay the sum of their waits for work that never depended on each other. Unbounded is the
 * other wrong answer: a turn that invented twelve calls would open twelve database reads or remote tool
 * calls at once, against one shared D1 connection and the reader's own rate limits. Four is where a step
 * that genuinely fans out is already covered and a runaway list still cannot outrun the queue.
 */
const TOOL_CONCURRENCY = 4

const MAX_RELEVANT_MEMORIES = 8
const ALWAYS_INCLUDE_PREFERENCES = 4
const VERDICT_RELATIONSHIPS = ['supersedes', 'refines', 'contradicts', 'complements', 'unrelated']

/**
 * How many stored turns a turn reads before the budget does the cutting.
 *
 * The window is what bounds the prompt, not this number: a 1M-token model can hold more than 200 turns,
 * and reading a generous page costs one indexed query. The old 200 was both the read and the effective
 * ceiling, so early turns fell out of reach of a model that could have read them.
 */
const CONTEXT_HISTORY_MESSAGES = 400

/** How many of the most recent turns may carry picture bytes; older ones are named, not re-sent. */
const IMAGE_RECENT_TURNS = 2

export interface RunnerDeps {
  store: AssistantStore
  env: Env
  ftsEnabled: boolean
  origin: string
  executionCtx?: ExecutionContext
  settings: AssistantSettings
  /** The run lease the caller already claimed, so this turn renews and never steals another run's. */
  runToken?: number | null
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
  /**
   * The note this thread began beside.
   *
   * Separate from `contextNoteId`, which is per-turn: this one is written onto the conversation the first
   * time it is known, so coming back to the thread still says where it came from.
   */
  originNoteId?: string
  /** The composer's web-search switch: ask this model for a live web search. */
  webSearch?: boolean
  /**
   * The model the caller named for this turn.
   *
   * Absent means today's behaviour: the reader's own pick, or the router's. Present, it answers the whole
   * turn — primary call, the chain of spares behind it, and the counters filed against whichever of them
   * replied — because a turn that quietly used the account default instead of the model it was asked for
   * is indistinguishable from one that was answered correctly. Checked against ownership and against the
   * `chat` purpose where the request is read; a runner that cannot resolve it answers as an unconfigured
   * turn rather than reaching for the reader's standing pick.
   */
  modelId?: string | null
  /**
   * Answer this turn without tools.
   *
   * No schema goes out — the same path a model with `supportsTools` turned off already takes — and a call
   * the model invents anyway is refused rather than run, because a turn asked to compare two answers must
   * not write to the vault a second time after the thread's own answer already did. The refusal is filed on
   * the row, so a reader who opens the answer later can see why it cites nothing.
   */
  noTools?: boolean
  /**
   * Start the conversation this turn needs as a temporary one.
   *
   * Only read when the turn creates its own conversation: a temporary thread is one the reader started
   * that way, and a later turn cannot turn a kept conversation into one — or the reverse — because the
   * promise is about the whole thread.
   */
  ephemeral?: boolean
  retry?: boolean
  /**
   * Pick up the last answer where it stopped.
   *
   * Not a retry: nothing is thrown away and nothing is asked again. The model is handed the answer it
   * had written and told to go on, and the row is rewritten with the whole of it.
   */
  continueTurn?: boolean
  /**
   * The answer to ask again, when it is not the newest one.
   *
   * A turn in the middle of a thread is re-answered by removing it and everything after it — the later
   * turns were drawn from the answer being replaced — and the answer itself is filed as a version first,
   * so the words are recoverable even though the row is not.
   */
  retryFromMessageId?: string
  signal: AbortSignal
  /** True once a write to the reader has failed, which is the only disconnect some platforms surface. */
  readerGone?: () => boolean
}

interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  /**
   * The row's own id, kept because a millisecond is not an order.
   *
   * Two turns written in the same one are told apart by the rowid the store sorts on, which an id cannot
   * recover — so this is an identity, used to name the row a summary was cut at, and not a comparison.
   * Absent on an entry assembled by hand rather than read from a row.
   */
  id?: string
  calls?: ToolCallRecord[]
  images?: { mime: string, dataUrl: string }[]
  /** Recordings the turn plays with its text; set only for a wire that has the field. */
  audio?: ChatAudioPart[]
  /** The files this turn carried, named here so the bytes are read only if the window keeps the turn. */
  attachmentIds?: string[]
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

/**
 * What a turn cost, worked out from the prompt it was built on instead of from what the wire said.
 *
 * The provider's own numbers are preferred wherever they exist: this is what stands in when a stream ends
 * before it reports any, which is what a stopped or failed turn almost always looks like. Tool results are
 * counted because they are most of what a tool-heavy turn sends back, and they sit on the calls rather
 * than in any turn's text — leaving them out under-charged exactly the turns that cost the reader most.
 */
function estimateTurnUsage(system: string, turns: ModelTurn[], answer: string): { inputTokens: number, outputTokens: number } {
  const inputTokens = turns.reduce(
    (total, turn) => total
      + estimateTokens(turn.content)
      + (turn.calls ?? []).reduce((sum, call) => sum + estimateTokens(call.result), 0),
    estimateTokens(system),
  )
  return { inputTokens, outputTokens: estimateTokens(answer) }
}

export class AssistantRunner {
  private readonly memoryHistory: MemoryHistoryService
  private readonly automations: AutomationService
  private scopePromise: Promise<NoteScope> | null = null
  private turnTools: string[] = []
  /** Set when this turn was asked to answer without tools, which outranks every tool rule below it. */
  private turnNoTools = false
  /**
   * Whether this step goes out with no tools at all, the one place that question is answered.
   *
   * Two levers mean the same thing here and are ORed rather than threaded separately: the turn's own
   * switch, and the model's standing `noTools` column. Both go through the door `supportsTools` already
   * uses — nothing is offered, and a call the model invents anyway is refused rather than run — because a
   * second mechanism would be a second place where a tool leaks out on a turn that said it must not.
   */
  private toolsRefused(entry: ResolvedCall): boolean {
    return this.turnNoTools || entry.model.noTools === true
  }
  /** The model named on this turn's request, or null when the account's own rules choose. */
  private turnModelId: string | null = null
  private webSearchRequested = false
  private webSearchNative = false
  /**
   * Whether this turn can be searched by the worker's own tool.
   *
   * Three states matter to the wire, not two: a vendor-side search (which carries the name `web_search`
   * itself on Anthropic), a first-party tool the reader configured, or neither. The last of these decides
   * both whether the tool is offered and whether the name is free to take.
   */
  private webSearchFirstParty = false
  private turnScopes: AssistantTurnScope[] = []
  /**
   * What this turn's answer was built on, by url, in the order it was found.
   *
   * Two kinds share the map: pages a web search named, and notes the note tools read. They are one list
   * because they are one thing to the reader — where the answer came from — and because a failover that
   * rolls back an attempt has to roll both back with it.
   */
  private readonly turnSources = new Map<string, AssistantSource>()
  /** What the reader had on screen, held for the turn so the prompt and the scope agree. */
  private contextNoteId: string | null = null
  private contextFolderId: string | null = null
  private contextPromise: Promise<{ openNote: { id: string, title: string } | null, browsingFolder: string | null }> | null = null
  /** Set with the conversation, before anything asks for the scope or the prompt. */
  private conversationProjectId: string | null = null
  /** Set when a step's model call was cut off at the output cap instead of stopping by itself. */
  private turnTruncated = false
  /** Set when a step's model call was stopped by a provider rule rather than by the model finishing. */
  private turnBlocked: UpstreamStopReason | null = null
  /** Files already read for this turn, keyed by the ids and whether pictures travelled. */
  private attachmentPayloads = new Map<string, AttachmentPayload>()
  /** Which row each key on the wire came from, so a refusal can be written onto the key that caused it. */
  private signedKeyIds = new Map<string, string>()
  /** The answer this turn resumes, when the reader pressed "continue" on a cut-off reply. */
  private continueFrom: AssistantMessage | null = null
  /** The note the reader had open when the thread began, recorded on the conversation it makes. */
  private originNoteId: string | null = null
  /** The lease this turn is running under: the caller's, or one this turn took for a new conversation. */
  private runToken: number | null = null
  /**
   * What this turn has written so far, as the lease row should carry it.
   *
   * Only the turn's own answer, not the steps' thinking or a tool's output: the one question the row exists
   * to answer is what the reader would want back if this isolate did not reach `finish`. It is kept on the
   * instance rather than passed in because the renewal that carries it happens at two sites in the streaming
   * loop and one before a step starts, and all three go through `holdLease`.
   */
  private leaseDraft: string | null = null

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
    this.turnNoTools = input.noTools === true
    this.turnModelId = input.modelId ?? null
    // Read before the scope is resolved for the first time: `noteScope()` caches, so a scope pinned
    // for this turn has to be in place before anything asks for it.
    // A turn that may call nothing keeps no pins either: the prompt would otherwise promise the model tools
    // this request has already decided to refuse.
    this.turnTools = this.turnNoTools ? [] : [...new Set(input.tools ?? [])].slice(0, MAX_TURN_TOOLS)
    // The switch means different things per protocol, so it is resolved after the model is known:
    // `webSearchNative` sends the vendor's own tool, otherwise a search-capable remote tool is pinned.
    this.webSearchRequested = input.webSearch === true
    this.webSearchNative = false
    this.webSearchFirstParty = false
    this.turnScopes = (input.scopes ?? []).slice(0, MAX_TURN_SCOPES)
    // Also read before the scope is resolved: the note on screen is readable for this turn, and the
    // scope promise is what enforces that.
    // A turn's search results belong to that turn: a retry that searched again must not inherit the
    // pages the answer it replaced was built on.
    this.turnSources.clear()
    // Files are read once per turn; a summarising second pass over the window reuses what it read.
    this.attachmentPayloads.clear()
    this.signedKeyIds.clear()
    this.continueFrom = null
    this.contextNoteId = isValidId(input.contextNoteId ?? '') ? input.contextNoteId! : null
    this.originNoteId = isValidId(input.originNoteId ?? '') ? input.originNoteId! : null
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
    // Whether this turn is the one that made the conversation. The naming pass only runs for a thread it
    // just created: a later turn cannot rename it (the reader may have titled it themselves by then), and a
    // retry that reuses a row is answering inside an already-named thread, so `complete` on its own is not
    // enough to decide "this is the first answer of a fresh conversation".
    let wasNewConversation = false
    // The caller's claim, when it made one; a turn that creates its own conversation claims below.
    this.runToken = this.deps.runToken ?? null
    if (input.retry) {
      if (!conversation) throw ApiError.badRequest('There is nothing to retry without a conversation.')
      if (input.retryFromMessageId) {
        // A turn picked out of the middle of the thread. Everything after it was written on top of the
        // answer being replaced, so it goes with that answer — but the answer itself is filed first, so
        // the words survive even though the row does not.
        const target = await this.store.getMessage(input.retryFromMessageId)
        if (!target || target.conversationId !== conversation.id) throw ApiError.notFound('Message not found')
        if (target.role !== 'assistant') throw ApiError.badRequest('Only an answer can be asked again.')
        // Read from the anchor rather than from a page: a thread longer than one page has rows that no
        // page containing the newest turn will ever return. Read it before the anchor row is deleted,
        // because that row is what the range is measured from.
        const later = await this.store.messagesAfter(conversation.id, target.id)
        reuseId = target.id
        await this.store.deleteMessageRow(target.id)
        await this.store.archiveAnswerVersion({
          messageId: target.id,
          conversationId: conversation.id,
          content: target.content,
          reasoning: target.reasoning,
          tools: target.tools,
          modelLabel: target.modelLabel ?? '',
          usage: target.usage,
          durationMs: target.durationMs,
          createdAt: target.createdAt,
        })
        for (const entry of later) await this.store.deleteMessage(entry.id)
        // The rollup described rows that no longer stand as they were.
        await this.store.clearSummary(conversation.id)
      } else {
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
      }
      const previous = await this.store.lastMessage(conversation.id)
      if (!previous || previous.role !== 'user') throw ApiError.conflict('Nothing to retry.')
      if (previous.source === 'import') {
        throw ApiError.conflict('A message restored from a backup cannot be retried. Send a new one instead.')
      }
    } else if (input.continueTurn) {
      if (!conversation) throw ApiError.badRequest('There is nothing to continue without a conversation.')
      const last = await this.store.lastMessage(conversation.id)
      if (!last || last.role !== 'assistant') throw ApiError.conflict('There is no answer to continue.')
      // The status is not the question a continuation has to answer. A cut-off reply is filed as an error
      // because the model ran out of output room, and the unfinished sentence above that notice is exactly
      // what the reader wants finished; only a row with no words of its own has nothing to go on from. The
      // reason a turn failed lives in `error` and never in the content, so an empty row is a failure
      // rather than a fragment, and asking again is the only thing it can be turned into.
      if (!last.content.trim()) throw ApiError.conflict('That answer has nothing to continue from; ask it again instead.')
      if (last.source === 'import') throw ApiError.conflict('A message restored from a backup cannot be continued.')
      this.continueFrom = last
      reuseId = last.id
      // The row is removed here and written back whole at the end, so the id and the place in the
      // transcript stay the same while the answer grows.
      await this.store.deleteMessageRow(last.id)
    } else {
      if (!message) throw ApiError.badRequest('Write something first.')
      if (message.length > MAX_MESSAGE_CHARS) throw ApiError.badRequest('That message is too long for one turn.')
      // A thread started beside a note remembers which one; a later turn does not re-label it.
      if (conversation && !conversation.noteId && this.originNoteId) await this.store.setConversationNote(conversation.id, this.originNoteId)
      if (!conversation) {
        conversation = await this.store.createConversation(titleFromMessage(message), null, input.ephemeral === true, null, this.originNoteId)
        wasNewConversation = true
        // The route had no id to claim yet, so the lease is taken here: without it a second tab could
        // open a parallel turn on the conversation this one has just made.
        this.runToken = await this.store.claimRun(conversation.id)
        if (this.runToken === null) {
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
        // The pins are part of the question, not a setting: stored with it so the transcript can say
        // what this turn was allowed to read after the chips are long gone.
        ...(this.turnScopes.length ? { scopes: this.turnScopes } : {}),
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
      // Only a turn that claimed its own conversation carries this; the route's claim is its own.
      ...(this.runToken === null ? {} : { runToken: this.runToken }),
    }

    let text = ''
    // A continued answer starts from what the reader could already see: the model writes the rest, and
    // the row is filed with both halves.
    let answer = this.continueFrom?.content ?? ''
    // Seeded before the first event, because a continued answer had its row deleted to make room for the
    // whole of it: a turn killed before it wrote a token has already taken the reader's words with it, and
    // the draft is the only copy left until the lease is renewed.
    this.leaseDraft = answer
    // Everything the turn has said so far, across its steps. The step's own text is what the model is
    // handed back after a tool call; this is what the reader watched arrive, and a turn filed from its
    // last step alone would drop the words that came before the call.
    // Whether the current step's `text` has already been merged into `answer`. A stop can arrive inside
    // the step (the stream is cut off, the lease was released), and the words that reached the reader
    // have to be filed with it rather than dropped on the floor of an exception.
    let stepWordsFiled = false
    // The whole turn's thinking, kept across steps because a turn that called a tool thought twice about
    // one question. Only what the model volunteered: a protocol that does not report a trace leaves this
    // empty, and an empty trace is what the fold needs to stay away.
    let reasoning = ''
    const tools: ToolActivity[] = []
    // The files this turn's tools made — an image the reader asked for — so they hang off the answer that
    // produced them rather than only off the call that drew them. This turn owns the array; the tool
    // context carries it, so every tool the executor runs is handed the same one.
    const generatedAttachments: string[] = []
    // Counted out here rather than in the `try`, because a turn that ends in `catch` still has to be
    // metered: the tokens a stopped or a failed turn produced were bought from the provider all the same.
    const usage = { inputTokens: 0, outputTokens: 0 }
    let system = ''
    let turns: ModelTurn[] = []
    // Which key the day's counters are filed against, and whether they have been written yet.
    let keyRef: { providerId: string, providerLabel: string } | undefined
    let usageCharged = false
    /**
     * Write this turn's counters onto the day's, once.
     *
     * The turn ends from two places — the loop it falls out of, and the `catch` that takes what it throws —
     * and a failure that lands after a good write (the row itself going wrong) must not spend the same
     * tokens twice. The request quota is not in here: it is spent by `reserve`, once per turn, and this
     * cannot become a second way to charge it.
     */
    const chargeUsage = async (counters: { inputTokens: number, outputTokens: number, toolCalls?: number, errors?: number }) => {
      if (usageCharged) return
      usageCharged = true
      await this.store.incrementUsage(counters, undefined, modelLabel, keyRef)
    }
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
      const resolved = await this.resolveModel(input)
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
      keyRef = { providerId: provider.id, providerLabel: provider.label }
      const limits = this.settings.limits
      // A 1M model and a 4K model do not get fed the same amount: the reader sets this per model on the
      // composer's context control, and the assistant-wide ceiling is what a model without one falls back
      // to — for the window and for the input ceiling over it alike.
      const contextTokens = contextBudgetFor(model, limits)
      // What one step may spend, thinking included. The model's own ceiling is the whole answer here and
      // the account's number answers only for a model the reader has not set: taking the lower of the two
      // let the account default (1024) silently outrank a model the reader had set to 64000. Read before
      // the history is budgeted, because the answer a turn means to write is part of what the prompt has
      // to leave room for, and kept in a name because a turn cut off at it has to say the number that cut
      // it.
      const capFor = (entry: ResolvedCall) => entry.model.maxOutputTokens ?? limits.maxOutputTokens
      let outputCap = capFor(primary)
      if (!(await this.reserve(1, limits.maxRequestsPerDay, { providerId: provider.id, providerLabel: provider.label }, model.label))) {
        throw ApiError.conflict(`The daily limit of ${limits.maxRequestsPerDay} assistant requests is reached. It is adjustable in Assistant settings.`)
      }

      yield { type: 'stage', stage: 'reading' }
      // The reader's own third-party tools are listed once per turn, and before the prompt is written:
      // the web-search switch works on a protocol with no vendor search by naming one of these tools to
      // the model, which only lands if the prompt has not been built yet. A server that is slow or down is
      // reported to the settings screen rather than failing the answer.
      const external: ExternalToolsResult = await loadExternalTools(this.store)
      // A turn that may call nothing gets no vendor search either: on the wire that one is a tool, and an
      // answer that quietly cites pages the reader never let this turn look up is the failure the flag
      // exists to prevent.
      this.webSearchNative = this.webSearchRequested && !this.toolsRefused(primary) && SEARCH_NATIVE_PROTOCOLS.has(call.protocol)
      if (this.webSearchRequested && !this.webSearchNative) {
        // No vendor-side search on this protocol. What can carry the switch, in the order of how sure the
        // answer is: the worker's own tool, which searches the engine the reader picked — an engine that
        // needs a key the reader never stored is not a channel, whatever the settings name; failing that,
        // one of the reader's remote tools whose *name* says it searches. The guess is the weaker one — a
        // tool called `query_orders` is not a web search — so it is only reached for when there is nothing
        // first-party to offer, and it stops firing the moment the reader configures an engine.
        const searchKey = await this.webSearchKey()
        this.webSearchFirstParty = !this.toolsRefused(primary)
          && webSearchConfigured(this.settings, Boolean(searchKey))
          && toolModeFor(this.settings, 'read') !== 'off'
        if (this.toolsRefused(primary)) {
          // The switch was on and this turn is forbidden every tool that could carry it out — which is
          // said with the code the client already has for a search nothing could do, rather than left as a
          // switch that silently did nothing.
          yield { type: 'notice', notice: 'web_search_unavailable' }
        } else if (this.webSearchFirstParty) {
          if (!this.turnTools.includes(WEB_SEARCH_TOOL_NAME)) this.turnTools = [...this.turnTools, WEB_SEARCH_TOOL_NAME].slice(0, MAX_TURN_TOOLS)
        } else {
          const searcher = external.definitions.find((definition) => looksLikeSearchTool(definition.name))
          if (searcher && !this.turnTools.includes(searcher.name)) this.turnTools = [...this.turnTools, searcher.name].slice(0, MAX_TURN_TOOLS)
          // The switch was on and nothing can carry it out. Saying so is the difference between a search
          // that did not happen and one the reader believes happened.
          if (!searcher) yield { type: 'notice', notice: 'web_search_unavailable' }
        }
      }
      const selected = await this.recallMemories(userMessage?.content ?? message)
      const memories = this.memoryHistory.promptMemories(selected, memoryTokenBudget(contextTokens))
      const history = await this.contextHistory(conversationId)
      // The row being resumed was taken out of the table so it can be written back whole; its words are
      // still what the model needs to go on from, so they are put back as the newest turn.
      if (this.continueFrom) {
        history.push({
          role: 'assistant',
          content: this.continueFrom.content,
          createdAt: this.continueFrom.createdAt,
          id: this.continueFrom.id,
        })
      }
      const context = await this.contextLabels()
      const project = await this.project()
      system = buildSystemPrompt({
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
        pinnedNotes: await this.pinnedNotes(),
        turnTools: this.turnTools,
        openNote: context.openNote,
        browsingFolder: context.browsingFolder,
        project: project?.instructions ? { name: project.name, instructions: project.instructions } : null,
        continuing: this.continueFrom !== null,
        customInstructions: this.settings.customInstructions,
      })
      // The history is what is left once the prompt has paid for itself: the standing instructions, the
      // answer the turn is going to write, and the results the steps after this one read back into it.
      const historyBudget = Math.max(500, contextTokens - estimateTokens(system) - outputCap - TOOL_RESULT_RESERVE_TOKENS)
      let window = buildContextWindow(history, historyBudget, conversation.summaryUpto ?? null)
      // Only now are the files read: the turns the budget dropped were never expanded at all.
      window = await this.hydrateWindow(window, model.vision, model.modalities, historyBudget, call.protocol)

      if (window.overflow.length >= SUMMARIZE_THRESHOLD) {
        const rolled = await this.summarize(conversationId, conversation.summary ?? null, window.overflow)
        if (rolled) {
          // The mark is the row the roll-up ends on, named rather than timed: the newest rows of this turn
          // can share its millisecond, and a cutoff that compares times alone would drop them — including
          // the question being answered.
          window = buildContextWindow(history, historyBudget, rolled.upto, rolled.uptoId)
          window = await this.hydrateWindow(window, model.vision, model.modalities, historyBudget, call.protocol)
        } else {
          // The roll-up did not happen and nothing else about the turn says so: the answer arrives as
          // though the whole thread stood behind it. Said here, once, rather than left to a log line.
          yield { type: 'error', code: 'summary_unavailable', message: SUMMARY_UNAVAILABLE }
        }
      }

      yield { type: 'stage', stage: 'generating' }
      const executor = new ToolExecutor(await this.toolContext(conversationId, generatedAttachments), { maxToolCalls: limits.maxToolCalls }, external.definitions)
      const schemas: ToolSchema[] = executor.available()
        // On a protocol that sends the vendor's own search tool, that one already carries this name, and a
        // request with two entries called `web_search` is a request the provider refuses outright. The
        // vendor's search is the better of the two wherever it exists, so the built-in one steps aside.
        .filter((definition) => !(this.webSearchNative && definition.name === WEB_SEARCH_TOOL_NAME))
        .map((definition) => ({
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
      turns = window.messages.map((entry) => ({
        role: entry.role,
        content: entry.content,
        calls: entry.calls,
        images: entry.images,
        audio: entry.audio,
      }))
      // Which ceiling ended the turn, when the model was cut off rather than finished. Named in the notice
      // the row is filed with, because "it stopped" and "it ran out of room to keep going" are different
      // things for the reader to act on.
      let ceiling: string | null = null
      let steps = 0

      for (;;) {
        steps++
        // A turn that walks several steps outlives the lease it was claimed with, and the row is also how
        // a stop reaches this generator: the reader's tab closing only fails a write on some platforms,
        // and a turn nobody is watching must not keep spending their budget.
        if (!(await this.holdLease(conversationId))) throw new AbortError()
        const calls: ToolCallRecord[] = []
        let eventsSeen = 0
        // Judged per step and only the last step's verdict is kept: a step cut off mid-tool-call is
        // repaired by the step after it, while a cut-off *answer* is what must not be filed as whole.
        this.turnTruncated = false
        this.turnBlocked = null
        // The first step is where a model may be swapped for one further down the chain; every step after
        // it is answered by whichever model got through, so a reply never changes voice halfway.
        const candidates = steps === 1 ? chain : [served.current]
        for await (const event of this.stepWithFailover(candidates, served, (entry, apiKey) => ({
          baseUrl: entry.call.baseUrl,
          apiKey,
          model: entry.model.model,
          system,
          turns,
          // A model that invents tool calls is silenced by not sending the schemas at all, which is the
          // same door a turn asked to answer without tools, and a model switched off for tools, both go
          // through.
          tools: entry.model.supportsTools && !this.toolsRefused(entry) ? schemas : [],
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
          if (event.type === 'text') {
            text += event.delta ?? ''
            // Everything the reader on this wire has been shown, filed steps and the step in hand. Carried
            // to the next `holdLease` rather than written here: this runs per token.
            this.leaseDraft = answer + text
          }
          if (event.type === 'reasoning') reasoning += event.delta ?? ''
          // A reader who pressed stop released the lease; on a platform that does not report the
          // dropped connection, this is what ends the turn. Every sixteenth event keeps the extra write
          // off the critical path while still stopping within a couple of hundred characters — and the
          // same touch is what renews the lease, so a long step never runs down the clock it is standing on.
          if (++eventsSeen % 16 === 0 && !(await this.holdLease(conversationId))) throw new AbortError()
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
        stepWordsFiled = true
        // A turn asked to answer without tools runs nothing the model invents, and neither does a model the
        // reader switched off for tools — the same refusal, named for whichever of the two said no. The
        // call is filed as refused rather than dropped: a row that shows no tool and no source and says
        // nothing about why leaves the reader reading a silent answer as an unpersuasive one, and the
        // turn's own answer already did whatever this second model was reaching for.
        if (this.toolsRefused(served.current) && calls.length) {
          const refusal = this.turnNoTools
            ? 'This turn was asked to answer without tools, so the call never ran.'
            : 'This model is switched off for tools, so the call never ran.'
          for (const call of calls.splice(0)) {
            const refused: ToolActivity = {
              id: call.id,
              name: call.name,
              status: 'error',
              args: toolPayloadText(call.args),
              error: refusal,
            }
            tools.push(refused)
            yield { type: 'tool', tool: { ...refused } }
          }
          break
        }
        if (!calls.length) break
        yield* this.runCalls(executor, calls, tools, stopped)
        turns.push({ role: 'assistant', content: text, calls })
        text = ''
        stepWordsFiled = false
        if (steps >= limits.maxAgentSteps || executor.budgetExhausted()) {
          // Reaching here means the model asked for another tool and there is no allowance left to run it.
          // That is a ceiling, not the model deciding it had finished, and the words above are the middle
          // of a working turn — so they are filed as one, which is what also makes them continuable.
          ceiling = steps >= limits.maxAgentSteps
            ? `the ${limits.maxAgentSteps}-step limit for one turn`
            : `the tool-call limit of ${limits.maxToolCalls} for one turn`
          break
        }
        if (!(await this.reserve(1, limits.maxRequestsPerDay, { providerId: provider.id, providerLabel: provider.label }, model.label))) {
          yield { type: 'error', code: 'rate_limited', message: 'The daily assistant request limit was reached during this turn.' }
          break
        }
      }

      if (!usage.inputTokens && !usage.outputTokens) {
        const estimate = estimateTurnUsage(system, turns, answer)
        usage.inputTokens = estimate.inputTokens
        usage.outputTokens = estimate.outputTokens
      }
      // The label travels with the counters so the day's models can be told apart: a reader with two
      // providers has two prices, and one total cannot be split after the fact. The provider rides along
      // too, so the same counters can be read back per key.
      await chargeUsage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, toolCalls: executor.callCount })
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
      if (this.turnBlocked) {
        outcome = 'error'
        // A stop the provider chose under its own rules is not a finished answer, and filing it as one is
        // how a refusal gets read back as the model's reply. Filed the way a cut-off answer is: the words
        // that did arrive stay, the notice says why they stop, and the reader can ask for the rest.
        failure = this.turnBlocked === 'refusal' ? TURN_REFUSED : TURN_FILTERED
      } else if (this.turnTruncated) {
        outcome = 'error'
        // The cap is a number the reader set somewhere, so it is named; a turn that stops mid-sentence and
        // says nothing leaves them guessing whether the model was finished or merely out of room.
        failure = answer.trim()
          ? `The model was cut off at its ${outputCap}-token output limit, so the answer above stops where it does. ${capAdvice}`
          : `The model spent the whole ${outputCap}-token output allowance thinking and never wrote an answer. ${capAdvice}`
      } else if (ceiling) {
        outcome = 'error'
        // Same shape as the two above: the words the reader watched arrive stay, and what stopped them is
        // said, so a turn that ran out of allowance is not mistaken for one that ran out of things to say.
        failure = answer.trim()
          ? `The assistant stopped at ${ceiling} while it was still working, so the answer above stops where it does. Ask again to carry on from here.`
          : `The assistant stopped at ${ceiling} while it was still working, and left no answer written to carry on from. Ask it again.`
      } else if (!answer.trim()) {
        outcome = 'error'
        if (tools.some((tool) => tool.status === 'success')) {
          // The tools ran and then the model said nothing. An invented "Done." was a sentence the model
          // never wrote, read back by the next turn as its own closing words and by the reader as an
          // answer; what is true is that the work happened without a report of it.
          failure = 'The assistant ran its tools, but the model wrote no answer afterwards. Try asking again.'
        } else {
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
      const finalMessage = await finish(stopped() ? 'cancelled' : outcome, failure, usage)
      yield { type: 'done', finalMessage }
      // A fresh, kept conversation's first answer, filed whole: spend one cheap call on the model that just
      // answered to name the thread and propose what to ask next. Best-effort and self-contained — it can
      // neither throw into the turn's `catch` nor leave the reader with a title the model never gave. When it
      // yields nothing (no budget, a dead call, an answer that is not JSON), the derived title stands and the
      // answer carries no suggestions, which is the honest reading rather than a rename that did not happen.
      if (wasNewConversation && !input.ephemeral && finalMessage.status === 'complete') {
        const named = await this.nameThreadAndSuggest({
          conversationId,
          messageId: assistantId,
          question: message,
          answer,
          model,
          provider,
          call,
          modelLabel,
          keyRef,
          derivedTitle: conversation.title,
          limits,
          signal: input.signal,
        })
        // Either half is worth a frame: a pass that offered follow-ups but named nothing — a blank title, or
        // a thread the reader renamed while the answer was being written, which this code deliberately does
        // not step on — still has chips to put under the answer. The id rides along because the row they
        // belong to is the row the reader is looking at, and the frame is what lets the transcript put them
        // there without reading the thread back.
        if (named) {
          yield {
            type: 'title',
            conversationId,
            assistantMessageId: assistantId,
            ...(named.title ? { title: named.title } : {}),
            ...(named.suggestions.length ? { suggestions: named.suggestions } : {}),
          }
        }
      }
    } catch (error) {
      // A stop stops the turn, not the record of it: the words the reader already watched arrive are
      // the half answer they chose to keep, so they are merged before the row is filed. Without this
      // a cancelled row was stored empty while the transcript on screen still showed the text.
      const cancelled = error instanceof AbortError || stopped()
      if (cancelled && !stepWordsFiled) answer += text
      // What this turn spent, however it ended. A stream that died before it priced itself is estimated —
      // an estimate is nearer the truth than the nothing that used to be filed here — but only when there
      // are words to estimate from: a turn the provider refused at the door (a spent key, a downed host)
      // was never served at all, and pricing its prompt would charge the reader for tokens no vendor sold.
      const spent = (usage.inputTokens || usage.outputTokens || !answer.trim())
        ? usage
        : estimateTurnUsage(system, turns, answer)
      if (cancelled) {
        await chargeUsage(spent)
        yield { type: 'done', finalMessage: await finish('cancelled', null, spent) }
        return
      }
      await chargeUsage({ ...spent, errors: 1 })
      const reason = describeUpstreamFailure(error)
      yield { type: 'error', code: errorCode(error), message: reason }
      yield { type: 'done', finalMessage: await finish('error', reason, spent) }
    }
  }

  /**
   * File one page this turn leaned on, first-found first-kept.
   *
   * Neither the number of citations nor the length of one is the runner's choice — a vendor names what it
   * names, and some name a chunk per paragraph — while the list is written onto the answer row and carried
   * every time the thread opens. So it is bounded where it is collected, at the same bounds the row is read
   * back under, and the pages that came first are the ones the answer was actually built on.
   */
  private collectSource(source: AssistantSource): void {
    if (this.turnSources.size >= MAX_TURN_SOURCES) return
    const url = source.url.slice(0, MAX_SOURCE_URL_CHARS)
    if (!url || this.turnSources.has(url)) return
    this.turnSources.set(url, { ...source, url })
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
        // A provider reports the running total for the message it is talking about, and plenty of relays
        // repeat that total on every chunk: added up, one step would be charged once per frame. The pair
        // this step last claimed is what it spent, and the turn's total stays a sum — every step sends its
        // own prompt again, and each of those is real spend.
        usage.inputTokens = Math.max(usage.inputTokens, event.inputTokens)
        usage.outputTokens = Math.max(usage.outputTokens, event.outputTokens)
        continue
      }
      // The cap signal is the runner's own business: the client has no event for it, and what the
      // reader needs to know arrives as the notice on the stored turn.
      if (event.type === 'truncated') {
        this.turnTruncated = true
        continue
      }
      // The same for a stop the provider chose: the wire names it, the stored row says why.
      if (event.type === 'stop-reason') {
        this.turnBlocked = event.reason
        continue
      }
      // What a search found. Collected as it arrives rather than at the end because the vendor reports
      // it beside the text it feeds; Gemini repeats its whole list on every frame, so the same page
      // would otherwise be listed a dozen times.
      if (event.type === 'sources') {
        for (const source of event.sources) this.collectSource(source)
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
   * What a failed attempt produced is rolled back with it. A trace, a set of search results, a truncation
   * flag or a stop reason left behind by an attempt that never answered would be attributed to the model
   * that did, and the turn would report a cap it was never cut off at.
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
      const blockedBefore = this.turnBlocked
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
        this.turnBlocked = blockedBefore
      }
    }
    throw failure ?? new Error('No model in the fallback chain could answer.')
  }

  /**
   * Run one step's calls with a bounded overlap, reporting each as it finishes.
   *
   * The transcript is written in the order the model asked for, and that is the order that matters: a
   * result list that arrived shuffled would be read back on the next step as a different set of calls than
   * the one the model made. It holds because the slots were made in that order and each task fills its own
   * — nothing a late tool does can move an earlier one. What lands in completion order is only the chips the
   * reader watches, which is the order that means something to them: which of the three lookups answered.
   *
   * Two things the overlap must not break. A call that fails is that call's own error and takes nothing
   * else down with it, and every task here resolves whatever happens inside it, because a promise nobody is
   * left waiting on becomes an unhandled rejection the reader cannot attribute. And a stop in the middle of
   * a step ends the step: calls not yet started are never started, and ones in the air are not written into
   * a turn that is being filed as cancelled.
   *
   * The budgets and the duplicate-call refusal survive the batching for one specific reason, worth keeping
   * true if this is ever edited: `ToolExecutor.execute` checks and records a call synchronously, before its
   * first `await`, and the calls are handed out in order. So a repeated signature or a spent call budget is
   * refused on exactly the call it was refused on when the step ran one at a time.
   */
  private async *runCalls(
    executor: ToolExecutor,
    calls: ToolCallRecord[],
    tools: ToolActivity[],
    stopped: () => boolean,
  ): AsyncGenerator<ChatStreamEvent> {
    const activities = calls.map((call): ToolActivity => ({
      // What the model asked for travels with the chip, so a thread opened tomorrow can still answer
      // "what did it search for". It is the same text the model produced, clipped by the shared cap.
      id: call.id,
      name: call.name,
      status: 'running',
      args: toolPayloadText(call.args),
    }))
    tools.push(...activities)
    for (const activity of activities) yield { type: 'tool', tool: { ...activity } }

    let next = 0
    let abandoned = false
    const running = new Map<number, Promise<number>>()

    const runOne = async (index: number): Promise<void> => {
      const call = calls[index]!
      const activity = activities[index]!
      try {
        const result = await executor.execute(call.name, call.args, call.id)
        // The reader went away while this was in the air. The tool's effect may already be real — nothing
        // here can cancel a call mid-flight — but its answer does not go into a turn that is closing.
        if (abandoned) return
        call.result = JSON.stringify(result ?? null)
        call.error = false
        // The notes this call read are cited beside the answer. Collected here rather than inside the
        // tool so there is one owner of the list: a failover that discards this attempt's calls takes
        // its citations with it, because they live in the same map.
        for (const source of noteCitationsFromTool(call.name, result)) this.collectSource(source)
        // A search the worker ran itself joins the same list as one a vendor ran on its own server, so the
        // chips under the answer do not care which wire the pages came from.
        for (const source of webSearchSources(call.name, result)) this.collectSource(source)
        // What came back, kept beside the arguments above. The `result` sent to the model stays the
        // compact JSON the wire wants; what the reader is shown is the tool's own text where the tool
        // returned text, because a quoted JSON string is not what the search returned.
        activity.result = toolPayloadText(result)
        const approval = executor.approvalFor(call.id)
        if (approval) activity.approval = (await this.store.getPendingAction(approval.id)) ?? undefined
      } catch (error) {
        if (abandoned) return
        const reason = error instanceof Error ? error.message : 'The tool failed.'
        call.result = JSON.stringify({ error: reason })
        call.error = true
        call.args = call.args ?? {}
        activity.error = reason.slice(0, 300)
      }
      activity.status = call.error ? 'error' : 'success'
      activity.detail = detailFor(call.args)
    }

    // A task runs straight from taking its slot to its first `await`, so handing the pool the calls in the
    // model's own order is what keeps the executor's own checks in that order too.
    const dispatch = () => {
      while (!abandoned && running.size < TOOL_CONCURRENCY && next < calls.length) {
        const index = next++
        running.set(index, runOne(index).then(() => index))
      }
    }
    dispatch()
    while (running.size > 0) {
      const finished = await Promise.race(running.values())
      running.delete(finished)
      dispatch()
      if (stopped()) abandoned = true
      if (abandoned) continue
      yield { type: 'tool', tool: { ...activities[finished]! } }
    }
    // The loop above only empties once everything that was started has settled, so nothing is left running
    // behind this; what was never started is dropped rather than run into a conversation nobody reads.
    if (abandoned) throw new AbortError()
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
    // Kept for the length of this turn only: the request carries the key, not the row it came from, and
    // this is what lets a refusal be charged to the key that earned it.
    if (picked.keyId) this.signedKeyIds.set(picked.key, picked.keyId)
    return picked.key
  }

  /**
   * The retry policy every call to a provider is made under.
   *
   * A second attempt is signed with a fresh key, which is the whole point of the reader's ring: a 429 or a
   * 401 on one key is answered by the next one, and the ring hands out the least recently used so a retry
   * does not land on the key that just failed.
   *
   * A refusal is also written onto that key's row, which is the only way the settings screen can say which
   * one of several keys is broken. Only the failures a key can be blamed for are recorded: an unreachable
   * host or a malformed request says nothing about the key, and counting it would send the reader to the
   * wrong row.
   */
  private retryFor(provider: ProviderRow): UpstreamRetry {
    return {
      attempts: UPSTREAM_RETRY_ATTEMPTS,
      rotateKey: async () => await this.signKey(provider),
      onAttemptFailed: async (error, apiKey) => {
        if (error.kind !== 'auth' && error.kind !== 'quota' && error.kind !== 'rate') return
        const keyId = this.signedKeyIds.get(apiKey)
        if (!keyId) return
        try {
          await this.store.recordProviderKeyError(keyId, `${error.kind}: ${error.message}`)
        } catch {
          // A diagnostic must not replace the failure it was describing: the turn still reports the
          // provider's own error, and the next failure will try to record itself again.
        }
      },
    }
  }

  /**
   * Keeps this turn's claim on the conversation alive, and answers whether the claim is still its own.
   *
   * Renewal and ownership have to be one statement, because asked separately they gave the wrong answer in
   * both directions: a turn whose lease had aged out read its own expired row as "not running" and filed a
   * finished answer as stopped, while a turn whose lease a second run had taken read that run's fresh row
   * as permission and kept streaming into the same conversation. A turn with no token is running under a
   * claim its caller kept, so it can only ask whether somebody is live.
   */
  private async holdLease(conversationId: string): Promise<boolean> {
    // The draft goes with the renewal rather than after it. A turn that has written forty characters has
    // already decided to keep going, and the write that says so is the cheapest place in the whole loop to
    // leave the words behind: an extra statement every sixteenth event would price the interrupted-worker
    // case into the stream of every turn that never is interrupted.
    const draft = this.leaseDraft
    if (this.runToken === null) {
      await this.store.renewRun(conversationId, undefined, Date.now(), draft)
      return this.store.isRunning(conversationId)
    }
    return this.store.touchRun(conversationId, this.runToken, Date.now(), draft)
  }

  /** Charges one or more model calls against the reader's daily ceiling, refusing when it is spent. */
  private async reserve(
    count: number,
    maxPerDay: number,
    keyRef?: { providerId: string, providerLabel: string },
    modelLabel = '',
  ): Promise<boolean> {
    // The ceiling is enforced by the statement that spends it: two turns that start in the same instant
    // used to both read a number with room left and both charge it.
    return this.store.reserveRequests(count, maxPerDay, modelLabel, keyRef)
  }

  private async summarize(
    conversationId: string,
    previous: string | null,
    overflow: HistoryEntry[],
  ): Promise<{ upto: number, uptoId?: string } | null> {
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
      // Best-effort only in the sense that the turn can still be answered without it — the conversation is
      // not, and the caller is what tells the reader. `null` is the signal that no roll-up was written,
      // and the log line is for whoever operates the deployment, not for the reader.
      console.warn('[inkstone] assistant summarization skipped:', error instanceof Error ? error.name : error)
      return null
    } finally {
      clearTimeout(timer)
    }
    const summary = text.trim().slice(0, 2000)
    if (!summary) return null
    const last = overflow.at(-1)
    if (!last) return null
    await this.store.setSummary(conversationId, summary, last.createdAt)
    // The row the roll-up ends on travels back with its time: two turns can share a millisecond, and the
    // one that came after must not be folded away with the history above it.
    return { upto: last.createdAt, ...(last.id ? { uptoId: last.id } : {}) }
  }

  /**
   * Name a fresh conversation and propose its follow-ups, in one cheap call to the model that just answered.
   *
   * The reader asked for a title written by the model rather than a truncation of their first line, and for
   * three questions to ask next. Both come out of the same reading of the same exchange, so they are asked
   * for together — one request, one bill — on the same model, the same provider and a key signed from that
   * provider's own ring. It runs after the answer is already filed and already on the reader's screen, so
   * everything here is strictly best-effort: a call that has no budget left, times out, is refused, or hands
   * back something that is not JSON leaves the derived title standing and the answer showing no suggestions,
   * and says so by yielding nothing rather than by renaming to a name the model never gave — a failure here
   * is reported by the absence of a change, not by a wrong one that looks like it worked.
   *
   * The tokens are metered — charged to the day's totals under the same model label and key as the turn, so
   * the reader is never quietly burned for free — but they are deliberately NOT written into the turn's own
   * `chat_messages` usage row, and never into the `usage` frame already sent: the naming pass is a separate
   * act of reading, not part of the price of the answer. Returns what the pass landed — the new title when it
   * wrote one, and the follow-ups when it offered any — or null when it landed nothing at all. The two halves
   * travel independently, because a thread the reader already renamed is still a thread whose first answer can
   * be followed up on.
   */
  private async nameThreadAndSuggest(args: {
    conversationId: string
    messageId: string
    question: string
    answer: string
    model: AssistantModel
    provider: ProviderRow
    call: ModelEndpoint
    modelLabel: string
    keyRef?: { providerId: string, providerLabel: string }
    derivedTitle: string
    limits: AssistantSettings['limits']
    signal: AbortSignal
  }): Promise<{ title: string | null, suggestions: string[] } | null> {
    // No request left on the day's ceiling: leave the derived title. A title is worth less than the reader's
    // last request to the day, and reserving here is what keeps this call off the free list.
    if (!(await this.reserve(1, args.limits.maxRequestsPerDay, args.keyRef, args.modelLabel))) return null
    const { system, user } = namingPrompt(this.settings.language, args.question, args.answer)
    // Its own controller, so a stop of the reader's or the deadline ends this call without touching the turn
    // (which is already filed). The turn's signal is watched, not replaced.
    const controller = new AbortController()
    const onAbort = () => controller.abort(args.signal.reason)
    if (args.signal.aborted) onAbort()
    else args.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), NAMING_DEADLINE_MS)
    // `max` rather than `+`: the naming call is one step, so there is no second usage frame to add, and a
    // provider that repeats a total on `done` must not count it twice.
    const spent = { inputTokens: 0, outputTokens: 0 }
    let text = ''
    try {
      for await (const event of streamUpstream(args.call.protocol, {
        baseUrl: args.call.baseUrl,
        // Signed from the same provider that answered, so the naming pass travels on the reader's own key and
        // nothing else's. No `retry`: a single cheap attempt, one key, one shot — this is a nicety on an
        // answer that already succeeded, and rotating the ring or trying another model for it would cost the
        // reader more than the title is worth.
        apiKey: await this.signKey(args.provider),
        model: args.model.model,
        system,
        turns: [{ role: 'user', content: user }],
        tools: [],
        maxOutputTokens: NAMING_MAX_OUTPUT_TOKENS,
        temperature: 0,
        reasoning: 'off',
        reasoningDialect: args.call.reasoningDialect,
        structured: true,
        signal: controller.signal,
      })) {
        if (event.type === 'text') text += event.delta
        if (event.type === 'usage') {
          spent.inputTokens = Math.max(spent.inputTokens, event.inputTokens)
          spent.outputTokens = Math.max(spent.outputTokens, event.outputTokens)
        }
      }
    } catch (error) {
      // A refused, unreachable or timed-out call. Meter the attempt as an error against the day (the same
      // shape the conflict judge leaves behind), then get out: the derived title is the honest answer.
      console.warn('[inkstone] assistant naming skipped:', error instanceof Error ? error.name : error)
      await this.store.incrementUsage({ errors: 1 }, undefined, args.modelLabel, args.keyRef)
      return null
    } finally {
      clearTimeout(timer)
      args.signal.removeEventListener('abort', onAbort)
    }
    // The call ran, so its tokens are paid for whether or not the answer is usable. Estimate when a relay
    // streamed no usage frame, so a naming pass is never free, then record it against the model and key.
    const charged = spent.inputTokens || spent.outputTokens
      ? spent
      : { inputTokens: estimateTokens(`${system}\n${user}`), outputTokens: estimateTokens(text) }
    await this.store.incrementUsage({ inputTokens: charged.inputTokens, outputTokens: charged.outputTokens }, undefined, args.modelLabel, args.keyRef)
    const parsed = parseNaming(text)
    if (!parsed) return null
    // Suggestions attach to the answer that earned them, independent of the title: a thread the reader
    // already renamed still gets follow-ups on its first answer, and an empty list writes nothing.
    if (parsed.suggestions.length) await this.store.setMessageSuggestions(args.messageId, parsed.suggestions)
    if (!parsed.title || parsed.title === args.derivedTitle) return { title: null, suggestions: parsed.suggestions }
    // Do not step on a title the reader chose: rename only while the row still holds the value this turn
    // derived. Re-read from the table rather than trusting the in-memory `conversation` — a second tab, a
    // restore, or a hand edit between the create above and now is exactly the case this check exists for,
    // and it is what makes "the reader renamed it" the one outcome that survives the race. If the current
    // title is anything other than the derived one, the reader owns it and it stays.
    const current = await this.store.getConversation(args.conversationId)
    if (!current || current.title !== args.derivedTitle) return { title: null, suggestions: parsed.suggestions }
    await this.store.renameConversation(args.conversationId, parsed.title)
    return { title: parsed.title, suggestions: parsed.suggestions }
  }

  /**
   * Which model answers this turn.
   *
   * A model named on the request answers it and nothing else is consulted — not the reader's standing pick
   * and not the router, both of which would answer a different question than the one asked. The chain of
   * spares behind it is read off that model (`modelChain`), so the per-turn choice brings its own provider
   * rules and its own key ring rather than jumping to the account default.
   *
   * Otherwise the reader's own model unless they asked the assistant to choose. A turn carrying files is
   * never routed: which model can read a picture is a property of the model, and the attachment rows would
   * have to be read before the model is known to decide — so the reader's choice stays the safe answer.
   */
  private async resolveModel(input: TurnInput) {
    if (this.turnModelId) return loadModelAndProvider(this.store, this.settings, this.turnModelId)
    if (!this.settings.autoRoute) return loadModelAndProvider(this.store, this.settings)
    if ((input.attachments?.length ?? 0) > 0) return loadModelAndProvider(this.store, this.settings)
    const models = await this.store.listModels()
    const picked = pickModelForTurn(models, {
      estimatedTokens: estimateTokens(input.message),
      needsTools: (input.tools?.length ?? 0) > 0 || input.webSearch === true,
    })
    return loadModelAndProvider(this.store, this.settings, picked?.id ?? null)
  }

  /**
   * The turns the model is shown, with their files named but not yet read.
   *
   * Two phases on purpose. The window is decided from cheap text first, and only the turns that survive
   * it have their attachments expanded — a thread with twenty pictures used to read and base64-encode
   * every one of them before the budget threw most of them away, on every single turn.
   */
  private async contextHistory(conversationId: string): Promise<HistoryEntry[]> {
    const messages = await this.store.messages(conversationId, CONTEXT_HISTORY_MESSAGES)
    const actions = await this.store.actionStatesForConversation(conversationId)
    const entries: HistoryEntry[] = messages
      // A cut-off answer is the model's own unfinished words, and the follow-up that asks about them —
      // "put the above into a table" — is a question about a text the reader can still see. Leaving the
      // row out made that follow-up answer a question about nothing. A failed turn that wrote nothing
      // stays out: what such a turn says about itself is one sentence in `error`, and a model handed its
      // own failure as its last answer reads it as an answer it had already finished.
      .filter((entry) => entry.role === 'user'
        || entry.status === 'complete'
        || (entry.status === 'error' && entry.content.trim().length > 0))
      .map((entry) => {
        const ids = entry.role === 'user' ? entry.attachments ?? [] : []
        return {
          role: entry.role,
          // A placeholder per file, so the window's estimate knows the turn carries attachments without
          // the worker having read a byte of them. Hydration replaces this with the real block below.
          content: withEntryAttachments(withApprovalOutcomes(entry, actions), entry.role, ids.length
            ? { block: ids.map(() => `${ATTACHMENT_MARKER}]`).join('\n'), images: [], audio: [] }
            : undefined),
          ...(ids.length ? { attachmentIds: ids } : {}),
          createdAt: entry.createdAt,
          id: entry.id,
          ...(entry.role === 'assistant'
            ? {
                calls: entry.tools.filter((tool) => tool.status !== 'running').map((tool) => ({
                  id: tool.id,
                  name: tool.name,
                  args: {},
                  result: historyToolResult(tool),
                  error: tool.status === 'error',
                })),
              }
            : {}),
        }
      })
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
   * Reads the files of the turns that survived the window, and fits the result back into the budget.
   *
   * Pictures ride only on the most recent turns: a screenshot from forty messages ago is context, not a
   * question, and re-uploading it on every turn is the cost the reader pays for nothing. Anything the
   * hydration pushed past the budget is handed back as overflow, so it is summarised rather than lost.
   */
  private async hydrateWindow(
    window: ContextWindow,
    vision: boolean,
    modalities: readonly AssistantModelModality[],
    budget: number,
    protocol: AssistantProtocol,
  ): Promise<ContextWindow> {
    if (!window.messages.some((entry) => entry.attachmentIds?.length)) return window
    let turnsFromEnd = 0
    const recent = new Set<number>()
    for (let index = window.messages.length - 1; index >= 0; index--) {
      const entry = window.messages[index]!
      if (entry.role !== 'user') continue
      turnsFromEnd++
      if (turnsFromEnd <= IMAGE_RECENT_TURNS) recent.add(entry.createdAt)
    }
    // Two turns that name the same files — a reader asking about the same picture twice — share one read,
    // and the summary pass below reuses the ones the first window already read.
    const memo = this.attachmentPayloads
    const hydrated: HistoryEntry[] = []
    for (const entry of window.messages) {
      const ids = entry.attachmentIds ?? []
      if (!ids.length) {
        hydrated.push(entry)
        continue
      }
      const withImages = recent.has(entry.createdAt)
      const key = `${withImages ? 'recent' : 'older'}:${ids.join(',')}`
      let payload = memo.get(key)
      if (!payload) {
        payload = await expandChatAttachments(this.store, this.deps.env, ids, vision, modalities, withImages, protocol)
        memo.set(key, payload)
      }
      hydrated.push({
        ...entry,
        content: withEntryAttachments(entry.content, 'user', payload),
        ...(payload.images.length ? { images: payload.images } : {}),
        ...(payload.audio.length ? { audio: payload.audio } : {}),
      })
    }
    const { kept, dropped } = fitToBudget(hydrated, budget)
    return { messages: kept, overflow: [...window.overflow, ...dropped] }
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
      // Best-effort by design, and said so in the doc comment above: an embedding that would not come back
      // costs the reader the memories phrased differently from their words, not the answer. Failing the
      // turn over it would make a Workers AI outage look like a broken assistant, and the word list it
      // falls back to is still the reader's own recall.
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
        // The note the reader had open, the notes they pinned as chips, and the pages the project names.
        // All three are the same act — pointing at a page and asking about it — and `noteIds` is the one
        // channel the scope has for it: "summarise this" is a question about the page in front of them,
        // and refusing it because the folder they excluded happens to hold it would answer a question
        // nobody asked. A project's own list is that decision made once and standing, so it travels the
        // same channel; the ids were checked against this account when the project was saved.
        noteIds: [...turnNoteIds(this.contextNoteId, this.turnScopes), ...(project?.pinIds ?? [])],
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
   *
   * Its named pages go the other way, through `noteIds`: naming one is an addition to what the turn may
   * read, not a folder to filter by, and it is the same channel the reader's own chip and open page use.
   * A project that says nothing at all — no brief, no folder, no page — contributes nothing and reads as
   * absent rather than as an empty selection.
   */
  private projectPromise: Promise<{ name: string, instructions: string, scopeIds: string[], pinIds: string[] } | null> | null = null

  private project() {
    if (!this.projectPromise) {
      this.projectPromise = (async () => {
        const projectId = this.conversationProjectId
        if (!projectId) return null
        const project = await this.store.getProject(projectId)
        if (!project) return null
        const brief = project.instructions.trim()
        if (!project.noteScope.length && !project.noteIds.length && !brief) return null
        return { name: project.name, instructions: brief, scopeIds: project.noteScope, pinIds: project.noteIds }
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

  /**
   * The notes pinned to this turn, read back from the vault rather than from the request.
   *
   * The client sends ids, and the titles are this vault's — a caller that supplied its own title would
   * be writing a line of the system prompt, which is the same reason folders are resolved here. A note
   * that has been deleted since the chip was added is dropped instead of named: the prompt must not
   * point at something the reader can no longer read.
   */
  private pinnedNotesPromise: Promise<Array<{ id: string, title: string }>> | null = null

  private pinnedNotes(): Promise<Array<{ id: string, title: string }>> {
    if (!this.pinnedNotesPromise) {
      this.pinnedNotesPromise = (async () => {
        // The turn's own chips and the pages the project names are one list here: both are the reader
        // pointing at a page and asking about it, and the prompt must not name a page the scope refused.
        const project = await this.project()
        const ids = [...new Set([
          ...this.turnScopes.filter((entry) => entry.kind === 'note').map((entry) => entry.id),
          ...(project?.pinIds ?? []),
        ])]
        if (!ids.length) return []
        const placeholders = ids.map((_, index) => `?${index + 2}`).join(', ')
        const { results } = await this.deps.env.DB.prepare(
          `SELECT id, title FROM notes WHERE user_id = ?1 AND deleted_at IS NULL AND id IN (${placeholders})`,
        ).bind(this.store.userId, ...ids).all<{ id: string, title: string }>()
        return (results ?? []).map((row) => ({ id: row.id, title: row.title.slice(0, 120) || 'Untitled' }))
      })()
    }
    return this.pinnedNotesPromise
  }

  /**
   * The key this reader stored for the web-search engine the settings name, resolved once per turn.
   *
   * Two doors ask the same question — whether the built-in search tool may be offered at all, and what it
   * signs its request with — and an engine's key must not be read twice from the vault in one turn, both
   * because the second read is a duplicate round trip and because the two answers could then disagree
   * about whether the reader has a key at all. An engine that needs no key never reaches the database.
   */
  private searchKeyPromise: Promise<string | null> | null = null

  private webSearchKey(): Promise<string | null> {
    if (!this.searchKeyPromise) {
      this.searchKeyPromise = (async () => {
        const engine = webSearchEngineFor(this.settings.webSearchEngine)
        if (!engine.requiresKey) return null
        return await this.store.searchApiKey(engine.id) || null
      })()
    }
    return this.searchKeyPromise
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
      webSearchKey: await this.webSearchKey(),
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
        // The judgement is read as an object, so the wire is asked for one. It is an ask and not a
        // guarantee — plenty of relays drop the field, and Anthropic has none — which is why `parseVerdict`
        // below still takes the object out of prose rather than trusting the answer to be bare JSON.
        // The prompt is also the half that makes the ask safe: a server that honours `json_object` refuses
        // one whose messages never mention JSON, and both language catalogs say "Reply with JSON only".
        structured: true,
        reasoning: 'off',
        reasoningDialect: call.reasoningDialect,
        retry: this.retryFor(resolved.provider),
        signal: controller.signal,
      })) {
        if (event.type === 'text') text += event.delta
      }
    } catch {
      // Best-effort, and metered rather than silent: the judgement is an extra opinion on two paragraphs
      // the writer's own rule already has a way to handle, so a dead summariser model must not fail the
      // write the reader asked for. The count is what makes the absence visible on the cost screen, and
      // `null` is the answer "no opinion", which is what the caller was built to take.
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
  async offlineTurn(conversationId: string, content: string, scopes: AssistantTurnScope[] = []): Promise<AssistantMessage> {
    await this.store.addMessage({
      conversationId,
      role: 'user',
      content,
      ...(scopes.length ? { scopes: scopes.slice(0, MAX_TURN_SCOPES) } : {}),
    })
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

/**
 * What a call from an earlier turn answers with when the model is shown its own past again.
 *
 * A stored `{"ok":true}` told the model it had retrieved nothing, so it called the same tool for the same
 * answer — and inside one turn the executor refuses a repeated call outright, which left the reader
 * watching a loop spend its steps and still not answer. So the real result travels, shortened to what a
 * later turn needs to remember rather than to what the turn that made it wanted to say. A failure keeps
 * naming itself, because that is the part the model has to know.
 */
function historyToolResult(tool: ToolActivity): string {
  if (tool.error) return JSON.stringify({ error: tool.error })
  if (!tool.result) return '[the result of this call was not kept]'
  if (tool.result.length <= MAX_HISTORY_TOOL_RESULT_CHARS) return tool.result
  return `${tool.result.slice(0, MAX_HISTORY_TOOL_RESULT_CHARS)}\n… [${tool.result.length - MAX_HISTORY_TOOL_RESULT_CHARS} more characters]`
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
 * Whether a row is already inside the roll-up and must not be sent again.
 *
 * The mark is a millisecond, and two turns written inside one millisecond are indistinguishable to `>`:
 * the row that came last — often the reader's newest question — used to be discarded along with the history
 * being condensed away from it. So the cutoff row is excluded by name when the caller can name it, which it
 * can on the turn that wrote the summary and not on a later one reading the mark out of the conversation.
 * There the older, coarser rule stands: everything sharing that millisecond goes with it, since one of them
 * is the row the summary was cut at and nothing here says which.
 */
function foldedIntoSummary(entry: HistoryEntry, summaryUpto: number | null, summaryUptoId?: string | null): boolean {
  if (summaryUpto === null) return false
  if (entry.createdAt !== summaryUpto) return entry.createdAt < summaryUpto
  return summaryUptoId ? entry.id === summaryUptoId : true
}

/**
 * Fits the newest turns into `maxTokens`.
 *
 * The newest turn is always kept even when it does not fit: dropping the question the reader just
 * asked would produce an answer to nothing, which is worse than one oversized prompt.
 */
/**
 * What one turn costs the window.
 *
 * The reader's words are most of it, but an assistant turn also carries the answers its calls brought back,
 * and every later prompt sends them again. Counting only the text under-priced exactly the turns that read
 * the most — which is how a window could fit its own budget and the request still go over the model's.
 */
function entryCost(entry: HistoryEntry): number {
  const results = (entry.calls ?? []).reduce((total, call) => total + estimateTokens(call.result), 0)
  return estimateTokens(entry.content) + results + 4
}

export function buildContextWindow(
  history: HistoryEntry[],
  maxTokens: number,
  summaryUpto: number | null,
  summaryUptoId?: string | null,
): ContextWindow {
  const eligible = history.filter((entry) => entry.content.trim().length > 0 && !foldedIntoSummary(entry, summaryUpto, summaryUptoId))
  const kept: HistoryEntry[] = []
  let used = 0
  for (let index = eligible.length - 1; index >= 0; index--) {
    const entry = eligible[index]!
    const cost = entryCost(entry)
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

/**
 * The same budget check, on content that is already final.
 *
 * `buildContextWindow` decides the window from placeholder text; once the surviving turns have had
 * their files read, the real cost is larger than the estimate. This trims the front until what is about
 * to be sent fits, and returns what it dropped so the summariser can account for it.
 */
function fitToBudget(entries: HistoryEntry[], maxTokens: number): { kept: HistoryEntry[], dropped: HistoryEntry[] } {
  const kept: HistoryEntry[] = []
  let used = 0
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    const cost = entryCost(entry)
    if (kept.length > 0 && used + cost > maxTokens) break
    kept.unshift(entry)
    used += cost
  }
  while (kept.length > 1 && kept[0]!.role !== 'user') kept.shift()
  return { kept, dropped: entries.slice(0, Math.max(0, entries.length - kept.length)) }
}

/**
 * The judgement object, taken out of whatever the model answered with.
 *
 * The request asks the wire for JSON (see `structured`), and a provider that honours it answers with a bare
 * object the brace below finds on its first character. A relay that ignored the field answers with prose
 * around it, which is what the same brace is for: the channel moves the odds and does not carry a promise,
 * since nothing sent from here can make a vendor obey it. So the read stays exactly as wide as it was
 * before the field existed, and a turn is no different when the field is ignored.
 */
export function parseVerdict(text: string): { relationship: string, confidence: number, reason: string } | null {
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

/**
 * The title and follow-ups, taken out of whatever the naming call answered with.
 *
 * Same brace-extraction discipline as `parseVerdict`: the request asked the wire for JSON (see `structured`),
 * a provider that honoured it answers with a bare object, a relay that ignored it answers with an object
 * wrapped in prose, and the brace finds the object either way. What comes back is then validated rather than
 * trusted: the title is a single trimmed line bounded by `MAX_CONVERSATION_TITLE_CHARS`, the follow-ups run
 * through `clipSuggestionList` (at most three, each length-bounded, empties and repeats dropped) — so a model
 * that volunteered five, or a run-on paragraph where a name belongs, is trimmed to something safe rather than
 * rejected whole or stored as-is. `null` means the answer held no usable object at all, which leaves the
 * derived title standing and no suggestions shown; a valid object that named only follow-ups (empty title) is
 * not `null` — it returns with the suggestions and an empty title, and the caller renames nothing.
 */
function parseNaming(text: string): { title: string, suggestions: string[] } | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const title = typeof record.title === 'string'
    ? record.title.replace(/\s+/g, ' ').trim().slice(0, MAX_CONVERSATION_TITLE_CHARS)
    : ''
  const suggestions = clipSuggestionList(record.suggestions)
  if (!title && !suggestions.length) return null
  return { title, suggestions }
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
