/**
 * Publishing one conversation, from the panel that owns it.
 *
 * The notes app's share panel is the model — link, passcode, expiry, revoke — and the copy says what is
 * different about sharing a thread: a visitor reads the transcript, and not the thinking, the tool
 * results or the attached files. Saying so under the switch is the honest place for it, because the
 * reader is deciding whether to send the link.
 *
 * The expiry ladder, the passcode rules and the keep-what-you-had semantics are the notes panel's, taken
 * from `share-form.ts` rather than written again.
 */

import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Eye, Globe, Link2, Lock, RefreshCw, Trash2 } from 'lucide-react'
import { LIMITS } from '@shared/constants'
import type { ConversationShareInfo } from '@shared/assistant'
import { api, ApiError } from '../../lib/api'
import { cn } from '../../lib/cn'
import { fullTime } from '../../lib/time'
import { COPY_RESET_MS } from '../../lib/motion'
import { Badge, Button } from '../../components/primitives'
import { Field, Input, Segmented, Switch } from '../../components/form'
import { Modal, Tooltip, confirm } from '../../components/overlay'
import { Empty, LoadingBlock } from '../../components/feedback'
import { useUi } from '../../store/ui'
import { useLocale, t } from '../../lib/i18n'
import { expiresInForSelection, KEEP_CURRENT_EXPIRY, needsNewSharePasscode } from './share-form'

const EXPIRY_OPTIONS = [
  { value: '0', label: () => t('share.never_expires') },
  { value: String(24 * 3600000), label: () => t('share.1_day') },
  { value: String(7 * 24 * 3600000), label: () => t('share.7_days') },
  { value: String(30 * 24 * 3600000), label: () => t('share.30_days') },
]

export function ConversationSharePanel({ conversationId, title, onClose }: {
  conversationId: string
  title: string
  onClose: () => void
}) {
  const toast = useUi((s) => s.toast)
  useLocale()
  const [share, setShare] = useState<ConversationShareInfo | null | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'revoke' | 'rotate' | null>(null)
  const [reload, setReload] = useState(0)
  const [password, setPassword] = useState('')
  const [usePassword, setUsePassword] = useState(false)
  const [expiry, setExpiry] = useState('0')
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef(0)

  useEffect(() => {
    let cancelled = false
    setShare(undefined)
    setLoadError(null)
    void api.assistant.conversationShare(conversationId).then((result) => {
      if (cancelled) return
      setShare(result.share)
      setUsePassword(Boolean(result.share?.hasPassword))
      setExpiry(result.share?.expiresAt ? KEEP_CURRENT_EXPIRY : '0')
    }).catch((error) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
    })
    return () => { cancelled = true }
  }, [conversationId, reload])

  useEffect(() => () => window.clearTimeout(copiedTimer.current), [])

  const save = async (rotate = false) => {
    setBusy(rotate ? 'rotate' : 'save')
    try {
      const expiresIn = expiresInForSelection(expiry)
      const result = await api.assistant.createConversationShare(conversationId, {
        password: usePassword ? password : null,
        ...(expiresIn === undefined ? {} : { expiresIn }),
        ...(rotate ? { rotate: true } : {}),
      })
      setShare(result.share)
      setPassword('')
      // A rotated link makes the one the reader already sent stop working, so the toast says it rather
      // than leaving them to discover it.
      toast({
        title: rotate ? t('assistant.share.rotated') : t('assistant.share.saved'),
        tone: 'success',
      })
    } catch (error) {
      toast({ title: error instanceof ApiError ? error.message : t('assistant.toast.failed'), tone: 'danger' })
      setReload((value) => value + 1)
    } finally {
      setBusy(null)
    }
  }

  const revoke = async () => {
    const agreed = await confirm({
      title: t('assistant.share.revoke_title'),
      description: t('assistant.share.revoke_hint'),
      confirmLabel: t('share.revoke_link'),
      tone: 'danger',
    })
    if (!agreed) return
    setBusy('revoke')
    try {
      await api.assistant.removeConversationShare(conversationId)
      setShare(null)
      setUsePassword(false)
      setPassword('')
      setExpiry('0')
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : t('assistant.toast.failed'), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  const copy = async () => {
    if (!share) return
    try {
      await navigator.clipboard.writeText(share.url)
      setCopied(true)
      window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), COPY_RESET_MS)
    } catch {
      toast({ title: t('preview.could_not_copy'), tone: 'danger' })
    }
  }

  const blocked = share === undefined || busy !== null || needsNewSharePasscode(usePassword, Boolean(share?.hasPassword), password)

  return (
    <Modal
      open
      onClose={onClose}
      title={t('assistant.share.title')}
      description={`"${title}"`}
      width={480}
      footer={share ? (
        <>
          <Button variant="ghost" className="mr-auto text-[var(--danger)]" icon={<Trash2 size={13} />} loading={busy === 'revoke'} disabled={busy === 'save'} onClick={() => void revoke()}>
            {t('share.revoke_link')}
          </Button>
          <Button variant="secondary" disabled={busy !== null} onClick={onClose}>{t('share.done')}</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={busy === 'revoke'} onClick={() => void save()}>{t('share.update_settings')}</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" disabled={busy !== null} onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            icon={<Globe size={13} />}
            loading={busy === 'save'}
            disabled={blocked}
            onClick={() => void save()}
          >
            {t('share.generate_public_link')}
          </Button>
        </>
      )}
    >
      {loadError ? (
        <Empty
          art="notes"
          compact
          title={t('share.could_not_load_sharing_status')}
          description={loadError}
          action={<Button size="sm" variant="secondary" onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</Button>}
        />
      ) : share === undefined ? (
        <LoadingBlock label={t('share.loading_share_status')} />
      ) : (
        <div className="space-y-4">
          {share && (
            <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
              <div className="flex items-center gap-2">
                <Link2 size={13} className="shrink-0 text-[var(--accent)]" />
                <input
                  aria-label={t('share.public_link')}
                  readOnly
                  value={share.url}
                  onFocus={(event) => event.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-[var(--r-sm)] bg-transparent font-mono text-[length:var(--text-11-5)] text-[var(--text-secondary)] focus:outline-none"
                />
                <Button size="sm" variant={copied ? 'ghost' : 'secondary'} icon={copied ? <Check size={12} className="text-[var(--success)]" /> : <Copy size={12} />} onClick={() => void copy()}>
                  {copied ? t('common.copied') : t('common.copy')}
                </Button>
                <Tooltip label={t('share.open_link')} side="left">
                  <a href={share.url} target="_blank" rel="noreferrer" aria-label={t('share.open_link')} className="inline-flex size-9 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-7">
                    <ExternalLink size={13} />
                  </a>
                </Tooltip>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-2.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                <span className="flex items-center gap-1"><Eye size={11} />{share.views}{t('share.visits')}</span>
                {share.hasPassword && <Badge tone="warning">{t('share.passcode_protected')}</Badge>}
                {share.expiresAt
                  ? <span className={cn(share.expiresAt < Date.now() && 'text-[var(--danger)]')}>
                      {share.expiresAt < Date.now() ? t('share.expired') : t('share.expires_value0', { value0: fullTime(share.expiresAt) })}
                    </span>
                  : <span>{t('share.never_expires')}</span>}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  icon={<RefreshCw size={12} />}
                  loading={busy === 'rotate'}
                  disabled={busy !== null}
                  onClick={() => void save(true)}
                >
                  {t('assistant.share.rotate')}
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-4 py-1">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[length:var(--text-13)] font-medium">
                <Lock size={12} className="text-[var(--text-tertiary)]" />{t('common.access_passcode')}
              </div>
              <p className="mt-0.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('assistant.share.passcode_hint')}</p>
            </div>
            <Switch checked={usePassword} disabled={busy !== null} onChange={setUsePassword} label={t('common.access_passcode')} />
          </div>

          {usePassword && (
            <Field label={t('share.passcode')} hint={share?.hasPassword ? t('share.leave_blank_to_keep_the_current_passcode') : undefined}>
              <Input
                type="password"
                value={password}
                disabled={busy !== null}
                maxLength={LIMITS.passwordMaxLength}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={share?.hasPassword ? t('share.unchanged') : t('share.set_a_passcode')}
                autoComplete="new-password"
              />
            </Field>
          )}

          <Field label={t('share.expiration')}>
            <Segmented
              value={expiry}
              disabled={busy !== null}
              onChange={setExpiry}
              options={[
                ...(share?.expiresAt ? [{ value: KEEP_CURRENT_EXPIRY, label: t('share.keep_current_expiration') }] : []),
                ...EXPIRY_OPTIONS.map((option) => ({ ...option, label: option.label() })),
              ]}
            />
          </Field>

          {/* What the visitor gets is not the same list as what the reader sees, so it is spelled out
              where the decision is made rather than discovered after sending the link. */}
          <p className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-3 py-2.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
            {t('assistant.share.what_is_shared')}
          </p>
        </div>
      )}
    </Modal>
  )
}
