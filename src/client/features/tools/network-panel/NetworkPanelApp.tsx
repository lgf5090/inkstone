/**
 * The module's shell.
 *
 * Loading, visibility and paste live here rather than in each screen: the test has to keep counting
 * while the reader looks at the history, and a pasted address has to become a node whichever screen
 * is open. Leaving the module is the same question as hiding the tab — the background switch answers
 * it once.
 */
import { useEffect } from 'react'
import { NETWORK_PANEL_LIMITS } from '@shared/tools/network-panel/types'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { useToolsStore } from '../store'
import { useNetworkPanelStore } from './store'
import { SpeedTestView } from './SpeedTestView'
import { NetworkInfoView } from './NetworkInfoView'
import { HistoryView } from './HistoryView'
import { SettingsView } from './SettingsView'

export function NetworkPanelApp() {
  const view = useToolsStore((s) => s.activeNetworkPanelView)
  const load = useNetworkPanelStore((s) => s.load)
  const handleBackgroundPolicy = useNetworkPanelStore((s) => s.handleBackgroundPolicy)
  const importPastedUrl = useNetworkPanelStore((s) => s.importPastedUrl)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    // The chart library is shared with note charts and is loaded lazily. A running test keeps every
    // connection busy (and a bandwidth cap keeps each one busy for seconds), so the first chart's
    // import would queue behind the downloads and draw nothing. Warming it here happens before Start.
    void import('chart.js/auto')
  }, [])

  useEffect(() => {
    const onVisibilityChange = () => handleBackgroundPolicy(document.visibilityState === 'hidden')
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      handleBackgroundPolicy(true)
    }
  }, [handleBackgroundPolicy])

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (useToolsStore.getState().activeSubmodule !== 'network_panel') return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable="true"]')) return
      const text = event.clipboardData?.getData('text/plain')?.trim() ?? ''
      if (!text || text.length > NETWORK_PANEL_LIMITS.maxUrl) return
      if (!/^(https?:\/\/|\/)/.test(text)) return
      void importPastedUrl(text).then((result) => {
        if (!result) {
          useUi.getState().toast({ title: t('tools.network_panel.paste.invalid'), tone: 'danger' })
          return
        }
        useUi.getState().toast({
          title: result.status === 'added'
            ? t('tools.network_panel.paste.added', { label: result.label })
            : t('tools.network_panel.paste.selected', { label: result.label }),
          tone: 'success',
        })
      })
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [importPastedUrl])

  return (
    <div data-testid="network-panel-app-root" className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]">
      {view === 'speed' && <SpeedTestView />}
      {view === 'info' && <NetworkInfoView />}
      {view === 'history' && <HistoryView />}
      {view === 'settings' && <SettingsView />}
    </div>
  )
}
