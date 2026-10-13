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
  AssistantConversation,
  ChatFolderNode,
  ConversationTag,
  AssistantMemory,
  AssistantMessage,
  AssistantAnswerVersion,
  AssistantMcpServer,
  AssistantModel,
  AssistantNotification,
  AssistantProvider,
  AssistantSettings,
  Automation as AssistantAutomation,
  AutomationRun as AssistantAutomationRun,
  ChatStreamEvent,
  MemoryReview,
  Project,
  Task as AssistantTask,
  ToolActivity,
} from '@shared/assistant'
import type { ChatPrompt } from '@shared/assistant'
import { MAX_CHAT_ATTACHMENTS, MAX_TURN_SCOPES, MAX_TURN_TOOLS, type AssistantTurnScope, type ChatAttachment } from '@shared/assistant'
import { api, ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { streamAssistantTurn } from './stream'
import { useUi } from '../../store/ui'

export type AssistantView = 'chat' | 'memory' | 'tasks' | 'automations' | 'prompts' | 'settings'

export const ASSISTANT_VIEWS: readonly AssistantView[] = ['chat', 'memory', 'tasks', 'automations', 'prompts', 'settings']

/** The four pickers the conversation list's tab strip offers, in the order it draws them. */
export type ConversationListTab = 'folders' | 'tags' | 'starred' | 'pinned'

export const CONVERSATION_LIST_TABS: readonly ConversationListTab[] = ['folders', 'tags', 'starred', 'pinned']

/**
 * A paste at least this long is turned into a text file instead of being pasted into the box.
 *
 * The reader pasted it as context, not as something to scroll past for the next three turns.
 */
export const PASTE_FILE_MIN_CHARS = 2000

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
  tagNodes: (ConversationTag & { count: number })[]
  /** Which of the four pickers the list column's tab panel currently shows. */
  listTab: ConversationListTab
  /** The shortlists two of the tabs jump to; kept apart from the filtered main list. */
  flagged: { starred: AssistantConversation[], pinned: AssistantConversation[] }
  /** The composer's live-web-search switch, kept between turns like the other per-composer settings. */
  webSearch: boolean
  setWebSearch: (value: boolean) => void
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

  /** The reader's external MCP servers, and the tools they currently expose. */
  mcpServers: AssistantMcpServer[]
  mcpProblems: { serverId: string, label: string, error: string }[]
  mcpTools: { name: string, description: string }[]
  loadMcp: () => Promise<void>
  addMcpServer: (body: { label: string, url: string, token?: string, toolMode?: string }) => Promise<boolean>
  patchMcpServer: (id: string, body: Record<string, unknown>) => Promise<void>
  removeMcpServer: (id: string) => Promise<void>
  testMcpServer: (id: string) => Promise<{ ok: boolean, error: string, count: number }>

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
  setConversationQuery: (query: string) => Promise<void>
  /** The folder tree and the tag list, both counted for conversations. */
  loadTaxonomy: () => Promise<void>
  setFolderFilter: (value: string) => Promise<void>
  setTagFilter: (tagId: string | null) => Promise<void>
  setListTab: (tab: ConversationListTab) => Promise<void>
  loadFlagged: () => Promise<void>
  starConversation: (id: string, starred: boolean) => Promise<void>
  moveConversation: (id: string, folderId: string | null) => Promise<void>
  toggleConversationTag: (id: string, tagId: string, on: boolean) => Promise<void>
  openConversation: (id: string | null) => Promise<void>
  newConversation: () => void
  send: (text: string, opts?: { retry?: boolean }) => Promise<void>
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
  prompts: ChatPrompt[]
  loadPrompts: (query?: string) => Promise<void>
  createPrompt: (input: { title: string, content: string, group?: string }) => Promise<ChatPrompt | null>
  savePrompt: (id: string, input: { title?: string, content?: string, group?: string }) => Promise<void>
  removePrompt: (id: string) => Promise<void>
  stop: () => void
  renameConversation: (id: string, title: string) => Promise<void>
  pinConversation: (id: string, pinned: boolean) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  decideAction: (actionId: string, approve: boolean) => Promise<void>

  loadMemories: () => Promise<void>
  setMemoryFilter: (patch: { query?: string, status?: string, category?: string }) => Promise<void>
  addMemory: (content: string, category: string) => Promise<void>
  editMemory: (id: string, content: string, category: string) => Promise<void>
  correctMemory: (id: string, content: string) => Promise<void>
  setMemoryStatus: (id: string, status: string) => Promise<void>
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
  addProvider: (body: Record<string, unknown>) => Promise<void>
  updateProvider: (id: string, body: Record<string, unknown>) => Promise<void>
  removeProvider: (id: string) => Promise<void>
  addModel: (body: Record<string, unknown>) => Promise<void>
  /** Any subset of the model's own fields; the route validates each one it recognises. */
  updateModel: (id: string, body: Partial<AssistantModel>) => Promise<void>
  removeModel: (id: string) => Promise<void>
  activateModel: (id: string) => Promise<void>
}

let inflight: AbortController | null = null
let conversationRequest = 0

function toast(error: unknown): void {
  useUi.getState().toast({
    title: error instanceof ApiError || error instanceof Error ? error.message : t('assistant.toast.failed'),
    tone: 'danger',
  })
}

/**
 * Brings the saved thread on screen.
 *
 * A stopped turn is filed by the worker a moment after the reader aborts the stream, so the first read
 * can still show the answer as running; the bubble is dropped only once the stored copy is visible, or
 * the reply blinks out and reappears on the next open.
 */
async function adoptThread(conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    let detail
    try {
      detail = await api.assistant.conversation(conversationId)
    } catch {
      return
    }
    if (useAssistant.getState().activeId === conversationId) {
      useAssistant.setState({ messages: detail.messages, messagesReady: true })
      if (!detail.streaming) {
        if (useAssistant.getState().turn?.done) useAssistant.setState({ turn: null })
        return
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  if (useAssistant.getState().turn?.done) useAssistant.setState({ turn: null })
}

export const useAssistant = create<AssistantState>()((set, get) => ({
  view: 'chat',
  loaded: false,
  loading: false,
  error: null,

  conversations: [],
  conversationQuery: '',
  folderFilter: 'all',
  tagFilter: null,
  folderNodes: [],
  unfiledCount: 0,
  tagNodes: [],
  webSearch: false,
  pending: [],
  prompts: [],
  turnTools: [],
  turnScopes: [],
  fileIndex: {},
  listTab: 'folders',
  flagged: { starred: [], pinned: [] },
  activeId: null,
  messages: [],
  messagesReady: false,
  answerVersions: {},
  remoteStreaming: false,
  turn: null,

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
  mcpTools: [],

  setView: (view) => set({ view }),

  bootstrap: async (force = false) => {
    if (get().loaded && !force) return
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const [settings, conversations] = await Promise.all([
        api.assistant.settings(),
        api.assistant.conversations(),
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
      const params: { q?: string, folder?: string, tag?: string } = {}
      if (query) params.q = query
      if (state.folderFilter !== 'all') params.folder = state.folderFilter
      if (state.tagFilter) params.tag = state.tagFilter
      const result = await api.assistant.conversations(params)
      if (token !== conversationRequest) return
      set({ conversations: result.conversations })
    } catch (error) {
      toast(error)
    }
  },

  loadMcp: async () => {
    try {
      const [servers, listing] = await Promise.all([api.assistant.mcpServers(), api.assistant.mcpTools()])
      set({ mcpServers: servers.servers, mcpTools: listing.tools, mcpProblems: listing.problems })
    } catch (error) {
      toast(error)
    }
  },

  addMcpServer: async (body) => {
    try {
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

  removeMcpServer: async (id) => {
    try {
      await api.assistant.removeMcpServer(id)
      await get().loadMcp()
    } catch (error) {
      toast(error)
    }
  },

  testMcpServer: async (id) => {
    try {
      const result = await api.assistant.testMcpServer(id)
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

  setConversationQuery: async (query) => {
    set({ conversationQuery: query })
    await get().loadConversations()
  },

  loadTaxonomy: async () => {
    try {
      const [folders, tags] = await Promise.all([api.assistant.conversationFolders(), api.assistant.conversationTags()])
      set({ folderNodes: folders.folders, unfiledCount: folders.unfiled, tagNodes: tags.tags })
    } catch (error) {
      toast(error)
    }
  },

  setFolderFilter: async (value) => {
    set({ folderFilter: value })
    await get().loadConversations()
  },

  setTagFilter: async (tagId) => {
    set({ tagFilter: tagId })
    await get().loadConversations()
  },

  setListTab: async (tab) => {
    set({ listTab: tab })
    if (tab === 'starred' || tab === 'pinned') await get().loadFlagged()
  },

  loadFlagged: async () => {
    try {
      const [starred, pinned] = await Promise.all([
        api.assistant.conversations({ starred: '1' }),
        api.assistant.conversations({ pinned: '1' }),
      ])
      set({ flagged: { starred: starred.conversations, pinned: pinned.conversations } })
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

  openConversation: async (id) => {
    const state = get()
    const turn = state.turn
    // A reply still arriving belongs to its own conversation; navigating away must not cancel it.
    if (turn && !turn.done && turn.conversationId !== id) set({ turn: null })
    set({ activeId: id, messages: [], messagesReady: false, remoteStreaming: false })
    if (!id) {
      set({ messagesReady: true })
      return
    }
    try {
      const detail = await api.assistant.conversation(id)
      if (get().activeId !== id) return
      set({
        messages: detail.messages,
        fileIndex: Object.fromEntries((detail.attachments ?? []).map((entry) => [entry.id, entry])),
        messagesReady: true,
        remoteStreaming: detail.streaming && !(get().turn && !get().turn?.done),
      })
    } catch (error) {
      if (get().activeId !== id) return
      set({ messagesReady: true })
      toast(error)
    }
  },

  newConversation: () => {
    const live = get().turn
    if (live && !live.done) return
    set({ activeId: null, messages: [], messagesReady: true, remoteStreaming: false, turn: null })
  },

  attachFiles: async (files) => {
    const room = MAX_CHAT_ATTACHMENTS - get().pending.length
    if (room <= 0) {
      toast({ title: t('assistant.attach.too_many', { count: MAX_CHAT_ATTACHMENTS }), tone: 'danger' })
      return
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
        const stored = await api.assistant.uploadChatFile(file, (sent, total) => {
          const progress = total > 0 ? sent / total : 0
          set((current) => ({
            pending: current.pending.map((entry) => (entry.localId === localId ? { ...entry, progress } : entry)),
          }))
        })
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
    if (entry?.id) await api.assistant.deleteChatFile(entry.id).catch(() => undefined)
  },

  clearAttachments: () => {
    set({ pending: [] })
  },

  loadPrompts: async (query) => {
    try {
      const { prompts } = await api.assistant.prompts(query)
      set({ prompts })
    } catch (error) {
      toast(error)
    }
  },

  createPrompt: async (input) => {
    try {
      const { prompt } = await api.assistant.createPrompt(input)
      set((state) => ({ prompts: [prompt, ...state.prompts] }))
      return prompt
    } catch (error) {
      toast(error)
      return null
    }
  },

  savePrompt: async (id, input) => {
    try {
      const { prompt } = await api.assistant.updatePrompt(id, input)
      set((state) => ({ prompts: state.prompts.map((entry) => (entry.id === id ? prompt : entry)) }))
    } catch (error) {
      toast(error)
    }
  },

  removePrompt: async (id) => {
    set((state) => ({ prompts: state.prompts.filter((entry) => entry.id !== id) }))
    try {
      await api.assistant.removePrompt(id)
    } catch (error) {
      toast(error)
    }
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

  send: async (text, opts = {}) => {
    const state = get()
    if (state.turn && !state.turn.done) return
    const conversationId = state.activeId
    const retry = opts.retry === true
    const attached = retry ? [] : state.pending.filter((entry) => entry.status === 'ready' && entry.id).map((entry) => entry.id)
    if (!retry && !text.trim() && !attached.length) return
    if (!retry && state.pending.some((entry) => entry.status === 'uploading')) {
      toast({ title: t('assistant.attach.waiting'), tone: 'danger' })
      return
    }
    const controller = new AbortController()
    inflight = controller
    set({
      turn: {
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
    })

    const apply = (event: ChatStreamEvent) => {
      set((current) => {
        const turn = current.turn
        if (!turn) return current
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
            return { turn: { ...turn, done: true } }
          default:
            return current
        }
      })
      if (event.type === 'title') void get().loadConversations()
    }

    try {
      await streamAssistantTurn(
        {
          ...(conversationId ? { conversationId } : {}),
          message: text,
          attachments: attached,
          tools: state.turnTools,
          scopes: state.turnScopes,
          webSearch: state.webSearch,
          retry,
        },
        apply,
        controller.signal,
      )
    } catch (error) {
      if (!controller.signal.aborted) {
        set((current) => (current.turn
          ? { turn: { ...current.turn, error: error instanceof Error ? error.message : t('assistant.toast.failed'), done: true } }
          : current))
      }
    } finally {
      inflight = null
      if (!retry) set({ pending: [], turnTools: [], turnScopes: [] })
      const finishedId = get().turn?.conversationId ?? conversationId
      set((current) => (current.turn ? { turn: { ...current.turn, done: true } } : current))
      if (finishedId) await adoptThread(finishedId)
      void get().loadConversations()
      void get().refreshAfterTurn()
    }
  },

  refreshAfterTurn: async () => {
    const state = get()
    if (state.view === 'memory') await state.loadMemories()
    if (state.view === 'tasks') await state.loadTasks()
    if (state.view === 'automations') await state.loadAutomations()
  },


  stop: () => {
    const turn = get().turn
    inflight?.abort()
    inflight = null
    set((current) => (current.turn ? { turn: { ...current.turn, done: true } } : current))
    const conversationId = turn?.conversationId ?? get().activeId
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
      if (get().activeId === id) set({ activeId: null, messages: [], turn: null })
      await get().loadConversations()
    } catch (error) {
      toast(error)
    }
  },

  decideAction: async (actionId, approve) => {
    try {
      const action = approve
        ? await api.assistant.approveAction(actionId)
        : await api.assistant.declineAction(actionId)
      set((current) => ({
        messages: current.messages.map((message) => ({
          ...message,
          tools: message.tools.map((tool) => (tool.approval?.id === actionId && action.action
            ? { ...tool, approval: action.action }
            : tool)),
        })),
        turn: current.turn
          ? {
              ...current.turn,
              tools: current.turn.tools.map((tool) => (tool.approval?.id === actionId && action.action
                ? { ...tool, approval: action.action }
                : tool)),
            }
          : current.turn,
      }))
      const view = get().view
      if (view === 'tasks') await get().loadTasks()
      if (view === 'memory') await get().loadMemories()
      if (view === 'automations') await get().loadAutomations()
      if (view === 'prompts') await get().loadPrompts()
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
      await api.assistant.createProject(name)
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
      await api.assistant.createProvider(body)
      await get().loadSettings()
    } catch (error) {
      toast(error)
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
