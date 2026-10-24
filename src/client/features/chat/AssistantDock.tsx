/**
 * The assistant, docked beside the note.
 *
 * Asking about what you are writing used to mean leaving the page: the chat tab replaces the notebook,
 * so "is this paragraph clear?" cost a reader the paragraph. The dock is the same conversation in a
 * column of the notebook's own frame — same store, same composer, same replies — so the thread that
 * answers a question about this note is the thread they can come back to later.
 *
 * It is deliberately not a second assistant. There is one active conversation, and the chat tab and this
 * panel are two windows onto it: switching between them keeps the answer that is streaming, because the
 * turn lives in the store rather than in either surface.
 *
 * The note on screen is the context by default. That is the whole point of the panel, so it is switched
 * on when the panel opens rather than inherited from whatever the chat tab was last set to — and it is
 * drawn as a chip the reader can take off, because a context they cannot see is one they cannot correct.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowUpRight, ListChecks, Mail, Music, Plus, Sparkles, Wallet, X } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import type { TodoAssistantContext } from '@shared/todos/assistant-context'
import type { EmailAssistantContext } from '@shared/email/assistant-context'
import type { MusicAssistantContext } from '@shared/music/assistant-context'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { IconButton, Button, Spinner } from '../../components/primitives'
import { Modal, Tooltip } from '../../components/overlay'
import { DEFAULT_LAYOUT, PANEL_WIDTHS, useUi } from '../../store/ui'
import { Resizer } from '../shell/Resizer'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'
import { AssistantBubble } from './MessageParts'
import { ChatComposer, MessageRow, UserBubble } from './ChatView'
import { ContextUsageRing } from './ContextUsageMeter'
import {
  applyEditorAiResult,
  EDITOR_AI_LABELS,
  lastAnswerText,
  previewEditorAiWrite,
  useEditorAi,
  type EditorAiRequest,
  type EditorAiWriteMode,
} from './editor-ai'
import { buildWriteDiff, WriteDiffSummary, WriteDiffView } from './editor-ai-diff'
import { saveReplyAsNote } from './save-to-note'

/** Which app the dock is sitting beside: it decides what "this page" can honestly mean. */
export type AssistantDockSurface = 'notebook' | 'subscriptions' | 'todos' | 'email' | 'music'

const TODO_VIEW_LABELS: Record<string, MessageKey> = {
  board: 'todo.view.board',
  today: 'todo.view.today',
  plan: 'todo.view.plan',
  calendar: 'todo.view.calendar',
  starred: 'todo.view.starred',
  completed: 'todo.view.completed',
  list: 'todo.view.list',
  tag: 'todo.view.tag',
  stats: 'todo.view.stats',
}

function todoLabel(context: TodoAssistantContext): string {
  if (context.taskTitle) return context.taskTitle
  if (context.listName) return context.listName
  if (context.tagName) return context.tagName
  const key = TODO_VIEW_LABELS[context.view]
  return key ? t(key) : t('todo.view.board')
}

export function AssistantDock({ surface = 'notebook', subscription = null, email = null, music = null }: {
  surface?: AssistantDockSurface
  /** The plan the money app has open, so "what will this cost me this year" has an answer. */
  subscription?: { id: string, name: string } | null
  email?: EmailAssistantContext | null
  music?: MusicAssistantContext | null
}) {
  const subscriptionId = subscription?.id ?? null
  const subscriptionName = subscription?.name ?? null
  // The strip draws what is attached, not what the page offered: once the reader takes it off it must stay
  // off until they move, or the control lies about the turn it is sending.
  const attached = useAssistant((state) => state.subscriptionContext)
  const bootstrap = useAssistant((state) => state.bootstrap)
  const loaded = useAssistant((state) => state.loaded)
  const agentName = useAssistant((state) => state.settings?.agentName)
  const activeId = useAssistant((state) => state.activeId)
  const messages = useAssistant((state) => state.messages)
  const messagesReady = useAssistant((state) => state.messagesReady)
  const turn = useAssistant((state) => state.turn)
  const remoteStreaming = useAssistant((state) => state.remoteStreaming)
  const send = useAssistant((state) => state.send)
  const stop = useAssistant((state) => state.stop)
  const newConversation = useAssistant((state) => state.newConversation)
  const setNoteContext = useAssistant((state) => state.setNoteContext)
  const setFolderContext = useAssistant((state) => state.setFolderContext)
  const noteContextOn = useAssistant((state) => state.noteContextOn)
  const activeNoteId = useUi((state) => state.activeNoteId)
  const todo = useAssistant((state) => state.todoContext)
  const todoOn = useAssistant((state) => state.todoContextOn)
  const setTodoContextOn = useAssistant((state) => state.setTodoContextOn)
  const emailContext = useAssistant((state) => state.emailContext)
  const emailOn = useAssistant((state) => state.emailContextOn)
  const setEmailContextOn = useAssistant((state) => state.setEmailContextOn)
  const musicContext = useAssistant((state) => state.musicContext)
  const musicOn = useAssistant((state) => state.musicContextOn)
  const setMusicContextOn = useAssistant((state) => state.setMusicContextOn)
  const sendOnEnter = useAssistant((state) => state.settings?.sendOnEnter ?? true)
  const blocked = useAssistant((state) => !state.settings?.activeModelId && !state.settings?.offlineMode)
  const fileIndex = useAssistant((state) => state.fileIndex)
  const setOpen = useUi((state) => state.setAssistantDock)
  const dockWidth = useUi((state) => state.assistantDockWidth)
  const setLayout = useUi((state) => state.setLayout)
  const request = useEditorAi((state) => state.request)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    // The panel exists to ask about the page it is on. In the notebook that means the note under the
    // reader's eyes; beside the money app or the to-do list the same pointer still names a note they are
    // not looking at, and a turn answered from it reads as "summarise this" about the wrong thing. So the
    // notebook's pointers are switched off there rather than borrowed. The surface also lands in the
    // store, because the strip and the outgoing turn read it there — a mount effect alone loses to the
    // conversation paths that put noteContextOn back to true.
    useAssistant.getState().setDockSurface(surface)
    if (surface === 'notebook') {
      setNoteContext(true)
      return
    }
    setNoteContext(false)
    setFolderContext(false)
  }, [surface, setNoteContext, setFolderContext])

  // The dock hands the plan over and takes it back as the reader moves through the list; the chip below is
  // what makes that visible, because context the reader cannot see is context they cannot remove.
  // The dependencies are the primitives, not the object: a caller that builds `{ id, name }` inline gives
  // this a new identity on every render, and re-attaching after the reader pressed "remove" is how the
  // chip would become impossible to take off.
  useEffect(() => {
    if (surface !== 'subscriptions') return
    useAssistant.getState().setSubscriptionContext(subscriptionId ? { id: subscriptionId, name: subscriptionName ?? '' } : null)
  }, [surface, subscriptionId, subscriptionName])

  const emailAccountId = email?.accountId ?? null
  const emailMessageId = email?.messageId ?? null
  const emailSubject = email?.subject ?? null
  const emailSender = email?.sender ?? null
  const emailFolderId = email?.folderId ?? null
  const emailLabel = emailContext?.subject?.trim() || emailContext?.sender?.trim() || emailContext?.address || ''
  useEffect(() => {
    if (surface !== 'email') return
    useAssistant.getState().setEmailContext(emailAccountId ? email ?? null : null)
  }, [surface, emailAccountId, emailMessageId, emailSubject, emailSender, emailFolderId])

  // Same handover as the plan and the message, with the page as the primitive that changes most: the
  // music app rebuilds this object on every render, and a dependency on the object would re-attach the
  // chip after the reader took it off.
  const musicPage = music?.page ?? null
  const musicTrackRef = music?.trackRef ?? null
  const musicTrackTitle = music?.trackTitle ?? null
  const musicArtists = music?.artists?.join('\u0001') ?? null
  const musicPlaylistId = music?.playlistId ?? null
  const musicCloudSource = music?.cloudSource ?? null
  const musicMountId = music?.mountId ?? null
  const musicCloudPath = music?.cloudPath ?? null
  const musicQueueLength = music?.queueLength ?? null
  useEffect(() => {
    if (surface !== 'music') return
    const store = useAssistant.getState()
    if (!musicPage) {
      store.setMusicContext(null)
      return
    }
    store.setMusicContext({
      page: musicPage,
      ...(musicTrackRef ? { trackRef: musicTrackRef } : {}),
      ...(musicTrackTitle ? { trackTitle: musicTrackTitle } : {}),
      ...(musicArtists ? { artists: musicArtists.split('\u0001') } : {}),
      ...(musicPlaylistId ? { playlistId: musicPlaylistId } : {}),
      ...(musicCloudSource ? { cloudSource: musicCloudSource } : {}),
      ...(musicMountId ? { mountId: musicMountId } : {}),
      ...(musicCloudPath ? { cloudPath: musicCloudPath } : {}),
      ...(musicQueueLength !== null ? { queueLength: musicQueueLength } : {}),
    })
  }, [surface, musicPage, musicTrackRef, musicTrackTitle, musicArtists, musicPlaylistId, musicCloudSource, musicMountId, musicCloudPath, musicQueueLength])

  const musicLabel = musicContext?.trackTitle?.trim()
    || musicContext?.cloudPath?.trim()
    || musicContext?.playlistId
    || t('assistant.dock.music_label')

  const streaming = (!!turn && !turn.done) || remoteStreaming
  const turnHere = turn && turn.conversationId === (activeId ?? null) ? turn : null
  const empty = !messages.length && !turnHere
  // The answer a selection-request is waiting for. Read only once the turn is over: a paragraph still
  // being written is not something to paste into a note.
  const answer = request && !streaming ? lastAnswerText() : ''

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages.length, turnHere?.text, turnHere?.tools.length])

  const suggestions = useMemo(() => (
    surface === 'subscriptions'
      ? ['assistant.dock.suggest_due', 'assistant.dock.suggest_cost', 'assistant.dock.suggest_remind'] as const
      : surface === 'todos'
        ? ['assistant.dock.suggest_todo_focus', 'assistant.dock.suggest_todo_plan', 'assistant.dock.suggest_todo_review'] as const
        : surface === 'email'
          ? ['assistant.dock.suggest_email_summary', 'assistant.dock.suggest_email_reply', 'assistant.dock.suggest_email_search'] as const
          : surface === 'music'
            ? ['assistant.dock.suggest_music_play', 'assistant.dock.suggest_music_queue', 'assistant.dock.suggest_music_about'] as const
            : ['assistant.dock.suggest_summary', 'assistant.dock.suggest_questions', 'assistant.dock.suggest_next'] as const
  ), [surface])

  /**
   * What the empty thread says about itself.
   *
   * The guidance used to promise that the note under the reader's eyes was already in context on every
   * surface, which in the money app named a thing that was not there and a chip that was deliberately not
   * drawn. It now names what this dock is actually carrying: the plan, the to-do page, the note, or
   * nothing yet.
   */
  const hint = surface === 'todos' && todo && todoOn
    ? t('assistant.dock.hint_todo')
    : surface === 'email' && emailContext && emailOn
      ? t('assistant.dock.hint_email')
      : surface === 'music' && musicContext && musicOn
        ? t('assistant.dock.hint_music')
        : attached
          ? t('assistant.dock.hint_plan', { name: attached.name })
          : surface === 'notebook' && noteContextOn && activeNoteId
            ? t('assistant.dock.hint')
            : t('assistant.dock.hint_page')

  return (
    <>
      <div className="hidden h-full shrink-0 md:block">
        <Resizer
          label={t('assistant.dock.resize')}
          value={dockWidth}
          min={PANEL_WIDTHS.assistantDock.min}
          max={PANEL_WIDTHS.assistantDock.max}
          invert
          className="h-full"
          onChange={(assistantDockWidth) => setLayout({ assistantDockWidth })}
          onReset={() => setLayout({ assistantDockWidth: DEFAULT_LAYOUT.assistantDockWidth })}
        />
      </div>
      <aside
        aria-label={t('assistant.dock.title')}
        data-assistant-dock="1"
        style={{ '--assistant-dock-width': `${dockWidth}px` } as CSSProperties}
        // A column beside the note on a wide screen, and a bottom sheet on a phone: the same panel, but a
        // 380px column on a 390px screen is the whole page rather than a companion to it.
        className={cn(
          'flex flex-col bg-[var(--bg-base)]',
          'fixed inset-x-0 bottom-0 z-[var(--z-panel)] h-[min(70vh,560px)] rounded-t-[var(--r-xl)] border-t border-[var(--border-default)] shadow-[var(--shadow-modal)]',
          'md:static md:h-full md:w-[var(--assistant-dock-width)] md:max-w-[60vw] md:shrink-0 md:rounded-none md:border-l md:border-t-0 md:shadow-none',
        )}
      >
      {/* The grab handle is the only thing that says "this can be dismissed by the reader", and it is
          not drawn where the panel is a column: a desktop has a close button and no thumb. */}
      <div aria-hidden className="mx-auto mt-1.5 h-1 w-9 shrink-0 rounded-full bg-[var(--border-strong)] md:hidden" />
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2">
        <Sparkles size={13} className="ml-1 shrink-0 text-[var(--accent)]" />
        <span className="min-w-0 truncate text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {agentName || t('assistant.dock.title')}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {/* The same reading the chat header wears: one thread, one ring, whichever window it is read from. */}
          <ContextUsageRing />
          <Tooltip label={t('assistant.chat.new')}>
            <IconButton label={t('assistant.chat.new')} size="sm" disabled={streaming} onClick={newConversation}>
              <Plus size={13} />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('assistant.dock.open_chat')}>
            <IconButton
              label={t('assistant.dock.open_chat')}
              size="sm"
              onClick={() => {
                useAssistant.getState().setView('chat')
                navigateToPath('/chat')
              }}
            >
              <ArrowUpRight size={13} />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('assistant.dock.close')}>
            <IconButton label={t('assistant.dock.close')} size="sm" onClick={() => setOpen(false)}>
              <X size={13} />
            </IconButton>
          </Tooltip>
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
        {!loaded ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : empty ? (
          <div className="flex flex-col gap-3 px-3 py-6">
            <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
              {hint}
            </p>
            <ul className="flex flex-col gap-1">
              {suggestions.map((key) => (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => void send(t(key))}
                    disabled={blocked || streaming}
                    className={cn(
                      'w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-2 text-left',
                      'text-[length:var(--text-12)] text-[var(--text-secondary)] transition-colors duration-[var(--dur-fast)]',
                      'hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                      'disabled:opacity-50',
                    )}
                  >
                    {t(key)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : !messagesReady && !turnHere ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : (
          <div className="flex flex-col gap-4 px-3 py-4">
            {/* Deliberately bare rows: the dock offers no retry and no continue either, because its thread is
                not the one the store's send path writes to. A follow-up chip here would press a question into
                the chat window's conversation — a different model, a different scope, a different thread — so
                the affordance is left out rather than pointed at the wrong place. */}
            {messages.map((message) => (
              <MessageRow key={message.id} message={message} busy={streaming} />
            ))}
            {turnHere && (
              <>
                {turnHere.userText && (
                  <UserBubble text={turnHere.userText} attachments={turnHere.attachments} fileIndex={fileIndex} />
                )}
                <AssistantBubble
                  text={turnHere.text}
                  reasoning={turnHere.reasoning}
                  tools={turnHere.tools}
                  error={turnHere.error}
                  streaming={!turnHere.done}
                  stage={turnHere.stage}
                  sources={turnHere.sources}
                />
              </>
            )}
          </div>
        )}
      </div>

      {surface === 'subscriptions' && attached && (
        <div role="group" aria-label={t('assistant.context.title')} className="flex flex-wrap items-center gap-1 px-3 pt-1.5">
          <span className="inline-flex min-w-0 items-center gap-1 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            <span aria-hidden className="shrink-0 text-[var(--text-quaternary)]"><Wallet size={12} /></span>
            <span className="max-w-[180px] truncate">{attached.name}</span>
            <button
              type="button"
              aria-label={t('assistant.context.remove', { name: attached.name })}
              onClick={() => useAssistant.getState().setSubscriptionContext(null)}
              className="ink-tap-pad relative shrink-0 text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)]"
            >
              <X size={11} />
            </button>
          </span>
        </div>
      )}
      {surface === 'todos' && todo && todoOn && (
        <div role="group" aria-label={t('assistant.context.title')} className="flex flex-wrap items-center gap-1 px-3 pt-1.5">
          <span className="inline-flex min-w-0 items-center gap-1 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            <span aria-hidden className="shrink-0 text-[var(--text-quaternary)]"><ListChecks size={12} /></span>
            <span className="max-w-[220px] truncate">{todoLabel(todo)}</span>
            <button
              type="button"
              aria-label={t('assistant.context.remove', { name: todoLabel(todo) })}
              onClick={() => setTodoContextOn(false)}
              className="relative shrink-0 p-0.5 text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)]"
            >
              <X size={11} />
            </button>
          </span>
        </div>
      )}
      {surface === 'email' && emailContext && emailOn && (
        <div role="group" aria-label={t('assistant.context.title')} className="flex flex-wrap items-center gap-1 px-3 pt-1.5">
          <span className="inline-flex min-w-0 items-center gap-1 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            <span aria-hidden className="shrink-0 text-[var(--text-quaternary)]"><Mail size={12} /></span>
            <span className="min-w-0 max-w-[220px] truncate">{emailLabel}</span>
            <button
              type="button"
              aria-label={t('assistant.context.remove', { name: emailLabel })}
              onClick={() => setEmailContextOn(false)}
              className="relative shrink-0 p-0.5 text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)]"
            >
              <X size={11} />
            </button>
          </span>
        </div>
      )}
      {surface === 'music' && musicContext && musicOn && (
        <div role="group" aria-label={t('assistant.context.title')} className="flex flex-wrap items-center gap-1 px-3 pt-1.5">
          <span className="inline-flex min-w-0 items-center gap-1 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            <span aria-hidden className="shrink-0 text-[var(--text-quaternary)]"><Music size={12} /></span>
            <span className="min-w-0 max-w-[220px] truncate">{musicLabel}</span>
            <button
              type="button"
              aria-label={t('assistant.context.remove', { name: musicLabel })}
              onClick={() => setMusicContextOn(false)}
              className="relative shrink-0 p-0.5 text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)]"
            >
              <X size={11} />
            </button>
          </span>
        </div>
      )}
      <ChatComposer
        streaming={streaming}
        sendOnEnter={sendOnEnter}
        onSend={(text) => void send(text)}
        onStop={stop}
        disabled={blocked}
        onManage={(view) => {
          useAssistant.getState().setView(view)
          navigateToPath('/chat')
        }}
      />
      {request && !streaming && answer.trim() && <AiResultRow request={request} answer={answer} />}
      </aside>
    </>
  )
}

/**
 * Where the answer goes, once the reader has read it.
 *
 * The row is the half of "select and ask" that lives outside the editor: the request was made from a
 * range of the note, so the answer is offered back into that range, after it, or as a note of its own.
 * It appears only once the turn has finished — a half-written paragraph is not something to paste — and
 * it stays until it is used or dismissed, because the reader may well have scrolled away while it was
 * being written.
 *
 * What it cannot do is write blind. Replace and insert name the change rather than perform it: they open
 * the preview of the words that would leave the note and the words that would arrive, and only the press
 * inside that dialog edits. A note the reader changed while the model was thinking is said out loud here,
 * in the same words the refusal uses, rather than discovered after the fact.
 */
function AiResultRow({ request, answer }: { request: EditorAiRequest, answer: string }) {
  const clear = useEditorAi((state) => state.clear)
  const toast = useUi((state) => state.toast)
  const content = useNotes((state) => state.contents[request.noteId])
  const [pending, setPending] = useState<EditorAiWriteMode | null>(null)
  // Measured against a replace, because that is the affordance with something to lose: an insert only
  // adds, and its preview is the same dialog read one way.
  const preview = content === undefined ? null : previewEditorAiWrite(content, request, answer, 'replace')
  const before = preview?.status === 'ok' ? preview.before : null
  const after = preview?.status === 'ok' ? preview.after : null
  const diff = useWriteDiff(before, after)
  const writable = content !== undefined && !!diff
  const commit = (mode: EditorAiWriteMode) => {
    setPending(null)
    if (!applyEditorAiResult(answer, mode)) return
    toast({ title: t(mode === 'replace' ? 'assistant.edit.replaced' : 'assistant.edit.inserted'), tone: 'success' })
    clear()
  }
  return (
    <div
      role="group"
      aria-label={t('assistant.edit.result')}
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5"
    >
      <span className="min-w-0 shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
        {t(EDITOR_AI_LABELS[request.action])}
      </span>
      {content === undefined ? (
        <span className="min-w-0 flex-1 text-[length:var(--text-11)] text-[var(--warning)]">{t('assistant.edit.note_gone')}</span>
      ) : preview?.status === 'stale' ? (
        <span className="min-w-0 flex-1 text-[length:var(--text-11)] text-[var(--warning)]">{t('assistant.edit.stale')}</span>
      ) : diff ? (
        <WriteDiffSummary diff={diff} />
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {writable && request.from < request.to && (
          <Button size="sm" variant="secondary" onClick={() => setPending('replace')}>
            {t('assistant.edit.replace')}
          </Button>
        )}
        {writable && (
          <Button size="sm" variant="secondary" onClick={() => setPending('insert')}>
            {t('assistant.edit.insert')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void saveReplyAsNote(answer)}>
          {t('assistant.edit.save_note')}
        </Button>
        <IconButton label={t('assistant.edit.dismiss')} size="sm" onClick={clear}>
          <X size={13} />
        </IconButton>
      </div>
      {pending && (
        <WritePreviewDialog
          request={request}
          answer={answer}
          mode={pending}
          onCommit={commit}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )
}

/**
 * The diff of one proposed write, computed once per pair of documents.
 *
 * Keyed on the two texts rather than on the request or the answer, because the note store can hand a new
 * object for the same words and a forty-thousand-character note is not something to compare again on
 * every keystroke elsewhere in the panel.
 */
function useWriteDiff(before: string | null, after: string | null) {
  return useMemo(() => (before === null || after === null ? null : buildWriteDiff(before, after)), [before, after])
}

/**
 * The change, shown before it is made.
 *
 * A dialog rather than a strip inside the dock: the note is the thing at stake and the panel is 380 pixels
 * wide, so the reader gets the room to actually read what the model wrote. `Modal` is the app's one focus
 * discipline — the tab order stays inside the diff, Escape and the backdrop both mean the same thing the
 * Cancel button says, and the focus goes back where it came from — and the change is only made by the
 * press that follows the reading of it.
 *
 * The preview is live: the note is subscribed from the store, so an edit that lands while the dialog is
 * open moves the diff and the Apply button with it, rather than leaving the reader confirming a change
 * that is no longer the change.
 */
function WritePreviewDialog({ request, answer, mode, onCommit, onCancel }: {
  request: EditorAiRequest
  answer: string
  mode: EditorAiWriteMode
  onCommit: (mode: EditorAiWriteMode) => void
  onCancel: () => void
}) {
  const content = useNotes((state) => state.contents[request.noteId])
  const preview = content === undefined ? null : previewEditorAiWrite(content, request, answer, mode)
  const before = preview?.status === 'ok' ? preview.before : null
  const after = preview?.status === 'ok' ? preview.after : null
  const diff = useWriteDiff(before, after)
  const reason = content === undefined ? 'assistant.edit.note_gone' : 'assistant.edit.stale'
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('assistant.edit.diff')}
      description={diff ? <WriteDiffSummary diff={diff} /> : undefined}
      width={620}
      footer={<>
        <Button variant="ghost" data-autofocus onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={!diff || !diff.changed} onClick={() => onCommit(mode)}>
          {t('assistant.edit.apply')}
        </Button>
      </>}
    >
      <div className="space-y-3">
        <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t(mode === 'replace' ? 'assistant.edit.preview_replace' : 'assistant.edit.preview_insert')}
        </p>
        {diff ? <WriteDiffView diff={diff} /> : <p className="text-[length:var(--text-12)] text-[var(--warning)]">{t(reason)}</p>}
      </div>
    </Modal>
  )
}
