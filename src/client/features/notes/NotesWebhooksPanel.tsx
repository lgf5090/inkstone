import { useCallback, useEffect, useState } from 'react'
import { Copy, Plus, RefreshCw, Trash2, Webhook } from 'lucide-react'
import { NOTE_WEBHOOK_EVENTS } from '@shared/constants'
import type { NoteWebhook } from '@shared/types'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Checkbox, Input } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'

const EVENT_LABEL_KEYS = {
  'note.created': 'notes.webhook_event_created',
  'note.updated': 'notes.webhook_event_updated',
  'note.deleted': 'notes.webhook_event_deleted',
} as const

export function NotesWebhooksPanel({ onClose }: { onClose: () => void }) {
  const [webhooks, setWebhooks] = useState<NoteWebhook[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<string[]>([...NOTE_WEBHOOK_EVENTS])
  const [signingSecret, setSigningSecret] = useState<string | null>(null)
  const toast = useUi((state) => state.toast)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setWebhooks((await api.notes.webhooks.list()).webhooks)
    }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const create = async () => {
    if (!title.trim() || !url.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.notes.webhooks.create({ title: title.trim(), url: url.trim(), events })
      setSigningSecret(result.signingSecret)
      setTitle('')
      setUrl('')
      await load()
    }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    finally {
      setBusy(false)
    }
  }

  const toggle = async (webhook: NoteWebhook) => {
    try {
      const result = await api.notes.webhooks.update(webhook.id, { enabled: !webhook.enabled })
      setWebhooks((current) => current.map((entry) => entry.id === webhook.id ? result.webhook : entry))
    }
    catch (cause) {
      toast({ title: t('notes.webhook_failed'), description: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    }
  }

  const remove = async (webhook: NoteWebhook) => {
    const accepted = await confirm({
      title: t('notes.webhook_delete_confirm', { value0: webhook.title }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!accepted) return
    try {
      await api.notes.webhooks.remove(webhook.id)
      setWebhooks((current) => current.filter((entry) => entry.id !== webhook.id))
    }
    catch (cause) {
      toast({ title: t('notes.webhook_failed'), description: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    }
  }

  const regenerate = async (webhook: NoteWebhook) => {
    const accepted = await confirm({
      title: t('notes.webhook_regenerate_confirm', { value0: webhook.title }),
      confirmLabel: t('notes.webhook_regenerate'),
      tone: 'danger',
    })
    if (!accepted) return
    try {
      const result = await api.notes.webhooks.regenerateSecret(webhook.id)
      setSigningSecret(result.signingSecret)
      setWebhooks((current) => current.map((entry) => entry.id === webhook.id ? result.webhook : entry))
    }
    catch (cause) {
      toast({ title: t('notes.webhook_failed'), description: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    }
  }

  const copySecret = async () => {
    if (!signingSecret) return
    try {
      await navigator.clipboard.writeText(signingSecret)
      toast({ title: t('common.copied'), tone: 'success' })
    }
    catch {
      toast({ title: t('preview.could_not_copy'), tone: 'danger' })
    }
  }

  return (
    <Modal open onClose={onClose} title={t('notes.webhooks_title')} description={t('notes.webhooks_desc')} width={720}>
      <div className="mt-[var(--sp-2)] space-y-4">
        {signingSecret && <div className="rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-3">
          <p className="mb-2 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('notes.webhook_secret_once')}</p>
          <div className="flex items-center gap-2">
            <Input readOnly value={signingSecret} aria-label={t('notes.webhook_secret')} className="font-mono"/>
            <IconButton label={t('common.copy')} onClick={() => void copySecret()}><Copy size={14}/></IconButton>
          </div>
        </div>}

        <section className="space-y-3 rounded-[var(--r-md)] border border-[var(--border-default)] p-3">
          <h3 className="flex items-center gap-2 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]"><Plus size={14}/>{t('notes.webhook_create')}</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t('notes.webhook_title')} aria-label={t('notes.webhook_title')}/>
            <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" aria-label={t('notes.webhook_url')}/>
          </div>
          <div className="flex flex-wrap gap-4">
            {NOTE_WEBHOOK_EVENTS.map((event) => <Checkbox key={event} checked={events.includes(event)} label={t(EVENT_LABEL_KEYS[event])} onChange={(checked) => setEvents((current) => checked ? [...current, event] : current.filter((entry) => entry !== event))}/>)}
          </div>
          <Button size="sm" variant="primary" disabled={busy || !title.trim() || !url.trim() || !events.length} onClick={() => void create()}>
            {busy ? <Spinner/> : <Webhook size={14}/>} {t('notes.webhook_create')}
          </Button>
        </section>

        {error && <div role="alert" className="rounded-[var(--r-md)] border border-[var(--danger)] p-3 text-[var(--text-secondary)]">
          <p>{error}</p>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => void load()}>{t('common.retry')}</Button>
        </div>}

        <section className="space-y-2">
          <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('notes.webhooks_title')}</h3>
          {loading ? <div className="flex justify-center p-4"><Spinner/></div> : webhooks.map((webhook) => <article key={webhook.id} className="rounded-[var(--r-md)] border border-[var(--border-default)] p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="truncate font-medium text-[var(--text-primary)]">{webhook.title}</h4>
                <p className="truncate text-[length:var(--text-12)] text-[var(--text-tertiary)]">{webhook.url}</p>
                <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{webhook.events.join(' · ')} · {t('notes.webhook_pending', { value0: webhook.pending })}</p>
                {webhook.lastError && <p className="mt-1 text-[length:var(--text-11)] text-[var(--danger)]">{webhook.lastError}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Checkbox checked={webhook.enabled} ariaLabel={t('notes.webhook_enabled')} onChange={() => void toggle(webhook)}/>
                <IconButton label={t('notes.webhook_regenerate')} onClick={() => void regenerate(webhook)}><RefreshCw size={14}/></IconButton>
                <IconButton label={t('common.delete')} className="text-[var(--danger)]" onClick={() => void remove(webhook)}><Trash2 size={14}/></IconButton>
              </div>
            </div>
          </article>)}
        </section>
      </div>
    </Modal>
  )
}
