import { useToolsStore } from '../store'
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

export function QrCodeApp() {
  const activeQrCodeView = useToolsStore((s) => s.activeQrCodeView)

  return (
    <div
      data-testid="qrcode-app-root"
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      {activeQrCodeView === 'generator' && (
        <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto lg:overflow-hidden lg:flex-row">
          <div className="flex flex-col gap-4 p-3 sm:p-4 lg:hidden bg-[var(--bg-sunken)]/40 border-b border-[var(--border-subtle)] shrink-0">
            <QrPreviewPanel />
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-4 p-3 sm:p-4 lg:p-6 lg:overflow-y-auto lg:border-r border-[var(--border-subtle)]">
            <QrContentEditor />
            <QrBeautifyPanel />
            <div className="lg:hidden mt-2">
              <QrExportControls />
            </div>
          </div>

          <div className="hidden lg:flex w-[420px] xl:w-[460px] 2xl:w-[500px] shrink-0 flex-col gap-4 overflow-y-auto p-4 xl:p-6 bg-[var(--bg-sunken)]/30">
            <QrPreviewPanel />
            <QrExportControls />
          </div>
        </div>
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
