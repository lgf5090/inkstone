/**
 * The conversation surface: the list, the thread, and the composer.
 *
 * A reply lives in the store, not here, so switching to the memory tab mid-stream does not throw the
 * answer away — the generator keeps writing into the same record and this view re-attaches to it.
 *
 * The thread is deliberately not `.ink-prose`: that class carries the note writer's measure and its
 * 42vh tail padding, which turns a one-line reply into a screen of whitespace. `ink-chat-prose` in
 * `styles/chat.css` keeps the typography and drops the page furniture.
 */
import { Z_INDEX } from '../../lib/z-index'
import { type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent, Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Archive, ArrowUp, ArrowUpRight, Check, Copy, FileText, FolderOpen, Ghost, History, ListChecks, MoreHorizontal, NotebookPen, PanelRight, Paperclip, Pencil, Plus, Search, Settings2, Square, Sparkles, Star, Trash2, X } from 'lucide-react'
import type { AssistantConversation, AssistantMessage, AssistantTurnScope, ChatAttachment } from '@shared/assistant'
import { EPHEMERAL_CONVERSATION_RETENTION_DAYS, SEARCH_NATIVE_PROTOCOLS, looksLikeSearchTool, mcpToolModeFor } from '@shared/assistant'
import { DEBOUNCE } from '@shared/constants'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { COPY_RESET_MS } from '../../lib/motion'
import { dayKey, formatDay, formatInZone } from './time-format'
import { LoadFailure } from './assistant-settings-shared'
import { isImeComposing } from '../../lib/ime'
import { relativeTime } from '../../lib/time'
import { useDebouncedDraft, useMediaQuery } from '../../lib/hooks'
import { compileQuery } from '../../lib/query-match'
import type { MoveMenuFolder } from '../../lib/tree'
import { Button, Divider, IconButton, Spinner } from '../../components/primitives'
import { FilterInput } from '../../components/FilterInput'
import { Input, Textarea } from '../../components/form'
import { Menu, Modal, confirm, prompt, submenuFor, type MenuItem } from '../../components/overlay'
import { api } from '../../lib/api'
import { FolderMoveMenu } from '../folders/FolderMoveMenu'
import { ConversationTabStrip, ConversationTaxonomyPanel, moveMenuTree } from './ChatTaxonomy'
import { AttachmentStrip, CHAT_ATTACHMENT_ACCEPT, CHAT_FOLDER_PICKER_ATTRS, MessageAttachments } from './ChatAttachments'
import {
  detectTrigger,
  filterRows,
  TOOL_TRIGGER_ROWS,
  TriggerPanel,
  TurnPinRow,
  type ActiveTrigger,
  type TriggerRow,
} from './ComposerTriggers'
import {
  ApprovalMenu,
  ControlChip,
  ContextMenu,
  ModelMenu,
  NotePicker,
  PlusMenu,
  ReasoningMenu,
  WebSearchMenu,
  VoiceButton,
} from './ComposerControls'
import { useUi } from '../../store/ui'
import { copyText } from '../../lib/clipboard'
import { useNotes } from '../../store/notes'
import { MarkdownBody } from '../preview/MarkdownBody'
import { PASTE_FILE_MIN_CHARS, useAssistant, type AssistantView } from './assistant-store'
import { MessageMenu, useMessageMenu } from './MessageMenu'
import { AssistantBubble, CHAT_MENTION_LINKS } from './MessageParts'
import { CanvasPanel } from './CanvasPanel'
import { openNote } from './note-links'
import { formatNoteMention } from './note-refs'
import { SelectionBar, SelectionTick, selectedMessages, type MessageSelection } from './SelectionBar'
import { downloadTranscript } from './transcript'
import { downloadTextFile, safeFileName } from '../../lib/export-note'
import { saveConversationAsNote } from './save-to-note'
import { writeConversationDrag } from './conversation-drag'
import { FOLDER_DRAG_TYPE, isNoteDrag, readDraggedNoteIds } from '../../lib/note-drag'
import { ConversationSharePanel } from '../share/ConversationSharePanel'
import { ThreadFinder } from './ThreadFinder'
import { BranchBar } from './BranchBar'
import { fetchWholeConversation } from './thread-fetch'
import { ChatOutline } from './ChatOutline'
import { modelReasoning, reasoningOptions } from './model-reasoning'

/** The composer's "common requests" list: the same openers the empty thread offers, by key. */
/**
 * Writes one conversation out as a Markdown file.
 *
 * Fetched on the press rather than carried in the list: a conversation's rows are only in the store for
 * the thread that is open, and the reader may export one they are not reading.
 */
async function exportConversation(conversationId: string, title: string): Promise<void> {
  const toast = useUi.getState().toast
  try {
    // The whole thread, walked page by page: the export is a document, and a document that stops at
    // the first page of a long conversation is a file the reader cannot tell is incomplete.
    const detail = await fetchWholeConversation(conversationId)
    downloadTranscript(detail.messages, title)
    toast({ title: t('assistant.chat.exported', { title }), tone: 'success' })
  } catch (error) {
    toast({ title: error instanceof Error ? error.message : t('assistant.toast.failed'), tone: 'danger' })
  }
}

/**
 * The same conversation as JSON: the record rather than the document.
 *
 * Everything stored is in it, including the answers the thread can page back to, which the Markdown
 * export leaves out — it is the file a reader keeps when they want the conversation, not a readable
 * copy of it.
 */
async function exportConversationJson(conversationId: string, title: string): Promise<void> {
  const toast = useUi.getState().toast
  try {
    const payload = await api.assistant.conversationExport(conversationId)
    downloadTextFile(`${safeFileName(title || t('assistant.chat.untitled'))}.json`, JSON.stringify(payload, null, 2), 'application/json')
    toast({ title: t('assistant.chat.exported', { title }), tone: 'success' })
  } catch (error) {
    toast({ title: error instanceof Error ? error.message : t('assistant.toast.failed'), tone: 'danger' })
  }
}

/**
 * Fills the `{{name}}` slots a saved skill leaves for the turn it is used in.
 *
 * A skill is a standing arrangement — "summarise {{topic}} in five bullets" — so the slots are the part
 * that changes each time. Asking here rather than sending the braces to the model keeps the template
 * readable as a template and the question readable as a question. A cancelled dialog returns null, and
 * the skill is not inserted at all: a half-filled template is worse than none.
 */
async function fillSkillVariables(text: string): Promise<string | null> {
  const names = [...new Set([...text.matchAll(/\{\{\s*([\p{L}\p{N}_-]{1,40})\s*\}\}/gu)].map((match) => match[1]!))]
  if (!names.length) return text
  let filled = text
  for (const name of names) {
    const value = await prompt({
      title: t('assistant.skills.fill_variable', { name }),
      placeholder: name,
    })
    if (value === null) return null
    const pattern = new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g')
    filled = filled.replace(pattern, value.trim())
  }
  return filled
}

const QUICK_SKILL_KEYS = ['assistant.chat.ask_1', 'assistant.chat.ask_2', 'assistant.chat.ask_3', 'assistant.chat.ask_4'] as const

const SUGGESTION_KEYS = [
  'assistant.chat.ask_1',
  'assistant.chat.ask_2',
  'assistant.chat.ask_3',
  'assistant.chat.ask_4',
] as const

/**
 * Nothing is off-limits when a conversation is filed.
 *
 * The picker takes an exclusion set because moving a folder under its own descendant would delete a
 * subtree; a conversation is one row that goes where it is told, so every branch is a destination.
 */
const NOTHING_EXCLUDED: ReadonlySet<string> = new Set<string>()

/** The `lg` breakpoint asked as a question, so one surface can decide where the conversation list lives. */
const CHAT_RAIL_QUERY = '(min-width: 1024px)'

export function ChatView() {
  const conversations = useAssistant((state) => state.conversations)
  const activeId = useAssistant((state) => state.activeId)
  const messages = useAssistant((state) => state.messages)
  const messagesReady = useAssistant((state) => state.messagesReady)
  const messagesError = useAssistant((state) => state.messagesError)
  // The uploads the composer just accepted are already indexed; the turn's chips read from there.
  const fileIndexForTurn = useAssistant((state) => state.fileIndex)
  const turn = useAssistant((state) => state.turn)
  const remoteStreaming = useAssistant((state) => state.remoteStreaming)
  const send = useAssistant((state) => state.send)
  const loadMcpServers = useAssistant((state) => state.loadMcpServers)
  const newConversation = useAssistant((state) => state.newConversation)
  const openConversation = useAssistant((state) => state.openConversation)
  const stop = useAssistant((state) => state.stop)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [listOpen, setListOpen] = useState(false)
  // Which presentation the conversation list gets — the rail, or the phone drawer. Asked here rather than
  // left to CSS because the list may only be mounted once; see the render below.
  const railWide = useMediaQuery(CHAT_RAIL_QUERY)
  const [finding, setFinding] = useState(false)
  // Selection is a mode, not a modifier: a checkbox on every message all the time is furniture nobody
  // asked for in a conversation, so the ticks exist only while the reader is picking. `null` is "not
  // picking"; an empty set is "picking with nothing chosen yet", which the bar has words for.
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null)
  const picked = useMemo(
    () => (selected ? selectedMessages(messages, selected) : []),
    [messages, selected],
  )
  // These three are handed to every message row, so they keep one identity for the life of the view:
  // a row that is memoised cannot skip its render if a new callback arrives on every token.
  const togglePicked = useCallback((id: string) => setSelected((current) => {
    if (!current) return current
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])
  const startPicking = useCallback((id: string) => setSelected(new Set([id])), [])
  const shareMessage = useCallback((id: string) => setShareScope([id]), [])
  // The turns the share panel is open for: `null` while it is closed. One entry is "share this message"
  // from a turn's own menu, several is the picking bar's — the panel and the link are the same either
  // way, and only the scope differs.
  const [shareScope, setShareScope] = useState<string[] | null>(null)

  const title = activeId
    ? conversations.find((conversation) => conversation.id === activeId)?.title || t('assistant.chat.untitled')
    : t('assistant.chat.new_title')
  // The note this thread came from, so coming back to it still says why it exists. The title is read from
  // the notebook's own cache; a note that is gone leaves the chip with the generic label rather than a
  // blank one.
  const originNoteId = useAssistant((state) => state.conversations.find((entry) => entry.id === state.activeId)?.noteId ?? null)
  const originNoteTitle = useNotes((state) => (originNoteId ? state.notes[originNoteId]?.title : undefined))

  // Which brief this thread is answered under, read from the same row the title came from. A reader who
  // cannot see the project cannot tell why an answer sounds the way it does.
  const projects = useAssistant((state) => state.projects)
  const activeProject = useMemo(() => {
    const projectId = conversations.find((conversation) => conversation.id === activeId)?.projectId
    return projectId ? projects.find((project) => project.id === projectId) ?? null : null
  }, [conversations, activeId, projects])

  // A live reply belongs to its own conversation; only show it in the thread that owns it.
  const turnHere = turn && turn.conversationId === (activeId ?? null) ? turn : null
  // Streaming is about the thread on screen. A reply still arriving for a conversation the reader left
  // must not disable the composer of the one they are in — that was how a background turn locked a
  // fresh thread — while a reply another device is writing is shown but not stoppable from here.
  const streaming = (!!turnHere && !turnHere.done) || remoteStreaming
  const showEmpty = !activeId && !turnHere
  // Days are named in the assistant's own zone, the same one the bubbles print their times in.
  const timezone = useAssistant((state) => state.settings?.timezone)

  useEffect(() => {
    stickToBottom.current = true
    // A conversation switch is a different thread, so nothing that described the one being left may
    // survive it: a picker over rows that are not here, a share scope of another thread's message ids,
    // a find panel marking a transcript that is gone. This is view state, so it is dropped at the view.
    setFinding(false)
    setSelected(null)
    setShareScope(null)
  }, [activeId])

  // The server rows name whose call each third-party chip was, so the transcript reads `Context7 ·
  // query-docs` instead of the namespaced name the model was offered. One read of the reader's own rows,
  // asked once per mount, and `loadMcpServers` says out loud why it is allowed to fail.
  useEffect(() => {
    void loadMcpServers()
  }, [loadMcpServers])

  // The reader is following the thread, so every part of a turn that is still arriving keeps it pinned to
  // the bottom — the reasoning trace included. Left out of the deps, a long think grew off-screen and the
  // reader had to scroll to find the answer.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages.length, turnHere?.text, turnHere?.reasoning, turnHere?.tools.length, turnHere?.error])

  // Older turns are a page away rather than part of the transcript, so the control that fetches them
  // belongs at the top of the list and the scroll position is kept where the reader left it: the new
  // page is inserted above them, and without the correction the thread jumps to its own beginning.
  const messagesHasMore = useAssistant((state) => state.messagesHasMore)
  const messagesLoadingMore = useAssistant((state) => state.messagesLoadingMore)
  const messagesHasNewer = useAssistant((state) => state.messagesHasNewer)
  const loadEarlierMessages = useAssistant((state) => state.loadEarlierMessages)
  const focusMessageId = useAssistant((state) => state.focusMessageId)
  const clearFocusMessage = useAssistant((state) => state.clearFocusMessage)
  const loadEarlier = useCallback(async () => {
    const el = scrollRef.current
    const height = el?.scrollHeight ?? 0
    const top = el?.scrollTop ?? 0
    stickToBottom.current = false
    await loadEarlierMessages()
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight - height + top
    })
  }, [loadEarlierMessages])

  // A search hit opens the thread around its own turn; this is what puts that turn in the middle of the
  // screen instead of leaving the reader at the end of a page they did not ask for.
  useEffect(() => {
    if (!messagesReady || !focusMessageId) return
    const nodes = scrollRef.current?.querySelectorAll<HTMLElement>('[data-chat-anchor]')
    const target = nodes ? Array.from(nodes).find((node) => node.dataset.chatAnchor === focusMessageId) : undefined
    if (target) {
      stickToBottom.current = false
      target.scrollIntoView({ block: 'center' })
    }
    clearFocusMessage()
  }, [messagesReady, focusMessageId, clearFocusMessage])

  // A reader with no model configured cannot ask anything real; the settings tab is the way out.
  const blocked = useAssistant((state) => !state.settings?.activeModelId && !state.settings?.offlineMode)

  // The side panel is the conversation's own workspace, so it has nothing to show until a thread is open.
  const canvasOpen = useAssistant((state) => state.canvasOpen)
  const setCanvasOpen = useAssistant((state) => state.setCanvasOpen)

  // A temporary thread has to say so where the reader is looking, or the one promise the feature makes is
  // the one thing about it they cannot see.
  const ephemeral = useAssistant((state) => state.ephemeral)
  const startTemporaryConversation = useAssistant((state) => state.startTemporaryConversation)

  // Retry re-answers the reader's last message and drops the reply that followed it, so it belongs to
  // the newest answer only — offered on an older one it would silently rewrite a different turn.
  const lastAnswer = useMemo(() => {
    const last = messages.at(-1)
    return last && last.role === 'assistant' ? last : null
  }, [messages])
  // One identity for the whole view: the regenerate control hangs off a memoised row, and a fresh
  // closure per token would be a different prop each time the answer streamed in.
  const retryLast = useCallback(() => {
    void send('', { retry: true })
  }, [send])
  /**
   * Ask any answer again, not only the newest one.
   *
   * A turn in the middle of a thread takes everything after it with it — those turns were written on
   * top of the answer being replaced — so it asks first. The newest answer is the one the bubble's own
   * button already means, and it goes straight through.
   */
  const regenerate = useCallback(async (messageId: string) => {
    const state = useAssistant.getState()
    if (state.messages.at(-1)?.id === messageId) {
      void state.send('', { retry: true })
      return
    }
    const agreed = await confirm({
      title: t('assistant.chat.regenerate_middle_title'),
      description: t('assistant.chat.regenerate_middle_hint'),
      confirmLabel: t('assistant.chat.regenerate'),
      tone: 'danger',
    })
    if (agreed) void state.send('', { retry: true, messageId })
  }, [])
  /**
   * The one retry control handed to every answer row.
   *
   * A row is memoised on its `onRetry` identity, so a closure built per message would arrive as a new prop
   * on every re-render of the view and every historical bubble would be parsed again. The message id is
   * passed in instead, and which door the press opens is read from the store's own rows: the newest answer
   * is the plain retry, an older one confirms first.
   */
  const retryAnswer = useCallback((messageId: string) => {
    if (useAssistant.getState().messages.at(-1)?.id === messageId) {
      retryLast()
      return
    }
    void regenerate(messageId)
  }, [regenerate, retryLast])

  // The outline's stops are the turns the reader wrote — the only fixed points in a thread whose answers
  // vary in length. A new array on every store write would re-register the outline's scroll listener on
  // each streamed token, so it is derived only when the rows themselves change.
  const anchors = useMemo(
    () => messages.filter((message) => message.role === 'user').map((message) => ({ id: message.id, text: message.content })),
    [messages],
  )

  return (
    <div className="flex h-full min-h-0">
      {/* One list, one mount. The rail used to draw a copy and the phone drawer another, with CSS deciding
          which was visible — but a hidden copy still runs its own effects and keeps its own row menu and
          rename dialog, so what was opened in one was invisible in the other and the taxonomy was fetched
          twice. The container is chosen from the same width the `lg` token means, so the rail keeps its
          place in the flex row and the drawer keeps the modal's focus, Escape and backdrop behaviour. */}
      {railWide ? (
        <aside className="flex w-64 shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
          <ConversationList activeId={activeId} onPick={() => setListOpen(false)} />
        </aside>
      ) : (
        <Modal open={listOpen} onClose={() => setListOpen(false)} title={t('assistant.chat.history')} width={360} bodyClassName="p-0">
          <div className="h-[60vh]">
            <ConversationList activeId={activeId} onPick={() => setListOpen(false)} />
          </div>
        </Modal>
      )}

      {/* Ctrl/Cmd+F is the reader's own reflex for this box, so it opens the thread's own find instead of
          the browser's bar over a page that is one conversation. */}
      <section
        className="relative flex min-w-0 flex-1 flex-col"
        onKeyDown={(event) => {
          // This box wraps the composer, so every keystroke in a half-written Chinese sentence bubbles
          // through here — and Escape is the key the input method is holding to drop that candidate.
          if (isImeComposing(event)) return
          if (event.key.toLowerCase() === 'f' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            setFinding(true)
          }
          if (event.key === 'Escape' && finding) setFinding(false)
        }}
      >
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2">
          <IconButton label={t('assistant.chat.history')} size="sm" className="lg:hidden" onClick={() => setListOpen(true)}>
            <History size={15} />
          </IconButton>
          <span className="min-w-0 truncate text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {title}
          </span>
          {activeProject && (
            <span
              className="shrink-0 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-quaternary)]"
              title={t('assistant.chat.in_project', { name: activeProject.name })}
            >
              {activeProject.name}
            </span>
          )}
          {originNoteId && (
            <button
              type="button"
              onClick={() => openNote(originNoteId)}
              title={t('assistant.chat.from_note')}
              className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]"
            >
              <NotebookPen size={10} className="shrink-0" />
              <span className="max-w-[140px] truncate">{originNoteTitle || t('assistant.chat.from_note')}</span>
            </button>
          )}
          {ephemeral && (
            <span
              className="shrink-0 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-quaternary)]"
              title={t('assistant.chat.temporary_hint', { days: EPHEMERAL_CONVERSATION_RETENTION_DAYS })}
            >
              {t('assistant.chat.temporary')}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <IconButton
              label={t('assistant.chat.temporary_start')}
              size="sm"
              disabled={streaming}
              // The thread on screen is emptied by this press, so it is asked for first — the same
              // courtesy the row's own delete control pays. A native dialog is not an option.
              onClick={() => {
                void confirm({
                  title: t('assistant.chat.temporary_confirm_title'),
                  description: t('assistant.chat.temporary_confirm_hint', { days: EPHEMERAL_CONVERSATION_RETENTION_DAYS }),
                  confirmLabel: t('assistant.chat.temporary_start'),
                  tone: 'danger',
                }).then((agreed) => {
                  if (agreed) startTemporaryConversation()
                })
              }}
            >
              <Ghost size={15} />
            </IconButton>
            <IconButton
              label={t('assistant.canvas.title')}
              size="sm"
              active={canvasOpen}
              disabled={!activeId}
              onClick={() => setCanvasOpen(!canvasOpen)}
            >
              <PanelRight size={15} />
            </IconButton>
            <IconButton active={finding} label={t('assistant.chat.find')} size="sm" onClick={() => setFinding((open) => !open)}>
              <Search size={15} />
            </IconButton>
            <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={newConversation} disabled={streaming}>
              {t('assistant.chat.new')}
            </Button>
          </div>
        </div>

        <BranchBar conversationId={activeId} />

        <div
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
          className="no-scrollbar min-h-0 flex-1 overflow-y-auto"
        >
          {showEmpty ? (
            <EmptyChat
              onPick={(text) => {
                void send(text)
              }}
            />
          ) : messagesError ? (
            // A refused thread is not an empty one. Falling through would show the reader their own
            // conversation as a blank page inviting them to start talking.
            <div className="px-4 py-16">
              <LoadFailure messageKey="assistant.chat.load_failed" onRetry={() => { if (activeId) void openConversation(activeId) }} />
            </div>
          ) : !messagesReady && !turnHere ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-4 py-5 md:px-6">
              {messagesHasMore && (
                <div className="flex justify-center">
                  <Button size="sm" variant="ghost" disabled={messagesLoadingMore} onClick={() => void loadEarlier()}>
                    {messagesLoadingMore ? <Spinner /> : t('assistant.chat.load_earlier')}
                  </Button>
                </div>
              )}
              {messagesHasNewer && activeId && (
                <div className="flex justify-center">
                  <Button size="sm" variant="secondary" onClick={() => void openConversation(activeId)}>
                    {t('assistant.chat.jump_latest')}
                  </Button>
                </div>
              )}
              {messages.map((message, index) => {
                // A long thread crosses days, and a run of bubbles with no date is a transcript the
                // reader has to guess the shape of. The separator belongs to the turn that starts the day.
                const previous = messages[index - 1]
                const startsDay = !previous || dayKey(previous.createdAt, timezone) !== dayKey(message.createdAt, timezone)
                return (
                <Fragment key={message.id}>
                {startsDay && (
                  <div className="flex items-center gap-2 py-1">
                    <span aria-hidden className="h-px flex-1 bg-[var(--border-subtle)]" />
                    <time
                      // A separator's content is dropped by assistive tech, and this date is the only
                      // thing the reader learns from the row — so it is a real time element, not a
                      // separator carrying text.
                      dateTime={new Date(message.createdAt).toISOString()}
                      className="shrink-0 text-[length:var(--text-10-5)] uppercase tracking-wide text-[var(--text-quaternary)]"
                    >
                      {formatDay(message.createdAt, timezone)}
                    </time>
                    <span aria-hidden className="h-px flex-1 bg-[var(--border-subtle)]" />
                  </div>
                )}
                <MessageRow
                  key={message.id}
                  message={message}
                  busy={streaming}
                  // Every stored answer can be asked again; the newest one is the plain retry, an older
                  // one confirms that the turns below it will be removed with it.
                  onRetry={message.role === 'assistant' && !streaming ? retryAnswer : undefined}
                  canContinue={canContinueAnswer(message, streaming, lastAnswer?.id ?? null)}
                  onStartPicking={startPicking}
                  onShare={shareMessage}
                  selection={selected ? { active: true, checked: selected.has(message.id), onToggle: () => togglePicked(message.id) } : undefined}
                />
                </Fragment>
                )
              })}
              {turnHere && (
                <>
                  {turnHere.userText && (
                    <UserBubble
                      text={turnHere.userText}
                      attachments={turnHere.attachments}
                      fileIndex={fileIndexForTurn}
                    />
                  )}
                  <AssistantBubble
                    text={turnHere.text}
                    reasoning={turnHere.reasoning}
                    tools={turnHere.tools}
                    error={turnHere.error}
                    streaming={!turnHere.done}
                    stage={turnHere.stage}
                  />
                </>
              )}
              {remoteStreaming && !turnHere && (
                <div className="flex flex-col gap-1.5">
                  <AssistantBubble text="" reasoning="" tools={[]} error={null} streaming stage={undefined} />
                  {/* Said out loud because the alternative is a box that will not take a question and
                      never says why. The stop control in the composer is the way out of the wait. */}
                  <p role="status" className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                    {t('assistant.chat.remote_streaming')}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {selected && (
          <SelectionBar
            picked={picked}
            title={title}
            onShare={() => setShareScope(picked.map((message) => message.id))}
            onDelete={() => {
              void confirm({
                title: t('assistant.chat.select_delete_title'),
                description: t('assistant.chat.select_delete_hint'),
                confirmLabel: t('common.delete'),
                tone: 'danger',
              }).then((agreed) => {
                if (!agreed) return
                void useAssistant.getState().removeMessages(picked.map((message) => message.id))
                setSelected(null)
              })
            }}
            onExit={() => setSelected(null)}
          />
        )}
        <ChatComposer
          streaming={streaming}
          sendOnEnter={useAssistant((state) => state.settings?.sendOnEnter ?? true)}
          onSend={send}
          onStop={stop}
          disabled={blocked}
        />
        <ChatOutline anchors={anchors} scrollerRef={scrollRef} />
        {finding && (
          <ThreadFinder
            scroller={scrollRef}
            // The stored rows plus a finished answer that is not adopted into them yet. A stream still
            // arriving is deliberately not counted: the marks are DOM edits inside the subtree React is
            // writing into, so they are remade when the text settles rather than on every token.
            revision={transcriptRevision(messages, turnHere)}
            onClose={() => setFinding(false)}
          />
        )}
      </section>

      {canvasOpen && activeId && <CanvasPanel />}

      {activeId && shareScope && (
        <ConversationSharePanel
          conversationId={activeId}
          title={title}
          messageIds={shareScope}
          onClose={() => setShareScope(null)}
        />
      )}
    </div>
  )
}

/**
 * Whether the reader can pick this answer up where it stopped.
 *
 * The status alone was the rule, and it hid the control on exactly the answer that needs it: a reply cut
 * off at the output cap is filed as an error, but the half-sentence above that notice is the thing worth
 * finishing. So the question is asked of the row's own words instead — an answer with nothing written in
 * it has nothing to carry on from, whichever flag it carries. The worker applies the same test, and a
 * reader who somehow asks for the other kind is told so rather than left watching an empty turn.
 */
export function canContinueAnswer(message: AssistantMessage, streaming: boolean, lastAnswerId: string | null): boolean {
  return message.role === 'assistant'
    && !streaming
    && message.id === lastAnswerId
    && (message.status !== 'error' || message.content.trim().length > 0)
}

/**
 * Which transcript the find panel's marks are sitting on, told as the one number it takes.
 *
 * Summed magnitudes could not answer that: one new message and one typed character move
 * `messages.length + text.length` by the same amount, and a late attachment moves it by nothing, so the
 * marks went stale under a reader who had no way to ask for them back. Identity answers instead — how many
 * rows, which row is last and what is on it, and whether a turn is still being written — folded into a
 * number because the panel wants one and this runs beside a streaming answer.
 */
export function transcriptRevision(messages: readonly AssistantMessage[], turn: { done: boolean, text: string } | null): number {
  const last = messages.at(-1)
  const key = [
    messages.length,
    last?.id ?? '',
    last?.content.length ?? 0,
    last?.attachments?.length ?? 0,
    last?.tools.length ?? 0,
    // A reply still arriving is deliberately not counted: the marks are DOM edits inside the subtree
    // React is writing into, so they are remade when it settles rather than on every token.
    turn ? (turn.done ? `settled:${turn.text.length}` : 'streaming') : 'idle',
  ].join('|')
  let hash = 0
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) | 0
  return hash
}

/**
 * One stored turn.
 *
 * Memoised because a streaming answer lives beside this list: every token re-renders the view that owns
 * the composer, and without this every historical Markdown bubble in a long thread was parsed and laid
 * out again for each one. The props that can actually change a row are the row itself and the few
 * states that show on it. The callbacks are compared because the row passes one through to its own
 * controls — which is why the view hands them over with a single identity rather than a closure per row.
 */
export const MessageRow = memo(function MessageRow({ message, onRetry, canContinue = false, busy = false, selection, onStartPicking, onShare }: {
  message: AssistantMessage
  /** The row answers for its own id, so one callback serves the whole list. */
  onRetry?: (messageId: string) => void
  /** Only the newest settled answer: continuing anything else would append to a turn already read past. */
  canContinue?: boolean
  busy?: boolean
  selection?: MessageSelection
  onStartPicking?: (messageId: string) => void
  onShare?: (messageId: string) => void
}) {
  // A finished answer can be asked again; a half one is only ever resumed by its own retry.
  const retryLabel = message.status === 'complete' ? 'assistant.chat.regenerate' : 'assistant.chat.retry'
  const fileIndex = useAssistant((state) => state.fileIndex)
  if (message.role === 'user') {
    // The id is also the outline's anchor: a stored turn is a fixed point in the thread, while the live
    // turn below — which the server has not named yet — is not.
    return (
      <UserBubble
        text={message.content}
        attachments={message.attachments ?? []}
        fileIndex={fileIndex}
        messageId={message.id}
        busy={busy}
        createdAt={message.createdAt}
        anchorId={message.id}
        scopes={message.scopes ?? []}
        selection={selection}
        onStartPicking={onStartPicking}
        onShare={onShare}
      />
    )
  }
  return (
    <AssistantBubble
      text={message.content}
      // A trace restored from the row is the one this answer was written by: the fold is skipped only
      // when the model never reported any.
      reasoning={message.reasoning ?? ''}
      tools={message.tools}
      error={message.status === 'error' ? message.error : null}
      cancelled={message.status === 'cancelled'}
      streaming={false}
      stage={undefined}
      messageId={message.id}
      createdAt={message.createdAt}
      onRetry={onRetry ? () => onRetry(message.id) : undefined}
      canContinue={canContinue}
      retryLabel={retryLabel}
      usage={message.usage}
      sources={message.sources}
      attachments={message.attachments ?? []}
      feedback={message.feedback}
      onRate={message.role === 'assistant' ? (verdict) => void useAssistant.getState().rateAnswer(message.id, verdict) : undefined}
      selection={selection}
      onStartPicking={onStartPicking}
      onShare={onShare}
      durationMs={message.durationMs ?? 0}
      modelLabel={message.modelLabel ?? ''}
      versionCount={message.versionCount ?? 0}
      loadVersions={() => useAssistant.getState().loadAnswerVersions(message.id)}
      onActivate={(versionId) => void useAssistant.getState().activateAnswerVersion(message.id, versionId)}
    />
  )
}, (previous, next) => previous.message === next.message
  && previous.busy === next.busy
  && previous.canContinue === next.canContinue
  && previous.onRetry === next.onRetry
  && previous.onStartPicking === next.onStartPicking
  && previous.onShare === next.onShare
  // The selection object is rebuilt by the list on every render; what a row draws from it is these two.
  && (previous.selection?.active ?? false) === (next.selection?.active ?? false)
  && (previous.selection?.checked ?? false) === (next.selection?.checked ?? false))

/**
 * One of the reader's own messages, and what they may do with it.
 *
 * The row is theirs alone — copy it back out, retype it and let the answer be written again from the new
 * words, or take the turn back — so the three controls hang under the bubble rather than beside the
 * answer's footer. They are drawn only for a message that is stored: the live turn's copy of the same
 * words has no row to edit and no answer to displace yet, and `busy` is the turn that is still being
 * written, which the server refuses to have re-taken under it.
 */
export function UserBubble({
  text,
  attachments = [],
  fileIndex = {},
  messageId,
  busy = false,
  createdAt,
  anchorId,
  scopes = [],
  selection,
  onStartPicking,
  onShare,
}: {
  text: string
  attachments?: string[]
  fileIndex?: Record<string, ChatAttachment>
  messageId?: string
  busy?: boolean
  /** When the reader wrote it; absent on the live turn, which has no row yet. */
  createdAt?: number
  anchorId?: string
  /** What this turn was allowed to read, as it was stored with the question. */
  scopes?: AssistantTurnScope[]
  selection?: MessageSelection
  onStartPicking?: (messageId: string) => void
  onShare?: (messageId: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const timezone = useAssistant((state) => state.settings?.timezone)
  // Whether this is the newest stored turn, subscribed rather than read out of the store during render:
  // the dialog offers a branch as soon as something exists below the message to keep, and a `getState()`
  // here would be a snapshot that only an unrelated re-render of the row ever refreshed. Selected as one
  // boolean per row, so the row that stops being the newest is the only one that redraws and the memo
  // above keeps its win.
  const isLatestMessage = useAssistant((state) => state.messages.at(-1)?.id === messageId)
  const toast = useUi((state) => state.toast)
  const menu = useMessageMenu()
  const removable = !!messageId && !!text
  // The pair goes together, so the question the reader is about to lose is spelled out in the dialog
  // rather than deleted on a single press. Both the hover row and the menu reach it through here.
  const askToDelete = () => {
    if (!messageId) return
    void confirm({
      title: t('assistant.chat.delete_message_title'),
      description: t('assistant.chat.delete_message_hint'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    }).then((agreed) => {
      if (agreed) void useAssistant.getState().removeMessage(messageId)
    })
  }
  return (
    <div
      data-chat-anchor={anchorId}
      onContextMenu={text ? menu.onContextMenu : undefined}
      className="flex animate-[ink-fade-in_var(--dur-base)_var(--ease-out)] items-start justify-end gap-2"
    >
      {selection?.active && messageId && (
        <SelectionTick
          label={t('assistant.chat.select_messages')}
          checked={selection.checked}
          onToggle={selection.onToggle}
        />
      )}
      <div className="group flex max-w-[85%] flex-col items-end gap-1">
        {/* The pins were a choice about this one question, and they outlive the composer chips that made
            them: a reader coming back to an answer that only knew one note should be able to see why. */}
        {scopes.length > 0 && (
          <div className="flex flex-wrap items-center justify-end gap-1" aria-label={t('assistant.chat.scoped_to')}>
            <span className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">
              {t('assistant.chat.scoped_to')}
            </span>
            {scopes.map((scope) => (
              <span
                key={`${scope.kind}:${scope.id}`}
                className="max-w-[180px] truncate rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-quaternary)]"
                title={scope.name}
              >
                {scope.name}
              </span>
            ))}
          </div>
        )}
        {attachments.length > 0 && <MessageAttachments ids={attachments} index={fileIndex} />}
        {text && (
          <div className="break-words rounded-[var(--r-lg)] rounded-br-[var(--r-xs)] bg-[var(--accent-soft)] px-3 py-2 text-[length:var(--text-13-5)] leading-relaxed text-[var(--text-primary)]">
            {/* The reader's own words are Markdown too: a `[[note]]` the composer inserted, a fenced
                block pasted in, a list typed out — all of them mean what they say. Formulas, diagrams
                and charts are declined because a chat bubble is a sentence, not a document, and the
                three of them are the only channels that would pull a library in to draw one. */}
            <MarkdownBody
              source={text}
              className="ink-chat-prose ink-chat-authored"
              math={false}
              mermaid={false}
              chart={false}
              links={CHAT_MENTION_LINKS}
            />
          </div>
        )}
        {text && (
          <div className="flex items-center gap-0.5 transition-opacity duration-[var(--dur-fast)] md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
            {createdAt && (
              <time
                dateTime={new Date(createdAt).toISOString()}
                className="mr-1 shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]"
              >
                {formatInZone(createdAt, timezone)}
              </time>
            )}
            <IconButton
              size="sm"
              label={copied ? t('assistant.chat.copied') : t('assistant.chat.copy')}
              onClick={() => {
                void copyText(text).then((ok) => {
                  if (!ok) {
                    toast({ title: t('preview.could_not_copy'), tone: 'danger' })
                    return
                  }
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), COPY_RESET_MS)
                })
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </IconButton>
            {removable && (
              <>
                <IconButton size="sm" label={t('assistant.chat.edit_message')} disabled={busy} onClick={() => setDraft(text)}>
                  <Pencil size={14} />
                </IconButton>
                <IconButton size="sm" label={t('assistant.chat.delete_message')} disabled={busy} onClick={askToDelete}>
                  <Trash2 size={14} />
                </IconButton>
              </>
            )}
            <span ref={menu.buttonRef}>
              <IconButton size="sm" label={t('assistant.chat.message_actions')} onClick={menu.openFromButton}>
                <MoreHorizontal size={14} />
              </IconButton>
            </span>
          </div>
        )}
      </div>
      <MessageMenu
        menu={menu}
        target={{
          role: 'user',
          text,
          ...(removable ? { onEdit: () => setDraft(text), onDelete: askToDelete } : {}),
          ...(messageId ? { onFork: () => void useAssistant.getState().forkFrom(messageId) } : {}),
          ...(messageId && onStartPicking ? { onSelect: () => onStartPicking(messageId) } : {}),
          ...(messageId && onShare ? { onShare: () => onShare(messageId) } : {}),
        }}
      />
      {draft !== null && messageId && (
        <EditMessageDialog
          text={draft}
          // A branch is only worth offering when there is something below this turn to keep, which the
          // subscribed row above answers without waiting for an unrelated render.
          canBranch={!isLatestMessage}
          onClose={() => setDraft(null)}
          onSave={(content, keepBranch) => {
            setDraft(null)
            // The turn re-answers itself: the dialog has nothing left to hold, and the replaced answer
            // arrives in the thread like any other.
            const edit = useAssistant.getState().editMessage
            if (keepBranch) void edit(messageId, content, { keepBranch: true })
            else void edit(messageId, content)
          }}
        />
      )}
    </div>
  )
}

/**
 * Retyping one of the reader's own messages.
 *
 * The words are the only thing being edited, so this is a box and nothing else — but the answer that hung
 * below them was written from the old text and the thread is asked again from here, which the note under
 * the box says out loud: saving is not a silent rewrite of a transcript.
 */
function EditMessageDialog({ text, canBranch = false, onClose, onSave }: {
  text: string
  /** Whether the turns below this one can be kept as a branch. False for the newest turn. */
  canBranch?: boolean
  onClose: () => void
  onSave: (content: string, keepBranch: boolean) => void
}) {
  const [value, setValue] = useState(text)
  const trimmed = value.trim()
  const unchanged = !trimmed || trimmed === text.trim()
  return (
    <Modal
      open
      onClose={onClose}
      title={t('assistant.chat.edit_message_title')}
      description={t('assistant.chat.edit_message_hint')}
      width={480}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          {canBranch && (
            <Button variant="ghost" disabled={unchanged} onClick={() => onSave(trimmed, true)}>
              {t('assistant.chat.edit_keep_branch')}
            </Button>
          )}
          <Button variant="primary" disabled={unchanged} onClick={() => onSave(trimmed, false)}>
            {t('assistant.chat.edit_message_save')}
          </Button>
        </>
      )}
    >
      <Textarea
        autoFocus
        rows={6}
        aria-label={t('assistant.chat.edit_message_title')}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    </Modal>
  )
}

/**
 * Exported so a test can pin the conversation box to the shared filter box. `ChatView` mounts one copy at a
 * time — the rail on a wide screen, the drawer on a narrow one — because two copies each kept their own row
 * menu and rename dialog out of the other's sight.
 */
export function ConversationList({ activeId, onPick }: { activeId: string | null, onPick: () => void }) {
  const conversations = useAssistant((state) => state.conversations)
  const query = useAssistant((state) => state.conversationQuery)
  const setQuery = useAssistant((state) => state.setConversationQuery)
  const openConversation = useAssistant((state) => state.openConversation)
  const newConversation = useAssistant((state) => state.newConversation)
  const renameConversation = useAssistant((state) => state.renameConversation)
  const loadTaxonomy = useAssistant((state) => state.loadTaxonomy)
  const hasMore = useAssistant((state) => state.conversationsHasMore)
  const loadingMore = useAssistant((state) => state.conversationsLoadingMore)
  const loadMore = useAssistant((state) => state.loadMoreConversations)
  const picks = useAssistant((state) => state.conversationPicks)
  const startPicking = useAssistant((state) => state.startPickingConversations)
  const togglePick = useAssistant((state) => state.toggleConversationPick)
  const cancelPicking = useAssistant((state) => state.cancelConversationPicks)
  const archivePicked = useAssistant((state) => state.archivePickedConversations)
  const deletePicked = useAssistant((state) => state.deletePickedConversations)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<AssistantConversation | null>(null)
  const [draft, setDraft] = useState('')
  // The box stops typing for `DEBOUNCE.search` before the settled text reaches the store, because a
  // keystroke that commits it there asks the server for the whole list again.
  const { draft: searchDraft, setDraft: setSearchDraft } = useDebouncedDraft(query, (next) => {
    void setQuery(next)
  }, DEBOUNCE.search)
  // The shared box's own grammar check. Matching is the server's, so what the box can answer here is
  // whether what was typed is a pattern at all — see the note on `FilterInput` below.
  const searchQuery = useMemo(() => compileQuery(searchDraft), [searchDraft])

  // Counts move whenever a conversation is filed or a turn adds one, so the tree rides along with it.
  useEffect(() => {
    void loadTaxonomy()
  }, [loadTaxonomy, conversations.length])

  // A restored flag tab is already drawing its shortlist, and `setListTab` only asks for one when the
  // reader clicks, so the list they left open has to be fetched here, once, on the way in.
  useEffect(() => {
    const state = useAssistant.getState()
    if (state.listTab === 'starred' || state.listTab === 'pinned') void state.loadFlagged()
  }, [])

  // The list is sorted by the server; a pinned row would reappear on every page of a keyset cursor,
  // so the order is applied here where the whole set is in hand.
  const ordered = useMemo(
    () => [...conversations].sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt),
    [conversations],
  )

  return (
    // min-w-0 is not decoration: as a flex item this column would otherwise grow to its content's
    // min-content width and paint the search box and the row menus across the thread.
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      {/* The reference project puts a start-a-chat button at the head of the list as well as in the
          thread header, and a reader scanning the list looks for it there. */}
      <div className="flex flex-col gap-2 p-2 pt-1">
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" block icon={<Plus size={14} />} onClick={() => { newConversation(); onPick() }}>
            {t('assistant.chat.new')}
          </Button>
          {/* Picking is a mode the reader enters on purpose: a tick on every row all the time is
              furniture, and the one action it enables is not one anybody reaches for daily. */}
          <IconButton
            label={picks ? t('assistant.chat.pick_cancel') : t('assistant.chat.pick_start')}
            size="sm"
            variant={picks ? 'secondary' : 'ghost'}
            active={!!picks}
            onClick={() => (picks ? cancelPicking() : startPicking())}
          >
            <ListChecks size={14} />
          </IconButton>
        </div>
        {/* The same box the notebook's rails draw: search icon, clear control, Escape that takes the text
            back out, and the shared refusal when what was typed is not a pattern. The chrome is shared,
            the matching is not — this list is answered by the server's `LIKE` over the title and the
            message bodies (`src/worker/assistant/store.ts`), and conversations are not in the omnisearch
            index, which covers `notes` only. So the settled text is handed on verbatim, exactly as the
            bare `Input` did: `/expression/` is a promise the conversation endpoint has yet to keep, and
            the grammar check is the part a box with a server behind it can honestly offer. */}
        <FilterInput
          size="sidebar"
          className="mt-0"
          value={searchDraft}
          onChange={setSearchDraft}
          query={searchQuery}
          label={t('assistant.chat.search')}
          placeholder={t('assistant.chat.search')}
        />
      </div>
      <ConversationTabStrip />
      <ConversationTaxonomyPanel onOpen={onPick} />
      <nav
        aria-label={t('assistant.chat.list')}
        // The list is paged, so reaching the bottom is what asks for the next page. The margin is a
        // screenful short of the end, which is when a reader is close enough to need it.
        onScroll={(event) => {
          const el = event.currentTarget
          if (hasMore && !loadingMore && el.scrollHeight - el.scrollTop - el.clientHeight < 240) void loadMore()
        }}
        className="no-scrollbar min-h-0 w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 pb-2"
      >
        {!ordered.length ? (
          <p className="px-2 py-6 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
            {query.trim() ? t('assistant.chat.no_matches') : t('assistant.chat.empty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-px">
            {ordered.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeId}
                menuOpen={menuFor === conversation.id}
                onToggleMenu={() => setMenuFor(menuFor === conversation.id ? null : conversation.id)}
                onCloseMenu={() => setMenuFor(null)}
                picking={!!picks}
                picked={!!picks?.has(conversation.id)}
                onTogglePick={() => togglePick(conversation.id)}
                onOpen={() => {
                  // A search row carries the turn its words were found in; opening the thread lands there.
                  void openConversation(conversation.id, conversation.match ? { focusMessageId: conversation.match.messageId } : undefined)
                  onPick()
                }}
                onRename={() => {
                  setDraft(conversation.title)
                  setRenaming(conversation)
                }}
              />
            ))}
          </ul>
        )}
        {loadingMore && (
          <div className="flex justify-center py-3">
            <Spinner />
          </div>
        )}
      </nav>
      {picks && (
        <div className="flex shrink-0 items-center gap-1 border-t border-[var(--border-subtle)] px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('assistant.chat.picked', { count: picks.size })}
          </span>
          <IconButton
            label={t('assistant.chat.archive')}
            size="sm"
            disabled={!picks.size}
            onClick={() => void archivePicked()}
          >
            <Archive size={13} />
          </IconButton>
          <IconButton
            label={t('assistant.chat.delete')}
            size="sm"
            disabled={!picks.size}
            onClick={() => {
              void confirm({
                title: t('assistant.chat.pick_delete_title'),
                description: t('assistant.chat.pick_delete_hint', { count: picks.size }),
                confirmLabel: t('common.delete'),
                tone: 'danger',
              }).then((agreed) => {
                if (agreed) void deletePicked()
              })
            }}
          >
            <Trash2 size={13} />
          </IconButton>
        </div>
      )}

      <Modal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title={t('assistant.chat.rename')}
        width={380}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>{t('common.cancel')}</Button>
            <Button
              onClick={() => {
                if (renaming && draft.trim()) void renameConversation(renaming.id, draft.trim())
                setRenaming(null)
              }}
            >
              {t('common.save')}
            </Button>
          </>
        )}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={200}
          autoFocus
          aria-label={t('assistant.chat.rename')}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (renaming && draft.trim()) void renameConversation(renaming.id, draft.trim())
              setRenaming(null)
            }
          }}
        />
      </Modal>
    </div>
  )
}

/**
 * One row of the list, with the menu anchor of its own.
 *
 * The anchor has to live here: a single ref shared by every row ends up pointing at whichever row
 * rendered last, so the menu of the first conversation opens beside the last one.
 */
function ConversationRow({
  conversation,
  active,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onOpen,
  onRename,
  picking = false,
  picked = false,
  onTogglePick,
}: {
  conversation: AssistantConversation
  active: boolean
  menuOpen: boolean
  onToggleMenu: () => void
  onCloseMenu: () => void
  onOpen: () => void
  onRename: () => void
  /** The list is in picking mode: a press ticks the row instead of opening it. */
  picking?: boolean
  picked?: boolean
  onTogglePick?: () => void
}) {
  const pinConversation = useAssistant((state) => state.pinConversation)
  const deleteConversation = useAssistant((state) => state.deleteConversation)
  const folderNodes = useAssistant((state) => state.folderNodes)
  const tagNodes = useAssistant((state) => state.tagNodes)
  const moveConversation = useAssistant((state) => state.moveConversation)
  const toggleConversationTag = useAssistant((state) => state.toggleConversationTag)
  const starConversation = useAssistant((state) => state.starConversation)
  const archiveConversation = useAssistant((state) => state.archiveConversation)
  const attachNewTag = useAssistant((state) => state.attachNewTag)
  const projects = useAssistant((state) => state.projects)
  const setConversationProject = useAssistant((state) => state.setConversationProject)
  const anchor = useRef<HTMLSpanElement>(null)
  const [sharing, setSharing] = useState(false)
  const title = conversation.title || t('assistant.chat.untitled')
  const assigned = new Set((conversation.tags ?? []).map((tag) => tag.id))

  // The picker names the thing being moved. A conversation carries no folder mark of its own, and it
  // moves whole, so — unlike a folder being moved into its own descendant — no branch is off-limits.
  const moveSubject: MoveMenuFolder = { id: conversation.id, name: title, children: [], directNotes: 0 }

  const tagItems = [
    ...tagNodes.map((tag) => ({
      id: `tag-${tag.id}`,
      label: tag.name,
      checked: assigned.has(tag.id),
      onSelect: () => void toggleConversationTag(conversation.id, tag.id, !assigned.has(tag.id)),
    })),
    {
      id: 'tag-new',
      label: t('assistant.chat.new_tag'),
      separatorBefore: tagNodes.length > 0,
      onSelect: () => {
        void prompt({ title: t('assistant.chat.new_tag'), placeholder: t('assistant.chat.tag_name') })
          .then(async (name) => {
            if (!name?.trim()) return
            // Brought in on the click rather than with the row: the tags module's own graph reaches the
            // note store and the drawing editors, and none of that is something this menu needs to draw.
            const { createTag } = await import('../tags/tagMutations')
            // The tags feature's own entry point, which is the part that can say what went wrong: it
            // refuses a name a tag cannot be called, answers a name already taken with the tag that
            // exists, and toasts either way. Nothing here catches the server's answer and hides it.
            const tagId = createTag(name)
            if (tagId) void attachNewTag(conversation.id, tagId)
          })
      },
    },
  ]

  // A conversation answers under one project's brief at a time, so the picker is a flat list with the
  // current one ticked and a way back out. An empty list says why rather than opening onto nothing.
  const projectItems: MenuItem[] = projects.length
    ? [
        ...(conversation.projectId
          ? [{ id: 'project-out', label: t('assistant.projects.remove_conversation'), onSelect: () => void setConversationProject(conversation.id, null) }]
          : []),
        ...projects.map((project) => ({
          id: `project-${project.id}`,
          label: project.name,
          checked: conversation.projectId === project.id,
          onSelect: () => void setConversationProject(conversation.id, project.id),
        })),
      ]
    : [{ id: 'project-empty', label: t('assistant.projects.move_needs_project'), disabled: true }]

  return (
    <li
      className="group relative"
      draggable
      title={t('assistant.chat.drop_into_folder')}
      onDragStart={(event) => writeConversationDrag(event, conversation.id)}
      onContextMenu={(event) => { event.preventDefault(); onToggleMenu() }}
    >
      <button
        type="button"
        onClick={picking ? onTogglePick : onOpen}
        aria-pressed={picking ? picked : undefined}
        className={cn(
          'flex w-full flex-col items-start gap-0.5 rounded-[var(--r-sm)] px-2 py-1.5 pr-7 text-left',
          'transition-colors duration-[var(--dur-fast)]',
          active
            ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
          picking && picked && 'bg-[var(--accent-soft)] text-[var(--text-primary)]',
        )}
      >
        <span className="flex w-full min-w-0 items-center gap-1">
          {picking && (
            <span
              aria-hidden
              className={cn(
                'flex size-3.5 shrink-0 items-center justify-center rounded-[var(--r-xs)] border',
                picked ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]' : 'border-[var(--border-strong)]',
              )}
            >
              {picked && <Check size={9} />}
            </span>
          )}
          {conversation.pinned && <span role="img" aria-label={t('assistant.chat.pin')} className="text-[length:var(--text-9)] text-[var(--accent)]">●</span>}
          {conversation.starred && (
            <span aria-label={t('assistant.chat.tab.starred')} role="img" className="shrink-0 text-[var(--warning)]">
              <Star size={10} className="fill-current" />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)]">{title}</span>
        </span>
        {conversation.match && (
          // The excerpt is why a row was a hit: a thread titled "untitled" that contains the word two
          // hundred turns in is otherwise indistinguishable from every other row in the list.
          <span className="line-clamp-2 w-full text-[length:var(--text-10-5)] leading-snug text-[var(--text-tertiary)]">
            {conversation.match.snippet}
          </span>
        )}
        <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{relativeTime(conversation.updatedAt)}</span>
      </button>
      <span ref={anchor} className="absolute right-1 top-1.5">
        <IconButton
          label={t('assistant.chat.options', { title })}
          size="xs"
          onClick={onToggleMenu}
        >
          <MoreHorizontal size={14} />
        </IconButton>
      </span>
      {sharing && (
        <ConversationSharePanel conversationId={conversation.id} title={title} onClose={() => setSharing(false)} />
      )}
      <Menu
        anchor={anchor}
        open={menuOpen}
        onClose={onCloseMenu}
        zIndex={Z_INDEX.pinnedMenu}
        items={[
          {
            id: 'pin',
            label: conversation.pinned ? t('assistant.chat.unpin') : t('assistant.chat.pin'),
            onSelect: () => void pinConversation(conversation.id, !conversation.pinned),
          },
          {
            id: 'star',
            label: conversation.starred ? t('assistant.chat.unstar') : t('assistant.chat.star'),
            onSelect: () => void starConversation(conversation.id, !conversation.starred),
          },
          { id: 'rename', label: t('assistant.chat.rename'), onSelect: onRename },
          {
            id: 'archive',
            label: conversation.archived ? t('assistant.chat.unarchive') : t('assistant.chat.archive'),
            // Not a delete and not a star: the thread stays whole and searchable, and the archive tab is
            // where it can be read — or taken back out — again.
            onSelect: () => void archiveConversation(conversation.id, !conversation.archived),
          },
          {
            id: 'folder',
            label: t('assistant.chat.move_to'),
            separatorBefore: true,
            // The notes rail's own picker: a cascade that puts each level beside the row that opens it,
            // walks it with the arrows, marks where the conversation already sits and refuses to choose
            // it again. The submenu used to be one flat list with the depth written into the label, which
            // looked like a tree and was not one.
            submenu: ({ closeMenu }) => (
              <FolderMoveMenu
                tree={moveMenuTree(folderNodes)}
                subject={moveSubject}
                currentParentId={conversation.folderId ?? null}
                excludedIds={NOTHING_EXCLUDED}
                onSelect={(parentId) => {
                  void moveConversation(conversation.id, parentId)
                  closeMenu()
                }}
              />
            ),
          },
          {
            id: 'project',
            label: t('assistant.chat.move_to_project'),
            submenu: submenuFor(projectItems),
            subItems: projectItems,
          },
          {
            id: 'tags',
            label: t('assistant.chat.tags'),
            submenu: submenuFor(tagItems),
            subItems: tagItems,
          },
          {
            id: 'share',
            label: t('assistant.share.title'),
            separatorBefore: true,
            onSelect: () => {
              onCloseMenu()
              setSharing(true)
            },
          },
          {
            id: 'export',
            label: t('assistant.chat.export_markdown'),
            separatorBefore: true,
            onSelect: () => {
              void exportConversation(conversation.id, title)
            },
          },
          {
            id: 'export-json',
            label: t('assistant.chat.export_json'),
            onSelect: () => {
              void exportConversationJson(conversation.id, title)
            },
          },
          {
            id: 'save-note',
            label: t('assistant.note.save_conversation'),
            onSelect: () => {
              // Saved from the row rather than from the open thread: the note is the conversation the
              // reader picked here, which need not be the one they left behind.
              void saveConversationAsNote(conversation.id)
            },
          },
          {
            id: 'delete',
            label: t('assistant.chat.delete'),
            tone: 'danger',
            onSelect: () => {
              void confirm({
                title: t('assistant.chat.delete'),
                description: t('assistant.chat.delete_hint', { title }),
                confirmLabel: t('assistant.chat.delete'),
                tone: 'danger',
              }).then((yes) => {
                if (yes) void deleteConversation(conversation.id)
              })
            },
          },
        ]}
      />
    </li>
  )
}

function EmptyChat({ onPick }: { onPick: (text: string) => void }) {
  const agentName = useAssistant((state) => state.settings?.agentName)
  const conversations = useAssistant((state) => state.conversations)
  const openConversation = useAssistant((state) => state.openConversation)
  const greeting = hourGreeting()
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[620px] flex-col justify-center px-5 py-8">
      <p className="text-[length:var(--text-11)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
        {agentName || t('assistant.app.title')}
      </p>
      <h2 className="mt-2 font-serif text-[length:var(--text-22)] font-semibold tracking-[var(--tracking-title)] text-[var(--text-primary)]">
        {greeting}
      </h2>
      <p className="mt-1 text-[length:var(--text-13)] text-[var(--text-secondary)]">{t('assistant.chat.prompt')}</p>
      <ul className="mt-5 flex flex-col gap-1.5">
        {SUGGESTION_KEYS.map((key) => (
          <li key={key}>
            <button
              type="button"
              onClick={() => onPick(t(key))}
              className={cn(
                'group flex w-full items-center justify-between gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3.5 py-2.5 text-left text-[length:var(--text-12-5)]',
                'text-[var(--text-secondary)] transition-[background-color,border-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                'hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              <span className="min-w-0">{t(key)}</span>
              <ArrowUpRight size={13} className="shrink-0 text-[var(--text-quaternary)] transition-colors duration-[var(--dur-fast)] group-hover:text-[var(--accent)]" />
            </button>
          </li>
        ))}
      </ul>
      {conversations.length > 0 && (
        <div className="mt-7">
          <p className="mb-1.5 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
            {t('assistant.chat.recent')}
          </p>
          <ul className="flex flex-col">
            {conversations.slice(0, 4).map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  onClick={() => void openConversation(conversation.id)}
                  className="flex w-full items-baseline justify-between gap-3 rounded-[var(--r-sm)] px-2 py-1 text-left text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <span className="min-w-0 truncate">{conversation.title || t('assistant.chat.untitled')}</span>
                  <span className="shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{relativeTime(conversation.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * The context the notebook's own pointer is adding to the next turn.
 *
 * The open note and folder ride along with every turn so "summarise this" works without naming anything,
 * but a pointer the reader cannot see is one they cannot correct — so each is drawn here and can be
 * taken off. Taking one off lasts for this thread only; the next thread starts from the pointer again.
 */
function ContextStrip() {
  const activeNoteId = useUi((state) => state.activeNoteId)
  const folderId = useUi((state) => state.folderId)
  const noteTitle = useNotes((state) => (activeNoteId ? state.notes[activeNoteId]?.title : undefined))
  const folderName = useNotes((state) => (folderId ? state.folders.find((folder) => folder.id === folderId)?.name : undefined))
  const noteOn = useAssistant((state) => state.noteContextOn)
  const folderOn = useAssistant((state) => state.folderContextOn)
  const setNoteContext = useAssistant((state) => state.setNoteContext)
  const setFolderContext = useAssistant((state) => state.setFolderContext)
  const chips: Array<{ id: string, icon: React.ReactNode, label: string, onRemove: () => void }> = []
  if (activeNoteId && noteOn) {
    chips.push({ id: 'note', icon: <FileText size={12} />, label: noteTitle || t('assistant.context.note'), onRemove: () => setNoteContext(false) })
  }
  if (folderId && folderOn) {
    chips.push({ id: 'folder', icon: <FolderOpen size={12} />, label: folderName || t('assistant.context.folder'), onRemove: () => setFolderContext(false) })
  }
  if (!chips.length) return null
  return (
    <div role="group" aria-label={t('assistant.context.title')} className="flex flex-wrap items-center gap-1 px-1 pt-0.5">
      {chips.map((chip) => (
        <span
          key={chip.id}
          className="inline-flex min-w-0 items-center gap-1 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]"
        >
          <span aria-hidden className="shrink-0 text-[var(--text-quaternary)]">{chip.icon}</span>
          <span className="max-w-[180px] truncate">{chip.label}</span>
          <button
            type="button"
            aria-label={t('assistant.context.remove', { name: chip.label })}
            onClick={chip.onRemove}
            className="shrink-0 text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)]"
          >
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  )
}

/**
 * The box a reader asks in.
 *
 * Exported because the notebook's docked panel asks the same way the chat tab does: one composer, so a
 * model chip, a `/` pin or an attachment behaves identically wherever the reader happens to be typing.
 * The two things that cannot be shared are the surfaces the "manage" entries open — the dock has no
 * assistant tabs of its own, so it is handed a way out instead.
 */
export function ChatComposer({
  streaming,
  sendOnEnter,
  onSend,
  onStop,
  disabled,
  onManage,
}: {
  streaming: boolean
  sendOnEnter: boolean
  /** Answers false when the request never left this device, so the words can be handed back. */
  onSend: (text: string) => Promise<boolean> | void
  onStop: () => void
  disabled?: boolean
  onManage?: (view: AssistantView) => void
}) {
  const [value, setValue] = useState('')
  const seed = useAssistant((state) => state.composerSeed)
  const ref = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  // Only the disabled "no model" chip needs an anchor of its own: the menu variant brings its own.
  const modelChipRef = useRef<HTMLButtonElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  // A quote from a message menu lands at the top of whatever the reader was already writing, and the
  // handover is spent on arrival: leaving it in the store would re-insert it on the next render.
  useEffect(() => {
    if (seed === null) return
    setValue((current) => (current.trim() ? `${seed}

${current}` : seed))
    useAssistant.getState().clearComposerSeed()
    const box = ref.current
    if (box) box.focus()
  }, [seed])
  const pending = useAssistant((state) => state.pending)
  const attachFiles = useAssistant((state) => state.attachFiles)
  const attachUrl = useAssistant((state) => state.attachUrl)
  const attachPastedText = useAssistant((state) => state.attachPastedText)
  const dropAttachment = useAssistant((state) => state.dropAttachment)
  const retryAttachment = useAssistant((state) => state.retryAttachment)
  const models = useAssistant((state) => state.models)
  const providers = useAssistant((state) => state.providers)
  const settings = useAssistant((state) => state.settings)
  const activateModel = useAssistant((state) => state.activateModel)
  const updateModel = useAssistant((state) => state.updateModel)
  const saveSettings = useAssistant((state) => state.saveSettings)
  const setView = useAssistant((state) => state.setView)
  // Where a "manage" entry goes: the assistant's own tab when the composer is drawn inside it, and
  // whatever the host offers when it is not.
  const manage = onManage ?? setView
  const [pickingNote, setPickingNote] = useState(false)
  const [pinningNote, setPinningNote] = useState(false)
  const [trigger, setTrigger] = useState<ActiveTrigger | null>(null)
  const [triggerRows, setTriggerRows] = useState<TriggerRow[]>([])
  const [triggerIndex, setTriggerIndex] = useState(0)
  const [triggerBusy, setTriggerBusy] = useState(false)
  // Every keystroke asks again, and the answers come back in whatever order the network chose. Each lookup
  // stamps itself with the number it was asked under, so an older response cannot write the panel a newer
  // query did not ask for — nor clear the loading flag a request still in flight owns.
  const triggerRequest = useRef(0)
  const turnTools = useAssistant((state) => state.turnTools)
  const turnScopes = useAssistant((state) => state.turnScopes)
  const addTurnTool = useAssistant((state) => state.addTurnTool)
  const dropTurnTool = useAssistant((state) => state.dropTurnTool)
  const addTurnScope = useAssistant((state) => state.addTurnScope)
  const applySkill = useAssistant((state) => state.applySkill)
  const dropTurnScope = useAssistant((state) => state.dropTurnScope)
  const toast = useUi((state) => state.toast)
  // Translated at render, so a reader who switches language sees the new words without a reload.
  // Their own saved skills come first; the built-in openers are the empty library's fallback.
  const savedSkills = useAssistant((state) => state.skills)
  const loadSkills = useAssistant((state) => state.loadSkills)
  useEffect(() => { void loadSkills() }, [loadSkills])
  const quickSkills = useMemo(
    () => (savedSkills.length
      ? savedSkills.map((skill) => ({ id: skill.id, label: skill.title, text: skill.content, skill }))
      : QUICK_SKILL_KEYS.map((key, index) => ({ id: String(index), label: t(key) }))),
    [savedSkills],
  )
  // Only a model the reader marked as answering chat belongs in the picker; an embedding endpoint is
  // not a thing to hold a conversation with.
  const enabled = models.filter((model) => model.enabled && model.purpose === 'chat')
  const active = enabled.find((model) => model.id === settings?.activeModelId) ?? null
  // The chip lists the levels the answering model's own service has rather than a fixed five, so a model
  // that can only be switched on and off is not offered three depths nothing will read.
  const activeReasoning = useMemo(
    () => (active ? modelReasoning(active, providers.find((entry) => entry.id === active.providerId) ?? null) : null),
    [active, providers],
  )
  const uploading = pending.some((entry) => entry.status === 'uploading')

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [value])

  const submit = () => {
    const text = value.trim()
    if ((!text && !pending.length) || streaming || disabled || uploading) return
    setValue('')
    // A turn the worker never took hands the whole draft back: the store returns the attachments and the
    // chips, and this box owns the words. Refused and stopped-before-the-first-frame are the same thing
    // from here — `send` answers false for both — so one criterion covers them.
    //
    // The merge, not a replace: a reader who went on typing while waiting keeps those words too, and the
    // refused question goes back above them rather than being thrown away.
    void Promise.resolve(onSend(text)).then((accepted) => {
      if (accepted !== false) return
      setValue((current) => (current.trim() ? `${text}\n\n${current}` : text))
    })
  }

  /** The panel answers the keyboard before the box does: Enter picks a row, it must not send the message. */
  const onTriggerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!trigger) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // With nothing to pick the key belongs to the text box: wrapping against an empty list would put
      // NaN in the index, and Enter would then look up no row and step out of a trigger the reader was
      // still typing into.
      if (!triggerRows.length) return false
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setTriggerIndex((current) => (current + step + triggerRows.length) % triggerRows.length)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setTrigger(null)
      setTriggerRows([])
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      // An IME commit is not a pick: the keystroke belongs to the input method.
      if (event.nativeEvent.isComposing) return false
      event.preventDefault()
      const row = triggerRows[triggerIndex]
      // Nothing to pick: the first Enter only steps out of the trigger, so a half-typed `@…` never
      // rides along into a message the reader meant to send. The second Enter sends.
      if (row) pickTriggerRow(row)
      setTrigger(null)
      setTriggerRows([])
      return true
    }
    return false
  }

  const webSearch = useAssistant((state) => state.webSearch)
  const setWebSearch = useAssistant((state) => state.setWebSearch)
  const mcpCatalog = useAssistant((state) => state.mcpCatalog)
  const mcpServers = useAssistant((state) => state.mcpServers)
  const loadMcp = useAssistant((state) => state.loadMcp)
  // Whether the web-search switch can do anything under this model: a vendor-side search, or a
  // search-capable tool among the reader's own MCP servers. Read here rather than inside the chip so the
  // chip itself stays a switch and not a policy.
  const webSearchAvailable = useMemo(() => {
    const protocol = providers.find((entry) => entry.id === active?.providerId)?.protocol
    if (protocol && SEARCH_NATIVE_PROTOCOLS.has(protocol)) return true
    return mcpCatalog.some((entry) => entry.tools.some((tool) => looksLikeSearchTool(tool.name)))
  }, [providers, mcpCatalog, active])

  /** Rows for the trigger the caret is inside. `@` asks the server; the other two filter locally. */
  const loadTriggerRows = async (next: ActiveTrigger) => {
    const request = ++triggerRequest.current
    // Whether this is still the lookup the reader is waiting for. A response that lost the race writes
    // nothing — not its rows, and not the end of the loading flag a newer request is still holding.
    const current = () => triggerRequest.current === request
    setTriggerIndex(0)
    if (next.sigil === '/') {
      // A server that has not been listed yet is awaited rather than skipped: showing the built-ins alone
      // would read as if the reader's own tools had disappeared.
      const offered = mcpServers.filter((server) => server.enabled && server.toolMode !== 'off')
      const pending = offered.length > 0 && mcpCatalog.length === 0
      setTriggerBusy(pending)
      if (pending) await loadMcp()
      if (!current()) return
      // The reader's own MCP tools sit beside the built-in ones, marked by their namespaced name so the
      // row says which server it came from. A tool switched off in settings, or one on a server that is off
      // or only asks, is not pinned here either: the pin would name a tool the turn never offers.
      const catalog = useAssistant.getState().mcpCatalog
      const external: TriggerRow[] = offered
        .flatMap((server) => (catalog.find((entry) => entry.serverId === server.id)?.tools ?? [])
          .filter((tool) => mcpToolModeFor(server, tool.remoteName) !== 'off'))
        .map((tool) => ({
          id: tool.name,
          label: tool.name,
          hint: tool.description.slice(0, 40),
        }))
      setTriggerRows(filterRows([...TOOL_TRIGGER_ROWS, ...external], next.query))
      setTriggerBusy(false)
      return
    }
    setTriggerBusy(true)
    try {
      if (next.sigil === '#') {
        const [tags, folders] = await Promise.all([api.tags.list(), api.folders.list()])
        const rows: TriggerRow[] = [
          ...tags.tags.map((tag) => ({ id: tag.id, label: `#${tag.name}`, kind: 'tag' as const })),
          ...folders.folders.map((folder) => ({ id: folder.id, label: folder.name, kind: 'folder' as const })),
        ]
        if (current()) setTriggerRows(filterRows(rows, next.query.replace(/^#/, '')))
      } else {
        const found = await api.search(next.query || t('assistant.attach.note_prompt'), 8)
        if (current()) setTriggerRows(found.results.map((hit) => ({ id: hit.note.id, label: hit.note.title || t('assistant.trigger.untitled') })))
      }
    } catch {
      // A failed lookup leaves the panel empty rather than closing it: the reader is still typing, and a
      // panel that vanishes under them reads as the app ignoring the trigger.
      if (current()) setTriggerRows([])
    } finally {
      if (current()) setTriggerBusy(false)
    }
  }

  const onTextChange = (next: string, caret: number) => {
    setValue(next)
    const found = detectTrigger(next, caret)
    setTrigger(found)
    if (found) void loadTriggerRows(found)
    else setTriggerRows([])
  }

  /** Splice the trigger token out, then apply what the reader chose. */
  const pickTriggerRow = (row: TriggerRow) => {
    if (!trigger) return
    const caret = ref.current?.selectionStart ?? value.length
    const head = value.slice(0, trigger.start)
    const tail = value.slice(caret)
    const gap = tail === '' || tail.startsWith(' ') ? '' : ' '
    if (trigger.sigil === '@') {
      // The id rides inside the link, not the title alone: two notes of one title, or a note renamed
      // after this turn was written, would otherwise point the model at a document the reader never
      // picked. See `formatNoteMention`.
      setValue(`${head}${formatNoteMention(row.id, row.label)}${gap}${tail}`)
      setTrigger(null)
      setTriggerRows([])
      return
    }
    if (trigger.sigil === '/') addTurnTool(row.id)
    else addTurnScope({ kind: row.kind ?? 'tag', id: row.id, name: row.label.replace(/^#/, '') })
    setValue(`${head}${tail.replace(/^ /, '')}`)
    setTrigger(null)
    setTriggerRows([])
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // The trigger panel answers Escape and the arrows first: a half-typed `@` is closed, not stopped.
    if (onTriggerKey(event)) return
    // A composition owns every bare key, Escape included: there the key drops a candidate, and stopping
    // an answer while the reader is still typing a question would be the app acting on the wrong key.
    if (isImeComposing(event)) return
    // Escape is the reader's way out of a reply that is taking too long, and the composer is where they
    // are looking when they press it. With no reply running it keeps its other meaning, so the section's
    // own Escape handling (closing the find panel) still receives it.
    if (event.key === 'Escape') {
      if (!streaming) return
      event.preventDefault()
      event.stopPropagation()
      onStop()
      return
    }
    if (event.key !== 'Enter') return
    if (sendOnEnter !== event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files]
    const text = event.clipboardData.getData('text')
    const asFile = !files.length && text.length >= PASTE_FILE_MIN_CHARS
    // The decision has to be made before the handler returns: once the browser has pasted, calling
    // preventDefault is a no-op and the reader gets the wall of text next to the file.
    if (files.length || asFile) event.preventDefault()
    if (files.length) {
      void attachFiles(files)
      return
    }
    if (!asFile) return
    void attachPastedText(text).then((attached) => {
      if (attached) toast({ title: t('assistant.attach.pasted_as_file'), tone: 'success' })
    })
  }

  const takeFiles = (input: HTMLInputElement | null) => {
    const picked = input?.files ? [...input.files] : []
    if (input) input.value = ''
    if (picked.length) void attachFiles(picked)
  }

  /**
   * A note or folder dropped on the box becomes a chip, not a file.
   *
   * The notebook's own rails already drag notes and folders around, so the gesture arrives here for free —
   * and what a reader means by dropping a note on the composer is "answer from this", which is a scope
   * chip rather than a copy of its bytes. A title the vault no longer holds is skipped: a chip naming a
   * note that cannot be read is a promise the turn would break.
   */
  const pinDragged = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes('Files')) return false
    const notes = readDraggedNoteIds(event)
    if (notes.length) {
      event.preventDefault()
      const known = useNotes.getState().notes
      for (const id of notes) {
        const note = known[id]
        if (note && !note.deletedAt) addTurnScope({ kind: 'note', id, name: note.title || t('assistant.trigger.untitled') })
      }
      return true
    }
    const folderId = event.dataTransfer.getData(FOLDER_DRAG_TYPE)
    if (folderId) {
      event.preventDefault()
      const folder = useNotes.getState().folders.find((entry) => entry.id === folderId)
      if (folder) addTurnScope({ kind: 'folder', id: folderId, name: folder.name })
      return true
    }
    return false
  }

  return (
    <div className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 pb-3 pt-2.5 md:px-6">
      <div className="mx-auto w-full max-w-[720px]">
        {trigger && (
          <TriggerPanel
            sigil={trigger.sigil}
            rows={triggerRows}
            activeIndex={triggerIndex}
            busy={triggerBusy}
            onHover={setTriggerIndex}
            onPick={pickTriggerRow}
          />
        )}
        <div
          ref={boxRef}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files') || isNoteDrag(event) || event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) {
              event.preventDefault()
            }
          }}
          onDrop={(event) => {
            if (pinDragged(event)) return
            const dropped = [...event.dataTransfer.files]
            if (!dropped.length) return
            event.preventDefault()
            void attachFiles(dropped)
          }}
          className={cn(
            'flex flex-col rounded-[var(--r-xl)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-1.5',
            'shadow-[var(--shadow-sm)]',
            'transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
            'focus-within:border-[var(--accent)] focus-within:shadow-[var(--shadow-ring)]',
          )}
        >
          <AttachmentStrip items={pending} onRemove={(localId) => void dropAttachment(localId)} onRetry={(localId) => void retryAttachment(localId)} />
          <TurnPinRow tools={turnTools} scopes={turnScopes} onDropTool={dropTurnTool} onDropScope={dropTurnScope} />
          <ContextStrip />
          <textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={(event) => onTextChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            maxLength={16_000}
            aria-label={t('assistant.chat.placeholder')}
            placeholder={t('assistant.chat.placeholder')}
            className={cn(
              'max-h-[180px] min-h-[38px] w-full resize-none bg-transparent px-2 py-2 text-[length:var(--text-13-5)] leading-relaxed',
              'text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] focus:outline-none',
            )}
          />
          {/* The row is icons only: five settings, the two ways in for an attachment, dictation and send all
              share a phone's width, so nothing here carries a word. */}
          <div className="flex min-w-0 flex-wrap items-center gap-0.5 px-0.5 pt-0.5">
            <PlusMenu
              skills={quickSkills}
              onFiles={() => fileRef.current?.click()}
              onFolder={() => folderRef.current?.click()}
              onUrl={() => {
                void prompt({ title: t('assistant.attach.url_prompt'), placeholder: 'https://' }).then(async (url) => {
                  if (url?.trim()) await attachUrl(url.trim())
                })
              }}
              onNote={() => setPickingNote(true)}
              onPinNote={() => setPinningNote(true)}
              onSkill={(row) => {
                void (async () => {
                  const text = await fillSkillVariables(row.text ?? row.label)
                  if (text === null) return
                  setValue((current) => (current.trim() ? `${current.trim()}\n${text}` : text))
                  // A saved skill is a standing arrangement, so its words arrive with the turn it was
                  // written for: the chips below the box change, which is what says the change happened.
                  if (row.skill) applySkill(row.skill)
                })()
              }}
              onManageSkills={() => manage('skills')}
            />
            <IconButton label={t('assistant.attach.add_file')} size="sm" onClick={() => fileRef.current?.click()} className="size-7 rounded-[var(--r-md)]">
              <Paperclip size={14} />
            </IconButton>
            <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-0.5">
              {settings && (
                <ApprovalMenu
                  mode={settings.toolModes.destructive}
                  onChange={(next) => void saveSettings({ toolModes: { ...settings.toolModes, destructive: next } })}
                />
              )}
              {active && (
                <>
                  <ReasoningMenu
                    value={active.reasoning}
                    rungs={activeReasoning ? reasoningOptions(activeReasoning, active.reasoning) : [active.reasoning]}
                    disabled={active.reasoning === 'off'}
                    onChange={(next) => void updateModel(active.id, { reasoning: next })}
                  />
                  <ContextMenu
                    value={active.contextTokens}
                    onPick={(tokens) => void updateModel(active.id, { contextTokens: tokens })}
                  />
                  <WebSearchMenu value={webSearch} onChange={setWebSearch} available={webSearchAvailable} />
                </>
              )}
              {active ? (
                <ModelMenu
                  models={enabled}
                  activeId={settings?.activeModelId ?? null}
                  onPick={(id) => void activateModel(id)}
                  onManage={() => manage('settings')}
                  // The switch changes what this model is able to be shown, so it is only drawn for the
                  // model that is answering: an empty id would PATCH `/models/` and change nothing.
                  onVision={(next) => void updateModel(active.id, { vision: next })}
                />
              ) : (
                // Nothing to toggle and nothing to pick: a switch that reads off and cannot be turned on
                // would be taken for a broken control, so the row says it is waiting for a model instead,
                // and leaves the door to settings where the model is chosen.
                <>
                  <ControlChip
                    refObject={modelChipRef}
                    label={t('assistant.composer.model')}
                    value={t('assistant.composer.model_none')}
                    icon={<Sparkles size={12} />}
                    disabled
                    hint={t('assistant.composer.model_none_hint')}
                    onClick={() => undefined}
                  />
                  <IconButton label={t('assistant.composer.manage_models')} size="sm" onClick={() => manage('settings')}>
                    <Settings2 size={14} />
                  </IconButton>
                </>
              )}
              <Divider vertical className="mx-0.5" />
              <VoiceButton onText={(chunk) => setValue((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${chunk}`)} />
              {streaming ? (
                <IconButton label={t('assistant.chat.stop')} size="sm" variant="secondary" onClick={onStop} className="size-8 rounded-[var(--r-md)]">
                  <Square size={12} className="fill-current" />
                </IconButton>
              ) : (
                <IconButton
                  label={t('assistant.chat.send')}
                  size="sm"
                  variant="primary"
                  disabled={(!value.trim() && !pending.length) || disabled || uploading}
                  onClick={submit}
                  className="size-8 rounded-[var(--r-md)]"
                >
                  <ArrowUp size={15} />
                </IconButton>
              )}
            </div>
          </div>
        </div>
        <input ref={fileRef} type="file" multiple hidden accept={CHAT_ATTACHMENT_ACCEPT} onChange={() => takeFiles(fileRef.current)} />
        <input
          ref={folderRef}
          type="file"
          multiple
          hidden
          {...CHAT_FOLDER_PICKER_ATTRS}
          onChange={() => takeFiles(folderRef.current)}
        />
        <NotePicker
          open={pickingNote}
          onClose={() => setPickingNote(false)}
          onPick={(row) => setValue((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${formatNoteMention(row.id, row.title)}`)}
          search={async (query) => {
            const response = await api.search(query || t('assistant.attach.note_prompt'), 12)
            return response.results.map((hit) => ({ id: hit.note.id, title: hit.note.title }))
          }}
        />
        <NotePicker
          open={pinningNote}
          onClose={() => setPinningNote(false)}
          title={t('assistant.attach.pin_note')}
          onPick={(row) => addTurnScope({ kind: 'note', id: row.id, name: row.title })}
          search={async (query) => {
            const response = await api.search(query || t('assistant.attach.note_prompt'), 12)
            return response.results.map((hit) => ({ id: hit.note.id, title: hit.note.title }))
          }}
        />
        {!active && (
          // Drawn rather than left to the chip's hover hint: the chip cannot be pressed, and a reason that
          // only a pointer can find would be unreachable on the touch screen that lacks a model most often.
          <p role="note" className="mt-1.5 text-center text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
            {t('assistant.composer.model_none_hint')}
          </p>
        )}
        <p className="mt-1.5 hidden text-center text-[length:var(--text-10-5)] text-[var(--text-quaternary)] md:block">
          {t('assistant.chat.disclaimer')}
        </p>
      </div>
    </div>
  )
}

function hourGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 6) return t('assistant.chat.greeting_late')
  if (hour < 12) return t('assistant.chat.greeting_morning')
  if (hour < 18) return t('assistant.chat.greeting_afternoon')
  return t('assistant.chat.greeting_evening')
}
