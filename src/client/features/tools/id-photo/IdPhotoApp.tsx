import { useEffect } from 'react'
import { useMediaQuery } from '../../../lib/hooks'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { useToolsStore } from '../store'
import { useIdPhotoStore } from './store'
import { IdPhotoUploadCard } from './content/IdPhotoUploadCard'
import { IdPhotoOptionsPanel } from './options/IdPhotoOptionsPanel'
import { IdPhotoPreviewCard } from './preview/IdPhotoPreviewCard'
import { IdPhotoFullscreenModal } from './preview/IdPhotoFullscreenModal'
import { CustomSpecModal } from './specs/CustomSpecModal'
import { IdPhotoExportControls } from './export/IdPhotoExportControls'
import { IdPhotoComplianceView } from './compliance/IdPhotoComplianceView'
import { IdPhotoCompareView } from './compare/IdPhotoCompareView'
import { IdPhotoPrintView } from './print/IdPhotoPrintView'
import { IdPhotoBatchView } from './batch/IdPhotoBatchView'
import { IdPhotoSpecsView } from './specs/IdPhotoSpecsView'
import { IdPhotoHistoryView } from './history/IdPhotoHistoryView'
import { IdPhotoSettingsView } from './settings/IdPhotoSettingsView'

export function IdPhotoApp() {
  const activeIdPhotoView = useToolsStore((s) => s.activeIdPhotoView)
  const loadCustomSpecs = useIdPhotoStore((s) => s.loadCustomSpecs)
  const loadPreferences = useIdPhotoStore((s) => s.loadPreferences)

  const isWide = useMediaQuery('(min-width: 1024px)')
  const customSpecModalOpen = useIdPhotoStore((s) => s.customSpecModalOpen)
  const setCustomSpecModalOpen = useIdPhotoStore((s) => s.setCustomSpecModalOpen)

  useEffect(() => {
    const boot = async () => {
      try {
        await loadCustomSpecs()
      } catch {
        useUi.getState().toast({ title: t('tools.id_photo.specs.load_failed'), tone: 'danger' })
      }
      try {
        await loadPreferences()
      } catch {
        useUi.getState().toast({ title: t('tools.id_photo.settings.load_failed'), tone: 'danger' })
      }
    }
    void boot()
  }, [loadCustomSpecs, loadPreferences])

  return (
    <div
      data-testid="id-photo-app-root"
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      {activeIdPhotoView === 'studio' && isWide && (
        <div className="flex h-full min-h-0 w-full flex-row overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col gap-4 p-6 overflow-y-auto border-r border-[var(--border-subtle)]">
            <IdPhotoUploadCard />
            <IdPhotoOptionsPanel />
          </div>

          <div className="flex w-[420px] xl:w-[460px] 2xl:w-[500px] shrink-0 flex-col gap-4 overflow-y-auto p-4 xl:p-6 bg-[var(--bg-sunken)]/30">
            <IdPhotoPreviewCard />
            <IdPhotoExportControls />
          </div>
        </div>
      )}

      {activeIdPhotoView === 'studio' && !isWide && (
        <div className="flex h-full min-h-0 w-full flex-col gap-4 overflow-y-auto p-3 sm:p-4">
          <IdPhotoPreviewCard />
          <IdPhotoUploadCard />
          <IdPhotoOptionsPanel />
          <IdPhotoExportControls />
        </div>
      )}

      {activeIdPhotoView === 'compliance' && <IdPhotoComplianceView />}
      {activeIdPhotoView === 'compare' && <IdPhotoCompareView />}
      {activeIdPhotoView === 'print' && <IdPhotoPrintView />}
      {activeIdPhotoView === 'batch' && <IdPhotoBatchView />}
      {activeIdPhotoView === 'specs' && <IdPhotoSpecsView />}
      {activeIdPhotoView === 'history' && <IdPhotoHistoryView />}
      {activeIdPhotoView === 'settings' && <IdPhotoSettingsView />}

      <IdPhotoFullscreenModal />
      <CustomSpecModal
        open={customSpecModalOpen}
        onClose={() => setCustomSpecModalOpen(false)}
      />
    </div>
  )
}
