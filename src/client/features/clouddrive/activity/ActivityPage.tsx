import { useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Button, Spinner } from '../../../components/primitives'
import { clouddriveApi, type CloudDriveActivity } from '../api'

export function ActivityPage() {
  const [items, setItems] = useState<CloudDriveActivity[]>([])
  const [alerts, setAlerts] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [onlyAlerts, setOnlyAlerts] = useState(false)

  const load = async () => {
    setStatus('loading')
    setError('')
    try {
      const result = await clouddriveApi.activities(onlyAlerts)
      setItems(result.activities.map((item) => ({
        id: item.id, action: item.action, targetPath: item.target_path,
        severity: item.severity, detail: item.detail, createdAt: item.created_at,
      })))
      setAlerts(result.alerts)
      setStatus('ready')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setStatus('error')
    }
  }
  useEffect(() => { void load() }, [onlyAlerts])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('clouddrive.activity.title')}</h1>
          <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('clouddrive.activity.description')}</p>
        </div>
        <Button size="sm" variant={onlyAlerts ? 'primary' : 'secondary'} onClick={() => setOnlyAlerts((value) => !value)}>
          <AlertTriangle size={13} /> {t('clouddrive.activity.alerts', { count: alerts })}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={13} /> {t('clouddrive.toolbar.refresh')}</Button>
      </div>
      {status === 'loading' && <div className="flex h-32 items-center justify-center"><Spinner /></div>}
      {status === 'error' && <div role="alert" className="p-6 text-center"><p className="text-[var(--danger)]">{error}</p><Button className="mt-3" onClick={() => void load()}>{t('clouddrive.retry')}</Button></div>}
      {status === 'ready' && items.length === 0 && <p className="rounded-[var(--r-lg)] border border-dashed border-[var(--border-subtle)] p-8 text-center text-[var(--text-tertiary)]">{t('clouddrive.activity.empty')}</p>}
      {status === 'ready' && items.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
              <span className={item.severity === 'warning' ? 'text-[var(--warning)]' : 'text-[var(--accent)]'}>{item.action}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-11)]">{item.targetPath}</span>
              {item.detail && <span className="text-[var(--text-11)] text-[var(--text-tertiary)]">{item.detail}</span>}
              <time className="text-[var(--text-10)] text-[var(--text-tertiary)]" dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
