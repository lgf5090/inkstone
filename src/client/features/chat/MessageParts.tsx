/**
 * The pieces of one assistant reply.
 *
 * Three things the reference project got wrong in ways only a reader notices:
 *  - it reused the note prose class, so a one-line answer filled a screen;
 *  - it stored the tool chip's words in English inside the message row, so a Chinese interface showed
 *    English pills that no translation could reach;
 *  - it kept the Approve button live after the reply was saved, because it read the approval out of the
 *    message rather than out of the pending-action table.
 *
 * So the chip's words come from the locale catalog by tool name, the prose is its own class, and the
 * approval card is driven by the action's current status.
 */
import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  MoreHorizontal,
  NotebookPen,
  Play,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Wrench,
  XCircle
} from 'lucide-react'
import type { AssistantAnswerVersion, AssistantSource, MessageFeedback, ToolActivity } from '@shared/assistant'
import { ASSISTANT_TOOL_BY_NAME, mcpToolOrigin } from '@shared/assistant'
import { cn } from '../../lib/cn'
import { COPY_RESET_MS } from '../../lib/motion'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { useNotes } from '../../store/notes'
import { useLocale } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { MarkdownBody } from '../preview/MarkdownBody'
import { useAssistant } from './assistant-store'
import { useUi } from '../../store/ui'
import { MessageAttachments } from './ChatAttachments'
import { CHAT_NOTE_LINKS } from './note-links'
import { MessageMenu, useMessageMenu } from './MessageMenu'
import { SelectionTick, type MessageSelection } from './SelectionBar'
import { noteRefsFromToolResult } from './note-refs'
import { embedConversationInNote, insertReplyIntoNote, saveConversationAsNote, saveReplyAsNote } from './save-to-note'

const STAGE_KEYS = {
  waiting: 'assistant.chat.stage_waiting',
  reading: 'assistant.chat.stage_reading',
  searching: 'assistant.chat.stage_searching',
  generating: 'assistant.chat.stage_generating',
} as const

export function MarkdownReply({ source }: { source: string }) {
  // The reply is read by the same renderer a note's preview is, so a formula is drawn, a diagram is
  // drawn, and a `[[note]]` is a door into the notebook rather than a word that looks like a link.
  return <MarkdownBody source={source} className="ink-chat-prose min-w-0" links={CHAT_NOTE_LINKS} />
}

/**
 * What the reply did, as one fold rather than a row of pills per call.
 *
 * A turn that searched, read two notes and called a third party used to open as four chips in a row, and
 * a long thread read as a wall of them. The group is the answer to "what did it do" and the rows inside
 * are the answer to "what exactly" — which is what a reader wants when the answer looks wrong.
 *
 * It opens by itself while a call is in flight, because that is the half of a turn worth watching, and
 * folds once the turn settles; from then on it is whatever the reader last chose.
 */
export function ToolCallList({ tools, messageId }: { tools: ToolActivity[], messageId?: string }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const [rows, setRows] = useState<Record<string, boolean>>({})
  const running = tools.some((tool) => tool.status === 'running')
  const expanded = open ?? running
  return (
    <div className="min-w-0 max-w-full" role="group" aria-label={t('assistant.chat.tools_group')}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
        className="inline-flex max-w-full items-center gap-1.5 rounded-[var(--r-sm)] px-1 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
      >
        <Wrench size={11} className="shrink-0 text-[var(--text-quaternary)]" />
        <span className="min-w-0 truncate">{t('assistant.chat.tools_group')}</span>
        <span className="shrink-0 tabular-nums text-[var(--text-quaternary)]">{t('assistant.chat.tool_calls', { count: tools.length })}</span>
        <ChevronDown size={11} className={cn('shrink-0 transition-transform duration-[var(--dur-fast)]', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <ul className="mt-1 flex max-w-full flex-col gap-1">
          {tools.map((tool) => (
            <li key={tool.id} className="min-w-0 max-w-full">
              <ToolCallRow
                tool={tool}
                messageId={messageId}
                open={Boolean(rows[tool.id])}
                onToggle={() => setRows((current) => ({ ...current, [tool.id]: !current[tool.id] }))}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const TOOL_STATUS_KEYS = {
  running: 'assistant.chat.tool_running',
  success: 'assistant.chat.tool_done',
  error: 'assistant.chat.tool_failed',
} as const

/**
 * The name a stored call wears on its row.
 *
 * A third party's function arrives namespaced (`mcp_rzmbk9_query-docs`), which says nothing to a reader.
 * The configured servers are already in the store, so the row says `Context7 · query-docs` where that
 * list has landed and keeps the raw name when it has not — a chip is never worth a failed read.
 */
function useToolLabel(name: string) {
  const servers = useAssistant((state) => state.mcpServers)
  const locale = useLocale()
  return useMemo(() => {
    if (!name.startsWith('mcp_')) {
      const spec = ASSISTANT_TOOL_BY_NAME.get(name)
      return { label: spec ? t(spec.labelKey) : name, external: false }
    }
    const origin = mcpToolOrigin(name, servers)
    return {
      label: origin ? `${origin.serverLabel} · ${origin.remoteName}` : name,
      external: true,
    }
  }, [name, servers, locale])
}

/**
 * One call, folded.
 *
 * The row states what happened before anything is opened — a spinner, a check or a cross, and the word
 * for it — and the payloads underneath are the text the model was actually given and handed back. A
 * third-party call also offers to run again: a reader looking at an answer built on a stale lookup has no
 * other way to ask whether it is still stale.
 */
function ToolCallRow({ tool, messageId, open, onToggle }: {
  tool: ToolActivity
  messageId?: string
  open: boolean
  onToggle: () => void
}) {
  const { label, external } = useToolLabel(tool.name)
  const replay = useAssistant((state) => state.replayMcpTool)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [again, setAgain] = useState<{ ok: boolean, error: string, result: string } | null>(null)
  const refs = useMemo(() => noteRefsFromToolResult(tool.name, tool.result), [tool.name, tool.result])
  const body = [
    tool.args ? { key: 'assistant.chat.tool_args' as const, text: tool.args } : null,
    tool.result ? { key: 'assistant.chat.tool_result' as const, text: tool.result } : null,
  ].filter((entry): entry is { key: 'assistant.chat.tool_args' | 'assistant.chat.tool_result', text: string } => entry !== null)
  return (
    <div
      className={cn(
        'max-w-full min-w-0 overflow-hidden rounded-[var(--r-md)] border',
        tool.status === 'error'
          ? 'border-[color-mix(in_oklab,var(--danger)_35%,transparent)] bg-[var(--danger-soft)]'
          : 'border-[var(--border-subtle)] bg-[var(--bg-inset)]',
      )}
    >
      <button
        type="button"
        data-tool-chip={tool.name}
        title={tool.error ?? undefined}
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-[var(--bg-hover)]"
      >
        {tool.status === 'running'
          ? <Loader2 size={12} className="shrink-0 animate-spin text-[var(--text-quaternary)]" />
          : tool.status === 'error'
            ? <XCircle size={12} className="shrink-0 text-[var(--danger)]" />
            : <Check size={12} className="shrink-0 text-[var(--success)]" />}
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
          {label}
          {tool.detail ? <span className="text-[var(--text-quaternary)]"> · {tool.detail}</span> : null}
        </span>
        <span
          className={cn(
            'shrink-0 text-[length:var(--text-10-5)]',
            tool.status === 'error' ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]',
          )}
        >
          {t(TOOL_STATUS_KEYS[tool.status] ?? TOOL_STATUS_KEYS.success)}
        </span>
        <ChevronDown size={11} className={cn('shrink-0 text-[var(--text-quaternary)] transition-transform duration-[var(--dur-fast)]', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="flex max-w-full min-w-0 flex-col gap-1.5 border-t border-[var(--border-subtle)] px-2 py-1.5">
          {tool.error && (
            <p className="min-w-0 break-words text-[length:var(--text-11)] text-[var(--danger)]">{tool.error}</p>
          )}
          {body.length === 0 && !tool.error && (
            <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.chat.tool_no_data')}</p>
          )}
          {body.map((entry) => (
            <div key={entry.key} className="min-w-0">
              <p className="text-[length:var(--text-10-5)] uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">{t(entry.key)}</p>
              {/* A tool answers with whatever it likes, so this is text as it arrived — never markdown and
                  never HTML, or a remote server's own output would render as this app's interface. */}
              <pre
                aria-label={t(entry.key)}
                className="mt-0.5 max-h-[280px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-[var(--r-sm)] border-l border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1.5 font-mono text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-tertiary)]"
              >{entry.text}</pre>
            </div>
          ))}
          {refs.length > 0 && (
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('assistant.chat.notes_in_result')}>
              {refs.map((ref) => (
                <button
                  key={ref.id}
                  type="button"
                  onClick={() => CHAT_NOTE_LINKS.openNote(ref.id)}
                  className="inline-flex max-w-[220px] items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)] transition-colors duration-[var(--dur-fast)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  <FileText size={11} className="shrink-0 text-[var(--text-quaternary)]" />
                  <span className="min-w-0 truncate">{ref.title}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1">
            {tool.result && (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(tool.result ?? '').then(() => {
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), COPY_RESET_MS)
                  })
                }}
                className="inline-flex items-center gap-1 rounded-[var(--r-sm)] px-1 py-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
              >
                {copied ? <Check size={11} /> : <Copy size={11} />}
                {copied ? t('assistant.chat.copied') : t('assistant.chat.copy')}
              </button>
            )}
            {external && messageId && tool.args && tool.status !== 'running' && (
              <button
                type="button"
                disabled={busy}
                title={t('assistant.chat.replay_hint')}
                onClick={() => {
                  setBusy(true)
                  void replay(useAssistant.getState().activeId ?? '', messageId, tool.id)
                    .then(setAgain)
                    .finally(() => setBusy(false))
                }}
                className="inline-flex items-center gap-1 rounded-[var(--r-sm)] px-1 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--accent-on-soft)] hover:bg-[var(--accent-soft)] disabled:opacity-50"
              >
                {busy ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                {busy ? t('assistant.chat.replaying') : t('assistant.chat.replay')}
              </button>
            )}
          </div>
          {again && (
            <div className="min-w-0 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1.5">
              <p className="text-[length:var(--text-10-5)] uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">{t('assistant.chat.replay_result')}</p>
              {again.ok
                ? <pre aria-label={t('assistant.chat.replay_result')} className="mt-0.5 max-h-[280px] max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-tertiary)]">{again.result}</pre>
                : <p className="mt-0.5 break-words text-[length:var(--text-11)] text-[var(--danger)]">{again.error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const OUTCOME_KEYS = {
  approved: 'assistant.approval.done',
  cancelled: 'assistant.approval.declined',
  expired: 'assistant.approval.expired',
  failed: 'assistant.approval.failed',
} as const

export function ApprovalCard({ action }: { action: ToolActivity['approval'] }) {
  const decide = useAssistant((state) => state.decideAction)
  const [busy, setBusy] = useState<'approve' | 'cancel' | null>(null)
  if (!action) return null
  const spec = action.tool ? ASSISTANT_TOOL_BY_NAME.get(action.tool) : undefined
  // A deletion has a sentence of its own, because what it would remove is the thing worth reading.
  // Everything else is held for approval as the call itself, so the tool's own name is the question.
  const question = spec?.approvalKey
    ? t(spec.approvalKey, { title: action.targetLabel })
    : spec ? t(spec.labelKey) : action.targetLabel

  if (action.status !== 'pending') {
    return (
      <div
        data-approval-outcome={action.status}
        className="flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-1.5 text-[length:var(--text-12)] text-[var(--text-tertiary)]"
      >
        {action.status === 'approved'
          ? <Check size={13} className="mt-0.5 shrink-0 text-[var(--success)]" />
          : <XCircle size={13} className={cn('mt-0.5 shrink-0', action.status === 'failed' && 'text-[var(--danger)]')} />}
        <span className="min-w-0 break-words">
          <span className="text-[var(--text-secondary)]">{question}</span>
          {' · '}
          {t(OUTCOME_KEYS[action.status] ?? OUTCOME_KEYS.expired)}
          {action.status === 'failed' && action.error ? `: ${action.error}` : ''}
        </span>
      </div>
    )
  }

  return (
    <div
      data-approval-card={action.id}
      role="group"
      aria-label={t('assistant.approval.title')}
      className="rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--warning)_45%,transparent)] bg-[var(--bg-surface)] px-3 py-2 shadow-[var(--shadow-sm)]"
    >
      <div className="flex items-start gap-2 text-[length:var(--text-12-5)]">
        <ShieldAlert size={14} className="mt-0.5 shrink-0 text-[var(--warning)]" />
        <div className="min-w-0">
          <p className="break-words font-medium text-[var(--text-primary)]">{question}</p>
          <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('assistant.approval.hint')}</p>
        </div>
      </div>
      <div className="mt-2 flex justify-end gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => {
            setBusy('cancel')
            void decide(action.id, false).finally(() => setBusy(null))
          }}
        >
          {t('assistant.approval.decline')}
        </Button>
        <Button
          size="sm"
          variant="danger"
          loading={busy === 'approve'}
          disabled={busy !== null}
          onClick={() => {
            setBusy('approve')
            void decide(action.id, true).finally(() => setBusy(null))
          }}
        >
          {t('assistant.approval.approve')}
        </Button>
      </div>
    </div>
  )
}

/**
 * The answers one turn has already displaced, walked with two arrows.
 *
 * The live answer is the last page; anything before it is a read-only look, and the reader has to press
 * "use this one" before it becomes the turn's answer again. That is the notes app's version history in
 * miniature, and for the same reason: looking must never overwrite.
 */
function AnswerVersionPager({ total, page, onStep, onRestore, busy }: {
  total: number
  page: number
  onStep: (delta: 1 | -1) => void
  onRestore: () => void
  busy: boolean
}) {
  const viewingOld = page < total - 1
  return (
    <span role="group" aria-label={t('assistant.chat.answer_history')} className="inline-flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => onStep(-1)}
        disabled={busy || page <= 0}
        aria-label={t('assistant.chat.previous')}
        className="inline-flex size-5 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronLeft size={12} />
      </button>
      <span aria-live="polite" className="min-w-[34px] text-center text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">
        {page + 1}/{total}
      </span>
      <button
        type="button"
        onClick={() => onStep(1)}
        disabled={busy || page >= total - 1}
        aria-label={t('assistant.chat.next')}
        className="inline-flex size-5 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronRight size={12} />
      </button>
      {viewingOld && (
        <button
          type="button"
          onClick={onRestore}
          disabled={busy}
          className="ml-0.5 inline-flex items-center gap-1 rounded-[var(--r-sm)] px-1 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--accent-on-soft)] hover:bg-[var(--accent-soft)] disabled:opacity-50"
        >
          {t('assistant.chat.use_this')}
        </button>
      )}
    </span>
  )
}

/** The cost of the answer and the speed it arrived at: total tokens, then output tokens per second. */
export function answerStats(usage: { inputTokens: number, outputTokens: number } | null | undefined, durationMs: number): string | null {
  if (!usage || (!usage.inputTokens && !usage.outputTokens)) return null
  const total = usage.inputTokens + usage.outputTokens
  const seconds = durationMs / 1000
  if (!usage.outputTokens || seconds <= 0) return `${total.toLocaleString('en-US')} ${t('assistant.chat.tokens')}`
  return `${total.toLocaleString('en-US')} ${t('assistant.chat.tokens')} · ${(usage.outputTokens / seconds).toFixed(1)} ${t('assistant.chat.tokens_per_second')}`
}

export function AssistantBubble({
  text,
  reasoning,
  tools,
  error,
  streaming,
  cancelled,
  stage,
  messageId,
  onRetry,
  retryLabel = 'assistant.chat.retry',
  usage,
  durationMs = 0,
  modelLabel = '',
  versionCount = 0,
  sources = [],
  attachments = [],
  feedback,
  onRate,
  selection,
  onStartPicking,
  onShare,
  loadVersions,
  onActivate,
}: {
  text: string
  reasoning: string
  tools: ToolActivity[]
  error: string | null
  streaming: boolean
  cancelled?: boolean
  stage?: 'reading' | 'searching' | 'generating' | 'waiting'
  /** The row this reply is stored on, which is what a third-party call is run again from. */
  messageId?: string
  onRetry?: () => void
  retryLabel?: 'assistant.chat.retry' | 'assistant.chat.regenerate'
  usage?: { inputTokens: number, outputTokens: number } | null
  durationMs?: number
  modelLabel?: string
  /** How many earlier answers this turn still holds. The pager appears at two or more pages. */
  versionCount?: number
  /** The pages a web search consulted on this turn. Empty for an answer that did not search. */
  sources?: AssistantSource[]
  /** The files this answer made, by attachment id: a picture the assistant drew for the reader. */
  attachments?: string[]
  /** The verdict already left on this answer, so the thumb that is down stays down. */
  feedback?: MessageFeedback
  /** Absent on a live turn: a verdict needs a row to be stored on. */
  onRate?: (feedback: MessageFeedback) => void
  /** Present while the reader is picking turns out of the thread. */
  selection?: MessageSelection
  /** Turns the thread into a picker, starting from this answer. */
  onStartPicking?: (messageId: string) => void
  /** Publishes this one answer behind a link. Absent on a turn still arriving, which has no row yet. */
  onShare?: (messageId: string) => void
  loadVersions?: () => Promise<AssistantAnswerVersion[]>
  onActivate?: (versionId: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const [showReasoning, setShowReasoning] = useState(false)
  const [versions, setVersions] = useState<AssistantAnswerVersion[] | null>(null)
  const menu = useMessageMenu()
  // The rows behind the ids this answer carries, so a picture it drew can be drawn here rather than
  // named by an id nobody can resolve.
  const fileIndex = useAssistant((state) => state.fileIndex)
  const [page, setPage] = useState<number | null>(null)
  const [swapping, setSwapping] = useState(false)
  const pages = (versions?.length ?? versionCount) + 1
  // The last page is the live answer; anything before it is one of the displaced ones, whose body has to
  // have arrived — and it has, because the list is fetched on the first arrow press.
  const index = page === null ? pages - 1 : Math.min(page, pages - 1)
  const viewing = index === pages - 1 ? null : versions?.[index] ?? null
  const body = viewing ? viewing.content : text
  // Looking at an earlier answer means looking at the thinking that answer was written by; falling back to
  // the live trace would show the reader the wrong model's reasoning.
  const shownReasoning = viewing ? viewing.reasoning : reasoning
  const step = (delta: 1 | -1) => {
    const advance = (list: AssistantAnswerVersion[]) => {
      const total = list.length + 1
      setPage((current) => Math.min(Math.max((current === null ? total - 1 : current) + delta, 0), total - 1))
    }
    if (versions) {
      advance(versions)
      return
    }
    void loadVersions?.().then((list) => {
      setVersions(list)
      advance(list)
    })
  }
  return (
    <div className="group flex items-start gap-2.5" onContextMenu={body ? menu.onContextMenu : undefined}>
      {selection?.active && messageId && (
        <SelectionTick
          label={t('assistant.chat.select_messages')}
          checked={selection.checked}
          onToggle={selection.onToggle}
        />
      )}
      <div className="min-w-0 flex-1 space-y-2">
        {tools.length > 0 && <ToolCallList tools={tools} messageId={messageId} />}
        {tools.map((tool) => tool.approval && <ApprovalCard key={tool.approval.id} action={tool.approval} />)}
        {shownReasoning && (
          <div className="min-w-0">
            {/* The trace is named by what it is rather than by what pressing does: the header is the one
                line of a turn that says the model thought before answering, and a reader skimming a long
                thread reads it instead of the reasoning itself. */}
            <button
              type="button"
              onClick={() => setShowReasoning((open) => !open)}
              aria-expanded={showReasoning}
              className="inline-flex items-center gap-1.5 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:text-[var(--text-secondary)]"
            >
              <Sparkles size={11} className="shrink-0 text-[var(--text-quaternary)]" />
              {streaming ? t('assistant.chat.thinking') : t('assistant.chat.thought')}
              <ChevronDown size={11} className={cn('shrink-0 transition-transform duration-[var(--dur-fast)]', showReasoning && 'rotate-180')} />
            </button>
            {showReasoning && (
              <div className="mt-1 border-l border-[var(--border-subtle)] pl-2.5">
                <p className="whitespace-pre-wrap text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
                  {shownReasoning}
                </p>
              </div>
            )}
          </div>
        )}
        {body
          ? <div className="max-w-[72ch]"><MarkdownReply source={body} /></div>
          : streaming && tools.every((tool) => tool.status !== 'running')
            ? (
                <div role="status" aria-label={t('assistant.chat.thinking')} className="flex h-6 items-center gap-1.5">
                  <span className="flex items-center gap-1">
                    <i className="size-1 animate-pulse rounded-full bg-[var(--text-quaternary)]" />
                    <i className="size-1 animate-pulse rounded-full bg-[var(--text-quaternary)] [animation-delay:150ms]" />
                    <i className="size-1 animate-pulse rounded-full bg-[var(--text-quaternary)] [animation-delay:300ms]" />
                  </span>
                  {stage && <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t(STAGE_KEYS[stage])}</span>}
                </div>
              )
            : null}
        {/* The files this answer made — a picture it drew — shown with it, the same way the reader's own
            attachments are shown on their message. The body above may say anything about them; the
            picture itself is what the reader came for. */}
        {attachments.length > 0 && <MessageAttachments ids={attachments} index={fileIndex} />}
        {cancelled && <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.chat.stopped')}</p>}
        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--danger)_30%,transparent)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-12)] text-[var(--danger)]">
            <AlertTriangle size={13} className="shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            {onRetry && (
              <button type="button" onClick={onRetry} className="shrink-0 font-medium underline underline-offset-2">
                {t(retryLabel)}
              </button>
            )}
          </div>
        )}
        {/* Sources are the answer's own, so they are only shown beside it: an earlier answer paged back
            to was built on pages this turn never saw, and listing them would credit it with a search it
            did not do. */}
        {!streaming && !viewing && sources.length > 0 && (
          <ul
            aria-label={t('assistant.chat.sources')}
            className="flex max-w-[72ch] flex-wrap gap-1 pt-0.5"
          >
            {sources.map((source, index) => (
              <li key={source.id ?? source.url}>
                {source.kind === 'note' && source.id
                  ? <NoteCitation index={index} source={source} noteId={source.id} />
                  : (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={source.cited ?? source.url}
                        className="inline-flex max-w-[280px] items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)] transition-colors duration-[var(--dur-fast)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                      >
                        <span className="shrink-0 tabular text-[var(--text-quaternary)]">{index + 1}</span>
                        <span className="min-w-0 truncate">{source.title}</span>
                        <ExternalLink size={10} className="shrink-0 opacity-70" />
                      </a>
                    )}
              </li>
            ))}
          </ul>
        )}
        {!streaming && (body || pages > 1) && (
          <div className={cn(
            'flex flex-wrap items-center gap-x-2 gap-y-1 transition-opacity duration-[var(--dur-fast)]',
            // Quiet until the pointer arrives — but only where a pointer exists. A touch screen has no
            // hover, and a reader looking at an older answer must be able to see how to leave it.
            !viewing && 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100',
          )}>
            {body && (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(body).then(() => {
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), COPY_RESET_MS)
                  })
                }}
                aria-label={t('assistant.chat.copy')}
                className="inline-flex items-center gap-1 rounded-[var(--r-sm)] px-1 py-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
              >
                {copied ? <Check size={11} /> : <Copy size={11} />}
                {copied ? t('assistant.chat.copied') : t('assistant.chat.copy')}
              </button>
            )}
            {/* A finished answer can be asked again from the same footer; the error card above carries
                its own retry, so the two never appear on one message. */}
            {!error && body && onRetry && !viewing && (
              <button
                type="button"
                onClick={onRetry}
                aria-label={t(retryLabel)}
                className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-sm)] px-1 py-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
              >
                <RotateCcw size={11} />
                {t(retryLabel)}
              </button>
            )}
            {/* Only a settled answer is offered: a half-written reply saved twice is two notes, and the
                one worth keeping is the one the model finished. */}
            {!error && body && !streaming && !viewing && (
              <button
                type="button"
                onClick={() => saveReplyAsNote(body)}
                aria-label={t('assistant.chat.save_to_note')}
                className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-sm)] px-1 py-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
              >
                <NotebookPen size={11} />
                {t('assistant.chat.save_to_note')}
              </button>
            )}
            {onRate && (
              <>
                <button
                  type="button"
                  onClick={() => onRate('up')}
                  aria-pressed={feedback === 'up'}
                  aria-label={t('assistant.chat.rate_up')}
                  title={t('assistant.chat.rate_up')}
                  className={cn(
                    'inline-flex shrink-0 items-center rounded-[var(--r-sm)] px-1 py-0.5 text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
                    feedback === 'up' && 'text-[var(--accent)]',
                  )}
                >
                  <ThumbsUp size={11} />
                </button>
                <button
                  type="button"
                  onClick={() => onRate('down')}
                  aria-pressed={feedback === 'down'}
                  aria-label={t('assistant.chat.rate_down')}
                  title={t('assistant.chat.rate_down')}
                  className={cn(
                    'inline-flex shrink-0 items-center rounded-[var(--r-sm)] px-1 py-0.5 text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
                    feedback === 'down' && 'text-[var(--danger)]',
                  )}
                >
                  <ThumbsDown size={11} />
                </button>
              </>
            )}
            {body && (
              <span ref={menu.buttonRef}>
                <button
                  type="button"
                  onClick={menu.openFromButton}
                  aria-label={t('assistant.chat.message_actions')}
                  className="inline-flex items-center rounded-[var(--r-sm)] px-1 py-0.5 text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
                >
                  <MoreHorizontal size={11} />
                </button>
              </span>
            )}
            {pages > 1 && (
              <AnswerVersionPager
                total={pages}
                page={index}
                busy={swapping}
                onStep={step}
                onRestore={() => {
                  if (!viewing || !onActivate) return
                  setSwapping(true)
                  void Promise.resolve(onActivate(viewing.id)).finally(() => {
                    setSwapping(false)
                    // The turn's history changed shape: the answer just filed is no longer one of the pages.
                    setVersions(null)
                    setPage(null)
                  })
                }}
              />
            )}
            {viewing ? (
              <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('assistant.chat.viewing_history')}
                {viewing.modelLabel && ` · ${viewing.modelLabel}`}
                {` · ${new Date(viewing.createdAt).toLocaleString()}`}
              </span>
            ) : (
              usage && answerStats(usage, durationMs) && (
                <span
                  className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]"
                  title={t('assistant.chat.usage', { input: usage.inputTokens, output: usage.outputTokens })}
                >
                  {answerStats(usage, durationMs)}
                  {modelLabel && ` · ${modelLabel}`}
                </span>
              )
            )}
          </div>
        )}
      </div>
      {/* `body` is what the reader can see — an earlier answer paged back to included — so the menu
          acts on that text rather than on whichever version happens to be newest. */}
      <MessageMenu
        menu={menu}
        target={{
          role: 'assistant',
          text: body,
          ...(onRetry && !viewing ? { onRetry, onRetryLabel: retryLabel } : {}),
          ...(feedback ? { feedback } : {}),
          ...(onRate && !streaming && !viewing ? { onRate } : {}),
          ...(messageId && !streaming ? { onFork: () => void useAssistant.getState().forkFrom(messageId) } : {}),
          ...(messageId && !streaming ? { onOpenCanvas: () => void useAssistant.getState().createArtifactFromReply(body) } : {}),
          // The thread is the record and the note is the copy: the menu can keep the whole thing, or
          // write this one answer into the note already open beside it.
          ...(messageId && !streaming ? { onSaveConversation: () => void saveConversationAsNote() } : {}),
          // Only while a note is open: the rows write into that note, and one that cannot is a row the
          // reader has to try to find out about.
          ...(messageId && !streaming && useUi.getState().activeNoteId ? { onInsertIntoNote: () => insertReplyIntoNote(body) } : {}),
          ...(messageId && !streaming && useUi.getState().activeNoteId ? { onEmbedInNote: () => embedConversationInNote() } : {}),
          ...(messageId && onStartPicking ? { onSelect: () => onStartPicking(messageId) } : {}),
          ...(messageId && onShare && !streaming ? { onShare: () => onShare(messageId) } : {}),
        }}
      />
    </div>
  )
}

/**
 * One note the answer was built from.
 *
 * A card rather than a link: the target is a note in this vault, so a new tab would be a second copy of
 * the notebook — and the note is already loaded, so the press is a switch of screens rather than a fetch.
 * The excerpt the search matched stays in the tooltip, which is what lets a reader check the citation
 * without leaving the answer they are reading.
 */
function NoteCitation({ index, source, noteId }: { index: number, source: AssistantSource, noteId: string }) {
  return (
    <button
      type="button"
      title={source.cited ?? source.title}
      onClick={() => {
        navigateToPath('/notes')
        void useNotes.getState().openNote(noteId)
      }}
      className="inline-flex max-w-[280px] items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)] transition-colors duration-[var(--dur-fast)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
    >
      <span className="shrink-0 tabular text-[var(--text-quaternary)]">{index + 1}</span>
      <FileText size={10} className="shrink-0 opacity-70" />
      <span className="min-w-0 truncate">{source.title}</span>
    </button>
  )
}
