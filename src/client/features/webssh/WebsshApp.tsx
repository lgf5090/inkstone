import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Download,
  History,
  KeyRound,
  Menu as MenuIcon,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  ScrollText,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  Upload,
} from 'lucide-react'
import type {
  WebsshCredential,
  WebsshHost,
  WebsshHostExportFormat,
  WebsshHostGroup,
  WebsshHostKey,
  WebsshHostPreflight,
  WebsshHostQuickView,
  WebsshHostSort,
  WebsshHostsOverview,
  WebsshKey,
} from '@shared/webssh/types'
import { Button, IconButton } from '../../components/primitives'
import { Empty } from '../../components/feedback'
import { Menu, MenuSubmenuList, confirm, hasOpenLayer, type MenuItem } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useBreakpoint } from '../../lib/hooks'
import { t } from '../../lib/i18n'
import { ApiError } from '../../lib/api'
import { websshApi } from './api'
import { HostSidebar } from './HostSidebar'
import { HostList, type HostDensity } from './HostList'
import { HostDialog } from './HostDialog'
import { CredentialDialog } from './CredentialDialog'
import { KeyManagerDialog } from './KeyManagerDialog'
import { FingerprintDialog } from './FingerprintDialog'
import { TerminalWorkspace } from './TerminalWorkspace'
import { SnippetsPanel } from './SnippetsPanel'
import { ImportDialog } from './ImportDialog'
import { AuditPanel } from './AuditPanel'
import { RecordingsPanel } from './RecordingsPanel'
import '@xterm/xterm/css/xterm.css'
import './webssh.css'

function issueLabel(issue: string): string {
  if (issue === 'credential_missing') return t('webssh.error.credential_missing')
  if (issue === 'key_missing') return t('webssh.error.key_missing')
  if (issue === 'vault_unavailable') return t('webssh.error.vault_unavailable')
  if (issue === 'credential_unreadable') return t('webssh.error.credential_unreadable')
  if (issue === 'key_unreadable') return t('webssh.error.key_unreadable')
  return issue
}

const SIDEBAR_KEY = 'webssh:sidebar-open'
const DENSITY_KEY = 'webssh:row-density'

function readPreference<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = window.localStorage.getItem(key)
    return value && allowed.includes(value as T) ? value as T : fallback
  } catch {
    return fallback
  }
}

function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // A blocked storage area only costs the preference, not the action that set it.
  }
}

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

export function WebsshApp() {
  const isMobile = useBreakpoint() === 'mobile'
  const [keys, setKeys] = useState<WebsshKey[]>([])
  const [credentials, setCredentials] = useState<WebsshCredential[]>([])
  const [overview, setOverview] = useState<WebsshHostsOverview | null>(null)
  const [hosts, setHosts] = useState<WebsshHost[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [quick, setQuick] = useState<WebsshHostQuickView>('all')
  const [folderId, setFolderId] = useState('')
  const [tag, setTag] = useState('')
  const [sort, setSort] = useState<WebsshHostSort>('manual')
  const [density, setDensity] = useState<HostDensity>(() => readPreference(DENSITY_KEY, 'comfortable', ['comfortable', 'compact'] as const))
  const [sidebarOpen, setSidebarOpen] = useState(() => readPreference(SIDEBAR_KEY, 'true', ['true', 'false'] as const) === 'true')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [refreshToken, setRefreshToken] = useState(0)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pinnedHost, setPinnedHost] = useState<WebsshHost | null>(null)
  const [workspaceHost, setWorkspaceHost] = useState<WebsshHost | null>(null)
  const [newTabToken, setNewTabToken] = useState(0)
  const [hostDialog, setHostDialog] = useState<{ open: boolean; host: WebsshHost | null; groupId?: string }>({ open: false, host: null })
  const [credentialsOpen, setCredentialsOpen] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [recordingsOpen, setRecordingsOpen] = useState(false)
  const [alertCount, setAlertCount] = useState(0)
  const [fingerprintOpen, setFingerprintOpen] = useState(false)
  const [fingerprints, setFingerprints] = useState<WebsshHostKey[]>([])
  const [preflight, setPreflight] = useState<WebsshHostPreflight | null>(null)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const headerMenuAnchor = useRef<HTMLButtonElement>(null)
  const exportMenuAnchor = useRef<HTMLButtonElement>(null)

  const refresh = () => setRefreshToken((value) => value + 1)
  const selected = hosts.find((host) => host.id === selectedId) ?? pinnedHost
  const groups: WebsshHostGroup[] = overview?.folders ?? []

  useEffect(() => {
    writePreference(SIDEBAR_KEY, sidebarOpen ? 'true' : 'false')
  }, [sidebarOpen])

  useEffect(() => {
    writePreference(DENSITY_KEY, density)
  }, [density])

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

  useEffect(() => {
    setChosen(new Set())
  }, [query, quick, folderId, tag, sort])

  useEffect(() => {
    if (folderId && overview && !overview.folders.some((folder) => folder.id === folderId)) {
      setFolderId('')
    }
  }, [folderId, overview])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(queryInput)
      setPage(1)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [queryInput])

  useEffect(() => {
    let cancelled = false
    Promise.all([websshApi.hostsOverview(), websshApi.listKeys(), websshApi.listCredentials()])
      .then(([nextOverview, nextKeys, nextCredentials]) => {
        if (cancelled) return
        setOverview(nextOverview)
        setKeys(nextKeys)
        setCredentials(nextCredentials)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic'))
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  useEffect(() => {
    let cancelled = false
    websshApi.auditHealth()
      .then((report) => {
        if (!cancelled) setAlertCount(report.alerts.length)
      })
      .catch(() => {
        // The header badge is a convenience; the audit panel surfaces a failed health read.
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    websshApi.listHosts({ q: query, groupId: folderId, quick, tag, sort, page, pageSize })
      .then((response) => {
        if (cancelled) return
        setHosts(response.items)
        setTotal(response.total)
        setError(null)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [query, quick, folderId, tag, sort, page, pageSize, refreshToken])

  const selectHost = (id: string) => {
    setSelectedId(id || null)
    setPinnedHost(null)
    setPreflight(null)
    setFingerprints([])
    setWorkspaceHost(null)
  }

  const selectQuick = (next: WebsshHostQuickView) => {
    setQuick(next)
    setFolderId('')
    setTag('')
    setPage(1)
  }

  const selectFolder = (next: string) => {
    setFolderId(next)
    setQuick('all')
    setTag('')
    setPage(1)
    setDrawerOpen(false)
  }

  const selectTag = (next: string) => {
    setTag(next)
    setQuick('all')
    setFolderId('')
    setPage(1)
    setDrawerOpen(false)
  }

  const clearFilters = () => {
    setQuick('all')
    setFolderId('')
    setTag('')
    setQuery('')
    setQueryInput('')
    setPage(1)
  }

  const connectHost = (host: WebsshHost) => {
    setSelectedId(host.id)
    setPinnedHost(host)
    setWorkspaceHost(host)
  }

  const openHostTab = (host: WebsshHost) => {
    if (workspaceHost?.id === host.id) setNewTabToken((value) => value + 1)
    else {
      setSelectedId(host.id)
      setPinnedHost(host)
      setWorkspaceHost(host)
    }
  }

  const runExport = async (format: WebsshHostExportFormat) => {
    try {
      const text = await websshApi.exportHosts(format)
      downloadText(text, `webssh-hosts.${format === 'csv' ? 'csv' : 'conf'}`, format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8')
      useUi.getState().toast({ title: t('webssh.toast.exported'), tone: 'success' })
    } catch (caught) {
      useUi.getState().toast({
        title: caught instanceof ApiError ? caught.message : t('webssh.error.generic'),
        tone: 'danger',
      })
    }
  }

  const openFingerprints = async () => {
    if (!selected) return
    setFingerprintOpen(true)
    try {
      setFingerprints(await websshApi.listFingerprints(selected.id))
    } catch (caught) {
      useUi.getState().toast({
        title: caught instanceof ApiError ? caught.message : t('webssh.error.generic'),
        tone: 'danger',
      })
    }
  }

  const runPreflight = async () => {
    if (!selected) return
    try {
      const result = await websshApi.preflight(selected.id, {})
      setPreflight(result)
      useUi.getState().toast({
        title: result.ready ? t('webssh.toast.preflight_ok') : t('webssh.toast.preflight_failed'),
        tone: result.ready ? 'success' : 'warning',
      })
    } catch (caught) {
      useUi.getState().toast({
        title: caught instanceof ApiError ? caught.message : t('webssh.error.generic'),
        tone: 'danger',
      })
    }
  }

  const removeHost = async () => {
    if (!selected) return
    const approved = await confirm({
      title: t('webssh.host.remove_title'),
      description: t('webssh.host.remove_description', { name: selected.name }),
      tone: 'danger',
      confirmLabel: t('webssh.actions.delete'),
    })
    if (!approved) return
    try {
      await websshApi.deleteHost(selected.id)
      useUi.getState().toast({ title: t('webssh.toast.host_deleted'), tone: 'success' })
      setSelectedId(null)
      setPinnedHost(null)
      setPreflight(null)
      setWorkspaceHost(null)
      refresh()
    } catch (caught) {
      useUi.getState().toast({
        title: caught instanceof ApiError ? caught.message : t('webssh.error.generic'),
        tone: 'danger',
      })
    }
  }

  const workspace = workspaceHost ? (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={workspaceHost.name}>
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5">
        <IconButton label={t('webssh.actions.back')} size="sm" onClick={() => {
          setWorkspaceHost(null)
          refresh()
        }}>
          <ArrowLeft size={15} aria-hidden="true" />
        </IconButton>
        <span className="min-w-0 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
          {workspaceHost.name}
        </span>
        <span className="min-w-0 truncate font-mono text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {workspaceHost.username}@{workspaceHost.host}:{workspaceHost.port}
        </span>
      </div>
      <TerminalWorkspace host={workspaceHost} newTabToken={newTabToken} />
    </section>
  ) : null

  const detail = selected ? (
    <HostDetail
      host={selected}
      groupName={groups.find((group) => group.id === selected.groupId)?.name ?? null}
      credentialLabel={credentials.find((credential) => credential.id === selected.credentialId)?.label ?? null}
      keyLabel={keys.find((key) => key.id === selected.keyId)?.label ?? null}
      preflight={preflight}
      onBack={isMobile ? () => setSelectedId(null) : undefined}
      onConnect={() => setWorkspaceHost(selected)}
      onEdit={() => setHostDialog({ open: true, host: selected })}
      onDelete={removeHost}
      onCheck={runPreflight}
      onFingerprints={openFingerprints}
    />
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <Empty
        art="select"
        title={t('webssh.host.detail_empty_title')}
        description={t('webssh.host.detail_empty_description')}
      />
    </div>
  )

  const rightPane = workspace ?? detail
  const viewLabel = tag
    ? `#${tag}`
    : folderId
      ? groups.find((group) => group.id === folderId)?.name ?? t('webssh.sidebar.folders')
      : quick === 'favorites'
        ? t('webssh.sidebar.favorites')
        : quick === 'recent'
          ? t('webssh.sidebar.recent')
          : t('webssh.sidebar.all')
  const exportItems: MenuItem[] = [
    { id: 'ssh-config', label: t('webssh.export.ssh_config'), icon: <Download size={13} aria-hidden="true" />, onSelect: () => void runExport('ssh-config') },
    { id: 'csv', label: t('webssh.export.csv'), icon: <Download size={13} aria-hidden="true" />, onSelect: () => void runExport('csv') },
  ]
  const mobileActions: MenuItem[] = [
    { id: 'credentials', label: t('webssh.actions.credentials'), onSelect: () => setCredentialsOpen(true) },
    { id: 'keys', label: t('webssh.actions.keys'), icon: <KeyRound size={13} aria-hidden="true" />, onSelect: () => setKeysOpen(true) },
    { id: 'snippets', label: t('webssh.snippet.open'), icon: <ScrollText size={13} aria-hidden="true" />, onSelect: () => setSnippetsOpen(true) },
    { id: 'import', label: t('webssh.actions.import'), icon: <Upload size={13} aria-hidden="true" />, onSelect: () => setImportOpen(true) },
    { id: 'recordings', label: t('webssh.recordings.open'), icon: <History size={13} aria-hidden="true" />, onSelect: () => setRecordingsOpen(true) },
    { id: 'audit', label: t('webssh.audit.open'), icon: <ShieldCheck size={13} aria-hidden="true" />, onSelect: () => setAuditOpen(true) },
    {
      id: 'export',
      label: t('webssh.actions.export'),
      icon: <Download size={13} aria-hidden="true" />,
      separatorBefore: true,
      submenu: ({ closeMenu }) => (
        <MenuSubmenuList
          label={t('webssh.actions.export')}
          items={[
            { id: 'export-conf', label: t('webssh.export.ssh_config'), onSelect: () => { closeMenu(); void runExport('ssh-config') } },
            { id: 'export-csv', label: t('webssh.export.csv'), onSelect: () => { closeMenu(); void runExport('csv') } },
          ]}
        />
      ),
    },
  ]

  return (
    <div
      data-testid="webssh-app-root"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 md:px-3">
        {isMobile ? (
          <IconButton label={t('webssh.sidebar.title')} onClick={() => setDrawerOpen(true)}>
            <MenuIcon size={17} aria-hidden="true" />
          </IconButton>
        ) : (
          <IconButton
            label={t('webssh.sidebar.toggle')}
            active={sidebarOpen}
            aria-expanded={sidebarOpen}
            aria-controls="webssh-sidebar"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            <PanelLeft size={15} aria-hidden="true" />
          </IconButton>
        )}
        <SquareTerminal size={16} aria-hidden="true" className="hidden shrink-0 text-[var(--text-secondary)] sm:block" />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h1 className="shrink-0 truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">
            {t('webssh.app.title')}
          </h1>
          <span className="min-w-0 truncate text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{viewLabel}</span>
        </div>
        <div className="ml-auto hidden shrink-0 items-center gap-1 md:flex">
          <Button size="sm" variant="ghost" onClick={() => setCredentialsOpen(true)}>{t('webssh.actions.credentials')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setKeysOpen(true)} icon={<KeyRound size={13} aria-hidden="true" />}>{t('webssh.actions.keys')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setSnippetsOpen(true)} icon={<ScrollText size={13} aria-hidden="true" />}>{t('webssh.snippet.open')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setImportOpen(true)} icon={<Upload size={13} aria-hidden="true" />}>{t('webssh.actions.import')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setRecordingsOpen(true)} icon={<History size={13} aria-hidden="true" />}>{t('webssh.recordings.open')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setAuditOpen(true)} icon={<ShieldCheck size={13} aria-hidden="true" />}>
            {t('webssh.audit.open')}
            {alertCount > 0 && (
              <span className="ms-0.5 rounded-full bg-[var(--danger)] px-1.5 text-[length:var(--text-10)] text-[var(--text-inverse)]">{alertCount}</span>
            )}
          </Button>
          <Button ref={exportMenuAnchor} size="sm" variant="ghost" onClick={() => setExportMenuOpen(true)} icon={<Download size={13} aria-hidden="true" />}>
            {t('webssh.actions.export')}
          </Button>
        </div>
        {isMobile && (
          <IconButton ref={headerMenuAnchor} label={t('webssh.list.more_actions')} onClick={() => setHeaderMenuOpen(true)}>
            <MoreHorizontal size={17} aria-hidden="true" />
          </IconButton>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <HostSidebar
          mobile={isMobile}
          open={isMobile ? drawerOpen : sidebarOpen}
          overview={overview}
          selection={{ quick, folderId, tag }}
          onOpenChange={(next) => {
            if (isMobile) setDrawerOpen(next)
            else setSidebarOpen(next)
          }}
          onSelectQuick={selectQuick}
          onSelectFolder={selectFolder}
          onSelectTag={selectTag}
          onNewHost={(nextFolderId) => setHostDialog({ open: true, host: null, groupId: nextFolderId })}
          onMoveHost={(hostId, groupId) => {
            websshApi.moveHost(hostId, { groupId })
              .then(() => {
                useUi.getState().toast({ title: t('webssh.toast.host_moved'), tone: 'success' })
                refresh()
              })
              .catch((caught: unknown) => {
                useUi.getState().toast({
                  title: caught instanceof ApiError ? caught.message : t('webssh.error.generic'),
                  tone: 'danger',
                })
              })
          }}
          onChanged={refresh}
        />
        {(!isMobile || (!selected && !workspaceHost)) && (
          <HostList
            hosts={hosts}
            groups={groups}
            overview={overview}
            loading={loading}
            error={error}
            query={queryInput}
            quick={quick}
            folderId={folderId}
            tag={tag}
            sort={sort}
            density={density}
            selectedId={selectedId}
            chosen={chosen}
            page={page}
            pageSize={pageSize}
            total={total}
            searchRef={searchRef}
            onQueryChange={setQueryInput}
            onSortChange={(value) => {
              setSort(value)
              setPage(1)
            }}
            onDensityChange={setDensity}
            onSelect={selectHost}
            onChosenChange={setChosen}
            onPageChange={setPage}
            onNew={() => setHostDialog({ open: true, host: null, groupId: folderId })}
            onRetry={refresh}
            onConnect={connectHost}
            onNewTab={openHostTab}
            onEdit={(host) => setHostDialog({ open: true, host })}
            onFilterTag={selectTag}
            onFilterFolder={selectFolder}
            onClearFilters={clearFilters}
            onChanged={refresh}
          />
        )}
        {(!isMobile || selected || workspaceHost) && rightPane}
      </div>

      <Menu anchor={exportMenuAnchor} open={exportMenuOpen} onClose={() => setExportMenuOpen(false)} items={exportItems} align="end" width={190} />
      <Menu anchor={headerMenuAnchor} open={headerMenuOpen} onClose={() => setHeaderMenuOpen(false)} items={mobileActions} align="end" width={210} />

      <HostDialog
        open={hostDialog.open}
        host={hostDialog.host}
        groups={groups}
        credentials={credentials}
        keys={keys}
        defaultGroupId={hostDialog.groupId}
        onClose={() => setHostDialog({ open: false, host: null })}
        onSaved={(host) => {
          useUi.getState().toast({
            title: hostDialog.host ? t('webssh.toast.host_saved') : t('webssh.toast.host_created'),
            tone: 'success',
          })
          setHostDialog({ open: false, host: null })
          setSelectedId(host.id)
          setPinnedHost(host)
          refresh()
        }}
        onOpenCredentials={() => setCredentialsOpen(true)}
        onOpenKeys={() => setKeysOpen(true)}
      />

      <CredentialDialog
        open={credentialsOpen}
        credentials={credentials}
        onClose={() => setCredentialsOpen(false)}
        onChanged={refresh}
      />

      <KeyManagerDialog
        open={keysOpen}
        keys={keys}
        onClose={() => setKeysOpen(false)}
        onChanged={refresh}
      />

      <SnippetsPanel open={snippetsOpen} onClose={() => setSnippetsOpen(false)} />

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          setImportOpen(false)
          refresh()
        }}
      />

      <RecordingsPanel open={recordingsOpen} onClose={() => setRecordingsOpen(false)} />

      <AuditPanel open={auditOpen} onClose={() => setAuditOpen(false)} />

      <FingerprintDialog
        open={fingerprintOpen}
        host={selected}
        fingerprints={fingerprints}
        onClose={() => setFingerprintOpen(false)}
        onChanged={async () => {
          if (!selected) return
          setFingerprints(await websshApi.listFingerprints(selected.id))
        }}
      />
    </div>
  )
}

function HostDetail({ host, groupName, credentialLabel, keyLabel, preflight, onBack, onConnect, onEdit, onDelete, onCheck, onFingerprints }: {
  host: WebsshHost
  groupName: string | null
  credentialLabel: string | null
  keyLabel: string | null
  preflight: WebsshHostPreflight | null
  onBack?: () => void
  onConnect: () => void
  onEdit: () => void
  onDelete: () => void
  onCheck: () => void
  onFingerprints: () => void
}) {
  return (
    <section aria-label={host.name} className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
      <div className="mx-auto max-w-[720px] space-y-5">
        <div className="flex items-start gap-2">
          {onBack && (
            <IconButton label={t('webssh.actions.back')} size="sm" onClick={onBack} className="mt-0.5 shrink-0">
              <ArrowLeft size={15} aria-hidden="true" />
            </IconButton>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">{host.name}</h2>
            <p className="mt-0.5 truncate font-mono text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">
              {host.username}@{host.host}:{host.port}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" onClick={onEdit} icon={<Pencil size={13} aria-hidden="true" />}>{t('webssh.actions.edit')}</Button>
            <IconButton label={t('webssh.actions.delete')} size="sm" onClick={onDelete}>
              <Trash2 size={14} aria-hidden="true" />
            </IconButton>
          </div>
        </div>

        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <DetailRow label={t('webssh.host.group')} value={groupName ?? t('webssh.group.none')} />
          <DetailRow
            label={t('webssh.host.auth_method')}
            value={host.authMethod === 'password' ? t('webssh.host.auth_password') : t('webssh.host.auth_key')}
          />
          <DetailRow
            label={host.authMethod === 'password' ? t('webssh.host.credential') : t('webssh.host.key')}
            value={(host.authMethod === 'password' ? credentialLabel : keyLabel) ?? t('webssh.host.missing_reference')}
          />
          <DetailRow
            label={t('webssh.host.last_connected')}
            value={host.lastConnectedAt ? new Date(host.lastConnectedAt).toLocaleString() : t('webssh.host.never_connected')}
          />
          <DetailRow label={t('webssh.host.term_type')} value={host.termType} />
          <DetailRow label={t('webssh.host.encoding')} value={host.encoding} />
          {host.initialCommand && <DetailRow label={t('webssh.host.initial_command')} value={host.initialCommand} mono />}
        </dl>

        {host.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {host.tags.map((tag) => (
              <span key={tag} className="rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-2 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                {tag}
              </span>
            ))}
          </div>
        )}

        {host.notes && (
          <div>
            <h3 className="mb-1 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('webssh.host.notes')}</h3>
            <p className="whitespace-pre-wrap text-[length:var(--text-12-5)] leading-relaxed text-[var(--text-tertiary)]">{host.notes}</p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-4">
          <Button variant="primary" onClick={onConnect} icon={<SquareTerminal size={13} aria-hidden="true" />}>
            {t('webssh.actions.open_terminal')}
          </Button>
          <Button onClick={onCheck}>{t('webssh.actions.check_connection')}</Button>
          <Button onClick={onFingerprints} icon={<ShieldCheck size={13} aria-hidden="true" />}>{t('webssh.actions.fingerprints')}</Button>
        </div>

        {preflight && (
          <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
            <p className="text-[length:var(--text-12-5)] font-medium text-[var(--text-secondary)]">
              {preflight.ready ? t('webssh.host.ready') : t('webssh.host.not_ready')}
            </p>
            {preflight.issues.length > 0 && (
              <ul className="mt-1 list-inside list-disc text-[length:var(--text-11-5)] text-[var(--danger)]">
                {preflight.issues.map((issue) => <li key={issue}>{issueLabel(issue)}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[length:var(--text-11)] font-medium uppercase tracking-wide text-[var(--text-quaternary)]">{label}</dt>
      <dd className={`mt-0.5 break-words text-[length:var(--text-12-5)] text-[var(--text-primary)] ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  )
}
