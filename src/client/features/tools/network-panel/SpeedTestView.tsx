/**
 * The speed screen.
 *
 * One measurement at a time, drawn as the three numbers the reference panel showed — bytes moved,
 * speed, bandwidth — plus the same controls around them: a node list, a thread slider, two ceilings,
 * the live chart and the full-screen clock. Nothing here invents its data: every number is read from
 * the response stream the worker generates.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  CalendarClock,
  Copy,
  Download,
  LineChart as LineChartIcon,
  Link2,
  Maximize2,
  Play,
  Settings2,
  Square,
  X,
} from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import type { ChartConfiguration } from 'chart.js'
import {
  DOWNLOAD_PATH,
  NETWORK_PANEL_LIMITS,
  type StopReason,
} from '@shared/tools/network-panel/types'
import {
  formatBandwidth,
  formatBytes,
  formatDuration,
  formatSpeed,
  predictUsage,
} from '@shared/tools/network-panel/engine'
import { Button, IconButton, SectionLabel } from '../../../components/primitives'
import { Slider, Switch } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { Tooltip } from '../../../components/overlay'
import { ChartCanvas, withAlpha, type ChartColors } from '../../../components/chart-canvas'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { useNetworkPanelStore } from './store'
import type { SpeedEngineError } from './speed-engine'
import { CapDialog } from './components/CapDialog'
import { NodeManagerModal } from './components/NodeManagerModal'
import { FullscreenScreen } from './FullscreenScreen'

const ERROR_KEY: Record<SpeedEngineError, MessageKey> = {
  fetch_failed: 'tools.network_panel.error.fetch_failed',
  empty_response: 'tools.network_panel.error.empty_response',
  http_error: 'tools.network_panel.error.http_error',
}

const REASON_KEY: Record<StopReason, MessageKey> = {
  manual: 'tools.network_panel.reason.manual',
  data_cap: 'tools.network_panel.reason.data_cap',
  hidden: 'tools.network_panel.reason.hidden',
  failed: 'tools.network_panel.reason.failed',
}

export function SpeedTestView() {
  const settings = useNetworkPanelStore((s) => s.settings)
  const nodes = useNetworkPanelStore((s) => s.nodes)
  const loaded = useNetworkPanelStore((s) => s.loaded)
  const runtime = useNetworkPanelStore((s) => s.runtime)
  const start = useNetworkPanelStore((s) => s.start)
  const stop = useNetworkPanelStore((s) => s.stop)
  const updateSettings = useNetworkPanelStore((s) => s.updateSettings)
  const setThreads = useNetworkPanelStore((s) => s.setThreads)
  const selectNode = useNetworkPanelStore((s) => s.selectNode)
  const clearError = useNetworkPanelStore((s) => s.clearError)
  const [nodesOpen, setNodesOpen] = useState(false)
  const [capKind, setCapKind] = useState<'data' | 'speed' | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [predictionOpen, setPredictionOpen] = useState(false)
  const closeFullscreen = useCallback(() => setFullscreen(false), [])
  const chartSection = useRef<HTMLElement>(null)

  const builtinLabel = t('tools.network_panel.node.builtin')
  const selected = settings.nodeId !== 'builtin'
    ? nodes.find((node) => node.id === settings.nodeId) ?? null
    : null
  const nodeUrl = selected ? selected.url : DOWNLOAD_PATH
  const nodeLabel = selected ? selected.label : builtinLabel

  const options = useMemo(
    () => [
      { value: 'builtin', label: builtinLabel },
      ...nodes.map((node) => ({ value: node.id, label: node.label })),
    ],
    [nodes, builtinLabel],
  )

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(new URL(nodeUrl, location.origin).toString())
      useUi.getState().toast({ title: t('tools.network_panel.node.copied'), tone: 'success' })
    } catch {
      useUi.getState().toast({ title: t('tools.network_panel.node.copy_failed'), tone: 'danger' })
    }
  }

  const exportChart = () => {
    const canvas = chartSection.current?.querySelector('canvas')
    if (!canvas) {
      useUi.getState().toast({ title: t('tools.network_panel.chart.export_failed'), tone: 'danger' })
      return
    }
    try {
      const link = document.createElement('a')
      link.download = `network-panel-${Date.now()}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch {
      useUi.getState().toast({ title: t('tools.network_panel.chart.export_failed'), tone: 'danger' })
    }
  }

  const chartBuild = useMemo(() => {
    const labels = runtime.series.map((point) => new Date(point.t * 1000).toLocaleTimeString())
    const values = runtime.series.map((point) => point.v)
    return (colors: ChartColors): ChartConfiguration<'line'> => ({
      type: 'line' as const,
      data: {
        labels,
        datasets: [
          {
            label: t('tools.network_panel.chart.series'),
            data: values,
            borderColor: colors.palette[0],
            backgroundColor: withAlpha(colors.palette[0] ?? '#888888', 0.14),
            borderWidth: 1.5,
            pointRadius: 0,
            fill: true,
            tension: 0.25,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { intersect: false, mode: 'index' as const },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => formatSpeed(Number(item.parsed.y ?? 0)),
            },
          },
        },
        scales: {
          x: {
            ticks: { maxTicksLimit: 8, color: colors.text },
            grid: { color: colors.grid },
          },
          y: {
            beginAtZero: true,
            ticks: {
              color: colors.text,
              callback: (value: string | number) => formatSpeed(Number(value)),
            },
            grid: { color: colors.grid },
          },
        },
      },
    })
  }, [runtime.series])

  const prediction = predictUsage(runtime.speedBps)
  const predictionRows = [
    { label: t('tools.network_panel.predict.minute'), value: formatBytes(prediction.minute) },
    { label: t('tools.network_panel.predict.hour'), value: formatBytes(prediction.hour) },
    { label: t('tools.network_panel.predict.day'), value: formatBytes(prediction.day) },
    { label: t('tools.network_panel.predict.month'), value: formatBytes(prediction.month) },
  ]

  const statusText = runtime.running
    ? t('tools.network_panel.state.running')
    : runtime.stopReason
      ? t(REASON_KEY[runtime.stopReason])
      : t('tools.network_panel.state.idle')

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 overflow-y-auto p-3 sm:p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
            {t('tools.network_panel.speed.title')}
          </h2>
          <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('tools.network_panel.speed.desc')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip label={settings.showChart ? t('tools.network_panel.chart.hide') : t('tools.network_panel.chart.show')}>
            <IconButton
              label={settings.showChart ? t('tools.network_panel.chart.hide') : t('tools.network_panel.chart.show')}
              size="sm"
              active={settings.showChart}
              onClick={() => updateSettings({ showChart: !settings.showChart })}
            >
              <LineChartIcon size={15} />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('tools.network_panel.fullscreen.open')}>
            <IconButton
              label={t('tools.network_panel.fullscreen.open')}
              size="sm"
              onClick={() => setFullscreen(true)}
            >
              <Maximize2 size={15} />
            </IconButton>
          </Tooltip>
        </div>
      </header>

      <section className="space-y-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
        <div className="space-y-1.5">
          <SectionLabel>{t('tools.network_panel.node.label')}</SectionLabel>
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <SelectMenu
                label={t('tools.network_panel.node.label')}
                value={selected ? selected.id : 'builtin'}
                options={options}
                onChange={selectNode}
              />
            </div>
            <Tooltip label={t('tools.network_panel.node.copy')}>
              <IconButton label={t('tools.network_panel.node.copy')} size="sm" onClick={() => { void copyUrl() }}>
                <Copy size={14} />
              </IconButton>
            </Tooltip>
            <Tooltip label={t('tools.network_panel.nodes.title')}>
              <IconButton
                label={t('tools.network_panel.nodes.title')}
                size="sm"
                onClick={() => setNodesOpen(true)}
              >
                <Settings2 size={14} />
              </IconButton>
            </Tooltip>
          </div>
          <p className="truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]" title={nodeUrl}>
            {nodeLabel} · {nodeUrl}
          </p>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <SectionLabel>{t('tools.network_panel.threads')}</SectionLabel>
            <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)]">
              {settings.threads} / {NETWORK_PANEL_LIMITS.maxThreads}
            </span>
          </div>
          <Slider
            label={t('tools.network_panel.threads')}
            value={settings.threads}
            min={NETWORK_PANEL_LIMITS.minThreads}
            max={NETWORK_PANEL_LIMITS.maxThreads}
            onChange={setThreads}
          />
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {t('tools.network_panel.auto_start')}
            </span>
            <Switch
              checked={settings.autoStart}
              label={t('tools.network_panel.auto_start')}
              onChange={(next) => updateSettings({ autoStart: next })}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {t('tools.network_panel.background')}
            </span>
            <Switch
              checked={settings.background}
              label={t('tools.network_panel.background')}
              onChange={(next) => updateSettings({ background: next })}
            />
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <MetricCard
          label={t('tools.network_panel.metric.total')}
          value={formatBytes(runtime.bytesUsed)}
          cap={settings.maxDataBytes > 0 ? formatBytes(settings.maxDataBytes) : null}
          action={
            <Tooltip label={t('tools.network_panel.cap.data_title')}>
              <IconButton
                label={t('tools.network_panel.cap.data_title')}
                size="xs"
                onClick={() => setCapKind('data')}
              >
                <Settings2 size={13} />
              </IconButton>
            </Tooltip>
          }
        />
        <MetricCard
          label={runtime.running
            ? t('tools.network_panel.metric.speed_live')
            : t('tools.network_panel.metric.speed_average')}
          value={runtime.speedBps > 0 ? formatSpeed(runtime.speedBps) : '—'}
          accent
          action={
            <Tooltip label={t('tools.network_panel.predict.label')}>
              <IconButton
                label={t('tools.network_panel.predict.label')}
                size="xs"
                active={predictionOpen}
                aria-expanded={predictionOpen}
                aria-controls="network-panel-prediction"
                onClick={() => setPredictionOpen((open) => !open)}
              >
                <CalendarClock size={13} />
              </IconButton>
            </Tooltip>
          }
        />
        <MetricCard
          label={t('tools.network_panel.metric.bandwidth')}
          value={runtime.speedBps > 0 ? formatBandwidth(runtime.speedBps) : '—'}
          cap={settings.maxSpeedBps > 0 ? formatBandwidth(settings.maxSpeedBps) : null}
          action={
            <Tooltip label={t('tools.network_panel.cap.speed_title')}>
              <IconButton
                label={t('tools.network_panel.cap.speed_title')}
                size="xs"
                onClick={() => setCapKind('speed')}
              >
                <Settings2 size={13} />
              </IconButton>
            </Tooltip>
          }
        />
      </section>

      {predictionOpen && (
        <section
          id="network-panel-prediction"
          aria-label={t('tools.network_panel.predict.label')}
          className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3"
        >
          <h3 className="mb-1.5 text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
            {t('tools.network_panel.predict.label')}
          </h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
            {predictionRows.map((row) => (
              <div key={row.label} className="min-w-0">
                <dt className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{row.label}</dt>
                <dd className="truncate text-[length:var(--text-13)] font-medium tabular-nums text-[var(--text-primary)]">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {runtime.error && (
        <div role="alert" className="flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-3 text-[length:var(--text-12)] text-[var(--danger)]">
          <p className="min-w-0 flex-1">{t(ERROR_KEY[runtime.error])}</p>
          <Tooltip label={t('tools.network_panel.error.dismiss')} side="left">
            <IconButton label={t('tools.network_panel.error.dismiss')} size="xs" onClick={clearError}>
              <X size={12} />
            </IconButton>
          </Tooltip>
        </div>
      )}

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            <span
              aria-hidden="true"
              className={cn(
                'inline-block size-1.5 shrink-0 rounded-full',
                runtime.running ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]',
              )}
            />
            {statusText}
          </p>
          <p className="mt-0.5 text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)]">
            {t('tools.network_panel.state.elapsed')} {formatDuration(runtime.elapsedMs)}
            {runtime.bytesUsed > 0 && ` · ${formatBytes(runtime.bytesUsed)}`}
          </p>
        </div>
        <Button
          variant={runtime.running ? 'danger' : 'primary'}
          size="lg"
          disabled={!loaded}
          icon={runtime.running ? <Square size={14} /> : <Play size={14} />}
          onClick={runtime.running ? () => stop('manual') : start}
        >
          {runtime.running ? t('tools.network_panel.stop') : t('tools.network_panel.start')}
        </Button>
      </section>

      {settings.showChart && (
        <section ref={chartSection} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
              {t('tools.network_panel.chart.title')}
            </h3>
            <div className="flex items-center gap-1.5">
              <span className="flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                <Link2 size={12} aria-hidden="true" />
                {t('tools.network_panel.chart.source')}
              </span>
              {runtime.series.length > 1 && (
                <Tooltip label={t('tools.network_panel.chart.export')} side="left">
                  <IconButton
                    label={t('tools.network_panel.chart.export')}
                    size="xs"
                    onClick={exportChart}
                  >
                    <Download size={12} />
                  </IconButton>
                </Tooltip>
              )}
            </div>
          </div>
          {runtime.series.length > 1 ? (
            <ChartCanvas
              height="h-[220px]"
              label={t('tools.network_panel.chart.label')}
              build={chartBuild}
            />
          ) : (
            <p className="grid h-[220px] place-items-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('tools.network_panel.chart.empty')}
            </p>
          )}
        </section>
      )}

      <NodeManagerModal open={nodesOpen} onClose={() => setNodesOpen(false)} />
      <CapDialog
        open={capKind !== null}
        kind={capKind ?? 'data'}
        value={capKind === 'speed' ? settings.maxSpeedBps : settings.maxDataBytes}
        onClose={() => setCapKind(null)}
        onApply={(value) => updateSettings(capKind === 'speed' ? { maxSpeedBps: value } : { maxDataBytes: value })}
      />
      <FullscreenScreen open={fullscreen} onClose={closeFullscreen} />
    </div>
  )
}

function MetricCard({
  label,
  value,
  cap,
  action,
  accent,
}: {
  label: string
  value: string
  cap?: string | null
  action?: ReactNode
  accent?: boolean
}) {
  return (
    <div className="min-w-0 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{label}</span>
        {action}
      </div>
      <div className="mt-1 flex min-w-0 items-baseline gap-1">
        <span
          className={cn(
            'truncate text-[length:var(--text-22)] font-semibold tabular-nums tracking-[-0.01em]',
            accent ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]',
          )}
        >
          {value}
        </span>
        {cap && (
          <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            / {cap}
          </span>
        )}
      </div>
    </div>
  )
}
