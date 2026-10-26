import { useToolsStore } from '../store'
import { QrContentEditor } from './content/QrContentEditor'
import { QrBeautifyPanel } from './options/QrBeautifyPanel'
import { QrPreviewPanel } from './preview/QrPreviewPanel'
import { QrExportControls } from './export/QrExportControls'
import { QrHistoryView } from './history/QrHistoryView'
import { QrTemplatesView } from './templates/QrTemplatesView'
import { QrSettingsView } from './settings/QrSettingsView'

export function QrCodeApp() {
  const activeQrCodeView = useToolsStore((s) => s.activeQrCodeView)

  return (
    <div
      data-testid="qrcode-app-root"
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      {activeQrCodeView === 'generator' && (
        <div className="flex h-full min-h-0 w-full flex-col lg:flex-row overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 border-r border-[var(--border-subtle)]">
            <QrContentEditor />
            <QrBeautifyPanel />
          </div>

          <div className="flex w-full lg:w-[420px] shrink-0 flex-col gap-4 overflow-y-auto p-4 bg-[var(--bg-sunken)]/40">
            <QrPreviewPanel />
            <QrExportControls />
          </div>
        </div>
      )}

      {activeQrCodeView === 'history' && <QrHistoryView />}
      {activeQrCodeView === 'templates' && <QrTemplatesView />}
      {activeQrCodeView === 'settings' && <QrSettingsView />}
    </div>
  )
}
