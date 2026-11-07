import { useEffect, useState, useCallback } from 'react'
import { t } from '../../lib/i18n'
import { useThemeDark } from '../../lib/hooks'
import { Button } from '../../components/primitives'
import { Empty } from '../../components/feedback'
import { TerminalTabs, type TerminalTabView } from './TerminalTabs'
import { TerminalPane } from './TerminalPane'
import { NewSessionDialog } from './NewSessionDialog'
import { TerminalSettingsDialog } from './TerminalSettingsDialog'
import { TerminalShortcutsDialog } from './TerminalShortcutsDialog'
import { loadTerminalSettings, saveTerminalSettings, type TerminalSettings } from './prefs'
import type { TerminalSessionPhase } from './use-terminal-session'

const PANEL_ID = 'webssh-sessions'

const FIRST_TAB: TerminalTabView = { id: 'session-1', title: 'demo-1' }

export function TerminalWorkspace({ demoTransport }: { demoTransport: boolean }) {
  const [tabs, setTabs] = useState<TerminalTabView[]>([FIRST_TAB])
  const [activeId, setActiveId] = useState<string | null>(FIRST_TAB.id)
  const [statuses, setStatuses] = useState<Record<string, TerminalSessionPhase>>({})
  const [sequence, setSequence] = useState(1)
  const [settings, setSettings] = useState<TerminalSettings>(loadTerminalSettings)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const isDark = useThemeDark()

  useEffect(() => {
    saveTerminalSettings(settings)
  }, [settings])

  const reportPhase = useCallback((id: string, phase: TerminalSessionPhase) => {
    setStatuses((current) => (current[id] === phase ? current : { ...current, [id]: phase }))
  }, [])

  const createSession = (name: string) => {
    const nextSequence = sequence + 1
    const next: TerminalTabView = { id: `session-${nextSequence}`, title: name }
    setSequence(nextSequence)
    setTabs((current) => [...current, next])
    setActiveId(next.id)
    setNewSessionOpen(false)
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

  const nextDefaultName = `demo-${sequence + 1}`

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TerminalTabs
        tabs={tabs}
        activeId={activeId}
        statuses={statuses}
        onSelect={setActiveId}
        onClose={closeSession}
        onNew={() => setNewSessionOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        panelId={PANEL_ID}
      />
      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <Empty
            art="select"
            title={t('webssh.app.empty_title')}
            description={t('webssh.app.empty_description')}
            action={
              <Button variant="primary" onClick={() => setNewSessionOpen(true)}>
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
              demoTransport={demoTransport}
              panelId={PANEL_ID}
              onPhaseChange={reportPhase}
            />
          ))
        )}
      </div>
      <NewSessionDialog
        open={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
        onCreate={createSession}
        defaultName={nextDefaultName}
      />
      <TerminalSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={setSettings}
      />
      <TerminalShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} demo={demoTransport} />
    </div>
  )
}
