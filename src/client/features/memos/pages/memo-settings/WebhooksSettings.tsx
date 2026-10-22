import { useId, useState, type FormEvent } from 'react'
import { Copy } from 'lucide-react'
import type { MemoWebhook } from '@shared/memos/types'
import { Badge, Button } from '../../../../components/primitives'
import { Field, Input } from '../../../../components/form'
import { LoadingBlock } from '../../../../components/feedback'
import { Modal, confirm } from '../../../../components/overlay'
import { copyText } from '../../../../lib/clipboard'
import { t, type MessageKey } from '../../../../lib/i18n'
import { memoWebhooksClient } from '../../webhook-client'
import { bump, useRevision } from '../../events'
import { useMemoResource } from '../../use-resource'
import { MEMO_SETTINGS_SECTION_IDS } from './sections'
import { SettingsCard } from './SettingsCard'
import { settingsErrorMessage } from './error'

const WEBHOOK_TITLE_MAX_LENGTH = 120
const WEBHOOK_URL_MAX_LENGTH = 2048

const ACTION_FAILURE_KEYS: Record<'delete' | 'secret', MessageKey> = {
  delete: 'memos.settings.webhooks_delete_failed',
  secret: 'memos.settings.webhooks_regenerate_failed',
}

interface WebhookError {
  headingKey: MessageKey | null
  invalidField: 'title' | 'url' | null
  message: string
}

interface WebhookProblem {
  field: 'title' | 'url'
  message: string
}

interface RevealedSecret {
  title: string
  secret: string
}

type WebhookAction = 'delete' | 'secret'

function validateWebhook(title: string, url: string): WebhookProblem | null {
  const trimmedTitle = title.trim()
  if (!trimmedTitle) {
    return { field: 'title', message: t('memos.settings.webhooks_title_required') }
  }
  if (trimmedTitle.length > WEBHOOK_TITLE_MAX_LENGTH) {
    return {
      field: 'title',
      message: t('memos.settings.webhooks_title_too_long', { max: WEBHOOK_TITLE_MAX_LENGTH }),
    }
  }
  const trimmedUrl = url.trim()
  if (!trimmedUrl) {
    return { field: 'url', message: t('memos.settings.webhooks_url_required') }
  }
  if (trimmedUrl.length > WEBHOOK_URL_MAX_LENGTH) {
    return {
      field: 'url',
      message: t('memos.settings.webhooks_url_too_long', { max: WEBHOOK_URL_MAX_LENGTH }),
    }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmedUrl)
  } catch {
    return { field: 'url', message: t('memos.settings.webhooks_url_invalid') }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { field: 'url', message: t('memos.settings.webhooks_url_invalid') }
  }
  return null
}

function invalidError(problem: WebhookProblem): WebhookError {
  return { headingKey: null, invalidField: problem.field, message: problem.message }
}

function WebhookErrorNotice({ error, id }: { error: WebhookError; id?: string }) {
  return (
    <div id={id} role="alert" className="rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-2">
      {error.headingKey ? (
        <p className="text-[length:var(--text-11-5)] font-medium text-[var(--danger)]">
          {t(error.headingKey)}
        </p>
      ) : null}
      <p
        className={[
          'text-[length:var(--text-11)] leading-relaxed',
          error.headingKey ? 'mt-0.5 text-[var(--text-tertiary)]' : 'text-[var(--danger)]',
        ].join(' ')}
      >
        {error.message}
      </p>
    </div>
  )
}

export function WebhooksSettings() {
  const revision = useRevision('webhooks')
  const webhooks = useMemoResource((signal) => memoWebhooksClient.list(signal), [revision])
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<WebhookError | null>(null)
  const [editing, setEditing] = useState<MemoWebhook | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editUrl, setEditUrl] = useState('')
  const [editError, setEditError] = useState<WebhookError | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [pending, setPending] = useState<{ id: string; kind: WebhookAction } | null>(null)
  const [actionError, setActionError] = useState<WebhookError | null>(null)
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const editFormId = useId()
  const createProblemId = useId()
  const editProblemId = useId()
  const items = webhooks.data ?? []
  const loading = webhooks.status === 'loading' && webhooks.data === null
  const failed = webhooks.status === 'error'

  const reveal = (webhookTitle: string, secret: string): void => {
    setRevealed({ title: webhookTitle, secret })
    setCopied(false)
    setCopyFailed(false)
  }

  const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (creating) return
    const problem = validateWebhook(title, url)
    if (problem) {
      setCreateError(invalidError(problem))
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const result = await memoWebhooksClient.create({ title: title.trim(), url: url.trim() })
      setTitle('')
      setUrl('')
      reveal(result.webhook.title, result.signingSecret)
      bump('webhooks')
    } catch (failure) {
      setCreateError({
        headingKey: 'memos.settings.webhooks_create_failed',
        invalidField: null,
        message: settingsErrorMessage(failure),
      })
    } finally {
      setCreating(false)
    }
  }

  const startEdit = (webhook: MemoWebhook): void => {
    setEditing(webhook)
    setEditTitle(webhook.title)
    setEditUrl(webhook.url)
    setEditError(null)
  }

  const closeEdit = (): void => {
    if (!savingEdit) setEditing(null)
  }

  const saveEdit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!editing || savingEdit) return
    const problem = validateWebhook(editTitle, editUrl)
    if (problem) {
      setEditError(invalidError(problem))
      return
    }
    setSavingEdit(true)
    setEditError(null)
    try {
      await memoWebhooksClient.update(editing.id, {
        title: editTitle.trim(),
        url: editUrl.trim(),
      })
      setEditing(null)
      bump('webhooks')
    } catch (failure) {
      setEditError({
        headingKey: 'memos.settings.webhooks_update_failed',
        invalidField: null,
        message: settingsErrorMessage(failure),
      })
    } finally {
      setSavingEdit(false)
    }
  }

  const remove = async (webhook: MemoWebhook): Promise<void> => {
    if (pending) return
    const agreed = await confirm({
      title: t('memos.settings.webhooks_delete_title'),
      description: t('memos.settings.webhooks_delete_description', { title: webhook.title }),
      confirmLabel: t('memos.settings.webhooks_delete_confirm'),
      cancelLabel: t('memos.common.cancel'),
      tone: 'danger',
    })
    if (!agreed) return
    setPending({ id: webhook.id, kind: 'delete' })
    setActionError(null)
    try {
      await memoWebhooksClient.delete(webhook.id)
      bump('webhooks')
    } catch (failure) {
      setActionError({
        headingKey: ACTION_FAILURE_KEYS.delete,
        invalidField: null,
        message: settingsErrorMessage(failure),
      })
    } finally {
      setPending(null)
    }
  }

  const regenerate = async (webhook: MemoWebhook): Promise<void> => {
    if (pending) return
    const agreed = await confirm({
      title: t('memos.settings.webhooks_regenerate_title'),
      description: t('memos.settings.webhooks_regenerate_description', { title: webhook.title }),
      confirmLabel: t('memos.settings.webhooks_regenerate_confirm'),
      cancelLabel: t('memos.common.cancel'),
      tone: 'danger',
    })
    if (!agreed) return
    setPending({ id: webhook.id, kind: 'secret' })
    setActionError(null)
    try {
      const result = await memoWebhooksClient.regenerateSecret(webhook.id)
      reveal(result.webhook.title, result.signingSecret)
      bump('webhooks')
    } catch (failure) {
      setActionError({
        headingKey: ACTION_FAILURE_KEYS.secret,
        invalidField: null,
        message: settingsErrorMessage(failure),
      })
    } finally {
      setPending(null)
    }
  }

  const copySecret = async (): Promise<void> => {
    if (!revealed) return
    const ok = await copyText(revealed.secret)
    setCopied(ok)
    setCopyFailed(!ok)
  }

  return (
    <SettingsCard
      id={MEMO_SETTINGS_SECTION_IDS.webhooks}
      title={t('memos.settings.webhooks')}
      description={t('memos.settings.webhooks_description')}
    >
      <form onSubmit={(event) => void create(event)} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-2.5">
        <h4 className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('memos.settings.webhooks_form_title')}
        </h4>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <Field label={t('memos.settings.webhooks_title_label')}>
            <Input
              value={title}
              disabled={creating}
              maxLength={WEBHOOK_TITLE_MAX_LENGTH}
              invalid={createError?.invalidField === 'title'}
              aria-describedby={createError ? createProblemId : undefined}
              placeholder={t('memos.settings.webhooks_title_placeholder')}
              onChange={(event) => {
                setTitle(event.target.value)
                if (createError) setCreateError(null)
              }}
            />
          </Field>
          <Field
            label={t('memos.settings.webhooks_url_label')}
            hint={t('memos.settings.webhooks_url_hint')}
          >
            <Input
              inputMode="url"
              spellCheck={false}
              value={url}
              disabled={creating}
              maxLength={WEBHOOK_URL_MAX_LENGTH}
              invalid={createError?.invalidField === 'url'}
              aria-describedby={createError ? createProblemId : undefined}
              placeholder={t('memos.settings.webhooks_url_placeholder')}
              onChange={(event) => {
                setUrl(event.target.value)
                if (createError) setCreateError(null)
              }}
            />
          </Field>
        </div>
        {createError ? (
          <div className="mt-2">
            <WebhookErrorNotice error={createError} id={createProblemId} />
          </div>
        ) : null}
        <div className="mt-2 flex justify-end">
          <Button type="submit" size="sm" variant="primary" loading={creating}>
            {creating ? t('memos.settings.webhooks_creating') : t('memos.settings.webhooks_create')}
          </Button>
        </div>
      </form>
      <section aria-label={t('memos.settings.webhooks_list')} className="mt-4">
        <h4 className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('memos.settings.webhooks_list')}
        </h4>
        {actionError ? (
          <div className="mt-2">
            <WebhookErrorNotice error={actionError} />
          </div>
        ) : null}
        {loading ? <LoadingBlock label={t('memos.common.loading')} /> : null}
        {failed ? (
          <div className="mt-2">
            <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">
              {webhooks.error ?? t('memos.settings.webhooks_load_failed')}
            </p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={webhooks.reload}>
              {t('memos.common.retry')}
            </Button>
          </div>
        ) : null}
        {!loading && !failed && items.length === 0 ? (
          <p className="mt-1.5 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('memos.settings.webhooks_empty')}
          </p>
        ) : null}
        {items.length > 0 ? (
          <ul className="mt-1 divide-y divide-[var(--border-subtle)]">
            {items.map((webhook) => (
              <li key={webhook.id} className="flex flex-wrap items-start gap-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
                    <span className="min-w-0 break-words">{webhook.title}</span>
                    {webhook.signingSecretSet ? (
                      <Badge tone="success">{t('memos.settings.webhooks_secret_set')}</Badge>
                    ) : (
                      <Badge tone="warning">{t('memos.settings.webhooks_secret_missing')}</Badge>
                    )}
                  </p>
                  <p className="mt-0.5 break-all text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                    <code className="rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-1 py-0.5 font-mono text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                      {webhook.url}
                    </code>
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pending !== null}
                    onClick={() => startEdit(webhook)}
                  >
                    {t('memos.settings.webhooks_edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={pending !== null && pending.kind === 'secret' && pending.id === webhook.id}
                    disabled={pending !== null}
                    onClick={() => void regenerate(webhook)}
                  >
                    {t('memos.settings.webhooks_regenerate')}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={pending !== null && pending.kind === 'delete' && pending.id === webhook.id}
                    disabled={pending !== null}
                    onClick={() => void remove(webhook)}
                  >
                    {t('memos.settings.webhooks_delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <Modal
        open={editing !== null}
        onClose={closeEdit}
        title={t('memos.settings.webhooks_edit_title')}
        width={540}
        dismissible={!savingEdit}
        footer={(
          <>
            <Button variant="ghost" disabled={savingEdit} onClick={closeEdit}>
              {t('memos.common.cancel')}
            </Button>
            <Button
              type="submit"
              form={editFormId}
              variant="primary"
              loading={savingEdit}
              disabled={savingEdit}
            >
              {savingEdit ? t('memos.settings.webhooks_saving') : t('memos.settings.webhooks_save')}
            </Button>
          </>
        )}
      >
        <form id={editFormId} onSubmit={(event) => void saveEdit(event)} className="space-y-2">
          <Field label={t('memos.settings.webhooks_title_label')}>
            <Input
              value={editTitle}
              disabled={savingEdit}
              maxLength={WEBHOOK_TITLE_MAX_LENGTH}
              invalid={editError?.invalidField === 'title'}
              aria-describedby={editError ? editProblemId : undefined}
              onChange={(event) => {
                setEditTitle(event.target.value)
                if (editError) setEditError(null)
              }}
            />
          </Field>
          <Field
            label={t('memos.settings.webhooks_url_label')}
            hint={t('memos.settings.webhooks_url_hint')}
          >
            <Input
              inputMode="url"
              spellCheck={false}
              value={editUrl}
              disabled={savingEdit}
              maxLength={WEBHOOK_URL_MAX_LENGTH}
              invalid={editError?.invalidField === 'url'}
              aria-describedby={editError ? editProblemId : undefined}
              onChange={(event) => {
                setEditUrl(event.target.value)
                if (editError) setEditError(null)
              }}
            />
          </Field>
          {editError ? <WebhookErrorNotice error={editError} id={editProblemId} /> : null}
        </form>
      </Modal>
      <Modal
        open={revealed !== null}
        onClose={() => setRevealed(null)}
        title={t('memos.settings.webhooks_secret_title')}
        description={t('memos.settings.webhooks_secret_warning')}
        width={540}
        footer={<Button variant="secondary" onClick={() => setRevealed(null)}>{t('memos.settings.webhooks_done')}</Button>}
      >
        {revealed ? (
          <div className="space-y-3">
            <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
              {t('memos.settings.webhooks_secret_for', { title: revealed.title })}
            </p>
            <Field label={t('memos.settings.webhooks_secret_label')}>
              <Input
                readOnly
                value={revealed.secret}
                autoComplete="off"
                spellCheck={false}
                onFocus={(event) => event.currentTarget.select()}
                className="font-mono text-[length:var(--text-11-5)]"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon={<Copy size={13} />} onClick={() => void copySecret()}>
                {t('memos.settings.webhooks_copy')}
              </Button>
              {copied ? (
                <span role="status" className="text-[length:var(--text-11)] text-[var(--success)]">
                  {t('memos.settings.webhooks_copied')}
                </span>
              ) : null}
              {copyFailed ? (
                <span role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">
                  {t('memos.settings.webhooks_copy_failed')}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </Modal>
    </SettingsCard>
  )
}
