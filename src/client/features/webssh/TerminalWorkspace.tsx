import { useEffect, useState, useCallback, useRef } from 'react'
import { Sparkles, X } from 'lucide-react'
import type { WebsshAiHandoffView } from '@shared/webssh/ai'
import type { WebsshHost } from '@shared/webssh/types'
import { t } from '../../lib/i18n'
import { useBreakpoint, useThemeDark } from '../../lib/hooks'
import { Button, IconButton } from '../../components/primitives'
import { websshAiApi } from './ai-client'
import { Empty } from '../../components/feedback'
import { TerminalTabs, type TerminalTabView } from './TerminalTabs'
import { TerminalPane } from './TerminalPane'
import { SftpPanel } from './SftpPanel'
import { WebsshAiPanel, type WebsshAiTerminalSource } from './WebsshAiPanel'
import { RecordingPlayerDialog } from './RecordingPlayerDialog'
import { RecordingSettingsDialog } from './RecordingSettingsDialog'
import { SnippetsPanel } from './SnippetsPanel'
import { TerminalSettingsDialog } from './TerminalSettingsDialog'
import { TerminalShortcutsDialog } from './TerminalShortcutsDialog'
import { loadTerminalSettings, saveTerminalSettings, type TerminalSettings } from './prefs'
import { WebSocketTerminalTransport } from './transport/websocket-transport'
import type { TerminalTransportFactory } from './transport/types'
import type { TerminalSessionPhase } from './use-terminal-session'

const PANEL_ID = 'webssh-sessions'

/** What the global assistant is told about the terminal on screen: labels and state, never a secret. */
export interface WebsshActiveSessionView {
  sessionId: string | null
  hostId: string
  hostName: string
  status: TerminalSessionPhase | null
}

interface WorkspaceTab extends TerminalTabView {
  sessionId: string | null
}

export function TerminalWorkspace({ host, onActiveSession }: {
  host: WebsshHost
  onActiveSession?: (view: WebsshActiveSessionView | null) => void
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
  const [aiOpen, setAiOpen] = useState(false)
  const [aiInitialTab, setAiInitialTab] = useState<'command' | 'session'>('command')
  const [handoff, setHandoff] = useState<WebsshAiHandoffView | null>(null)
  const [handoffDismissed, setHandoffDismissed] = useState(false)
  const [sources, setSources] = useState<Record<string, WebsshAiTerminalSource>>({})
  const [replayOpen, setReplayOpen] = useState(false)
  const [recordingOpen, setRecordingOpen] = useState(false)
  const [snippetsOpen, setSnippetsOpen] = useState(false)
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
    setSequence(1)
    setFilesOpen(false)
    setAiOpen(false)
    setAiInitialTab('command')
    setReplayOpen(false)
    setSnippetsOpen(false)
    setInsertRequest(null)
    setHandoff(null)
    setHandoffDismissed(false)
  }, [host.id, host.name])

  // The last handoff is a database read, not a model call: reconnecting to a host shows what the
  // previous session left unfinished without spending the reader's quota to say so.
  useEffect(() => {
    let cancelled = false
    websshAiApi.handoff(host.id)
      .then((next) => {
        if (!cancelled) setHandoff(next)
      })
      .catch((error: unknown) => {
        // The card is a convenience; a failed read must not keep the terminal from opening, and the
        // assistant panel surfaces the same failure when the reader asks there.
        console.warn('[inkstone] WebSSH handoff read failed:', error instanceof Error ? error.message : error)
      })
    return () => {
      cancelled = true
    }
  }, [host.id])

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

  const reportSource = useCallback((id: string, source: WebsshAiTerminalSource) => {
    setSources((current) => (current[id] === source ? current : { ...current, [id]: source }))
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
  const activeSource = activeId ? sources[activeId] : undefined

  const reportActiveSession = onActiveSession
  useEffect(() => {
    if (!reportActiveSession) return
    reportActiveSession(activeId
      ? {
        sessionId: activeSessionId,
        hostId: host.id,
        hostName: host.name,
        status: statuses[activeId] ?? null,
      }
      : null)
  }, [reportActiveSession, activeId, activeSessionId, host.id, host.name, statuses])

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
        onOpenFiles={() => {
          setFilesOpen((value) => !value)
          setAiOpen(false)
        }}
        filesOpen={filesOpen}
        filesDisabled={!activeSessionId}
        onOpenAi={() => {
          setAiInitialTab('command')
          setAiOpen((value) => !value)
          setFilesOpen(false)
        }}
        aiOpen={aiOpen}
        aiDisabled={!activeSessionId}
        onOpenSnippets={() => setSnippetsOpen(true)}
        snippetsDisabled={!activeSessionId}
        onOpenReplay={() => setReplayOpen(true)}
        replayDisabled={!activeSessionId}
        onOpenRecordingSettings={() => setRecordingOpen(true)}
        panelId={PANEL_ID}
      />
      {handoff && !handoffDismissed && (
        <aside
          aria-label={t('webssh.ai.handoff.banner_title')}
          className="flex shrink-0 flex-wrap items-start gap-x-2 gap-y-1 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1.5"
        >
          <Sparkles size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--accent)]" />
          <div className="min-w-0 flex-1">
            <p className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">
              {t('webssh.ai.handoff.banner_title')}
            </p>
            <p className="line-clamp-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{handoff.summary}</p>
            {handoff.openIssues.length > 0 && (
              <p className="text-[length:var(--text-10-5)] text-[var(--warning)]">
                {t('webssh.ai.handoff.open_issues_count', { count: handoff.openIssues.length })}
              </p>
            )}
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setAiInitialTab('session')
              setAiOpen(true)
              setFilesOpen(false)
            }}
          >
            {t('webssh.ai.handoff.view')}
          </Button>
          <IconButton label={t('webssh.ai.handoff.dismiss')} size="xs" onClick={() => setHandoffDismissed(true)}>
            <X size={12} aria-hidden="true" />
          </IconButton>
        </aside>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
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
                isDark={isDark}
                createTransport={factoryFor()}
                panelId={PANEL_ID}
                insertRequest={tab.id === activeId ? insertRequest : null}
                onPhaseChange={reportPhase}
                onSessionId={(sessionId) => reportSession(tab.id, sessionId)}
                onSourceReady={reportSource}
              />
            ))
          )}
        </div>
        {filesOpen && activeSessionId && (
          <div className={isMobile ? 'absolute inset-0 z-20 bg-[var(--bg-surface)]' : 'flex min-h-0'}>
            <SftpPanel sessionId={activeSessionId} homePath={homePath} onClose={() => setFilesOpen(false)} />
          </div>
        )}
        {aiOpen && activeSessionId && activeSource && (
          <div className={isMobile ? 'absolute inset-0 z-20 bg-[var(--bg-surface)]' : 'flex min-h-0'}>
            <WebsshAiPanel
              host={host}
              sessionId={activeSessionId}
              source={activeSource}
              onInsert={insertSnippet}
              onClose={() => setAiOpen(false)}
              initialTab={aiInitialTab}
            />
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
