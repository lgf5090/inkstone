import { Trash2 } from 'lucide-react'
import { Modal, confirm } from '../../../../components/overlay'
import { Button, IconButton } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'
import { useApiTesterStore } from '../store'

export function CookieJarDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cookies = useApiTesterStore((s) => s.state.cookies ?? [])
  const patchState = useApiTesterStore((s) => s.patchState)

  const remove = (id: string) => {
    patchState((state) => ({ ...state, cookies: (state.cookies ?? []).filter((cookie) => cookie.id !== id) }))
  }

  const clear = async () => {
    const ok = await confirm({
      title: t('development.apitester.clear_cookies'),
      description: t('development.apitester.clear_cookies_confirm'),
      tone: 'danger',
      confirmLabel: t('common.clear'),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return
    patchState((state) => ({ ...state, cookies: [] }))
  }

  return (
    <Modal open={open} onClose={onClose} title={t('development.apitester.cookies_title')} description={t('development.apitester.cookies_desc')} width={680}>
      <div className="space-y-2">
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" className="gap-1 text-[var(--danger)]" disabled={cookies.length === 0} onClick={() => void clear()}>
            <Trash2 size={13} /> {t('development.apitester.clear_cookies')}
          </Button>
        </div>
        {cookies.length === 0 ? (
          <p className="py-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.apitester.cookie_jar_empty')}</p>
        ) : (
          <div className="max-h-[55vh] overflow-y-auto overscroll-contain">
            {cookies.map((cookie) => (
              <div key={cookie.id} className="flex items-center gap-2 border-b border-[var(--border-subtle)] py-1.5 text-[length:var(--text-11)]">
                <span className="min-w-0 flex-1 truncate font-mono">
                  <span className="text-[var(--text-secondary)]">{cookie.name}</span>
                  <span className="text-[var(--text-quaternary)]">=</span>
                  <span className="text-[var(--text-primary)]">{cookie.value}</span>
                </span>
                <span className="max-w-[220px] shrink-0 truncate font-mono text-[var(--text-tertiary)]" title={`${cookie.domain}${cookie.path}`}>
                  {cookie.domain}
                  {cookie.path}
                </span>
                <span className="w-36 shrink-0 text-right text-[var(--text-quaternary)]">
                  {cookie.expiresAt ? new Date(cookie.expiresAt).toLocaleString() : t('development.apitester.cookie_session')}
                </span>
                <IconButton label={t('development.apitester.delete')} size="sm" className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--danger)]" onClick={() => remove(cookie.id)}>
                  <Trash2 size={13} />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
