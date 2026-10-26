import { useToolsStore } from '../store'
import { IdPhotoUploadCard } from './content/IdPhotoUploadCard'
import { IdPhotoOptionsPanel } from './options/IdPhotoOptionsPanel'
import { IdPhotoPreviewCard } from './preview/IdPhotoPreviewCard'
import { IdPhotoExportControls } from './export/IdPhotoExportControls'
import { IdPhotoComplianceView } from './compliance/IdPhotoComplianceView'
import { IdPhotoPrintView } from './print/IdPhotoPrintView'
import { IdPhotoBatchView } from './batch/IdPhotoBatchView'
import { IdPhotoSpecsView } from './specs/IdPhotoSpecsView'
import { IdPhotoHistoryView } from './history/IdPhotoHistoryView'
import { IdPhotoSettingsView } from './settings/IdPhotoSettingsView'

export function IdPhotoApp() {
  const activeIdPhotoView = useToolsStore((s) => s.activeIdPhotoView)

  return (
    <div
      data-testid="id-photo-app-root"
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      {activeIdPhotoView === 'studio' && (
        <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto lg:overflow-hidden lg:flex-row">
          {/* Mobile Top Preview */}
          <div className="flex flex-col gap-4 p-3 sm:p-4 lg:hidden bg-[var(--bg-sunken)]/40 border-b border-[var(--border-subtle)] shrink-0">
            <IdPhotoPreviewCard />
          </div>

          {/* Left / Middle Settings and Image Setup Area */}
          <div className="flex min-h-0 flex-1 flex-col gap-4 p-3 sm:p-4 lg:p-6 lg:overflow-y-auto lg:border-r border-[var(--border-subtle)]">
            <IdPhotoUploadCard />
            <IdPhotoOptionsPanel />
            <div className="lg:hidden mt-2">
              <IdPhotoExportControls />
            </div>
          </div>

          {/* Right Preview and Export Controls on Large Screens */}
          <div className="hidden lg:flex w-[420px] xl:w-[460px] 2xl:w-[500px] shrink-0 flex-col gap-4 overflow-y-auto p-4 xl:p-6 bg-[var(--bg-sunken)]/30">
            <IdPhotoPreviewCard />
            <IdPhotoExportControls />
          </div>
        </div>
      )}

      {activeIdPhotoView === 'compliance' && <IdPhotoComplianceView />}
      {activeIdPhotoView === 'print' && <IdPhotoPrintView />}
      {activeIdPhotoView === 'batch' && <IdPhotoBatchView />}
      {activeIdPhotoView === 'specs' && <IdPhotoSpecsView />}
      {activeIdPhotoView === 'history' && <IdPhotoHistoryView />}
      {activeIdPhotoView === 'settings' && <IdPhotoSettingsView />}
    </div>
  )
}
