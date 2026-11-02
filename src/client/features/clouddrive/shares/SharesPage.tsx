import { useEffect, useMemo, useState } from 'react'
import { Edit3, ExternalLink, Link2, QrCode, RefreshCw, Trash2 } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { useUi } from '../../../store/ui'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { Field, Input, Segmented, Switch } from '../../../components/form'
import { confirm, Modal } from '../../../components/overlay'
import { clouddriveApi } from '../api'
import { useCloudDriveStore } from '../store'

interface Share {
  slug: string
  url: string
  targetKind: 'file' | 'folder'
  name: string
  hasPassword: boolean
  expiresAt: number | null
  maxViews: number | null
  maxDownloads: number | null
  allowDownload: boolean
  views: number
  downloads: number
  isEnabled: boolean
  revokedAt: number | null
  createdAt: number
}

type ShareFilter = 'all' | 'active' | 'expired' | 'revoked'

interface EditForm {
  password: string
  expiryDays: string
  maxViews: string
  maxDownloads: string
  allowDownload: boolean
  isEnabled: boolean
}

const EMPTY_FORM: EditForm = {
  password: '', expiryDays: '0', maxViews: '0', maxDownloads: '0', allowDownload: true, isEnabled: true,
}

const DAY_MS = 86_400_000

function isExpired(share: Share): boolean {
  return share.expiresAt !== null && share.expiresAt <= Date.now()
}

/** Revoking and disabling are the same state to the reader: the link is closed. */
function isClosed(share: Share): boolean {
  return share.revokedAt !== null || !share.isEnabled
}

function matchesFilter(share: Share, filter: ShareFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'revoked') return isClosed(share)
  if (filter === 'expired') return !isClosed(share) && isExpired(share)
  return !isClosed(share) && !isExpired(share)
}

function daysUntil(expiresAt: number | null): string {
  if (expiresAt === null) return '0'
  return String(Math.max(1, Math.round((expiresAt - Date.now()) / DAY_MS)))
}

export function SharesPage() {
  const toast = useUi((state) => state.toast)
  const [shares, setShares] = useState<Share[]>([])
  const [loading, setLoading] = useState(true)
  const refreshKey = useCloudDriveStore((state) => state.refreshKey)
  const [qr, setQr] = useState<Share | null>(null)
  const [filter, setFilter] = useState<ShareFilter>('all')
  const [editing, setEditing] = useState<Share | null>(null)
  const [form, setForm] = useState<EditForm>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)

  const shown = useMemo(() => shares.filter((share) => matchesFilter(share, filter)), [shares, filter])

  const openEdit = (share: Share) => {
    setEditing(share)
    setForm({
      password: '',
      expiryDays: daysUntil(share.expiresAt),
      maxViews: share.maxViews === null ? '0' : String(share.maxViews),
      maxDownloads: share.maxDownloads === null ? '0' : String(share.maxDownloads),
      allowDownload: share.allowDownload,
      isEnabled: share.isEnabled,
    })
  }

  const saveEdit = async () => {
    if (!editing) return
    const days = Number(form.expiryDays)
    const body = {
      expiresAt: Number.isFinite(days) && days > 0 ? Date.now() + days * DAY_MS : null,
      maxViews: Number(form.maxViews) > 0 ? Number(form.maxViews) : null,
      maxDownloads: Number(form.maxDownloads) > 0 ? Number(form.maxDownloads) : null,
      allowDownload: form.allowDownload,
      isEnabled: form.isEnabled,
      // An empty field leaves the passcode alone: clearing it is its own decision, made by typing.
      ...(form.password ? { password: form.password } : {}),
    }
    setBusy(true)
    try {
      await clouddriveApi.patchShare(editing.slug, body)
      toast({ title: t('clouddrive.share.updated') })
      setEditing(null)
      await load()
    } catch (error) {
      toast({ title: t('clouddrive.toast.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const load = async () => {
    setLoading(true)
    try {
      const result = await clouddriveApi.shares()
      setShares(result.shares as Share[])
    } catch (error) {
      toast({ title: t('clouddrive.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [refreshKey])

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('clouddrive.share.title')}</h1>
        <Segmented<ShareFilter>
          className="ml-auto"
          size="sm"
          value={filter}
          label={t('clouddrive.share.filter')}
          options={[
            { value: 'all', label: t('clouddrive.share.filter_all') },
            { value: 'active', label: t('clouddrive.share.filter_active') },
            { value: 'expired', label: t('clouddrive.share.filter_expired') },
            { value: 'revoked', label: t('clouddrive.share.filter_revoked') },
          ]}
          onChange={setFilter}
        />
        <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={13} /> {t('clouddrive.toolbar.refresh')}</Button>
      </div>
      {loading ? <div className="flex h-32 items-center justify-center"><Spinner /></div> : shares.length === 0 ? (
        <p className="py-10 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.share.no_shares')}</p>
      ) : shown.length === 0 ? (
        <p className="py-10 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.empty.search')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map((share) => (
            <li key={share.slug} className="flex min-w-0 flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
              <Link2 size={14} className="text-[var(--text-tertiary)]" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{share.name}</span>
              <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{share.targetKind === 'folder' ? t('clouddrive.share.kind_folder') : t('clouddrive.share.kind_file')}{share.hasPassword ? ' · ••••' : ''}</span>
              <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('clouddrive.share.views', { count: share.views })} · {t('clouddrive.share.downloads', { count: share.downloads })}</span>
              <span className={`shrink-0 rounded-full border border-[var(--border-subtle)] px-1.5 py-0.5 text-[length:var(--text-10)] ${isClosed(share) ? 'text-[var(--danger)]' : isExpired(share) ? 'text-[var(--warning)]' : 'text-[var(--text-tertiary)]'}`}>
                {isClosed(share) ? t('clouddrive.share.filter_revoked') : isExpired(share) ? t('clouddrive.share.filter_expired') : share.expiresAt === null ? t('clouddrive.share.filter_active') : `${t('clouddrive.share.filter_active')} · ${new Date(share.expiresAt).toLocaleString()}`}
              </span>
              <IconButton label={t('clouddrive.share.edit')} onClick={() => openEdit(share)}><Edit3 size={13} /></IconButton>
              <a className="rounded p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]" href={share.url} target="_blank" rel="noreferrer" aria-label={t('clouddrive.action.open')}><ExternalLink size={13} /></a>
              <IconButton label={t('clouddrive.share.qr')} onClick={() => setQr(share)}><QrCode size={13} /></IconButton>
              <IconButton label={t('clouddrive.share.copy')} onClick={() => void copyText(new URL(share.url, window.location.origin).toString()).then((ok) => toast({ title: ok ? t('clouddrive.toast.copied_link') : t('clouddrive.toast.failed'), tone: ok ? 'default' : 'danger' }))}><Link2 size={13} /></IconButton>
              <IconButton label={t('clouddrive.share.revoke')} onClick={async () => {
                if (!(await confirm({ title: t('clouddrive.share.revoke'), description: share.name, tone: 'danger' }))) return
                try { await clouddriveApi.revokeShare(share.slug); await load() } catch (error) { toast({ title: t('clouddrive.toast.failed'), description: String(error), tone: 'danger' }) }
              }}><Trash2 size={13} /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={t('clouddrive.share.edit')}
        width={460}
        footer={<><Button variant="ghost" onClick={() => setEditing(null)}>{t('clouddrive.dialog.cancel')}</Button><Button variant="primary" loading={busy} onClick={() => void saveEdit()}>{t('clouddrive.dialog.save')}</Button></>}
      >
        <div className="flex flex-col gap-2">
          <Field label={t('clouddrive.share.expires_days')} hint={t('clouddrive.share.expires_days_hint')}>
            <Input type="number" value={form.expiryDays} onChange={(event) => setForm({ ...form, expiryDays: event.target.value })} />
          </Field>
          <Field label={t('clouddrive.share.password_label')} hint={t('clouddrive.share.edit_password_hint')}>
            <Input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </Field>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label={t('clouddrive.share.max_views')}><Input type="number" value={form.maxViews} onChange={(event) => setForm({ ...form, maxViews: event.target.value })} /></Field>
            <Field label={t('clouddrive.share.max_downloads')}><Input type="number" value={form.maxDownloads} onChange={(event) => setForm({ ...form, maxDownloads: event.target.value })} /></Field>
          </div>
          <label className="flex items-center gap-2 text-[length:var(--text-12)]">
            <Switch checked={form.allowDownload} onChange={(value) => setForm({ ...form, allowDownload: value })} label={t('clouddrive.share.allow_download')} />{t('clouddrive.share.allow_download')}
          </label>
          <label className="flex items-center gap-2 text-[length:var(--text-12)]">
            <Switch checked={form.isEnabled} onChange={(value) => setForm({ ...form, isEnabled: value })} label={t('clouddrive.share.enabled')} />{t('clouddrive.share.enabled')}
          </label>
        </div>
      </Modal>

      <Modal open={qr !== null} onClose={() => setQr(null)} title={t('clouddrive.share.qr')} width={320}>
        {qr && <div className="flex flex-col items-center gap-3"><QRCodeSVG value={new URL(qr.url, window.location.origin).toString()} size={220} /><span className="max-w-full truncate text-[length:var(--text-10)] text-[var(--text-tertiary)]">{qr.name}</span></div>}
      </Modal>
    </div>
  )
}
