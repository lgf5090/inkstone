import { useEffect } from 'react'
import { useToolsStore } from '../store'
import { useShortlinksStore } from './store'
import { DashboardView } from './DashboardView'
import { LinksView } from './LinksView'
import { LinkDetailView } from './LinkDetailView'
import { BundlesView } from './BundlesView'
import { SettingsView } from './SettingsView'
import { CreateLinkModal } from './modals/CreateLinkModal'
import { EditLinkModal } from './modals/EditLinkModal'
import { AddSlugModal } from './modals/AddSlugModal'
import { QrCodeModal } from './modals/QrCodeModal'
import { CreateBundleModal } from './modals/CreateBundleModal'
import { ManageBundleLinksModal } from './modals/ManageBundleLinksModal'
import { BreakdownModal } from './modals/BreakdownModal'
import { ImportModal } from './modals/ImportModal'

export function ShortlinksApp() {
  const activeView = useToolsStore((s) => s.activeShortlinksView)
  const activeLinkId = useShortlinksStore((s) => s.activeLinkId)
  const fetchBundles = useShortlinksStore((s) => s.fetchBundles)
  const fetchSettings = useShortlinksStore((s) => s.fetchSettings)

  useEffect(() => {
    // Bundles feed the selectors and badges; settings seed the analytics range.
    void fetchBundles()
    void fetchSettings()
  }, [fetchBundles, fetchSettings])

  return (
    <div
      data-testid="tools-shortlinks-root"
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      {/* Main View Router */}
      <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
        {activeLinkId !== null ? (
          <LinkDetailView />
        ) : activeView === 'dashboard' ? (
          <DashboardView />
        ) : activeView === 'links' ? (
          <LinksView />
        ) : activeView === 'bundles' ? (
          <BundlesView />
        ) : (
          <SettingsView />
        )}
      </div>

      {/* Global Modals */}
      <CreateLinkModal />
      <EditLinkModal />
      <AddSlugModal />
      <QrCodeModal />
      <CreateBundleModal />
      <ManageBundleLinksModal />
      <BreakdownModal />
      <ImportModal />
    </div>
  )
}
