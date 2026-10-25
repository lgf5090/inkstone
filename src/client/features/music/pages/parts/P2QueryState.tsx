/**
 * The small shared pieces of the library pages: an inline failure band, the date and count
 * formatting they all need, and the anchor behaviour every card repeats.
 *
 * This file is private to the pages in this group. The music frame, the song list and the player
 * already own the reusable surfaces; what is left is the four lines of arithmetic that would
 * otherwise be copied into eight documents.
 */
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { Button } from '../../../../components/primitives'
import { LoadingBlock } from '../../../../components/feedback'
import { ApiError } from '../../../../lib/api'
import { navigateToAddress } from '../../../../lib/app-history'
import { getLocale } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { formatPlayCount } from '@shared/music/format'
import { musicText } from '../../components/labels'

/** The page's own paragraph rhythm. The frame already pads the content column. */
export const PAGE_STACK = 'flex flex-col gap-[var(--sp-5)]'

export function describeError(error: unknown): string {
  // The localized sentence names the kind of failure; the route's own reason is the part that
  // distinguishes a gateway hiccup from a provider refusal, so a detail line keeps both.
  if (error instanceof ApiError && error.serverMessage && error.serverMessage !== error.message) {
    return `${error.message} (${error.serverMessage})`
  }
  return error instanceof Error ? error.message : String(error)
}

/** A gateway answer right after the phone confirms can clear on its own; a 4xx will not. */
export function shouldRetryQrPoll(error: unknown, transientFailures: number): boolean {
  return transientFailures < 3
    && error instanceof ApiError
    && (error.status === 502 || error.status === 503 || error.status === 504)
}

export function toastFailure(title: string, error: unknown): void {
  useUi.getState().toast({
    title,
    description: describeError(error),
    tone: 'danger',
  })
}

export function PageLoading({ label }: { label?: string }): ReactElement {
  return <LoadingBlock label={label ?? musicText('common.loading')} />
}

/**
 * An error for one data region. The detail is the route's or the browser's own sentence and is
 * printed as text; the retry button is the action every loader can honour.
 */
export function QueryError({
  title,
  detail,
  onRetry,
}: {
  title: string
  detail?: string | null
  onRetry: () => void
}): ReactElement {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-[var(--sp-2)] rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-[var(--sp-3)]"
    >
      <p className="text-[length:var(--text-13)] font-medium text-[var(--danger)]">{title}</p>
      {detail && (
        <p className="max-w-full break-words text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {detail}
        </p>
      )}
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {musicText('common.retry')}
      </Button>
    </div>
  )
}

export function formatDate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(new Date(value))
}

export function formatDateTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function formatCount(value: number | null | undefined): string {
  return formatPlayCount(value, getLocale())
}

/**
 * A card is a link, not a button: the address is the screen it names, so a middle click or a
 * context menu keeps working. A modifier press is left to the browser for the same reason.
 */
export function onMusicLink(event: ReactMouseEvent<HTMLAnchorElement>, href: string): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  navigateToAddress(href)
}
