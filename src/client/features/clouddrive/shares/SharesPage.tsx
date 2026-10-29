import { useEffect, useState } from 'react'
import { ExternalLink, Link2, QrCode, RefreshCw, Trash2 } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { useUi } from '../../../store/ui'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { confirm, Modal } from '../../../components/overlay'
import { clouddriveApi } from '../api'

interface Share {
  slug: string
  url: string
  targetKind: 'file' | 'folder'
  name: string
  hasPassword: boolean
  expiresAt: number | null
  views: number
  downloads: number
  isEnabled: boolean
  revokedAt: number | null
  createdAt: number
}

export function SharesPage() {
  const toast = useUi((state) => state.toast)
  const [shares, setShares] = useState<Share[]>([])
  const [loading, setLoading] = useState(true)
  const [qr, setQr] = useState<Share | null>(null)

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
  useEffect(() => { void load() }, [])

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('clouddrive.share.title')}</h1>
        <Button className="ml-auto" size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={13} /> {t('clouddrive.toolbar.refresh')}</Button>
      </div>
      {loading ? <div className="flex h-32 items-center justify-center"><Spinner /></div> : shares.length === 0 ? (
        <p className="py-10 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.share.no_shares')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shares.map((share) => (
            <li key={share.slug} className="flex min-w-0 flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
              <Link2 size={14} className="text-[var(--text-tertiary)]" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{share.name}</span>
              <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{share.targetKind === 'folder' ? t('clouddrive.share.kind_folder') : t('clouddrive.share.kind_file')}{share.hasPassword ? ' · ••••' : ''}</span>
              <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('clouddrive.share.views', { count: share.views })} · {t('clouddrive.share.downloads', { count: share.downloads })}</span>
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
      <Modal open={qr !== null} onClose={() => setQr(null)} title={t('clouddrive.share.qr')} width={320}>
        {qr && <div className="flex flex-col items-center gap-3"><QRCodeSVG value={new URL(qr.url, window.location.origin).toString()} size={220} /><span className="max-w-full truncate text-[length:var(--text-10)] text-[var(--text-tertiary)]">{qr.name}</span></div>}
      </Modal>
    </div>
  )
}
