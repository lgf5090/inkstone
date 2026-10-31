import { useEffect } from 'react'
import { useToolsStore } from '../store'
import { useMediaQuery } from '../../../lib/hooks'
import { fetchQrSettings } from './api'
import { useQrCodeStore } from './store'
import { QrContentEditor } from './content/QrContentEditor'
import { QrBeautifyPanel } from './options/QrBeautifyPanel'
import { QrPreviewPanel } from './preview/QrPreviewPanel'
import { QrExportControls } from './export/QrExportControls'
import { QrHistoryView } from './history/QrHistoryView'
import { QrTemplatesView } from './templates/QrTemplatesView'
import { QrSettingsView } from './settings/QrSettingsView'
import { QrScannerView } from './scanner/QrScannerView'
import { QrCompareView } from './compare/QrCompareView'
import { QrBatchView } from './batch/QrBatchView'
import { QrInfoModal } from './preview/QrInfoModal'
import { QrFullscreenModal } from './preview/QrFullscreenModal'

const WIDE_LAYOUT_QUERY = '(min-width: 1024px)'

export function QrCodeApp() {
  const activeQrCodeView = useToolsStore((s) => s.activeQrCodeView)
  const isWide = useMediaQuery(WIDE_LAYOUT_QUERY)

  useEffect(() => {
    if (useQrCodeStore.getState().defaultsApplied) return
    fetchQrSettings()
      .then((settings) => useQrCodeStore.getState().applyServerDefaults(settings))
      .catch(() => {
        // Unreachable preferences leave the workbench on its built-in starting values, and the flag
        // stays clear so the next visit asks again.
      })
  }, [])

  return (
    <div
      data-testid="qrcode-app-root"
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      {activeQrCodeView === 'generator' && (
        isWide ? (
          <div className="flex h-full min-h-0 w-full flex-row overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col gap-4 p-6 overflow-y-auto border-r border-[var(--border-subtle)]">
              <QrContentEditor />
              <QrBeautifyPanel />
            </div>

            <div className="flex w-[420px] xl:w-[460px] 2xl:w-[500px] shrink-0 flex-col gap-4 overflow-y-auto p-4 xl:p-6 bg-[var(--bg-sunken)]/30">
              <QrPreviewPanel />
              <QrExportControls />
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-0 w-full flex-col gap-4 overflow-y-auto p-3 sm:p-4">
            <div className="flex flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]/40">
              <QrPreviewPanel />
            </div>

            <QrContentEditor />
            <QrBeautifyPanel />
            <QrExportControls />
          </div>
        )
      )}

      {activeQrCodeView === 'scanner' && <QrScannerView />}
      {activeQrCodeView === 'compare' && <QrCompareView />}
      {activeQrCodeView === 'batch' && <QrBatchView />}
      {activeQrCodeView === 'history' && <QrHistoryView />}
      {activeQrCodeView === 'templates' && <QrTemplatesView />}
      {activeQrCodeView === 'settings' && <QrSettingsView />}

      <QrInfoModal />
      <QrFullscreenModal />
    </div>
  )
}
