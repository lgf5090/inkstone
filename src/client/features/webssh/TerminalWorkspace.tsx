import { useEffect, useState, useCallback, useRef } from 'react'
import type { WebsshHost } from '@shared/webssh/types'
import { t } from '../../lib/i18n'
import { useBreakpoint, useThemeDark } from '../../lib/hooks'
import { Button } from '../../components/primitives'
import { Empty } from '../../components/feedback'
import { useUi } from '../../store/ui'
import { TerminalTabs, type TerminalTabView } from './TerminalTabs'
import { TerminalPane, type TerminalPaneController } from './TerminalPane'
import { SftpPanel } from './SftpPanel'
import { RecordingPlayerDialog } from './RecordingPlayerDialog'
import { RecordingSettingsDialog } from './RecordingSettingsDialog'
import { SnippetsPanel } from './SnippetsPanel'
import { QuickCommandsPanel, type SendTarget } from './QuickCommandsPanel'
import { TerminalSettingsDialog } from './TerminalSettingsDialog'
import { TerminalShortcutsDialog } from './TerminalShortcutsDialog'
import { appearanceStyle, type WebsshAppearance } from './appearance'
import { loadTerminalSettings, saveTerminalSettings, type TerminalSettings } from './prefs'
import { WebSocketTerminalTransport } from './transport/websocket-transport'
import type { TerminalTransportFactory } from './transport/types'
import type { TerminalSessionPhase } from './use-terminal-session'

const PANEL_ID = 'webssh-sessions'

interface WorkspaceTab extends TerminalTabView {
  sessionId: string | null
}

export function TerminalWorkspace({
  host,
  appearance,
}: {
  host: WebsshHost
  appearance: WebsshAppearance
}) {
  const isMobile = useBreakpoint() === 'mobile'
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() => [{ id: 'session-1', title: host.name, sessionId: null }])
  const [activeId, setActiveId] = useState<string | null>('session-1')
  const [statuses, setStatuses] = useState<Record<string, TerminalSessionPhase>>({})
  const [sequence, setSequence] = useState(1)
  const [settings, setSettings] = useState<TerminalSettings>(loadTerminalSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [replayOpen, setReplayOpen] = useState(false)
  const [recordingOpen, setRecordingOpen] = useState(false)
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  const [insertRequest, setInsertRequest] = useState<{ text: string; token: number } | null>(null)
  const insertTokenRef = useRef(0)
  const controllersRef = useRef(new Map<string, TerminalPaneController>())
  const isDark = useThemeDark()

  useEffect(() => {
    saveTerminalSettings(settings)
  }, [settings])

  useEffect(() => {
    setTabs([{ id: 'session-1', title: host.name, sessionId: null }])
    setActiveId('session-1')
    setStatuses({})
    setSequence(1)
    setFilesOpen(false)
    setQuickOpen(false)
    setReplayOpen(false)
    setSnippetsOpen(false)
    setInsertRequest(null)
    controllersRef.current.clear()
  }, [host.id, host.name])

  const insertSnippet = (text: string) => {
    insertTokenRef.current += 1
    setInsertRequest({ text, token: insertTokenRef.current })
  }

  const registerController = useCallback((id: string, controller: TerminalPaneController | null) => {
    if (controller) controllersRef.current.set(id, controller)
    else controllersRef.current.delete(id)
  }, [])

  const sendCommand = (text: string, target: SendTarget) => {
    const ids = target === 'all'
      ? tabs.filter((tab) => statuses[tab.id] === 'open').map((tab) => tab.id)
      : activeId ? [activeId] : []
    let sent = 0
    for (const id of ids) {
      if (controllersRef.current.get(id)?.send(text)) sent += 1
    }
    if (sent === 0) {
      useUi.getState().toast({ title: t('webssh.quick.no_session'), tone: 'warning' })
      return
    }
    useUi.getState().toast({ title: t('webssh.quick.sent', { count: sent }), tone: 'success' })
  }

  const insertCommand = (text: string) => {
    if (!activeId || !controllersRef.current.get(activeId)?.insert(text)) {
      useUi.getState().toast({ title: t('webssh.quick.no_session'), tone: 'warning' })
      return
    }
    useUi.getState().toast({ title: t('webssh.quick.inserted'), tone: 'success' })
  }

  const reportPhase = useCallback((id: string, phase: TerminalSessionPhase) => {
    setStatuses((current) => (current[id] === phase ? current : { ...current, [id]: phase }))
  }, [])

  const reportSession = useCallback((id: string, sessionId: string) => {
    setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, sessionId } : tab)))
  }, [])

  const createSession = () => {
    const nextSequence = sequence + 1
    const next: WorkspaceTab = {
      id: `session-${nextSequence}`,
      title: nextSequence === 1 ? host.name : `${host.name} (${nextSequence})`,
      sessionId: null,
    }
    setSequence(nextSequence)
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

  const homePath = host.username === 'root' ? '/root' : `/home/${host.username}`
  const factoryFor = (): TerminalTransportFactory => (handlers) =>
    new WebSocketTerminalTransport(handlers, { hostId: host.id, cols: 80, rows: 24 })
  const activeConnected = activeId ? statuses[activeId] === 'open' : false
  const connectedCount = tabs.filter((tab) => statuses[tab.id] === 'open').length

  return (
    <div className="webssh-shell relative flex min-h-0 flex-1 flex-col" style={appearanceStyle(appearance)}>
      <TerminalTabs
        tabs={tabs}
        activeId={activeId}
        statuses={statuses}
        onSelect={setActiveId}
        onClose={closeSession}
        onNew={createSession}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenFiles={() => {
          setFilesOpen((value) => !value)
          if (isMobile) setQuickOpen(false)
        }}
        filesOpen={filesOpen}
        filesDisabled={!activeSessionId}
        onOpenQuickCommands={() => {
          setQuickOpen((value) => !value)
          if (isMobile) setFilesOpen(false)
        }}
        quickOpen={quickOpen}
        onOpenSnippets={() => setSnippetsOpen(true)}
        snippetsDisabled={!activeSessionId}
        onOpenReplay={() => setReplayOpen(true)}
        replayDisabled={!activeSessionId}
        onOpenRecordingSettings={() => setRecordingOpen(true)}
        panelId={PANEL_ID}
      />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {quickOpen && (
          <div className={isMobile ? 'absolute inset-0 z-20 bg-[var(--bg-surface)]' : 'flex min-h-0 w-[300px] shrink-0 border-e border-[var(--border-subtle)]'}>
            <QuickCommandsPanel
              open={quickOpen}
              onClose={() => setQuickOpen(false)}
              activeConnected={activeConnected}
              connectedCount={connectedCount}
              onSend={sendCommand}
              onInsert={insertCommand}
            />
          </div>
        )}
        <div className="relative min-h-0 flex-1">
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
                appearance={appearance}
                isDark={isDark}
                createTransport={factoryFor()}
                panelId={PANEL_ID}
                insertRequest={tab.id === activeId ? insertRequest : null}
                onPhaseChange={reportPhase}
                onSessionId={(sessionId) => reportSession(tab.id, sessionId)}
                onController={registerController}
              />
            ))
          )}
        </div>
        {filesOpen && activeSessionId && (
          <div className={isMobile ? 'absolute inset-0 z-20 bg-[var(--bg-surface)]' : 'flex min-h-0'}>
            <SftpPanel sessionId={activeSessionId} homePath={homePath} onClose={() => setFilesOpen(false)} />
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
    </div>
  )
}
