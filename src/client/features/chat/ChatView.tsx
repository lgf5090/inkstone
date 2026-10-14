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
import { type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, History, MoreHorizontal, Paperclip, Plus, Square, Star } from 'lucide-react'
import type { AssistantConversation, AssistantMessage, ChatAttachment } from '@shared/assistant'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { relativeTime } from '../../lib/time'
import { useDebouncedDraft } from '../../lib/hooks'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Input } from '../../components/form'
import { Menu, Modal, confirm, prompt, submenuFor } from '../../components/overlay'
import { api } from '../../lib/api'
import { ConversationTabStrip, ConversationTaxonomyPanel, orderedFolders } from './ChatTaxonomy'
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
import { PASTE_FILE_MIN_CHARS, useAssistant } from './assistant-store'
import { AssistantBubble } from './MessageParts'

/** The composer's "common requests" list: the same openers the empty thread offers, by key. */
const QUICK_PROMPT_KEYS = ['assistant.chat.ask_1', 'assistant.chat.ask_2', 'assistant.chat.ask_3', 'assistant.chat.ask_4'] as const

const SUGGESTION_KEYS = [
  'assistant.chat.ask_1',
  'assistant.chat.ask_2',
  'assistant.chat.ask_3',
  'assistant.chat.ask_4',
] as const

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
  const newConversation = useAssistant((state) => state.newConversation)
  const stop = useAssistant((state) => state.stop)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [listOpen, setListOpen] = useState(false)

  const streaming = (!!turn && !turn.done) || remoteStreaming
  // A live reply belongs to its own conversation; only show it in the thread that owns it.
  const turnHere = turn && turn.conversationId === (activeId ?? null) ? turn : null
  const showEmpty = !activeId && !turnHere

  useEffect(() => {
    stickToBottom.current = true
  }, [activeId])

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

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-64 shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] lg:flex">
        <ConversationList activeId={activeId} onPick={() => undefined} />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2">
          <IconButton label={t('assistant.chat.history')} size="sm" className="lg:hidden" onClick={() => setListOpen(true)}>
            <History size={15} />
          </IconButton>
          <span className="min-w-0 truncate text-[12px] text-[var(--text-tertiary)]">
            {activeId
              ? conversations.find((conversation) => conversation.id === activeId)?.title || t('assistant.chat.untitled')
              : t('assistant.chat.new_title')}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
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
                  onRetry={message.id === lastAnswer?.id && !streaming ? () => void send('', { retry: true }) : undefined}
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

        <Composer
          streaming={streaming}
          sendOnEnter={useAssistant((state) => state.settings?.sendOnEnter ?? true)}
          onSend={(text) => void send(text)}
          onStop={stop}
          disabled={blocked}
        />
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

function MessageRow({ message, onRetry }: { message: AssistantMessage, onRetry?: () => void }) {
  // A finished answer can be asked again; a half one is only ever resumed by its own retry.
  const retryLabel = message.status === 'complete' ? 'assistant.chat.regenerate' : 'assistant.chat.retry'
  const fileIndex = useAssistant((state) => state.fileIndex)
  if (message.role === 'user') {
    return <UserBubble text={message.content} attachments={message.attachments ?? []} fileIndex={fileIndex} />
  }
  return (
    <AssistantBubble
      text={message.content}
      reasoning=""
      tools={message.tools}
      error={message.status === 'error' ? message.error : null}
      cancelled={message.status === 'cancelled'}
      streaming={false}
      stage={undefined}
      onRetry={onRetry}
      retryLabel={retryLabel}
      usage={message.usage}
      durationMs={message.durationMs ?? 0}
      modelLabel={message.modelLabel ?? ''}
      versionCount={message.versionCount ?? 0}
      loadVersions={() => useAssistant.getState().loadAnswerVersions(message.id)}
      onActivate={(versionId) => void useAssistant.getState().activateAnswerVersion(message.id, versionId)}
    />
  )
}

export function UserBubble({
  text,
  attachments = [],
  fileIndex = {},
}: { text: string, attachments?: string[], fileIndex?: Record<string, ChatAttachment> }) {
  return (
    <div className="flex animate-[ink-fade-in_var(--dur-base)_var(--ease-out)] justify-end">
      <div className="flex max-w-[85%] flex-col items-end gap-1">
        {attachments.length > 0 && <MessageAttachments ids={attachments} index={fileIndex} />}
        {text && (
          <div className="whitespace-pre-wrap break-words rounded-[var(--r-lg)] rounded-br-[var(--r-xs)] bg-[var(--accent-soft)] px-3 py-2 text-[13.5px] leading-relaxed text-[var(--text-primary)]">
            {text}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * How long the conversation box stops typing before the settled text reaches the store. The query lives
 * in the assistant store, so a keystroke that commits it there re-filters every row in the list.
 */
const CONVERSATION_SEARCH_DEBOUNCE_MS = 200

function ConversationList({ activeId, onPick }: { activeId: string | null, onPick: () => void }) {
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
  const { draft: searchDraft, setDraft: setSearchDraft } = useDebouncedDraft(query, (next) => {
    void setQuery(next)
  }, CONVERSATION_SEARCH_DEBOUNCE_MS)

  // Counts move whenever a conversation is filed or a turn adds one, so the tree rides along with it.
  useEffect(() => {
    void loadTaxonomy()
  }, [loadTaxonomy, conversations.length])

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
        <Input
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
          placeholder={t('assistant.chat.search')}
          aria-label={t('assistant.chat.search')}
          className="h-8 text-[12px]"
        />
      </div>
      <ConversationTabStrip />
      <ConversationTaxonomyPanel onOpen={onPick} />
      <nav aria-label={t('assistant.chat.list')} className="no-scrollbar min-h-0 w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 pb-2">
        {!ordered.length ? (
          <p className="px-2 py-6 text-center text-[12px] text-[var(--text-quaternary)]">
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
  const loadTaxonomy = useAssistant((state) => state.loadTaxonomy)
  const anchor = useRef<HTMLSpanElement>(null)
  const title = conversation.title || t('assistant.chat.untitled')
  const assigned = new Set((conversation.tags ?? []).map((tag) => tag.id))

  const folderItems = [
    {
      id: 'folder-none',
      label: t('assistant.chat.unfiled'),
      checked: !conversation.folderId,
      onSelect: () => void moveConversation(conversation.id, null),
    },
    ...orderedFolders(folderNodes).map(({ node, depth }) => ({
      id: `folder-${node.id}`,
      // The level is part of the label because the submenu is one flat list of rows.
      label: `${' '.repeat(depth * 3)}${node.name}`,
      checked: conversation.folderId === node.id,
      onSelect: () => void moveConversation(conversation.id, node.id),
    })),
  ]

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
        void prompt({ title: t('assistant.chat.new_tag'), placeholder: t('assistant.chat.tag_name') }).then(async (name) => {
          if (!name?.trim()) return
          const created = await api.tags.create({ name: name.trim() }).catch(() => null)
          if (created) await toggleConversationTag(conversation.id, created.id, true)
          await loadTaxonomy()
        })
      },
    },
  ]

  return (
    <li className="group relative" onContextMenu={(event) => { event.preventDefault(); onToggleMenu() }}>
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
          {conversation.pinned && <span aria-hidden className="text-[9px] text-[var(--accent)]">●</span>}
          {conversation.starred && (
            <span aria-label={t('assistant.chat.tab.starred')} role="img" className="shrink-0 text-[var(--warning)]">
              <Star size={10} className="fill-current" />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{title}</span>
        </span>
        <span className="text-[10.5px] text-[var(--text-quaternary)]">{relativeTime(conversation.updatedAt)}</span>
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
      <Menu
        anchor={anchor}
        open={menuOpen}
        onClose={onCloseMenu}
        zIndex={300}
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
            id: 'folder',
            label: t('assistant.chat.move_to'),
            separatorBefore: true,
            submenu: submenuFor(folderItems),
            subItems: folderItems,
          },
          {
            id: 'tags',
            label: t('assistant.chat.tags'),
            submenu: submenuFor(tagItems),
            subItems: tagItems,
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
      <p className="text-[11px] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
        {agentName || t('assistant.app.title')}
      </p>
      <h2 className="mt-2 font-serif text-[22px] font-semibold tracking-[var(--tracking-title)] text-[var(--text-primary)]">
        {greeting}
      </h2>
      <p className="mt-1 text-[13px] text-[var(--text-secondary)]">{t('assistant.chat.prompt')}</p>
      <ul className="mt-5 flex flex-col gap-1.5">
        {SUGGESTION_KEYS.map((key) => (
          <li key={key}>
            <button
              type="button"
              onClick={() => onPick(t(key))}
              className={cn(
                'w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-left text-[12.5px]',
                'text-[var(--text-secondary)] transition-colors duration-[var(--dur-fast)]',
                'hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
              )}
            >
              {t(key)}
            </button>
          </li>
        ))}
      </ul>
      {conversations.length > 0 && (
        <div className="mt-7">
          <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
            {t('assistant.chat.recent')}
          </p>
          <ul className="flex flex-col">
            {conversations.slice(0, 4).map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  onClick={() => void openConversation(conversation.id)}
                  className="flex w-full items-baseline justify-between gap-3 rounded-[var(--r-sm)] px-2 py-1 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <span className="min-w-0 truncate">{conversation.title || t('assistant.chat.untitled')}</span>
                  <span className="shrink-0 text-[10.5px] text-[var(--text-quaternary)]">{relativeTime(conversation.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
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
  const ref = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const pending = useAssistant((state) => state.pending)
  const attachFiles = useAssistant((state) => state.attachFiles)
  const attachUrl = useAssistant((state) => state.attachUrl)
  const attachPastedText = useAssistant((state) => state.attachPastedText)
  const dropAttachment = useAssistant((state) => state.dropAttachment)
  const models = useAssistant((state) => state.models)
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
  const dropTurnScope = useAssistant((state) => state.dropTurnScope)
  const toast = useUi((state) => state.toast)
  // Translated at render, so a reader who switches language sees the new words without a reload.
  // Their own saved prompts come first; the built-in openers are the empty library's fallback.
  const savedPrompts = useAssistant((state) => state.prompts)
  const loadPrompts = useAssistant((state) => state.loadPrompts)
  useEffect(() => { void loadPrompts() }, [loadPrompts])
  const quickPrompts = useMemo(
    () => (savedPrompts.length
      ? savedPrompts.map((prompt) => ({ id: prompt.id, label: prompt.title, text: prompt.content }))
      : QUICK_PROMPT_KEYS.map((key, index) => ({ id: String(index), label: t(key) }))),
    [savedPrompts],
  )
  // Only a model the reader marked as answering chat belongs in the picker; an embedding endpoint is
  // not a thing to hold a conversation with.
  const enabled = models.filter((model) => model.enabled && model.purpose === 'chat')
  const active = enabled.find((model) => model.id === settings?.activeModelId) ?? null
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
  const mcpTools = useAssistant((state) => state.mcpTools)
  const mcpServers = useAssistant((state) => state.mcpServers)
  const loadMcp = useAssistant((state) => state.loadMcp)

  /** Rows for the trigger the caret is inside. `@` asks the server; the other two filter locally. */
  const loadTriggerRows = async (next: ActiveTrigger) => {
    setTriggerIndex(0)
    if (next.sigil === '/') {
      // A server that has not been listed yet is awaited rather than skipped: showing the built-ins alone
      // would read as if the reader's own tools had disappeared.
      const pending = mcpServers.some((server) => server.enabled && server.toolMode !== 'off') && mcpTools.length === 0
      setTriggerBusy(pending)
      if (pending) await loadMcp()
      // The reader's own MCP tools sit beside the built-in ones, marked by their namespaced name so the
      // row says which server it came from.
      const external: TriggerRow[] = useAssistant.getState().mcpTools.map((tool) => ({
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
            'flex flex-col rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-1.5',
            'transition-[border-color,box-shadow] duration-[var(--dur-fast)]',
            'focus-within:border-[var(--accent)] focus-within:shadow-[var(--shadow-ring)]',
          )}
        >
          <AttachmentStrip items={pending} onRemove={(localId) => void dropAttachment(localId)} />
          <TurnPinRow tools={turnTools} scopes={turnScopes} onDropTool={dropTurnTool} onDropScope={dropTurnScope} />
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
              'max-h-[180px] min-h-[36px] w-full resize-none bg-transparent px-2 py-1.5 text-[13.5px] leading-relaxed',
              'text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] focus:outline-none',
            )}
          />
          {/* Seven controls will not fit one line at 360px; wrapping keeps every one of them reachable
              instead of pushing the send button past the edge of the box. */}
          <div className="flex min-w-0 flex-wrap items-center gap-1 px-0.5">
            <PlusMenu
              prompts={quickPrompts}
              onFiles={() => fileRef.current?.click()}
              onFolder={() => folderRef.current?.click()}
              onUrl={() => {
                void prompt({ title: t('assistant.attach.url_prompt'), placeholder: 'https://' }).then(async (url) => {
                  if (url?.trim()) await attachUrl(url.trim())
                })
              }}
              onNote={() => setPickingNote(true)}
              onPrompt={(text) => setValue((current) => (current.trim() ? `${current.trim()}\n${text}` : text))}
              onManagePrompts={() => setView('prompts')}
            />
            <IconButton label={t('assistant.attach.add_file')} size="sm" onClick={() => fileRef.current?.click()} className="size-7 rounded-[var(--r-md)]">
              <Paperclip size={14} />
            </IconButton>
            <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1">
              {settings && <ApprovalMenu auto={settings.autoApproveWrites} onChange={(next) => void saveSettings({ autoApproveWrites: next })} />}
              {active && (
                <>
                  <ReasoningMenu
                    value={active.reasoning}
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
        <p className="mt-1.5 hidden text-center text-[10.5px] text-[var(--text-quaternary)] md:block">
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
