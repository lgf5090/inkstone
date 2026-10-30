import { useEffect, useState } from 'react'
import { Link2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { Field, Input } from '../../../components/form'
import { confirm, Modal } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { clouddriveApi, type CloudDriveFileRequest } from '../api'

interface RequestForm {
  name: string
  targetPath: string
  password: string
  expiresDays: string
  maxFiles: string
  maxBytes: string
  maxFileBytes: string
}

const EMPTY_FORM: RequestForm = {
  name: '',
  targetPath: '/',
  password: '',
  expiresDays: '7',
  maxFiles: '20',
  maxBytes: '100',
  maxFileBytes: '50',
}

export function RequestsPage() {
  const toast = useUi((state) => state.toast)
  const [items, setItems] = useState<CloudDriveFileRequest[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<RequestForm>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setStatus('loading')
    try {
      setItems((await clouddriveApi.requests()).requests)
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }
  useEffect(() => { void load() }, [])

  const create = async () => {
    setBusy(true)
    try {
      const days = Number(form.expiresDays) || 0
      await clouddriveApi.createRequest({
        name: form.name,
        targetPath: form.targetPath,
        password: form.password || undefined,
        expiresAt: days > 0 ? Date.now() + days * 86_400_000 : null,
        maxFiles: Number(form.maxFiles) || undefined,
        maxBytes: (Number(form.maxBytes) || 0) * 1024 * 1024 || undefined,
        maxFileBytes: (Number(form.maxFileBytes) || 0) * 1024 * 1024 || undefined,
      })
      setOpen(false)
      setForm(EMPTY_FORM)
      await load()
      toast({ title: t('clouddrive.requests.created') })
    } catch (caught) {
      toast({ title: t('clouddrive.toast.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (item: CloudDriveFileRequest) => {
    if (!(await confirm({ title: t('clouddrive.requests.revoke_title'), description: t('clouddrive.requests.revoke_body'), tone: 'danger' }))) return
    try {
      await clouddriveApi.revokeRequest(item.slug)
      await load()
    } catch (caught) {
      toast({ title: t('clouddrive.toast.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    }
  }

  const copy = async (item: CloudDriveFileRequest) => {
    const url = new URL(item.url, window.location.origin).toString()
    const ok = await copyText(url)
    toast({ title: ok ? t('clouddrive.toast.copied_link') : t('clouddrive.toast.failed'), tone: ok ? 'success' : 'danger' })
  }

  const field = (key: keyof RequestForm, label: string, options: { type?: string; min?: number } = {}) => (
    <Field label={label}>
      <Input
        type={options.type ?? 'text'}
        min={options.min}
        value={form[key]}
        onChange={(event) => setForm({ ...form, [key]: event.target.value })}
      />
    </Field>
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('clouddrive.requests.title')}</h1>
          <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{t('clouddrive.requests.description')}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={13} /> {t('clouddrive.toolbar.refresh')}</Button>
        <Button size="sm" variant="primary" onClick={() => { setForm(EMPTY_FORM); setOpen(true) }}><Plus size={13} /> {t('clouddrive.requests.add')}</Button>
      </div>
      {status === 'loading' && <div className="flex h-32 items-center justify-center"><Spinner /></div>}
      {status === 'error' && (
        <div role="alert" className="flex flex-col items-center gap-2 p-6 text-center">
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('clouddrive.failed')}</p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>{t('clouddrive.retry')}</Button>
        </div>
      )}
      {status === 'ready' && items.length === 0 && (
        <p className="py-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.requests.empty')}</p>
      )}
      {items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((item) => {
            const revoked = item.revokedAt !== null
            return (
              <li key={item.slug} className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link2 size={15} className="text-[var(--accent)]" aria-hidden />
                  <strong className="text-[length:var(--text-13)] text-[var(--text-primary)]">{item.name}</strong>
                  <span className="rounded-full bg-[var(--bg-inset)] px-2 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{item.targetPath}</span>
                  {revoked && <span className="text-[length:var(--text-10)] text-[var(--danger)]">{t('clouddrive.requests.status_revoked')}</span>}
                  <span className="min-w-0 flex-1" />
                  <Button size="sm" variant="secondary" disabled={revoked} onClick={() => void copy(item)}>{t('clouddrive.share.copy')}</Button>
                  {!revoked && <IconButton label={t('clouddrive.requests.revoke')} onClick={() => void revoke(item)}><Trash2 size={13} /></IconButton>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                  <span>{t('clouddrive.requests.received', {
                    files: item.receivedFiles,
                    maxFiles: item.maxFiles,
                    bytes: formatBytes(item.receivedBytes),
                    maxBytes: formatBytes(item.maxBytes),
                  })}</span>
                  {item.hasPassword && <span>{t('clouddrive.requests.password_set')}</span>}
                  <span>{item.expiresAt ? t('clouddrive.requests.expires', { time: new Date(item.expiresAt).toLocaleString() }) : t('clouddrive.requests.no_expiry')}</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('clouddrive.requests.add')}
        width={480}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t('clouddrive.dialog.cancel')}</Button>
            <Button variant="primary" loading={busy} disabled={!form.name.trim()} onClick={() => void create()}>{t('clouddrive.dialog.create')}</Button>
          </>
        )}
      >
        <div className="grid gap-2">
          {field('name', t('clouddrive.requests.name'))}
          {field('targetPath', t('clouddrive.requests.target'))}
          {field('password', t('clouddrive.share.password_label'), { type: 'password' })}
          {field('expiresDays', t('clouddrive.requests.expires_days'), { type: 'number', min: 0 })}
          {field('maxFiles', t('clouddrive.requests.max_files'), { type: 'number', min: 1 })}
          {field('maxBytes', t('clouddrive.requests.max_bytes'), { type: 'number', min: 1 })}
          {field('maxFileBytes', t('clouddrive.requests.max_file_bytes'), { type: 'number', min: 1 })}
        </div>
      </Modal>
    </div>
  )
}
