import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { Send } from 'lucide-react'
import { newApiTesterId } from '@shared/development/api-tester/ids'
import { defaultRequest } from '@shared/development/api-tester/state'
import { t } from '../../../lib/i18n'
import { useBreakpoint } from '../../../lib/hooks'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { Button } from '../../../components/primitives'
import { Drawer } from '../../../components/overlay'
import { useApiTesterStore } from './store'
import { sendActiveRequest } from './send'
import { isSendShortcut } from './lib/shortcut'
import { closeAllWsSessions } from './ws-session'
import { AppToolbar, type ToolbarDialog } from './components/AppToolbar'
import { TabBar } from './components/TabBar'
import { ConflictBanner } from './components/ConflictBanner'
import { Resizer } from '../../shell/Resizer'
import { EnvironmentDialog } from './components/EnvironmentDialog'
import { WorkspaceManagerDialog } from './components/WorkspaceManagerDialog'
import { HistoryDialog } from './components/HistoryDialog'
import { CurlImportDialog } from './components/CurlImportDialog'
import { ImportExportDialog } from './components/ImportExportDialog'
import { MockGeneratorDialog } from './components/MockGeneratorDialog'
import { TagManagerHost } from './components/TagManagerHost'
import { CollectionRunner } from './components/CollectionRunner'
import type { CollectionNode } from '@shared/development/api-tester/types'

const CollectionsPanel = lazy(() =>
  import('./components/CollectionsPanel').then((module) => ({ default: module.CollectionsPanel })),
)
const WorkspaceView = lazy(() =>
  import('./components/WorkspaceView').then((module) => ({ default: module.WorkspaceView })),
)

export function ApiTesterApp() {
  const breakpoint = useBreakpoint()
  const compact = breakpoint !== 'desktop'
  const [dialog, setDialog] = useState<ToolbarDialog | null>(null)
  const [collectionsOpen, setCollectionsOpen] = useState(false)
  const [runnerFolder, setRunnerFolder] = useState<CollectionNode | null>(null)
  const [collectionWidth, setCollectionWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem('inkstone.development.api-tester.collections-width'))
      return Number.isFinite(stored) && stored >= 160 ? Math.min(420, Math.max(160, stored)) : 260
    } catch {
      return 260
    }
  })

  const loaded = useApiTesterStore((s) => s.loaded)
  const loading = useApiTesterStore((s) => s.loading)
  const loadError = useApiTesterStore((s) => s.loadError)
  const activeId = useApiTesterStore((s) => s.activeId)
  const openTabs = useApiTesterStore((s) => s.openTabs)
  const state = useApiTesterStore((s) => s.state)
  const results = useApiTesterStore((s) => s.results)
  const loadingTabs = useApiTesterStore((s) => s.loadingTabs)
  const testResults = useApiTesterStore((s) => s.testResults)
  const activeNode = state.nodes.find((node) => node.id === activeId) ?? null
  const tabs = useMemo(
    () => openTabs.map((id) => state.nodes.find((node) => node.id === id)).filter((node): node is NonNullable<typeof node> => Boolean(node)),
    [openTabs, state.nodes],
  )

  useEffect(() => {
    void useApiTesterStore.getState().initialize()
    return () => {
      void useApiTesterStore.getState().flush()
      closeAllWsSessions()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSendShortcut(event)) return
      const store = useApiTesterStore.getState()
      const node = store.state.nodes.find((entry) => entry.id === store.activeId)
      if (!node || node.type !== 'request' || node.kind === 'websocket' || !node.request) return
      // A modal owns the keyboard while it is open; sending behind it would be a surprise.
      if (document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      void sendActiveRequest()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const createRest = () => {
    const node = {
      id: newApiTesterId(),
      type: 'request' as const,
      kind: 'rest' as const,
      name: t('development.apitester.new_request_name'),
      parentId: null,
      order: Date.now(),
      tags: [],
      request: defaultRequest(),
      updatedAt: Date.now(),
    }
    useApiTesterStore.getState().addNode(node)
  }

  return (
    <div data-testid="api-tester-app-root" className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]">
      <AppToolbar compact={compact} onOpen={setDialog} onOpenCollections={() => setCollectionsOpen(true)} />
      <TabBar
        tabs={tabs}
        activeId={activeId}
        results={results}
        loading={loadingTabs}
        onSelect={(id) => useApiTesterStore.getState().setActiveTab(id)}
        onClose={(id) => useApiTesterStore.getState().closeTab(id)}
      />
      <ConflictBanner />
      <div className="relative flex min-h-0 flex-1">
        {!compact && loaded && (
          <div style={{ width: collectionWidth }} className="shrink-0 overflow-hidden border-r border-[var(--border-subtle)]">
            <Suspense fallback={<LoadingBlock />}>
              <CollectionsPanel
                compact={false}
                onOpenTagManager={() => undefined}
                onRunCollection={(folder) => { setRunnerFolder(folder); setCollectionsOpen(false) }}
                onRequestClose={() => setCollectionsOpen(false)}
              />
            </Suspense>
          </div>
        )}
        {!compact && loaded && (
          <Resizer
            label={t('development.apitester.collections.resize')}
            value={collectionWidth}
            min={160}
            max={420}
            onChange={(width) => {
              setCollectionWidth(width)
              try { localStorage.setItem('inkstone.development.api-tester.collections-width', String(width)) } catch { /* storage may be unavailable */ }
            }}
            onReset={() => setCollectionWidth(260)}
          />
        )}
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {loading || !loaded ? (
            <LoadingBlock label={t('development.apitester.loading')} />
          ) : loadError ? (
            <div className="flex h-full items-center justify-center p-6">
              <Empty
                title={t('development.apitester.load_failed', { msg: loadError })}
                action={<Button size="sm" onClick={() => void useApiTesterStore.getState().initialize()}>{t('development.apitester.retry')}</Button>}
              />
            </div>
          ) : activeNode ? (
            <Suspense fallback={<LoadingBlock />}>
              <WorkspaceView
                node={activeNode}
                result={activeId ? results[activeId] ?? null : null}
                loading={activeId ? Boolean(loadingTabs[activeId]) : false}
                testResults={activeId ? testResults[activeId] : undefined}
                onSend={() => void sendActiveRequest()}
                compact={compact}
              />
            </Suspense>
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <Empty
                art="select"
                title={t('development.apitester.app.empty_title')}
                description={t('development.apitester.app.empty_hint')}
                action={
                  <Button size="sm" className="gap-1" onClick={createRest}>
                    <Send size={14} /> {t('development.apitester.app.new_rest')}
                  </Button>
                }
              />
            </div>
          )}
        </main>
      </div>
      <Drawer
        open={compact && collectionsOpen}
        onClose={() => setCollectionsOpen(false)}
        side="left"
        width={340}
        title={t('development.apitester.collections')}
        bodyClassName="p-0"
      >
        <Suspense fallback={<LoadingBlock />}>
          <CollectionsPanel
            compact
            onOpenTagManager={() => { setCollectionsOpen(false); setDialog('tags') }}
            onRunCollection={(folder) => { setRunnerFolder(folder); setCollectionsOpen(false) }}
            onRequestClose={() => setCollectionsOpen(false)}
          />
        </Suspense>
      </Drawer>
      <EnvironmentDialog open={dialog === 'env'} onClose={() => setDialog(null)} />
      <WorkspaceManagerDialog open={dialog === 'workspaces'} onClose={() => setDialog(null)} />
      <HistoryDialog open={dialog === 'history'} onClose={() => setDialog(null)} />
      <CurlImportDialog
        open={dialog === 'curl'}
        onClose={() => setDialog(null)}
        onImport={(request, name) => {
          useApiTesterStore.getState().addNode({
            id: newApiTesterId(),
            type: 'request',
            kind: 'rest',
            name,
            parentId: null,
            order: Date.now(),
            tags: [],
            request,
            updatedAt: Date.now(),
          })
          setDialog(null)
        }}
      />
      <ImportExportDialog open={dialog === 'io'} onClose={() => setDialog(null)} />
      <MockGeneratorDialog open={dialog === 'mock'} onClose={() => setDialog(null)} />
      <TagManagerHost open={dialog === 'tags'} onClose={() => setDialog(null)} />
      <CollectionRunner open={runnerFolder !== null} folder={runnerFolder} onClose={() => setRunnerFolder(null)} />
      <span className="sr-only" data-dialog={dialog ?? ''} />
    </div>
  )
}
