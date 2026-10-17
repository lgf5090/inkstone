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
  AssistantVendorModel,
  Automation as AssistantAutomation,
  AutomationRun as AssistantAutomationRun,
  ChatStreamEvent,
  MemoryReview,
  Project,
  Task as AssistantTask,
  ToolActivity,
  MessageFeedback,
} from '@shared/assistant'
import type { AssistantSkill } from '@shared/assistant'
import { DEBOUNCE } from '@shared/constants'
import { MAX_ARTIFACT_CONTENT_CHARS, MAX_ARTIFACT_TITLE_CHARS, MAX_CHAT_ATTACHMENTS, MAX_TURN_SCOPES, MAX_TURN_TOOLS, type AssistantTurnScope, type ChatAttachment, type AssistantSkillInput, type SkillImportResult, type AssistantMcpToolMode } from '@shared/assistant'
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

/** The five pickers the conversation list's tab strip offers, in the order it draws them. */
export type ConversationListTab = 'folders' | 'projects' | 'tags' | 'starred' | 'pinned' | 'archived'

export const CONVERSATION_LIST_TABS: readonly ConversationListTab[] = ['folders', 'projects', 'tags', 'starred', 'pinned', 'archived']

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
  /** Empty until the upload lands; the server's id is what the turn names. */
  id: string
  filename: string
  mime: string
  size: number
  kind: 'image' | 'file'
  /** 0..1 of the bytes the browser has handed over. */
  progress: number
  status: 'uploading' | 'ready' | 'error'
  error?: string
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
  done: boolean
}

interface AssistantState {
  view: AssistantView
  loaded: boolean
  loading: boolean
  error: string | null

  conversations: AssistantConversation[]
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
  folderContextOn: boolean
  setNoteContext: (on: boolean) => void
  setFolderContext: (on: boolean) => void
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
   * The displaced answers of a turn, by message id; absent until the reader opens that turn's pager.
   * A transcript of forty turns does not need forty histories fetched up front.
   */
  answerVersions: Record<string, AssistantAnswerVersion[] | undefined>
  remoteStreaming: boolean
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

  tasks: AssistantTask[]
  taskTab: 'today' | 'upcoming' | 'completed'
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
  addMcpServer: (body: Record<string, unknown>) => Promise<boolean>
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
  patchMcpServer: (id: string, body: Record<string, unknown>) => Promise<void>
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
  editMessage: (messageId: string, content: string) => Promise<void>
  /** Take one turn back: the reader's message and the answer that was drawn from it. */
  removeMessage: (messageId: string) => Promise<void>
  /** Records or takes back the reader's verdict on one answer. */
  rateAnswer: (messageId: string, feedback: MessageFeedback) => Promise<void>
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
  openConversation: (id: string | null) => Promise<void>
  newConversation: () => void
  /**
   * Asks the assistant, and answers whether the worker took the turn.
   *
   * False means the request never reached the worker — a refused route or a connection that never
   * formed — so the composer can hand the reader their words back instead of swallowing them. True
   * covers a turn that ran and a turn the reader stopped: either way the question itself was sent.
   */
  send: (text: string, opts?: { retry?: boolean }) => Promise<boolean>
  attachFiles: (files: File[]) => Promise<void>
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
  /** Rewrite a draft's name or body. The server stores what it is sent and keeps the rest. */
  saveArtifact: (id: string, patch: { title?: string, content?: string, noteId?: string | null }) => Promise<void>
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

  loadTasks: () => Promise<void>
  setTaskTab: (tab: 'today' | 'upcoming' | 'completed') => void
  addTask: (title: string) => Promise<void>
  updateTask: (id: string, patch: Record<string, unknown>) => Promise<void>
  toggleTask: (task: AssistantTask) => Promise<void>
  removeTask: (id: string) => Promise<void>
  loadProjects: () => Promise<void>
  addProject: (name: string) => Promise<void>
  removeProject: (id: string) => Promise<void>

  loadAutomations: () => Promise<void>
  addAutomation: (body: Record<string, unknown>) => Promise<void>
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
  addProvider: (body: Record<string, unknown>) => Promise<AssistantProvider | null>
  updateProvider: (id: string, body: Record<string, unknown>) => Promise<void>
  removeProvider: (id: string) => Promise<void>
  addModel: (body: Record<string, unknown>) => Promise<void>
  /** Any subset of the model's own fields; the route validates each one it recognises. */
  updateModel: (id: string, body: Partial<AssistantModel>) => Promise<void>
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

function toast(error: unknown): void {
  useUi.getState().toast({
    title: error instanceof ApiError || error instanceof Error ? error.message : t('assistant.toast.failed'),
    tone: 'danger',
  })
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
 * Brings the saved thread on screen.
 *
 * A stopped turn is filed by the worker a moment after the reader aborts the stream, so the first read
 * can still show the answer as running; the bubble is dropped only once the stored copy is visible, or
 * the reply blinks out and reappears on the next open. `turn` is the live turn the caller is adopting,
 * and is the only turn this read is allowed to settle — every write below is either about that turn or
 * about the thread, never about whatever turn happens to be on screen now.
 */
async function adoptThread(conversationId: string, turn: LiveTurn | null): Promise<void> {
  for (let attempt = 0; attempt < ADOPT_ATTEMPTS; attempt++) {
    let detail
    try {
      detail = await api.assistant.conversation(conversationId)
    } catch {
      return
    }
    // Another thread is on screen. This read is only worth anything to the thread the reader can see,
    // and the next open of this one reads it again for itself.
    if (useAssistant.getState().activeId !== conversationId) return
    useAssistant.setState({
      messages: fillStoppedAnswer(detail.messages, turn),
      messagesReady: true,
      // Merged rather than replaced: the rows this turn already had are still the reader's, and a
      // picture the assistant drew is a row the thread has never seen before this read.
      fileIndex: { ...useAssistant.getState().fileIndex, ...Object.fromEntries((detail.attachments ?? []).map((entry) => [entry.id, entry])) },
    })
    if (!detail.streaming) {
      useAssistant.setState({ remoteStreaming: false })
      releaseTurn(turn?.token)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, ADOPT_POLL_MS))
  }
  releaseTurn(turn?.token)
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
      messages: detail.messages,
      messagesReady: true,
      remoteStreaming: false,
      fileIndex: { ...current.fileIndex, ...Object.fromEntries((detail.attachments ?? []).map((entry) => [entry.id, entry])) },
    }))
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

function watchRemoteStream(conversationId: string): void {
  stopRemoteStreamWatch()
  const watch: RemoteWatch = { conversationId, startedAt: Date.now(), timer: 0 }
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

export const useAssistant = create<AssistantState>()((set, get) => ({
  view: 'chat',
  loaded: false,
  loading: false,
  error: null,

  conversations: [],
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
  folderContextOn: true,
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
  answerVersions: {},
  remoteStreaming: false,
  turn: null,
  artifacts: [],
  artifactsReady: false,
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
  taskTab: 'today',
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
      set({ loading: false, error: error instanceof Error ? error.message : t('assistant.toast.failed') })
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
      const params: { q?: string, folder?: string, project?: string, tag?: string, archived?: string } = {}
      if (query) params.q = query
      if (state.folderFilter !== 'all') params.folder = state.folderFilter
      if (state.projectFilter !== 'all') params.project = state.projectFilter
      if (state.tagFilter) params.tag = state.tagFilter
      // Always sent, so no view of this list ever shows a conversation the reader has put away.
      params.archived = '0'
      const result = await api.assistant.conversations(params)
      if (token !== conversationRequest) return
      set({ conversations: result.conversations })
    } catch (error) {
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

  addMcpServer: async (body) => {    try {
      await api.assistant.createMcpServer(body)
      await get().loadMcp()
      return true
    } catch (error) {
      toast(error)
      return false
    }
  },

  patchMcpServer: async (id, body) => {
    try {
      await api.assistant.patchMcpServer(id, body)
      await get().loadMcp()
    } catch (error) {
      toast(error)
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
      return { ok: false, error: error instanceof Error ? error.message : String(error), result: '' }
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
      return { ok: false, error: error instanceof Error ? error.message : String(error), count: 0 }
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

  editMessage: async (messageId, content) => {
    const conversationId = get().activeId
    if (!conversationId) return
    try {
      await api.assistant.editMessage(conversationId, messageId, content)
      await get().openConversation(conversationId)
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
      toast({ title: t('assistant.chat.forked', { title: conversation.title }), tone: 'success' })
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

  openConversation: async (id) => {
    const state = get()
    const turn = state.turn
    // A reply still arriving belongs to its own conversation: navigating away keeps the request going
    // and drops only the view of it. What keeps the stream honest is the token on its turn — its events
    // find no turn to write to here, so they cannot land in the thread the reader moved to.
    if (turn && !turn.done && turn.conversationId !== id) set({ turn: null })
    // A remote marker belongs to the conversation it was read from; asking again below is what starts a
    // new watch when this thread has one too.
    stopRemoteStreamWatch()
    // A muted chip is this thread's correction, not a setting: the next thread starts from the pointer.
    // The panel starts closed on every thread and shows no draft until that thread's own read lands.
    set({ activeId: id, messages: [], messagesReady: false, remoteStreaming: false, noteContextOn: true, folderContextOn: true, artifacts: [], artifactsReady: false, canvasOpen: false, activeArtifactId: null, ephemeral: false })
    if (!id) {
      set({ messagesReady: true, artifactsReady: true })
      return
    }
    void get().loadArtifacts()
    try {
      const detail = await api.assistant.conversation(id)
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
        remoteStreaming: remote,
        // Read from the row rather than from the list, which never carries a temporary conversation.
        ephemeral: detail.conversation.ephemeral === true,
      })
      if (remote) watchRemoteStream(id)
    } catch (error) {
      if (get().activeId !== id) return
      set({ messagesReady: true })
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
    set({ activeId: null, messages: [], messagesReady: true, remoteStreaming: false, turn: null, noteContextOn: true, folderContextOn: true, artifacts: [], artifactsReady: true, canvasOpen: false, activeArtifactId: null, ephemeral: false, turnTools: [], turnScopes: [] })
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
    set({ activeId: null, messages: [], messagesReady: true, remoteStreaming: false, turn: null, noteContextOn: true, folderContextOn: true, artifacts: [], artifactsReady: true, canvasOpen: false, activeArtifactId: null, ephemeral: true })
  },

  attachFiles: async (files) => {
    const room = MAX_CHAT_ATTACHMENTS - get().pending.length
    if (room <= 0) {
      toast({ title: t('assistant.attach.too_many', { count: MAX_CHAT_ATTACHMENTS }), tone: 'danger' })
      return
    }
    // Files that do not fit are named rather than silently dropped: a folder picked as a whole can hold
    // more than the box does, and "only some of them appeared" is otherwise indistinguishable from a bug.
    if (files.length > room) {
      toast({ title: t('assistant.attach.dropped', { count: files.length - room, max: MAX_CHAT_ATTACHMENTS }), tone: 'warning' })
    }
    for (const file of files.slice(0, room)) {
      const localId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const kind = file.type.startsWith('image/') ? 'image' : 'file'
      set((current) => ({
        pending: [...current.pending, {
          localId, id: '', filename: file.name || 'file', mime: file.type, size: file.size, kind, progress: 0, status: 'uploading',
        }],
      }))
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
              ? { ...entry, id: stored.id, progress: 1, status: 'ready' as const, filename: stored.filename, mime: stored.mime, kind: stored.kind }
              : entry
          )),
          fileIndex: { ...current.fileIndex, [stored.id]: stored },
        }))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        set((current) => ({
          pending: current.pending.map((entry) => (
            entry.localId === localId ? { ...entry, status: 'error' as const, error: reason } : entry
          )),
        }))
        toast({ title: t('assistant.attach.failed'), description: reason, tone: 'danger' })
      }
    }
  },

  attachUrl: async (url) => {
    const trimmed = url.trim()
    if (!trimmed) return
    if (get().pending.length >= MAX_CHAT_ATTACHMENTS) {
      toast({ title: t('assistant.attach.too_many', { count: MAX_CHAT_ATTACHMENTS }), tone: 'danger' })
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
      toast({ title: t('assistant.attach.failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
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

  setNoteContext: (on) => set({ noteContextOn: on }),

  setFolderContext: (on) => set({ folderContextOn: on }),

  seedComposer: (text) => set({ composerSeed: text }),

  clearComposerSeed: () => set({ composerSeed: null }),

  send: async (text, opts = {}) => {
    const state = get()
    if (state.turn && !state.turn.done) return false
    const conversationId = state.activeId
    const retry = opts.retry === true
    const attached = retry ? [] : state.pending.filter((entry) => entry.status === 'ready' && entry.id).map((entry) => entry.id)
    if (!retry && !text.trim() && !attached.length) return false
    if (!retry && state.pending.some((entry) => entry.status === 'uploading')) {
      toast({ title: t('assistant.attach.waiting'), tone: 'danger' })
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
        userText: retry ? '' : text.trim(),
        attachments: retry ? [] : attached,
        assistantId: null,
        text: '',
        reasoning: '',
        tools: [],
        stage: 'waiting',
        error: null,
        done: false,
      },
      remoteStreaming: false,
      ...(retry ? {} : { pending: [], turnTools: [], turnScopes: [] }),
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
              },
              activeId: current.activeId ?? event.conversationId ?? null,
            }
          case 'text':
            return { turn: { ...turn, text: turn.text + (event.delta ?? ''), stage: undefined } }
          case 'reasoning':
            return { turn: { ...turn, reasoning: turn.reasoning + (event.delta ?? '') } }
          case 'stage':
            return { turn: { ...turn, stage: event.stage } }
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
          case 'mcp_problem':
            // A server the reader added did not answer. The turn still proceeds without its
            // tools, so this is said out loud rather than swallowed.
            toast({ title: t('assistant.mcp.problem', { server: event.server ?? '', error: event.error ?? '' }), tone: 'warning' })
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
              },
            }
          default:
            return current
        }
      })
      if (event.type === 'title') void get().loadConversations()
    }

    // What the reader had on screen when they asked. The notebook's own pointer is the only thing that
    // makes "summarise this" work without naming the note, and it costs two ids on the wire.
    const ui = useUi.getState()
    try {
      await streamAssistantTurn(
        {
          ...(conversationId ? { conversationId } : {}),
          message: text,
          attachments: attached,
          tools: state.turnTools,
          scopes: state.turnScopes,
          ...(retry ? {} : {
            ...(state.noteContextOn && ui.activeNoteId ? { contextNoteId: ui.activeNoteId } : {}),
            ...(state.folderContextOn && ui.folderId ? { contextFolderId: ui.folderId } : {}),
          }),
          webSearch: state.webSearch,
          // Only when this turn is the one that makes the conversation: the flag is read at creation and
          // never again, because the promise is about the whole thread.
          ...(state.ephemeral && !conversationId ? { ephemeral: true } : {}),
          retry,
        },
        apply,
        controller.signal,
      )
    } catch (error) {
      if (!controller.signal.aborted) {
        set((current) => (current.turn?.token === token
          ? { turn: { ...current.turn, error: error instanceof Error ? error.message : t('assistant.toast.failed'), done: true } }
          : current))
      }
    } finally {
      inflight.delete(token)
      // Only the turn this request started may be settled here. A later send owns the screen after a
      // stop or a change of conversation, and its token is what tells the two apart.
      const mine = get().turn?.token === token ? get().turn : null
      if (mine) {
        const finished: LiveTurn = { ...mine, done: true }
        set({ turn: finished })
        // A turn that never reached the worker has no stored row to adopt; the draft comes back instead.
        if (accepted && filedConversationId) await adoptThread(filedConversationId, finished)
      } else if (accepted && filedConversationId) {
        // A stream whose turn left the screen while it was running: the thread is all that can be
        // updated now, and only if the reader happens to be looking at it.
        await adoptThread(filedConversationId, null)
      }
      if (!accepted && !retry && !controller.signal.aborted) {
        // The words never left this device: give the draft back, unless the reader has already asked
        // something else — a newer turn owns the composer and the old draft must not overwrite it.
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
    if (state.view === 'tasks') await state.loadTasks()
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
    if (conversationId) void api.assistant.cancel(conversationId).catch(() => {})
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
        set({ activeId: null, messages: [], turn: null, artifacts: [], artifactsReady: true, canvasOpen: false, activeArtifactId: null, ephemeral: false })
      }
      await get().loadConversations()
    } catch (error) {
      toast(error)
    }
  },

  setCanvasOpen: (open) => set({ canvasOpen: open }),

  selectArtifact: (id) => set({ activeArtifactId: id }),

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
      }))
    } catch (error) {
      toast(error)
    }
  },

  saveArtifact: async (id, patch) => {
    const conversationId = get().activeId
    if (!conversationId) return
    try {
      const { artifact } = await api.assistant.updateConversationArtifact(conversationId, id, patch)
      set((current) => ({ artifacts: current.artifacts.map((entry) => (entry.id === id ? artifact : entry)) }))
    } catch (error) {
      toast(error)
    }
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
      set((current) => ({
        messages: current.messages.map((message) => ({ ...message, tools: message.tools.map(settle) })),
        turn: current.turn
          ? { ...current.turn, tools: current.turn.tools.map(settle) }
          : current.turn,
      }))
      const view = get().view
      if (view === 'tasks') await get().loadTasks()
      if (view === 'memory') await get().loadMemories()
      if (view === 'automations') await get().loadAutomations()
      if (view === 'skills') await get().loadSkills()
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

  loadTasks: async () => {
    try {
      const result = await api.assistant.tasks({ limit: 500 })
      set({ tasks: result.tasks })
    } catch (error) {
      toast(error)
    }
  },

  setTaskTab: (tab) => set({ taskTab: tab }),

  addTask: async (title) => {
    try {
      const today = get().taskTab === 'today'
      await api.assistant.createTask({ title, ...(today ? { dueAt: endOfTodayLocal() } : {}) })
      await get().loadTasks()
    } catch (error) {
      toast(error)
    }
  },

  updateTask: async (id, patch) => {
    try {
      await api.assistant.updateTask(id, patch)
      await get().loadTasks()
    } catch (error) {
      toast(error)
    }
  },

  toggleTask: async (task) => {
    try {
      await api.assistant.updateTask(task.id, { status: task.status === 'done' ? 'todo' : 'done' })
      await get().loadTasks()
    } catch (error) {
      toast(error)
    }
  },

  removeTask: async (id) => {
    try {
      await api.assistant.deleteTask(id)
      await get().loadTasks()
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
      await get().loadTasks()
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
    } catch (error) {
      toast(error)
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
    try {
      const result = await api.assistant.notifications()
      set({ notifications: result.notifications, unread: result.unread })
    } catch (error) {
      toast(error)
    }
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

  addProvider: async (body) => {
    try {
      const created = await api.assistant.createProvider(body)
      await get().loadSettings()
      return created.provider
    } catch (error) {
      toast(error)
      return null
    }
  },

  updateProvider: async (id, body) => {
    try {
      await api.assistant.updateProvider(id, body)
      await get().loadSettings()
    } catch (error) {
      toast(error)
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

  addModel: async (body) => {
    try {
      await api.assistant.createModel(body)
      await get().loadSettings()
    } catch (error) {
      toast(error)
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
        vendorModelsError: error instanceof Error ? error.message : t('assistant.model.list_failed'),
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
        vendorModelsError: error instanceof Error ? error.message : t('assistant.model.list_failed'),
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
        await api.assistant.createModel({ providerId, model: id, ...(entry ? { label: entry.label } : {}) })
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

  updateModel: async (id, body) => {
    try {
      await api.assistant.updateModel(id, body)
      await get().loadSettings()
    } catch (error) {
      toast(error)
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

/**
 * The reader's own end of today, as the server reads a due date.
 *
 * A quick-add from the Today tab means "by tonight"; sending a bare date would land at 23:59 in the
 * *server's* zone, which is a different day for a reader in Shanghai or São Paulo.
 */
function endOfTodayLocal(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T23:59`
}

function describeMemoryWrite(result: { superseded: AssistantMemory[], reviews: number }): void {
  const parts = [t('assistant.toast.memory_saved')]
  if (result.superseded.length) {
    parts.push(t('assistant.toast.memory_superseded', { count: result.superseded.length }))
  }
  if (result.reviews) parts.push(t('assistant.toast.memory_review'))
  useUi.getState().toast({ title: parts.join(' · '), tone: 'success' })
}
