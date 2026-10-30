import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Code2,
  Database,
  FileCode2,
  ArrowRightLeft,
  GitBranch,
  GitCompare,
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
import { IS_DEMO_MODE } from '../../../lib/runtime'
import { AssistantDock } from '../../chat/AssistantDock'
import { useAssistant } from '../../chat/assistant-store'
import type { DatabaseAssistantContext } from '@shared/development/database/assistant-context'
import { MAX_DATABASE_CONTEXT_COLUMNS, MAX_DATABASE_CONTEXT_SQL, MAX_DATABASE_CONTEXT_TABLES } from '@shared/development/database/assistant-context'
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
import { quoteIdent } from '@shared/development/database/sql-utils'
import { downloadBlob, downloadTextFile, toSchemaSql } from './export-utils'
import { loadStudioLayout, saveStudioLayout, DRAFT_MAX_CHARS, STUDIO_SIDEBAR_WIDTH } from './layout'
import { DEFAULT_GUARD, loadGuards, saveGuards, type ConnectionGuard } from './guards'
import { StudioCommandPalette } from './StudioCommandPalette'
import { DatabaseSearchPanel } from './DatabaseSearchPanel'
import { DatabaseDumpDialog } from './DatabaseDumpDialog'
import { DataTransferDialog } from './DataTransferDialog'
import { CompareDialog } from './CompareDialog'
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
  const [guards, setGuards] = useState<Record<string, ConnectionGuard>>(loadGuards)
  const [unlocks, setUnlocks] = useState<Record<string, number>>({})
  const [unlockAsk, setUnlockAsk] = useState<{ resolve: (ok: boolean) => void } | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [dumpOpen, setDumpOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [contextSql, setContextSql] = useState('')
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
  const restoredSession = useRef(false)
  const pendingDraft = useRef('')
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectionRef = useRef<StudioSelection | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(Boolean(initialLayout.sidebarCollapsed))
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingConnection, setEditingConnection] = useState<DatabaseConnectionView | null>(null)
  const [sqlViewOpen, setSqlViewOpen] = useState<{ kind: 'view' | 'trigger'; name: string; sql: string } | null>(null)
  const [sqlDraft, setSqlDraft] = useState('')
  const [definitionSaving, setDefinitionSaving] = useState(false)
  const menuAnchor = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  selectionRef.current = selection

  const persistDraft = useCallback((text: string) => {
    if (selectionRef.current?.kind !== 'saved') return
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => {
      saveStudioLayout({ draft: text.slice(0, DRAFT_MAX_CHARS) })
    }, 400)
  }, [])

  useEffect(() => () => {
    if (draftTimer.current) clearTimeout(draftTimer.current)
  }, [])

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
      if (!restoredSession.current) {
        restoredSession.current = true
        const wanted = initialLayout.activeConnectionId
        if (wanted && list.some((connection) => connection.id === wanted)) {
          pendingDraft.current = initialLayout.draft ?? ''
          setSelection({ kind: 'saved', id: wanted })
        }
      }
      setSelection((current) => {
        if (!current || current.kind !== 'saved') return current
        return list.some((connection) => connection.id === current.id) ? current : null
      })
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    } finally {
      setConnectionsLoading(false)
    }
  }, [notifyError, initialLayout])

  useEffect(() => {
    void refreshConnections()
  }, [refreshConnections])

  useEffect(() => {
    if (!activeTabId && tabs.length > 0) setActiveTabId(tabs[0]!.id)
  }, [activeTabId, tabs])

  const [visitedTabIds, setVisitedTabIds] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (!activeTabId) return
    setVisitedTabIds((current) => {
      if (current.has(activeTabId)) return current
      const next = new Set(current)
      next.add(activeTabId)
      return next
    })
  }, [activeTabId])

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

  const guardKey = selection?.kind === 'saved'
    ? `saved:${selection.id}`
    : selection?.kind === 'local' ? `local:${selection.name}` : null
  const guard = (guardKey ? guards[guardKey] : undefined) ?? DEFAULT_GUARD
  const unlockedUntil = guardKey ? unlocks[guardKey] : undefined
  const unlocked = Boolean(unlockedUntil && unlockedUntil > Date.now())

  useEffect(() => {
    if (!guardKey || !unlockedUntil || unlockedUntil <= Date.now()) return
    const timeout = setTimeout(() => {
      setUnlocks((current) => {
        if (!(guardKey in current)) return current
        const next = { ...current }
        delete next[guardKey]
        return next
      })
    }, unlockedUntil - Date.now())
    return () => clearTimeout(timeout)
  }, [guardKey, unlockedUntil])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key !== 'k' && event.key !== 'K') return
      event.preventDefault()
      event.stopImmediatePropagation()
      setPaletteOpen((value) => !value)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const updateGuard = (patch: Partial<ConnectionGuard>) => {
    if (!guardKey) return
    const next = { ...guards, [guardKey]: { ...guard, ...patch } }
    setGuards(next)
    saveGuards(next)
  }

  const lockNow = () => {
    if (!guardKey) return
    setUnlocks((current) => {
      const next = { ...current }
      delete next[guardKey]
      return next
    })
  }

  const ensureWritable = async (): Promise<boolean> => {
    if (guard.readOnly && !unlocked) {
      const ok = await new Promise<boolean>((resolve) => setUnlockAsk({ resolve }))
      if (!ok) {
        notify(t('development.database.guard.cancelled'), undefined, 'warning')
        return false
      }
    }
    if (guard.production) {
      return await confirm({
        title: t('development.database.guard.prod_title', { name: activeSaved?.name ?? localFile?.name ?? '' }),
        description: t('development.database.guard.prod_description'),
        confirmLabel: t('development.database.guard.prod_confirm'),
        tone: 'danger',
      })
    }
    return true
  }

  const finishUnlock = (minutes: number | null) => {
    const ask = unlockAsk
    setUnlockAsk(null)
    if (!ask) return
    if (minutes === null) {
      ask.resolve(false)
      return
    }
    if (guardKey) setUnlocks((current) => ({ ...current, [guardKey]: Date.now() + minutes * 60_000 }))
    ask.resolve(true)
  }

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
    const restored = selection.kind === 'saved' && selection.id === initialLayout.activeConnectionId
      ? pendingDraft.current
      : ''
    pendingDraft.current = ''
    if (selection.kind === 'saved') saveStudioLayout({ activeConnectionId: selection.id, draft: '' })
    const nextTabs = [queryTab(restored || undefined)]
    setTabs(nextTabs)
    setActiveTabId(nextTabs[0]!.id)
    void reloadSchema(next)
    return () => {
      next.close()
    }
  }, [selection, localFile, activeSaved?.type, notifyError, reloadSchema, initialLayout])

  const handleSaved = (connection: DatabaseConnectionView) => {
    const wasCreating = editingConnection === null
    setConnections((current) => sortConnections([
      ...current.filter((entry) => entry.id !== connection.id),
      connection,
    ]))
    setSelection((current) => {
      if (current?.kind === 'saved' && current.id === connection.id) return current
      if (wasCreating || !current) return { kind: 'saved', id: connection.id }
      return current
    })
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

  const handleExportSchema = () => {
    if (!schema) return
    const sql = toSchemaSql(schema)
    if (!sql) {
      notify(t('development.database.app.no_objects'), undefined, 'warning')
      return
    }
    const base = (activeSaved?.name ?? localFile?.name.replace(/\.[^.]+$/, '') ?? 'database').replace(/[\\/:*?"<>|]+/g, '-')
    downloadTextFile(`${base}.schema.sql`, sql, 'application/sql')
    const count = schema.tables.length
      + schema.indexes.filter((entry) => entry.sql).length
      + schema.views.length
      + schema.triggers.length
    notify(t('development.database.app.export_schema_done', { count }), undefined, 'success')
  }

  const handleDownloadLocal = async () => {
    if (!driver?.exportFile || selection?.kind !== 'local') return
    try {
      const bytes = await driver.exportFile()
      const source = localFile?.name ?? 'database.sqlite'
      const filename = /\.(?:sqlite3?|db3?)$/i.test(source) ? source : `${source}.sqlite`
      downloadBlob(filename, new Blob([new Uint8Array(bytes)], { type: 'application/x-sqlite3' }))
      notify(t('development.database.app.download_sqlite_done'), undefined, 'success')
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    }
  }

  const saveDefinition = async () => {
    if (!sqlViewOpen || !driver) return
    const definition = sqlViewOpen
    const text = sqlDraft.trim()
    const kindWord = definition.kind === 'view' ? 'view' : 'trigger'
    if (!new RegExp(`^\\s*create\\s+(?:temp(?:orary)?\\s+)?${kindWord}\\b`, 'i').test(text)) {
      notify(t('development.database.app.definition_kind'), undefined, 'danger')
      return
    }
    if (!(await ensureWritable())) return
    const ok = await confirm({
      title: t('development.database.app.definition_confirm_title', { name: definition.name }),
      description: t('development.database.app.definition_confirm'),
      confirmLabel: t('development.database.app.definition_save'),
      tone: 'danger',
    })
    if (!ok) return
    setDefinitionSaving(true)
    try {
      await driver.query(`DROP ${definition.kind === 'view' ? 'VIEW' : 'TRIGGER'} IF EXISTS ${quoteIdent(definition.name)}`)
      await driver.query(text)
      setSqlViewOpen(null)
      await reloadSchema(driver)
      notify(t('development.database.app.definition_done', { name: definition.name }), undefined, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const previous = definition.sql.trim()
      if (!previous) {
        notifyError(message)
      } else {
        try {
          await driver.query(`DROP ${definition.kind === 'view' ? 'VIEW' : 'TRIGGER'} IF EXISTS ${quoteIdent(definition.name)}`)
          await driver.query(previous)
          notify(t('development.database.app.definition_restored'), message, 'warning')
        } catch (restoreError) {
          notifyError(t('development.database.app.definition_restore_failed', {
            message: `${message} — ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          }))
        }
      }
    } finally {
      setDefinitionSaving(false)
    }
  }

  const contextSqlTimer = useRef<number | null>(null)
  const handleContextSql = useCallback((text: string) => {
    if (contextSqlTimer.current !== null) window.clearTimeout(contextSqlTimer.current)
    contextSqlTimer.current = window.setTimeout(() => setContextSql(text), 500)
  }, [])
  useEffect(() => () => {
    if (contextSqlTimer.current !== null) window.clearTimeout(contextSqlTimer.current)
  }, [])

  const assistantDockOpen = useUi((state) => state.assistantDockOpen)
  const databaseContext = useMemo<DatabaseAssistantContext | null>(() => {
    if (!selection) return null
    const name = selection.kind === 'local' ? selection.name : activeSaved?.name ?? ''
    const tables = (schema?.tables ?? []).slice(0, MAX_DATABASE_CONTEXT_TABLES).map((table) => ({
      name: table.name,
      columns: table.columns.slice(0, MAX_DATABASE_CONTEXT_COLUMNS).map((column) => ({ name: column.name, type: column.type })),
    }))
    return {
      ...(selection.kind === 'saved' ? { connectionId: selection.id } : {}),
      connectionName: name,
      connectionType: activeSaved?.type ?? 'sqlite',
      ...(activeTab && (activeTab.kind === 'data' || activeTab.kind === 'schema') && activeTab.table ? { activeTable: activeTab.table } : {}),
      ...(contextSql.trim() ? { sql: contextSql.slice(0, MAX_DATABASE_CONTEXT_SQL) } : {}),
      tables,
      views: (schema?.views ?? []).map((view) => view.name),
    }
  }, [activeSaved?.name, activeSaved?.type, activeTab, contextSql, schema, selection])

  const assistantTools = useAssistant((state) => state.turn?.tools)
  const assistantWriteCount = useMemo(
    () => (assistantTools ?? []).filter((tool) => tool.name.startsWith('database_') && tool.status === 'success').length,
    [assistantTools],
  )
  const lastAssistantWrite = useRef(0)
  useEffect(() => {
    if (assistantWriteCount <= lastAssistantWrite.current) return
    lastAssistantWrite.current = assistantWriteCount
    if (driver) void reloadSchema(driver)
  }, [assistantWriteCount, driver, reloadSchema])

  useEffect(() => {
    const onChange = (event: Event) => {
      const tool = (event as CustomEvent<{ tool?: string }>).detail?.tool
      if (!tool || !tool.startsWith('database_') || !driver) return
      void reloadSchema(driver)
    }
    window.addEventListener('inkstone:assistant-tool', onChange)
    return () => window.removeEventListener('inkstone:assistant-tool', onChange)
  }, [driver, reloadSchema])

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

  const tableForTab = (tab: StudioTab) => tab.table ? schema?.tables.find((table) => table.name === tab.table) ?? null : null
  const renderTabContent = (tab: StudioTab, active: boolean) => {
    if (!driver) return null
    const table = tableForTab(tab)
    if (tab.kind === 'query') {
      return (
        <QueryTab
          key={tab.id}
          driver={driver}
          connectionId={connectionId}
          connectionType={connectionType}
          schemaModel={schema ?? EMPTY_SCHEMA}
          {...(tab.initialSql ? { initialSql: tab.initialSql } : {})}
          active={active}
          onDraftChange={persistDraft}
          onSchemaChanged={() => void reloadSchema(driver)}
          ensureWritable={ensureWritable}
          onOpenSql={(text) => openQueryTab(text)}
          onSqlChange={handleContextSql}
          onError={notifyError}
        />
      )
    }
    if (tab.kind === 'data') {
      if (!table) {
        return (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--text-tertiary)]">
            <Table2 size={28} className="opacity-40" />
            <p className="text-[length:var(--text-13)]">
              {t('development.database.app.table_missing', { table: tab.table ?? '' })}
            </p>
          </div>
        )
      }
      return <DataTable key={tab.id} driver={driver} table={table} active={active} ensureWritable={ensureWritable} onSchemaChanged={() => void reloadSchema(driver)} onError={notifyError} />
    }
    if (tab.kind === 'schema') {
      return (
        <SchemaEditor
          key={tab.id}
          driver={driver}
          table={table}
          schemaModel={schema ?? EMPTY_SCHEMA}
          onSchemaChanged={() => void reloadSchema(driver)}
          ensureWritable={ensureWritable}
          onError={notifyError}
          onOpenSql={(sql) => openQueryTab(sql)}
          onTableCreated={(name) => openDataTab(name)}
        />
      )
    }
    if (tab.kind === 'tools') {
      return (
        <MassDropPanel
          key={tab.id}
          driver={driver}
          tables={schema?.tables ?? []}
          onSchemaChanged={() => void reloadSchema(driver)}
          ensureWritable={ensureWritable}
          onError={notifyError}
        />
      )
    }
    if (tab.kind === 'erd') {
      return (
        <ErdView
          tables={schema?.tables ?? []}
          className="h-full w-full"
          onOpenData={openDataTab}
          onOpenSchema={openSchemaTab}
        />
      )
    }
    return null
  }

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
        setSelection((current) => current?.kind === 'saved' && current.id === id ? current : { kind: 'saved', id })
        setMobileSidebarOpen(false)
      }}
      onSelectLocal={() => {
        if (localFile) {
          setSelection((current) => current?.kind === 'local' && current.name === localFile.name && current.file === localFile.file
            ? current
            : { kind: 'local', name: localFile.name, file: localFile.file })
          setMobileSidebarOpen(false)
        }
      }}
      onDownloadLocal={() => void handleDownloadLocal()}
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
      onExportSchema={handleExportSchema}
      onSearchData={() => setSearchOpen(true)}
      onExportDatabase={() => setDumpOpen(true)}
      guard={guard}
      unlockedUntil={unlockedUntil}
      onGuardChange={updateGuard}
      onLockNow={lockNow}
      onViewSql={(definition) => { setSqlViewOpen(definition); setSqlDraft(definition.sql) }}
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
        <Tooltip label={t('development.database.app.assistant')}>
          <IconButton
            label={t('development.database.app.assistant')}
            size="sm"
            active={assistantDockOpen}
            onClick={() => useUi.getState().toggleAssistantDock()}
          >
            <Bot size={14} />
          </IconButton>
        </Tooltip>
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
          { id: 'transfer', label: t('development.database.transfer.title'), icon: <ArrowRightLeft size={13} />, disabled: !schema || schema.tables.length === 0 || !driver || connections.length === 0, onSelect: () => { setMenuOpen(false); setTransferOpen(true) } },
          { id: 'compare', label: t('development.database.compare.title'), icon: <GitCompare size={13} />, disabled: !schema || schema.tables.length === 0 || !driver, onSelect: () => { setMenuOpen(false); setCompareOpen(true) } },
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
        ) : (
          tabs.map((tab) => {
            const active = tab.id === activeTabId
            if (!active && !visitedTabIds.has(tab.id)) return null
            return (
              <div key={tab.id} className={active ? 'h-full min-h-0' : 'hidden'}>
                {renderTabContent(tab, active)}
              </div>
            )
          })
        )}
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
          {assistantDockOpen && !IS_DEMO_MODE && (
            <AssistantDock surface="database" database={databaseContext} />
          )}
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
          {assistantDockOpen && !IS_DEMO_MODE && (
            <AssistantDock surface="database" database={databaseContext} />
          )}
        </div>
      )}

      {driver && (
        <DatabaseDumpDialog
          open={dumpOpen}
          driver={driver}
          schema={schema ?? EMPTY_SCHEMA}
          connectionName={activeSaved?.name ?? localFile?.name ?? 'database'}
          onClose={() => setDumpOpen(false)}
          onError={notifyError}
        />
      )}

      {driver && (
        <CompareDialog
          open={compareOpen}
          sourceDriver={driver}
          sourceLabel={activeSaved?.name ?? localFile?.name ?? ''}
          {...(selection?.kind === 'saved' ? { sourceConnectionId: selection.id } : {})}
          sourceSchema={schema ?? EMPTY_SCHEMA}
          connections={connections}
          onClose={() => setCompareOpen(false)}
          onError={notifyError}
        />
      )}

      {driver && (
        <DataTransferDialog
          open={transferOpen}
          sourceDriver={driver}
          sourceLabel={activeSaved?.name ?? localFile?.name ?? ''}
          {...(selection?.kind === 'saved' ? { sourceConnectionId: selection.id } : {})}
          schema={schema ?? EMPTY_SCHEMA}
          connections={connections}
          onClose={() => setTransferOpen(false)}
          onError={notifyError}
        />
      )}

      {driver && (
        <DatabaseSearchPanel
          open={searchOpen}
          tables={schema?.tables ?? []}
          driver={driver}
          onClose={() => setSearchOpen(false)}
          onOpenTable={openDataTab}
          onError={notifyError}
        />
      )}

      <StudioCommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        connections={connections}
        hasLocal={Boolean(localFile)}
        schema={schema}
        onSelectSaved={(id) => setSelection((current) => current?.kind === 'saved' && current.id === id ? current : { kind: 'saved', id })}
        onSelectLocal={() => {
          if (localFile) setSelection((current) => current?.kind === 'local' && current.name === localFile.name && current.file === localFile.file
            ? current
            : { kind: 'local', name: localFile.name, file: localFile.file })
        }}
        onOpenData={openDataTab}
        onOpenSchema={openSchemaTab}
        onViewSql={(definition) => { setSqlViewOpen(definition); setSqlDraft(definition.sql) }}
        onNewQuery={() => openQueryTab()}
        onExportSchema={handleExportSchema}
        onRefreshSchema={() => { if (driver) void reloadSchema(driver) }}
      />

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
        description={sqlViewOpen ? t('development.database.app.definition_hint', { name: sqlViewOpen.name }) : undefined}
        width={720}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setSqlViewOpen(null)}>{t('development.database.common.cancel')}</Button>
            <Button variant="secondary" size="sm" onClick={() => { if (sqlDraft) void copyText(sqlDraft).then((ok) => notify(ok ? t('development.database.common.copied') : t('development.database.common.copy_failed'), undefined, ok ? 'success' : 'danger')) }}>
              <Code2 size={14} />
              {t('development.database.common.copy')}
            </Button>
            <Button size="sm" disabled={definitionSaving} onClick={() => void saveDefinition()}>
              {definitionSaving && <Loader2 size={13} className="animate-spin" />}
              {t('development.database.app.definition_save')}
            </Button>
          </>
        }
      >
        <textarea
          value={sqlDraft}
          onChange={(event) => setSqlDraft(event.target.value)}
          spellCheck={false}
          aria-label={t('development.database.app.sql_definition')}
          className="h-[50vh] w-full resize-none rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] p-3 font-mono text-[length:var(--text-11)] leading-relaxed text-[var(--text-primary)] outline-none"
        />
      </Modal>

      <Modal
        open={unlockAsk !== null}
        onClose={() => finishUnlock(null)}
        title={t('development.database.guard.unlock_title')}
        description={t('development.database.guard.unlock_description')}
        width={440}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => finishUnlock(null)}>{t('development.database.common.cancel')}</Button>
            <Button variant="secondary" size="sm" onClick={() => finishUnlock(1)}>{t('development.database.guard.unlock_minutes', { minutes: 1 })}</Button>
            <Button size="sm" onClick={() => finishUnlock(5)}>{t('development.database.guard.unlock_minutes', { minutes: 5 })}</Button>
          </>
        }
      >
        <div />
      </Modal>
    </div>
  )
}
