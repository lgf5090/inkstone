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
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { ArrowUpRight, Plus, Sparkles, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { IconButton, Button, Spinner } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import { AssistantBubble } from './MessageParts'
import { ChatComposer, MessageRow, UserBubble } from './ChatView'
import {
  applyEditorAiResult,
  EDITOR_AI_LABELS,
  lastAnswerText,
  useEditorAi,
  type EditorAiRequest,
} from './editor-ai'
import { saveReplyAsNote } from './save-to-note'

export function AssistantDock() {
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
  const sendOnEnter = useAssistant((state) => state.settings?.sendOnEnter ?? true)
  const blocked = useAssistant((state) => !state.settings?.activeModelId && !state.settings?.offlineMode)
  const fileIndex = useAssistant((state) => state.fileIndex)
  const setOpen = useUi((state) => state.setAssistantDock)
  const request = useEditorAi((state) => state.request)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    // The panel exists to ask about this page, so opening it points the next turn at the page.
    setNoteContext(true)
  }, [setNoteContext])

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

  const suggestions = useMemo(() => [
    'assistant.dock.suggest_summary',
    'assistant.dock.suggest_questions',
    'assistant.dock.suggest_next',
  ] as const, [])

  return (
    <aside
      aria-label={t('assistant.dock.title')}
      data-assistant-dock="1"
      // A column beside the note on a wide screen, and a bottom sheet on a phone: the same panel, but a
      // 380px column on a 390px screen is the whole page rather than a companion to it.
      className={cn(
        'flex flex-col bg-[var(--bg-base)]',
        'fixed inset-x-0 bottom-0 z-[var(--z-panel)] h-[min(70vh,560px)] rounded-t-[var(--r-xl)] border-t border-[var(--border-default)] shadow-[var(--shadow-modal)]',
        'md:static md:h-full md:w-[min(380px,36vw)] md:shrink-0 md:rounded-none md:border-l md:border-t-0 md:shadow-none',
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
              {t('assistant.dock.hint')}
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
                />
              </>
            )}
          </div>
        )}
      </div>

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
 */
function AiResultRow({ request, answer }: { request: EditorAiRequest, answer: string }) {
  const clear = useEditorAi((state) => state.clear)
  const toast = useUi((state) => state.toast)
  const apply = (mode: 'replace' | 'insert') => {
    if (!applyEditorAiResult(answer, mode)) return
    toast({ title: t(mode === 'replace' ? 'assistant.edit.replaced' : 'assistant.edit.inserted'), tone: 'success' })
    clear()
  }
  return (
    <div
      role="group"
      aria-label={t('assistant.edit.result')}
      className="flex shrink-0 flex-wrap items-center gap-1 border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5"
    >
      <span className="min-w-0 truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
        {t(EDITOR_AI_LABELS[request.action])}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {request.from < request.to && (
          <Button size="sm" variant="secondary" onClick={() => apply('replace')}>
            {t('assistant.edit.replace')}
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => apply('insert')}>
          {t('assistant.edit.insert')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void saveReplyAsNote(answer)}>
          {t('assistant.edit.save_note')}
        </Button>
        <IconButton label={t('assistant.edit.dismiss')} size="sm" onClick={clear}>
          <X size={13} />
        </IconButton>
      </div>
    </div>
  )
}
