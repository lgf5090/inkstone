/**
 * The calendar-subscription block of the to-do settings page.
 *
 * A subscription is the output half of the to-do app: a third-party calendar polls
 * `/feeds/<slug>.ics` and never logs in, so the only capabilities are the unguessable slug and an
 * optional passcode. This screen is where the owner mints, copies and revokes those capabilities. It
 * keeps no copy of the passcode after the create answer — the server hashes it immediately, and the
 * address shown here is deliberately key-free.
 *
 * The address is rebuilt from `window.location.origin` rather than printed from the route's `url`:
 * behind a reverse proxy the origin the worker saw can differ from the one the reader's calendar can
 * reach, and a copied address that only works inside the deployment is worse than no copy button.
 *
 * Load, failure and empty are three separate states. An empty list says "none yet"; a failed read says
 * so and offers a retry; neither is allowed to look like the other, because a reader who cannot read
 * their feeds must not conclude they never made one.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Check, Copy, Link2, RefreshCw, Trash2 } from 'lucide-react'
import { LIMITS } from '@shared/constants'
import { api, ApiError, type TodoFeedInfo } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { fullTime } from '../../lib/time'
import { COPY_RESET_MS } from '../../lib/motion'
import { Button } from '../../components/primitives'
import { Input, Select } from '../../components/form'
import { confirm } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { t, translateApiError } from '../../lib/i18n'

const DAY_MS = 24 * 60 * 60 * 1000
/** The lifetimes the picker offers. A feed can be revoked at any time; expiry is the backstop. */
const EXPIRY_DAYS = [7, 30, 90, 365] as const

function describeError(cause: unknown): string {
  if (cause instanceof ApiError) return translateApiError(cause.code, cause.message)
  return cause instanceof Error ? cause.message : String(cause)
}

/** The address a calendar subscribes to, in the origin the reader can actually reach. */
function feedUrl(slug: string): string {
  return `${window.location.origin}/feeds/${slug}.ics`
}

export function FeedSettings() {
  const [feeds, setFeeds] = useState<TodoFeedInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [password, setPassword] = useState('')
  const [expiryDays, setExpiryDays] = useState('0')
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const copiedTimer = useRef(0)
  const passwordId = useId()
  const expiryId = useId()
  const passwordHintId = useId()
  const toast = useUi((state) => state.toast)

  async function load(): Promise<void> {
    setLoading(true)
    try {
      const answer = await api.todos.feed.list()
      setFeeds(answer.feeds)
      setLoadError(null)
    } catch (cause) {
      setLoadError(describeError(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    return () => {
      window.clearTimeout(copiedTimer.current)
    }
    // Once per visit: the list is this account's and changes only through the buttons below.
  }, [])

  /** Mints one feed and paints the row the server answered with, without a second read. */
  async function create(): Promise<void> {
    setCreating(true)
    try {
      const days = Number(expiryDays)
      const answer = await api.todos.feed.create({
        password: password === '' ? null : password,
        expiresIn: days > 0 ? days * DAY_MS : null,
      })
      setFeeds((current) => [answer.feed, ...(current ?? [])])
      setPassword('')
      setLoadError(null)
      toast({ title: t('settings.todo_feed_created'), tone: 'success' })
    } catch (cause) {
      toast({ title: t('common.action_failed'), description: describeError(cause), tone: 'danger' })
    } finally {
      setCreating(false)
    }
  }

  async function copy(feed: TodoFeedInfo): Promise<void> {
    if (!(await copyText(feedUrl(feed.slug)))) {
      toast({ title: t('preview.could_not_copy'), tone: 'danger' })
      return
    }
    setCopied(feed.slug)
    window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(null), COPY_RESET_MS)
  }

  /**
   * Revokes one feed after the dialog's confirmation.
   *
   * The row leaves the list only once the server said it is dead; a failed revoke leaves it there and
   * says why, because a row that vanished on a failed write would claim the calendar already stopped.
   */
  async function revoke(feed: TodoFeedInfo): Promise<void> {
    if (revoking) return
    setRevoking(feed.slug)
    try {
      const ok = await confirm({
        title: t('settings.todo_feed_revoke_title'),
        description: t('settings.todo_feed_revoke_body'),
        confirmLabel: t('settings.todo_feed_revoke'),
        tone: 'danger',
      })
      if (!ok) return
      await api.todos.feed.remove(feed.slug)
      setFeeds((current) => current?.filter((entry) => entry.slug !== feed.slug) ?? null)
      toast({ title: t('settings.todo_feed_revoked'), tone: 'success' })
    } catch (cause) {
      toast({ title: t('common.action_failed'), description: describeError(cause), tone: 'danger' })
    } finally {
      setRevoking(null)
    }
  }

  return (
    <section
      data-setting-title={t('settings.todo_feed')}
      className="border-t border-[var(--border-subtle)] py-3"
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {t('settings.todo_feed')}
          </h3>
          <p className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
            {t('settings.todo_feed_hint')}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={13} />}
          loading={loading}
          onClick={() => void load()}
          aria-label={t('common.refresh')}
          title={t('common.refresh')}
        />
      </div>

      {loadError && (
        <div role="alert" className="mb-2 flex items-center justify-between gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]">
          <span>{t('settings.todo_feed_load_failed')} {loadError}</span>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        </div>
      )}

      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_132px_auto] md:items-end">
        <div className="min-w-0">
          <label htmlFor={passwordId} className="mb-1 block text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('settings.todo_feed_password')}
          </label>
          <Input
            id={passwordId}
            type="password"
            autoComplete="new-password"
            value={password}
            disabled={creating}
            aria-describedby={passwordHintId}
            onChange={(event) => setPassword(event.target.value)}
            className="max-w-[320px]"
          />
        </div>
        <div>
          <label htmlFor={expiryId} className="mb-1 block text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('settings.todo_feed_expiry')}
          </label>
          <Select
            id={expiryId}
            value={expiryDays}
            disabled={creating}
            onChange={(event) => setExpiryDays(event.target.value)}
            className="w-full"
          >
            <option value="0">{t('settings.todo_feed_expiry_never')}</option>
            {EXPIRY_DAYS.map((days) => (
              <option key={days} value={String(days)}>
                {t('settings.todo_feed_expiry_days', { days })}
              </option>
            ))}
          </Select>
        </div>
        <Button variant="primary" loading={creating} onClick={() => void create()}>
          {t('settings.todo_feed_create')}
        </Button>
      </div>
      <p id={passwordHintId} className="mt-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
        {t('settings.todo_feed_password_hint', { min: LIMITS.sharePasscodeMinLength })}
      </p>

      {feeds === null
        ? !loadError && (
          <p role="status" className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('common.loading')}
          </p>
        )
        : feeds.length === 0
          ? (
            <p className="mt-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('settings.todo_feed_empty')}
            </p>
          )
          : (
            <div className="mt-2 divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
              {feeds.map((feed) => {
                const url = feedUrl(feed.slug)
                const expired = feed.expiresAt !== null && feed.expiresAt <= Date.now()
                return (
                  <div key={feed.slug} className="px-3 py-3">
                    <div className="flex items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                      <Link2 size={12} className="shrink-0" />
                      <input
                        readOnly
                        value={url}
                        aria-label={`${t('settings.todo_feed_url')}: ${feed.slug}`}
                        onFocus={(event) => event.currentTarget.select()}
                        className="min-w-0 flex-1 truncate rounded-[var(--r-sm)] bg-transparent text-[length:var(--text-11)] text-[var(--text-secondary)] transition-[box-shadow] duration-[var(--dur-fast)] focus:shadow-[var(--shadow-ring-focus)] focus:outline-none"
                      />
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                      {feed.hasPassword && <span>{t('share.passcode_protected')}</span>}
                      <span className={expired ? 'text-[var(--danger)]' : undefined}>
                        {feed.expiresAt !== null
                          ? t('settings.todo_feed_expires', { time: fullTime(feed.expiresAt) })
                          : t('share.never_expires_71ab34')}
                      </span>
                      {expired && <span className="text-[var(--danger)]">{t('share.expired')}</span>}
                      <span>{t('settings.todo_feed_created_at', { time: fullTime(feed.createdAt) })}</span>
                    </div>
                    {feed.hasPassword && (
                      <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                        {t('settings.todo_feed_password_hint', { min: LIMITS.sharePasscodeMinLength })}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={copied === feed.slug ? <Check size={12} /> : <Copy size={12} />}
                        onClick={() => void copy(feed)}
                      >
                        {copied === feed.slug ? t('common.copied') : t('common.copy')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Trash2 size={12} />}
                        loading={revoking === feed.slug}
                        disabled={revoking !== null}
                        className="text-[var(--danger)]"
                        onClick={() => void revoke(feed)}
                      >
                        {t('settings.todo_feed_revoke')}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
    </section>
  )
}
