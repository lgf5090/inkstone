/**
 * The Prompt Optimizer container.
 *
 * It owns the address-to-view reading, the one-time hydration and the modal that settles a draft
 * conflict; each screen below it owns its own layout.
 */

import { useEffect } from 'react'
import { useSearch, usePathname } from '../../../lib/app-history'
import { t } from '../../../lib/i18n'
import { Modal } from '../../../components/overlay'
import { Button } from '../../../components/primitives'
import { LoadingBlock } from '../../../components/feedback'
import { promptOptimizerViewFromSearch, usePromptOptimizerStore } from './store'
import { WorkspaceView } from './views/WorkspaceView'
import { ArenaView } from './views/ArenaView'
import { FavoritesView } from './views/FavoritesView'
import { TemplatesView } from './views/TemplatesView'
import { HistoryView } from './views/HistoryView'
import { SettingsView } from './views/SettingsView'

export function PromptOptimizerApp() {
  const search = useSearch()
  const pathname = usePathname()
  const activeView = usePromptOptimizerStore((s) => s.activeView)
  const loading = usePromptOptimizerStore((s) => s.loading)
  const settings = usePromptOptimizerStore((s) => s.settings)
  const conflictWorkspace = usePromptOptimizerStore((s) => s.conflictWorkspace)
  const conflictSession = usePromptOptimizerStore((s) => s.conflictSession)
  const hydrate = usePromptOptimizerStore((s) => s.hydrate)
  const setActiveView = usePromptOptimizerStore((s) => s.setActiveView)
  const reloadWorkspace = usePromptOptimizerStore((s) => s.reloadWorkspace)
  const overwriteConflict = usePromptOptimizerStore((s) => s.overwriteConflict)
  const dismissConflict = usePromptOptimizerStore((s) => s.dismissConflict)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    // `settings` is the hydration marker: effects in the same commit still see the pre-hydration
    // values, so a direct `?view=` load would otherwise switch workspaces and persist an empty draft
    // at revision 0 before the real session arrives.
    if (loading || !settings || !pathname.startsWith('/tools/prompt_optimizer')) return
    const view = promptOptimizerViewFromSearch(search)
    if (view && view !== usePromptOptimizerStore.getState().activeView) void setActiveView(view)
  }, [search, pathname, loading, settings, setActiveView])

  if (loading && !settings) return <LoadingBlock />

  return (
    <div
      data-testid="tools-prompt-optimizer-root"
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeView === 'arena' ? (
          <ArenaView />
        ) : activeView === 'favorites' ? (
          <FavoritesView />
        ) : activeView === 'templates' ? (
          <TemplatesView />
        ) : activeView === 'history' ? (
          <HistoryView />
        ) : activeView === 'settings' ? (
          <SettingsView />
        ) : (
          <WorkspaceView />
        )}
      </div>

      <Modal
        open={Boolean(conflictWorkspace && conflictSession)}
        onClose={dismissConflict}
        title={t('tools.prompt_optimizer.common.conflict')}
        description={t('tools.prompt_optimizer.common.conflict_hint')}
        footer={(
          <div className="flex justify-end gap-2">
            <Button onClick={() => { dismissConflict(); void reloadWorkspace() }}>
              {t('tools.prompt_optimizer.common.reload')}
            </Button>
            <Button variant="primary" onClick={() => void overwriteConflict()}>
              {t('tools.prompt_optimizer.common.overwrite')}
            </Button>
          </div>
        )}
      >
        <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">
          {conflictSession ? new Date(conflictSession.updatedAt).toLocaleString() : ''}
        </p>
      </Modal>
    </div>
  )
}
