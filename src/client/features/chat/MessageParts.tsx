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
  Copy,
  Loader2,
  RotateCcw,
  ShieldAlert,
  XCircle
} from 'lucide-react'
import type { ToolActivity } from '@shared/assistant'
import { ASSISTANT_TOOL_BY_NAME } from '@shared/assistant'
import { cn } from '../../lib/cn'
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
}) {
  const [copied, setCopied] = useState(false)
  const [showReasoning, setShowReasoning] = useState(false)
  return (
    <div className="flex gap-2.5">
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
        {text
          ? <MarkdownReply source={text} />
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
        {!streaming && text && (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              })
            }}
            aria-label={t('assistant.chat.copy')}
            className="inline-flex items-center gap-1 rounded-[var(--r-sm)] px-1 py-0.5 text-[11px] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? t('assistant.chat.copied') : t('assistant.chat.copy')}
          </button>
        )}
        {/* A finished answer can be asked again from the same footer; the error card above carries its
            own retry, so the two never appear on one message. */}
        {!streaming && !error && text && onRetry && (
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
        {!streaming && usage && (
          <span className="shrink-0 text-[11px] text-[var(--text-quaternary)]" title={t('assistant.chat.usage_hint')}>
            {t('assistant.chat.usage', { input: usage.inputTokens, output: usage.outputTokens })}
          </span>
        )}
      </div>
    </div>
  )
}
