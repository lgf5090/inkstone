/**
 * The ScriptsHub container.
 *
 * Desktop keeps the rail, the list and the editor on screen together; a phone shows the list and
 * opens the editor over it, because three columns on 390px is a strip of each. Import and export live
 * in the one header the whole app shares, and `Ctrl/Cmd+K` focuses the list's search from anywhere in
 * this container — the closest thing to the global quick search a single app can offer without
 * taking over the shell's own palette.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Download, Menu as MenuIcon, PanelLeft, Upload } from 'lucide-react'
import { t } from '../../lib/i18n'
import { navigateToPath, usePathname } from '../../lib/app-history'
import { useBreakpoint } from '../../lib/hooks'
import { useUi } from '../../store/ui'
import { Button, IconButton } from '../../components/primitives'
import { Menu, hasOpenLayer, type MenuItem } from '../../components/overlay'
import { AssistantDock } from '../chat/AssistantDock'
import { SnippetsSidebar } from './sidebar'
import { SnippetList } from './snippet-list'
import { SnippetEditor, EditorError, EditorLoading, EditorPlaceholder } from './snippet-editor'
import { StatsPage } from './stats-page'
import { ImportDialog } from './import-dialog'
import { scriptshubApi } from './api'
import { useScriptsHub, folderPathOf } from './store'
import { buildScriptsHubPageContext } from './assistant-context'

function downloadText(text: string, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function ScriptsHubApp() {
  const pathname = usePathname()
  const breakpoint = useBreakpoint()
  const mobile = breakpoint === 'mobile'
  const bootstrap = useScriptsHub((state) => state.bootstrap)
  const overview = useScriptsHub((state) => state.overview)
  const query = useScriptsHub((state) => state.query)
  const snippets = useScriptsHub((state) => state.snippets)
  const selectedId = useScriptsHub((state) => state.selectedId)
  const detail = useScriptsHub((state) => state.detail)
  const detailLoading = useScriptsHub((state) => state.detailLoading)
  const detailError = useScriptsHub((state) => state.detailError)
  const select = useScriptsHub((state) => state.select)
  const assistantDockOpen = useUi((state) => state.assistantDockOpen)
  const toast = useUi((state) => state.toast)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const exportAnchor = useRef<HTMLButtonElement>(null)
  const isStats = pathname === '/scripts/stats' || pathname.startsWith('/scripts/stats?')
  const folders = overview?.folders ?? []
  const tags = overview?.tags ?? []

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      if (hasOpenLayer()) return
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const pageContext = useMemo(() => {
    const folder = query.folderId ? folderPathOf(folders, query.folderId).map((entry) => entry.name).join(' / ') : ''
    const tag = query.tagId ? tags.find((entry) => entry.id === query.tagId)?.name ?? null : null
    return buildScriptsHubPageContext({
      folderPath: folder,
      tagName: tag,
      quick: query.quick ?? 'all',
      search: query.search ?? '',
      visible: snippets.length,
      selected: detail,
      items: snippets,
    })
  }, [detail, folders, query.folderId, query.quick, query.search, query.tagId, snippets, tags])

  const exportItems: MenuItem[] = [
    {
      id: 'generic',
      label: t('scriptshub.export.generic'),
      icon: <Download size={13} aria-hidden="true" />,
      onSelect: () => void runExport('generic'),
    },
    {
      id: 'masscode',
      label: t('scriptshub.export.masscode'),
      onSelect: () => void runExport('masscode'),
    },
    {
      id: 'vscode',
      label: t('scriptshub.export.vscode'),
      onSelect: () => void runExport('vscode'),
    },
  ]

  async function runExport(format: 'generic' | 'masscode' | 'vscode'): Promise<void> {
    try {
      const text = await scriptshubApi.exportEntries(format)
      downloadText(text, `scriptshub-${format}.json`, 'application/json;charset=utf-8')
      toast({ title: t('scriptshub.export.done'), tone: 'success' })
    } catch (error) {
      toast({ title: t('scriptshub.export.failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  if (isStats) {
    return <StatsPage onBack={() => navigateToPath('/scripts')} />
  }

  const editor = detail
    ? <SnippetEditor detail={detail} folders={folders} tags={tags} mobile={mobile} onBack={() => void select(null)} />
    : detailLoading
      ? <EditorLoading />
      : detailError
        ? <EditorError message={detailError} onRetry={() => { if (selectedId) void select(selectedId) }} />
        : (
          <EditorPlaceholder
            art="notes"
            title={t('scriptshub.editor.empty_title')}
            description={t('scriptshub.editor.empty_body')}
            action={(
              <Button
                variant="primary"
                onClick={() => {
                  void useScriptsHub.getState().create({
                    title: t('scriptshub.defaults.new_title'),
                    folderId: useScriptsHub.getState().query.folderId,
                    language: 'shell',
                  })
                }}
              >
                {t('scriptshub.sidebar.new_snippet')}
              </Button>
            )}
          />
        )

  if (mobile) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
        <header className="flex items-center gap-1.5 border-b border-[var(--border-subtle)] px-2 py-2">
          <IconButton label={t('scriptshub.sidebar.title')} onClick={() => setDrawerOpen(true)}>
            <MenuIcon size={17} aria-hidden="true" />
          </IconButton>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('scriptshub.sidebar.title')}</p>
            <p className="truncate text-[length:var(--text-10)] text-[var(--text-quaternary)]">{t('scriptshub.list.count', { count: snippets.length })}</p>
          </div>
          <IconButton label={t('scriptshub.import.title')} onClick={() => setImportOpen(true)}>
            <Upload size={16} aria-hidden="true" />
          </IconButton>
          <IconButton ref={exportAnchor} label={t('scriptshub.export.title')} onClick={() => setExportOpen(true)}>
            <Download size={16} aria-hidden="true" />
          </IconButton>
          <IconButton label={t('scriptshub.assistant.toggle')} active={assistantDockOpen} onClick={() => useUi.getState().setAssistantDock(!assistantDockOpen)}>
            <Bot size={16} aria-hidden="true" />
          </IconButton>
          <Menu anchor={exportAnchor} open={exportOpen} onClose={() => setExportOpen(false)} items={exportItems} align="end" width={200} />
        </header>
        <div className="min-h-0 flex-1">
          <SnippetList searchRef={searchRef} onOpenDetail={() => undefined} />
        </div>
        {selectedId && (
          <div className="fixed inset-0 z-[var(--z-drawer)] flex flex-col bg-[var(--bg-base)] pt-[env(safe-area-inset-top)]">
            <div className="min-h-0 flex-1">{editor}</div>
          </div>
        )}
        {drawerOpen && <SnippetsSidebar mobile onNavigate={() => setDrawerOpen(false)} />}
        <ImportDialog open={importOpen} folders={folders} onClose={() => setImportOpen(false)} onImported={() => void bootstrap()} />
        {assistantDockOpen && <AssistantDock surface="scriptshub" pageContext={pageContext} />}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] px-3">
        <IconButton
          label={t('scriptshub.sidebar.toggle')}
          active={sidebarOpen}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          <PanelLeft size={15} aria-hidden="true" />
        </IconButton>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">{t('scriptshub.sidebar.title')}</h1>
        </div>
        <Button size="sm" variant="ghost" icon={<Upload size={13} aria-hidden="true" />} onClick={() => setImportOpen(true)}>
          {t('scriptshub.import.title')}
        </Button>
        <Button ref={exportAnchor} size="sm" variant="ghost" icon={<Download size={13} aria-hidden="true" />} onClick={() => setExportOpen(true)}>
          {t('scriptshub.export.title')}
        </Button>
        <Menu anchor={exportAnchor} open={exportOpen} onClose={() => setExportOpen(false)} items={exportItems} align="end" width={200} />
        <IconButton label={t('scriptshub.assistant.toggle')} active={assistantDockOpen} onClick={() => useUi.getState().setAssistantDock(!assistantDockOpen)}>
          <Bot size={17} aria-hidden="true" />
        </IconButton>
      </header>
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && <SnippetsSidebar />}
        <SnippetList searchRef={searchRef} />
        <div className="min-w-0 flex-1">{editor}</div>
        {assistantDockOpen && <AssistantDock surface="scriptshub" pageContext={pageContext} />}
      </div>
      <ImportDialog open={importOpen} folders={folders} onClose={() => setImportOpen(false)} onImported={() => void bootstrap()} />
    </div>
  )
}
