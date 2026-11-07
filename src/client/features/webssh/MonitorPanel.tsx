import { useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import type {
  WebsshMonitorContainers,
  WebsshMonitorNetworkInterface,
  WebsshMonitorProcess,
  WebsshMonitorProcesses,
  WebsshMonitorResources,
  WebsshMonitorSnapshot,
} from '@shared/webssh/types'
import { IconButton } from '../../components/primitives'
import { Segmented } from '../../components/form'
import { Empty } from '../../components/feedback'
import { Tabs } from '../../components/tabs'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import type { MessageKey } from '@shared/locales/en-US'
import type { MonitorHistoryEntry } from './monitor-data'
import { formatBytes, formatRate, formatUptime, useMonitorSnapshot, useProcessKill } from './monitor-data'

const PANEL_ID = 'webssh-monitor'
const TAB_IDS = ['resources', 'network', 'processes', 'containers'] as const
type MonitorTab = typeof TAB_IDS[number]
const TAB_LABELS: Readonly<Record<MonitorTab, MessageKey>> = {
  resources: 'webssh.monitor.tab_resources',
  network: 'webssh.monitor.tab_network',
  processes: 'webssh.monitor.tab_processes',
  containers: 'webssh.monitor.tab_containers',
}

function Meter({ label, percent, detail }: { label: string; percent: number | null; detail: string }) {
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent))
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{label}</span>
        <span className="font-mono text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{detail}</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value)}
        aria-valuetext={`${label} ${percent === null ? '—' : `${Math.round(value)}%`}`}
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--bg-inset)]"
      >
        <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${value}%` }} />
      </div>
    </div>
  )
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2.5 py-1.5">
      <div className="text-[length:var(--text-10-5)] uppercase tracking-wide text-[var(--text-quaternary)]">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[length:var(--text-12-5)] text-[var(--text-primary)]" title={value}>{value}</div>
    </div>
  )
}

export function ResourcesView({ snapshot }: { snapshot: WebsshMonitorSnapshot }) {
  const resources: WebsshMonitorResources = snapshot.resources
  const memory = resources.memory
  const memoryPercent = memory.totalBytes && memory.usedBytes ? (memory.usedBytes / memory.totalBytes) * 100 : null
  const swapPercent = memory.swapTotalBytes && memory.swapUsedBytes ? (memory.swapUsedBytes / memory.swapTotalBytes) * 100 : null
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <StatCell label={t('webssh.monitor.os')} value={resources.os.pretty || resources.os.system || '—'} />
        <StatCell label={t('webssh.monitor.kernel')} value={[resources.os.system, resources.os.release].filter(Boolean).join(' ') || '—'} />
        <StatCell label={t('webssh.monitor.arch')} value={resources.os.arch || '—'} />
        <StatCell label={t('webssh.monitor.uptime')} value={formatUptime(resources.uptimeSeconds)} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map((index) => (
          <StatCell
            key={index}
            label={t('webssh.monitor.load_short', { minutes: [1, 5, 15][index] })}
            value={resources.load ? resources.load[index].toFixed(2) : '—'}
          />
        ))}
      </div>
      <div className="space-y-2.5 rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-2.5">
        <Meter
          label={t('webssh.monitor.cpu')}
          percent={resources.cpuPercent}
          detail={resources.cpuPercent === null ? '—' : `${resources.cpuPercent.toFixed(1)}%`}
        />
        <Meter
          label={t('webssh.monitor.memory')}
          percent={memoryPercent}
          detail={memory.totalBytes === null ? '—' : `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`}
        />
        {memory.swapTotalBytes !== null && (
          <Meter
            label={t('webssh.monitor.swap')}
            percent={swapPercent}
            detail={`${formatBytes(memory.swapUsedBytes)} / ${formatBytes(memory.swapTotalBytes)}`}
          />
        )}
      </div>
      <div>
        <h3 className="mb-1.5 text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('webssh.monitor.disks')}</h3>
        {resources.disks.length === 0 ? (
          <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.monitor.no_data')}</p>
        ) : (
          <ul className="space-y-2">
            {resources.disks.map((disk) => (
              <li key={disk.mount} className="min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-mono text-[length:var(--text-11-5)] text-[var(--text-secondary)]" title={disk.mount}>{disk.mount}</span>
                  <span className="shrink-0 font-mono text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                    {formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)}
                  </span>
                </div>
                <Meter
                  label={disk.mount}
                  percent={disk.usedPercent}
                  detail={disk.usedPercent === null ? '—' : `${disk.usedPercent.toFixed(1)}%`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function BandwidthChart({ history }: { history: MonitorHistoryEntry[] }) {
  if (history.length < 2) {
    return <div className="flex h-28 items-center justify-center text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.monitor.chart_waiting')}</div>
  }
  const width = 600
  const height = 112
  const padding = 6
  const peak = Math.max(1, ...history.map((entry) => Math.max(entry.rx, entry.tx)))
  const xFor = (index: number) => padding + (index * (width - padding * 2)) / Math.max(1, history.length - 1)
  const yFor = (value: number) => height - padding - (value / peak) * (height - padding * 2)
  const line = (key: 'rx' | 'tx') => history.map((entry, index) => `${xFor(index).toFixed(1)},${yFor(entry[key]).toFixed(1)}`).join(' ')
  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('webssh.monitor.chart_label')}
        className="h-28 w-full"
        preserveAspectRatio="none"
      >
        <polyline points={line('rx')} fill="none" stroke="var(--accent)" strokeWidth={1.6} />
        <polyline points={line('tx')} fill="none" stroke="var(--warning)" strokeWidth={1.6} />
      </svg>
      <div className="mt-1 flex items-center gap-3 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="size-2 rounded-full bg-[var(--accent)]" />{t('webssh.monitor.rx')}</span>
        <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="size-2 rounded-full bg-[var(--warning)]" />{t('webssh.monitor.tx')}</span>
        <span className="ms-auto font-mono">{t('webssh.monitor.peak', { value: formatRate(peak) })}</span>
      </div>
    </div>
  )
}

function InterfaceRows({ items }: { items: WebsshMonitorNetworkInterface[] }) {
  if (items.length === 0) return <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.monitor.no_data')}</p>
  return (
    <table className="w-full table-auto text-[length:var(--text-11-5)]">
      <thead className="text-[var(--text-quaternary)]">
        <tr>
          <th className="py-1 text-start font-medium">{t('webssh.monitor.interface')}</th>
          <th className="py-1 text-end font-medium">{t('webssh.monitor.rx')}</th>
          <th className="py-1 text-end font-medium">{t('webssh.monitor.tx')}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.name} className="border-t border-[var(--border-subtle)]">
            <td className="max-w-[120px] truncate py-1 font-mono text-[var(--text-secondary)]" title={item.name}>{item.name}</td>
            <td className="py-1 text-end font-mono text-[var(--text-primary)]">{formatRate(item.rx)}</td>
            <td className="py-1 text-end font-mono text-[var(--text-primary)]">{formatRate(item.tx)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function NetworkView({ snapshot, history }: { snapshot: WebsshMonitorSnapshot; history: MonitorHistoryEntry[] }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <StatCell label={t('webssh.monitor.total_rx')} value={formatRate(snapshot.network.total.rx)} />
        <StatCell label={t('webssh.monitor.total_tx')} value={formatRate(snapshot.network.total.tx)} />
        <StatCell label={t('webssh.monitor.rx_total')} value={formatBytes(snapshot.network.total.rxBytes)} />
        <StatCell label={t('webssh.monitor.tx_total')} value={formatBytes(snapshot.network.total.txBytes)} />
      </div>
      <BandwidthChart history={history} />
      <InterfaceRows items={snapshot.network.interfaces} />
    </div>
  )
}

const PROCESS_COLUMNS: ReadonlyArray<{ key: MessageKey; className: string }> = [
  { key: 'webssh.monitor.process_pid', className: 'w-[52px]' },
  { key: 'webssh.monitor.process_user', className: 'w-[84px]' },
  { key: 'webssh.monitor.process_cpu', className: 'w-[52px] text-end' },
  { key: 'webssh.monitor.process_mem', className: 'w-[52px] text-end' },
  { key: 'webssh.monitor.process_rss', className: 'w-[64px] text-end' },
  { key: 'webssh.monitor.process_state', className: 'w-[44px]' },
  { key: 'webssh.monitor.process_command', className: 'min-w-[160px]' },
]

function ProcessTable({
  processes,
  onKill,
}: {
  processes: WebsshMonitorProcess[]
  onKill?: (process: WebsshMonitorProcess) => void
}) {
  if (processes.length === 0) return <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.monitor.no_processes')}</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-[600px] table-fixed text-[length:var(--text-11-5)] [&_td]:px-1 [&_th]:px-1">
        <thead className="text-[var(--text-quaternary)]">
          <tr>
            {PROCESS_COLUMNS.map((column) => (
              <th key={column.key} className={cn('whitespace-nowrap py-1 font-medium', column.className)}>
                {t(column.key)}
              </th>
            ))}
            {onKill && <th className="w-[40px] py-1 text-end font-medium">{t('webssh.monitor.process_action')}</th>}
          </tr>
        </thead>
        <tbody>
          {processes.map((process) => (
            <tr key={`${process.pid}-${process.user}`} className="border-t border-[var(--border-subtle)]">
              <td className="py-1 font-mono text-[var(--text-primary)]">{process.pid}</td>
              <td className="truncate py-1 text-[var(--text-secondary)]" title={process.user}>{process.user}</td>
              <td className="py-1 text-end font-mono text-[var(--text-primary)]">{process.cpuPercent.toFixed(1)}</td>
              <td className="py-1 text-end font-mono text-[var(--text-primary)]">{process.memPercent.toFixed(1)}</td>
              <td className="py-1 text-end font-mono text-[var(--text-secondary)]">{formatBytes(process.rssBytes)}</td>
              <td className="py-1 font-mono text-[var(--text-tertiary)]">{process.state}</td>
              <td className="truncate py-1 font-mono text-[var(--text-secondary)]" title={process.command}>{process.command}</td>
              {onKill && (
                <td className="py-1 text-end">
                  <IconButton
                    label={t('webssh.monitor.kill_pid', { pid: process.pid })}
                    size="xs"
                    onClick={() => onKill(process)}
                  >
                    <X size={12} aria-hidden="true" />
                  </IconButton>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ProcessesView({
  processes,
  onKill,
}: {
  processes: WebsshMonitorProcesses
  onKill?: (process: WebsshMonitorProcess) => void
}) {
  const [sort, setSort] = useState<'cpu' | 'memory'>('cpu')
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.monitor.process_total', { count: processes.total })}</span>
        <Segmented
          size="sm"
          value={sort}
          label={t('webssh.monitor.process_sort')}
          options={[
            { value: 'cpu', label: t('webssh.monitor.sort_cpu') },
            { value: 'memory', label: t('webssh.monitor.sort_memory') },
          ]}
          onChange={setSort}
        />
      </div>
      <ProcessTable processes={sort === 'cpu' ? processes.byCpu : processes.byMemory} onKill={onKill} />
      {processes.truncated && <p className="text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{t('webssh.monitor.process_truncated')}</p>}
    </div>
  )
}

export function ContainersView({ containers }: { containers: WebsshMonitorContainers }) {
  if (!containers.available) {
    return <Empty art="search" compact title={t('webssh.monitor.docker_missing_title')} description={t('webssh.monitor.docker_missing_description')} />
  }
  if (containers.items.length === 0) {
    return <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.monitor.no_containers')}</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-[600px] table-fixed text-[length:var(--text-11-5)] [&_td]:px-1 [&_th]:px-1">
        <thead className="text-[var(--text-quaternary)]">
          <tr>
            <th className="whitespace-nowrap py-1 text-start font-medium">{t('webssh.monitor.container_name')}</th>
            <th className="whitespace-nowrap py-1 text-start font-medium">{t('webssh.monitor.container_image')}</th>
            <th className="whitespace-nowrap py-1 text-start font-medium">{t('webssh.monitor.container_state')}</th>
            <th className="whitespace-nowrap py-1 text-end font-medium">{t('webssh.monitor.container_cpu')}</th>
            <th className="whitespace-nowrap py-1 text-end font-medium">{t('webssh.monitor.container_memory')}</th>
            <th className="whitespace-nowrap py-1 text-end font-medium">{t('webssh.monitor.container_network')}</th>
          </tr>
        </thead>
        <tbody>
          {containers.items.map((item) => (
            <tr key={item.id} className="border-t border-[var(--border-subtle)]">
              <td className="max-w-[110px] truncate py-1 text-[var(--text-primary)]" title={item.name}>{item.name}</td>
              <td className="max-w-[120px] truncate py-1 font-mono text-[var(--text-secondary)]" title={item.image}>{item.image}</td>
              <td className="max-w-[110px] truncate py-1 text-[var(--text-tertiary)]" title={item.status}>{item.status || item.state}</td>
              <td className="py-1 text-end font-mono text-[var(--text-primary)]">{item.cpuPercent === null ? '—' : `${item.cpuPercent.toFixed(1)}%`}</td>
              <td className="py-1 text-end font-mono text-[var(--text-secondary)]">{item.memoryUsage || '—'}</td>
              <td className="py-1 text-end font-mono text-[var(--text-secondary)]">{item.networkIo || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {containers.truncated && <p className="mt-1 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{t('webssh.monitor.container_truncated')}</p>}
    </div>
  )
}

export function MonitorPanel({
  sessionId,
  onClose,
}: {
  sessionId: string | null
  onClose: () => void
}) {
  const [tab, setTab] = useState<MonitorTab>('resources')
  const data = useMonitorSnapshot(sessionId, Boolean(sessionId))
  const kill = useProcessKill(sessionId, data.refresh)
  const snapshot = data.snapshot
  return (
    <aside
      aria-label={t('webssh.monitor.title')}
      className="flex h-full min-h-0 w-full shrink-0 flex-col border-s border-[var(--border-subtle)] bg-[var(--bg-surface)] md:w-[420px]"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2 py-1.5">
        <Tabs
          value={tab}
          onChange={setTab}
          label={t('webssh.monitor.title')}
          panelId={PANEL_ID}
          items={TAB_IDS.map((id) => ({ id, label: t(TAB_LABELS[id]) }))}
        />
        <div className="ms-auto flex shrink-0 items-center gap-0.5">
          <IconButton label={t('webssh.monitor.refresh')} size="sm" onClick={data.refresh} disabled={!sessionId || data.loading}>
            <RefreshCw size={14} aria-hidden="true" />
          </IconButton>
          <IconButton label={t('webssh.actions.close')} size="sm" onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <div id={PANEL_ID} role="tabpanel" className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {!sessionId ? (
          <Empty art="select" compact title={t('webssh.monitor.need_session_title')} description={t('webssh.monitor.need_session_description')} />
        ) : data.error ? (
          <div className="rounded-[var(--r-sm)] border border-[var(--danger)] bg-[var(--bg-sunken)] p-2 text-[length:var(--text-11-5)] text-[var(--danger)]">
            {data.error}
          </div>
        ) : !snapshot ? (
          <p className="p-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.monitor.loading')}</p>
        ) : tab === 'resources' ? (
          <ResourcesView snapshot={snapshot} />
        ) : tab === 'network' ? (
          <NetworkView snapshot={snapshot} history={data.history} />
        ) : tab === 'processes' ? (
          <ProcessesView processes={snapshot.processes} onKill={kill} />
        ) : (
          <ContainersView containers={snapshot.containers} />
        )}
      </div>
    </aside>
  )
}
