import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Code2,
  Database,
  FileCode2,
  GitBranch,
  Loader2,
  Menu as MenuIcon,
  Pencil,
  Plus,
  Table2,
  Trash2,
  X,
} from 'lucide-react'
import type { DatabaseConnectionView, SchemaModel } from '@shared/development/database/types'
import { useBreakpoint } from '../../../lib/hooks'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { useUi } from '../../../store/ui'
import { ApiError } from '../../../lib/api'
import { copyText } from '../../../lib/clipboard'
import { Button, IconButton } from '../../../components/primitives'
import { Empty } from '../../../components/feedback'
import { Drawer, Menu, Modal, Tooltip, confirm } from '../../../components/overlay'
import { Resizer } from '../../shell/Resizer'
import { ConnectionDialog } from './ConnectionDialog'
import { StudioSidebar, type ConnectionFilter } from './StudioSidebar'
import { QueryTab } from './QueryTab'
import { DataTable } from './DataTable'
import { SchemaEditor } from './SchemaEditor'
import { MassDropPanel } from './MassDropPanel'
import { ErdView } from './ErdView'
import {
  createDriver,
  type StudioDriver,
} from './drivers'
import { deleteConnection, listConnections, saveConnectionOrder, updateConnectionFlags } from './api'
import { loadSchema } from './schema-utils'
import { loadStudioLayout, saveStudioLayout, STUDIO_SIDEBAR_WIDTH } from './layout'
import type { StudioSelection, StudioTab, StudioTabKind } from './types'

const EMPTY_SCHEMA: SchemaModel = { tables: [], views: [], triggers: [], indexes: [] }

let tabSeq = 0
function nextTabId(): string {
  tabSeq += 1
  return `db-${Date.now()}-${tabSeq}`
}

function queryTab(initialSql?: string): StudioTab {
  return { id: nextTabId(), kind: 'query', initialSql }
}

function sortConnections(list: DatabaseConnectionView[]): DatabaseConnectionView[] {
  return [...list].sort((left, right) => {
    if (left.isPinned !== right.isPinned) return left.isPinned ? -1 : 1
    if (left.isFavorite !== right.isFavorite) return left.isFavorite ? -1 : 1
    if (left.sort !== right.sort) return left.sort - right.sort
    return left.id.localeCompare(right.id)
  })
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

function tabKindIcon(kind: StudioTabKind) {
  if (kind === 'data') return <Table2 size={13} />
  if (kind === 'schema') return <Pencil size={13} />
  if (kind === 'tools') return <Trash2 size={13} />
  if (kind === 'erd') return <GitBranch size={13} />
  return <FileCode2 size={13} />
}

export function StudioApp() {
  const breakpoint = useBreakpoint()
  const isSmall = breakpoint === 'mobile' || breakpoint === 'tablet'
  const initialLayout = useMemo(loadStudioLayout, [])
  const [connections, setConnections] = useState<DatabaseConnectionView[]>([])
  const [connectionsLoading, setConnectionsLoading] = useState(true)
  const [selection, setSelection] = useState<StudioSelection | null>(null)
  const [localFile, setLocalFile] = useState<{ name: string; file: File } | null>(null)
  const [schema, setSchema] = useState<SchemaModel | null>(null)
  const [schemaError, setSchemaError] = useState<string | null>(null)
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [driver, setDriver] = useState<StudioDriver | null>(null)
  const [tabs, setTabs] = useState<StudioTab[]>(() => [queryTab()])
  const [activeTabId, setActiveTabId] = useState('')
  const [connSearch, setConnSearch] = useState('')
  const [connFilter, setConnFilter] = useState<ConnectionFilter>('all')
  const [tableSearch, setTableSearch] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(
    initialLayout.sidebarWidth ?? STUDIO_SIDEBAR_WIDTH.default,
  )
  const autoWidth = useRef(initialLayout.sidebarWidth === undefined)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(Boolean(initialLayout.sidebarCollapsed))
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingConnection, setEditingConnection] = useState<DatabaseConnectionView | null>(null)
  const [sqlViewOpen, setSqlViewOpen] = useState<string | null>(null)
  const menuAnchor = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null

  const notify = useCallback((title: string, description?: string, tone: 'default' | 'success' | 'warning' | 'danger' = 'danger') => {
    useUi.getState().toast({ title, description, tone })
  }, [])

  const notifyError = useCallback((message: string) => {
    notify(t('development.database.error.title'), message, 'danger')
  }, [notify])

  const refreshConnections = useCallback(async () => {
    setConnectionsLoading(true)
    try {
      const list = sortConnections(await listConnections())
      setConnections(list)
      setSelection((current) => {
        if (!current || current.kind !== 'saved') return current
        return list.some((connection) => connection.id === current.id) ? current : null
      })
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    } finally {
      setConnectionsLoading(false)
    }
  }, [notifyError])

  useEffect(() => {
    void refreshConnections()
  }, [refreshConnections])

  useEffect(() => {
    if (!activeTabId && tabs.length > 0) setActiveTabId(tabs[0]!.id)
  }, [activeTabId, tabs])

  useEffect(() => {
    saveStudioLayout({ sidebarWidth, sidebarCollapsed })
  }, [sidebarWidth, sidebarCollapsed])

  useEffect(() => {
    if (!autoWidth.current) return
    const measure = (name: string) => {
      let width = 0
      for (const character of name) width += character.charCodeAt(0) > 255 ? 14 : 7.5
      return width
    }
    const estimated = Math.min(STUDIO_SIDEBAR_WIDTH.max, Math.max(
      STUDIO_SIDEBAR_WIDTH.default,
      ...connections.map((connection) => measure(connection.name) + 176),
      ...(schema?.tables.map((table) => measure(table.name) + 64) ?? []),
    ))
    setSidebarWidth((current) => Math.max(current, estimated))
  }, [connections, schema])

  const activeSaved = selection?.kind === 'saved'
    ? connections.find((connection) => connection.id === selection.id) ?? null
    : null

  const reloadSchema = useCallback(async (target: StudioDriver) => {
    setSchemaLoading(true)
    setSchemaError(null)
    try {
      const model = await loadSchema(target)
      setSchema(model)
    } catch (error) {
      setSchema(null)
      const message = error instanceof Error ? error.message : String(error)
      const said = error instanceof ApiError ? error.serverMessage : undefined
      const detail = said && said !== message ? `${message} — ${said}` : message
      setSchemaError(detail)
      notifyError(detail)
    } finally {
      setSchemaLoading(false)
    }
  }, [notifyError])

  useEffect(() => {
    setSchema(null)
    setSchemaError(null)
    setTableSearch('')
    setDriver((previous) => {
      previous?.close()
      return null
    })
    if (!selection) {
      setTabs((current) => current.length ? current : [queryTab()])
      return
    }

    let next: StudioDriver
    try {
      next = selection.kind === 'local'
        ? createDriver({ kind: 'local', label: localFile?.name ?? selection.name, ...(localFile?.file ? { file: localFile.file } : {}) })
        : createDriver({
            kind: 'remote',
            connectionId: selection.id,
            type: activeSaved?.type ?? 'd1',
            label: activeSaved?.name ?? t('development.database.app.title'),
          })
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
      return
    }

    setDriver(next)
    const nextTabs = [queryTab()]
    setTabs(nextTabs)
    setActiveTabId(nextTabs[0]!.id)
    void reloadSchema(next)
    return () => {
      next.close()
    }
  }, [selection, localFile, activeSaved?.type, activeSaved?.name, notifyError, reloadSchema])

  const handleSaved = (connection: DatabaseConnectionView) => {
    setConnections((current) => sortConnections([
      ...current.filter((entry) => entry.id !== connection.id),
      connection,
    ]))
    setSelection({ kind: 'saved', id: connection.id })
    setMobileSidebarOpen(false)
  }

  const handleLocalFile = (file: File) => {
    setLocalFile({ name: file.name, file })
    setSelection({ kind: 'local', name: file.name, file })
    setMobileSidebarOpen(false)
  }

  const handleDelete = async (connection: DatabaseConnectionView) => {
    const ok = await confirm({
      title: t('development.database.app.delete_title', { name: connection.name }),
      description: t('development.database.app.delete_description'),
      confirmLabel: t('development.database.app.delete_connection'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await deleteConnection(connection.id)
      if (selection?.kind === 'saved' && selection.id === connection.id) setSelection(null)
      await refreshConnections()
      notify(t('development.database.app.delete_done', { name: connection.name }), undefined, 'success')
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    }
  }

  const handleFlags = async (connection: DatabaseConnectionView, flags: { isFavorite?: boolean; isPinned?: boolean }) => {
    const next = { ...connection, ...flags }
    setConnections((current) => sortConnections(current.map((entry) => entry.id === connection.id ? next : entry)))
    try {
      const saved = await updateConnectionFlags(connection.id, flags)
      setConnections((current) => sortConnections(current.map((entry) => entry.id === saved.id ? saved : entry)))
    } catch (error) {
      setConnections((current) => sortConnections(current.map((entry) => entry.id === connection.id ? connection : entry)))
      notifyError(error instanceof Error ? error.message : String(error))
    }
  }

  const saveOrder = async (next: DatabaseConnectionView[]) => {
    const previous = connections
    setConnections(next)
    try {
      await saveConnectionOrder(next.map((connection) => connection.id))
    } catch (error) {
      setConnections(previous)
      notifyError(error instanceof Error ? error.message : String(error))
    }
  }

  const handleReorder = (sourceId: string, targetId: string) => {
    const from = connections.findIndex((connection) => connection.id === sourceId)
    const to = connections.findIndex((connection) => connection.id === targetId)
    if (from < 0 || to < 0) return
    void saveOrder(moveItem(connections, from, to))
  }

  const handleMove = (id: string, direction: 'up' | 'down') => {
    const index = connections.findIndex((connection) => connection.id === id)
    if (index < 0) return
    const target = direction === 'up' ? index - 1 : index + 1
    if (target < 0 || target >= connections.length) return
    void saveOrder(moveItem(connections, index, target))
  }

  const openTab = (tab: StudioTab) => {
    const existing = tabs.find((entry) => entry.kind === tab.kind && entry.table === tab.table && tab.kind !== 'query')
    if (existing) {
      setActiveTabId(existing.id)
      if (isSmall) setMobileSidebarOpen(false)
      return
    }
    setTabs((current) => [...current, tab])
    setActiveTabId(tab.id)
    if (isSmall) setMobileSidebarOpen(false)
  }

  const openDataTab = (table: string) => {
    openTab({ id: nextTabId(), kind: 'data', table })
  }

  const openSchemaTab = (table: string) => {
    openTab({ id: nextTabId(), kind: 'schema', table })
  }

  const openQueryTab = (initialSql?: string) => {
    const tab = queryTab(initialSql)
    setTabs((current) => [...current, tab])
    setActiveTabId(tab.id)
    setMenuOpen(false)
  }

  const openToolsTab = () => {
    openTab({ id: nextTabId(), kind: 'tools' })
    setMenuOpen(false)
  }

  const openErdTab = () => {
    openTab({ id: nextTabId(), kind: 'erd' })
    setMenuOpen(false)
  }

  const closeTab = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const next = tabs.filter((tab) => tab.id !== id)
    if (next.length === 0) {
      const replacement = queryTab()
      setTabs([replacement])
      setActiveTabId(replacement.id)
      return
    }
    if (activeTabId === id) setActiveTabId(next[Math.min(index, next.length - 1)]!.id)
    setTabs(next)
  }

  const tabTitle = (tab: StudioTab) => {
    if (tab.kind === 'query') return t('development.database.app.query')
    if (tab.kind === 'tools') return t('development.database.app.mass_ops')
    if (tab.kind === 'erd') return t('development.database.app.erd')
    if (tab.table) return t('development.database.app.tab_with_table', {
      title: tab.kind === 'data' ? t('development.database.app.data') : t('development.database.app.schema'),
      table: tab.table,
    })
    return t('development.database.app.query')
  }

  const activeTable = activeTab?.table
    ? schema?.tables.find((table) => table.name === activeTab.table) ?? null
    : null

  const sidebar = (
    <StudioSidebar
      collapsed={!isSmall && sidebarCollapsed}
      connections={connections}
      loading={connectionsLoading}
      selection={selection}
      localName={localFile?.name}
      schema={schema}
      schemaError={schemaError}
      schemaLoading={schemaLoading}
      onRetrySchema={() => { if (driver) void reloadSchema(driver) }}
      tableSearch={tableSearch}
      onTableSearch={setTableSearch}
      connSearch={connSearch}
      onConnSearch={setConnSearch}
      connFilter={connFilter}
      onConnFilter={setConnFilter}
      onSelectSaved={(id) => {
        setSelection({ kind: 'saved', id })
        setMobileSidebarOpen(false)
      }}
      onSelectLocal={() => {
        if (localFile) {
          setSelection({ kind: 'local', name: localFile.name, file: localFile.file })
          setMobileSidebarOpen(false)
        }
      }}
      onNew={() => {
        setEditingConnection(null)
        setDialogOpen(true)
      }}
      onEdit={(connection) => {
        setEditingConnection(connection)
        setDialogOpen(true)
      }}
      onDelete={(connection) => void handleDelete(connection)}
      onToggleFavorite={(connection) => void handleFlags(connection, { isFavorite: !connection.isFavorite })}
      onTogglePinned={(connection) => void handleFlags(connection, { isPinned: !connection.isPinned })}
      onReorder={handleReorder}
      onMove={handleMove}
      onOpenData={openDataTab}
      onOpenSchema={openSchemaTab}
      onViewSql={setSqlViewOpen}
      onCollapse={() => setSidebarCollapsed(true)}
      onExpand={() => setSidebarCollapsed(false)}
      collapsible={!isSmall}
    />
  )

  const connectionId = selection?.kind === 'saved' ? selection.id : selection?.kind === 'local' ? 'local' : ''
  const connectionType = driver?.type ?? 'd1'

  const main = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-1.5" role="tablist" aria-label={t('development.database.app.tabs')}>
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className={cn(
                'group flex h-8 max-w-52 min-w-0 shrink-0 items-center gap-1 rounded-t-[var(--r-md)] border border-b-0 px-2 text-[length:var(--text-12)]',
                active
                  ? 'border-[var(--border-default)] bg-[var(--bg-base)] text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
              onClick={() => setActiveTabId(tab.id)}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') setActiveTabId(tab.id)
              }}
            >
              {tabKindIcon(tab.kind)}
              <span className="min-w-0 flex-1 truncate">{tabTitle(tab)}</span>
              <button
                type="button"
                aria-label={t('development.database.app.close_tab')}
                title={t('development.database.app.close_tab')}
                onClick={(event) => {
                  event.stopPropagation()
                  closeTab(tab.id)
                }}
                className={cn(
                  'rounded p-0.5 text-[var(--text-quaternary)] hover:text-[var(--text-primary)]',
                  active ? 'opacity-70 group-hover:opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
        <Tooltip label={t('development.database.app.new_tab')}>
          <IconButton
            ref={menuAnchor}
            label={t('development.database.app.new_tab')}
            size="sm"
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <Plus size={14} />
          </IconButton>
        </Tooltip>
        <div className="flex-1" />
        {!isSmall && selection && (
          <span className="max-w-48 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {selection.kind === 'local' ? selection.name : activeSaved?.name}
          </span>
        )}
      </div>

      <Menu
        anchor={menuAnchor}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        label={t('development.database.app.new_tab')}
        items={[
          { id: 'query', label: t('development.database.app.new_query'), icon: <FileCode2 size={13} />, onSelect: () => openQueryTab() },
          { id: 'table', label: t('development.database.app.new_table'), icon: <Pencil size={13} />, disabled: !schema, onSelect: () => { setMenuOpen(false); openTab({ id: nextTabId(), kind: 'schema' }) } },
          { id: 'tools', label: t('development.database.app.mass_ops'), icon: <Trash2 size={13} />, disabled: !schema || schema.tables.length === 0, onSelect: openToolsTab },
          { id: 'erd', label: t('development.database.app.erd'), icon: <GitBranch size={13} />, disabled: !schema || schema.tables.length === 0, onSelect: openErdTab },
        ]}
      />

      <div className="min-h-0 flex-1">
        {!selection ? (
          <Empty
            art="select"
            title={t('development.database.app.connect')}
            description={t('development.database.app.connect_description')}
            action={
              <Button size="sm" onClick={() => { setEditingConnection(null); setDialogOpen(true) }}>
                <Plus size={14} />
                {t('development.database.app.new_connection')}
              </Button>
            }
          />
        ) : !driver || !activeTab ? (
          <div className="flex h-full items-center justify-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            <Loader2 size={14} className="mr-2 animate-spin" />
            {t('development.database.app.connecting')}
          </div>
        ) : activeTab.kind === 'query' ? (
          <QueryTab
            key={activeTab.id}
            driver={driver}
            connectionId={connectionId}
            connectionType={connectionType}
            schemaModel={schema ?? EMPTY_SCHEMA}
            {...(activeTab.initialSql ? { initialSql: activeTab.initialSql } : {})}
            onError={notifyError}
          />
        ) : activeTab.kind === 'data' && activeTable ? (
          <DataTable key={activeTab.id} driver={driver} table={activeTable} onError={notifyError} />
        ) : activeTab.kind === 'data' ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--text-tertiary)]">
            <Table2 size={28} className="opacity-40" />
            <p className="text-[length:var(--text-13)]">
              {t('development.database.app.table_missing', { table: activeTab.table ?? '' })}
            </p>
          </div>
        ) : activeTab.kind === 'schema' ? (
          <SchemaEditor
            key={activeTab.id}
            driver={driver}
            table={activeTable}
            schemaModel={schema ?? EMPTY_SCHEMA}
            onSchemaChanged={() => void reloadSchema(driver)}
            onError={notifyError}
            onOpenSql={(sql) => openQueryTab(sql)}
            onTableCreated={(name) => openDataTab(name)}
          />
        ) : activeTab.kind === 'tools' ? (
          <MassDropPanel
            key={activeTab.id}
            driver={driver}
            tables={schema?.tables ?? []}
            onSchemaChanged={() => void reloadSchema(driver)}
            onError={notifyError}
          />
        ) : activeTab.kind === 'erd' ? (
          <ErdView
            tables={schema?.tables ?? []}
            className="h-full w-full"
            onOpenData={openDataTab}
            onOpenSchema={openSchemaTab}
          />
        ) : null}
      </div>
    </div>
  )

  return (
    <div data-testid="studio-app-root" className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]">
      {isSmall ? (
        <>
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2">
            <Tooltip label={t('development.database.app.sidebar')}>
              <IconButton label={t('development.database.app.sidebar')} size="sm" onClick={() => setMobileSidebarOpen(true)}>
                <MenuIcon size={16} />
              </IconButton>
            </Tooltip>
            <Database size={16} className="shrink-0 text-[var(--accent)]" />
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-14)] font-medium text-[var(--text-primary)]">
              {selection ? (selection.kind === 'local' ? selection.name : activeSaved?.name) : t('development.database.app.title')}
            </span>
            <Tooltip label={t('development.database.app.new_connection')}>
              <IconButton label={t('development.database.app.new_connection')} size="sm" onClick={() => { setEditingConnection(null); setDialogOpen(true) }}>
                <Plus size={16} />
              </IconButton>
            </Tooltip>
          </header>
          <main className="min-h-0 flex-1">{main}</main>
          <Drawer
            open={mobileSidebarOpen}
            onClose={() => setMobileSidebarOpen(false)}
            side="left"
            width={Math.min(380, Math.max(280, sidebarWidth))}
            title={t('development.database.app.title')}
          >
            {sidebar}
          </Drawer>
        </>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            className="shrink-0 overflow-hidden transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
            style={{ width: sidebarCollapsed ? STUDIO_SIDEBAR_WIDTH.collapsed : sidebarWidth }}
          >
            {sidebar}
          </div>
          {!sidebarCollapsed && (
            <Resizer
              label={t('development.database.app.resize_sidebar')}
              value={sidebarWidth}
              min={STUDIO_SIDEBAR_WIDTH.min}
              max={STUDIO_SIDEBAR_WIDTH.max}
              onChange={(width) => { autoWidth.current = false; setSidebarWidth(width) }}
              onReset={() => { autoWidth.current = false; setSidebarWidth(STUDIO_SIDEBAR_WIDTH.default) }}
            />
          )}
          <main className="min-h-0 min-w-0 flex-1">{main}</main>
        </div>
      )}

      <ConnectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editingConnection}
        onSaved={handleSaved}
        onLocalFile={handleLocalFile}
        onError={notifyError}
      />

      <Modal
        open={sqlViewOpen !== null}
        onClose={() => setSqlViewOpen(null)}
        title={t('development.database.app.sql_definition')}
        width={720}
        footer={
          <Button variant="secondary" size="sm" onClick={() => { if (sqlViewOpen) void copyText(sqlViewOpen).then((ok) => notify(ok ? t('development.database.common.copied') : t('development.database.common.copy_failed'), undefined, ok ? 'success' : 'danger')) }}>
            <Code2 size={14} />
            {t('development.database.common.copy')}
          </Button>
        }
      >
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 font-mono text-[length:var(--text-11)] leading-relaxed text-[var(--text-primary)]">
          {sqlViewOpen}
        </pre>
      </Modal>
    </div>
  )
}
