/**
 * Quick Ask: a small question beside the note, without leaving it.
 *
 * The panel sends an ephemeral turn through the same stream the chat uses. It does not open the chat
 * tab, change the active conversation, or write to the history list. The answer can be copied, inserted
 * at the caret, or discarded.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, CornerDownLeft, Square, WandSparkles, X } from 'lucide-react'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { Button, IconButton } from '../../components/primitives'
import { useDialogFocus, useEscape } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { getActiveEditorView } from '../../editor/commands'
import { copyText } from '../../lib/clipboard'
import { streamAssistantTurn } from './stream'
import { editorAiAnchor, locateAnchor } from './editor-ai'
import { useQuickAsk } from './quick-ask-store'

const PANEL_WIDTH = 380
const PANEL_EDGE = 12
const CONTEXT_CAP = 8_000

type Mode = 'ask' | 'continue'

function place(anchor: { top: number, left: number } | null): { top: number, left: number } {
  if (!anchor) return { top: 64, left: Math.max(PANEL_EDGE, window.innerWidth - PANEL_WIDTH - PANEL_EDGE) }
  return {
    top: Math.max(PANEL_EDGE, Math.min(anchor.top, window.innerHeight - 260)),
    left: Math.max(PANEL_EDGE, Math.min(anchor.left, window.innerWidth - PANEL_WIDTH - PANEL_EDGE)),
  }
}

export function QuickAskPanel() {
  const open = useQuickAsk((state) => state.open)
  const context = useQuickAsk((state) => state.context)
  const anchor = useQuickAsk((state) => state.anchor)
  const close = useQuickAsk((state) => state.close)
  const toast = useUi((state) => state.toast)
  const [mode, setMode] = useState<Mode>('ask')
  const [text, setText] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const pos = useMemo(() => place(anchor), [anchor])

  useEscape(open, () => {
    abortRef.current?.abort()
    close()
  })
  useDialogFocus(open, panelRef, inputRef)

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort()
      abortRef.current = null
      setAnswer('')
      setError(null)
      setBusy(false)
      return
    }
    setMode('ask')
    setText('')
    setAnswer('')
    setError(null)
    setBusy(false)
  }, [open])

  if (!open) return null

  const send = async () => {
    if (busy) return
    const instruction = text.trim()
    const source = (context.selection.trim() || context.whole).slice(-CONTEXT_CAP)
    const prompt = mode === 'continue'
      ? [
          instruction || t('assistant.quick_ask.continue_prompt'),
          `Continue this passage from my note “${context.noteTitle || t('common.untitled_note')}”. Reply with the continuation only.`,
          `---\n${source}\n---`,
        ].join('\n\n')
      : [
          instruction || t('assistant.quick_ask.ask_prompt'),
          context.selection.trim() ? `The passage I am looking at:\n---\n${context.selection.slice(0, CONTEXT_CAP)}\n---` : '',
        ].filter(Boolean).join('\n\n')
    if (!prompt.trim()) return
    setBusy(true)
    setAnswer('')
    setError(null)
    const controller = new AbortController()
    abortRef.current = controller
    let received = ''
    try {
      await streamAssistantTurn({
        message: prompt,
        ...(context.noteId ? { contextNoteId: context.noteId, noteId: context.noteId } : {}),
        ephemeral: true,
        noTools: true,
      }, (event) => {
        if (event.type === 'text' && event.delta) {
          received += event.delta
          setAnswer(received)
        }
        if (event.type === 'error') setError(event.message ?? event.error ?? t('assistant.quick_ask.failed'))
      }, controller.signal)
    } catch (caught) {
      if ((caught as Error)?.name !== 'AbortError') {
        setError(caught instanceof Error ? caught.message : t('assistant.quick_ask.failed'))
      }
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  const insert = () => {
    if (!answer.trim()) return
    const view = getActiveEditorView()
    if (!view) {
      toast({ title: t('assistant.quick_ask.no_editor'), tone: 'warning' })
      return
    }
    const doc = view.state.doc.toString()
    let from = Math.min(context.from, doc.length)
    let to = Math.min(context.to, doc.length)
    if (context.selection.trim()) {
      const anchor = editorAiAnchor(context.whole, context.from, context.to)
      const at = locateAnchor(doc, anchor.lead, context.selection, anchor.trail)
      if (at === null) {
        toast({ title: t('assistant.quick_ask.stale'), tone: 'warning' })
        return
      }
      from = at
      to = at + context.selection.length
    }
    const body = answer.trim()
    view.dispatch({
      changes: { from, to, insert: body },
      selection: { anchor: from + body.length },
    })
    view.focus()
    toast({ title: t('assistant.quick_ask.inserted'), tone: 'success' })
    close()
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label={t('assistant.quick_ask.title')}
      data-quick-ask="1"
      className="fixed z-[var(--z-popover)] flex max-h-[min(520px,80vh)] flex-col overflow-hidden rounded-[var(--r-xl)] border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-[var(--shadow-modal)]"
      style={{ top: pos.top, left: pos.left, width: PANEL_WIDTH }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <WandSparkles size={14} className="text-[var(--accent)]" />
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] font-semibold text-[var(--text-primary)]">{t('assistant.quick_ask.title')}</span>
        <IconButton label={t('common.close')} size="sm" onClick={() => { abortRef.current?.abort(); close() }}>
          <X size={13} />
        </IconButton>
      </div>
      <div className="flex shrink-0 gap-1 px-3 pt-2">
        <button
          type="button"
          aria-pressed={mode === 'ask'}
          onClick={() => setMode('ask')}
          className={cn(
            'rounded-[var(--r-md)] px-2 py-1 text-[length:var(--text-11-5)]',
            mode === 'ask' ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
          )}
        >
          {t('assistant.quick_ask.mode_ask')}
        </button>
        <button
          type="button"
          aria-pressed={mode === 'continue'}
          onClick={() => setMode('continue')}
          className={cn(
            'rounded-[var(--r-md)] px-2 py-1 text-[length:var(--text-11-5)]',
            mode === 'continue' ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
          )}
        >
          {t('assistant.quick_ask.mode_continue')}
        </button>
      </div>
      <textarea
        ref={inputRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void send()
          }
        }}
        rows={3}
        placeholder={mode === 'continue' ? t('assistant.quick_ask.continue_placeholder') : t('assistant.quick_ask.placeholder')}
        aria-label={t('assistant.quick_ask.title')}
        className="mx-3 mt-2 min-h-16 shrink-0 resize-y rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2.5 py-2 text-[length:var(--text-12-5)] text-[var(--text-primary)] outline-none focus-visible:border-[var(--accent)]"
      />
      {error && <p role="alert" className="mx-3 mt-1.5 text-[length:var(--text-11)] text-[var(--danger)]">{error}</p>}
      {answer && (
        <div className="mx-3 mt-2 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-2 text-[length:var(--text-12-5)] leading-relaxed text-[var(--text-secondary)]">
          {answer}
        </div>
      )}
      <div className="mt-2 flex shrink-0 items-center gap-1 border-t border-[var(--border-subtle)] px-3 py-2">
        {busy ? (
          <Button size="sm" variant="secondary" icon={<Square size={12} />} onClick={() => abortRef.current?.abort()}>
            {t('assistant.quick_ask.stop')}
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={<CornerDownLeft size={12} />} disabled={!text.trim() && mode !== 'continue'} onClick={() => void send()}>
            {t('assistant.quick_ask.send')}
          </Button>
        )}
        <span className="flex-1" />
        <IconButton label={t('common.copy')} size="sm" disabled={!answer} onClick={() => { void copyText(answer).then((ok) => { if (ok) toast({ title: t('assistant.quick_ask.copied'), tone: 'success' }) }) }}>
          <Copy size={13} />
        </IconButton>
        <Button size="sm" variant="ghost" disabled={!answer} onClick={insert}>
          {t('assistant.quick_ask.insert')}
        </Button>
      </div>
    </div>
  )
}
