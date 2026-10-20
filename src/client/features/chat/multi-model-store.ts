/**
 * The multi-model workspace: one conversation per pane, one shared question.
 *
 * The main pane is the reader's own thread. Every other pane is an ephemeral fork of it, so a side model
 * gets the same history and files instead of a question with its context missing, while the rows it writes
 * stay out of the reader's listings and backup. A pane's answer is its own conversation; the transcript's
 * single-answer rules are untouched, and a side turn never claims the reader's thread.
 *
 * A side turn is asked without tools. The main pane already runs the tools the turn is allowed to run, and
 * a second model performing the same write from a pane the reader opened to compare answers would be the
 * write happening twice, not a second opinion.
 */
import { create } from 'zustand'
import { titleFromMessage } from '@shared/assistant'
import type {
  AssistantMessage,
  AssistantModel,
  AssistantSource,
  ChatAttachment,
  ChatStreamEvent,
  ToolActivity,
} from '@shared/assistant'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { randomLocalId } from '../../lib/random-id'
import { useUi } from '../../store/ui'
import { useAssistant, chatModels, modelLabelOf } from './assistant-store'
import { streamAssistantTurn } from './stream'

export type MultiModelLayout = 0 | 2 | 3 | 4 | 6

export interface MultiModelPane {
  id: string
  conversationId: string | null
  modelId: string | null
  messages: AssistantMessage[]
  files: Record<string, ChatAttachment>
  loading: boolean
  error: string | null
}

/** One side pane's answer while it is arriving, and after it settles until its stored row is read back. */
export interface MultiModelTurn {
  token: number
  userText: string
  attachments: string[]
  text: string
  reasoning: string
  tools: ToolActivity[]
  sources: AssistantSource[]
  error: string | null
  done: boolean
  startedAt: number
  finishedAt: number | null
  usage: { inputTokens: number, outputTokens: number } | null
}

interface PersistedPane {
  id: string
  conversationId: string | null
  modelId: string | null
}

interface PersistedConfig {
  layout: MultiModelLayout
  panes: PersistedPane[]
  expanded: string | null
}

interface MultiModelState {
  mainId: string | null
  layout: MultiModelLayout
  panes: MultiModelPane[]
  expanded: string | null
  turns: Record<string, MultiModelTurn | null>
  /** How many side answers are in flight. The composer is held while any of them is. */
  running: number
  syncConversation: (id: string | null) => void
  setLayout: (layout: MultiModelLayout) => Promise<void>
  setPaneModel: (paneId: string, modelId: string) => void
  setExpanded: (paneId: string | null) => void
  closePane: (paneId: string) => Promise<void>
  loadPane: (paneId: string) => Promise<void>
  sendAll: (text: string) => Promise<boolean>
  stopAll: () => void
  stopPane: (paneId: string) => void
}

const STORAGE_KEY = 'inkstone.assistant.multi-model.v1'
const LAYOUTS: readonly MultiModelLayout[] = [0, 2, 3, 4, 6]
let turnSeq = 0
const inflight = new Map<string, { token: number, controller: AbortController }>()

function readConfigs(): Record<string, PersistedConfig> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, PersistedConfig> : {}
  } catch {
    return {}
  }
}

function writeConfig(mainId: string | null, config: PersistedConfig | null): void {
  if (!mainId || typeof localStorage === 'undefined') return
  const all = readConfigs()
  if (config) all[mainId] = config
  else delete all[mainId]
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)) } catch { /* a full store costs the next reload, not this one */ }
}

function persist(state: MultiModelState): void {
  writeConfig(state.mainId, state.layout > 1
    ? {
      layout: state.layout,
      panes: state.panes.map((pane) => ({ id: pane.id, conversationId: pane.conversationId, modelId: pane.modelId })),
      expanded: state.expanded,
    }
    : null)
}

function layoutForPaneCount(count: number): MultiModelLayout {
  if (count >= 6) return 6
  if (count >= 4) return 4
  if (count >= 3) return 3
  if (count >= 2) return 2
  return 0
}

function visiblePanes(state: MultiModelState): MultiModelPane[] {
  return state.panes.slice(0, Math.max(0, state.layout - 1))
}

function defaultModelId(models: readonly AssistantModel[], primaryId: string | null, index: number): string | null {
  if (!models.length) return null
  const others = models.filter((model) => model.id !== primaryId)
  const pool = others.length ? others : models
  return pool[index % pool.length]?.id ?? null
}

function newPane(models: readonly AssistantModel[], primaryId: string | null, index: number): MultiModelPane {
  return {
    id: randomLocalId('pane'),
    conversationId: null,
    modelId: defaultModelId(models, primaryId, index),
    messages: [],
    files: {},
    loading: false,
    error: null,
  }
}

function paneFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'StreamDisconnectedError') return t('assistant.panes.stream_incomplete')
  return error instanceof Error ? error.message : t('assistant.panes.stream_failed')
}

/**
 * Give every visible pane the thread it answers in.
 *
 * A pane created before the first message has nothing to fork, so it starts as an empty ephemeral thread.
 * Every later pane forks at the newest stored turn, which is what gives the same question the same history
 * in every pane. Panes that already have a conversation are left alone.
 */
async function ensurePaneConversations(get: () => MultiModelState, set: (fn: (state: MultiModelState) => Partial<MultiModelState>) => void): Promise<void> {
  const assistant = useAssistant.getState()
  const mainId = assistant.activeId
  if (!mainId) return
  const lastMessageId = assistant.messages.at(-1)?.id ?? null
  const models = chatModels(assistant.models)
  for (const visible of visiblePanes(get())) {
    if (visible.conversationId || visible.loading) continue
    const pane = get().panes.find((entry) => entry.id === visible.id)
    if (!pane) continue
    set((state) => ({
      panes: state.panes.map((entry) => entry.id === pane.id ? { ...entry, loading: true, error: null } : entry),
    }))
    const model = models.find((entry) => entry.id === pane.modelId) ?? null
    const title = t('assistant.panes.side_title', { model: modelLabelOf(model) })
    try {
      const created = lastMessageId
        ? await api.assistant.forkConversation(mainId, lastMessageId, title, true)
        : await api.assistant.createConversation(title, null, true)
      const messages = ('messages' in created ? created.messages : []) as AssistantMessage[]
      set((state) => ({
        panes: state.panes.map((entry) => entry.id === pane.id
          ? { ...entry, conversationId: created.conversation.id, messages, loading: false, error: null }
          : entry),
      }))
    } catch (error) {
      set((state) => ({
        panes: state.panes.map((entry) => entry.id === pane.id
          ? { ...entry, loading: false, error: paneFailure(error) }
          : entry),
      }))
    }
  }
  persist(get())
}

export const useMultiModel = create<MultiModelState>()((set, get) => ({
  mainId: null,
  layout: 0,
  panes: [],
  expanded: null,
  turns: {},
  running: 0,

  syncConversation: (id) => {
    if (get().mainId === id) return
    for (const entry of inflight.values()) entry.controller.abort()
    inflight.clear()
    set({ mainId: id, layout: 0, panes: [], expanded: null, turns: {}, running: 0 })
    if (!id) return
    const config = readConfigs()[id]
    if (!config || !LAYOUTS.includes(config.layout) || config.layout <= 1) return
    const assistant = useAssistant.getState()
    const models = chatModels(assistant.models)
    const primaryId = assistant.settings?.activeModelId ?? null
    const panes: MultiModelPane[] = config.panes.slice(0, 5).map((pane, index) => ({
      id: pane.id || randomLocalId('pane'),
      conversationId: pane.conversationId ?? null,
      modelId: pane.modelId ?? defaultModelId(models, primaryId, index),
      messages: [],
      files: {},
      loading: false,
      error: null,
    }))
    while (panes.length < config.layout - 1) panes.push(newPane(models, primaryId, panes.length))
    set({
      layout: config.layout,
      panes,
      expanded: config.expanded && panes.slice(0, config.layout - 1).some((pane) => pane.id === config.expanded)
        ? config.expanded
        : null,
    })
    for (const pane of panes.slice(0, config.layout - 1)) {
      if (pane.conversationId) void get().loadPane(pane.id)
    }
  },

  setLayout: async (next) => {
    if (!LAYOUTS.includes(next)) return
    const assistant = useAssistant.getState()
    const models = chatModels(assistant.models)
    if (next > 1) {
      if (!models.length) {
        useUi.getState().toast({ title: t('assistant.panes.need_model'), tone: 'danger' })
        return
      }
      if (assistant.activeId && !assistant.messagesReady) {
        useUi.getState().toast({ title: t('assistant.panes.wait'), tone: 'danger' })
        return
      }
    }
    if (next <= 1) {
      for (const entry of inflight.values()) entry.controller.abort()
      inflight.clear()
      set({ layout: 0, expanded: null, turns: {}, running: 0 })
      persist(get())
      return
    }
    const primaryId = assistant.settings?.activeModelId ?? null
    const panes: MultiModelPane[] = [...get().panes]
    while (panes.length < next - 1) panes.push(newPane(models, primaryId, panes.length))
    for (const [paneId, entry] of inflight) {
      const index = panes.findIndex((pane) => pane.id === paneId)
      if (index >= next - 1) entry.controller.abort()
    }
    const expanded = get().expanded
    set({
      layout: next,
      panes,
      expanded: expanded && panes.slice(0, next - 1).some((pane) => pane.id === expanded) ? expanded : null,
    })
    persist(get())
    await ensurePaneConversations(get, set)
  },

  setPaneModel: (paneId, modelId) => {
    set((state) => ({
      panes: state.panes.map((pane) => pane.id === paneId ? { ...pane, modelId } : pane),
    }))
    persist(get())
  },

  setExpanded: (paneId) => {
    set({ expanded: paneId })
    persist(get())
  },

  closePane: async (paneId) => {
    const pane = get().panes.find((entry) => entry.id === paneId)
    if (!pane) return
    inflight.get(paneId)?.controller.abort()
    inflight.delete(paneId)
    const panes = get().panes.filter((entry) => entry.id !== paneId)
    const layout = layoutForPaneCount(panes.length + 1)
    set((state) => {
      const turns = { ...state.turns }
      delete turns[paneId]
      return {
        panes,
        layout,
        expanded: state.expanded === paneId ? null : state.expanded,
        turns,
      }
    })
    persist(get())
    if (pane.conversationId) await api.assistant.deleteConversation(pane.conversationId).catch(() => undefined)
  },

  loadPane: async (paneId) => {
    const pane = get().panes.find((entry) => entry.id === paneId)
    if (!pane?.conversationId) return
    set((state) => ({
      panes: state.panes.map((entry) => entry.id === paneId ? { ...entry, loading: true, error: null } : entry),
    }))
    try {
      const detail = await api.assistant.conversation(pane.conversationId)
      if (!get().panes.some((entry) => entry.id === paneId)) return
      set((state) => ({
        panes: state.panes.map((entry) => entry.id === paneId
          ? {
            ...entry,
            messages: detail.messages,
            files: Object.fromEntries((detail.attachments ?? []).map((row) => [row.id, row])),
            loading: false,
            error: null,
          }
          : entry),
      }))
    } catch (error) {
      const missing = error instanceof Error && 'status' in error && (error as { status?: number }).status === 404
      set((state) => ({
        panes: state.panes.map((entry) => entry.id === paneId
          ? { ...entry, conversationId: missing ? null : entry.conversationId, loading: false, error: missing ? null : paneFailure(error) }
          : entry),
      }))
    }
  },

  sendAll: async (text) => {
    const assistant = useAssistant.getState()
    if (assistant.turn && !assistant.turn.done) return false
    if (get().running > 0) return false
    const attached = assistant.pending.filter((entry) => entry.status === 'ready' && entry.id).map((entry) => entry.id)
    if (!text.trim() && !attached.length) return false
    if (assistant.pending.some((entry) => entry.status === 'uploading')) {
      useUi.getState().toast({ title: t('assistant.attach.waiting'), tone: 'danger' })
      return false
    }
    const visible = visiblePanes(get())
    if (get().layout < 2 || !visible.length) return false
    const models = chatModels(assistant.models)
    const primary = models.find((model) => model.id === assistant.settings?.activeModelId)
    if (!primary) {
      useUi.getState().toast({ title: t('assistant.panes.need_model'), tone: 'danger' })
      return false
    }
    for (const pane of visible) {
      if (!models.some((model) => model.id === pane.modelId)) {
        useUi.getState().toast({ title: t('assistant.panes.need_model'), tone: 'danger' })
        return false
      }
    }
    const { confirm } = await import('../../components/overlay')
    const agreed = await confirm({
      title: t('assistant.panes.confirm_title'),
      description: t('assistant.panes.confirm_hint', {
        primary: modelLabelOf(primary),
        total: String(visible.length + 1),
      }),
      confirmLabel: t('assistant.panes.confirm_action'),
    })
    if (!agreed) return false
    // A workspace opened before its first message has no thread yet. The first send makes the main one,
    // titled from the reader's own words, and tells the workspace about it before the store opens it —
    // otherwise returning to the thread would read as a different workspace and drop the panes.
    if (!useAssistant.getState().activeId) {
      try {
        const title = text.trim() ? titleFromMessage(text.trim()) : t('assistant.panes.new_title')
        const created = await api.assistant.createConversation(title)
        set({ mainId: created.conversation.id })
        persist(get())
        await useAssistant.getState().openConversation(created.conversation.id)
      } catch (error) {
        useUi.getState().toast({ title: paneFailure(error), tone: 'danger' })
        return false
      }
    }
    await ensurePaneConversations(get, set)
    if (visiblePanes(get()).some((pane) => !pane.conversationId)) {
      useUi.getState().toast({ title: t('assistant.panes.prepare_failed'), tone: 'danger' })
      return false
    }
    for (const pane of visiblePanes(get())) void runPaneTurn(pane, text.trim(), attached, set, get)
    void useAssistant.getState().send(text).then((accepted) => {
      if (!accepted) useUi.getState().toast({ title: t('assistant.panes.main_refused'), tone: 'danger' })
    })
    return true
  },

  stopAll: () => {
    useAssistant.getState().stop()
    for (const entry of inflight.values()) entry.controller.abort()
    set((state) => {
      const turns = { ...state.turns }
      for (const [paneId, turn] of Object.entries(turns)) {
        if (turn && !turn.done) turns[paneId] = { ...turn, done: true, finishedAt: Date.now() }
      }
      return { turns, running: 0 }
    })
  },

  stopPane: (paneId) => {
    inflight.get(paneId)?.controller.abort()
    set((state) => {
      const turn = state.turns[paneId]
      return turn && !turn.done
        ? { turns: { ...state.turns, [paneId]: { ...turn, done: true, finishedAt: Date.now() } } }
        : state
    })
  },
}))

async function runPaneTurn(
  pane: MultiModelPane,
  message: string,
  attachments: string[],
  set: (fn: (state: MultiModelState) => Partial<MultiModelState>) => void,
  get: () => MultiModelState,
): Promise<void> {
  if (!pane.conversationId || !pane.modelId) return
  const token = ++turnSeq
  const controller = new AbortController()
  inflight.set(pane.id, { token, controller })
  set((state) => ({
    running: state.running + 1,
    turns: {
      ...state.turns,
      [pane.id]: {
        token,
        userText: message,
        attachments,
        text: '',
        reasoning: '',
        tools: [],
        sources: [],
        error: null,
        done: false,
        startedAt: Date.now(),
        finishedAt: null,
        usage: null,
      },
    },
  }))
  const apply = (event: ChatStreamEvent): void => {
    set((state) => {
      const turn = state.turns[pane.id]
      if (!turn || turn.token !== token) return state
      switch (event.type) {
        case 'text':
          return { turns: { ...state.turns, [pane.id]: { ...turn, text: turn.text + (event.delta ?? '') } } }
        case 'reasoning':
          return { turns: { ...state.turns, [pane.id]: { ...turn, reasoning: turn.reasoning + (event.delta ?? '') } } }
        case 'usage':
          return { turns: { ...state.turns, [pane.id]: { ...turn, usage: event.usage ?? turn.usage } } }
        case 'error':
          return { turns: { ...state.turns, [pane.id]: { ...turn, error: event.message ?? null } } }
        case 'done':
          return {
            turns: {
              ...state.turns,
              [pane.id]: {
                ...turn,
                done: true,
                finishedAt: Date.now(),
                text: event.finalMessage?.content || turn.text,
                usage: event.finalMessage?.usage ?? turn.usage,
              },
            },
          }
        default:
          return state
      }
    })
  }
  try {
    await streamAssistantTurn(
      {
        conversationId: pane.conversationId,
        message,
        attachments,
        modelId: pane.modelId,
        noTools: true,
      },
      apply,
      controller.signal,
    )
  } catch (error) {
    if (!controller.signal.aborted) {
      set((state) => {
        const turn = state.turns[pane.id]
        return turn && turn.token === token
          ? { turns: { ...state.turns, [pane.id]: { ...turn, error: paneFailure(error), done: true, finishedAt: Date.now() } } }
          : state
      })
    }
  } finally {
    inflight.delete(pane.id)
    set((state) => {
      const turns = { ...state.turns }
      const turn = turns[pane.id]
      if (turn && turn.token === token && !turn.done) turns[pane.id] = { ...turn, done: true, finishedAt: Date.now() }
      return { turns, running: Math.max(0, state.running - 1) }
    })
    if (!controller.signal.aborted) {
      await get().loadPane(pane.id)
      set((state) => {
        const turn = state.turns[pane.id]
        return turn && turn.token === token && turn.done
          ? { turns: { ...state.turns, [pane.id]: null } }
          : state
      })
    }
  }
}
