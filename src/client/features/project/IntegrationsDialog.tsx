/**
 * One place for the two machine-facing surfaces: an account's API tokens and a board's webhooks.
 * Both issue a secret exactly once, so the dialog keeps the value in local state until dismissed and
 * never reads it back from a list response.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { PROJECT_WEBHOOK_EVENTS, type ProjectWebhookEvent } from '@shared/project/integrations'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Input } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { Modal } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useProjectStore } from './store'
import {
  createProjectApiToken, createProjectWebhook, deleteProjectWebhook,
  fetchProjectApiTokens, fetchProjectWebhooks, patchProjectWebhook, revokeProjectApiToken,
  type ProjectApiTokenSummary, type ProjectWebhookSummary,
} from './api'

interface IntegrationsDialogProps {
  boardId: string
  onClose: () => void
}

type SecretPanel = { kind: 'token' | 'webhook', value: string } | null

const EVENT_LABELS: Record<string, Parameters<typeof t>[0]> = {
  '*': 'project.integrations.events_all',
  'card.created': 'project.integrations.event.card_created',
  'card.updated': 'project.integrations.event.card_updated',
  'card.deleted': 'project.integrations.event.card_deleted',
  'board.changed': 'project.integrations.event.board_changed',
}

function describeFailure(reason: unknown): void {
  // The route says which field it refused; the generic code sentence alone leaves the reader
  // guessing which of the two inputs to fix.
  const detail = reason instanceof ApiError ? reason.serverMessage : undefined
  useUi.getState().toast({
    title: reason instanceof Error ? reason.message : String(reason),
    ...(detail ? { description: detail } : {}),
    tone: 'danger',
  })
}

export function IntegrationsDialog({ boardId, onClose }: IntegrationsDialogProps): ReactElement {
  const [tokens, setTokens] = useState<ProjectApiTokenSummary[]>([])
  const [webhooks, setWebhooks] = useState<ProjectWebhookSummary[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [reload, setReload] = useState(0)
  const [secret, setSecret] = useState<SecretPanel>(null)
  const [tokenName, setTokenName] = useState('')
  const [tokenScope, setTokenScope] = useState<'read' | 'write'>('read')
  const [tokenBoardId, setTokenBoardId] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhookEvent, setWebhookEvent] = useState<'*' | ProjectWebhookEvent>('*')
  const [busy, setBusy] = useState(false)
  const boards = useProjectStore((state) => state.boards)

  useEffect(() => {
    let alive = true
    setStatus('loading')
    Promise.all([fetchProjectApiTokens(), fetchProjectWebhooks(boardId)])
      .then(([tokenList, webhookList]) => {
        if (!alive) return
        setTokens(tokenList)
        setWebhooks(webhookList)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (!alive) return
        setStatus('error')
        describeFailure(reason)
      })
    return () => { alive = false }
  }, [boardId, reload])

  const copySecret = async () => {
    if (!secret) return
    try {
      await navigator.clipboard.writeText(secret.value)
      useUi.getState().toast({ title: t('common.copied'), tone: 'success' })
    } catch (reason) {
      describeFailure(reason)
    }
  }

  const addToken = async () => {
    setBusy(true)
    try {
      const created = await createProjectApiToken({ name: tokenName.trim(), scope: tokenScope, boardId: tokenBoardId })
      setTokens((current) => [created.token, ...current])
      setSecret({ kind: 'token', value: created.secret })
      setTokenName('')
    } catch (reason) {
      describeFailure(reason)
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    try {
      await revokeProjectApiToken(id)
      setTokens((current) => current.filter((token) => token.id !== id))
    } catch (reason) {
      describeFailure(reason)
    }
  }

  const addWebhook = async () => {
    setBusy(true)
    try {
      const created = await createProjectWebhook(boardId, { url: webhookUrl.trim(), events: [webhookEvent] })
      setWebhooks((current) => [...current, created.webhook])
      setSecret({ kind: 'webhook', value: created.secret })
      setWebhookUrl('')
    } catch (reason) {
      describeFailure(reason)
    } finally {
      setBusy(false)
    }
  }

  const toggleWebhook = async (webhook: ProjectWebhookSummary) => {
    try {
      const updated = await patchProjectWebhook(boardId, webhook.id, { enabled: !webhook.enabled })
      setWebhooks((current) => current.map((entry) => entry.id === webhook.id ? updated : entry))
    } catch (reason) {
      describeFailure(reason)
    }
  }

  const removeWebhook = async (id: string) => {
    try {
      await deleteProjectWebhook(boardId, id)
      setWebhooks((current) => current.filter((webhook) => webhook.id !== id))
    } catch (reason) {
      describeFailure(reason)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('project.integrations.title')}
      width={640}
      footer={<Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="space-y-4">
        {status === 'error' && (
          <div className="flex items-center gap-2 text-[length:var(--text-12)] text-[var(--danger)]">
            <span role="status">{t('project.integrations.load_failed')}</span>
            <Button size="sm" onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</Button>
          </div>
        )}
        {status === 'loading' && <p role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('common.loading')}</p>}
        {status === 'ready' && (
          <>
            {secret && (
              <div className="space-y-2 rounded-[var(--r-md)] border border-[var(--accent)] p-3">
                <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
                  {t(secret.kind === 'token' ? 'project.integrations.token_secret' : 'project.integrations.webhook_secret')}
                </h3>
                <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {t(secret.kind === 'token' ? 'project.integrations.token_secret_hint' : 'project.integrations.webhook_secret_hint')}
                </p>
                <div className="flex items-center gap-2">
                  <Input className="min-w-0 flex-1" readOnly value={secret.value} aria-label={t('common.copy')} />
                  <Button size="sm" onClick={() => void copySecret()}>{t('common.copy')}</Button>
                  <IconButton label={t('common.close')} size="sm" onClick={() => setSecret(null)}><Trash2 size={14} /></IconButton>
                </div>
              </div>
            )}
            <section className="space-y-2">
              <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{t('project.integrations.tokens')}</h3>
              {tokens.length === 0 && <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.integrations.empty_tokens')}</p>}
              {tokens.filter((token) => token.revokedAt === null).map((token) => (
                <div key={token.id} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">{token.name}</span>
                  <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                    {t(token.scope === 'read' ? 'project.integrations.scope_read' : 'project.integrations.scope_write')}
                  </span>
                  <Button size="sm" onClick={() => void revoke(token.id)}>{t('project.integrations.revoke')}</Button>
                </div>
              ))}
              <div className="grid gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3 sm:grid-cols-2">
                <Input className="w-full" value={tokenName} aria-label={t('project.integrations.name')} placeholder={t('project.integrations.name')} onChange={(event) => setTokenName(event.target.value)} />
                <SelectMenu
                  className="w-full" label={t('project.integrations.scope')} value={tokenScope}
                  onChange={(next) => setTokenScope(next as 'read' | 'write')}
                  options={[
                    { value: 'read', label: t('project.integrations.scope_read') },
                    { value: 'write', label: t('project.integrations.scope_write') },
                  ]}
                />
                <SelectMenu
                  className="w-full" label={t('project.integrations.board')} value={tokenBoardId}
                  onChange={setTokenBoardId}
                  options={[
                    { value: '', label: t('project.integrations.board_all') },
                    ...boards.map((board) => ({ value: board.id, label: board.title || board.id })),
                  ]}
                />
                <Button variant="primary" icon={<Plus size={14} />} loading={busy} disabled={!tokenName.trim()} onClick={() => void addToken()}>
                  {t('project.integrations.create_token')}
                </Button>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{t('project.integrations.webhooks')}</h3>
              {webhooks.length === 0 && <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.integrations.empty_webhooks')}</p>}
              {webhooks.map((webhook) => (
                <div key={webhook.id} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
                  <Checkbox ariaLabel={t('project.integrations.enabled')} checked={webhook.enabled} onChange={() => void toggleWebhook(webhook)} />
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">{webhook.url}</span>
                  {webhook.pending > 0 && <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('project.integrations.pending', { count: webhook.pending })}</span>}
                  {webhook.lastError && <span className="text-[length:var(--text-11)] text-[var(--danger)]">{t('project.integrations.last_error', { message: webhook.lastError })}</span>}
                  <IconButton label={t('common.delete')} size="sm" onClick={() => void removeWebhook(webhook.id)}><Trash2 size={14} /></IconButton>
                </div>
              ))}
              <div className="grid gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3 sm:grid-cols-2">
                <Input className="w-full" value={webhookUrl} aria-label={t('project.integrations.url')} placeholder={t('project.integrations.url')} onChange={(event) => setWebhookUrl(event.target.value)} />
                <SelectMenu
                  className="w-full" label={t('project.integrations.events')} value={webhookEvent}
                  onChange={(next) => setWebhookEvent(next as '*' | ProjectWebhookEvent)}
                  options={['*', ...PROJECT_WEBHOOK_EVENTS].map((event) => ({ value: event, label: t(EVENT_LABELS[event] ?? 'project.integrations.events_all') }))}
                />
                <Button variant="primary" icon={<Plus size={14} />} loading={busy} disabled={!webhookUrl.trim()} onClick={() => void addWebhook()}>
                  {t('project.integrations.create_webhook')}
                </Button>
              </div>
            </section>
          </>
        )}
      </div>
    </Modal>
  )
}
