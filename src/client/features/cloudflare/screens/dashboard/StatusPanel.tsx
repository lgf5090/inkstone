/**
 * The public Cloudflare service status (cloudflarestatus.com), which needs no reader credential.
 *
 * The panel lists only components that are not operational and unresolved incidents: a healthy
 * status page with hundreds of green components is not a useful card. The whole feed is cached by the
 * worker for five minutes, so opening the dashboard repeatedly does not hammer the public endpoint.
 */
import { useEffect, useState } from 'react'
import { LoadingBlock } from '../../../../components/feedback'
import { Badge } from '../../../../components/primitives'
import { cfErrorText } from '../../api/client'
import { getCloudflareStatus, type CloudflareStatusSummary } from '../../api/dashboard'
import { useCfT } from '../../i18n'
import { Panel, PanelEmpty, PanelError } from './Panel'

function toneForIndicator(indicator: string): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (indicator) {
    case 'none': return 'success'
    case 'minor': return 'warning'
    case 'major':
    case 'critical':
      return 'danger'
    default: return 'neutral'
  }
}

export function StatusPanel() {
  const tcf = useCfT()
  const [data, setData] = useState<CloudflareStatusSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void getCloudflareStatus()
      .then((body) => {
        if (!cancelled) setData(body)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(cfErrorText(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [reload])

  return (
    <Panel
      title={(
        <span className="flex items-center gap-2">
          {tcf('cloudflare.dashboard.service_status')}
          {data ? <Badge tone={toneForIndicator(data.indicator)}>{data.description}</Badge> : null}
        </span>
      )}
      bodyClassName="space-y-2"
    >
      {error ? <PanelError message={error} onRetry={() => setReload((value) => value + 1)} /> : null}
      {loading && !data ? (
        <LoadingBlock />
      ) : !data ? null : data.components.length === 0 && data.incidents.length === 0 ? (
        <PanelEmpty>{tcf('cloudflare.dashboard.all_operational')}</PanelEmpty>
      ) : (
        <div className="space-y-2">
          {data.incidents.map((incident) => (
            <div
              key={incident.id}
              className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2"
            >
              <p className="text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{incident.name}</p>
              <p className="mt-0.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                {incident.status} · {incident.impact}
              </p>
            </div>
          ))}
          {data.components.map((component) => (
            <div
              key={component.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-2"
            >
              <span className="min-w-0 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">
                {component.name}
              </span>
              <Badge tone={component.status === 'operational' ? 'success' : 'warning'}>{component.status}</Badge>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
