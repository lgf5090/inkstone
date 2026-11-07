import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  FolderTree,
  KeyRound,
  Pencil,
  ShieldCheck,
  SquareTerminal,
  Trash2,
} from 'lucide-react'
import type {
  WebsshCredential,
  WebsshHost,
  WebsshHostGroup,
  WebsshHostKey,
  WebsshHostPreflight,
  WebsshKey,
} from '@shared/webssh/types'
import { Badge, Button, IconButton } from '../../components/primitives'
import { Empty } from '../../components/feedback'
import { Tooltip, confirm } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useBreakpoint } from '../../lib/hooks'
import { t } from '../../lib/i18n'
import { ApiError } from '../../lib/api'
import { websshApi } from './api'
import { HostList } from './HostList'
import { HostDialog } from './HostDialog'
import { GroupDialog } from './GroupDialog'
import { CredentialDialog } from './CredentialDialog'
import { KeyManagerDialog } from './KeyManagerDialog'
import { FingerprintDialog } from './FingerprintDialog'
import { TerminalWorkspace } from './TerminalWorkspace'
import '@xterm/xterm/css/xterm.css'
import './webssh.css'

/**
 * The demo transport is still the only implementation the terminal has. Until the host-to-session
 * wiring replaces it, the badge stays visible: a terminal that looks live must never be mistaken
 * for a real SSH connection.
 */
const DEMO_TRANSPORT = true

type SortKey = 'manual' | 'name' | 'recent'

function issueLabel(issue: string): string {
  if (issue === 'credential_missing') return t('webssh.error.credential_missing')
  if (issue === 'key_missing') return t('webssh.error.key_missing')
  if (issue === 'vault_unavailable') return t('webssh.error.vault_unavailable')
  if (issue === 'credential_unreadable') return t('webssh.error.credential_unreadable')
  if (issue === 'key_unreadable') return t('webssh.error.key_unreadable')
  return issue
}

export function WebsshApp() {
  const isMobile = useBreakpoint() === 'mobile'
  const [groups, setGroups] = useState<WebsshHostGroup[]>([])
  const [keys, setKeys] = useState<WebsshKey[]>([])
  const [credentials, setCredentials] = useState<WebsshCredential[]>([])
  const [hosts, setHosts] = useState<WebsshHost[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [groupId, setGroupId] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [sort, setSort] = useState<SortKey>('manual')
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [refreshToken, setRefreshToken] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pinnedHost, setPinnedHost] = useState<WebsshHost | null>(null)
  const [workspaceHost, setWorkspaceHost] = useState<WebsshHost | null>(null)
  const [hostDialog, setHostDialog] = useState<{ open: boolean; host: WebsshHost | null }>({ open: false, host: null })
  const [groupsOpen, setGroupsOpen] = useState(false)
  const [credentialsOpen, setCredentialsOpen] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [fingerprintOpen, setFingerprintOpen] = useState(false)
  const [fingerprints, setFingerprints] = useState<WebsshHostKey[]>([])
  const [preflight, setPreflight] = useState<WebsshHostPreflight | null>(null)

  const refresh = () => setRefreshToken((value) => value + 1)
  const selected = hosts.find((host) => host.id === selectedId) ?? pinnedHost

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(queryInput)
      setPage(1)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [queryInput])

  useEffect(() => {
    let cancelled = false
    Promise.all([websshApi.listGroups(), websshApi.listKeys(), websshApi.listCredentials()])
      .then(([nextGroups, nextKeys, nextCredentials]) => {
        if (cancelled) return
        setGroups(nextGroups)
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
    setLoading(true)
    websshApi.listHosts({ q: query, groupId, favorite: favoriteOnly, sort, page, pageSize })
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
  }, [query, groupId, favoriteOnly, sort, page, pageSize, refreshToken])

  const selectHost = (id: string) => {
    setSelectedId(id)
    setPinnedHost(null)
    setPreflight(null)
    setFingerprints([])
    setWorkspaceHost(null)
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
        <IconButton label={t('webssh.actions.back')} size="sm" onClick={() => setWorkspaceHost(null)}>
          <ArrowLeft size={15} aria-hidden="true" />
        </IconButton>
        <span className="min-w-0 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
          {workspaceHost.name}
        </span>
        <span className="min-w-0 truncate font-mono text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {workspaceHost.username}@{workspaceHost.host}:{workspaceHost.port}
        </span>
        {DEMO_TRANSPORT && (
          <Tooltip label={t('webssh.app.demo_hint')}>
            <Badge tone="warning">{t('webssh.app.demo_badge')}</Badge>
          </Tooltip>
        )}
      </div>
      <TerminalWorkspace demoTransport={DEMO_TRANSPORT} />
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

  return (
    <div
      data-testid="webssh-app-root"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
        <SquareTerminal size={16} aria-hidden="true" className="shrink-0 text-[var(--text-secondary)]" />
        <h1 className="truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
          {t('webssh.app.title')}
        </h1>
        {DEMO_TRANSPORT && (
          <Tooltip label={t('webssh.app.demo_hint')}>
            <Badge tone="warning">{t('webssh.app.demo_badge')}</Badge>
          </Tooltip>
        )}
        <span className="hidden min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)] md:block">
          {t('webssh.app.subtitle')}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setGroupsOpen(true)} icon={<FolderTree size={13} aria-hidden="true" />}>
            {t('webssh.actions.groups')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCredentialsOpen(true)}>
            {t('webssh.actions.credentials')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setKeysOpen(true)} icon={<KeyRound size={13} aria-hidden="true" />}>
            {t('webssh.actions.keys')}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {(!isMobile || (!selected && !workspaceHost)) && (
          <HostList
            hosts={hosts}
            groups={groups}
            loading={loading}
            error={error}
            query={queryInput}
            groupId={groupId}
            favoriteOnly={favoriteOnly}
            sort={sort}
            selectedId={selectedId}
            page={page}
            pageSize={pageSize}
            total={total}
            onQueryChange={setQueryInput}
            onGroupChange={(value) => {
              setGroupId(value)
              setPage(1)
            }}
            onFavoriteToggle={() => {
              setFavoriteOnly((value) => !value)
              setPage(1)
            }}
            onSortChange={(value) => {
              setSort(value)
              setPage(1)
            }}
            onSelect={selectHost}
            onPageChange={setPage}
            onNew={() => setHostDialog({ open: true, host: null })}
            onRetry={refresh}
          />
        )}
        {(!isMobile || selected || workspaceHost) && rightPane}
      </div>

      <HostDialog
        open={hostDialog.open}
        host={hostDialog.host}
        groups={groups}
        credentials={credentials}
        keys={keys}
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

      <GroupDialog
        open={groupsOpen}
        groups={groups}
        onClose={() => setGroupsOpen(false)}
        onChanged={refresh}
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
