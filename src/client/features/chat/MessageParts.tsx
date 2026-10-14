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
  Loader2,
  RotateCcw,
  ShieldAlert,
  XCircle
} from 'lucide-react'
import type { AssistantAnswerVersion, ToolActivity } from '@shared/assistant'
import { ASSISTANT_TOOL_BY_NAME } from '@shared/assistant'
import { cn } from '../../lib/cn'
import { COPY_RESET_MS } from '../../lib/motion'
import { t } from '../../lib/i18n'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { useLocale } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { useAssistant } from './assistant-store'

const STAGE_KEYS = {
  waiting: 'assistant.chat.stage_waiting',
  reading: 'assistant.chat.stage_reading',
  searching: 'assistant.chat.stage_searching',
  generating: 'assistant.chat.stage_generating',
} as const

export function MarkdownReply({ source }: { source: string }) {
  const locale = useLocale()
  // The object identity is what matters: a fresh literal on every render makes React rewrite
  // innerHTML each time anything else in the thread changes, which repaints the answer mid-stream.
  const html = useMemo(() => ({ __html: renderMarkdown(source).html }), [source, locale])
  return <div className="ink-prose ink-chat-prose min-w-0" dangerouslySetInnerHTML={html} />
}

export function ToolChip({ tool }: { tool: ToolActivity }) {
  const spec = ASSISTANT_TOOL_BY_NAME.get(tool.name)
  const label = spec ? t(spec.labelKey) : tool.name
  return (
    <span
      data-tool-chip={tool.name}
      title={tool.error ?? undefined}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-[2px] text-[11px]',
        tool.status === 'error'
          ? 'border-[color-mix(in_oklab,var(--danger)_35%,transparent)] bg-[var(--danger-soft)] text-[var(--danger)]'
          : 'border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-tertiary)]',
      )}
    >
      {tool.status === 'running'
        ? <Loader2 size={11} className="shrink-0 animate-spin" />
        : tool.status === 'error'
          ? <XCircle size={11} className="shrink-0" />
          : <Check size={11} className="shrink-0 text-[var(--success)]" />}
      <span className="min-w-0 truncate">
        {label}
        {tool.detail ? <span className="text-[var(--text-quaternary)]"> · {tool.detail}</span> : null}
      </span>
    </span>
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
  const question = spec?.approvalKey ? t(spec.approvalKey, { title: action.targetLabel }) : action.targetLabel

  if (action.status !== 'pending') {
    return (
      <div
        data-approval-outcome={action.status}
        className="flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-1.5 text-[12px] text-[var(--text-tertiary)]"
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
      <div className="flex items-start gap-2 text-[12.5px]">
        <ShieldAlert size={14} className="mt-0.5 shrink-0 text-[var(--warning)]" />
        <div className="min-w-0">
          <p className="break-words font-medium text-[var(--text-primary)]">{question}</p>
          <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">{t('assistant.approval.hint')}</p>
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
      <span aria-live="polite" className="min-w-[34px] text-center text-[11px] tabular-nums text-[var(--text-quaternary)]">
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
          className="ml-0.5 inline-flex items-center gap-1 rounded-[var(--r-sm)] px-1 py-0.5 text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:opacity-50"
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
  onRetry,
  retryLabel = 'assistant.chat.retry',
  usage,
  durationMs = 0,
  modelLabel = '',
  versionCount = 0,
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
  onRetry?: () => void
  retryLabel?: 'assistant.chat.retry' | 'assistant.chat.regenerate'
  usage?: { inputTokens: number, outputTokens: number } | null
  durationMs?: number
  modelLabel?: string
  /** How many earlier answers this turn still holds. The pager appears at two or more pages. */
  versionCount?: number
  loadVersions?: () => Promise<AssistantAnswerVersion[]>
  onActivate?: (versionId: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const [showReasoning, setShowReasoning] = useState(false)
  const [versions, setVersions] = useState<AssistantAnswerVersion[] | null>(null)
  const [page, setPage] = useState<number | null>(null)
  const [swapping, setSwapping] = useState(false)
  const pages = (versions?.length ?? versionCount) + 1
  // The last page is the live answer; anything before it is one of the displaced ones, whose body has to
  // have arrived — and it has, because the list is fetched on the first arrow press.
  const index = page === null ? pages - 1 : Math.min(page, pages - 1)
  const viewing = index === pages - 1 ? null : versions?.[index] ?? null
  const body = viewing ? viewing.content : text
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
    <div className="group flex gap-2.5">
      <div className="min-w-0 flex-1 space-y-2">
        {tools.length > 0 && (
          <div role="group" aria-label={t('assistant.chat.tools_taken')} className="flex flex-wrap gap-1">
            {tools.map((tool) => <ToolChip key={tool.id} tool={tool} />)}
          </div>
        )}
        {tools.map((tool) => tool.approval && <ApprovalCard key={tool.approval.id} action={tool.approval} />)}
        {reasoning && (
          <button
            type="button"
            onClick={() => setShowReasoning((open) => !open)}
            aria-expanded={showReasoning}
            className="inline-flex items-center gap-1 text-[11px] text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]"
          >
            <ChevronDown size={11} className={cn('transition-transform duration-[var(--dur-fast)]', showReasoning && 'rotate-180')} />
            {t('assistant.chat.reasoning')}
          </button>
        )}
        {reasoning && showReasoning && (
          <p className="whitespace-pre-wrap rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
            {reasoning}
          </p>
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
                  {stage && <span className="text-[11px] text-[var(--text-quaternary)]">{t(STAGE_KEYS[stage])}</span>}
                </div>
              )
            : null}
        {cancelled && <p className="text-[11px] text-[var(--text-quaternary)]">{t('assistant.chat.stopped')}</p>}
        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--danger)_30%,transparent)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[12px] text-[var(--danger)]">
            <AlertTriangle size={13} className="shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            {onRetry && (
              <button type="button" onClick={onRetry} className="shrink-0 font-medium underline underline-offset-2">
                {t(retryLabel)}
              </button>
            )}
          </div>
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
                className="inline-flex items-center gap-1 rounded-[var(--r-sm)] px-1 py-0.5 text-[11px] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
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
                className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-sm)] px-1 py-0.5 text-[11px] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
              >
                <RotateCcw size={11} />
                {t(retryLabel)}
              </button>
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
              <span className="text-[11px] text-[var(--text-quaternary)]">
                {t('assistant.chat.viewing_history')}
                {viewing.modelLabel && ` · ${viewing.modelLabel}`}
                {` · ${new Date(viewing.createdAt).toLocaleString()}`}
              </span>
            ) : (
              usage && answerStats(usage, durationMs) && (
                <span
                  className="shrink-0 text-[11px] text-[var(--text-quaternary)]"
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
    </div>
  )
}
