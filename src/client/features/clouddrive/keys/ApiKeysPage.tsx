import { useEffect, useState } from 'react'
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { useUi } from '../../../store/ui'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { Field, Input } from '../../../components/form'
import { confirm, Modal } from '../../../components/overlay'
import { clouddriveApi } from '../api'

interface ApiKey { id: string; name: string; prefix: string; scopes: string[]; pathPrefix: string; expiresAt: number | null; lastUsedAt: number | null; createdAt: number }

export function ApiKeysPage() {
  const toast = useUi((state) => state.toast)
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['read'])
  const [days, setDays] = useState('365')
  const [token, setToken] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try { setKeys((await clouddriveApi.keys()).keys) } catch (error) { toast({ title: t('clouddrive.toast.failed'), description: String(error), tone: 'danger' }) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const create = async () => {
    try {
      const result = await clouddriveApi.createKey({ name: name.trim(), scopes, expiresAt: days === '0' ? null : Date.now() + Number(days) * 86_400_000 })
      setToken(result.token)
      setOpen(false)
      setName('')
      await load()
    } catch (error) { toast({ title: t('clouddrive.toast.failed'), description: String(error), tone: 'danger' }) }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('clouddrive.keys.title')}</h1>
        <Button className="ml-auto" size="sm" variant="primary" onClick={() => setOpen(true)}><Plus size={13} /> {t('clouddrive.keys.add')}</Button>
      </div>
      {loading ? <div className="flex h-32 items-center justify-center"><Spinner /></div> : keys.length === 0 ? <p className="py-10 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.keys.none')}</p> : (
        <ul className="flex flex-col gap-1.5">
          {keys.map((key) => (
            <li key={key.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
              <KeyRound size={14} className="text-[var(--text-tertiary)]" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{key.name}</span>
              <code className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{key.prefix}…</code>
              <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{key.scopes.join(', ')}</span>
              <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : '—'}</span>
              <IconButton label={t('clouddrive.keys.revoke')} onClick={async () => { if (!(await confirm({ title: t('clouddrive.keys.revoke'), description: key.name, tone: 'danger' }))) return; try { await clouddriveApi.revokeKey(key.id); await load() } catch (error) { toast({ title: t('clouddrive.toast.failed'), description: String(error), tone: 'danger' }) } }}><Trash2 size={13} /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={t('clouddrive.keys.add')} width={440} footer={<><Button variant="ghost" onClick={() => setOpen(false)}>{t('clouddrive.dialog.cancel')}</Button><Button variant="primary" disabled={!name.trim()} onClick={() => void create()}>{t('clouddrive.dialog.create')}</Button></>}>
        <div className="grid gap-2">
          <Field label={t('clouddrive.keys.name')}><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label={t('clouddrive.keys.scopes')}>
            <div className="flex flex-wrap gap-3 text-[length:var(--text-12)]">
              {['read', 'write', 'webdav'].map((scope) => <label key={scope} className="flex items-center gap-1.5"><input type="checkbox" checked={scopes.includes(scope)} onChange={() => setScopes(scopes.includes(scope) ? scopes.filter((item) => item !== scope) : [...scopes, scope])} />{t(`clouddrive.keys.${scope}` as Parameters<typeof t>[0])}</label>)}
            </div>
          </Field>
          <Field label={t('clouddrive.keys.expiry_days')}><Input type="number" value={days} onChange={(event) => setDays(event.target.value)} /></Field>
        </div>
      </Modal>
      <Modal open={token !== null} onClose={() => setToken(null)} title={t('clouddrive.keys.created')} width={520} footer={<Button variant="primary" onClick={() => setToken(null)}>{t('common.close')}</Button>}>
        <p className="mb-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('clouddrive.keys.token_once')}</p>
        <div className="flex items-center gap-2 rounded-[var(--r-md)] bg-[var(--bg-inset)] p-2"><code className="min-w-0 flex-1 break-all text-[length:var(--text-11)]">{token}</code><IconButton label={t('clouddrive.share.copy')} onClick={() => token && void copyText(token)}><Copy size={13} /></IconButton></div>
      </Modal>
    </div>
  )
}
