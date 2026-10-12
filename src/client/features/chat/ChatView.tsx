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
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, History, MoreHorizontal, Plus, Square } from 'lucide-react'
import type { AssistantConversation, AssistantMessage } from '@shared/assistant'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { relativeTime } from '../../lib/time'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Input } from '../../components/form'
import { Menu, Modal, confirm } from '../../components/overlay'
import { useAssistant } from './assistant-store'
import { AssistantBubble } from './MessageParts'

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

  const lastFailed = useMemo(() => {
    const last = messages.at(-1)
    return last && last.role === 'assistant' && last.status === 'error' ? last : null
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
                  onRetry={lastFailed?.id === message.id && !streaming ? () => void send('', { retry: true }) : undefined}
                />
              ))}
              {turnHere && (
                <>
                  {turnHere.userText && <UserBubble text={turnHere.userText} />}
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
  if (message.role === 'user') return <UserBubble text={message.content} />
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
    />
  )
}

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex animate-[ink-fade-in_var(--dur-base)_var(--ease-out)] justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[var(--r-lg)] rounded-br-[var(--r-xs)] bg-[var(--accent-soft)] px-3 py-2 text-[13.5px] leading-relaxed text-[var(--text-primary)]">
        {text}
      </div>
    </div>
  )
}

function ConversationList({ activeId, onPick }: { activeId: string | null, onPick: () => void }) {
  const conversations = useAssistant((state) => state.conversations)
  const query = useAssistant((state) => state.conversationQuery)
  const setQuery = useAssistant((state) => state.setConversationQuery)
  const openConversation = useAssistant((state) => state.openConversation)
  const newConversation = useAssistant((state) => state.newConversation)
  const renameConversation = useAssistant((state) => state.renameConversation)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<AssistantConversation | null>(null)
  const [draft, setDraft] = useState('')

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
      <div className="flex flex-col gap-2 p-2">
        <Button size="sm" variant="secondary" block icon={<Plus size={14} />} onClick={() => { newConversation(); onPick() }}>
          {t('assistant.chat.new')}
        </Button>
        <Input
          value={query}
          onChange={(event) => void setQuery(event.target.value)}
          placeholder={t('assistant.chat.search')}
          aria-label={t('assistant.chat.search')}
          className="h-8 text-[12px]"
        />
      </div>
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
  const anchor = useRef<HTMLSpanElement>(null)
  const title = conversation.title || t('assistant.chat.untitled')
  return (
    <li className="group relative">
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
          { id: 'rename', label: t('assistant.chat.rename'), onSelect: onRename },
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

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [value])

  const submit = () => {
    const text = value.trim()
    if (!text || streaming || disabled) return
    onSend(text)
    setValue('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return
    // A Chinese or Japanese input commits with Enter; that keystroke belongs to the IME, not to send.
    if (event.nativeEvent.isComposing) return
    if (sendOnEnter !== event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 pb-3 pt-2.5 md:px-6">
      <div className="mx-auto w-full max-w-[720px]">
        <div
          className={cn(
            'flex items-end gap-2 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-1.5',
            'transition-[border-color,box-shadow] duration-[var(--dur-fast)]',
            'focus-within:border-[var(--accent)] focus-within:shadow-[var(--shadow-ring)]',
          )}
        >
          <textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={onKeyDown}
            maxLength={16_000}
            aria-label={t('assistant.chat.placeholder')}
            placeholder={t('assistant.chat.placeholder')}
            className={cn(
              'max-h-[180px] min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] leading-relaxed',
              'text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] focus:outline-none',
            )}
          />
          {streaming ? (
            <IconButton label={t('assistant.chat.stop')} size="sm" variant="secondary" onClick={onStop} className="size-8 rounded-[var(--r-md)]">
              <Square size={12} className="fill-current" />
            </IconButton>
          ) : (
            <IconButton
              label={t('assistant.chat.send')}
              size="sm"
              variant="primary"
              disabled={!value.trim() || disabled}
              onClick={submit}
              className="size-8 rounded-[var(--r-md)]"
            >
              <ArrowUp size={15} />
            </IconButton>
          )}
        </div>
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
