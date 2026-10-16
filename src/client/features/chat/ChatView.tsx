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
import { type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ArrowUpRight, Check, Copy, FileText, FolderOpen, History, MoreHorizontal, Paperclip, Pencil, Plus, Search, Square, Star, Trash2, X } from 'lucide-react'
import type { AssistantConversation, AssistantMessage, ChatAttachment } from '@shared/assistant'
import { mcpToolModeFor } from '@shared/assistant'
import { DEBOUNCE } from '@shared/constants'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { COPY_RESET_MS } from '../../lib/motion'
import { isImeComposing } from '../../lib/ime'
import { relativeTime } from '../../lib/time'
import { useDebouncedDraft } from '../../lib/hooks'
import { compileQuery } from '../../lib/query-match'
import type { MoveMenuFolder } from '../../lib/tree'
import { Button, Divider, IconButton, Spinner } from '../../components/primitives'
import { FilterInput } from '../../components/FilterInput'
import { Input, Textarea } from '../../components/form'
import { Menu, Modal, confirm, prompt, submenuFor, type MenuItem } from '../../components/overlay'
import { api } from '../../lib/api'
import { FolderMoveMenu } from '../folders/FolderMoveMenu'
import { ConversationTabStrip, ConversationTaxonomyPanel, moveMenuTree } from './ChatTaxonomy'
import { AttachmentStrip, MessageAttachments } from './ChatAttachments'
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
  ContextMenu,
  ModelMenu,
  NotePicker,
  PlusMenu,
  ReasoningMenu,
  WebSearchMenu,
  VoiceButton,
} from './ComposerControls'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { MarkdownBody } from '../preview/MarkdownBody'
import { PASTE_FILE_MIN_CHARS, useAssistant } from './assistant-store'
import { MessageMenu, useMessageMenu } from './MessageMenu'
import { AssistantBubble } from './MessageParts'
import { CHAT_NOTE_LINKS } from './note-links'
import { SelectionBar, SelectionTick, selectedMessages, type MessageSelection } from './SelectionBar'
import { downloadTranscript } from './transcript'
import { writeConversationDrag } from './conversation-drag'
import { ConversationSharePanel } from '../share/ConversationSharePanel'
import { ThreadFinder } from './ThreadFinder'
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
    const detail = await api.assistant.conversation(conversationId)
    downloadTranscript(detail.messages, title)
    toast({ title: t('assistant.chat.exported', { title }), tone: 'success' })
  } catch (error) {
    toast({ title: error instanceof Error ? error.message : t('assistant.toast.failed'), tone: 'danger' })
  }
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

export function ChatView() {
  const conversations = useAssistant((state) => state.conversations)
  const activeId = useAssistant((state) => state.activeId)
  const messages = useAssistant((state) => state.messages)
  const messagesReady = useAssistant((state) => state.messagesReady)
  // The uploads the composer just accepted are already indexed; the turn's chips read from there.
  const fileIndexForTurn = useAssistant((state) => state.fileIndex)
  const turn = useAssistant((state) => state.turn)
  const remoteStreaming = useAssistant((state) => state.remoteStreaming)
  const send = useAssistant((state) => state.send)
  const loadMcpServers = useAssistant((state) => state.loadMcpServers)
  const newConversation = useAssistant((state) => state.newConversation)
  const stop = useAssistant((state) => state.stop)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [listOpen, setListOpen] = useState(false)
  const [finding, setFinding] = useState(false)
  // Selection is a mode, not a modifier: a checkbox on every message all the time is furniture nobody
  // asked for in a conversation, so the ticks exist only while the reader is picking. `null` is "not
  // picking"; an empty set is "picking with nothing chosen yet", which the bar has words for.
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null)
  const picked = useMemo(
    () => (selected ? selectedMessages(messages, selected) : []),
    [messages, selected],
  )
  const togglePicked = (id: string) => setSelected((current) => {
    if (!current) return current
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const startPicking = (id: string) => setSelected(new Set([id]))

  const title = activeId
    ? conversations.find((conversation) => conversation.id === activeId)?.title || t('assistant.chat.untitled')
    : t('assistant.chat.new_title')

  const streaming = (!!turn && !turn.done) || remoteStreaming
  // A live reply belongs to its own conversation; only show it in the thread that owns it.
  const turnHere = turn && turn.conversationId === (activeId ?? null) ? turn : null
  const showEmpty = !activeId && !turnHere

  useEffect(() => {
    stickToBottom.current = true
  }, [activeId])

  // The server rows name whose call each third-party chip was, so the transcript reads `Context7 ·
  // query-docs` instead of the namespaced name the model was offered. One read of the reader's own rows,
  // asked once per mount, and `loadMcpServers` says out loud why it is allowed to fail.
  useEffect(() => {
    void loadMcpServers()
  }, [loadMcpServers])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages.length, turnHere?.text, turnHere?.tools.length, turnHere?.error])

  // A reader with no model configured cannot ask anything real; the settings tab is the way out.
  const blocked = useAssistant((state) => !state.settings?.activeModelId && !state.settings?.offlineMode)

  // Retry re-answers the reader's last message and drops the reply that followed it, so it belongs to
  // the newest answer only — offered on an older one it would silently rewrite a different turn.
  const lastAnswer = useMemo(() => {
    const last = messages.at(-1)
    return last && last.role === 'assistant' ? last : null
  }, [messages])

  // The outline's stops are the turns the reader wrote — the only fixed points in a thread whose answers
  // vary in length. A new array on every store write would re-register the outline's scroll listener on
  // each streamed token, so it is derived only when the rows themselves change.
  const anchors = useMemo(
    () => messages.filter((message) => message.role === 'user').map((message) => ({ id: message.id, text: message.content })),
    [messages],
  )

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-64 shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] lg:flex">
        <ConversationList activeId={activeId} onPick={() => undefined} />
      </aside>

      {/* Ctrl/Cmd+F is the reader's own reflex for this box, so it opens the thread's own find instead of
          the browser's bar over a page that is one conversation. */}
      <section
        className="relative flex min-w-0 flex-1 flex-col"
        onKeyDown={(event) => {
          // This box wraps the composer, so every keystroke in a half-written Chinese sentence bubbles
          // through here — and Escape is the key the input method is holding to drop that candidate.
          if (isImeComposing(event)) return
          if (event.key === 'f' && (event.metaKey || event.ctrlKey)) {
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
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <IconButton label={t('assistant.chat.find')} size="sm" onClick={() => setFinding((open) => !open)}>
              <Search size={15} />
            </IconButton>
            <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={newConversation} disabled={streaming}>
              {t('assistant.chat.new')}
            </Button>
          </div>
        </div>

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
          ) : !messagesReady && !turnHere ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-4 py-5 md:px-6">
              {messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  busy={streaming}
                  onRetry={message.id === lastAnswer?.id && !streaming ? () => void send('', { retry: true }) : undefined}
                  onStartPicking={startPicking}
                  selection={selected ? { active: true, checked: selected.has(message.id), onToggle: () => togglePicked(message.id) } : undefined}
                />
              ))}
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
              {remoteStreaming && !turnHere && <AssistantBubble text="" reasoning="" tools={[]} error={null} streaming stage={undefined} />}
            </div>
          )}
        </div>

        {selected && (
          <SelectionBar
            picked={picked}
            title={title}
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
        <Composer
          streaming={streaming}
          sendOnEnter={useAssistant((state) => state.settings?.sendOnEnter ?? true)}
          onSend={(text) => void send(text)}
          onStop={stop}
          disabled={blocked}
        />
        <ChatOutline anchors={anchors} scrollerRef={scrollRef} />
        {finding && (
          <ThreadFinder
            scroller={scrollRef}
            revision={messages.length}
            onClose={() => setFinding(false)}
          />
        )}
      </section>

      <Modal open={listOpen} onClose={() => setListOpen(false)} title={t('assistant.chat.history')} width={360} bodyClassName="p-0">
        <div className="h-[60vh]">
          <ConversationList
            activeId={activeId}
            onPick={() => setListOpen(false)}
          />
        </div>
      </Modal>
    </div>
  )
}

export function MessageRow({ message, onRetry, busy = false, selection, onStartPicking }: {
  message: AssistantMessage
  onRetry?: () => void
  busy?: boolean
  selection?: MessageSelection
  onStartPicking?: (messageId: string) => void
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
        anchorId={message.id}
        selection={selection}
        onStartPicking={onStartPicking}
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
      onRetry={onRetry}
      retryLabel={retryLabel}
      usage={message.usage}
      sources={message.sources}
      feedback={message.feedback}
      onRate={message.role === 'assistant' ? (verdict) => void useAssistant.getState().rateAnswer(message.id, verdict) : undefined}
      selection={selection}
      onStartPicking={onStartPicking}
      durationMs={message.durationMs ?? 0}
      modelLabel={message.modelLabel ?? ''}
      versionCount={message.versionCount ?? 0}
      loadVersions={() => useAssistant.getState().loadAnswerVersions(message.id)}
      onActivate={(versionId) => void useAssistant.getState().activateAnswerVersion(message.id, versionId)}
    />
  )
}

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
  anchorId,
  selection,
  onStartPicking,
}: {
  text: string
  attachments?: string[]
  fileIndex?: Record<string, ChatAttachment>
  messageId?: string
  busy?: boolean
  anchorId?: string
  selection?: MessageSelection
  onStartPicking?: (messageId: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
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
              links={CHAT_NOTE_LINKS}
            />
          </div>
        )}
        {text && (
          <div className="flex items-center gap-0.5 transition-opacity duration-[var(--dur-fast)] md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
            <IconButton
              size="sm"
              label={copied ? t('assistant.chat.copied') : t('assistant.chat.copy')}
              onClick={() => {
                void navigator.clipboard.writeText(text).then(() => {
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), COPY_RESET_MS)
                }).catch(() => toast({ title: t('preview.could_not_copy'), tone: 'danger' }))
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
        }}
      />
      {draft !== null && messageId && (
        <EditMessageDialog
          text={draft}
          onClose={() => setDraft(null)}
          onSave={(content) => {
            setDraft(null)
            // The turn re-answers itself: the dialog has nothing left to hold, and the replaced answer
            // arrives in the thread like any other.
            void useAssistant.getState().editMessage(messageId, content)
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
function EditMessageDialog({ text, onClose, onSave }: { text: string, onClose: () => void, onSave: (content: string) => void }) {
  const [value, setValue] = useState(text)
  const trimmed = value.trim()
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
          <Button variant="primary" disabled={!trimmed || trimmed === text.trim()} onClick={() => onSave(trimmed)}>
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

/** Exported so a test can pin the conversation box to the shared filter box; `ChatView` draws it twice. */
export function ConversationList({ activeId, onPick }: { activeId: string | null, onPick: () => void }) {
  const conversations = useAssistant((state) => state.conversations)
  const query = useAssistant((state) => state.conversationQuery)
  const setQuery = useAssistant((state) => state.setConversationQuery)
  const openConversation = useAssistant((state) => state.openConversation)
  const newConversation = useAssistant((state) => state.newConversation)
  const renameConversation = useAssistant((state) => state.renameConversation)
  const loadTaxonomy = useAssistant((state) => state.loadTaxonomy)
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
        <Button size="sm" variant="secondary" block icon={<Plus size={14} />} onClick={() => { newConversation(); onPick() }}>
          {t('assistant.chat.new')}
        </Button>
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
      <nav aria-label={t('assistant.chat.list')} className="no-scrollbar min-h-0 w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 pb-2">
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
                onOpen={() => {
                  void openConversation(conversation.id)
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
      </nav>

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
}: {
  conversation: AssistantConversation
  active: boolean
  menuOpen: boolean
  onToggleMenu: () => void
  onCloseMenu: () => void
  onOpen: () => void
  onRename: () => void
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
        onClick={onOpen}
        className={cn(
          'flex w-full flex-col items-start gap-0.5 rounded-[var(--r-sm)] px-2 py-1.5 pr-7 text-left',
          'transition-colors duration-[var(--dur-fast)]',
          active
            ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        )}
      >
        <span className="flex w-full min-w-0 items-center gap-1">
          {conversation.pinned && <span aria-hidden className="text-[length:var(--text-9)] text-[var(--accent)]">●</span>}
          {conversation.starred && (
            <span aria-label={t('assistant.chat.tab.starred')} role="img" className="shrink-0 text-[var(--warning)]">
              <Star size={10} className="fill-current" />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)]">{title}</span>
        </span>
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

function Composer({
  streaming,
  sendOnEnter,
  onSend,
  onStop,
  disabled,
}: {
  streaming: boolean
  sendOnEnter: boolean
  onSend: (text: string) => void
  onStop: () => void
  disabled?: boolean
}) {
  const [value, setValue] = useState('')
  const seed = useAssistant((state) => state.composerSeed)
  const ref = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
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
  const models = useAssistant((state) => state.models)
  const providers = useAssistant((state) => state.providers)
  const settings = useAssistant((state) => state.settings)
  const activateModel = useAssistant((state) => state.activateModel)
  const updateModel = useAssistant((state) => state.updateModel)
  const saveSettings = useAssistant((state) => state.saveSettings)
  const setView = useAssistant((state) => state.setView)
  const [pickingNote, setPickingNote] = useState(false)
  const [trigger, setTrigger] = useState<ActiveTrigger | null>(null)
  const [triggerRows, setTriggerRows] = useState<TriggerRow[]>([])
  const [triggerIndex, setTriggerIndex] = useState(0)
  const [triggerBusy, setTriggerBusy] = useState(false)
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
    onSend(text)
    setValue('')
  }

  /** The panel answers the keyboard before the box does: Enter picks a row, it must not send the message. */
  const onTriggerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!trigger) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
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

  /** Rows for the trigger the caret is inside. `@` asks the server; the other two filter locally. */
  const loadTriggerRows = async (next: ActiveTrigger) => {
    setTriggerIndex(0)
    if (next.sigil === '/') {
      // A server that has not been listed yet is awaited rather than skipped: showing the built-ins alone
      // would read as if the reader's own tools had disappeared.
      const offered = mcpServers.filter((server) => server.enabled && server.toolMode !== 'off')
      const pending = offered.length > 0 && mcpCatalog.length === 0
      setTriggerBusy(pending)
      if (pending) await loadMcp()
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
        setTriggerRows(filterRows(rows, next.query.replace(/^#/, '')))
      } else {
        const found = await api.search(next.query || t('assistant.attach.note_prompt'), 8)
        setTriggerRows(found.results.map((hit) => ({ id: hit.note.id, label: hit.note.title || t('assistant.trigger.untitled') })))
      }
    } catch {
      // A failed lookup leaves the panel empty rather than closing it: the reader is still typing, and a
      // panel that vanishes under them reads as the app ignoring the trigger.
      setTriggerRows([])
    } finally {
      setTriggerBusy(false)
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
      setValue(`${head}[[${row.label}]]${gap}${tail}`)
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
    if (onTriggerKey(event)) return
    if (event.key !== 'Enter') return
    // A Chinese or Japanese input commits with Enter; that keystroke belongs to the IME, not to send.
    if (event.nativeEvent.isComposing) return
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
            if (event.dataTransfer.types.includes('Files')) event.preventDefault()
          }}
          onDrop={(event) => {
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
          <AttachmentStrip items={pending} onRemove={(localId) => void dropAttachment(localId)} />
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
              onSkill={(row) => {
                const text = row.text ?? row.label
                setValue((current) => (current.trim() ? `${current.trim()}\n${text}` : text))
                // A saved skill is a standing arrangement, so its words arrive with the turn it was
                // written for: the chips below the box change, which is what says the change happened.
                if (row.skill) applySkill(row.skill)
              }}
              onManageSkills={() => setView('skills')}
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
                  <WebSearchMenu value={webSearch} onChange={setWebSearch} />
                </>
              )}
              <ModelMenu
                models={enabled}
                activeId={settings?.activeModelId ?? null}
                onPick={(id) => void activateModel(id)}
                onManage={() => setView('settings')}
                onVision={(next) => void updateModel(active?.id ?? '', { vision: next })}
              />
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
        <input ref={fileRef} type="file" multiple hidden onChange={() => takeFiles(fileRef.current)} />
        <input
          ref={folderRef}
          type="file"
          multiple
          hidden
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={() => takeFiles(folderRef.current)}
        />
        <NotePicker
          open={pickingNote}
          onClose={() => setPickingNote(false)}
          onPick={(title) => setValue((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}[[${title}]]`)}
          search={async (query) => {
            const response = await api.search(query || t('assistant.attach.note_prompt'), 12)
            return response.results.map((hit) => ({ id: hit.note.id, title: hit.note.title }))
          }}
        />
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
