/**
 * The email-to-task block of the to-do settings page.
 *
 * The inbound half of the to-do app: a message posted to this account's address becomes a task, which
 * is the one door that works from a phone's share sheet, a mail rule or a colleague's forward without
 * anybody installing anything. The address is the capability — 200 bits of randomness — so this screen
 * is where the owner reads it, copies it, rotates it and revokes it.
 *
 * The server refuses to answer when `MAIL_DOMAIN` is not configured, and says why in the refusal. That
 * reason is shown rather than swallowed: an empty address list would read as "you never asked for one",
 * which is a different and wrong answer.
 *
 * Load, failure and empty are three separate states, exactly as the feed block beside it keeps them.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Check, Copy, Mail, RefreshCw, Trash2 } from 'lucide-react'
import { api, ApiError } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { fullTime } from '../../lib/time'
import { COPY_RESET_MS } from '../../lib/motion'
import { Button } from '../../components/primitives'
import { LoadingBlock } from '../../components/feedback'
import { confirm } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { t, translateApiError } from '../../lib/i18n'

interface MailTokenState {
  address: string | null
  createdAt: number | null
}

function describeError(cause: unknown): string {
  if (cause instanceof ApiError) return translateApiError(cause.code, cause.message)
  return cause instanceof Error ? cause.message : String(cause)
}

export function MailToTaskSettings() {
  const [state, setState] = useState<MailTokenState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'load' | 'create' | 'revoke' | null>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef(0)
  const addressId = useId()
  const toast = useUi((state) => state.toast)

  async function load(): Promise<void> {
    setBusy('load')
    try {
      const answer = await api.todos.mailToken.get()
      setState({ address: answer.address, createdAt: answer.createdAt })
      setLoadError(null)
    } catch (cause) {
      setLoadError(describeError(cause))
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    void load()
    return () => {
      window.clearTimeout(copiedTimer.current)
    }
    // Once per visit: the address is this account's and changes only through the buttons below.
  }, [])

  /** Issues the first address, or rotates the one already issued; both are the same door. */
  async function create(): Promise<void> {
    setBusy('create')
    try {
      const answer = await api.todos.mailToken.create()
      setState({ address: answer.address, createdAt: answer.createdAt })
      setLoadError(null)
      toast({ title: t('settings.todo_mail_issued'), tone: 'success' })
    } catch (cause) {
      toast({ title: t('common.action_failed'), description: describeError(cause), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  async function copy(): Promise<void> {
    if (!state?.address) return
    if (!(await copyText(state.address))) {
      toast({ title: t('preview.could_not_copy'), tone: 'danger' })
      return
    }
    setCopied(true)
    window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(false), COPY_RESET_MS)
  }

  /**
   * Revokes the address after the dialog's confirmation.
   *
   * Mail addressed to a revoked token is dropped exactly like mail to one that never existed, so the
   * row leaves the screen only once the server said it is dead.
   */
  async function revoke(): Promise<void> {
    if (busy) return
    setBusy('revoke')
    try {
      const ok = await confirm({
        title: t('settings.todo_mail_revoke_title'),
        description: t('settings.todo_mail_revoke_body'),
        confirmLabel: t('settings.todo_mail_revoke'),
        tone: 'danger',
      })
      if (!ok) return
      await api.todos.mailToken.remove()
      setState({ address: null, createdAt: null })
      toast({ title: t('settings.todo_mail_revoked'), tone: 'success' })
    } catch (cause) {
      toast({ title: t('common.action_failed'), description: describeError(cause), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  const address = state?.address ?? null

  return (
    <section
      data-setting-title={t('settings.todo_mail')}
      className="flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-4"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('settings.todo_mail')}</h3>
        <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">{t('settings.todo_mail_hint')}</p>
      </div>

      {loadError && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--danger)] px-3 py-2">
          <span className="min-w-0 flex-1 break-words text-[length:var(--text-12)] text-[var(--danger)]">{loadError}</span>
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => { void load() }}>
            <RefreshCw size={13} />{t('common.retry')}
          </Button>
        </div>
      )}

      {!loadError && state === null && <LoadingBlock />}

      {!loadError && state !== null && (
        address ? (
          <div className="flex flex-wrap items-center gap-2">
            <code
              id={addressId}
              className="min-w-0 flex-1 break-all rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5 text-[length:var(--text-12)] text-[var(--text-primary)]"
            >
              {address}
            </code>
            <Button size="sm" variant="secondary" onClick={() => { void copy() }}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? t('common.copied') : t('common.copy')}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => { void create() }}>
              <RefreshCw size={13} />{t('settings.todo_mail_rotate')}
            </Button>
            <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => { void revoke() }}>
              <Trash2 size={13} />{t('settings.todo_mail_revoke')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('settings.todo_mail_none')}</p>
            <Button size="sm" disabled={busy !== null} onClick={() => { void create() }}>
              <Mail size={13} />{t('settings.todo_mail_issue')}
            </Button>
          </div>
        )
      )}

      {address && state?.createdAt != null && (
        <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {t('settings.todo_mail_issued_at', { when: fullTime(state.createdAt) })}
        </p>
      )}
    </section>
  )
}
