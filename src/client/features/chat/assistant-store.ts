/**
 * The chat app's state.
 *
 * One store rather than one per surface, because the surfaces share more than they differ: the
 * settings decide how a chat turn is assembled, the memory list has to refresh after a turn that
 * called `remember`, and the unread badge is read from two places. Splitting it would mean keeping
 * three stores in step by hand, which is the kind of thing that shows up as a stale panel rather than
 * as an error.
 *
 * A streamed turn lives here and not in React state on purpose: the reader can navigate to another
 * surface mid-reply and come back to find it still arriving, because the generator keeps writing into
 * the same record the view reads.
 */

import { create } from 'zustand'
import type {
  AssistantArtifact,
  AssistantArtifactVersion,
  AssistantConversation,
  ChatFolderNode,
  ChatProjectNode,
  ConversationTag,
  AssistantMemory,
  AssistantMessage,
  AssistantAnswerVersion,
  AssistantMcpCatalogEntry,
  AssistantMcpProblem,
  AssistantMcpServerDetail,
  AssistantMcpServer,
  AssistantModel,
  AssistantNotification,
  AssistantProvider,
  AssistantSettings,
  AssistantSource,
  AssistantVendorModel,
  Automation as AssistantAutomation,
  AutomationRun as AssistantAutomationRun,
  ChatStreamEvent,
  MemoryReview,
  Project,
  ToolActivity,
  MessageFeedback,
} from '@shared/assistant'
import type { AssistantSkill } from '@shared/assistant'
import type { TodoAssistantContext } from '@shared/todos/assistant-context'
import type { EmailAssistantContext } from '@shared/email/assistant-context'
import type { NavAssistantContext } from '@shared/nav/assistant-context'
import type { DatabaseAssistantContext } from '@shared/development/database/assistant-context'
import type { MusicAssistantContext } from '@shared/music/assistant-context'
import type { InknoteAssistantContext } from '@shared/inknote/assistant-context'
import { DEBOUNCE } from '@shared/constants'
import { formatBytes } from '@shared/byte-format'
import { MAX_ARTIFACT_CONTENT_CHARS, MAX_ARTIFACT_TITLE_CHARS, MAX_CHAT_ATTACHMENTS, AUDIO_SEND_MAX_BYTES, MAX_TURN_SCOPES, MAX_TURN_TOOLS, CONVERSATION_PAGE_SIZE, MESSAGE_PAGE_SIZE, attachmentModality, audioFormatFor, modelWire, protocolCarriesAudio, type AssistantModelModality, type AttachmentSense, type AssistantTurnScope, type ChatAttachment, type AssistantSkillInput, type SkillImportResult, type AssistantMcpToolMode } from '@shared/assistant'
import { api, ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { streamAssistantTurn } from './stream'
import { leadingProse } from './save-to-note'
import { extractPdfText } from './pdf-text'
import { downloadSkillBundle } from './skill-bundle'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'

export type AssistantView = 'chat' | 'memory' | 'tasks' | 'automations' | 'skills' | 'projects' | 'settings'

export const ASSISTANT_VIEWS: readonly AssistantView[] = ['chat', 'memory', 'tasks', 'automations', 'skills', 'projects', 'settings']

/** The picks the conversation list's tab strip offers, in the order it draws them. */
export type ConversationListTab = 'folders' | 'projects' | 'tags' | 'starred' | 'pinned' | 'archived' | 'saved'

export const CONVERSATION_LIST_TABS: readonly ConversationListTab[] = ['folders', 'projects', 'tags', 'starred', 'pinned', 'archived', 'saved']

/**
 * A paste at least this long is turned into a text file instead of being pasted into the box.
 *
 * The reader pasted it as context, not as something to scroll past for the next three turns.
 */
export const PASTE_FILE_MIN_CHARS = 2000

/** Whether a file's own words can be read here: only a PDF has a parser in the browser today. */
function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

/** One file on its way to the server, or waiting there for the reader to press send. */
export interface PendingAttachment {
  localId: string
  /**
   * Empty until the upload lands; the server's id is what the turn names.
   *
   * A row refused before it was ever uploaded stays empty, because there is nothing on the server to name.
   */
  id: string
  filename: string
  mime: string
  size: number
  kind: 'image' | 'file'
  /** 0..1 of the bytes the browser has handed over. */
  progress: number
  status: 'uploading' | 'ready' | 'error'
  /** Why this row is not in the turn: the line a refused upload gave, or the reason a file was never sent. */
  error?: string
  /**
   * The file as the browser handed it over, kept only so a failed upload can be tried again.
   *
   * Memory only: the bytes are already the browser's, and a retry that asked the reader to pick the
   * file again would lose the context the failure happened in. A row refused before its first byte left
   * keeps it as well, so that every door into `retryAttachment` meets the same answer there.
   */
  sourceFile?: File
}

/** What a reader has typed but the assistant has not answered yet. */
interface LiveTurn {
  /**
   * The identity of this turn in this tab.
   *
   * Every stream event carries the token of the send that asked for it, and only the turn with that
   * token may be written by it. Without it a reply still arriving from a conversation the reader has
   * left would append its words to whichever turn is on screen now — two threads' sentences in one
   * bubble, and the older stream ending the newer turn.
   */
  token?: number
  /**
   * The run lease this turn holds on the worker, distinct from `token` above.
   *
   * `token` identifies the send inside this tab; this is the server's claim on the conversation, which is
   * what a stop has to name. Releasing the claim without naming it unlocks whatever turn is running now —
   * so a stop pressed a second before a new send claimed released the *new* answer's claim, and that answer
   * was then filed as stopped although nobody had asked it to stop.
   */
  runToken?: number
  conversationId: string | null
  userText: string
  /** The files the reader hung on this turn, so the bubble can show them before the row exists. */
  attachments: string[]
  assistantId: string | null
  text: string
  reasoning: string
  tools: ToolActivity[]
  stage: ChatStreamEvent['stage']
  error: string | null
  /**
   * Whether the failure in `error` is the reading loop's own news that the bytes stopped arriving.
   *
   * Kept as a fact rather than folded into the sentence, because the sentence a broken stream may print
   * depends on something the store cannot see when it writes: whether the transcript is drawing the
   * continue control for this answer right now. `ChatView.tsx` reads this next to the row's own
   * `canContinueAnswer` and asks for the line — see `streamInterruptedLine`.
   */
  streamInterrupted?: boolean
  done: boolean
  /** When this send started, so the composer's comparison column can say how long the answer took. */
  startedAt?: number
  /** What the model reported spending, once the `usage` frame landed. Null while it has not said. */
  usage?: { inputTokens: number, outputTokens: number } | null
  /**
   * The pages a web search consulted, copied from the row the worker filed at the end of the turn.
   *
   * The citations are drawn from here, so a turn that searched has to carry them the moment it settles —
   * otherwise the answer looks unsourced until the reader leaves the thread and comes back to it.
   */
  sources?: AssistantSource[]
  /** When the turn settled; absent while it is still arriving. */
  finishedAt?: number | null
}

/** The reader's own models that can answer a chat turn: enabled, and for conversation. */
export function chatModels(models: readonly AssistantModel[]): AssistantModel[] {
  return models.filter((model) => model.enabled && model.purpose === 'chat')
}

/** A model as a reader names it in a sentence. */
export function modelLabelOf(model: AssistantModel | null | undefined): string {
  if (!model) return ''
  return model.label || model.model
}

/**
 * What `POST /automations` reads, written down rather than left as a loose record.
 *
 * The two target fields are the reason this exists: the route asks for `folderId` and `noteId`, while the
 * row it answers with calls them `targetFolderId` and `targetNoteId`. A client body that sent the row's
 * names would be accepted — and read as no target at all, because a field the route does not look at is a
 * field the route does not have. Naming them here is what keeps that mismatch from coming back as a
 * schedule that silently writes nowhere.
 *
 * A target is settable only at create: `PATCH /automations/:id` whitelists the words and the timing, so a
 * routine cannot be repointed at another page after the reader has learned to trust its name.
 *
 * A type alias and not an interface on purpose: `api` takes the body as `Record<string, unknown>`, and an
 * interface has no implicit index signature, so the call below would need a cast to say the same thing.
 */
export type AutomationCreateInput = {
  name: string
  kind: AssistantAutomation['kind']
  message: string
  schedule: AssistantAutomation['schedule']
  enabled: boolean
  folderId?: string
  noteId?: string
}

interface AssistantState {
  view: AssistantView
  loaded: boolean
  loading: boolean
  error: string | null

  conversations: AssistantConversation[]
  /** Where the next page of the list starts; null means this page is all of it. */
  conversationsCursor: string | null
  conversationsHasMore: boolean
  conversationsLoadingMore: boolean
  /**
   * The conversations the reader is picking out of the list, or null when not picking.
   *
   * An empty set is "picking with nothing chosen yet", which is a different state from "not picking" —
   * the same pair the message selection uses, and for the same reason: a mode has to exist before its
   * first choice does.
   */
  conversationPicks: ReadonlySet<string> | null
  conversationQuery: string
  /** 'all', 'none' (unfiled), or a folder id from the notebook's tree. */
  folderFilter: string
  tagFilter: string | null
  folderNodes: ChatFolderNode[]
  /** Conversations with no folder; the tree counts the rest. */
  unfiledCount: number
  /** 'all', 'none' (under no brief), or a project id. */
  projectFilter: string
  projectNodes: ChatProjectNode[]
  /** Conversations under no project; the projects list counts the rest. */
  unfiledProjectCount: number
  tagNodes: (ConversationTag & { count: number })[]
  /** Which of the four pickers the list column's tab panel currently shows. */
  listTab: ConversationListTab
  /** The shortlists two of the tabs jump to; kept apart from the filtered main list. */
  flagged: { starred: AssistantConversation[], pinned: AssistantConversation[], archived: AssistantConversation[] }
  /** The composer's live-web-search switch, kept between turns like the other per-composer settings. */
  webSearch: boolean
  setWebSearch: (value: boolean) => void
  /**
   * Whether the note the reader has open rides along as context with the next turn.
   *
   * The notebook's own pointer is what makes "summarise this" work without naming the note, but a
   * pointer the reader cannot see is a pointer they cannot correct — so it is drawn as a chip the reader
   * can take off, and these two flags are what the chip and the send path both read.
   */
  noteContextOn: boolean
  /** The plan the money app has on screen, pushed by the dock that sits beside it. Null means nothing is attached. */
  subscriptionContext: { id: string, name: string } | null
  /**
   * Which app the assistant is docked beside right now.
   *
   * A mount effect that switches the notebook's pointers off is a race: opening, switching or starting a
   * conversation puts noteContextOn back to true, and the reader is left with a note chip for a page
   * that has no note on it. The surface is therefore checked where the chips are drawn and where the turn
   * is sent, not only when the dock appears.
   */
  dockSurface: 'notebook' | 'subscriptions' | 'todos' | 'email' | 'nav' | 'music' | 'database' | 'inknote'
  folderContextOn: boolean
  /**
   * Whether the draft open in the canvas rides along with the next turn.
   *
   * The same rule as the note chip: a context the reader cannot see is one they cannot correct. The
   * canvas being open is not enough; the chip is the visible promise, and taking it off leaves the
   * draft on screen without sending it to the model.
   */
  canvasContextOn: boolean
  todoContext: TodoAssistantContext | null
  todoContextOn: boolean
  emailContext: EmailAssistantContext | null
  emailContextOn: boolean
  navContext: NavAssistantContext | null
  navContextOn: boolean
  databaseContext: DatabaseAssistantContext | null
  databaseContextOn: boolean
  /** The music screen the dock beside the player is carrying, and whether the chip is attached. */
  musicContext: MusicAssistantContext | null
  musicContextOn: boolean
  /** The hand-written note the dock beside it is carrying, and whether the chip is attached. */
  inknoteContext: InknoteAssistantContext | null
  inknoteContextOn: boolean
  setNoteContext: (on: boolean) => void
  setSubscriptionContext: (value: { id: string, name: string } | null) => void
  setDockSurface: (surface: 'notebook' | 'subscriptions' | 'todos' | 'email' | 'nav' | 'music' | 'database' | 'inknote') => void
  setFolderContext: (on: boolean) => void
  setCanvasContext: (on: boolean) => void
  setTodoContext: (value: TodoAssistantContext | null) => void
  setTodoContextOn: (on: boolean) => void
  setEmailContext: (value: EmailAssistantContext | null) => void
  setEmailContextOn: (on: boolean) => void
  setNavContext: (value: NavAssistantContext | null) => void
  setNavContextOn: (on: boolean) => void
  setDatabaseContext: (value: DatabaseAssistantContext | null) => void
  setDatabaseContextOn: (on: boolean) => void
  setMusicContext: (value: MusicAssistantContext | null) => void
  setMusicContextOn: (on: boolean) => void
  setInknoteContext: (value: InknoteAssistantContext | null) => void
  setInknoteContextOn: (on: boolean) => void
  /**
   * Text the composer has been asked to start from — a quote of a turn.
   *
   * The draft lives in the composer's own state, so a menu elsewhere on screen cannot reach it. This is
   * the one-way handover: the menu writes a block here, the composer takes it once and clears it, and
   * nothing else reads it.
   */
  composerSeed: string | null
  seedComposer: (text: string) => void
  clearComposerSeed: () => void
  /** The composer's queue: files uploaded for a turn that has not been sent yet. */
  pending: PendingAttachment[]
  /** Attachment rows behind the open conversation, by id, so a bubble can name what it carries. */
  fileIndex: Record<string, ChatAttachment>
  activeId: string | null
  messages: AssistantMessage[]
  messagesReady: boolean
  /**
   * Why the open thread could not be read, and null while nothing is outstanding.
   *
   * `messagesReady` alone cannot tell a refused thread from an empty one, and the reader's own history
   * disappearing into the "say something to start" screen is the worse failure: it looks like their
   * conversation is gone. The view draws this instead of that screen.
   */
  messagesError: string | null
  /**
   * The page boundary above the oldest message on screen, and whether there is more above it.
   *
   * A thread is read from its end. The turns above the first page are fetched when the reader scrolls
   * up, so opening a conversation with a thousand messages costs one page rather than all of them.
   */
  messagesBefore: string | null
  messagesHasMore: boolean
  messagesLoadingMore: boolean
  /** Whether the window was opened at an older hit, with newer turns still below it. */
  messagesHasNewer: boolean
  /** The turn a search asked the thread to land on, cleared once it has been scrolled to. */
  focusMessageId: string | null
  /**
   * The displaced answers of a turn, by message id; absent until the reader opens that turn's pager.
   * A transcript of forty turns does not need forty histories fetched up front.
   */
  answerVersions: Record<string, AssistantAnswerVersion[] | undefined>
  remoteStreaming: boolean
  /**
   * The half answer of a turn the server no longer claims, and whether the ceiling on the run lease cut it.
   *
   * A Worker isolate killed by its CPU limit never runs `finish`: it files no assistant row, and the lease it
   * held goes on claiming the thread for the rest of its window. The renewal it did perform carried the words
   * it had written, so the conversation read hands them back beside `streaming: false` — the only shape in
   * which a reader can be told that an answer stopped because the writer was interrupted rather than because
   * the model had said what it meant.
   *
   * Deliberately not filled while a turn is still being held: a draft of an answer somebody is writing belongs
   * to the waiting placeholder, and putting it on the screen as a reply would say the writer is gone when the
   * only evidence is a lease nobody has let go of yet.
   */
  remotePartial: string | null
  /** Whether `remotePartial` filled the ceiling the lease can carry, so more was written than is shown. */
  remotePartialTruncated: boolean
  turn: LiveTurn | null

  /**
   * The drafts the open conversation keeps, and which of them the side panel is showing.
   *
   * Read with the thread and held here rather than fetched by the panel itself, for the same reason the
   * messages are: the panel is one of the conversation's surfaces, so leaving it for the memory tab and
   * coming back must not re-fetch a document the reader is in the middle of editing.
   */
  artifacts: AssistantArtifact[]
  /** False until the first read lands, so the panel can tell "none yet" from "not yet known". */
  artifactsReady: boolean
  /** Whether the side panel is open. Kept here so it survives a switch of surface, like the thread does. */
  canvasOpen: boolean
  /** The draft the panel is editing; null means it is showing the list of them. */
  activeArtifactId: string | null

  /**
   * Whether the thread on screen is a temporary one.
   *
   * Not read off the conversation list, which by design never carries a temporary conversation — this is
   * the store's own memory of what the reader asked for, kept until they leave the thread.
   */
  ephemeral: boolean
  /** Start a conversation the reader asked not to keep. */
  startTemporaryConversation: () => void

  memories: AssistantMemory[]
  memoryCounts: { active: number, historical: number, review: number }
  memoryTotal: number
  memoryQuery: string
  memoryStatus: string
  memoryCategory: string
  reviews: MemoryReview[]

  projects: Project[]

  automations: AssistantAutomation[]
  runs: AssistantAutomationRun[]

  notifications: AssistantNotification[]
  unread: number

  settings: AssistantSettings | null
  providers: AssistantProvider[]
  models: AssistantModel[]

  /** The reader's external MCP servers, and the tools each of them currently offers. */
  mcpServers: AssistantMcpServer[]
  mcpProblems: AssistantMcpProblem[]
  /** One entry per server, switched-off tools included, so the screen can draw every switch it needs. */
  mcpCatalog: AssistantMcpCatalogEntry[]
  /** True while the listing is in flight: a switch flipped against a stale list would be a lie. */
  mcpCatalogLoading: boolean
  loadMcp: () => Promise<void>
  addMcpServer: (body: Record<string, unknown>, report?: ReportFailure) => Promise<boolean>
  /** One server as its editor opens it: the row plus the header names it stores, never the values. */
  /**
   * Just the server rows.
   *
   * The transcript names a past call's third party from them (`context7: query-docs` rather than
   * `mcp_rzmbk9_query-docs`), which is a label and not a listing: `loadMcp` would ask every configured
   * server for its tools to draw a chip, which is a network round trip per thread open.
   */
  loadMcpServers: () => Promise<void>

  /**
   * Run one stored third-party call again with what it was handed.
   *
   * The answer comes back to the caller and is never written into the thread: what the model was given is
   * a record of the turn, and a call made now is a new observation.
   */
  replayMcpTool: (conversationId: string, messageId: string, toolId: string) => Promise<{ ok: boolean, error: string, result: string }>

  loadMcpServer: (id: string) => Promise<AssistantMcpServerDetail | null>
  /**
   * A server the reader changed, as the form that changed it says whether it worked.
   *
   * The route reads every field it was given, and true is said only once the row has been read back, so a
   * form that keeps its own "saved" note can trust it rather than the absence of a failure.
   */
  patchMcpServer: (id: string, body: Record<string, unknown>, report?: ReportFailure) => Promise<boolean>
  /**
   * One press on a tool's switch, or on the card's all-of-them pair.
   *
   * The whole off-list is written every time rather than a delta: the row holds a list, so a request that
   * added one name would race the request that removed another, and the loser would silently win.
   */
  /**
   * Answer for some of one server's tools at once.
   *
   * The map is written whole rather than one key at a time because the server's own mode is the default
   * a tool is measured against, and that comparison only happens where the whole map is in hand.
   */
  setMcpToolModes: (server: AssistantMcpServer, modes: Record<string, AssistantMcpToolMode>) => Promise<void>
  removeMcpServer: (id: string) => Promise<void>
  /** Opens the third party's own login in a popup and waits for the reader to come back. */
  authorizeMcp: (id: string) => Promise<boolean>
  revokeMcp: (id: string) => Promise<void>
  /** Withdraw the client registration itself, at the issuer when it can be; false means only cleared here. */
  revokeMcpClient: (id: string) => Promise<boolean>
  testMcpServer: (id: string, headers?: Record<string, string>) => Promise<{ ok: boolean, error: string, count: number }>

  setView: (view: AssistantView) => void
  bootstrap: (force?: boolean) => Promise<void>
  loadProviders: () => Promise<void>
  /** A turn can have written memories, tasks and schedules, so the other surfaces re-read once. */
  refreshAfterTurn: () => Promise<void>
  loadConversations: () => Promise<void>
  /** Enters the list's picking mode, optionally with one row already ticked. */
  startPickingConversations: (id?: string) => void
  toggleConversationPick: (id: string) => void
  cancelConversationPicks: () => void
  /** Files every picked conversation away at once. */
  archivePickedConversations: () => Promise<void>
  /** Deletes every picked conversation, after the caller has asked. */
  deletePickedConversations: () => Promise<void>
  /** The next page of the sidebar list, appended to what is already there. */
  loadMoreConversations: () => Promise<void>
  /** The page of turns above the oldest one on screen, prepended to the transcript. */
  loadEarlierMessages: () => Promise<void>
  /** The answers one turn displaced, fetched once per message and kept for the session. */
  loadAnswerVersions: (messageId: string) => Promise<AssistantAnswerVersion[]>
  /** Make one of those answers the turn's live one again. */
  activateAnswerVersion: (messageId: string, versionId: string) => Promise<void>
  /**
   * Retype one of the reader's own messages, then answer it again.
   *
   * The turn the server removed is the one this replaces, so the words land first, the thread is
   * re-read, and the same turn is asked for once more — the reader edited a question, not a transcript.
   */
  editMessage: (messageId: string, content: string, options?: { keepBranch?: boolean }) => Promise<void>
  /** Take one turn back: the reader's message and the answer that was drawn from it. */
  removeMessage: (messageId: string) => Promise<void>
  /** Records or takes back the reader's verdict on one answer. */
  rateAnswer: (messageId: string, feedback: MessageFeedback) => Promise<void>
  /**
   * Keep one turn, or take it back off the shelf.
   *
   * Nothing is painted before the write answers: a keep is a row on the server, and a bubble that goes on
   * looking kept after the route refused is a mark the reader believes. The local row is set from what came
   * back, not from what was asked for. `false` means the shelf is unchanged, and the refusal — the route's
   * own line about the field it disliked — goes to `report` when the caller can show one, and to a toast
   * when it cannot.
   */
  toggleMessageSaved: (messageId: string, report?: ReportFailure) => Promise<boolean>
  /** Starts a new conversation that carries this one up to the given message. */
  forkFrom: (messageId: string) => Promise<void>
  /** Deletes exactly the turns a reader selected. */
  removeMessages: (ids: readonly string[]) => Promise<void>
  setConversationQuery: (query: string) => Promise<void>
  /** The folder tree and the tag list, both counted for conversations. */
  loadTaxonomy: () => Promise<void>
  setFolderFilter: (value: string) => Promise<void>
  setProjectFilter: (value: string) => Promise<void>
  setTagFilter: (tagId: string | null) => Promise<void>
  setListTab: (tab: ConversationListTab) => Promise<void>
  loadFlagged: () => Promise<void>
  starConversation: (id: string, starred: boolean) => Promise<void>
  moveConversation: (id: string, folderId: string | null) => Promise<void>
  setConversationProject: (id: string, projectId: string | null) => Promise<void>
  setConversationNote: (id: string, noteId: string | null) => Promise<void>
  toggleConversationTag: (id: string, tagId: string, on: boolean) => Promise<void>
  /**
   * File a conversation under a tag `createTag` has only just asked the server for.
   *
   * `createTag` is optimistic by design — it validates, dedupes, seeds the local cache and posts the row
   * without waiting — so its id is in hand a round trip before the row exists, and the attach route
   * refuses an unknown tag. Waiting for the row is what turns "click new tag, nothing happens" into
   * either the label appearing or a word about why it did not.
   */
  attachNewTag: (id: string, tagId: string) => Promise<void>
  /**
   * Opens a thread, at its newest page unless a message is named.
   *
   * `focusMessageId` comes from a search hit: the page is read around that turn rather than at the end,
   * and the thread scrolls to it once the rows are on screen.
   */
  openConversation: (id: string | null, options?: { focusMessageId?: string }) => Promise<void>
  /** Takes the "land here" mark off once the thread has scrolled to it. */
  clearFocusMessage: () => void
  newConversation: () => void
  /**
   * Asks the assistant, and answers whether the worker took the turn.
   *
   * False means the request never reached the worker — a refused route or a connection that never
   * formed — so the composer can hand the reader their words back instead of swallowing them. True
   * covers a turn that ran and a turn the reader stopped: either way the question itself was sent.
   */
  send: (text: string, opts?: {
    retry?: boolean
    messageId?: string
    continue?: boolean
    activeArtifactId?: string
    /** A model named by a canvas action or a skill; absent uses the reader's standing pick. */
    modelId?: string | null
    noTools?: boolean
  }) => Promise<boolean>
  /**
   * Queue files the reader picked, dragged or pasted, and send the ones a turn could read.
   *
   * A clip, and a recording the model on screen cannot be handed, are turned away here without an upload:
   * see `unreadableAttachmentReason`.
   */
  attachFiles: (files: File[]) => Promise<void>
  /** Uploads one failed attachment again, from the file the browser still holds. */
  retryAttachment: (localId: string) => Promise<void>
  attachUrl: (url: string) => Promise<void>
  attachPastedText: (text: string) => Promise<boolean>
  /** Tools the reader pinned to this turn with `/`, and note scopes pinned with `#`. */
  turnTools: string[]
  turnScopes: AssistantTurnScope[]
  addTurnTool: (name: string) => void
  dropTurnTool: (name: string) => void
  addTurnScope: (scope: AssistantTurnScope) => void
  dropTurnScope: (id: string) => void
  dropAttachment: (localId: string) => Promise<void>
  clearAttachments: () => void
  skills: AssistantSkill[]
  loadSkills: (query?: string) => Promise<void>
  createSkill: (input: AssistantSkillInput) => Promise<AssistantSkill | null>
  saveSkill: (id: string, input: AssistantSkillInput) => Promise<void>
  removeSkill: (id: string) => Promise<void>
  /** Fetch the whole library and hand it to the reader as a file. */
  exportSkills: () => Promise<void>
  /**
   * Send a bundle's entries in, and say what came of them.
   *
   * The list is not patched here the way the single-skill actions patch it: an import may add hundreds of
   * rows, and the caller is the one that knows which search is on screen, so it re-reads with its own.
   */
  importSkills: (entries: unknown[]) => Promise<SkillImportResult | null>
  /**
   * Arm the turn with everything one saved skill stands for, not only its words.
   *
   * The text is the composer's business — it appends to what the reader was already typing — so this
   * covers the other three: the tools and knowledge the skill wants are added to this turn's pins, and
   * its model becomes the one that answers.
   */
  applySkill: (skill: AssistantSkill) => void
  stop: () => void
  renameConversation: (id: string, title: string) => Promise<void>
  pinConversation: (id: string, pinned: boolean) => Promise<void>
  /** Put a conversation away without deleting it, or bring it back into the everyday list. */
  archiveConversation: (id: string, archived: boolean) => Promise<void>
  deleteConversation: (id: string) => Promise<void>

  /** Open or close the side panel; the reader's own toggle, kept for the session. */
  setCanvasOpen: (open: boolean) => void
  /** Show one draft in the panel, or the list of them when the id is null. */
  selectArtifact: (id: string | null) => void
  /** Re-read the open conversation's drafts. */
  loadArtifacts: () => Promise<void>
  /**
   * Keep a reply as a draft and open the panel on it.
   *
   * The reply is copied, never moved: the message stays the record of what was said, and the draft is the
   * copy that is meant to change. The title is the reply's own first line, so the list reads as documents
   * rather than as timestamps.
   */
  createArtifactFromReply: (text: string) => Promise<void>
  /**
   * Start an empty draft, creating the conversation it needs when there is none.
   *
   * A draft belongs to a thread, so the panel opened on an empty screen has to make one before it can
   * make the draft. The empty conversation is a real thread the reader can leave or delete; it is not a
   * second kind of draft storage.
   */
  createDraft: () => Promise<void>
  /**
   * The snapshots of each draft that has been asked for, keyed by draft id.
   *
   * Loaded on demand rather than with the draft list: a conversation with fifty drafts would otherwise
   * pay for fifty histories the reader may never open.
   */
  artifactVersions: Record<string, AssistantArtifactVersion[] | undefined>
  loadArtifactVersions: (artifactId: string) => Promise<void>
  /** One snapshot with its body. Throws when the read fails, so the history view can say so and retry. */
  readArtifactVersion: (artifactId: string, versionId: string) => Promise<AssistantArtifactVersion>
  /** Bring an old snapshot back as a new head; returns the draft as it now stands. */
  restoreArtifactVersion: (artifactId: string, versionId: string) => Promise<AssistantArtifact>
  /** Rewrite a draft's name or body. The server stores what it is sent and keeps the rest. */
  saveArtifact: (
    id: string,
    patch: { title?: string, content?: string, noteId?: string | null },
    options?: { baseVersion?: number, source?: 'user' | 'assistant', messageId?: string | null },
  ) => Promise<AssistantArtifact>
  removeArtifact: (id: string) => Promise<void>
  decideAction: (actionId: string, approve: boolean) => Promise<void>

  loadMemories: () => Promise<void>
  setMemoryFilter: (patch: { query?: string, status?: string, category?: string }) => Promise<void>
  addMemory: (content: string, category: string) => Promise<void>
  editMemory: (id: string, content: string, category: string) => Promise<void>
  correctMemory: (id: string, content: string) => Promise<void>
  setMemoryStatus: (id: string, status: string) => Promise<void>
  /** Write a memory out as a note in the vault, and remember which note it became. */
  saveMemoryAsNote: (id: string, folderId: string | null, title: string) => Promise<string | null>
  removeMemory: (id: string) => Promise<void>
  resolveReview: (id: string, action: string) => Promise<void>

  loadProjects: () => Promise<void>
  addProject: (name: string) => Promise<void>
  removeProject: (id: string) => Promise<void>

  loadAutomations: () => Promise<void>
  addAutomation: (body: AutomationCreateInput) => Promise<boolean>
  toggleAutomation: (automation: AssistantAutomation) => Promise<void>
  updateAutomation: (id: string, body: Record<string, unknown>) => Promise<void>
  removeAutomation: (id: string) => Promise<void>

  loadNotifications: () => Promise<void>
  markRead: (id?: string) => Promise<void>
  removeNotification: (id: string) => Promise<void>

  loadSettings: () => Promise<void>
  saveSettings: (patch: Record<string, unknown>) => Promise<void>
  /**
   * The created row, so a caller can go straight on to the models of the provider it just made — the
   * vendor listing needs an id, and asking for the settings again to find it would be a second race.
   * `null` when the route refused it.
   */
  addProvider: (body: Record<string, unknown>, report?: ReportFailure) => Promise<AssistantProvider | null>
  updateProvider: (id: string, body: Record<string, unknown>, report?: ReportFailure) => Promise<boolean>
  removeProvider: (id: string) => Promise<void>
  addModel: (body: Record<string, unknown>, report?: ReportFailure) => Promise<boolean>
  /** Any subset of the model's own fields; the route validates each one it recognises. */
  updateModel: (id: string, body: Partial<AssistantModel>, report?: ReportFailure) => Promise<boolean>
  removeModel: (id: string) => Promise<void>
  activateModel: (id: string) => Promise<void>
  /** The vendor's own list for one provider, asked when the picker opens. */
  vendorModels: AssistantVendorModel[]
  vendorModelsError: string | null
  vendorModelsLoading: boolean
  loadVendorModels: (providerId: string) => Promise<void>
  /**
   * The same listing for a provider the form has not saved yet. It fills the same two fields the dialog
   * already reads, so a listing looks the same whether the row exists or is still being typed.
   */
  loadDraftVendorModels: (input: { protocol: string, baseUrl: string, apiKey: string }) => Promise<void>
  /**
   * Makes this provider's vendor-listed models match exactly what was ticked: the ids that are missing are
   * created, and the ones the vendor listed but the reader unticked are deleted.
   *
   * A model the reader typed in by hand is not the dialog's to delete — it is not in the vendor's listing,
   * so an untick cannot name it — and it is left alone even when it is not in the ticked set.
   */
  syncVendorModels: (providerId: string, ids: string[]) => Promise<{ added: number, removed: number }>
}

/**
 * The abort handle of every turn this tab is running, keyed by the turn's token.
 *
 * A map rather than one field because leaving a conversation does not stop its reply: the reader can
 * walk to another thread and ask something there while the first answer is still arriving, and each
 * request has to be stoppable on its own. The token is what finally deletes the right entry, so a
 * stream that ends after a newer one began cannot take the newer handle away.
 */
const inflight = new Map<number, AbortController>()
let turnSeq = 0
let conversationRequest = 0
/**
 * The one list read in flight, so a header that carries a bell and a bootstrap behind it asks once.
 *
 * A failed read leaves nothing held: the count stays where it was, and the next mount asks again rather
 * than treating a list it never read as an empty account.
 */
let notificationsRequest: Promise<void> | null = null

/**
 * Why a write was refused, in the two lines a form can print.
 *
 * The headline is what this app's code means, in the reader's language; the detail is what the route said
 * about the field it refused, which the headline cannot carry because one line covers every bad request.
 */
export interface WriteFailure {
  headline: string
  detail: string | null
}

/**
 * Where a form takes the refusal instead of getting a toast for it.
 *
 * Every write action used to report the failure itself and resolve with nothing, which left the caller
 * unable to tell a saved model from a refused one — the dialog closed, the toast appeared, and the draft
 * a reader had just typed was gone. The action now answers `true` or `false`, and a caller that prints the
 * reason above its own buttons hands this in so the failure is told once rather than twice.
 */
export type ReportFailure = (failure: WriteFailure) => void

function describeFailure(error: unknown, fallback = t('assistant.toast.failed')): WriteFailure {
  const headline = error instanceof ApiError || error instanceof Error ? error.message : fallback
  // The route's sentence repeats the headline whenever the code has no mapping of its own, and a line the
  // reader has just read above it is not a second fact about the same mistake.
  const said = error instanceof ApiError ? error.serverMessage : undefined
  return { headline, detail: said && said !== headline ? said : null }
}

function toast(error: unknown): void {
  const failure = describeFailure(error)
  useUi.getState().toast({
    title: failure.headline,
    // The route's line goes where a toast has a place for it. Added only when there is one, so a failure
    // with no field reason stays the single-line notice it has always been rather than gaining an empty row
    // under the headline — and a write the reader cannot retry in place is exactly the case that line was
    // written for, because nothing else about the refusal reaches them.
    ...(failure.detail ? { description: failure.detail } : {}),
    tone: 'danger',
  })
}

/**
 * The two lines of a failure as one, for the places that hold a single string instead of a headline and a
 * description: a stopped turn's bubble, a tool row's reason, a vendor listing that never arrived.
 *
 * These surfaces print one line and cannot be given two without changing what they are, so the route's
 * reason is joined to the app's headline rather than dropped — the same loss the toast had, in a place where
 * a reader is more likely to be stuck: a turn that was refused for the name of a model, or a call that will
 * not run again. What is joined here is text the deployment wrote, and every surface that shows it renders
 * it as a child node, so it arrives already bounded and plain from `routeApiError()`.
 */
function failureLine(error: unknown, fallback?: string): string {
  const failure = fallback === undefined ? describeFailure(error) : describeFailure(error, fallback)
  return failure.detail ? `${failure.headline} — ${failure.detail}` : failure.headline
}

/** The `name` `StreamDisconnectedError` in `./stream` sets on itself; kept as text for the reason below. */
const STREAM_DISCONNECTED_NAME = 'StreamDisconnectedError'

/**
 * Whether a failure is the reading loop's own news that the bytes stopped arriving.
 *
 * The test is on the error's `name` rather than `instanceof StreamDisconnectedError`, and that is not a
 * shortcut: `./stream` is mocked in eight test files whose factories hand back only the one function they
 * replace, and a mocked module answers a missing export by throwing. A value import of the class would have
 * failed those tests on their own unrelated assertions. `name` is what the class sets in its constructor for
 * exactly this, and it is the same test `lib/api` applies to a browser abort.
 */
function isStreamDisconnected(error: unknown): boolean {
  return error instanceof Error && error.name === STREAM_DISCONNECTED_NAME
}

/**
 * The line for an answer whose bytes stopped arriving, decided by the one fact that draws the control.
 *
 * A refusal has a reason: the route wrote one, and `failureLine` carries it. A stream whose bytes stopped
 * arriving has nothing — the browser hands over "Failed to fetch" or its own wording of a network error,
 * which names no part of this app, translates to no language, and reads as a bug report rather than as news
 * about the answer. So that case is answered from the catalog, and the catalog holds two answers, because
 * the two states a reader is ever left in differ in exactly one thing:
 *
 *  - the half answer is on the screen as the thread's newest stored row, which draws
 *    `assistant.chat.continue`: the sentence may tell the reader to press it;
 *  - it is not — the row has not been filed yet, nothing arrived, or the reader has stepped the row back to
 *    an older version, any of which leaves no control to press: the line says only that the connection
 *    dropped and this reply did not finish, and names no control and no kept part.
 *
 * `canContinue` is therefore not a copy preference but the render's own gate, and it is handed in by the
 * surface that draws the control, computed with the same `canContinueAnswer` the control is drawn with. The
 * two lines used to be chosen from different facts, which is how the sentence came to point at a button the
 * transcript had not drawn — the fourth instance of that class in this repo.
 */
export function streamInterruptedLine(canContinue: boolean): string {
  return canContinue ? t('assistant.chat.stream_disconnected') : t('assistant.chat.stream_interrupted')
}

/**
 * What a turn that ended with no further words says in its bubble.
 *
 * The neutral line, because this is the string that also reaches the surfaces that print `turn.error`
 * without knowing what the transcript is drawing — the editor's AI run and the assistant dock. The thread
 * itself asks for the line that matches its controls, from the fact recorded beside this: see
 * `streamInterruptedLine` and `LiveTurn.streamInterrupted`.
 */
function turnFailureLine(error: unknown): string {
  return isStreamDisconnected(error) ? t('assistant.chat.stream_interrupted') : failureLine(error)
}

/** One failure, one surface: the form that was handed the refusal is the one that says it. */
function reportFailure(error: unknown, report?: ReportFailure): void {
  if (report) report(describeFailure(error))
  else toast(error)
}

/** How often a popup is asked whether the reader has finished logging in, and how long to keep asking. */
const POPUP_POLL_MS = 700
const POPUP_WAIT_MS = 5 * 60 * 1000

/**
 * Resolves when the reader's provider has handed them back, or when they have plainly given up.
 *
 * The worker learns the outcome from the callback, so the popup itself carries no message back — and a page
 * on somebody else's origin is not allowed to post into this one anyway. What can be watched from here is
 * whether the tab is still open: closed means the reader saw an answer, either way, and the list is worth
 * reading again. The deadline is for the case where they never come back at all.
 */
function followedPopup(tab: Window): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      if (tab.closed || Date.now() - startedAt > POPUP_WAIT_MS) {
        window.clearInterval(timer)
        resolve()
      }
    }, POPUP_POLL_MS)
  })
}

/**
 * The budget for the chase `adoptThread` describes below: how often it reads, and how many reads it is
 * allowed before the answer is left as it is. The interval is what one read costs the network, so the
 * pair is chosen together — patient enough to span the worker filing the turn, cheap enough to sit
 * unnoticed behind a reader who has already moved on.
 */
const ADOPT_ATTEMPTS = 6
const ADOPT_POLL_MS = 400

/**
 * How long filing a conversation under a brand-new tag waits for the tag itself — see `attachNewTag`.
 * The pair is chosen with the same arithmetic as `ADOPT_*`: one read per wait, long enough to span the
 * POST the tag came from, short enough that a reader who moved on is not left with a pending write.
 */
const TAG_ROW_ATTEMPTS = 6
const TAG_ROW_POLL_MS = 200

/**
 * The words the reader watched arrive, put back into a stopped turn's stored row.
 *
 * The stored row is what a reopened thread reads, and the worker files it a moment after the reader
 * aborts the stream. A worker that files the cancelled answer from its last completed step writes an
 * empty row while the screen still shows a fragment, and adopting that row verbatim would erase words
 * the reader chose to keep. The fragment is filled into the row this device was watching — matched by
 * the turn's own message id — and only where the row arrived blank, so a worker that already saved the
 * half answer is still the one the thread trusts.
 */
function fillStoppedAnswer(messages: AssistantMessage[], turn: LiveTurn | null): AssistantMessage[] {
  const text = turn?.text
  const assistantId = turn?.assistantId
  if (!text || !assistantId) return messages
  const index = messages.findIndex((message) => message.id === assistantId)
  if (index < 0) return messages
  const row = messages[index]
  if (!row || row.role !== 'assistant' || row.content) return messages
  return messages.map((message, position) => (position === index ? { ...message, content: text } : message))
}

/** Drops a finished turn, and only the one the caller finished: a later send owns the screen now. */
function releaseTurn(token?: number): void {
  if (token === undefined) return
  useAssistant.setState((current) => (current.turn?.done && current.turn.token === token ? { turn: null } : current))
}

/**
 * The stored page, without throwing away the older turns the reader had already scrolled back to.
 *
 * A background read always asks for the newest page. Replacing the transcript with it would make every
 * "load earlier" the reader had done vanish the moment a reply was filed, and the thread would jump. So
 * anything on screen that is older than the page's own first row is kept, and rows the page carries are
 * the ones that win — they are the server's current copy of those turns.
 */
function mergeThreadPage(current: AssistantMessage[], page: AssistantMessage[]): AssistantMessage[] {
  if (!page.length) return current
  const oldest = page[0]!
  const keep = current.filter((message) => message.createdAt < oldest.createdAt && !page.some((entry) => entry.id === message.id))
  return [...keep, ...page]
}

/** One read of one thread, as the conversation route answers it. */
type ConversationRead = Awaited<ReturnType<typeof api.assistant.conversation>>

/**
 * The half answer a read leaves on the screen, in the one state this store holds it in.
 *
 * Every read of a thread answers for the thread it read, so this is called from each of them rather than
 * from one place that could go stale: opening a thread, the chase after a stream this tab broke, and the
 * watch that waits on a writer somewhere else. A turn the server still claims contributes nothing — the
 * words on that lease are arriving rather than lost, and the placeholder says so. Three call sites, one
 * rule about what may be shown as an interrupted answer.
 */
function interruptedDraft(read: ConversationRead): Pick<AssistantState, 'remotePartial' | 'remotePartialTruncated'> {
  if (read.streaming || !read.partialText) return { remotePartial: null, remotePartialTruncated: false }
  return { remotePartial: read.partialText, remotePartialTruncated: read.partialTruncated === true }
}

/**
 * Brings the saved thread on screen.
 *
 * A stopped turn is filed by the worker a moment after the reader aborts the stream, so the first read
 * can still show the answer as running; the bubble is dropped only once the stored copy is visible, or
 * the reply blinks out and reappears on the next open. `turn` is the live turn the caller is adopting,
 * and is the only turn this read is allowed to settle — every write below is either about that turn or
 * about the thread, never about whatever turn happens to be on screen now.
 *
 * A budget is a promise about how long the worker takes, and a broken connection is the case that breaks
 * it: the read may fail outright, or the run may still be going when the attempts run out. Neither is an
 * answer that has settled, so both leave the thread to `watchRemoteStream` below rather than ending here.
 */
async function adoptThread(conversationId: string, turn: LiveTurn | null): Promise<void> {
  for (let attempt = 0; attempt < ADOPT_ATTEMPTS; attempt++) {
    let detail
    try {
      detail = await api.assistant.conversation(conversationId)
    } catch {
      // The read went out over the same connection that just broke the turn, so this is the ordinary
      // failure rather than the surprising one. Returning here used to leave the bubble on screen with
      // nothing coming back for the row the worker is still going to file.
      handOffToRemoteWatch(conversationId, turn)
      return
    }
    // Another thread is on screen. This read is only worth anything to the thread the reader can see,
    // and the next open of this one reads it again for itself.
    if (useAssistant.getState().activeId !== conversationId) return
    useAssistant.setState({
      messages: fillStoppedAnswer(mergeThreadPage(useAssistant.getState().messages, detail.messages), turn),
      messagesReady: true,
      messagesError: null,
      // Merged rather than replaced: the rows this turn already had are still the reader's, and a
      // picture the assistant drew is a row the thread has never seen before this read.
      fileIndex: { ...useAssistant.getState().fileIndex, ...Object.fromEntries((detail.attachments ?? []).map((entry) => [entry.id, entry])) },
    })
    if (!detail.streaming) {
      useAssistant.setState({ remoteStreaming: false, ...interruptedDraft(detail) })
      releaseTurn(turn?.token)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, ADOPT_POLL_MS))
  }
  // The worker still claims the run after every attempt this side was willing to spend. Dropping the
  // turn here is what deleted the reader's half answer, on the chance that its row would be there the
  // next time they opened the thread.
  handOffToRemoteWatch(conversationId, turn)
}

/**
 * Leaves a thread the chase could not settle to the conversation's own watch.
 *
 * This is not a second mechanism: `watchRemoteStream` is what already asks an open thread whether a run
 * is going, on the same read, until the server says it is not. The point of routing both give-ups through
 * it is what they used to do — decide the answer is finished — without the evidence. The turn goes with
 * the watch so that the one read which finds its row is also the one that takes the bubble down.
 */
function handOffToRemoteWatch(conversationId: string, turn: LiveTurn | null): void {
  // A thread the reader has left is read again by the next open of it, the same rule the chase follows
  // above: nothing here may write into whatever is on screen now.
  if (useAssistant.getState().activeId !== conversationId) return
  useAssistant.setState({ remoteStreaming: true })
  watchRemoteStream(conversationId, turn)
}

/**
 * How often the open conversation asks whether another device is still writing into it.
 *
 * The server tells the client that a run is live, but not when it ends — there is no SSE reconnect or
 * subscription — so the one honest way to notice the other tab finishing is to ask again. The interval
 * is a read of a thread the reader is already looking at, which is cheap; a reader who is not looking
 * at it has no poll running at all.
 */
export const REMOTE_WATCH_POLL_MS = 2500

/**
 * How long that question is asked before the marker is treated as stale.
 *
 * `streaming` comes from the worker's run lease, which outlives a crashed tab by one lease and is
 * renewed only while a turn is really going. A marker still set after this long is either a very long
 * answer or a lease nobody is renewing; either way the reader has waited long enough that losing the
 * composer is the worse outcome, so the placeholder is cleared and the server's own claim is left to
 * refuse a second turn if one is genuinely running.
 */
export const REMOTE_WATCH_MAX_MS = 3 * 60 * 1000

interface RemoteWatch {
  conversationId: string
  startedAt: number
  timer: number
  /**
   * A turn this tab was watching when the watch began, if any.
   *
   * Only a stream that broke under its own turn hands one over: the ordinary watch is started by opening
   * a thread somebody else is writing, where there is no bubble of this tab's to settle. When there is
   * one, this read is the only thing that will ever say it is finished, so it is carried here.
   */
  turn: LiveTurn | null
}

let remoteWatch: RemoteWatch | null = null

/** Exported so a test can take the timer down with it, the way the persistence key is. */
export function stopRemoteStreamWatch(): void {
  if (!remoteWatch) return
  window.clearTimeout(remoteWatch.timer)
  remoteWatch = null
}

function scheduleRemotePoll(watch: RemoteWatch): void {
  watch.timer = window.setTimeout(() => void pollRemoteStream(watch), REMOTE_WATCH_POLL_MS)
}

/**
 * Reads a conversation until the turn another device started is over.
 *
 * The answer itself is never assembled here: the worker writes it, and this only swaps in the stored
 * rows once `streaming` turns false, which is the same read that opening the conversation would do.
 * When the read fails it is retried inside the same budget, because a poll that gives up on one bad
 * round trip would leave the placeholder exactly as stuck as it was before the poll existed.
 */
async function pollRemoteStream(watch: RemoteWatch): Promise<void> {
  if (remoteWatch !== watch) return
  if (useAssistant.getState().activeId !== watch.conversationId) {
    stopRemoteStreamWatch()
    return
  }
  let detail
  try {
    detail = await api.assistant.conversation(watch.conversationId)
  } catch {
    if (remoteWatch !== watch) return
    if (Date.now() - watch.startedAt >= REMOTE_WATCH_MAX_MS) {
      giveUpRemoteStream(watch)
      return
    }
    scheduleRemotePoll(watch)
    return
  }
  if (remoteWatch !== watch) return
  if (useAssistant.getState().activeId !== watch.conversationId) {
    stopRemoteStreamWatch()
    return
  }
  if (!detail.streaming) {
    stopRemoteStreamWatch()
    useAssistant.setState((current) => ({
      // The same two rules the chase applies: rows the reader had scrolled back to stay, and the words
      // this tab watched arrive are filled into a row the worker filed blank. Then, and not before, the
      // bubble goes — which is what keeps a turn that broke mid-stream from losing its own answer.
      messages: fillStoppedAnswer(mergeThreadPage(current.messages, detail.messages), watch.turn),
      messagesReady: true,
      messagesError: null,
      remoteStreaming: false,
      // The draft a claim is still carrying, if this read found one. A turn that finished filed its row and
      // let go of the claim, so this is null for the ordinary end of a watch; a writer that was killed
      // leaves the claim standing with the words it had written, and those are what the thread has to show
      // until the next turn takes them over into a row of their own.
      ...interruptedDraft(detail),
      fileIndex: { ...current.fileIndex, ...Object.fromEntries((detail.attachments ?? []).map((entry) => [entry.id, entry])) },
    }))
    // The bubble goes only once its own row is actually on screen. A thread that stops claiming a run
    // without ever filing this turn's row keeps the fragment the reader watched instead of taking it
    // down with the marker — and an ordinary watch, which carries no turn, matches nothing here and
    // leaves whatever is on screen alone, exactly as it did before.
    const assistantId = watch.turn?.assistantId
    if (assistantId && useAssistant.getState().messages.some((message) => message.id === assistantId)) {
      releaseTurn(watch.turn?.token)
    }
    void useAssistant.getState().loadConversations()
    return
  }
  if (Date.now() - watch.startedAt >= REMOTE_WATCH_MAX_MS) {
    giveUpRemoteStream(watch)
    return
  }
  scheduleRemotePoll(watch)
}

function giveUpRemoteStream(watch: RemoteWatch): void {
  if (remoteWatch !== watch) return
  stopRemoteStreamWatch()
  // The composer comes back rather than staying disabled on a marker nobody can confirm. Sending is
  // still safe: the worker refuses a second turn on a conversation it is really running.
  useAssistant.setState({ remoteStreaming: false })
  useUi.getState().toast({ title: t('assistant.chat.remote_streaming_lost'), tone: 'warning' })
}

/**
 * Starts asking an open thread whether its run is over.
 *
 * `turn` is only ever given by `handOffToRemoteWatch`: a stream that broke under a turn this tab was
 * watching has the watch settle that turn as well as the thread, so nothing that is on screen depends on
 * a chase that already ran out. Opening a conversation somebody else is writing carries nothing, because
 * the bubble on that screen belongs to a different turn.
 */
function watchRemoteStream(conversationId: string, turn: LiveTurn | null = null): void {
  stopRemoteStreamWatch()
  const watch: RemoteWatch = { conversationId, startedAt: Date.now(), timer: 0, turn }
  remoteWatch = watch
  scheduleRemotePoll(watch)
}

/**
 * The three choices that decide which conversations the list shows.
 *
 * They are this device's view of rows that live on the server, which is exactly what the notebook's own
 * panel state is, so they are kept the same way `../../store/ui.ts` keeps its `expandedFolders`: read
 * once when the store is built, validated per key, and written back by a debounced subscriber that
 * compares the serialised slice first. Without them a reload dropped the reader back to "All chats" with
 * the tab strip, the folder and the tag all reset — three things they had just set by hand.
 */
/** Exported so a test can read and clear exactly the entry this store owns. */
export const ASSISTANT_UI_STORAGE_KEY = IS_DEMO_MODE ? 'inkstone.demo.assistantUi' : 'inkstone.assistant.ui'

const PERSISTED_KEYS = ['listTab', 'folderFilter', 'projectFilter', 'tagFilter'] as const

/** An id is 26 characters today; the ceiling is what stops a hand-edited entry from growing the store. */
const MAX_FILTER_ID_CHARS = 128

type PersistedKey = typeof PERSISTED_KEYS[number]

const PERSISTED_DEFAULTS: Pick<AssistantState, PersistedKey> = {
  listTab: 'folders',
  folderFilter: 'all',
  projectFilter: 'all',
  tagFilter: null,
}

function persistedSlice(state: AssistantState): string {
  const out: Record<string, unknown> = {}
  for (const key of PERSISTED_KEYS) out[key] = state[key]
  return JSON.stringify(out)
}

/** A stored id, or null when the entry is not one: the shape is all that can be checked before the tree loads. */
function readFilterId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_FILTER_ID_CHARS) : null
}

function loadPersisted(): Partial<AssistantState> {
  try {
    const raw = localStorage.getItem(ASSISTANT_UI_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const value = parsed as Record<string, unknown>
    const out: Partial<AssistantState> = {}
    if (typeof value.listTab === 'string'
      && (CONVERSATION_LIST_TABS as readonly string[]).includes(value.listTab)) {
      out.listTab = value.listTab as ConversationListTab
    }
    // 'all' and 'none' are the two built-in picks and a folder id is an id: one read covers all three.
    const folder = readFilterId(value.folderFilter)
    if (folder) out.folderFilter = folder
    const project = readFilterId(value.projectFilter)
    if (project) out.projectFilter = project
    const tag = readFilterId(value.tagFilter)
    if (tag) out.tagFilter = tag
    return out
  }
  catch {
    // Best-effort: this is one device's view of a list, and the defaults are a working state, so a
    // unreadable or malformed entry costs the reader one click rather than the panel.
    return {}
  }
}

let persistTimer: number | undefined
let lastPersisted = ''

function schedulePersist(): void {
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    const serialized = persistedSlice(useAssistant.getState())
    if (serialized === lastPersisted) return
    try {
      localStorage.setItem(ASSISTANT_UI_STORAGE_KEY, serialized)
      lastPersisted = serialized
    }
    catch {
      // Best-effort again: a quota or a private-mode rejection leaves the in-memory filter working, and
      // the next change retries. The reader's own choice is not lost, only not remembered.
    }
  }, DEBOUNCE.persist)
}

type AttachmentSetter = (updater: (state: AssistantState) => Partial<AssistantState>) => void

/** The two senses a file can ask of a model, as the reader's own language names them. */
const SENSE_LABEL_KEYS: Record<AttachmentSense, Parameters<typeof t>[0]> = {
  audio: 'assistant.model.modality.audio',
  video: 'assistant.model.modality.video',
}

/**
 * Say which sense a model would have to be handed these bytes for.
 *
 * One function rather than a map each surface indexes by hand, because the queue now writes this sentence
 * into a row before the strip is asked to draw it: two surfaces, one wording, and no place for the two to
 * drift apart.
 *
 * It reads `AttachmentSense`, not `AssistantModelModality`: the sentence is about what the *file* asks for,
 * and a clip asks for a thing no model can be ticked for here any more.
 */
export function attachmentSenseLabel(sense: AttachmentSense): string {
  return t(SENSE_LABEL_KEYS[sense])
}

/**
 * The model these bytes would be handed to, in the two facts the attachment rules read off it.
 *
 * What the reader ticked, and which wire the model is actually called on. Both are needed and neither is
 * the same question: a tick on a model whose request format has no field for a recording is a promise
 * nobody keeps, and a wire with the field means nothing until the reader marks the model for it.
 */
export interface AttachmentTarget {
  /** What the reader calls this model, for the sentence that has to name it. */
  label: string
  modalities: readonly AssistantModelModality[]
  audioWire: boolean
}

/**
 * Which model the next turn would answer with, as an `AttachmentTarget`.
 *
 * Read off `activeModelId` because that is the one the composer sends with, and the provider is consulted
 * through `modelWire` — the same rule the worker builds its request from — so a model that follows its
 * provider's wire is judged on that wire here rather than on a guess.
 *
 * Filtered through `chatModels` for the same reason the worker's `loadModelAndProvider` answers `no_model`
 * for a disabled row: the question is which model *would* pick these bytes up, and one that is switched off
 * answers nothing.
 *
 * The gate judges the model that answers the main pane. Side panes are asked with the same attachment ids
 * and the worker decides what each side model can actually be shown, so one composer never promises a file
 * to a model it has not checked.
 */
export function attachmentTargetOf(
  models: readonly AssistantModel[],
  providers: readonly AssistantProvider[],
  activeModelId: string | null,
): AttachmentTarget | null {
  const model = chatModels(models).find((entry) => entry.id === activeModelId)
  if (!model) return null
  const provider = providers.find((entry) => entry.id === model.providerId) ?? null
  const protocol = provider ? modelWire(model, provider).protocol : model.protocol
  return {
    label: modelLabelOf(model),
    modalities: model.modalities,
    audioWire: protocol !== null && protocolCarriesAudio(protocol),
  }
}

/** The same question asked of the store as it stands, for the two actions that only ever have the store. */
export function attachmentTarget(): AttachmentTarget | null {
  const state = useAssistant.getState()
  return attachmentTargetOf(state.models, state.providers, state.settings?.activeModelId ?? null)
}

/**
 * Why these bytes cannot be read into a turn, or null when this model can.
 *
 * `attachmentModality` says what the file asks for; the target says whether the model the reader is
 * standing on can answer it. The answer is asked before anything is sent rather than after: knowing once
 * the file is already stored only explains the waste — the upload costs the reader storage, the wait costs
 * them a round trip, and nothing about the answer changes. So the queue refuses the file here, no byte
 * leaves the browser, and `send()`, which carries only `ready` attachments, never pays for a turn that
 * could not have read it. The row still says why in the same words, and still keeps its cross, because a
 * file the reader picked has to be takeable back out of the box.
 *
 * A clip is one refusal and a recording is four, and each of the four names the one fact that fails:
 * no model to answer (`activeModelId` unset or switched off), a wire with no field for the bytes, a model
 * nobody ticked, a container no provider decodes. Telling a reader "not supported" teaches them nothing,
 * and the file is not the thing they have to change in three of the four cases.
 *
 * The wire is asked before the tick, because the model editor draws the audio switch only on a wire that
 * honours it. A tick-first answer of "go tick the model" sent the reader to a control that is not there;
 * on a dead wire the wire is the only fact they can act on, whatever the stored tick says. The worker names
 * these same facts in its own lines for a file that arrives anyway (`attachments.ts`), off the same two
 * shared predicates — `protocolCarriesAudio` and `audioFormatFor` — not a second copy of this rule, and it
 * adds the two that are only known once the bytes are in front of it: the size ceiling and the window.
 */
export function unreadableAttachmentReason(mime: string, filename: string, target: AttachmentTarget | null): string | null {
  const sense = attachmentModality(mime, filename)
  if (!sense) return null
  if (sense === 'video') return t('assistant.attach.unreadable', { kind: attachmentSenseLabel(sense), name: filename })
  if (!target) return t('assistant.attach.no_audio_target', { name: filename })
  if (!target.audioWire) return t('assistant.attach.no_audio_wire', { model: target.label, name: filename })
  if (!target.modalities.includes('audio')) {
    return t('assistant.attach.no_audio_switch', { model: target.label, name: filename })
  }
  if (!audioFormatFor(mime, filename)) return t('assistant.attach.no_audio_format', { name: filename })
  return null
}

/**
 * Whether these bytes are worth uploading at all — the model's four reasons, then the size ceiling.
 *
 * A recording bigger than `AUDIO_SEND_MAX_BYTES` reaches the worker and is named there with a line saying it
 * was not sent, which is honest but late: the reader waited for a five-megabyte upload and paid to store a
 * file no turn would read, and the answer was always going to be the same. So the queue asks the ceiling it
 * asks the model, off the constant the request builder itself compares against — `@shared/assistant`, one
 * copy of the number, never a client-side second opinion of it.
 *
 * Only a recording is weighed. A text file's bytes are read out of storage into the prompt and a picture has
 * its own ceiling that the composer does not pre-check, so pointing this one at either would refuse files the
 * turn really does read.
 *
 * The model is asked first: on a wire with no field for audio the reason the reader can act on is the wire,
 * and shrinking the file would not have helped.
 */
export function attachmentUploadRefusal(
  mime: string,
  filename: string,
  size: number,
  target: AttachmentTarget | null,
): string | null {
  const reason = unreadableAttachmentReason(mime, filename, target)
  if (reason) return reason
  if (attachmentModality(mime, filename) === 'audio' && size > AUDIO_SEND_MAX_BYTES) {
    return t('assistant.attach.audio_too_large', {
      name: filename,
      size: formatBytes(size),
      max: formatBytes(AUDIO_SEND_MAX_BYTES),
    })
  }
  return null
}

/**
 * Send one pending file, and record where it got to.
 *
 * Shared by the first attempt and by the retry: a second code path for "upload again" is how the two
 * drift, and the failure branch here is the one that already knows how to say what went wrong.
 */
async function uploadAttachment(localId: string, file: File, set: AttachmentSetter): Promise<void> {
  try {
    // A PDF's words are read here, in the browser, because the worker has no parser: the text rides
    // along with the bytes so the model is shown the contents on every later turn too.
    const extractedText = isPdfFile(file) ? await extractPdfText(file) : ''
    const stored = await api.assistant.uploadChatFile(file, (sent, total) => {
      const progress = total > 0 ? sent / total : 0
      set((current) => ({
        pending: current.pending.map((entry) => (entry.localId === localId ? { ...entry, progress } : entry)),
      }))
    }, extractedText || undefined)
    set((current) => ({
      pending: current.pending.map((entry) => (
        entry.localId === localId
          ? { ...entry, id: stored.id, progress: 1, status: 'ready' as const, filename: stored.filename, mime: stored.mime, kind: stored.kind, error: undefined }
          : entry
      )),
      fileIndex: { ...current.fileIndex, [stored.id]: stored },
    }))
  } catch (error) {
    const reason = failureLine(error, String(error))
    set((current) => ({
      pending: current.pending.map((entry) => (
        entry.localId === localId ? { ...entry, status: 'error' as const, error: reason } : entry
      )),
    }))
    useUi.getState().toast({ title: t('assistant.attach.failed'), description: reason, tone: 'danger' })
  }
}

/**
 * How many turns of one thread the transcript on screen is allowed to hold.
 *
 * The arithmetic, in the two numbers this app already states: a page is `MESSAGE_PAGE_SIZE` (60,
 * `@shared/assistant`) and the conversation route clamps `limit` to 500 (`src/worker/routes/assistant.ts`
 * `pageSize(..., MESSAGE_PAGE_SIZE, 500)`). 8 × 60 = 480 is the largest whole number of pages that fits
 * under that ceiling, so a page the reader asks for is never trimmed by the route and the count never
 * drifts past a limit that lives in another layer. Opening a thread is one page and every press of
 * "load earlier" adds exactly one more — the dedupe can only take rows out, never widen a page — so 480
 * is reached and not overshot. Eight presses is a screenful of scrolling many times over, while a list
 * with no ceiling let twenty presses put 1,200 rendered bubbles in the DOM for a reader who arrived at
 * the thread from its newest turn.
 *
 * Stopping is not the same as the thread stopping: `messagesHasMore` keeps whatever the server answered,
 * so the transcript goes on naming the older turns it does not hold, and the control that cannot fetch
 * them says why instead of disappearing.
 */
export const MAX_LOADED_MESSAGES = MESSAGE_PAGE_SIZE * 8

export const useAssistant = create<AssistantState>()((set, get) => ({
  view: 'chat',
  loaded: false,
  loading: false,
  error: null,

  conversations: [],
  conversationPicks: null,
  conversationsCursor: null,
  conversationsHasMore: false,
  conversationsLoadingMore: false,
  conversationQuery: '',
  ...PERSISTED_DEFAULTS,
  ...loadPersisted(),
  folderNodes: [],
  unfiledCount: 0,
  projectNodes: [],
  unfiledProjectCount: 0,
  tagNodes: [],
  webSearch: false,
  noteContextOn: true,
  subscriptionContext: null,
  dockSurface: 'notebook',
  folderContextOn: true,
  canvasContextOn: true,
  todoContext: null,
  todoContextOn: true,
  emailContext: null,
  emailContextOn: true,
  navContext: null,
  navContextOn: true,
  databaseContext: null,
  databaseContextOn: true,
  musicContext: null,
  musicContextOn: true,
  inknoteContext: null,
  inknoteContextOn: true,
  composerSeed: null,
  pending: [],
  skills: [],
  turnTools: [],
  turnScopes: [],
  fileIndex: {},
  flagged: { starred: [], pinned: [], archived: [] },
  activeId: null,
  messages: [],
  messagesReady: false,
  messagesError: null,
  messagesBefore: null,
  messagesHasMore: false,
  messagesLoadingMore: false,
  messagesHasNewer: false,
  focusMessageId: null,
  answerVersions: {},
  remoteStreaming: false,
  remotePartial: null,
  remotePartialTruncated: false,
  turn: null,
  artifacts: [],
  artifactsReady: false,
  artifactVersions: {},
  canvasOpen: false,
  activeArtifactId: null,
  ephemeral: false,

  memories: [],
  memoryCounts: { active: 0, historical: 0, review: 0 },
  memoryTotal: 0,
  memoryQuery: '',
  memoryStatus: 'all',
  memoryCategory: '',
  reviews: [],

  tasks: [],
  projects: [],

  automations: [],
  runs: [],

  notifications: [],
  unread: 0,

  settings: null,
  providers: [],
  models: [],
  mcpServers: [],
  mcpProblems: [],
  mcpCatalog: [],
  mcpCatalogLoading: false,
  vendorModels: [],
  vendorModelsError: null,
  vendorModelsLoading: false,

  setView: (view) => set({ view }),

  bootstrap: async (force = false) => {
    if (get().loaded && !force) return
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const [settings, conversations] = await Promise.all([
        api.assistant.settings(),
        // The everyday list leaves archived conversations out; the archive tab is where they are read.
        api.assistant.conversations({ archived: '0' }),
      ])
      set({
        settings: settings.settings,
        models: settings.models,
        conversations: conversations.conversations,
        view: get().loaded ? get().view : settings.settings.startView,
        loaded: true,
        loading: false,
      })
      const active = get().activeId
      if (active) await get().openConversation(active)
      else await get().openConversation(conversations.conversations[0]?.id ?? null)
      void get().loadProviders()
      void get().loadNotifications()
      // The composer’s / picker lists the reader’s own MCP tools, so they have to be known before the
      // first slash is typed — otherwise the picker shows only the built-ins until settings are opened.
      void get().loadMcp()
    } catch (error) {
      set({ loading: false, error: failureLine(error) })
      toast(error)
    }
  },

  loadProviders: async () => {
    try {
      const result = await api.assistant.providers()
      set({ providers: result.providers })
    } catch (error) {
      toast(error)
    }
  },

  loadConversations: async () => {
    const token = ++conversationRequest
    try {
      const state = get()
      const query = state.conversationQuery.trim()
      const params: { q?: string, folder?: string, project?: string, tag?: string, archived?: string, limit?: string } = {}
      if (query) params.q = query
      if (state.folderFilter !== 'all') params.folder = state.folderFilter
      if (state.projectFilter !== 'all') params.project = state.projectFilter
      if (state.tagFilter) params.tag = state.tagFilter
      // Always sent, so no view of this list ever shows a conversation the reader has put away.
      params.archived = '0'
      params.limit = String(CONVERSATION_PAGE_SIZE)
      const result = await api.assistant.conversations(params)
      if (token !== conversationRequest) return
      set({
        conversations: result.conversations,
        conversationsCursor: result.nextCursor,
        conversationsHasMore: result.nextCursor !== null,
        conversationsLoadingMore: false,
      })
    } catch (error) {
      if (token !== conversationRequest) return
      set({ conversationsLoadingMore: false })
      toast(error)
    }
  },

  startPickingConversations: (id) => set({ conversationPicks: new Set(id ? [id] : []) }),

  toggleConversationPick: (id) => set((state) => {
    if (!state.conversationPicks) return state
    const next = new Set(state.conversationPicks)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return { conversationPicks: next }
  }),

  cancelConversationPicks: () => set({ conversationPicks: null }),

  archivePickedConversations: async () => {
    const picks = get().conversationPicks
    if (!picks?.size) return
    try {
      // One request per row, because the route files one conversation at a time; a reader picking a
      // handful is the case this exists for, and a batch endpoint would be a second way to do the same.
      for (const id of picks) await api.assistant.setConversationArchived(id, true)
      set({ conversationPicks: null })
      await get().loadConversations()
      await get().loadFlagged()
    } catch (error) {
      toast(error)
    }
  },

  deletePickedConversations: async () => {
    const picks = get().conversationPicks
    if (!picks?.size) return
    try {
      for (const id of picks) await api.assistant.deleteConversation(id)
      const active = get().activeId
      set({ conversationPicks: null })
      if (active && picks.has(active)) get().newConversation()
      await get().loadConversations()
      await get().loadFlagged()
    } catch (error) {
      toast(error)
    }
  },

  loadMoreConversations: async () => {
    const state = get()
    // One page at a time: the scroll handler fires on every frame near the bottom, and a second request
    // would append the same page twice.
    if (!state.conversationsHasMore || state.conversationsLoadingMore || !state.conversationsCursor) return
    const token = conversationRequest
    set({ conversationsLoadingMore: true })
    try {
      const params: { q?: string, folder?: string, project?: string, tag?: string, archived?: string, limit?: string, cursor?: string } = {
        archived: '0',
        limit: String(CONVERSATION_PAGE_SIZE),
        cursor: state.conversationsCursor,
      }
      const query = state.conversationQuery.trim()
      if (query) params.q = query
      if (state.folderFilter !== 'all') params.folder = state.folderFilter
      if (state.projectFilter !== 'all') params.project = state.projectFilter
      if (state.tagFilter) params.tag = state.tagFilter
      const result = await api.assistant.conversations(params)
      // A filter change or a fresh load happened while this page was in flight; its rows belong to the
      // list the reader has already left.
      if (token !== conversationRequest) return
      const seen = new Set(get().conversations.map((entry) => entry.id))
      set({
        conversations: [...get().conversations, ...result.conversations.filter((entry) => !seen.has(entry.id))],
        conversationsCursor: result.nextCursor,
        conversationsHasMore: result.nextCursor !== null,
        conversationsLoadingMore: false,
      })
    } catch (error) {
      set({ conversationsLoadingMore: false })
      toast(error)
    }
  },

  loadMcp: async () => {
    set({ mcpCatalogLoading: true })
    try {
      const [servers, listing] = await Promise.all([api.assistant.mcpServers(), api.assistant.mcpTools()])
      set({ mcpServers: servers.servers, mcpCatalog: listing.servers, mcpProblems: listing.problems })
    } catch (error) {
      toast(error)
    } finally {
      set({ mcpCatalogLoading: false })
    }
  },

  addMcpServer: async (body, report) => {
    try {
      await api.assistant.createMcpServer(body)
      await get().loadMcp()
      return true
    } catch (error) {
      reportFailure(error, report)
      return false
    }
  },

  patchMcpServer: async (id, body, report) => {
    try {
      await api.assistant.patchMcpServer(id, body)
      await get().loadMcp()
      return true
    } catch (error) {
      reportFailure(error, report)
      return false
    }
  },

  setMcpToolModes: async (server, modes) => {
    // The server's own answer is the default, so a tool set back to it is not an exception and is dropped:
    // that is what keeps the map a list of the tools the reader actually disagreed about, and what makes
    // "follow the server again" reachable without a fourth option on every row.
    const next: Record<string, AssistantMcpToolMode> = { ...server.toolModes }
    for (const [remoteName, mode] of Object.entries(modes)) {
      if (mode === server.toolMode) delete next[remoteName]
      else next[remoteName] = mode
    }
    await get().patchMcpServer(server.id, { toolModes: next })
  },

  removeMcpServer: async (id) => {
    try {
      await api.assistant.removeMcpServer(id)
      await get().loadMcp()
    } catch (error) {
      toast(error)
    }
  },

  /**
   * Send the reader through the third party's own login, and come back when they have.
   *
   * The address is opened as a popup rather than navigated to: this screen holds a form somebody may be
   * half way through typing, and a page that leaves to log in and returns to nothing is the oldest complaint
   * about this kind of flow. When the popup closes the list is read again, because the answer to "did it
   * work" is on the server and nowhere else.
   */
  authorizeMcp: async (id) => {
    try {
      const { url } = await api.assistant.authorizeMcpServer(id)
      const tab = window.open(url, 'inkstone-mcp-oauth', 'popup=yes,width=520,height=720')
      if (!tab) {
        // Blocked, not failed: the reader's provider never saw them. Saying where the address went would
        // be a second way to leak a state parameter, so the answer is simply to allow the popup.
        useUi.getState().toast({ title: t('assistant.mcp.authorize_blocked'), tone: 'danger' })
        return false
      }
      await followedPopup(tab)
      await get().loadMcp()
      return true
    } catch (error) {
      toast(error)
      return false
    }
  },

  revokeMcp: async (id) => {
    try {
      await api.assistant.revokeMcpServer(id)
      await get().loadMcp()
    } catch (error) {
      toast(error)
    }
  },

  revokeMcpClient: async (id) => {
    try {
      const { revokedAtIssuer } = await api.assistant.revokeMcpClient(id)
      await get().loadMcp()
      // The difference between the two outcomes is not a failure: a client the reader registered by hand has
      // nothing at the far end to delete, and saying "withdrawn here only" is the honest answer.
      useUi.getState().toast({
        title: t(revokedAtIssuer ? 'assistant.mcp.client_revoked' : 'assistant.mcp.client_revoked_local'),
        tone: revokedAtIssuer ? 'success' : 'default',
      })
      return revokedAtIssuer
    } catch (error) {
      toast(error)
      return false
    }
  },

  loadMcpServers: async () => {
    try {
      const { servers } = await api.assistant.mcpServers()
      set({ mcpServers: servers })
    } catch (error) {
      // Naming whose call a past chip was is decoration: a thread has to open whether or not this lands.
      console.warn('[inkstone] the MCP server list could not be read', error)
    }
  },

  replayMcpTool: async (conversationId, messageId, toolId) => {
    try {
      return await api.assistant.replayMcpTool(conversationId, messageId, toolId)
    } catch (error) {
      return { ok: false, error: failureLine(error, String(error)), result: '' }
    }
  },

  loadMcpServer: async (id) => {
    try {
      return await api.assistant.mcpServer(id)
    } catch (error) {
      toast(error)
      return null
    }
  },

  testMcpServer: async (id, headers) => {
    try {
      const result = await api.assistant.testMcpServer(id, headers)
      await get().loadMcp()
      return { ok: result.ok, error: result.error, count: result.tools.length }
    } catch (error) {
      return { ok: false, error: failureLine(error, String(error)), count: 0 }
    }
  },

  loadAnswerVersions: async (messageId) => {
    const cached = get().answerVersions[messageId]
    if (cached) return cached
    const conversationId = get().activeId
    if (!conversationId) return []
    try {
      const { versions } = await api.assistant.answerVersions(conversationId, messageId)
      set((current) => ({ answerVersions: { ...current.answerVersions, [messageId]: versions } }))
      return versions
    } catch (error) {
      toast(error)
      return []
    }
  },

  activateAnswerVersion: async (messageId, versionId) => {
    const conversationId = get().activeId
    if (!conversationId) return
    try {
      const { message } = await api.assistant.activateAnswerVersion(conversationId, messageId, versionId)
      // The turn's own row changed, and the list of histories has to be re-read: what was live is now
      // filed, and the entry the reader just chose is the one that is not.
      set((current) => ({
        messages: current.messages.map((entry) => (entry.id === message.id ? message : entry)),
        answerVersions: { ...current.answerVersions, [messageId]: undefined },
      }))
      void get().loadAnswerVersions(messageId)
    } catch (error) {
      toast(error)
    }
  },

  editMessage: async (messageId, content, options) => {
    const conversationId = get().activeId
    if (!conversationId) return
    try {
      const title = get().conversations.find((entry) => entry.id === conversationId)?.title || t('assistant.chat.untitled')
      // The suffix is named here for the same reason the fork action names it here: a title is interface
      // copy, and the worker carries no catalog.
      const result = await api.assistant.editMessage(conversationId, messageId, content, options?.keepBranch
        ? `${title}${t('assistant.chat.fork_suffix')}`.slice(0, 200)
        : undefined)
      await get().openConversation(conversationId)
      await get().loadConversations()
      if (result.branch) {
        useUi.getState().toast({ title: t('assistant.chat.branch_kept', { title: result.branch.title }), tone: 'success' })
      } else if (result.removed > 0) {
        // The dialog says the turns below go; this says how many actually did, which is the difference
        // between a warning and a receipt.
        useUi.getState().toast({ title: t('assistant.chat.edit_removed', { count: result.removed }) })
      }
      await get().send('', { retry: true })
    } catch (error) {
      toast(error)
    }
  },

  removeMessage: async (messageId) => {
    const conversationId = get().activeId
    if (!conversationId) return
    try {
      // The rows the server kept come back with the answer, so the thread is re-read from what is
      // actually stored rather than from a guess about which rows the pair covered.
      const { messages } = await api.assistant.removeMessage(conversationId, messageId)
      set({ messages, answerVersions: {} })
    } catch (error) {
      toast(error)
    }
  },

  rateAnswer: async (messageId, feedback) => {
    const state = get()
    const conversationId = state.activeId
    const current = state.messages.find((message) => message.id === messageId)?.feedback
    // Pressing the same thumb again takes the verdict back, which is what a reader expects a toggle to
    // do — and the only way to undo a mis-press without a dialog.
    const next = current === feedback ? null : feedback
    // Painted before the round trip: a verdict is the reader's opinion, not the server's, and the row is
    // put back where it was if the write is refused.
    const paint = (value: MessageFeedback | undefined) => set((s) => ({
      messages: s.messages.map((message) => {
        if (message.id !== messageId) return message
        const { feedback: _dropped, ...rest } = message
        return value ? { ...rest, feedback: value } : rest
      }),
    }))
    paint(next ?? undefined)
    if (!conversationId) return
    try {
      const { message } = await api.assistant.rateAnswer(conversationId, messageId, next)
      paint(message.feedback)
    } catch (error) {
      paint(current)
      toast(error)
    }
  },

  toggleMessageSaved: async (messageId, report) => {
    const state = get()
    // The thread the row lives on is read from the row itself rather than from whatever is open: the shelf
    // takes a keep off a turn in another conversation, and `activeId` there names the wrong thread.
    const conversationId = state.messages.find((message) => message.id === messageId)?.conversationId ?? state.activeId
    if (!conversationId) return false
    try {
      const answer = await api.assistant.setMessageSaved(conversationId, messageId)
      // After the await, and from the server's number: the row on screen is made to agree with the row in
      // the account, which is what lets the press be a toggle the reader can trust from either side.
      set((current) => ({
        messages: current.messages.map((message) => (message.id === messageId ? { ...message, savedAt: answer.savedAt } : message)),
      }))
      return true
    } catch (error) {
      reportFailure(error, report)
      return false
    }
  },

  forkFrom: async (messageId) => {
    const state = get()
    const conversationId = state.activeId
    if (!conversationId) return
    const source = state.conversations.find((entry) => entry.id === conversationId)
    // The suffix is named here rather than on the server because a conversation's name is interface copy
    // and the worker carries no catalog — the same reason the fork route takes the title as an argument.
    const title = `${source?.title || t('assistant.chat.untitled')}${t('assistant.chat.fork_suffix')}`
    try {
      const { conversation } = await api.assistant.forkConversation(conversationId, messageId, title.slice(0, 200))
      await get().loadConversations()
      await get().openConversation(conversation.id)
      useUi.getState().toast({ title: t('assistant.chat.forked', { title: conversation.title }), tone: 'success' })
    } catch (error) {
      toast(error)
    }
  },

  removeMessages: async (ids) => {
    const conversationId = get().activeId
    if (!conversationId || !ids.length) return
    try {
      const { messages } = await api.assistant.deleteMessages(conversationId, ids)
      set({ messages, answerVersions: {} })
    } catch (error) {
      toast(error)
    }
  },

  setConversationQuery: async (query) => {
    set({ conversationQuery: query })
    await get().loadConversations()
  },

  loadTaxonomy: async () => {
    try {
      const [folders, tags, projects] = await Promise.all([
        api.assistant.conversationFolders(),
        api.assistant.conversationTags(),
        api.assistant.conversationProjects(),
      ])
      set({
        folderNodes: folders.folders,
        unfiledCount: folders.unfiled,
        tagNodes: tags.tags,
        projectNodes: projects.projects,
        unfiledProjectCount: projects.unfiled,
      })
      // A filter restored from this device can name a row that is gone — deleted, or merged away on
      // another machine. Left alone it answers "no conversations" forever, with no row in the picker
      // left to click it off, so a choice the real tree no longer offers is dropped as soon as the
      // tree is known.
      const state = get()
      if (state.folderFilter !== 'all' && state.folderFilter !== 'none'
        && !folders.folders.some((node) => node.id === state.folderFilter)) await state.setFolderFilter('all')
      if (state.projectFilter !== 'all' && state.projectFilter !== 'none'
        && !projects.projects.some((node) => node.id === state.projectFilter)) await state.setProjectFilter('all')
      if (state.tagFilter && !tags.tags.some((tag) => tag.id === state.tagFilter)) await state.setTagFilter(null)
    } catch (error) {
      toast(error)
    }
  },

  setFolderFilter: async (value) => {
    set({ folderFilter: value })
    await get().loadConversations()
  },

  setProjectFilter: async (value) => {
    set({ projectFilter: value })
    await get().loadConversations()
  },

  setTagFilter: async (tagId) => {
    set({ tagFilter: tagId })
    await get().loadConversations()
  },

  setListTab: async (tab) => {
    set({ listTab: tab })
    if (tab === 'starred' || tab === 'pinned' || tab === 'archived') await get().loadFlagged()
  },

  loadFlagged: async () => {
    try {
      const [starred, pinned, archived] = await Promise.all([
        api.assistant.conversations({ starred: '1', archived: '0' }),
        api.assistant.conversations({ pinned: '1', archived: '0' }),
        api.assistant.conversations({ archived: '1' }),
      ])
      set({ flagged: { starred: starred.conversations, pinned: pinned.conversations, archived: archived.conversations } })
    } catch (error) {
      toast(error)
    }
  },

  archiveConversation: async (id, archived) => {
    try {
      await api.assistant.setConversationArchived(id, archived)
      await get().loadConversations()
      // The tab the reader is looking at has to lose the row too, or it goes on offering something that
      // has just been filed away — and the other shortlists may have gained one.
      await get().loadFlagged()
    } catch (error) {
      toast(error)
    }
  },

  moveConversation: async (id, folderId) => {
    try {
      await api.assistant.moveConversation(id, folderId)
      await get().loadConversations()
      await get().loadTaxonomy()
    } catch (error) {
      toast(error)
    }
  },

  setConversationProject: async (id, projectId) => {
    try {
      await api.assistant.setConversationProject(id, projectId)
      await get().loadConversations()
    } catch (error) {
      toast(error)
    }
  },

  setConversationNote: async (id, noteId) => {
    try {
      await api.assistant.setConversationNote(id, noteId)
      await get().loadConversations()
    } catch (error) {
      toast(error)
    }
  },

  toggleConversationTag: async (id, tagId, on) => {
    try {
      if (on) await api.assistant.addConversationTag(id, tagId)
      else await api.assistant.removeConversationTag(id, tagId)
      await get().loadConversations()
      await get().loadTaxonomy()
    } catch (error) {
      toast(error)
    }
  },

  attachNewTag: async (id, tagId) => {
    for (let attempt = 0; attempt < TAG_ROW_ATTEMPTS; attempt++) {
      await get().loadTaxonomy()
      if (get().tagNodes.some((tag) => tag.id === tagId)) {
        await get().toggleConversationTag(id, tagId, true)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, TAG_ROW_POLL_MS))
    }
    // The row never came back. `createTag` has already said so if the server refused it; this is the
    // case where it is simply not there yet, and the label did not reach the conversation.
    useUi.getState().toast({ title: t('assistant.toast.failed'), tone: 'danger' })
  },

  openConversation: async (id, options) => {
    const state = get()
    const turn = state.turn
    // A reply still arriving belongs to its own conversation: navigating away keeps the request going
    // and drops only the view of it. What keeps the stream honest is the token on its turn — its events
    // find no turn to write to here, so they cannot land in the thread the reader moved to.
    if (turn && !turn.done && turn.conversationId !== id) set({ turn: null })
    // A remote marker belongs to the conversation it was read from; asking again below is what starts a
    // new watch when this thread has one too.
    stopRemoteStreamWatch()
    const focus = options?.focusMessageId ?? null
    // A muted chip is this thread's correction, not a setting: the next thread starts from the pointer.
    // The panel starts closed on every thread and shows no draft until that thread's own read lands.
    set({ activeId: id, messages: [], messagesReady: false, messagesError: null, remoteStreaming: false, remotePartial: null, remotePartialTruncated: false, noteContextOn: true, folderContextOn: true, canvasContextOn: true, todoContextOn: true, emailContextOn: true, navContextOn: true, databaseContextOn: true, musicContextOn: true, inknoteContextOn: true, artifacts: [], artifactsReady: false, artifactVersions: {}, canvasOpen: false, activeArtifactId: null, ephemeral: false, messagesBefore: null, messagesHasMore: false, messagesLoadingMore: false, messagesHasNewer: false, focusMessageId: focus })
    if (!id) {
      set({ messagesReady: true, messagesError: null, artifactsReady: true })
      return
    }
    void get().loadArtifacts()
    try {
      const detail = await api.assistant.conversation(id, focus
        ? { limit: String(MESSAGE_PAGE_SIZE), upto: focus }
        : { limit: String(MESSAGE_PAGE_SIZE) })
      if (get().activeId !== id) return
      // The server says whether a turn is being written somewhere else. A local turn for this very
      // conversation is not "remote" — it is the one on screen — but anything else is a reply this tab
      // can only watch, so it gets the placeholder and the poll that clears it when the writer finishes.
      const local = get().turn
      const remote = detail.streaming && !(local && !local.done && local.conversationId === id)
      set({
        messages: detail.messages,
        fileIndex: Object.fromEntries((detail.attachments ?? []).map((entry) => [entry.id, entry])),
        messagesReady: true,
        messagesError: null,
        messagesBefore: detail.nextBefore,
        messagesHasMore: detail.hasMore === true,
        messagesHasNewer: detail.hasNewer === true,
        remoteStreaming: remote,
        // Read from the row rather than from the list, which never carries a temporary conversation.
        ephemeral: detail.conversation.ephemeral === true,
        ...interruptedDraft(detail),
      })
      if (remote) watchRemoteStream(id)
    } catch (error) {
      if (get().activeId !== id) return
      // The banner's own headline comes from the catalog, so what belongs in this field is the reason the
      // route gave — and only that. Storing the translated sentence here (which is what it used to hold)
      // made the view's detail compare equal to the headline and drop itself, so the refusal that survived
      // in the toast was still missing from the one surface that stays on screen. With no reason to carry,
      // the generic sentence comes back and the detail line disappears as it should.
      set({ messagesReady: true, messagesError: describeFailure(error).detail ?? t('assistant.chat.load_failed') })
      toast(error)
    }
  },

  clearFocusMessage: () => set({ focusMessageId: null }),

  loadEarlierMessages: async () => {
    const state = get()
    const conversationId = state.activeId
    if (!conversationId || !state.messagesHasMore || state.messagesLoadingMore || !state.messagesBefore) return
    // The ceiling is about how much this tab keeps on screen, not about what the thread holds, so nothing
    // here touches `messagesHasMore`: a reader stopped at the limit still has older turns above the list,
    // and the page they are on is not the conversation. The view presents the control as unavailable and
    // says the reason; this is the same rule enforced where the fetch actually happens, because the find
    // panel and any other caller reach the store rather than the button.
    if (state.messages.length >= MAX_LOADED_MESSAGES) return
    set({ messagesLoadingMore: true })
    try {
      const detail = await api.assistant.conversation(conversationId, {
        limit: String(MESSAGE_PAGE_SIZE),
        before: state.messagesBefore,
      })
      // The reader may have moved to another thread while this page was in flight.
      if (get().activeId !== conversationId) {
        set({ messagesLoadingMore: false })
        return
      }
      const current = get().messages
      const seen = new Set(current.map((message) => message.id))
      set({
        messages: [...detail.messages.filter((message) => !seen.has(message.id)), ...current],
        fileIndex: { ...get().fileIndex, ...Object.fromEntries((detail.attachments ?? []).map((entry) => [entry.id, entry])) },
        messagesBefore: detail.nextBefore,
        messagesHasMore: detail.hasMore === true,
        messagesLoadingMore: false,
      })
    } catch (error) {
      set({ messagesLoadingMore: false })
      toast(error)
    }
  },

  newConversation: () => {
    const live = get().turn
    if (live && !live.done) return
    stopRemoteStreamWatch()
    // The pins go with the thread they were added to. They are "this turn's" by definition — the row the
    // composer draws is the record of what this question was asked about — so a new conversation that
    // inherited them would answer a question nobody asked, in a folder nobody named.
    set({ activeId: null, messages: [], messagesReady: true, messagesError: null, remoteStreaming: false, remotePartial: null, remotePartialTruncated: false, turn: null, noteContextOn: true, folderContextOn: true, canvasContextOn: true, todoContextOn: true, emailContextOn: true, navContextOn: true, databaseContextOn: true, musicContextOn: true, inknoteContextOn: true, artifacts: [], artifactsReady: true, artifactVersions: {}, canvasOpen: false, activeArtifactId: null, ephemeral: false, turnTools: [], turnScopes: [] })
  },

  /**
   * Start a thread the reader asked not to keep.
   *
   * The conversation is made by the first turn rather than here, so it is created with the flag and with a
   * title taken from what was asked — the same path every other new conversation takes.
   */
  startTemporaryConversation: () => {
    const live = get().turn
    if (live && !live.done) return
    stopRemoteStreamWatch()
    set({ activeId: null, messages: [], messagesReady: true, messagesError: null, remoteStreaming: false, remotePartial: null, remotePartialTruncated: false, turn: null, noteContextOn: true, folderContextOn: true, canvasContextOn: true, todoContextOn: true, emailContextOn: true, navContextOn: true, databaseContextOn: true, musicContextOn: true, inknoteContextOn: true, artifacts: [], artifactsReady: true, artifactVersions: {}, canvasOpen: false, activeArtifactId: null, ephemeral: true })
  },

  attachFiles: async (files) => {
    const room = MAX_CHAT_ATTACHMENTS - get().pending.length
    if (room <= 0) {
      useUi.getState().toast({ title: t('assistant.attach.too_many', { count: MAX_CHAT_ATTACHMENTS }), tone: 'danger' })
      return
    }
    // Files that do not fit are named rather than silently dropped: a folder picked as a whole can hold
    // more than the box does, and "only some of them appeared" is otherwise indistinguishable from a bug.
    if (files.length > room) {
      useUi.getState().toast({ title: t('assistant.attach.dropped', { count: files.length - room, max: MAX_CHAT_ATTACHMENTS }), tone: 'warning' })
    }
    for (const file of files.slice(0, room)) {
      const localId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const kind = file.type.startsWith('image/') ? 'image' : 'file'
      const filename = file.name || 'file'
      // Refused before the request, not explained after it: no door into this function respects the
      // pickers' `accept` filter — a drag and a paste both hand over whatever the reader had, and a file
      // dialog lets them widen the type themselves — so the question has to be asked here, where all three
      // arrive. Nothing is uploaded, and the row carries the reason instead of the bytes.
      const refused = attachmentUploadRefusal(file.type, filename, file.size, attachmentTarget())
      if (refused) {
        set((current) => ({
          pending: [...current.pending, {
            localId, id: '', filename, mime: file.type, size: file.size, kind, progress: 0, status: 'error' as const, error: refused, sourceFile: file,
          }],
        }))
        continue
      }
      set((current) => ({
        pending: [...current.pending, {
          localId, id: '', filename, mime: file.type, size: file.size, kind, progress: 0, status: 'uploading', sourceFile: file,
        }],
      }))
      await uploadAttachment(localId, file, set)
    }
  },

  /**
   * Try a failed upload again, with the file the browser still has.
   *
   * The row keeps its place and its name, so a flaky connection costs one press rather than re-picking
   * the file and losing which one failed. A row the gate turned away is asked the same question again
   * rather than refused on sight: the answer is about the model on screen, so a recording refused under
   * one model uploads after the reader ticks audio or switches to a wire that carries it. What stays
   * refused is what no press can change — a clip, a container nothing decodes, and the case where there
   * is still no model to answer — and the strip hides the press for all of them, while this keeps the
   * other doors honest.
   */
  retryAttachment: async (localId) => {
    const entry = get().pending.find((item) => item.localId === localId)
    if (!entry?.sourceFile || entry.status === 'uploading') return
    const refused = attachmentUploadRefusal(entry.mime, entry.filename, entry.sourceFile.size, attachmentTarget())
    if (refused) {
      set((current) => ({
        pending: current.pending.map((item) => (
          item.localId === localId ? { ...item, status: 'error' as const, progress: 0, error: refused } : item
        )),
      }))
      return
    }
    set((current) => ({
      pending: current.pending.map((item) => (
        item.localId === localId ? { ...item, status: 'uploading' as const, progress: 0, error: undefined } : item
      )),
    }))
    await uploadAttachment(localId, entry.sourceFile, set)
  },

  attachUrl: async (url) => {
    const trimmed = url.trim()
    if (!trimmed) return
    if (get().pending.length >= MAX_CHAT_ATTACHMENTS) {
      useUi.getState().toast({ title: t('assistant.attach.too_many', { count: MAX_CHAT_ATTACHMENTS }), tone: 'danger' })
      return
    }
    try {
      const stored = await api.assistant.addChatFileFromUrl(trimmed)
      set((current) => ({
        pending: [...current.pending, {
          localId: stored.attachment.id,
          id: stored.attachment.id,
          filename: stored.attachment.filename,
          mime: stored.attachment.mime,
          size: stored.attachment.size,
          kind: stored.attachment.kind,
          progress: 1,
          status: 'ready' as const,
        }],
        fileIndex: { ...current.fileIndex, [stored.attachment.id]: stored.attachment },
      }))
    } catch (error) {
      useUi.getState().toast({ title: t('assistant.attach.failed'), description: failureLine(error, String(error)), tone: 'danger' })
    }
  },

  /**
   * A long paste becomes a file rather than a wall of text.
   *
   * The reader pasted it because it is context, not because they want to scroll past it for the next
   * three turns; as an attachment it is read once, quoted by name, and stays out of the way.
   */
  attachPastedText: async (text) => {
    if (text.trim().length < PASTE_FILE_MIN_CHARS) return false
    const file = new File([text], `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.txt`, { type: 'text/plain' })
    await get().attachFiles([file])
    return true
  },

  dropAttachment: async (localId) => {
    const entry = get().pending.find((item) => item.localId === localId)
    set((current) => ({ pending: current.pending.filter((item) => item.localId !== localId) }))
    // Best-effort release of the uploaded copy. The reader asked for the attachment out of the draft and
    // the draft no longer holds it, which is the outcome they can see and act on; a failed server-side
    // delete leaves a file this conversation will never reference again, and there is no retry a reader
    // could be offered for an object they have already removed. Reporting it would say "could not
    // remove" about a removal that did happen.
    if (entry?.id) await api.assistant.deleteChatFile(entry.id).catch(() => undefined)
  },

  clearAttachments: () => {
    set({ pending: [] })
  },

  loadSkills: async (query) => {
    try {
      const { skills } = await api.assistant.skills(query)
      set({ skills })
    } catch (error) {
      toast(error)
    }
  },

  createSkill: async (input) => {
    try {
      const { skill } = await api.assistant.createSkill(input)
      set((state) => ({ skills: [skill, ...state.skills] }))
      return skill
    } catch (error) {
      toast(error)
      return null
    }
  },

  saveSkill: async (id, input) => {
    try {
      const { skill } = await api.assistant.updateSkill(id, input)
      set((state) => ({ skills: state.skills.map((entry) => (entry.id === id ? skill : entry)) }))
    } catch (error) {
      toast(error)
    }
  },

  removeSkill: async (id) => {
    set((state) => ({ skills: state.skills.filter((entry) => entry.id !== id) }))
    try {
      await api.assistant.removeSkill(id)
    } catch (error) {
      toast(error)
    }
  },

  exportSkills: async () => {
    try {
      const { bundle } = await api.assistant.exportSkills()
      downloadSkillBundle(bundle)
    } catch (error) {
      toast(error)
    }
  },

  importSkills: async (entries) => {
    try {
      return await api.assistant.importSkills(entries)
    } catch (error) {
      toast(error)
      return null
    }
  },

  applySkill: (skill) => {
    // The pins a skill names replace this turn's rather than joining them: the two rows of chips, and the
    // model chip beside them, then say exactly what the skill promised, which is the point of saving one.
    set({ turnTools: [...skill.tools].slice(0, MAX_TURN_TOOLS), turnScopes: [...skill.scopes].slice(0, MAX_TURN_SCOPES) })
    if (skill.modelId && skill.modelId !== get().settings?.activeModelId) void get().activateModel(skill.modelId)
  },

  addTurnTool: (name) => set((current) => (current.turnTools.includes(name)
    ? current
    : { turnTools: [...current.turnTools, name].slice(0, MAX_TURN_TOOLS) })),

  dropTurnTool: (name) => set((current) => ({ turnTools: current.turnTools.filter((entry) => entry !== name) })),

  addTurnScope: (scope) => set((current) => (current.turnScopes.some((entry) => entry.id === scope.id)
    ? current
    : { turnScopes: [...current.turnScopes, scope].slice(0, MAX_TURN_SCOPES) })),

  dropTurnScope: (id) => set((current) => ({ turnScopes: current.turnScopes.filter((entry) => entry.id !== id) })),

  setWebSearch: (value) => set({ webSearch: value }),

  /**
   * Arming, or unarming, the comparison for this thread.
   *
   * Switching it off drops the second model too: the pair is one decision, and a remembered half of it
   * would be there waiting for the next time the reader turns the switch on.
   */
  setNoteContext: (on) => set({ noteContextOn: on }),
  setSubscriptionContext: (value) => set({ subscriptionContext: value }),
  setDockSurface: (surface) => set({ dockSurface: surface }),
  setTodoContext: (value) => set({ todoContext: value }),
  setTodoContextOn: (on) => set({ todoContextOn: on }),
  setEmailContext: (value) => set({ emailContext: value }),
  setEmailContextOn: (on) => set({ emailContextOn: on }),
  setNavContext: (value) => set({ navContext: value }),
  setNavContextOn: (on) => set({ navContextOn: on }),
  setDatabaseContext: (value) => set({ databaseContext: value }),
  setDatabaseContextOn: (on) => set({ databaseContextOn: on }),
  setMusicContext: (value) => set({ musicContext: value }),
  setMusicContextOn: (on) => set({ musicContextOn: on }),
  setInknoteContext: (value) => set({ inknoteContext: value }),
  setInknoteContextOn: (on) => set({ inknoteContextOn: on }),
  setFolderContext: (on) => set({ folderContextOn: on }),

  setCanvasContext: (on) => set({ canvasContextOn: on }),

  seedComposer: (text) => set({ composerSeed: text }),

  clearComposerSeed: () => set({ composerSeed: null }),

  send: async (text, opts = {}) => {
    const state = get()
    if (state.turn && !state.turn.done) return false
    const conversationId = state.activeId
    const retry = opts.retry === true
    // A continued answer has nothing to send: the question is already in the thread and the reader is
    // asking the model to finish what it started.
    const continuing = opts.continue === true && !retry
    const attached = retry || continuing ? [] : state.pending.filter((entry) => entry.status === 'ready' && entry.id).map((entry) => entry.id)
    if (!retry && !continuing && !text.trim() && !attached.length) return false
    if (!retry && !continuing && state.pending.some((entry) => entry.status === 'uploading')) {
      useUi.getState().toast({ title: t('assistant.attach.waiting'), tone: 'danger' })
      return false
    }
    const token = ++turnSeq
    const controller = new AbortController()
    inflight.set(token, controller)
    // This turn is now the one the screen owns; a reply another device was writing is no longer the
    // thing the reader is waiting for, and the poller would keep replacing the messages under it.
    stopRemoteStreamWatch()
    // The draft becomes the turn's, and is handed back by the finally below if the request never
    // reached the worker — the reader should not have to upload again because the network refused.
    const draft = { pending: state.pending, turnTools: state.turnTools, turnScopes: state.turnScopes }
    set({
      turn: {
        token,
        conversationId,
        userText: retry || continuing ? '' : text.trim(),
        attachments: retry || continuing ? [] : attached,
        assistantId: null,
        text: '',
        reasoning: '',
        tools: [],
        stage: 'waiting',
        error: null,
        done: false,
        startedAt: Date.now(),
        usage: null,
        finishedAt: null,
      },
      remoteStreaming: false,
      // This send is the turn that takes a dead claim over, and the worker files the fragment it held as
      // the unfinished answer of the turn that died. Leaving the draft here too would show one half answer
      // twice — once on the screen and once, shortly, in the thread it was written for.
      remotePartial: null,
      remotePartialTruncated: false,
      ...(retry || continuing ? {} : { pending: [], turnTools: [], turnScopes: [] }),
    })

    // Where the worker filed this turn: known from the first frame when this send is the one that made
    // the conversation, and from the reader's own thread id when it already existed.
    let filedConversationId = conversationId
    // False until a frame arrives. A stream that threw before its first frame is a request the worker
    // never took, which is the one case where the draft is still the reader's.
    let accepted = false
    const apply = (event: ChatStreamEvent) => {
      if (event.type !== 'title') accepted = true
      if (event.type === 'start' && event.conversationId) filedConversationId = event.conversationId
      // A draft arrives whole rather than as deltas: the tool writes a row and the row is what the
      // panel draws. It belongs to the turn that asked for it, so the same token check the other frames
      // use applies here before anything touches the list.
      if (event.type === 'artifact' && event.artifact) {
        const incoming = event.artifact
        const currentTurn = get().turn
        if (!currentTurn || currentTurn.token !== token) return
        if (incoming.conversationId !== (currentTurn.conversationId ?? get().activeId)) return
        const wasOpen = get().canvasOpen && get().activeArtifactId === incoming.id
        set((current) => {
          const known = current.artifacts.some((entry) => entry.id === incoming.id)
          const artifacts = known
            ? current.artifacts.map((entry) => (entry.id === incoming.id ? incoming : entry))
            : [incoming, ...current.artifacts]
          return event.change === 'created'
            ? { artifacts, artifactsReady: true, canvasOpen: true, activeArtifactId: incoming.id, canvasContextOn: true }
            : { artifacts, artifactsReady: true }
        })
        // An update to a panel the reader is not looking at would otherwise land silently. Creating one
        // opens the panel, because that is what the reader asked the model to do.
        if (event.change !== 'created' && !wasOpen) {
          useUi.getState().toast({
            title: t('assistant.canvas.updated', { title: incoming.title || t('assistant.canvas.untitled') }),
          })
        }
        return
      }
      set((current) => {
        const turn = current.turn
        // An event belongs to the turn that asked for it. After the reader leaves the conversation and
        // starts another turn, this stream's token is no longer the one on screen, and writing into it
        // is exactly how one thread's words used to appear in another.
        if (!turn || turn.token !== token) return current
        switch (event.type) {
          case 'start':
            return {
              turn: {
                ...turn,
                conversationId: event.conversationId ?? turn.conversationId,
                assistantId: event.assistantMessageId ?? null,
                runToken: event.runToken ?? turn.runToken,
              },
              activeId: current.activeId ?? event.conversationId ?? null,
            }
          case 'text':
            return { turn: { ...turn, text: turn.text + (event.delta ?? ''), stage: undefined } }
          case 'reasoning':
            return { turn: { ...turn, reasoning: turn.reasoning + (event.delta ?? '') } }
          case 'stage':
            return { turn: { ...turn, stage: event.stage } }
          case 'usage':
            // Kept so the answer's column can say what this turn spent. A second `usage` frame from a
            // multi-step turn replaces the first, which is the number the worker last reported.
            return { turn: { ...turn, usage: event.usage ?? turn.usage } }
          case 'tool': {
            const incoming = event.tool
            if (!incoming) return current
            const known = turn.tools.some((tool) => tool.id === incoming.id)
            return {
              turn: {
                ...turn,
                tools: known
                  ? turn.tools.map((tool) => (tool.id === incoming.id ? incoming : tool))
                  : [...turn.tools, incoming],
              },
            }
          }
          case 'notice':
            // Something the reader asked for that this turn could not do — said out loud rather than
            // left to look like it worked.
            if (event.notice === 'web_search_unavailable') {
              useUi.getState().toast({ title: t('assistant.search.unavailable'), tone: 'warning' })
            }
            return current
          case 'mcp_problem':
            // A server the reader added did not answer. The turn still proceeds without its
            // tools, so this is said out loud rather than swallowed.
            useUi.getState().toast({ title: t('assistant.mcp.problem', { server: event.server ?? '', error: event.error ?? '' }), tone: 'warning' })
            return current
          case 'error':
            return { turn: { ...turn, error: event.message ?? null } }
          case 'done':
            return {
              turn: {
                ...turn,
                done: true,
                // The final row is the worker's own record of where the answer really ended. A stopped
                // turn's last step never completed, and a worker that merges the fragment before filing
                // it says here what it kept — which is at least what arrived. When it says nothing, the
                // fragment on screen stays: it is what the reader chose not to throw away.
                text: event.finalMessage?.role === 'assistant' && event.finalMessage.content
                  ? event.finalMessage.content
                  : turn.text,
                // The pages this turn's search consulted live on the row, not on any frame, so this is the
                // one moment the bubble on screen can be given them.
                sources: event.finalMessage?.sources ?? turn.sources,
              },
            }
          default:
            return current
        }
      })
      if (event.type === 'title') {
        // The follow-ups are the answer's own, so they are written onto the row they arrived for rather
        // than fetched with the whole thread again: a reader may already be typing the next question into
        // this one, and a reload would take the loaded page and their place in it away from under them.
        const messageId = event.assistantMessageId
        const incoming = event.suggestions ?? []
        if (messageId && incoming.length) {
          set((current) => {
            const index = current.messages.findIndex((message) => message.id === messageId)
            const row = current.messages[index]
            if (index < 0 || !row || row.role !== 'assistant') return current
            return { messages: current.messages.map((message, position) => (position === index ? { ...message, suggestions: incoming } : message)) }
          })
        }
        void get().loadConversations()
      }
      // An approved artifact write runs outside the stream (the card replayed it), so no artifact frame
      // arrived for it. Reading the list once the turn closes is the fallback that keeps a write made
      // through an approval from being invisible until the next reload. A cancelled run can also have
      // written a draft after its chip was shown but before it could be settled, so the tool name is
      // enough to ask again.
      if (event.type === 'done') {
        const tools = get().turn?.tools ?? []
        if (tools.some((tool) => tool.artifactId) || tools.some((tool) => tool.name === 'create_artifact' || tool.name === 'update_artifact')) {
          void get().loadArtifacts()
        }
      }
    }

    // What the reader had on screen when they asked. The notebook's own pointer is the only thing that
    // makes "summarise this" work without naming the note, and it costs two ids on the wire.
    const ui = useUi.getState()
    const originNoteId = state.turnScopes.find((scope) => scope.kind === 'note')?.id ?? ui.activeNoteId
    try {
      await streamAssistantTurn(
        {
          ...(conversationId ? { conversationId } : {}),
          message: text,
          attachments: attached,
          tools: state.turnTools,
          scopes: state.turnScopes,
          ...(retry || continuing ? {} : {
            ...(state.dockSurface === 'notebook' && state.noteContextOn && ui.activeNoteId ? { contextNoteId: ui.activeNoteId } : {}),
            ...(state.dockSurface === 'notebook' && state.folderContextOn && ui.folderId ? { contextFolderId: ui.folderId } : {}),
            // Named by id, not by title: two plans can share a name, and the reader pointed at one of them.
            ...(state.subscriptionContext ? { contextSubscriptionId: state.subscriptionContext.id } : {}),
            // The canvas chip is the visible half of this: a draft the reader can see on screen but
            // cannot see in the context row is one they cannot take back off the next question.
            ...(state.canvasOpen && state.canvasContextOn && state.activeArtifactId ? { activeArtifactId: state.activeArtifactId } : {}),
            ...(opts?.activeArtifactId ? { activeArtifactId: opts.activeArtifactId } : {}),
            // The to-do chip is the same promise one app over: what the reader sees beside the dock is
            // what the turn may read, and taking it off leaves the list on screen unsent.
            ...(state.dockSurface === 'todos' && state.todoContextOn && state.todoContext ? { contextTodo: state.todoContext } : {}),
            ...(state.dockSurface === 'email' && state.emailContextOn && state.emailContext ? { contextEmail: state.emailContext } : {}),
            ...(state.dockSurface === 'nav' && state.navContextOn && state.navContext ? { contextNav: state.navContext } : {}),
            ...(state.dockSurface === 'database' && state.databaseContextOn && state.databaseContext ? { contextDatabase: state.databaseContext } : {}),
            ...(state.dockSurface === 'music' && state.musicContextOn && state.musicContext ? { contextMusic: state.musicContext } : {}),
            // The hand-written note chip: the worker re-reads the id and replaces the title from its row.
            ...(state.dockSurface === 'inknote' && state.inknoteContextOn && state.inknoteContext ? { contextInknote: state.inknoteContext } : {}),
            // Where this thread began. The worker records it once and never re-labels the thread, so a
            // later turn asked beside another note leaves the origin alone.
            //
            // The note the reader aimed "chat about this" at is the answer; the page that happens to be
            // open afterwards is not. `startChatAboutNote` pins exactly one note scope on a fresh thread,
            // so that chip is the record of the request, and the open page stays the fallback for a thread
            // begun beside a note without the command.
            ...(state.dockSurface === 'notebook' && originNoteId ? { noteId: originNoteId } : {}),
          }),
          webSearch: state.webSearch,
          ...(opts?.modelId ? { modelId: opts.modelId } : {}),
          ...(opts?.noTools ? { noTools: true } : {}),
          // Only when this turn is the one that makes the conversation: the flag is read at creation and
          // never again, because the promise is about the whole thread.
          ...(state.ephemeral && !conversationId ? { ephemeral: true } : {}),
          retry,
          // Only a retry reads this: the answer to ask again, when it is not the newest one.
          ...(retry && opts.messageId ? { messageId: opts.messageId } : {}),
          ...(continuing ? { continueTurn: true } : {}),
        },
        apply,
        controller.signal,
      )
    } catch (error) {
      if (!controller.signal.aborted) {
        // The line and the fact are written together: the line is the one that is true whatever the thread
        // is drawing, and the fact is what lets the thread ask for the promise it can actually keep.
        const interrupted = isStreamDisconnected(error)
        set((current) => (current.turn?.token === token
          ? {
            turn: {
              ...current.turn,
              error: turnFailureLine(error),
              streamInterrupted: interrupted,
              done: true,
            },
          }
          : current))
      }
    } finally {
      inflight.delete(token)
      // Only the turn this request started may be settled here. A later send owns the screen after a
      // stop or a change of conversation, and its token is what tells the two apart.
      const mine = get().turn?.token === token ? get().turn : null
      if (mine) {
        const finished: LiveTurn = { ...mine, done: true, finishedAt: Date.now() }
        set({ turn: finished })
        // A turn that never reached the worker has no stored row to adopt; the draft comes back instead.
        if (accepted && filedConversationId) await adoptThread(filedConversationId, finished)
      } else if (accepted && filedConversationId) {
        // A stream whose turn left the screen while it was running: the thread is all that can be
        // updated now, and only if the reader happens to be looking at it.
        await adoptThread(filedConversationId, null)
      }
      if (!accepted && !(retry || continuing)) {
        // The turn was not accepted — the request was refused, or Stop was pressed before the worker's
        // first frame, which is the same outcome for the reader: the draft is still theirs. The words are
        // the composer's half of the same promise, and a newer turn owns the screen, which is what the
        // token says.
        set((current) => (current.turn?.token === token
          ? { pending: draft.pending, turnTools: draft.turnTools, turnScopes: draft.turnScopes }
          : current))
      }
      void get().loadConversations()
      void get().refreshAfterTurn()
    }
    return accepted
  },

  refreshAfterTurn: async () => {
    const state = get()
    if (state.view === 'memory') await state.loadMemories()
    if (state.view === 'automations') await state.loadAutomations()
  },


  stop: () => {
    const turn = get().turn
    const token = turn?.token
    // Only the turn on screen is stopped. A reply still running for a conversation the reader left is
    // not what this press is about, and aborting it from here would end an answer they are still owed.
    if (token !== undefined) inflight.get(token)?.abort()
    set((current) => (current.turn && current.turn.token === token ? { turn: { ...current.turn, done: true } } : current))
    // A remote marker has no local handle; the cancel below is what ends the turn another device owns.
    const conversationId = turn?.conversationId ?? get().activeId
    // Best-effort notice to the worker. Stop is carried out here first — the request is aborted and the
    // turn is marked done — so what a failed cancel leaves behind is an upstream still writing into a
    // thread the reader has already closed the stream on, which is discarded either way. A toast would
    // tell the reader the stop failed when the answer did stop appearing.
    if (conversationId) void api.assistant.cancel(conversationId, turn?.runToken).catch(() => {})
  },

  renameConversation: async (id, title) => {
    try {
      await api.assistant.renameConversation(id, title)
      await get().loadConversations()
    } catch (error) {
      toast(error)
    }
  },

  pinConversation: async (id, pinned) => {
    try {
      await api.assistant.pinConversation(id, pinned)
      await get().loadConversations()
      await get().loadFlagged()
    } catch (error) {
      toast(error)
    }
  },

  starConversation: async (id, starred) => {
    try {
      await api.assistant.starConversation(id, starred)
      await get().loadConversations()
      await get().loadFlagged()
    } catch (error) {
      toast(error)
    }
  },

  deleteConversation: async (id) => {
    try {
      await api.assistant.deleteConversation(id)
      if (get().activeId === id) {
        stopRemoteStreamWatch()
        set({ activeId: null, messages: [], turn: null, artifacts: [], artifactsReady: true, artifactVersions: {}, canvasOpen: false, activeArtifactId: null, ephemeral: false })
      }
      await get().loadConversations()
    } catch (error) {
      toast(error)
    }
  },

  setCanvasOpen: (open) => set({ canvasOpen: open }),

  selectArtifact: (id) => set({ activeArtifactId: id, ...(id ? { canvasContextOn: true } : {}) }),

  loadArtifacts: async () => {
    const conversationId = get().activeId
    if (!conversationId) {
      set({ artifacts: [], artifactsReady: true })
      return
    }
    try {
      const { artifacts } = await api.assistant.conversationArtifacts(conversationId)
      // The reader may have switched threads while the read was in flight.
      if (get().activeId !== conversationId) return
      set({ artifacts, artifactsReady: true })
    } catch (error) {
      if (get().activeId !== conversationId) return
      set({ artifactsReady: true })
      toast(error)
    }
  },

  loadArtifactVersions: async (artifactId) => {
    const conversationId = get().activeId
    if (!conversationId) return
    const { versions } = await api.assistant.conversationArtifactVersions(conversationId, artifactId)
    // The reader may have switched threads while the read was in flight.
    if (get().activeId !== conversationId) return
    set((current) => ({ artifactVersions: { ...current.artifactVersions, [artifactId]: versions } }))
  },

  readArtifactVersion: async (artifactId, versionId) => {
    const conversationId = get().activeId
    if (!conversationId) throw new Error('No conversation is open.')
    const { version } = await api.assistant.conversationArtifactVersion(conversationId, artifactId, versionId)
    return version
  },

  restoreArtifactVersion: async (artifactId, versionId) => {
    const conversationId = get().activeId
    if (!conversationId) throw new Error('No conversation is open.')
    const { artifact } = await api.assistant.restoreConversationArtifact(conversationId, artifactId, versionId)
    set((current) => ({
      artifacts: current.artifacts.map((entry) => (entry.id === artifact.id ? artifact : entry)),
      // The head is new, so the list the history was showing is stale. It is read again when opened;
      // fetching it now would race the modal the reader is about to close.
      artifactVersions: { ...current.artifactVersions, [artifactId]: undefined },
    }))
    return artifact
  },

  createArtifactFromReply: async (text) => {
    const conversationId = get().activeId
    if (!conversationId) {
      // A draft hangs off a thread, so a reply can only be kept once one exists to hold it.
      useUi.getState().toast({ title: t('assistant.canvas.need_conversation'), tone: 'warning' })
      return
    }
    try {
      const { artifact } = await api.assistant.createConversationArtifact(conversationId, {
        // The reply's own opening line, so the panel's list reads as documents and not as timestamps.
        title: leadingProse(text).slice(0, MAX_ARTIFACT_TITLE_CHARS),
        content: text.slice(0, MAX_ARTIFACT_CONTENT_CHARS),
      })
      set((current) => ({
        artifacts: [artifact, ...current.artifacts],
        artifactsReady: true,
        canvasOpen: true,
        activeArtifactId: artifact.id,
        canvasContextOn: true,
      }))
    } catch (error) {
      toast(error)
    }
  },

  createDraft: async () => {
    try {
      let conversationId = get().activeId
      if (!conversationId) {
        const { conversation } = await api.assistant.createConversation()
        await get().openConversation(conversation.id)
        conversationId = conversation.id
      }
      const { artifact } = await api.assistant.createConversationArtifact(conversationId, { title: '', content: '' })
      set((current) => ({
        artifacts: [artifact, ...current.artifacts.filter((entry) => entry.id !== artifact.id)],
        artifactsReady: true,
        canvasOpen: true,
        activeArtifactId: artifact.id,
        canvasContextOn: true,
      }))
    } catch (error) {
      toast(error)
    }
  },

  saveArtifact: async (id, patch, options) => {
    const conversationId = get().activeId
    if (!conversationId) throw new Error('No conversation is open.')
    // The error is deliberately not toasted here: the panel owns the save line and the conflict banner,
    // and a toast that said the same thing in a corner would outlive the text it is about.
    const { artifact } = await api.assistant.updateConversationArtifact(conversationId, id, { ...patch, ...options })
    set((current) => ({ artifacts: current.artifacts.map((entry) => (entry.id === id ? artifact : entry)) }))
    return artifact
  },

  removeArtifact: async (id) => {
    const conversationId = get().activeId
    if (!conversationId) return
    try {
      await api.assistant.removeConversationArtifact(conversationId, id)
      set((current) => ({
        artifacts: current.artifacts.filter((entry) => entry.id !== id),
        // The panel falls back to its list when the draft it was showing is gone.
        activeArtifactId: current.activeArtifactId === id ? null : current.activeArtifactId,
      }))
    } catch (error) {
      toast(error)
    }
  },

  decideAction: async (actionId, approve) => {
    try {
      const action = approve
        ? await api.assistant.approveAction(actionId)
        : await api.assistant.declineAction(actionId)
      // An approved call may have answered with something: that answer is what the reader opens the row
      // to see, so it travels back with the card's own outcome. A cancelled call never ran and has none.
      const settle = (tool: ToolActivity) => (tool.approval?.id === actionId && action.action
        ? { ...tool, approval: action.action, ...(action.result ? { result: action.result } : {}) }
        : tool)
      // Only the row that carries this action is replaced. Mapping every message into a fresh object —
      // which is what this did — handed the whole transcript a new identity for one press: `MessageRow`
      // compares `message` by reference (ChatView's memo), so a hundred stored turns re-rendered and
      // re-parsed their Markdown because the reader approved a call in one of them.
      set((current) => ({
        messages: current.messages.map((message) => (
          message.tools.some((tool) => tool.approval?.id === actionId)
            ? { ...message, tools: message.tools.map(settle) }
            : message
        )),
        turn: current.turn
          ? { ...current.turn, tools: current.turn.tools.map(settle) }
          : current.turn,
      }))
      const view = get().view
      if (view === 'memory') await get().loadMemories()
      if (view === 'automations') await get().loadAutomations()
      if (view === 'skills') await get().loadSkills()
      // An approved write replayed outside the turn: there is no artifact frame to read, so the list is
      // asked again rather than left showing the version before the approval.
      if (approve) await get().loadArtifacts()
      // An approval runs after the turn has closed, so a surface that mirrors the tool's target (the
      // database Studio's schema tree) has no other frame to hear about it. The event names the tool and
      // nothing else: the page decides what in it needs re-reading.
      if (approve && action.action?.tool && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('inkstone:assistant-tool', { detail: { tool: action.action.tool } }))
      }
    } catch (error) {
      toast(error)
    }
  },

  loadMemories: async () => {
    const { memoryQuery, memoryStatus, memoryCategory } = get()
    try {
      const [list, reviews] = await Promise.all([
        api.assistant.memories({
          ...(memoryQuery.trim() ? { q: memoryQuery.trim() } : {}),
          status: memoryStatus,
          ...(memoryCategory ? { category: memoryCategory } : {}),
        }),
        api.assistant.reviews(),
      ])
      set({
        memories: list.memories,
        memoryTotal: list.total,
        memoryCounts: list.counts,
        reviews: reviews.reviews,
      })
    } catch (error) {
      toast(error)
    }
  },

  setMemoryFilter: async (patch) => {
    set({
      ...(patch.query !== undefined ? { memoryQuery: patch.query } : {}),
      ...(patch.status !== undefined ? { memoryStatus: patch.status } : {}),
      ...(patch.category !== undefined ? { memoryCategory: patch.category } : {}),
    })
    await get().loadMemories()
  },

  addMemory: async (content, category) => {
    try {
      const result = await api.assistant.createMemory(content, category)
      describeMemoryWrite(result)
      await get().loadMemories()
    } catch (error) {
      toast(error)
    }
  },

  editMemory: async (id, content, category) => {
    try {
      const result = await api.assistant.updateMemory(id, { content, category })
      describeMemoryWrite(result)
      await get().loadMemories()
    } catch (error) {
      toast(error)
    }
  },

  correctMemory: async (id, content) => {
    try {
      const result = await api.assistant.correctMemory(id, content)
      describeMemoryWrite(result)
      await get().loadMemories()
    } catch (error) {
      toast(error)
    }
  },

  setMemoryStatus: async (id, status) => {
    try {
      await api.assistant.memoryStatus(id, status)
      await get().loadMemories()
    } catch (error) {
      toast(error)
    }
  },

  saveMemoryAsNote: async (id, folderId, title) => {
    const memory = get().memories.find((entry) => entry.id === id)
    if (!memory) return null
    try {
      // The note is made here rather than by the assistant's tools: the reader is choosing a folder and a
      // title in a dialog, and the notes module is what owns creating a note. The server is then told
      // which note this memory became, which is the half that survives a reload.
      const note = await api.notes.create({
        title: title.trim().slice(0, 300) || memory.content.slice(0, 120),
        content: memory.content,
        folderId,
      })
      const { memory: updated } = await api.assistant.memoryNote(id, note.id)
      set((state) => ({
        memories: state.memories.map((entry) => (entry.id === id ? updated : entry)),
      }))
      // The vault's own list is stale until it hears about the new note, and the reader is about to be
      // sent to it.
      void useNotes.getState().openNote(note.id)
      return note.id
    } catch (error) {
      toast(error)
      return null
    }
  },

  removeMemory: async (id) => {
    try {
      await api.assistant.deleteMemory(id)
      await get().loadMemories()
    } catch (error) {
      toast(error)
    }
  },

  resolveReview: async (id, action) => {
    try {
      await api.assistant.resolveReview(id, action)
      await get().loadMemories()
    } catch (error) {
      toast(error)
    }
  },

  loadProjects: async () => {
    try {
      const result = await api.assistant.projects()
      set({ projects: result.projects })
    } catch (error) {
      toast(error)
    }
  },

  addProject: async (name) => {
    try {
      await api.assistant.createProject({ name })
      await get().loadProjects()
    } catch (error) {
      toast(error)
    }
  },

  removeProject: async (id) => {
    try {
      await api.assistant.deleteProject(id)
      await get().loadProjects()
    } catch (error) {
      toast(error)
    }
  },

  loadAutomations: async () => {
    try {
      const result = await api.assistant.automations()
      set({ automations: result.automations, runs: result.runs })
    } catch (error) {
      toast(error)
    }
  },

  addAutomation: async (body) => {
    try {
      await api.assistant.createAutomation(body)
      await get().loadAutomations()
      return true
    } catch (error) {
      toast(error)
      return false
    }
  },

  toggleAutomation: async (automation) => {
    try {
      await api.assistant.updateAutomation(automation.id, { enabled: !automation.enabled })
      await get().loadAutomations()
    } catch (error) {
      toast(error)
    }
  },

  updateAutomation: async (id, body) => {
    try {
      await api.assistant.updateAutomation(id, body)
      await get().loadAutomations()
    } catch (error) {
      toast(error)
    }
  },

  removeAutomation: async (id) => {
    try {
      await api.assistant.deleteAutomation(id)
      await get().loadAutomations()
    } catch (error) {
      toast(error)
    }
  },

  loadNotifications: async () => {
    if (notificationsRequest) return notificationsRequest
    notificationsRequest = (async () => {
      try {
        const result = await api.assistant.notifications()
        set({ notifications: result.notifications, unread: result.unread })
      } catch (error) {
        toast(error)
      } finally {
        notificationsRequest = null
      }
    })()
    return notificationsRequest
  },

  markRead: async (id) => {
    try {
      const result = await api.assistant.markNotificationsRead(id)
      set({ unread: result.unread })
      await get().loadNotifications()
    } catch (error) {
      toast(error)
    }
  },

  removeNotification: async (id) => {
    try {
      const result = await api.assistant.deleteNotification(id)
      set({ unread: result.unread })
      await get().loadNotifications()
    } catch (error) {
      toast(error)
    }
  },

  loadSettings: async () => {
    try {
      const [settings, providers] = await Promise.all([api.assistant.settings(), api.assistant.providers()])
      set({ settings: settings.settings, models: settings.models, providers: providers.providers })
    } catch (error) {
      toast(error)
    }
  },

  saveSettings: async (patch) => {
    try {
      const result = await api.assistant.saveSettings(patch)
      set({ settings: result.settings })
      useUi.getState().toast({ title: t('assistant.toast.saved'), tone: 'success' })
      if (patch.timezone !== undefined) await get().loadAutomations()
    } catch (error) {
      toast(error)
    }
  },

  addProvider: async (body, report) => {
    try {
      const created = await api.assistant.createProvider(body)
      await get().loadSettings()
      return created.provider
    } catch (error) {
      reportFailure(error, report)
      return null
    }
  },

  updateProvider: async (id, body, report) => {
    try {
      await api.assistant.updateProvider(id, body)
      await get().loadSettings()
      return true
    } catch (error) {
      reportFailure(error, report)
      return false
    }
  },

  removeProvider: async (id) => {
    try {
      await api.assistant.deleteProvider(id)
      await get().loadSettings()
    } catch (error) {
      toast(error)
    }
  },

  addModel: async (body, report) => {
    try {
      await api.assistant.createModel(body)
      await get().loadSettings()
      return true
    } catch (error) {
      reportFailure(error, report)
      return false
    }
  },

  loadVendorModels: async (providerId) => {
    set({ vendorModelsLoading: true, vendorModelsError: null })
    try {
      const listing = await api.assistant.vendorModels(providerId)
      set({
        vendorModels: listing.models,
        vendorModelsError: listing.ok ? null : listing.error,
        vendorModelsLoading: false,
      })
    } catch (error) {
      // A listing that never arrived is said in the dialog, which still has its manual entry.
      set({
        vendorModels: [],
        vendorModelsError: failureLine(error, t('assistant.model.list_failed')),
        vendorModelsLoading: false,
      })
    }
  },

  loadDraftVendorModels: async (input) => {
    set({ vendorModelsLoading: true, vendorModelsError: null })
    try {
      const listing = await api.assistant.previewVendorModels(input)
      set({
        vendorModels: listing.models,
        vendorModelsError: listing.ok ? null : listing.error,
        vendorModelsLoading: false,
      })
    } catch (error) {
      // Said in the dialog, which keeps the hand-typed ids as the way forward.
      set({
        vendorModels: [],
        vendorModelsError: failureLine(error, t('assistant.model.list_failed')),
        vendorModelsLoading: false,
      })
    }
  },

  syncVendorModels: async (providerId, ids) => {
    const listed = new Set(get().vendorModels.map((entry) => entry.id))
    const wanted = new Set(ids)
    const mine = get().models.filter((model) => model.providerId === providerId)
    let added = 0
    for (const id of wanted) {
      if (mine.some((model) => model.model === id)) continue
      const entry = get().vendorModels.find((candidate) => candidate.id === id)
      try {
        await api.assistant.createModel({
          providerId,
          model: id,
          ...(entry ? { label: entry.label } : {}),
          // The vendor's own numbers, when its listing published them. A synced row should know what the
          // service said about it, not only what a bundled table guesses from its name.
          ...(entry?.contextTokens !== undefined ? { vendorContextTokens: entry.contextTokens } : {}),
          ...(entry?.maxOutputTokens !== undefined ? { vendorMaxOutputTokens: entry.maxOutputTokens } : {}),
        })
        added += 1
      } catch (error) {
        // One id the route refuses must not lose the ones the reader also ticked.
        toast(error)
      }
    }
    let removed = 0
    for (const model of mine) {
      if (!listed.has(model.model) || wanted.has(model.model)) continue
      try {
        await api.assistant.deleteModel(model.id)
        removed += 1
      } catch (error) {
        // The same rule as above: one refusal must not stop the rest of the selection.
        toast(error)
      }
    }
    if (added || removed) await get().loadSettings()
    return { added, removed }
  },

  updateModel: async (id, body, report) => {
    try {
      await api.assistant.updateModel(id, body)
      await get().loadSettings()
      return true
    } catch (error) {
      reportFailure(error, report)
      return false
    }
  },

  removeModel: async (id) => {
    try {
      await api.assistant.deleteModel(id)
      await get().loadSettings()
    } catch (error) {
      toast(error)
    }
  },

  activateModel: async (id) => {
    try {
      const result = await api.assistant.saveSettings({ activeModelId: id })
      set({ settings: result.settings })
    } catch (error) {
      toast(error)
    }
  },
}))

lastPersisted = persistedSlice(useAssistant.getState())
useAssistant.subscribe(schedulePersist)

function describeMemoryWrite(result: { superseded: AssistantMemory[], reviews: number }): void {
  const parts = [t('assistant.toast.memory_saved')]
  if (result.superseded.length) {
    parts.push(t('assistant.toast.memory_superseded', { count: result.superseded.length }))
  }
  if (result.reviews) parts.push(t('assistant.toast.memory_review'))
  useUi.getState().toast({ title: parts.join(' · '), tone: 'success' })
}
