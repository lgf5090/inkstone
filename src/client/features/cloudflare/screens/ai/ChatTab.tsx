/**
 * The chat tab: one conversation at a time, streamed from the proxy, with the session list on the
 * side. The screen owns the messages it is showing; the session row is written after each side of
 * the exchange is complete, so a failed stream never invents half a conversation.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  History,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react'
import type { AiChatMessage, AiModel } from '../../api/ai'
import { aiApi, readChatDelta } from '../../api/ai'
import type { AiChatSession } from '../../api/chat-sessions'
import { chatSessionsApi } from '../../api/chat-sessions'
import { cfErrorText } from '../../api/client'
import { useCfT } from '../../i18n'
import { formatRelative } from '../../lib/format'
import { useUi } from '../../../../store/ui'
import { cn } from '../../../../lib/cn'
import { Button, IconButton, Spinner } from '../../../../components/primitives'
import { Input, Slider, Textarea } from '../../../../components/form'
import { Drawer, Modal, confirm } from '../../../../components/overlay'
import { SelectMenu } from '../../../../components/select-menu'
import { CopyButton } from '../../components/CopyButton'
import { MarkdownBody } from '../../components/MarkdownBody'
import { useAiAccounts } from './use-ai-accounts'
import {
  AUTO_ACCOUNT,
  CHAT_PARAM_DEFAULTS,
  buildChatBody,
  chatStreamError,
  sessionTitleFromAnswer,
  shortModelId,
  shouldAutoNameSession,
  type ChatSampling,
} from './options'
import { ChatHistorySidebar } from './ChatHistorySidebar'

const NAME_PROMPT = 'You name chat sessions. Reply in the same language as the user question with a title of at most six words. '
  + 'Output only the title, without quotes, punctuation or explanation.'

const SUGGESTION_KEYS = [
  'cloudflare.ai.suggestions.s1',
  'cloudflare.ai.suggestions.s2',
  'cloudflare.ai.suggestions.s3',
  'cloudflare.ai.suggestions.s4',
  'cloudflare.ai.suggestions.s5',
  'cloudflare.ai.suggestions.s6',
] as const

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  reasoningOpen?: boolean
  thinkingDone?: boolean
  loading?: boolean
  createdAt: number
}

interface RequestConfig {
  model: string
  accountId: string
  params: ChatSampling
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

export function ChatTab() {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const { accounts } = useAiAccounts()

  const [accountId, setAccountId] = useState(AUTO_ACCOUNT)
  const [models, setModels] = useState<AiModel[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [activeSession, setActiveSession] = useState<AiChatSession | null>(null)
  const [params, setParams] = useState<ChatSampling>({ ...CHAT_PARAM_DEFAULTS })
  const [paramsOpen, setParamsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [sidebarRefresh, setSidebarRefresh] = useState(0)

  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadSeq = useRef(0)
  const streamSeq = useRef(0)
  const alive = useRef(true)
  const sending = useRef(false)
  const sessionRef = useRef<AiChatSession | null>(null)

  useEffect(() => {
    sessionRef.current = activeSession
  }, [activeSession])

  const accountOptions = [
    { value: AUTO_ACCOUNT, label: t('cloudflare.ai.auto_assign') },
    ...accounts.map((account) => ({ value: account.value, label: account.label })),
  ]
  const modelOptions = models.map((model) => ({ value: model.id, label: shortModelId(model.id) }))
  const config: RequestConfig = { model: selectedModel, accountId, params }

  useEffect(() => {
    let cancelled = false
    setModels([])
    setSelectedModel('')
    aiApi.models('text-generation', accountId === AUTO_ACCOUNT ? undefined : accountId)
      .then((response) => {
        if (cancelled) return
        setModels(response.data)
        setSelectedModel((current) => (
          response.data.some((model) => model.id === current) ? current : response.data[0]?.id ?? ''
        ))
      })
      .catch((failure: unknown) => {
        if (cancelled) return
        setModels([])
        setSelectedModel('')
        toast({ title: t('common.action_failed'), description: cfErrorText(failure), tone: 'danger' })
      })
    return () => { cancelled = true }
  }, [accountId, t, toast])

  useEffect(() => {
    // Re-armed on every mount: StrictMode cleans a fresh mount up, and a flag left false there would
    // discard every streamed answer for the rest of the session.
    alive.current = true
    return () => {
      alive.current = false
      abortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  function scrollToBottom(): void {
    requestAnimationFrame(() => {
      const node = scrollRef.current
      if (node) node.scrollTop = node.scrollHeight
    })
  }

  function stopInference(): void {
    abortRef.current?.abort()
    abortRef.current = null
  }

  async function ensureSession(): Promise<AiChatSession | null> {
    if (activeSession) return activeSession
    try {
      const session = await chatSessionsApi.create()
      setActiveSession(session)
      setSidebarRefresh((value) => value + 1)
      return session
    } catch (failure: unknown) {
      toast({ title: t('common.action_failed'), description: cfErrorText(failure), tone: 'danger' })
      return null
    }
  }

  async function streamAnswer(
    baseMessages: ChatMessage[],
    request: RequestConfig,
  ): Promise<ChatMessage> {
    const answer: ChatMessage = {
      role: 'assistant',
      content: '',
      reasoning: '',
      reasoningOpen: false,
      thinkingDone: false,
      loading: true,
      createdAt: Date.now(),
    }
    setMessages([...baseMessages, answer])
    setStreaming(true)
    scrollToBottom()
    const controller = new AbortController()
    abortRef.current = controller
    const seq = streamSeq.current + 1
    streamSeq.current = seq

    const commit = () => {
      if (seq !== streamSeq.current || !alive.current) return
      setMessages((previous) => previous.map((message, index) => (
        index === previous.length - 1 ? { ...answer } : message
      )))
    }
    const history: AiChatMessage[] = baseMessages
      .filter((message) => !message.loading && (message.role === 'user' || message.content.trim()))
      .map((message) => ({ role: message.role, content: message.content }))

    try {
      const response = await aiApi.chatStream(
        buildChatBody({ ...request, messages: history, stream: true }),
        controller.signal,
      )
      const reader = response.body?.getReader()
      if (!reader) throw new Error(t('cloudflare.ai.inference_failed'))
      const decoder = new TextDecoder()
      let buffer = ''
      let finished = false
      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const raw of lines) {
          const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          const streamError = chatStreamError(payload)
          if (streamError) throw new Error(streamError)
          if (payload === '[DONE]') {
            answer.thinkingDone = true
            finished = true
            await reader.cancel().catch((failure: unknown) => {
              console.warn('[inkstone] AI stream cancel failed:', failure)
            })
            break
          }
          const delta = readChatDelta(payload)
          if (delta.reasoning) {
            answer.reasoning = (answer.reasoning ?? '') + delta.reasoning
            answer.reasoningOpen = true
            commit()
            scrollToBottom()
            await nextFrame()
          }
          if (delta.content) {
            answer.thinkingDone = true
            answer.content += delta.content
            commit()
            scrollToBottom()
            await nextFrame()
          }
        }
      }
      answer.loading = false
      if (!answer.content && !answer.reasoning) answer.content = t('cloudflare.ai.empty_response')
    } catch (failure: unknown) {
      answer.loading = false
      if ((failure as Error)?.name === 'AbortError') {
        answer.content = answer.content
          ? `${answer.content}\n\n${t('cloudflare.ai.stopped')}`
          : t('cloudflare.ai.stopped')
      } else {
        const message = t('cloudflare.ai.error', { error: cfErrorText(failure) })
        answer.content = answer.content ? `${answer.content}\n\n${message}` : message
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
      commit()
      scrollToBottom()
    }
    return answer
  }

  async function autoName(
    session: AiChatSession,
    question: string,
    request: RequestConfig,
  ): Promise<void> {
    if (!shouldAutoNameSession(session)) return
    const current = sessionRef.current
    if (current?.id === session.id && !shouldAutoNameSession(current)) return
    let title = ''
    try {
      const completion = await aiApi.chat({
        model: request.model,
        messages: [
          { role: 'system', content: NAME_PROMPT },
          { role: 'user', content: question },
        ],
        max_tokens: 64,
        temperature: 0.3,
        ...(request.accountId !== AUTO_ACCOUNT ? { accountId: request.accountId } : {}),
      })
      title = sessionTitleFromAnswer(completion.choices?.[0]?.message?.content ?? '', question)
    } catch (failure: unknown) {
      // Naming is best-effort; the question still supplies a usable title.
      console.warn('[inkstone] AI session naming failed:', failure)
      title = sessionTitleFromAnswer('', question)
    }
    if (!title) return
    try {
      const updated = await chatSessionsApi.update(session.id, { title })
      setActiveSession((current) => (current?.id === updated.id ? updated : current))
      setSidebarRefresh((value) => value + 1)
      toast({ title: t('cloudflare.ai.history.named'), tone: 'success' })
    } catch (failure: unknown) {
      toast({ title: t('common.action_failed'), description: cfErrorText(failure), tone: 'danger' })
    }
  }

  async function sendMessage(text?: string): Promise<void> {
    const question = (text ?? prompt).trim()
    if (!question || !selectedModel || streaming || sending.current) return
    sending.current = true
    setPrompt('')
    const session = await ensureSession()
    if (!session) {
      sending.current = false
      return
    }
    const userMessage: ChatMessage = { role: 'user', content: question, createdAt: Date.now() }
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    scrollToBottom()

    try {
      await chatSessionsApi.append(session.id, [{ role: 'user', content: question }])
    } catch (failure: unknown) {
      toast({ title: t('common.action_failed'), description: cfErrorText(failure), tone: 'danger' })
    }

    const firstExchange = nextMessages.filter((message) => message.role === 'user').length === 1
    const attempt = streamSeq.current + 1
    const answer = await streamAnswer(nextMessages, config)
    if (!alive.current || streamSeq.current !== attempt) {
      sending.current = false
      return
    }
    if (answer.content || answer.reasoning) {
      try {
        await chatSessionsApi.append(session.id, [{ role: 'assistant', content: answer.content }])
        setSidebarRefresh((value) => value + 1)
      } catch (failure: unknown) {
        toast({ title: t('common.action_failed'), description: cfErrorText(failure), tone: 'danger' })
      }
    }
    if (firstExchange && answer.content) {
      await autoName(session, question, config)
    }
    sending.current = false
  }

  async function regenerate(): Promise<void> {
    if (streaming) return
    const lastIndex = messages.length - 1
    const last = messages[lastIndex]
    if (!last || last.role !== 'assistant' || last.loading) return
    let userIndex = -1
    for (let index = lastIndex - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'user') {
        userIndex = index
        break
      }
    }
    if (userIndex < 0) return
    const base = messages.slice(0, lastIndex)
    setMessages(base)
    if (activeSession) {
      try {
        await chatSessionsApi.removeLastAssistant(activeSession.id)
      } catch (failure: unknown) {
        toast({ title: t('common.action_failed'), description: cfErrorText(failure), tone: 'danger' })
      }
    }
    const attempt = streamSeq.current + 1
    const answer = await streamAnswer(base, config)
    if (!alive.current || streamSeq.current !== attempt) return
    if (activeSession && answer.content) {
      try {
        await chatSessionsApi.append(activeSession.id, [{ role: 'assistant', content: answer.content }])
        setSidebarRefresh((value) => value + 1)
      } catch (failure: unknown) {
        toast({ title: t('common.action_failed'), description: cfErrorText(failure), tone: 'danger' })
      }
    }
  }

  async function clearChat(): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.ai.clear_chat'),
      confirmLabel: t('cloudflare.ai.clear_chat'),
      cancelLabel: t('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    stopInference()
    loadSeq.current += 1
    streamSeq.current += 1
    setMessages([])
    let cleared = true
    if (activeSession) {
      try {
        await chatSessionsApi.clear(activeSession.id)
        setSidebarRefresh((value) => value + 1)
      } catch (failure: unknown) {
        cleared = false
        toast({ title: t('common.action_failed'), description: cfErrorText(failure), tone: 'danger' })
      }
    }
    if (cleared) toast({ title: t('cloudflare.ai.chat_cleared'), tone: 'success' })
  }

  function newChat(): void {
    stopInference()
    loadSeq.current += 1
    streamSeq.current += 1
    setActiveSession(null)
    setMessages([])
    setPrompt('')
    setHistoryOpen(false)
  }

  async function selectSession(session: AiChatSession): Promise<void> {
    stopInference()
    loadSeq.current += 1
    streamSeq.current += 1
    const seq = loadSeq.current
    setActiveSession(session)
    setMessages([])
    setHistoryOpen(false)
    try {
      const rows = await chatSessionsApi.messages(session.id)
      if (seq !== loadSeq.current) return
      setMessages(rows.map((row) => ({
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
      })))
      scrollToBottom()
    } catch (failure: unknown) {
      toast({ title: t('common.action_failed'), description: cfErrorText(failure), tone: 'danger' })
    }
  }

  function onSessionDeleted(id: string): void {
    if (activeSession?.id !== id) return
    streamSeq.current += 1
    setActiveSession(null)
    setMessages([])
  }

  return (
    <div className="flex h-full min-h-0">
      <main className="flex min-w-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          className={cn(
            'min-h-0 flex-1',
            messages.length === 0 ? 'flex items-center justify-center p-5' : 'overflow-y-auto p-4',
          )}
        >
          {messages.length === 0 ? (
            <div className="w-full max-w-2xl text-center">
              <h2 className="mb-6 text-[length:var(--text-26)] font-semibold text-[var(--text-primary)]">
                {t('cloudflare.ai.welcome')}
              </h2>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTION_KEYS.map((key) => (
                  <Button
                    key={key}
                    variant="subtle"
                    size="sm"
                    onClick={() => {
                      setPrompt(t(key))
                      void sendMessage(t(key))
                    }}
                  >
                    {t(key)}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              {messages.map((message, index) => (
                <div key={`${message.createdAt}-${index}`} className="min-w-0">
                  {message.role === 'user' ? (
                    <div className="flex flex-col items-end gap-1">
                      <div className="max-w-[85%] rounded-[var(--r-xl)] rounded-br-[var(--r-xs)] bg-[var(--accent-soft)] px-3.5 py-2.5 text-[length:var(--text-13)] leading-relaxed whitespace-pre-wrap text-[var(--text-primary)]">
                        {message.content}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <CopyButton text={message.content} label={t('cloudflare.ai.copy_message')} size="xs" />
                        <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                          {formatRelative(message.createdAt)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="flex min-w-0 gap-2.5">
                      <span
                        aria-hidden="true"
                        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)]"
                      >
                        <Sparkles size={13} />
                      </span>
                      <div className="min-w-0 flex-1">
                        {message.reasoning ? (
                          <div className="mb-2">
                            <button
                              type="button"
                              aria-expanded={message.reasoningOpen === true}
                              onClick={() => {
                                setMessages((previous) => previous.map((entry, entryIndex) => (
                                  entryIndex === index
                                    ? { ...entry, reasoningOpen: !entry.reasoningOpen }
                                    : entry
                                )))
                              }}
                              className="flex items-center gap-1 rounded-[var(--r-xs)] text-[length:var(--text-11-5)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                            >
                              <ChevronRight
                                size={12}
                                aria-hidden="true"
                                className={cn('transition-transform', message.reasoningOpen && 'rotate-90')}
                              />
                              {t('cloudflare.ai.thinking_process')}
                              {message.thinkingDone ? '' : t('cloudflare.ai.thinking_in_progress')}
                            </button>
                            {message.reasoningOpen ? (
                              <div className="mt-1.5 rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-2.5 text-[length:var(--text-11-5)] whitespace-pre-wrap text-[var(--text-tertiary)]">
                                {message.reasoning}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        {message.content && message.loading ? (
                          <p className="text-[length:var(--text-12-5)] break-words whitespace-pre-wrap text-[var(--text-primary)]">
                            {message.content}
                          </p>
                        ) : message.content ? (
                          <MarkdownBody source={message.content} />
                        ) : message.loading ? (
                          <p className="flex items-center gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                            <Spinner size={13} />
                            {t('cloudflare.ai.thinking')}
                          </p>
                        ) : null}
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {message.content ? (
                            <CopyButton text={message.content} label={t('cloudflare.ai.copy_message')} size="xs" />
                          ) : null}
                          {!message.loading && !streaming && index === messages.length - 1 ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<RefreshCw size={12} />}
                              onClick={() => { void regenerate() }}
                            >
                              {t('cloudflare.ai.regenerate')}
                            </Button>
                          ) : null}
                          <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                            {formatRelative(message.createdAt)}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-[var(--border-subtle)] p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <SelectMenu
              label={t('cloudflare.ai.account')}
              value={accountId}
              options={accountOptions}
              onChange={setAccountId}
              width={220}
              className="w-40"
            />
            <SelectMenu
              label={t('cloudflare.ai.select_model')}
              value={selectedModel}
              options={modelOptions}
              onChange={setSelectedModel}
              placeholder={t('cloudflare.ai.select_model')}
              disabled={modelOptions.length === 0}
              width={300}
              className="w-56"
            />
            <IconButton label={t('cloudflare.ai.chat_settings')} onClick={() => setParamsOpen(true)}>
              <Settings2 size={15} />
            </IconButton>
            <IconButton
              label={t('cloudflare.ai.history.title')}
              className="md:hidden"
              onClick={() => setHistoryOpen(true)}
            >
              <History size={15} />
            </IconButton>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {messages.length > 0 ? (
                <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={newChat}>
                  {t('cloudflare.ai.new_chat')}
                </Button>
              ) : null}
              {messages.length > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={13} />}
                  className="text-[var(--danger)] hover:text-[var(--danger)]"
                  onClick={() => { void clearChat() }}
                >
                  {t('cloudflare.ai.clear_chat')}
                </Button>
              ) : null}
            </div>
          </div>
          <div className="relative rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-inset)]">
            <Textarea
              rows={4}
              value={prompt}
              aria-label={t('cloudflare.ai.send_message')}
              placeholder={t('cloudflare.ai.send_message')}
              disabled={streaming}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void sendMessage()
                }
              }}
              className="min-h-24 resize-none border-0 bg-transparent pb-11 focus:shadow-none"
            />
            <div className="absolute inset-x-2 bottom-2 flex justify-end">
              {streaming ? (
                <IconButton label={t('cloudflare.ai.stop')} variant="secondary" onClick={stopInference}>
                  <Square size={14} />
                </IconButton>
              ) : (
                <IconButton
                  label={t('cloudflare.ai.send')}
                  variant="primary"
                  disabled={!prompt.trim() || !selectedModel}
                  onClick={() => { void sendMessage() }}
                >
                  <Send size={14} />
                </IconButton>
              )}
            </div>
          </div>
        </div>
      </main>

      <aside className="hidden w-72 shrink-0 border-l border-[var(--border-subtle)] md:flex">
        <ChatHistorySidebar
          activeId={activeSession?.id ?? null}
          onSelect={(session) => { void selectSession(session) }}
          onNewChat={newChat}
          onDeleted={onSessionDeleted}
          onUpdated={(session) => {
            setActiveSession((current) => (current?.id === session.id ? session : current))
          }}
          refreshKey={sidebarRefresh}
          className="w-full"
        />
      </aside>

      <Drawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title={t('cloudflare.ai.history.title')}
        width={340}
        bodyClassName="flex min-h-0 flex-col"
      >
        <ChatHistorySidebar
          activeId={activeSession?.id ?? null}
          onSelect={(session) => { void selectSession(session) }}
          onNewChat={newChat}
          onDeleted={onSessionDeleted}
          onUpdated={(session) => {
            setActiveSession((current) => (current?.id === session.id ? session : current))
          }}
          refreshKey={sidebarRefresh}
          className="min-h-0 flex-1"
        />
      </Drawer>

      <Modal
        open={paramsOpen}
        onClose={() => setParamsOpen(false)}
        title={t('cloudflare.ai.chat_settings')}
        width={460}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setParams({ ...CHAT_PARAM_DEFAULTS })}>
              {t('cloudflare.ai.param_reset')}
            </Button>
            <Button variant="primary" onClick={() => setParamsOpen(false)}>{t('common.close')}</Button>
          </>
        )}
      >
        <div className="grid gap-4">
          <div className="space-y-1.5">
            <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]" htmlFor="chat-max-tokens">
              {t('cloudflare.ai.param_max_tokens')}
            </label>
            <Input
              id="chat-max-tokens"
              type="number"
              min={1}
              max={8192}
              step={256}
              value={params.max_tokens}
              onChange={(event) => setParams((current) => ({ ...current, max_tokens: Number(event.target.value) }))}
            />
            <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
              {t('cloudflare.ai.param_max_tokens_hint')}
            </p>
          </div>
          <div className="space-y-1">
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('cloudflare.ai.param_temperature')}
            </span>
            <Slider
              label={t('cloudflare.ai.param_temperature')}
              value={params.temperature}
              min={0}
              max={2}
              step={0.05}
              onChange={(value) => setParams((current) => ({ ...current, temperature: value }))}
            />
          </div>
          <div className="space-y-1">
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('cloudflare.ai.param_top_p')}
            </span>
            <Slider
              label={t('cloudflare.ai.param_top_p')}
              value={params.top_p}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => setParams((current) => ({ ...current, top_p: value }))}
            />
          </div>
          <div className="space-y-1">
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('cloudflare.ai.param_presence_penalty')}
            </span>
            <Slider
              label={t('cloudflare.ai.param_presence_penalty')}
              value={params.presence_penalty}
              min={-2}
              max={2}
              step={0.1}
              onChange={(value) => setParams((current) => ({ ...current, presence_penalty: value }))}
            />
          </div>
          <div className="space-y-1">
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('cloudflare.ai.param_frequency_penalty')}
            </span>
            <Slider
              label={t('cloudflare.ai.param_frequency_penalty')}
              value={params.frequency_penalty}
              min={-2}
              max={2}
              step={0.1}
              onChange={(value) => setParams((current) => ({ ...current, frequency_penalty: value }))}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
