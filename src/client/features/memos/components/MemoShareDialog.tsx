import { useEffect, useState, type ReactElement } from 'react'
import { Copy } from 'lucide-react'
import type { MemoShare } from '@shared/memos/types'
import { Badge, Button } from '../../../components/primitives'
import { Field, Input, Select } from '../../../components/form'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { Modal, confirm } from '../../../components/overlay'
import { copyText } from '../../../lib/clipboard'
import { t } from '../../../lib/i18n'
import { fullTime } from '../../../lib/time'
import { memosApi } from '../api'
import { memoErrorMessage, memoIsAbortError } from '../errors'

const SHARE_EXPIRY_OPTIONS = ['never', '1', '7', '30'] as const
type ShareExpiry = (typeof SHARE_EXPIRY_OPTIONS)[number]
const SHARE_EXPIRY_DAYS: Record<Exclude<ShareExpiry, 'never'>, number> = { '1': 1, '7': 7, '30': 30 }
const SECONDS_PER_DAY = 86_400

function isShareExpiry(value: string): value is ShareExpiry {
  return (SHARE_EXPIRY_OPTIONS as readonly string[]).includes(value)
}

function expiryTimestamp(expiry: ShareExpiry, nowMs: number): number | null {
  if (expiry === 'never') return null
  return Math.floor(nowMs / 1000) + SHARE_EXPIRY_DAYS[expiry] * SECONDS_PER_DAY
}

function isExpired(share: MemoShare, nowMs: number): boolean {
  return share.expiresAt !== null && share.expiresAt * 1000 <= nowMs
}

function absoluteShareUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url
  return `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`
}

const EXPIRY_LABEL_KEYS = {
  never: 'memos.share.expiry_never',
  '1': 'memos.share.expiry_one_day',
  '7': 'memos.share.expiry_seven_days',
  '30': 'memos.share.expiry_thirty_days',
} as const

export interface MemoShareDialogProps {
  memoId: string
  open: boolean
  onClose: () => void
}

export function MemoShareDialog({ memoId, open, onClose }: MemoShareDialogProps): ReactElement {
  const [expiry, setExpiry] = useState<ShareExpiry>('never')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<MemoShare | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [shares, setShares] = useState<MemoShare[]>([])
  const [listStatus, setListStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState<string | null>(null)
  const [listTicket, setListTicket] = useState(0)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setExpiry('never')
    setCreated(null)
    setCreateError(null)
    setCopied(false)
    setCopyFailed(false)
    setShares([])
    setRevokeError(null)
  }, [open, memoId])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setListStatus('loading')
    setListError(null)
    memosApi.shares.list(memoId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setShares(result.shares)
        setListStatus('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || memoIsAbortError(error)) return
        setListStatus('error')
        setListError(memoErrorMessage(error))
      })
    return () => controller.abort()
  }, [open, memoId, listTicket])

  const create = async (): Promise<void> => {
    setCreating(true)
    setCreateError(null)
    setCopyFailed(false)
    try {
      const share = await memosApi.shares.create(memoId, { expiresAt: expiryTimestamp(expiry, Date.now()) })
      setCreated(share)
      setCopied(false)
      setListTicket((value) => value + 1)
    } catch (error) {
      setCreateError(memoErrorMessage(error))
    } finally {
      setCreating(false)
    }
  }

  const copy = async (): Promise<void> => {
    if (!created?.url) return
    const ok = await copyText(absoluteShareUrl(created.url))
    setCopied(ok)
    setCopyFailed(!ok)
  }

  const revoke = async (share: MemoShare): Promise<void> => {
    const ok = await confirm({
      title: t('memos.share.revoke_title'),
      description: t('memos.share.revoke_description'),
      confirmLabel: t('memos.share.revoke_confirm'),
      tone: 'danger',
    })
    if (!ok) return
    setRevokingId(share.id)
    setRevokeError(null)
    try {
      await memosApi.shares.delete(memoId, share.id)
      setShares((current) => current.filter((item) => item.id !== share.id))
      setCreated((current) => (current?.id === share.id ? null : current))
    } catch (error) {
      setRevokeError(memoErrorMessage(error))
    } finally {
      setRevokingId(null)
    }
  }

  const nowMs = Date.now()
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('memos.share.title')}
      description={t('memos.share.description')}
      width={500}
      footer={<Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="space-y-4 pt-1">
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('memos.share.expiry_label')} className="min-w-[160px] flex-1">
            <Select
              value={expiry}
              onChange={(event) => {
                const value = event.target.value
                if (isShareExpiry(value)) setExpiry(value)
              }}
            >
              {SHARE_EXPIRY_OPTIONS.map((option) => (
                <option key={option} value={option}>{t(EXPIRY_LABEL_KEYS[option])}</option>
              ))}
            </Select>
          </Field>
          <Button variant="primary" loading={creating} onClick={() => void create()}>
            {t('memos.share.create')}
          </Button>
        </div>
        {createError ? (
          <div role="alert">
            <p className="text-[length:var(--text-11-5)] font-medium text-[var(--danger)]">
              {t('memos.share.create_failed')}
            </p>
            <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{createError}</p>
          </div>
        ) : null}
        {created?.url ? (
          <section
            aria-label={t('memos.share.created_title')}
            className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-2.5"
          >
            <p className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
              {t('memos.share.created_title')}
            </p>
            <div className="mt-1.5 flex flex-col gap-1.5 sm:flex-row">
              <Input
                readOnly
                value={absoluteShareUrl(created.url)}
                aria-label={t('memos.share.link_label')}
                className="min-w-0 flex-1"
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button size="sm" variant="secondary" icon={<Copy size={13} />} onClick={() => void copy()}>
                {t('memos.share.copy')}
              </Button>
            </div>
            <p className="mt-1.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
              {t('memos.share.url_hint')}
            </p>
            <p role="status" aria-live="polite" className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
              {copied ? t('memos.share.copied') : ''}
            </p>
            {copyFailed ? (
              <p role="alert" className="mt-0.5 text-[length:var(--text-11)] text-[var(--danger)]">
                {t('memos.share.copy_failed')}
              </p>
            ) : null}
          </section>
        ) : null}
        <section aria-label={t('memos.share.links_title')}>
          <h3 className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('memos.share.links_title')}
          </h3>
          {listStatus === 'loading' ? <LoadingBlock label={t('memos.common.loading')} /> : null}
          {listStatus === 'error' ? (
            <div className="mt-2">
              <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">
                {listError ?? t('memos.share.links_error')}
              </p>
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => setListTicket((value) => value + 1)}>
                {t('memos.common.retry')}
              </Button>
            </div>
          ) : null}
          {listStatus === 'ready' && shares.length === 0 ? (
            <Empty compact art="notes" title={t('memos.share.links_empty')} />
          ) : null}
          {listStatus === 'ready' && shares.length > 0 ? (
            <ul className="mt-1 divide-y divide-[var(--border-subtle)]">
              {shares.map((share) => {
                const expired = isExpired(share, nowMs)
                return (
                  <li key={share.id} className="flex flex-wrap items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                        {t('memos.share.created_at', { time: fullTime(share.createdAt * 1000) })}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                        {share.expiresAt === null
                          ? t('memos.share.never_expires')
                          : t('memos.share.expires_at', { time: fullTime(share.expiresAt * 1000) })}
                        {expired ? <Badge tone="warning">{t('memos.share.expired')}</Badge> : null}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={revokingId === share.id}
                      aria-label={t('memos.share.revoke_for', { time: fullTime(share.createdAt * 1000) })}
                      onClick={() => void revoke(share)}
                    >
                      {t('memos.share.revoke')}
                    </Button>
                  </li>
                )
              })}
            </ul>
          ) : null}
          {revokeError ? (
            <div role="alert" className="mt-1">
              <p className="text-[length:var(--text-11-5)] font-medium text-[var(--danger)]">
                {t('memos.share.revoke_failed')}
              </p>
              <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{revokeError}</p>
            </div>
          ) : null}
        </section>
      </div>
    </Modal>
  )
}
