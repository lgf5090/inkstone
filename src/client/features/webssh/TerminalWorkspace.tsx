import { useEffect, useState, useCallback, useRef } from 'react'
import type { WebsshHost } from '@shared/webssh/types'
import { t } from '../../lib/i18n'
import { useBreakpoint, useThemeDark } from '../../lib/hooks'
import { Button } from '../../components/primitives'
import { Empty } from '../../components/feedback'
import { TerminalTabs, type TerminalTabView } from './TerminalTabs'
import { TerminalPane } from './TerminalPane'
import { SftpPanel } from './SftpPanel'
import { RecordingPlayerDialog } from './RecordingPlayerDialog'
import { RecordingSettingsDialog } from './RecordingSettingsDialog'
import { SnippetsPanel } from './SnippetsPanel'
import { ForwardPanel } from './ForwardPanel'
import { TerminalSettingsDialog } from './TerminalSettingsDialog'
import { TerminalShortcutsDialog } from './TerminalShortcutsDialog'
import { MonitorPanel } from './MonitorPanel'
import { DashboardGrid } from './DashboardGrid'
import { loadTerminalSettings, saveTerminalSettings, type TerminalSettings } from './prefs'
import { WebSocketTerminalTransport } from './transport/websocket-transport'
import type { TerminalTransportFactory } from './transport/types'
import type { TerminalSessionPhase } from './use-terminal-session'

const PANEL_ID = 'webssh-sessions'

interface WorkspaceTab extends TerminalTabView {
  sessionId: string | null
}

export function TerminalWorkspace({ host, newTabToken = 0 }: { host: WebsshHost; newTabToken?: number }) {
  const isMobile = useBreakpoint() === 'mobile'
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() => [{ id: 'session-1', title: host.name, sessionId: null }])
  const [activeId, setActiveId] = useState<string | null>('session-1')
  const [statuses, setStatuses] = useState<Record<string, TerminalSessionPhase>>({})
  const sequenceRef = useRef(1)
  const lastNewTabToken = useRef(newTabToken)
  const [settings, setSettings] = useState<TerminalSettings>(loadTerminalSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [filesFullscreen, setFilesFullscreen] = useState(false)
  const [cwdPath, setCwdPath] = useState<string | null>(null)
  const [cwdToken, setCwdToken] = useState(0)
  const [replayOpen, setReplayOpen] = useState(false)
  const [recordingOpen, setRecordingOpen] = useState(false)
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  const [monitorOpen, setMonitorOpen] = useState(false)
  const [view, setView] = useState<'terminal' | 'dashboard'>('terminal')
  const [forwardOpen, setForwardOpen] = useState(false)
  const [insertRequest, setInsertRequest] = useState<{ text: string; token: number } | null>(null)
  const insertTokenRef = useRef(0)
  const isDark = useThemeDark()

  useEffect(() => {
    saveTerminalSettings(settings)
  }, [settings])

  useEffect(() => {
    setTabs([{ id: 'session-1', title: host.name, sessionId: null }])
    setActiveId('session-1')
    setStatuses({})
    sequenceRef.current = 1
    setFilesOpen(false)
    setFilesFullscreen(false)
    setCwdPath(null)
    setCwdToken(0)
    setReplayOpen(false)
    setSnippetsOpen(false)
    setForwardOpen(false)
    setInsertRequest(null)
    setMonitorOpen(false)
    setView('terminal')
  }, [host.id, host.name])

  useEffect(() => {
    if (newTabToken === 0 || newTabToken === lastNewTabToken.current) return
    lastNewTabToken.current = newTabToken
    const nextSequence = sequenceRef.current + 1
    sequenceRef.current = nextSequence
    const next: WorkspaceTab = {
      id: `session-${nextSequence}`,
      title: `${host.name} (${nextSequence})`,
      sessionId: null,
    }
    setTabs((current) => [...current, next])
    setActiveId(next.id)
  }, [newTabToken, host.name])

  const insertSnippet = (text: string) => {
    insertTokenRef.current += 1
    setInsertRequest({ text, token: insertTokenRef.current })
  }

  const reportPhase = useCallback((id: string, phase: TerminalSessionPhase) => {
    setStatuses((current) => (current[id] === phase ? current : { ...current, [id]: phase }))
  }, [])

  const reportSession = useCallback((id: string, sessionId: string) => {
    setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, sessionId } : tab)))
  }, [])

  const createSession = () => {
    const nextSequence = sequenceRef.current + 1
    sequenceRef.current = nextSequence
    const next: WorkspaceTab = {
      id: `session-${nextSequence}`,
      title: nextSequence === 1 ? host.name : `${host.name} (${nextSequence})`,
      sessionId: null,
    }
    setTabs((current) => [...current, next])
    setActiveId(next.id)
  }

  const closeSession = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id)
    const remaining = tabs.filter((tab) => tab.id !== id)
    setTabs(remaining)
    setStatuses((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    if (activeId === id) {
      const neighbour = remaining[Math.max(0, index - 1)]
      setActiveId(neighbour?.id ?? remaining[0]?.id ?? null)
    }
  }

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? null
  const activeSessionId = activeTab?.sessionId ?? null

  const reportCwd = useCallback((path: string) => {
    setCwdPath(path)
    setCwdToken((value) => value + 1)
  }, [])

  const homePath = host.username === 'root' ? '/root' : `/home/${host.username}`
  const factoryFor = (): TerminalTransportFactory => (handlers) =>
    new WebSocketTerminalTransport(handlers, { hostId: host.id, cols: 80, rows: 24 })

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <TerminalTabs
        tabs={tabs}
        activeId={activeId}
        statuses={statuses}
        onSelect={setActiveId}
        onClose={closeSession}
        onNew={createSession}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenFiles={() => setFilesOpen((value) => !value)}
        filesOpen={filesOpen}
        filesDisabled={!activeSessionId}
        onOpenSnippets={() => setSnippetsOpen(true)}
        snippetsDisabled={!activeSessionId}
        onOpenReplay={() => setReplayOpen(true)}
        replayDisabled={!activeSessionId}
        onOpenForward={() => setForwardOpen(true)}
        forwardDisabled={!activeSessionId}
        onOpenRecordingSettings={() => setRecordingOpen(true)}
        onOpenMonitor={() => setMonitorOpen((value) => !value)}
        monitorOpen={monitorOpen}
        monitorDisabled={!activeSessionId}
        onOpenDashboard={() => setView((value) => (value === 'terminal' ? 'dashboard' : 'terminal'))}
        dashboardActive={view === 'dashboard'}
        panelId={PANEL_ID}
      />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {view === 'dashboard' && <DashboardGrid sessionId={activeSessionId} />}
        <div className={view === 'dashboard' ? 'hidden' : 'relative min-h-0 flex-1'}>
          {tabs.length === 0 ? (
            <Empty
              art="select"
              title={t('webssh.app.empty_title')}
              description={t('webssh.app.empty_description')}
              action={
                <Button variant="primary" onClick={createSession}>
                  {t('webssh.session.create')}
                </Button>
              }
            />
          ) : (
            tabs.map((tab) => (
              <TerminalPane
                key={tab.id}
                session={tab}
                active={tab.id === activeId}
                settings={settings}
                isDark={isDark}
                createTransport={factoryFor()}
                panelId={PANEL_ID}
                homePath={homePath}
                insertRequest={tab.id === activeId ? insertRequest : null}
                onPhaseChange={reportPhase}
                onSessionId={(sessionId) => reportSession(tab.id, sessionId)}
                onCwd={tab.id === activeId ? reportCwd : undefined}
              />
            ))
          )}
        </div>
        {filesOpen && activeSessionId && (
          <div className={filesFullscreen ? 'contents' : isMobile ? 'absolute inset-0 z-20 bg-[var(--bg-surface)]' : 'flex min-h-0'}>
            <SftpPanel
              sessionId={activeSessionId}
              hostId={host.id}
              homePath={homePath}
              followPath={cwdPath ? { path: cwdPath, token: cwdToken } : null}
              fullscreen={filesFullscreen}
              onToggleFullscreen={() => setFilesFullscreen((value) => !value)}
              onClose={() => {
                setFilesOpen(false)
                setFilesFullscreen(false)
              }}
            />
          </div>
        )}
        {view === 'terminal' && monitorOpen && activeSessionId && (
          <div className={isMobile ? 'absolute inset-0 z-20 bg-[var(--bg-surface)]' : 'flex min-h-0'}>
            <MonitorPanel sessionId={activeSessionId} onClose={() => setMonitorOpen(false)} />
          </div>
        )}
      </div>
      <TerminalSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={setSettings}
      />
      <TerminalShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} demo={false} />
      <RecordingSettingsDialog open={recordingOpen} onClose={() => setRecordingOpen(false)} />
      <RecordingPlayerDialog open={replayOpen} sessionId={activeSessionId} onClose={() => setReplayOpen(false)} />
      <SnippetsPanel
        open={snippetsOpen}
        onClose={() => setSnippetsOpen(false)}
        onInsert={activeSessionId ? insertSnippet : undefined}
      />
      <ForwardPanel
        open={forwardOpen}
        sessionId={activeSessionId}
        hostId={host.id}
        onClose={() => setForwardOpen(false)}
      />
    </div>
  )
}
