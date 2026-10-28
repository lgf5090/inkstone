import { AlertTriangle, Download, RefreshCw } from 'lucide-react'
import { stateDataOf } from '@shared/development/api-tester/state'
import { t } from '../../../../lib/i18n'
import { Button } from '../../../../components/primitives'
import { useApiTesterStore } from '../store'

export function ConflictBanner() {
  const conflict = useApiTesterStore((s) => s.conflict)
  const reload = useApiTesterStore((s) => s.dismissConflict)
  const state = useApiTesterStore((s) => s.state)
  if (!conflict) return null
  const download = () => {
    const blob = new Blob([JSON.stringify(stateDataOf(state), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `api-tester-local-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--warning)]/40 bg-[var(--warning-softer)] px-3 py-2 text-[length:var(--text-12)]">
      <AlertTriangle size={15} className="shrink-0 text-[var(--warning)]" />
      <span className="font-medium text-[var(--text-primary)]">{t('development.apitester.app.conflict_title')}</span>
      <span className="min-w-0 flex-1 text-[var(--text-secondary)]">{t('development.apitester.app.conflict_hint')}</span>
      <Button size="sm" variant="secondary" onClick={reload} className="gap-1">
        <RefreshCw size={13} /> {t('development.apitester.app.reload_server')}
      </Button>
      <Button size="sm" variant="ghost" onClick={download} className="gap-1">
        <Download size={13} /> {t('development.apitester.app.download_local')}
      </Button>
    </div>
  )
}
