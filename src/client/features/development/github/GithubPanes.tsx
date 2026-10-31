import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../../../lib/cn'
import { useMediaQuery } from '../../../lib/hooks'
import { Drawer } from '../../../components/overlay'
import { Resizer, SplitResizer } from '../../shell/Resizer'
import { loadLayoutPrefs, saveLayoutPrefs, type GithubLayoutPrefs } from './prefs'

export interface ListPaneControls {
  toggleSidebar: () => void
  toggleDetail: () => void
  detailDisabled: boolean
}

export interface GithubPanesProps {
  title: string
  sidebar: ReactNode
  sidebarHeader?: ReactNode
  sidebarFooter?: ReactNode
  list: ReactNode | ((controls: ListPaneControls) => ReactNode)
  detail: ReactNode
  detailDisabled?: boolean
}

export function GithubPanes({
  title,
  sidebar,
  sidebarHeader,
  sidebarFooter,
  list,
  detail,
  detailDisabled = false,
}: GithubPanesProps) {
  const wide = useMediaQuery('(min-width: 1280px)')
  const twoPane = useMediaQuery('(min-width: 1024px)')
  const [initial] = useState(loadLayoutPrefs)
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.min(300, Math.max(200, initial.sidebarWidth)))
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const [detailRatio, setDetailRatio] = useState(() => Math.min(0.7, Math.max(0.3, initial.detailRatio)))
  const [sidebarDrawer, setSidebarDrawer] = useState(false)
  const [detailDrawer, setDetailDrawer] = useState(false)
  const [detailHidden, setDetailHidden] = useState(false)
  const splitRef = useRef<HTMLDivElement>(null)
  const pendingLayout = useRef<Partial<GithubLayoutPrefs>>({})
  const layoutTimer = useRef<number | null>(null)

  const scheduleLayoutSave = (patch: Partial<GithubLayoutPrefs>): void => {
    pendingLayout.current = { ...pendingLayout.current, ...patch }
    if (layoutTimer.current !== null) window.clearTimeout(layoutTimer.current)
    layoutTimer.current = window.setTimeout(() => {
      layoutTimer.current = null
      const pending = pendingLayout.current
      pendingLayout.current = {}
      saveLayoutPrefs(pending)
    }, 200)
  }

  useEffect(() => () => {
    if (layoutTimer.current !== null) window.clearTimeout(layoutTimer.current)
    if (Object.keys(pendingLayout.current).length > 0) saveLayoutPrefs(pendingLayout.current)
  }, [])

  const toggleSidebar = () => {
    if (wide) {
      setSidebarHidden((value) => !value)
      return
    }
    setSidebarDrawer(true)
  }

  const toggleDetail = () => {
    if (twoPane) {
      setDetailHidden((value) => !value)
      return
    }
    setDetailDrawer(true)
  }

  useEffect(() => {
    if (!detailDisabled) setDetailHidden(false)
  }, [detailDisabled])

  const controls: ListPaneControls = { toggleSidebar, toggleDetail, detailDisabled }
  const listContent = typeof list === 'function' ? list(controls) : list

  const tabsBar = sidebarHeader ? <div className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2" data-testid="github-module-tabs">{sidebarHeader}</div> : null

  const sidebarColumn = (
    <div className="flex h-full min-h-0 flex-col">
      {tabsBar}
      <div className="min-h-0 flex-1 overflow-hidden">{sidebar}</div>
      {sidebarFooter && <div className="shrink-0 border-t border-[var(--border-subtle)]">{sidebarFooter}</div>}
    </div>
  )

  if (!twoPane) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="github-panes-compact">
        {tabsBar}
        <div className="min-h-0 flex-1 overflow-hidden">{listContent}</div>
        <Drawer open={sidebarDrawer} onClose={() => setSidebarDrawer(false)} side="left" width={300} title={title}>
          {sidebarColumn}
        </Drawer>
        <Drawer
          open={detailDrawer}
          onClose={() => setDetailDrawer(false)}
          side="right"
          width={520}
          title={title}
          bodyClassName="overflow-hidden"
        >
          <div className="h-full min-h-0 overflow-hidden">{detail}</div>
        </Drawer>
      </div>
    )
  }

  if (!wide) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="github-panes-two">
        {tabsBar}
        <div ref={splitRef} className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-hidden" style={detailHidden ? undefined : { flexBasis: `${(1 - detailRatio) * 100}%` }}>
            {listContent}
          </div>
          {!detailHidden && (
            <>
              <SplitResizer
                label={title}
                containerRef={splitRef}
                ratio={detailRatio}
                onChange={(next) => {
                  setDetailRatio(next)
                  scheduleLayoutSave({ detailRatio: next })
                }}
                onReset={() => setDetailRatio(0.5)}
              />
              <div className="min-w-0 flex-1 overflow-hidden" style={{ flexBasis: `${detailRatio * 100}%` }}>
                {detail}
              </div>
            </>
          )}
        </div>
        <Drawer open={sidebarDrawer} onClose={() => setSidebarDrawer(false)} side="left" width={300} title={title}>
          {sidebarColumn}
        </Drawer>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="github-panes-wide">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {!sidebarHidden && (
          <>
            <div className="shrink-0 overflow-hidden" style={{ width: sidebarWidth }}>
              {sidebarColumn}
            </div>
            <Resizer
              label={title}
              value={sidebarWidth}
              min={200}
              max={300}
              onChange={(next) => {
                setSidebarWidth(next)
                scheduleLayoutSave({ sidebarWidth: next })
              }}
              onReset={() => setSidebarWidth(240)}
            />
          </>
        )}
        <div ref={splitRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className={cn('min-w-0 overflow-hidden', 'flex-1')} style={detailHidden ? undefined : { flexBasis: `${(1 - detailRatio) * 100}%` }}>
            {listContent}
          </div>
          {!detailHidden && (
            <>
              <SplitResizer
                label={title}
                containerRef={splitRef}
                ratio={detailRatio}
                onChange={(next) => {
                  setDetailRatio(next)
                  scheduleLayoutSave({ detailRatio: next })
                }}
                onReset={() => setDetailRatio(0.5)}
              />
              <div className="min-w-0 overflow-hidden" style={{ flexBasis: `${detailRatio * 100}%` }}>
                {detail}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
