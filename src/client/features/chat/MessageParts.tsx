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
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
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
  Volume2,
  VolumeX,
  Wrench,
  XCircle
} from 'lucide-react'
import type { AssistantAnswerVersion, AssistantSource, MessageFeedback, ToolActivity } from '@shared/assistant'
import { ASSISTANT_TOOL_BY_NAME, mcpToolOrigin } from '@shared/assistant'
import { toPlainText } from '@shared/markdown-utils'
import { cn } from '../../lib/cn'
import { COPY_RESET_MS } from '../../lib/motion'
import { getLocale, t, type MessageKey } from '../../lib/i18n'
import { formatInZone } from './time-format'
import { full as fullTokenCount } from './usage-format'
import { copyText } from '../../lib/clipboard'
import { useLocale } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { MarkdownBody } from '../preview/MarkdownBody'
import { useAssistant } from './assistant-store'
import { canSpeak, stopSpeaking } from './speech'
import { useUi } from '../../store/ui'
import { MessageAttachments } from './ChatAttachments'
import { CHAT_NOTE_LINKS, openCitedNote } from './note-links'
import { MessageMenu, useMessageMenu } from './MessageMenu'
import { SelectionTick, type MessageSelection } from './SelectionBar'
import { noteMentionLinks, noteRefsFromToolResult } from './note-refs'
import { LoadFailure } from './assistant-settings-shared'
import { AnswerSelectionBar } from './answer-selection'
import { FeedbackReasonPanel } from './feedback-reason'
import { embedConversationInNote, insertReplyIntoNote, saveConversationAsNote, saveReplyAsNote } from './save-to-note'

/**
 * The link handlers every reply and question in the container is drawn with.
 *
 * One object, built once at module scope, because a fresh literal per message would be a new identity on
 * every render of the row. It is `CHAT_NOTE_LINKS` with one addition: a mention the composer wrote as
 * `[[<id>|Title]]` is followed by its id, not by a request to make a note named after it.
 */
export const CHAT_MENTION_LINKS = noteMentionLinks(CHAT_NOTE_LINKS)

const STAGE_KEYS = {
  waiting: 'assistant.chat.stage_waiting',
  reading: 'assistant.chat.stage_reading',
  searching: 'assistant.chat.stage_searching',
  generating: 'assistant.chat.stage_generating',
} as const

export function MarkdownReply({ source }: { source: string }) {
  // The reply is read by the same renderer a note's preview is, so a formula is drawn, a diagram is
  // drawn, and a `[[note]]` is a door into the notebook rather than a word that looks like a link.
  return <MarkdownBody source={source} className="ink-chat-prose min-w-0" links={CHAT_MENTION_LINKS} />
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

const TOOL_STATUS_KEYS: Partial<Record<string, MessageKey>> = {
  running: 'assistant.chat.tool_running',
  success: 'assistant.chat.tool_done',
  error: 'assistant.chat.tool_failed',
}

/**
 * What a call whose status this app does not recognise says.
 *
 * Borrowing "Completed" was the old reading, and it lied: a stored row can carry a status the client has
 * never seen — a call the worker skipped, a row written by an older build — and a chip that calls that a
 * success is the one answer a reader cannot check any other way.
 */
const TOOL_STATUS_UNKNOWN_KEY: MessageKey = 'assistant.chat.tool_unknown'

function toolStatusKey(status: string): MessageKey {
  return TOOL_STATUS_KEYS[status] ?? TOOL_STATUS_UNKNOWN_KEY
}

/** Whether the row has a status this app can account for, which is what the neutral mark is drawn for. */
function isKnownToolStatus(status: string): boolean {
  return status === 'running' || status === 'success' || status === 'error'
}

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
  // Why a run was not started at all — nothing to run it in, or a request that never answered. Said here
  // rather than as a toast, because the reason belongs to the row the reader is looking at.
  const [refused, setRefused] = useState<string | null>(null)
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
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-[var(--bg-hover)]"
      >
        {tool.status === 'running'
          ? <Loader2 size={12} className="ink-chat-spin shrink-0 text-[var(--text-quaternary)]" />
          : tool.status === 'error'
            ? <XCircle size={12} className="shrink-0 text-[var(--danger)]" />
            : isKnownToolStatus(tool.status)
              ? <Check size={12} className="shrink-0 text-[var(--success)]" />
              : <AlertTriangle size={12} className="shrink-0 text-[var(--warning)]" />}
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
          {label}
          {tool.detail ? <span className="text-[var(--text-quaternary)]"> · {tool.detail}</span> : null}
        </span>
        <span
          className={cn(
            'shrink-0 text-[length:var(--text-10-5)]',
            tool.status === 'error' ? 'text-[var(--danger)]'
              : isKnownToolStatus(tool.status) ? 'text-[var(--text-quaternary)]'
                : 'text-[var(--warning)]',
          )}
        >
          {t(toolStatusKey(tool.status))}
        </span>
        <ChevronDown size={11} className={cn('shrink-0 text-[var(--text-quaternary)] transition-transform duration-[var(--dur-fast)]', open && 'rotate-180')} />
      </button>
      {/* Why a call failed, written on the row instead of parked in a `title`: a tooltip is only ever read
          with a hovering pointer, so the one fact a reader needs about a failed call was invisible to a
          keyboard and to a thumb. It stays out of the fold, because closing the fold does not take the
          failure back. */}
      {tool.error && (
        <p
          data-tool-error={tool.name}
          className="min-w-0 break-words border-t border-[var(--border-subtle)] px-2 py-1.5 text-[length:var(--text-11)] text-[var(--danger)]"
        >
          {tool.error}
        </p>
      )}
      {open && (
        <div className="flex max-w-full min-w-0 flex-col gap-1.5 border-t border-[var(--border-subtle)] px-2 py-1.5">
          {body.length === 0 && (
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
                  void copyText(tool.result ?? '').then((ok) => {
                    if (!ok) {
                      useUi.getState().toast({ title: t('preview.could_not_copy'), tone: 'danger' })
                      return
                    }
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
                  // Read on the press, not at render: the id belongs to this action, and a turn with no
                  // conversation to run in is refused here rather than sent as an empty one, which the
                  // route would answer with an error about a conversation the reader never had.
                  const conversationId = useAssistant.getState().activeId
                  if (!conversationId) {
                    setRefused(t('assistant.toast.failed'))
                    return
                  }
                  setBusy(true)
                  setRefused(null)
                  void replay(conversationId, messageId, tool.id)
                    .then(setAgain)
                    // The store's own replay answers a refusal with a reason instead of throwing, so this
                    // is only the half it cannot report: a promise that never settled into an answer.
                    .catch((error: unknown) => setRefused(error instanceof Error ? error.message : String(error)))
                    .finally(() => setBusy(false))
                }}
                className="inline-flex items-center gap-1 rounded-[var(--r-sm)] px-1 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--accent-on-soft)] hover:bg-[var(--accent-soft)] disabled:opacity-50"
              >
                {busy ? <Loader2 size={11} className="ink-chat-spin" /> : <Play size={11} />}
                {busy ? t('assistant.chat.replaying') : t('assistant.chat.replay')}
              </button>
            )}
          </div>
          {refused && (
            <p role="alert" className="min-w-0 break-words text-[length:var(--text-11)] text-[var(--danger)]">{refused}</p>
          )}
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
  // A press that never landed. The store's own `decideAction` reports a refusal it can see — it toasts and
  // leaves the card pending — so this is not a second notice of the same fact: it is the half a toast
  // cannot leave behind, the words saying this card is still waiting because the request failed.
  const [failed, setFailed] = useState<string | null>(null)
  if (!action) return null
  const settle = (approve: boolean) => {
    setBusy(approve ? 'approve' : 'cancel')
    setFailed(null)
    void decide(action.id, approve)
      .catch((error: unknown) => setFailed(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(null))
  }
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
      {failed && (
        <p role="alert" className="mt-1.5 break-words text-[length:var(--text-11)] text-[var(--danger)]">{failed}</p>
      )}
      <div className="mt-2 flex justify-end gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => settle(false)}
        >
          {t('assistant.approval.decline')}
        </Button>
        <Button
          size="sm"
          variant="danger"
          loading={busy === 'approve'}
          disabled={busy !== null}
          onClick={() => settle(true)}
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
        className="ink-tap-pad relative inline-flex size-5 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] disabled:pointer-events-none disabled:opacity-40"
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
        className="ink-tap-pad relative inline-flex size-5 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] disabled:pointer-events-none disabled:opacity-40"
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
  if (!usage.outputTokens || seconds <= 0) return `${fullTokenCount(total)} ${t('assistant.chat.tokens')}`
  return `${fullTokenCount(total)} ${t('assistant.chat.tokens')} · ${(usage.outputTokens / seconds).toFixed(1)} ${t('assistant.chat.tokens_per_second')}`
}

/**
 * What wrote the answer, and what it cost.
 *
 * The model's name is the one fact about an answer that is always known, so it is drawn on its own: a
 * provider that reports no tokens makes `answerStats` answer nothing, and a line built out of the stats
 * alone took the name down with them, leaving the reader unable to say which model answered.
 */
function AnswerFootline({ usage, durationMs, modelLabel }: {
  usage?: { inputTokens: number, outputTokens: number } | null
  durationMs: number
  modelLabel: string
}) {
  const stats = answerStats(usage, durationMs)
  if (!stats && !modelLabel) return null
  return (
    <span
      className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]"
      {...(stats && usage ? { title: t('assistant.chat.usage', { input: usage.inputTokens, output: usage.outputTokens }) } : {})}
    >
      {stats}
      {modelLabel && (stats ? ` · ${modelLabel}` : modelLabel)}
    </span>
  )
}

/**
 * The most the engine is handed in one piece.
 *
 * A browser's speech synthesiser drops what it cannot say in one breath — every engine is comfortable well
 * under a screen of text — so a long answer is read in pieces and the row stays lit until the last one has
 * finished. It is a ceiling rather than a target: a piece ends on a clause mark or a space wherever one
 * falls inside it, so the cut costs no word, and only a run with neither is cut mid-sentence.
 */
const SPEAK_PIECE_CHARS = 220

/**
 * Where a piece may end.
 *
 * A clause mark comes first because a Chinese answer has no spaces to cut on, and `[\u3001\u3002...]` is
 * how its own punctuation is named without the interface copy the locale catalog owns.
 */
const SPEAK_CLAUSE_END = /[\u3001\u3002\uff01\u3002\uff0c\uff1a\uff1b\uff1f][ \t]*|[.!?:;][ \t]+|[ \t]+/g

function lastBoundary(window: string): number {
  let cut = -1
  for (const match of window.matchAll(SPEAK_CLAUSE_END)) {
    const index = match.index + match[0].length
    if (index > cut) cut = index
  }
  return cut
}

/**
 * The answer as the voice gets it: markup taken out, then cut into pieces the engine will keep.
 *
 * Exported because the cut is the part a reader cannot see working — the words either all arrive or some
 * of them never do.
 */
export function splitForSpeech(text: string): string[] {
  // A screen reader spelling out `##` and `**` is worse than not offering the button, so the markup goes
  // before anything is measured: the pieces are what the answer says, not how it is written.
  let rest = toPlainText(text)
  if (!rest) return []
  const pieces: string[] = []
  while (rest.length > SPEAK_PIECE_CHARS) {
    const cut = lastBoundary(rest.slice(0, SPEAK_PIECE_CHARS))
    // No boundary at all in a whole piece is a run of characters with no space and no clause mark in it.
    // Cutting it anyway is what keeps the rest of the answer readable instead of silently dropped.
    const edge = cut > 0 ? cut : SPEAK_PIECE_CHARS
    pieces.push(rest.slice(0, edge))
    rest = rest.slice(edge)
  }
  if (rest) pieces.push(rest)
  return pieces
}

/**
 * Which row, if any, is holding the one voice the browser has.
 *
 * `speechSynthesis` is a single channel for the whole document, and a row that does not know somebody else
 * took it goes on saying "reading" while another answer's voice is what comes out. One module token is the
 * smallest thing that can answer that: nothing is broadcast and nothing is subscribed to — a row only asks
 * whether the token is still its own before it believes an engine callback.
 */
let speakingToken: symbol | null = null

/**
 * The row's own half of that channel: forget the queue and the light, and hand the token back only if this
 * row is the one still holding it.
 */
function releaseToken(token: React.RefObject<symbol | null>, queue: React.RefObject<string[]>): void {
  if (token.current !== null && speakingToken === token.current) speakingToken = null
  token.current = null
  queue.current = []
}

/**
 * Reading one answer aloud, as a switch rather than a fire-and-forget menu row.
 *
 * Three things make this a control instead of a trick: the state is spoken (`aria-pressed`, and a name that
 * changes), the voice is put back down wherever the answer stops being on screen — this row unmounting, the
 * conversation switching, another answer taking the channel — and a browser with no speech synthesis says so
 * in the node its disabled control points at, rather than offering an icon that does nothing.
 *
 * An answer with nothing readable in it draws nothing: there is no capability being withheld, only no words
 * to hear, and a press that could only apologise for itself is not an affordance.
 */
export function ReadAloudButton({ text }: { text: string }) {
  const [reading, setReading] = useState(false)
  // A voice that died while it still held the channel is a different fact from one that was never asked
  // for, and it is the reader's, so it is said on this row rather than in a toast elsewhere.
  const [failed, setFailed] = useState<string | null>(null)
  const hintId = useId()
  const conversationId = useAssistant((state) => state.activeId)
  const token = useRef<symbol | null>(null)
  const queue = useRef<string[]>([])
  const pieces = useMemo(() => splitForSpeech(text), [text])
  const available = canSpeak()

  const stop = useCallback(() => {
    // Only what this row still owns is its to stop: cancelling the channel would cut off whichever answer
    // took it over.
    const owned = token.current !== null && speakingToken === token.current
    releaseToken(token, queue)
    setReading(false)
    if (owned) stopSpeaking()
  }, [])

  const readNext = useCallback(() => {
    const mine = token.current
    if (mine === null) return
    const piece = queue.current.shift()
    if (piece === undefined) {
      // The whole answer has been handed over and finished: the light comes down with the queue.
      releaseToken(token, queue)
      setReading(false)
      return
    }
    const utterance = new window.SpeechSynthesisUtterance(piece)
    // Decided at the press rather than at render: the interface language is a setting a reader moves
    // between answers, and a Chinese answer handed to an English voice is the mistake this avoids.
    utterance.lang = getLocale()
    utterance.onend = () => {
      // Somebody else owns the channel now, so this row has one job left: stop claiming it is reading.
      if (token.current !== mine || speakingToken !== mine) {
        releaseToken(token, queue)
        setReading(false)
        return
      }
      readNext()
    }
    utterance.onerror = (event) => {
      if (token.current !== mine) return
      const owned = speakingToken === mine
      releaseToken(token, queue)
      setReading(false)
      // `canceled` and `interrupted` are the engine obeying a stop — this row's own press, another answer
      // taking the voice, a thread switched. Only a voice that died while it still held the channel is
      // worth a sentence.
      if (owned && event.error !== 'canceled' && event.error !== 'interrupted') setFailed(t('assistant.chat.read_failed'))
    }
    window.speechSynthesis.speak(utterance)
  }, [])

  const start = () => {
    if (!available || !pieces.length) return
    // The channel is one, so taking it means putting down whatever was being read on it — before this row
    // claims it, so whoever loses it hears a stop rather than a half sentence.
    stopSpeaking()
    const mine = Symbol('read-aloud')
    token.current = mine
    speakingToken = mine
    queue.current = [...pieces]
    setFailed(null)
    setReading(true)
    readNext()
  }

  // Unmount is the thread scrolling away, the panel closing, the answer being regenerated: none of them
  // leaves a reader who can still hear this row.
  useEffect(() => () => {
    const owned = token.current !== null && speakingToken === token.current
    releaseToken(token, queue)
    if (owned) stopSpeaking()
  }, [])

  // A voice reading an answer that is no longer on screen is the ghost this exists to kill: the reader hears
  // a reply they cannot find, because the row that started it is on the other side of the switch.
  const lastConversation = useRef(conversationId)
  useEffect(() => {
    if (lastConversation.current === conversationId) return
    lastConversation.current = conversationId
    stop()
  })

  if (!pieces.length) return null

  return (
    <>
      <button
        type="button"
        disabled={!available}
        {...(available ? { 'aria-pressed': reading } : {})}
        aria-label={reading ? t('assistant.chat.read_stop') : t('assistant.chat.read_aloud')}
        {...(!available ? { 'aria-describedby': hintId } : {})}
        onClick={() => (reading ? stop() : start())}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-[var(--r-sm)] px-1 py-0.5 text-[length:var(--text-11)]',
          'text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
          !available && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-[var(--text-quaternary)]',
        )}
      >
        {reading ? <VolumeX size={11} aria-hidden /> : <Volume2 size={11} aria-hidden />}
        {reading ? t('assistant.chat.read_stop') : t('assistant.chat.read_aloud')}
      </button>
      {!available && <span id={hintId} className="sr-only">{t('assistant.chat.read_unavailable')}</span>}
      {failed && (
        // `basis-full` asks for the whole width instead of splitting the chips around it: the row is icons
        // and one-word labels, and a reason has to be read as a line of its own.
        <p role="alert" className="basis-full min-w-0 break-words text-[length:var(--text-11)] text-[var(--danger)]">
          {failed}
        </p>
      )}
    </>
  )
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
  canContinue,
  createdAt,
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
  /**
   * Whether this answer can be picked up where it stopped.
   *
   * Only the newest answer, and only once it has settled: continuing a turn in the middle of a thread
   * would append words to an answer the reader has already read past.
   */
  canContinue?: boolean
  /** When the answer was written; absent on a live turn, which has no row yet. */
  createdAt?: number
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
  // The prose is the only part of the bubble a reader reads *at*, so it is the only part a highlighted
  // selection is acted on inside: the action row, the sources and the citations are outside it, and a
  // selection that reaches past this container reaches into another message — which the bar declines.
  const answerBodyRef = useRef<HTMLDivElement>(null)
  const rateDownRef = useRef<HTMLButtonElement>(null)
  // Three states rather than a boolean: a card that unmounts when dismissed takes the reader's half-typed
  // grounds with it, so once it has been opened it stays mounted and only stops drawing.
  const [reasonPanel, setReasonPanel] = useState<'none' | 'open' | 'dismissed'>('none')
  // The rows behind the ids this answer carries, so a picture it drew can be drawn here rather than
  // named by an id nobody can resolve.
  const fileIndex = useAssistant((state) => state.fileIndex)
  // The assistant's own zone, not the browser's: a thread written in one place and read in another
  // should still say when it was written where the assistant lives.
  const timezone = useAssistant((state) => state.settings?.timezone)
  // Whether the reader has a note open to write into. Subscribed, not read with `getState()` during
  // render: the two rows below appear the moment a note is opened beside the thread, and a snapshot taken
  // on the row's last render would keep them away until something unrelated redrew the row. Only the
  // yes/no is watched, so moving from one open note to another redraws nothing.
  const noteIsOpen = useUi((state) => state.activeNoteId !== null)
  const [page, setPage] = useState<number | null>(null)
  const [swapping, setSwapping] = useState(false)
  // The history is fetched once, on the first step back. The guard is a ref rather than state because two
  // presses inside one tick would both read the `false` of the render they came from and send the same
  // request twice; the flag the arrows are disabled by is the state beside it.
  const fetchingHistory = useRef(false)
  const [awaitingHistory, setAwaitingHistory] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
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
    // One fetch at a time, and a press after a failure asks again: an arrow that remembered it had
    // failed would leave the reader pressing a control that does nothing.
    if (!loadVersions || fetchingHistory.current) return
    fetchingHistory.current = true
    setAwaitingHistory(true)
    setHistoryError(null)
    void loadVersions().then((list) => {
      setVersions(list)
      advance(list)
    }).catch((error: unknown) => {
      // The route's own words, which are the only thing that says what was refused.
      setHistoryError(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      fetchingHistory.current = false
      setAwaitingHistory(false)
    })
  }
  return (
    <div className="group flex items-start gap-2.5" onContextMenu={body ? menu.onContextMenu : undefined} data-chat-anchor={messageId}>
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
          ? (
            // The answer itself is not a live region. A settled one used to carry its own `role="log"`
            // + `aria-live="polite"`, which did two wrong things at once: a long thread became dozens of
            // competing regions, and — because this row is created only when the streaming turn is saved,
            // after the content has already changed — it announced the finished answer never. Completion
            // is announced once, from a single region at the conversation list level (see ChatView).
            <div className="max-w-[72ch]" ref={answerBodyRef} data-answer-body="" tabIndex={-1}>
              <MarkdownReply source={body} />
            </div>
          )
          : streaming && tools.every((tool) => tool.status !== 'running')
            ? (
                <div role="status" aria-label={t('assistant.chat.thinking')} className="flex h-6 items-center gap-1.5">
                  <span className="flex items-center gap-1">
                    <i className="ink-chat-thinking size-1 rounded-full bg-[var(--text-quaternary)]" />
                    <i className="ink-chat-thinking size-1 rounded-full bg-[var(--text-quaternary)]" />
                    <i className="ink-chat-thinking size-1 rounded-full bg-[var(--text-quaternary)]" />
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
        {/* The history the pager could not read, said outside the hover row: a failure the reader has to
            hover into view is a failure they will only find by accident, and retry is the point. */}
        {historyError && !versions && (
          <div className="max-w-[72ch]">
            <LoadFailure messageKey="assistant.memory.history_failed" detail={historyError} onRetry={() => step(-1)} />
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
                  void copyText(body).then((ok) => {
                    if (!ok) {
                      useUi.getState().toast({ title: t('preview.could_not_copy'), tone: 'danger' })
                      return
                    }
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
            {/* Hearing it belongs beside copying it: a reader who wants the answer read out should not have to
                find it in a context menu, and a switch that can be put back down is the part a menu row
                cannot be. */}
            {body && <ReadAloudButton text={body} />}
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
            {/* The way back from a cut-off answer: a stopped or truncated reply is finished here rather
                than asked for again, which would spend the same tokens twice and lose what was written.
                `canContinue` already admits a truncated row — whose notice lives in `error`, not in
                `body` — so this one affordance is deliberately not gated on `!error` the way the
                copy/save actions below are: there is something to carry on from. */}
            {body && !streaming && !viewing && canContinue && (
              <button
                type="button"
                onClick={() => void useAssistant.getState().send('', { continue: true })}
                aria-label={t('assistant.chat.continue')}
                className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-sm)] px-1 py-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
              >
                <Play size={11} />
                {t('assistant.chat.continue')}
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
                  onClick={() => {
                    onRate('up')
                    // An upvote takes the grounds card away — the reader has changed their mind about this
                    // answer — but a card never opened is not mounted to be closed.
                    setReasonPanel((current) => (current === 'none' ? 'none' : 'dismissed'))
                  }}
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
                  ref={rateDownRef}
                  onClick={() => {
                    onRate('down')
                    // The store toggles, so a second press on a down thumb is the reader taking the verdict
                    // back — and the card closes on that press rather than opening again.
                    setReasonPanel(feedback === 'down' ? 'dismissed' : 'open')
                  }}
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
                  // The panel is a disclosure, so the button says so and says whether it is down; without
                  // these a screen reader announces a control that changes nothing it can hear.
                  aria-haspopup="menu"
                  aria-expanded={menu.open}
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
                busy={swapping || awaitingHistory}
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
            {createdAt && !viewing && (
              <time
                dateTime={new Date(createdAt).toISOString()}
                className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]"
              >
                {formatInZone(createdAt, timezone)}
              </time>
            )}
            {viewing ? (
              <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('assistant.chat.viewing_history')}
                {viewing.modelLabel && ` · ${viewing.modelLabel}`}
                {/* The same clock as the live row's: an older answer read in the browser's zone while the
                    thread is set to another would date the version the reader is comparing at. */}
                {` · ${formatInZone(viewing.createdAt, timezone)}`}
              </span>
            ) : (
              <AnswerFootline usage={usage} durationMs={durationMs} modelLabel={modelLabel} />
            )}
          </div>
        )}
        {/* Why the down thumb is down, asked in the row it belongs to rather than in a dialog: the grounds
            are about this answer, and a modal would move the reader off it. */}
        {onRate && messageId && reasonPanel !== 'none' && (
          <FeedbackReasonPanel
            messageId={messageId}
            open={reasonPanel === 'open'}
            triggerRef={rateDownRef}
            onClose={() => setReasonPanel('dismissed')}
          />
        )}
      </div>
      {/* A half of the reply the reader stopped on: the bar over a selection inside the answer's own prose.
          It draws nothing until the selection is there, and it is a portal, so the thread's scroll never
          clips it. */}
      {!streaming && <AnswerSelectionBar root={answerBodyRef} />}
      {/* `body` is what the reader can see — an earlier answer paged back to included — so the menu
          acts on that text rather than on whichever version happens to be newest. */}
      <MessageMenu
        menu={menu}
        target={{
          role: 'assistant',
          text: body,
          ...(onRetry && !viewing ? { onRetry, onRetryLabel: retryLabel } : {}),
          ...(canContinue && !streaming && !viewing ? { onContinue: () => void useAssistant.getState().send('', { continue: true }) } : {}),
          ...(feedback ? { feedback } : {}),
          ...(onRate && !streaming && !viewing ? { onRate } : {}),
          ...(messageId && !streaming ? { onFork: () => void useAssistant.getState().forkFrom(messageId) } : {}),
          ...(messageId && !streaming ? { onOpenCanvas: () => void useAssistant.getState().createArtifactFromReply(body) } : {}),
          // The thread is the record and the note is the copy: the menu can keep the whole thing, or
          // write this one answer into the note already open beside it.
          ...(messageId && !streaming ? { onSaveConversation: () => void saveConversationAsNote() } : {}),
          // Only while a note is open: the rows write into that note, and one that cannot is a row the
          // reader has to try to find out about.
          ...(messageId && !streaming && noteIsOpen ? { onInsertIntoNote: () => insertReplyIntoNote(body) } : {}),
          ...(messageId && !streaming && noteIsOpen ? { onEmbedInNote: () => embedConversationInNote() } : {}),
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
      onClick={() => openCitedNote(noteId)}
      className="inline-flex max-w-[280px] items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)] transition-colors duration-[var(--dur-fast)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
    >
      <span className="shrink-0 tabular text-[var(--text-quaternary)]">{index + 1}</span>
      <FileText size={10} className="shrink-0 opacity-70" />
      <span className="min-w-0 truncate">{source.title}</span>
    </button>
  )
}
