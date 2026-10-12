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
import { api, ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { streamAssistantTurn } from './stream'
import { useUi } from '../../store/ui'

export type AssistantView = 'chat' | 'memory' | 'tasks' | 'automations' | 'settings'

export const ASSISTANT_VIEWS: readonly AssistantView[] = ['chat', 'memory', 'tasks', 'automations', 'settings']

/** What a reader has typed but the assistant has not answered yet. */
interface LiveTurn {
  conversationId: string | null
  userText: string
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
  activeId: string | null
  messages: AssistantMessage[]
  messagesReady: boolean
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

  setView: (view: AssistantView) => void
  bootstrap: (force?: boolean) => Promise<void>
  loadProviders: () => Promise<void>
  /** A turn can have written memories, tasks and schedules, so the other surfaces re-read once. */
  refreshAfterTurn: () => Promise<void>
  loadConversations: () => Promise<void>
  setConversationQuery: (query: string) => Promise<void>
  /** The folder tree and the tag list, both counted for conversations. */
  loadTaxonomy: () => Promise<void>
  setFolderFilter: (value: string) => Promise<void>
  setTagFilter: (tagId: string | null) => Promise<void>
  moveConversation: (id: string, folderId: string | null) => Promise<void>
  toggleConversationTag: (id: string, tagId: string, on: boolean) => Promise<void>
  openConversation: (id: string | null) => Promise<void>
  newConversation: () => void
  send: (text: string, opts?: { retry?: boolean }) => Promise<void>
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
  updateModel: (id: string, body: Record<string, unknown>) => Promise<void>
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
  activeId: null,
  messages: [],
  messagesReady: false,
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

  send: async (text, opts = {}) => {
    const state = get()
    if (state.turn && !state.turn.done) return
    const conversationId = state.activeId
    const retry = opts.retry === true
    if (!retry && !text.trim()) return
    const controller = new AbortController()
    inflight = controller
    set({
      turn: {
        conversationId,
        userText: retry ? '' : text.trim(),
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
        { ...(conversationId ? { conversationId } : {}), message: text, retry },
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
