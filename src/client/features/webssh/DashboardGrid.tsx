import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Lock, Plus, Unlock, Upload, GripVertical, MoreVertical } from 'lucide-react'
import type { WebsshDashboard, WebsshDashboardExport, WebsshDashboardWidget, WebsshMonitorProcess, WebsshWidgetType } from '@shared/webssh/types'
import { WEBSSH_WIDGET_TYPES } from '@shared/webssh/types'
import type { MessageKey } from '@shared/locales/en-US'
import { Button, IconButton } from '../../components/primitives'
import { Menu, Tooltip, confirm, type MenuItem } from '../../components/overlay'
import { SelectMenu } from '../../components/select-menu'
import { Empty } from '../../components/feedback'
import { useBreakpoint } from '../../lib/hooks'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { ApiError } from '../../lib/api'
import { useUi } from '../../store/ui'
import { websshApi } from './api'
import {
  ContainersView,
  NetworkView,
  ProcessesView,
  ResourcesView,
} from './MonitorPanel'
import { useMonitorSnapshot, useProcessKill, type MonitorData } from './monitor-data'

const GRID_COLUMNS = 12
const ROW_HEIGHT = 52
const ROW_GAP = 8
const WIDGET_MIN_W = 2
const WIDGET_MIN_H = 2

const WIDGET_TITLE_KEYS: Readonly<Record<WebsshWidgetType, MessageKey>> = {
  resources: 'webssh.monitor.tab_resources',
  network: 'webssh.monitor.tab_network',
  processes: 'webssh.monitor.tab_processes',
  containers: 'webssh.monitor.tab_containers',
}

interface Gesture {
  kind: 'move' | 'resize'
  id: string
  startX: number
  startY: number
  colWidth: number
  origin: { x: number; y: number; w: number; h: number }
}

function toastError(caught: unknown): void {
  useUi.getState().toast({
    title: caught instanceof ApiError ? caught.message : t('webssh.error.generic'),
    tone: 'danger',
  })
}

function WidgetBody({
  widget,
  sessionId,
  monitor,
  onKill,
}: {
  widget: WebsshDashboardWidget
  sessionId: string | null
  monitor: MonitorData
  onKill: (process: WebsshMonitorProcess) => void
}) {
  const snapshot = monitor.snapshot
  if (!sessionId) {
    return <p className="p-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.monitor.need_session_title')}</p>
  }
  if (monitor.error) {
    return <p className="p-2 text-[length:var(--text-11-5)] text-[var(--danger)]">{monitor.error}</p>
  }
  if (!snapshot) {
    return <p className="p-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.monitor.loading')}</p>
  }
  if (widget.type === 'resources') return <ResourcesView snapshot={snapshot} />
  if (widget.type === 'network') return <NetworkView snapshot={snapshot} history={monitor.history} />
  if (widget.type === 'processes') return <ProcessesView processes={snapshot.processes} onKill={onKill} />
  return <ContainersView containers={snapshot.containers} />
}

export function DashboardGrid({ sessionId }: { sessionId: string | null }) {
  const isMobile = useBreakpoint() === 'mobile'
  const gridRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [dashboards, setDashboards] = useState<WebsshDashboard[]>([])
  const [activeId, setActiveId] = useState('')
  const [widgets, setWidgets] = useState<WebsshDashboardWidget[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [addAnchor, setAddAnchor] = useState<{ x: number; y: number } | null>(null)
  const [widgetMenu, setWidgetMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const widgetsRef = useRef<WebsshDashboardWidget[]>([])
  const activeIdRef = useRef('')
  widgetsRef.current = widgets
  activeIdRef.current = activeId
  const monitor = useMonitorSnapshot(sessionId, Boolean(sessionId))
  const kill = useProcessKill(sessionId, monitor.refresh)

  const active = dashboards.find((dashboard) => dashboard.id === activeId) ?? null

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    websshApi.listDashboards()
      .then((next) => {
        if (cancelled) return
        setDashboards(next)
        const selected = next.find((dashboard) => dashboard.id === activeIdRef.current) ?? next[0] ?? null
        setActiveId(selected?.id ?? '')
        setWidgets(selected?.widgets ?? [])
        setError(null)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const selectDashboard = (id: string) => {
    const next = dashboards.find((dashboard) => dashboard.id === id)
    if (!next) return
    setActiveId(id)
    setWidgets(next.widgets)
  }

  const persist = useCallback(async (next: WebsshDashboardWidget[]) => {
    const dashboardId = activeIdRef.current
    if (!dashboardId) return
    try {
      const saved = await websshApi.saveDashboardLayout(dashboardId, next)
      setWidgets(saved.widgets)
      setDashboards((current) => current.map((dashboard) => (dashboard.id === saved.id ? saved : dashboard)))
    } catch (caught) {
      toastError(caught)
      setRefreshToken((value) => value + 1)
    }
  }, [])

  useEffect(() => {
    if (!gesture) return
    const onMove = (event: PointerEvent) => {
      const columns = Math.round((event.clientX - gesture.startX) / (gesture.colWidth || 1))
      const rows = Math.round((event.clientY - gesture.startY) / ROW_HEIGHT)
      setWidgets((current) => {
        const next = current.map((widget) => {
          if (widget.id !== gesture.id) return widget
          if (gesture.kind === 'move') {
            const x = Math.max(0, Math.min(GRID_COLUMNS - widget.w, gesture.origin.x + columns))
            const y = Math.max(0, gesture.origin.y + rows)
            return { ...widget, x, y }
          }
          const w = Math.max(WIDGET_MIN_W, Math.min(GRID_COLUMNS - gesture.origin.x, gesture.origin.w + columns))
          const h = Math.max(WIDGET_MIN_H, Math.min(12, gesture.origin.h + rows))
          return { ...widget, w, h }
        })
        widgetsRef.current = next
        return next
      })
    }
    const onUp = () => {
      setGesture(null)
      void persist(widgetsRef.current)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [gesture, persist])

  const startGesture = (event: React.PointerEvent, widget: WebsshDashboardWidget, kind: Gesture['kind']) => {
    if (active?.locked || isMobile) return
    const width = gridRef.current?.clientWidth ?? 0
    if (width <= 0) return
    event.preventDefault()
    setGesture({
      kind,
      id: widget.id,
      startX: event.clientX,
      startY: event.clientY,
      colWidth: (width - ROW_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS,
      origin: { x: widget.x, y: widget.y, w: widget.w, h: widget.h },
    })
  }

  const moveWidget = (widget: WebsshDashboardWidget, patch: Partial<Pick<WebsshDashboardWidget, 'x' | 'y' | 'w' | 'h'>>) => {
    const next = widgets.map((entry) => (entry.id === widget.id ? { ...entry, ...patch } : entry))
    setWidgets(next)
    void persist(next)
  }

  const removeWidget = (widget: WebsshDashboardWidget) => {
    const next = widgets.filter((entry) => entry.id !== widget.id)
    setWidgets(next)
    void persist(next)
  }

  const addWidget = (type: WebsshWidgetType) => {
    const maxY = widgets.reduce((value, widget) => Math.max(value, widget.y + widget.h), 0)
    const next = [
      ...widgets,
      { id: `tmp${Date.now().toString(36)}`, type, x: 0, y: maxY, w: 6, h: 4, config: {} },
    ]
    setWidgets(next)
    void persist(next)
  }

  const toggleLock = async () => {
    if (!active) return
    try {
      const saved = await websshApi.updateDashboard(active.id, { locked: !active.locked })
      setDashboards((current) => current.map((dashboard) => (dashboard.id === saved.id ? saved : dashboard)))
    } catch (caught) {
      toastError(caught)
    }
  }

  const exportLayout = async () => {
    if (!active) return
    try {
      const layout = await websshApi.exportDashboard(active.id)
      const url = URL.createObjectURL(new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${layout.name.replace(/[^A-Za-z0-9._-]+/g, '-') || 'webssh'}-layout.json`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (caught) {
      toastError(caught)
    }
  }

  const importLayout = async (file: File | undefined) => {
    if (!file) return
    if (file.size > 1024 * 1024) {
      useUi.getState().toast({ title: t('webssh.dashboard.import_too_large'), tone: 'danger' })
      return
    }
    try {
      const parsed: unknown = JSON.parse(await file.text())
      const approved = await confirm({
        title: t('webssh.dashboard.import_title'),
        description: t('webssh.dashboard.import_description', { name: file.name }),
        confirmLabel: t('webssh.dashboard.import_confirm'),
      })
      if (!approved) return
      const created = await websshApi.importDashboard(parsed as WebsshDashboardExport)
      setDashboards((current) => [created, ...current])
      setActiveId(created.id)
      setWidgets(created.widgets)
    } catch (caught) {
      toastError(caught)
    }
  }

  const widgetTypesAvailable = WEBSSH_WIDGET_TYPES.filter((type) => !widgets.some((widget) => widget.type === type))
  const addItems: MenuItem[] = widgetTypesAvailable.map((type) => ({
    id: type,
    label: t(WIDGET_TITLE_KEYS[type]),
    onSelect: () => addWidget(type),
  }))
  const menuWidget = widgets.find((widget) => widget.id === widgetMenu?.id) ?? null
  const widgetItems: MenuItem[] = menuWidget ? [
    { id: 'left', label: t('webssh.dashboard.move_left'), disabled: menuWidget.x <= 0, onSelect: () => moveWidget(menuWidget, { x: Math.max(0, menuWidget.x - 1) }) },
    { id: 'right', label: t('webssh.dashboard.move_right'), disabled: menuWidget.x + menuWidget.w >= GRID_COLUMNS, onSelect: () => moveWidget(menuWidget, { x: Math.min(GRID_COLUMNS - menuWidget.w, menuWidget.x + 1) }) },
    { id: 'up', label: t('webssh.dashboard.move_up'), disabled: menuWidget.y <= 0, onSelect: () => moveWidget(menuWidget, { y: Math.max(0, menuWidget.y - 1) }) },
    { id: 'down', label: t('webssh.dashboard.move_down'), onSelect: () => moveWidget(menuWidget, { y: menuWidget.y + 1 }) },
    { id: 'wider', label: t('webssh.dashboard.wider'), disabled: menuWidget.x + menuWidget.w >= GRID_COLUMNS, onSelect: () => moveWidget(menuWidget, { w: Math.min(GRID_COLUMNS - menuWidget.x, menuWidget.w + 1) }) },
    { id: 'narrower', label: t('webssh.dashboard.narrower'), disabled: menuWidget.w <= WIDGET_MIN_W, onSelect: () => moveWidget(menuWidget, { w: Math.max(WIDGET_MIN_W, menuWidget.w - 1) }) },
    { id: 'taller', label: t('webssh.dashboard.taller'), onSelect: () => moveWidget(menuWidget, { h: Math.min(12, menuWidget.h + 1) }) },
    { id: 'shorter', label: t('webssh.dashboard.shorter'), disabled: menuWidget.h <= WIDGET_MIN_H, onSelect: () => moveWidget(menuWidget, { h: Math.max(WIDGET_MIN_H, menuWidget.h - 1) }) },
    { id: 'remove', label: t('webssh.dashboard.remove_widget'), onSelect: () => removeWidget(menuWidget) },
  ] : []

  if (loading) {
    return <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('common.loading')}</div>
  }
  if (error) {
    return <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-[length:var(--text-12)] text-[var(--danger)]">{error}</div>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5">
        <SelectMenu
          label={t('webssh.dashboard.select')}
          value={activeId}
          size="sm"
          options={dashboards.map((dashboard) => ({ value: dashboard.id, label: dashboard.name }))}
          onChange={selectDashboard}
          className="w-[180px]"
        />
        <Tooltip label={active?.locked ? t('webssh.dashboard.unlock') : t('webssh.dashboard.lock')}>
          <IconButton
            label={active?.locked ? t('webssh.dashboard.unlock') : t('webssh.dashboard.lock')}
            size="sm"
            active={active?.locked}
            onClick={() => void toggleLock()}
          >
            {active?.locked ? <Lock size={14} aria-hidden="true" /> : <Unlock size={14} aria-hidden="true" />}
          </IconButton>
        </Tooltip>
        <Tooltip label={t('webssh.dashboard.export')}>
          <IconButton label={t('webssh.dashboard.export')} size="sm" onClick={() => void exportLayout()}>
            <Download size={14} aria-hidden="true" />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('webssh.dashboard.import')}>
          <IconButton label={t('webssh.dashboard.import')} size="sm" onClick={() => fileRef.current?.click()}>
            <Upload size={14} aria-hidden="true" />
          </IconButton>
        </Tooltip>
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus size={13} aria-hidden="true" />}
          disabled={!active || active.locked || addItems.length === 0}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setAddAnchor({ x: rect.left, y: rect.bottom })
          }}
        >
          {t('webssh.dashboard.add_widget')}
        </Button>
        <span className="ms-auto text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          {isMobile ? t('webssh.dashboard.mobile_hint') : t('webssh.dashboard.hint')}
        </span>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          aria-label={t('webssh.dashboard.import')}
          onChange={(event) => {
            void importLayout(event.target.files?.[0])
            event.target.value = ''
          }}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {widgets.length === 0 ? (
          <Empty art="select" title={t('webssh.dashboard.empty_title')} description={t('webssh.dashboard.empty_description')} />
        ) : isMobile ? (
          <div className="flex flex-col gap-2">
            {widgets.map((widget) => (
              <WidgetFrame
                key={widget.id}
                widget={widget}
                sessionId={sessionId}
                monitor={monitor}
                onKill={kill}
                locked={Boolean(active?.locked)}
                mobile
                onMenu={() => undefined}
                onMoveDown={(event) => startGesture(event, widget, 'move')}
                onResizeDown={(event) => startGesture(event, widget, 'resize')}
              />
            ))}
          </div>
        ) : (
          <div
            ref={gridRef}
            className="grid grid-cols-12 gap-2"
            style={{ gridAutoRows: `${ROW_HEIGHT}px` }}
          >
            {widgets.map((widget) => (
              <WidgetFrame
                key={widget.id}
                widget={widget}
                sessionId={sessionId}
                monitor={monitor}
                onKill={kill}
                locked={Boolean(active?.locked)}
                onMenu={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  setWidgetMenu({ id: widget.id, x: rect.left, y: rect.bottom })
                }}
                onMoveDown={(event) => startGesture(event, widget, 'move')}
                onResizeDown={(event) => startGesture(event, widget, 'resize')}
              />
            ))}
          </div>
        )}
      </div>

      <Menu
        anchor={addAnchor ?? { x: 0, y: 0 }}
        open={addAnchor !== null}
        onClose={() => setAddAnchor(null)}
        items={addItems}
        label={t('webssh.dashboard.add_widget')}
      />
      <Menu
        anchor={widgetMenu ?? { x: 0, y: 0 }}
        open={widgetMenu !== null}
        onClose={() => setWidgetMenu(null)}
        items={widgetItems}
        label={t('webssh.dashboard.widget_actions')}
        width={200}
      />
    </div>
  )
}

function WidgetFrame({
  widget,
  sessionId,
  monitor,
  onKill,
  locked,
  mobile,
  onMenu,
  onMoveDown,
  onResizeDown,
}: {
  widget: WebsshDashboardWidget
  sessionId: string | null
  monitor: MonitorData
  onKill: (process: WebsshMonitorProcess) => void
  locked: boolean
  mobile?: boolean
  onMenu: (event: React.MouseEvent<HTMLButtonElement>) => void
  onMoveDown: (event: React.PointerEvent) => void
  onResizeDown: (event: React.PointerEvent) => void
}) {
  return (
    <section
      aria-label={t(WIDGET_TITLE_KEYS[widget.type])}
      className={cn(
        'relative flex min-h-0 flex-col overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]',
        mobile && 'min-h-[240px]',
      )}
      style={mobile ? undefined : {
        gridColumn: `${widget.x + 1} / span ${widget.w}`,
        gridRow: `${widget.y + 1} / span ${widget.h}`,
      }}
    >
      <div
        className={cn('flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2 py-1', !locked && !mobile && 'cursor-grab')}
        style={{ touchAction: 'none' }}
        onPointerDown={locked || mobile ? undefined : onMoveDown}
      >
        {!locked && !mobile && <GripVertical size={13} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />}
        <h3 className="min-w-0 flex-1 truncate text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t(WIDGET_TITLE_KEYS[widget.type])}</h3>
        {!locked && (
          <IconButton label={t('webssh.dashboard.widget_actions')} size="xs" onClick={onMenu} onPointerDown={(event) => event.stopPropagation()}>
            <MoreVertical size={12} aria-hidden="true" />
          </IconButton>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <WidgetBody widget={widget} sessionId={sessionId} monitor={monitor} onKill={onKill} />
      </div>
      {!locked && !mobile && (
        <button
          type="button"
          aria-label={t('webssh.dashboard.resize')}
          onPointerDown={onResizeDown}
          className="absolute bottom-0 right-0 size-5 cursor-se-resize"
          style={{ touchAction: 'none' }}
        >
          <span aria-hidden="true" className="absolute bottom-1 right-1 size-2 rounded-br-[var(--r-sm)] border-b border-r border-[var(--text-quaternary)]" />
        </button>
      )}
    </section>
  )
}
