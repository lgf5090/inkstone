/** A small assistant drawer scoped to the handwriting note on screen. */
import { useState } from 'react'
import { Send, Sparkles, Trash2 } from 'lucide-react'
import type { InknoteNoteMeta, InknotePage, InknoteSettings } from '@shared/inknote/types'
import { t } from '../../../lib/i18n'
import { isImeComposing } from '../../../lib/ime'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { Drawer } from '../../../components/overlay'
import { inknoteTextDefaults } from '../tool-state'
import { useInknoteStore } from '../store'

interface Message { role: 'user' | 'assistant'; text: string }

async function streamAnswer(body: { message: string; conversationId?: string }, onDelta: (delta: string) => void, onConversation: (id: string) => void): Promise<string> {
  const response = await fetch('/api/assistant/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inkstone-Client': '1' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(data?.error?.message ?? `HTTP ${response.status}`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The assistant returned no stream')
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.trim()
      if (!line.startsWith('data:')) continue
      try {
        const event = JSON.parse(line.slice(5).trim()) as { type?: string; delta?: string; conversationId?: string; finalMessage?: { content?: string } }
        if (event.type === 'start' && event.conversationId) onConversation(event.conversationId)
        if (event.type === 'delta' && event.delta) { answer += event.delta; onDelta(event.delta) }
        if (event.type === 'done' && event.finalMessage?.content) answer = event.finalMessage.content
      } catch { /* an incomplete frame is normal at chunk boundaries */ }
    }
  }
  return answer
}

export function AiPanel({ open, onClose, note, pages, settings }: {
  open: boolean
  onClose: () => void
  note: InknoteNoteMeta | null
  pages: InknotePage[]
  settings: InknoteSettings
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [conversationId, setConversationId] = useState<string | undefined>(undefined)
  const insert = (text: string) => {
    if (!note) return
    const state = useInknoteStore.getState()
    const page = state.pages.find((entry) => entry.id === state.activePageId)
    if (!page) return
    let y = 0.08
    for (const paragraph of text.split(/\n+/).map((line) => line.trim()).filter(Boolean)) {
      const lines = Math.max(1, Math.ceil(paragraph.length / 30))
      const height = Math.max(0.05, (lines * settings.textSize * 1.3 + 12) / note.pageHeight)
      page.content.texts.push({ ...inknoteTextDefaults(), id: crypto.randomUUID().replace(/-/g, ''), x: 0.06, y, w: 0.88, h: height, text: paragraph, fontSize: settings.textSize })
      y += height + 0.02
    }
    state.touchPage()
    window.dispatchEvent(new Event('inknote:invalidate'))
    void state.savePage(page.id)
  }
  const speak = (text: string) => {
    if (typeof window.speechSynthesis === 'undefined') return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = document.documentElement.lang || 'zh-CN'
    utterance.rate = settings.ttsRate
    window.speechSynthesis.speak(utterance)
  }
  const send = async (override?: string) => {
    const text = (override ?? input).trim()
    if (!text || busy) return
    setInput('')
    setMessages((list) => [...list, { role: 'user', text }])
    setMessages((list) => [...list, { role: 'assistant', text: '' }])
    setBusy(true)
    const context = pages.flatMap((page) => page.content.texts.map((item) => item.text)).filter(Boolean).join('\n').slice(0, 6000)
    const message = context ? `${text}\n\n[The reader's handwriting note "${note?.title ?? ''}" says:]\n${context}` : text
    try {
      await streamAnswer({ message, conversationId }, (delta) => {
        setMessages((list) => list.map((entry, index) => index === list.length - 1 ? { ...entry, text: entry.text + delta } : entry))
      }, setConversationId)
    } catch (error) {
      setMessages((list) => list.map((entry, index) => index === list.length - 1 ? { ...entry, text: error instanceof Error ? error.message : String(error) } : entry))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Drawer open={open} onClose={onClose} title={t('inknote.ai.title' as never)} width={380} side="right">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-[var(--border-subtle)] px-2 py-1">
          <IconButton label={t('inknote.ai.summary' as never)} size="sm" onClick={() => void send('Please summarise this handwritten note in concise bullet points.')}><Sparkles size={14}/></IconButton>
          <IconButton label={t('inknote.delete')} size="sm" onClick={() => { setMessages([]); setConversationId(undefined) }}><Trash2 size={14}/></IconButton>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {messages.length === 0 && <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('inknote.ai.title' as never)}</p>}
          {messages.map((message, index) => (
            <div key={index} className={message.role === 'user' ? 'ml-8 rounded-[var(--r-md)] bg-[var(--accent-soft)] p-2 text-[length:var(--text-12)]' : 'mr-4 rounded-[var(--r-md)] bg-[var(--bg-surface)] p-2 text-[length:var(--text-12)]'}>
              <p className="whitespace-pre-wrap">{message.text}</p>
              {message.role === 'assistant' && message.text && (
                <div className="mt-1 flex gap-2 text-[length:var(--text-10-5)]">
                  <button type="button" className="underline" onClick={() => insert(message.text)}>{t('inknote.ai.insert' as never)}</button>
                  <button type="button" className="underline" onClick={() => speak(message.text)}>{t('inknote.ai.read' as never)}</button>
                </div>
              )}
            </div>
          ))}
          {busy && <div className="flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]"><Spinner size={12}/>{t('inknote.saving')}</div>}
        </div>
        <div className="border-t border-[var(--border-subtle)] p-2">
          <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} className="h-20 w-full resize-none rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-inset)] p-2 text-[length:var(--text-12)] outline-none focus:border-[var(--accent)]" aria-label={t('inknote.ai.title' as never)} />
          <Button size="sm" variant="primary" icon={<Send size={13}/>} loading={busy} onClick={() => void send()}>{t('inknote.ai.title' as never)}</Button>
        </div>
      </div>
    </Drawer>
  )
}
