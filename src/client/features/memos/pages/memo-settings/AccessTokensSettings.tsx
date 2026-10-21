import { useState, type FormEvent } from 'react'
import { Copy, Trash2 } from 'lucide-react'
import type { MemoToken, MemoTokenCreateResult } from '@shared/memos/types'
import { Badge, Button } from '../../../../components/primitives'
import { Field, Input, Select } from '../../../../components/form'
import { LoadingBlock } from '../../../../components/feedback'
import { Modal, confirm } from '../../../../components/overlay'
import { copyText } from '../../../../lib/clipboard'
import { t, type MessageKey } from '../../../../lib/i18n'
import { fullTime } from '../../../../lib/time'
import { memosApi } from '../../api'
import { bump, useRevision } from '../../events'
import { useMemoResource } from '../../use-resource'
import { MEMO_SETTINGS_SECTION_IDS } from './sections'
import { SettingsCard } from './SettingsCard'
import { settingsErrorMessage } from './error'

const SECONDS_PER_DAY = 86_400
const TOKEN_DESCRIPTION_MAX_LENGTH = 128
const EXPIRY_OPTIONS = ['never', '30', '90'] as const

type TokenExpiry = (typeof EXPIRY_OPTIONS)[number]

const EXPIRY_KEYS: Record<TokenExpiry, MessageKey> = {
  never: 'memos.settings.tokens_expiry_never',
  '30': 'memos.settings.tokens_expiry_30',
  '90': 'memos.settings.tokens_expiry_90',
}

const EXPIRY_DAYS: Record<Exclude<TokenExpiry, 'never'>, number> = {
  '30': 30,
  '90': 90,
}

function expiryTimestamp(expiry: TokenExpiry): number | null {
  if (expiry === 'never') return null
  return Math.floor(Date.now() / 1000) + EXPIRY_DAYS[expiry] * SECONDS_PER_DAY
}

function isExpired(token: MemoToken, nowMs: number): boolean {
  return token.expiresAt !== null && token.expiresAt * 1000 <= nowMs
}

export function AccessTokensSettings() {
  const revision = useRevision('tokens')
  const tokens = useMemoResource(
    (signal) => memosApi.tokens.list(signal).then((page) => page.tokens),
    [revision],
  )
  const [description, setDescription] = useState('')
  const [expiry, setExpiry] = useState<TokenExpiry>('never')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [created, setCreated] = useState<MemoTokenCreateResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const items = tokens.data ?? []
  const loading = tokens.status === 'loading' && tokens.data === null
  const failed = tokens.status === 'error' && tokens.data === null
  const nowMs = Date.now()

  const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (creating) return
    const trimmed = description.trim()
    if (trimmed.length > TOKEN_DESCRIPTION_MAX_LENGTH) {
      setCreateError(t('memos.settings.tokens_description_too_long', { max: TOKEN_DESCRIPTION_MAX_LENGTH }))
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const result = await memosApi.tokens.create({
        description: trimmed,
        expiresAt: expiryTimestamp(expiry),
      })
      setCreated(result)
      setCopied(false)
      setCopyFailed(false)
      setDescription('')
      bump('tokens')
    } catch (failure) {
      setCreateError(settingsErrorMessage(failure))
    } finally {
      setCreating(false)
    }
  }

  const copyCreated = async (): Promise<void> => {
    if (!created) return
    const ok = await copyText(created.token)
    setCopied(ok)
    setCopyFailed(!ok)
  }

  const revoke = async (token: MemoToken): Promise<void> => {
    if (revokingId) return
    const label = token.description || t('memos.settings.tokens_untitled')
    const agreed = await confirm({
      title: t('memos.settings.tokens_revoke_title'),
      description: t('memos.settings.tokens_revoke_description', { description: label }),
      confirmLabel: t('memos.settings.tokens_revoke_confirm'),
      cancelLabel: t('memos.common.cancel'),
      tone: 'danger',
    })
    if (!agreed) return
    setRevokingId(token.id)
    setRevokeError(null)
    try {
      await memosApi.tokens.delete(token.id)
      bump('tokens')
    } catch (failure) {
      setRevokeError(settingsErrorMessage(failure))
    } finally {
      setRevokingId(null)
    }
  }

  const curlExample = created && typeof window !== 'undefined'
    ? `curl -H "Authorization: Bearer ${created.token}" "${window.location.origin}/api/memos?limit=1"`
    : ''

  return (
    <SettingsCard
      id={MEMO_SETTINGS_SECTION_IDS.tokens}
      title={t('memos.settings.tokens')}
      description={t('memos.settings.tokens_description')}
    >
      <form onSubmit={(event) => void create(event)} className="flex flex-wrap items-end gap-2">
        <Field
          label={t('memos.settings.tokens_description_label')}
          className="min-w-[180px] flex-1"
        >
          <Input
            value={description}
            disabled={creating}
            maxLength={TOKEN_DESCRIPTION_MAX_LENGTH}
            invalid={Boolean(createError)}
            placeholder={t('memos.settings.tokens_description_placeholder')}
            onChange={(event) => {
              setDescription(event.target.value)
              if (createError) setCreateError(null)
            }}
          />
        </Field>
        <Field label={t('memos.settings.tokens_expiry_label')} className="w-[150px]">
          <Select
            value={expiry}
            disabled={creating}
            onChange={(event) => {
              const next = event.target.value
              if ((EXPIRY_OPTIONS as readonly string[]).includes(next)) {
                setExpiry(next as TokenExpiry)
              }
            }}
          >
            {EXPIRY_OPTIONS.map((option) => (
              <option key={option} value={option}>{t(EXPIRY_KEYS[option])}</option>
            ))}
          </Select>
        </Field>
        <Button type="submit" size="md" variant="primary" loading={creating}>
          {creating ? t('memos.settings.tokens_creating') : t('memos.settings.tokens_create')}
        </Button>
      </form>
      {createError ? (
        <div role="alert" className="mt-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-2">
          <p className="text-[length:var(--text-11-5)] font-medium text-[var(--danger)]">
            {t('memos.settings.tokens_create_failed')}
          </p>
          <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
            {createError}
          </p>
        </div>
      ) : null}
      <section aria-label={t('memos.settings.tokens_list')} className="mt-4">
        <h4 className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('memos.settings.tokens_list')}
        </h4>
        {revokeError ? (
          <div role="alert" className="mt-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-2">
            <p className="text-[length:var(--text-11-5)] font-medium text-[var(--danger)]">
              {t('memos.settings.tokens_revoke_failed')}
            </p>
            <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
              {revokeError}
            </p>
          </div>
        ) : null}
        {loading ? <LoadingBlock label={t('memos.common.loading')} /> : null}
        {failed ? (
          <div className="mt-2">
            <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">
              {tokens.error ?? t('memos.settings.tokens_load_failed')}
            </p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={tokens.reload}>
              {t('memos.common.retry')}
            </Button>
          </div>
        ) : null}
        {!loading && !failed && items.length === 0 ? (
          <p className="mt-1.5 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('memos.settings.tokens_empty')}
          </p>
        ) : null}
        {items.length > 0 ? (
          <ul className="mt-1 divide-y divide-[var(--border-subtle)]">
            {items.map((token) => {
              const label = token.description || t('memos.settings.tokens_untitled')
              return (
                <li key={token.id} className="flex flex-wrap items-start gap-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
                      <span className="min-w-0 break-words">{label}</span>
                      {isExpired(token, nowMs) ? (
                        <Badge tone="warning">{t('memos.settings.tokens_expired')}</Badge>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                      <span className="sr-only">{t('memos.settings.tokens_prefix')} </span>
                      <code className="rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-1 py-0.5 font-mono text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                        {token.prefix}…
                      </code>
                    </p>
                    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                      <span>{t('memos.settings.tokens_created_at', { time: fullTime(token.createdAt * 1000) })}</span>
                      <span>
                        {token.expiresAt === null
                          ? t('memos.settings.tokens_never_expires')
                          : t('memos.settings.tokens_expires_at', { time: fullTime(token.expiresAt * 1000) })}
                      </span>
                      <span>
                        {token.lastUsedAt === null
                          ? t('memos.settings.tokens_never_used')
                          : t('memos.settings.tokens_last_used_at', { time: fullTime(token.lastUsedAt * 1000) })}
                      </span>
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 size={13} />}
                    loading={revokingId === token.id}
                    disabled={revokingId !== null && revokingId !== token.id}
                    onClick={() => void revoke(token)}
                  >
                    {t('memos.settings.tokens_revoke')}
                  </Button>
                </li>
              )
            })}
          </ul>
        ) : null}
      </section>
      <Modal
        open={created !== null}
        onClose={() => setCreated(null)}
        title={t('memos.settings.tokens_created_title')}
        description={t('memos.settings.tokens_created_warning')}
        width={540}
        footer={<Button variant="secondary" onClick={() => setCreated(null)}>{t('memos.settings.tokens_done')}</Button>}
      >
        {created ? (
          <div className="space-y-3">
            <Field label={t('memos.settings.tokens_token_label')}>
              <Input
                readOnly
                value={created.token}
                onFocus={(event) => event.currentTarget.select()}
                className="font-mono text-[length:var(--text-11-5)]"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon={<Copy size={13} />} onClick={() => void copyCreated()}>
                {t('memos.settings.tokens_copy')}
              </Button>
              {copied ? (
                <span role="status" className="text-[length:var(--text-11)] text-[var(--success)]">
                  {t('memos.settings.tokens_copied')}
                </span>
              ) : null}
              {copyFailed ? (
                <span role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">
                  {t('memos.settings.tokens_copy_failed')}
                </span>
              ) : null}
            </div>
            <div>
              <p className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">
                {t('memos.settings.tokens_curl_hint')}
              </p>
              <pre className="mt-1 overflow-x-auto rounded-[var(--r-sm)] bg-[var(--bg-inset)] p-2 font-mono text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-secondary)]">
                <code>{curlExample}</code>
              </pre>
            </div>
          </div>
        ) : null}
      </Modal>
    </SettingsCard>
  )
}
