/**
 * The host list between the rail and the details pane.
 *
 * Rows carry what a connection decision needs: the folder, tags, a star, and when it last connected.
 * The menu is the app's own `Menu`, so the same row is reachable by right click, Shift+F10 and the
 * trailing button; drag reordering has a menu equivalent because a keyboard cannot drag.
 */
import { useMemo, useRef, useState, type RefObject } from 'react'
import {
  ArrowDown, ArrowUp, Copy, CopyPlus, FolderClosed, FolderInput, History, MoreHorizontal,
  Pencil, Plus, Rows3, Rows4, Search, SquareTerminal, Star, Tag as TagIcon, Trash2, X,
} from 'lucide-react'
import type {
  WebsshHost,
  WebsshHostGroup,
  WebsshHostQuickView,
  WebsshHostSessionSummary,
  WebsshHostSort,
  WebsshHostsOverview,
} from '@shared/webssh/types'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { isImeComposing } from '../../lib/ime'
import { copyText } from '../../lib/clipboard'
import { relativeTime, fullTime } from '../../lib/time'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Input } from '../../components/form'
import { Empty, NoteListSkeleton } from '../../components/feedback'
import { Menu, MenuSubmenuList, Modal, Tooltip, confirm, useContextMenu, type MenuItem } from '../../components/overlay'
import { SelectMenu } from '../../components/select-menu'
import { FolderPicker } from '../folders/FolderPicker'
import { useUi } from '../../store/ui'
import { ApiError } from '../../lib/api'
import { websshApi } from './api'
import { HostTagDialog } from './HostTagDialog'
import { WEBSSH_HOST_DRAG } from './HostSidebar'

export type HostDensity = 'comfortable' | 'compact'

const SESSION_STATUS_KEY: Record<WebsshHostSessionSummary['status'], 'webssh.history.status.pending' | 'webssh.history.status.connecting' | 'webssh.history.status.active' | 'webssh.history.status.closed' | 'webssh.history.status.error'> = {
  pending: 'webssh.history.status.pending',
  connecting: 'webssh.history.status.connecting',
  active: 'webssh.history.status.active',
  closed: 'webssh.history.status.closed',
  error: 'webssh.history.status.error',
}

export interface HostListProps {
  hosts: WebsshHost[]
  groups: WebsshHostGroup[]
  overview: WebsshHostsOverview | null
  loading: boolean
  error: string | null
  query: string
  quick: WebsshHostQuickView
  folderId: string
  tag: string
  sort: WebsshHostSort
  density: HostDensity
  selectedId: string | null
  chosen: Set<string>
  page: number
  pageSize: number
  total: number
  searchRef: RefObject<HTMLInputElement | null>
  onQueryChange: (value: string) => void
  onSortChange: (value: WebsshHostSort) => void
  onDensityChange: (value: HostDensity) => void
  onSelect: (id: string) => void
  onChosenChange: (ids: Set<string>) => void
  onPageChange: (page: number) => void
  onNew: () => void
  onRetry: () => void
  onConnect: (host: WebsshHost) => void
  onNewTab: (host: WebsshHost) => void
  onEdit: (host: WebsshHost) => void
  onFilterTag: (tag: string) => void
  onFilterFolder: (folderId: string) => void
  onClearFilters: () => void
  onChanged: () => void
}

export function HostList(props: HostListProps) {
  const toast = useUi((state) => state.toast)
  const menu = useContextMenu()
  const [menuHost, setMenuHost] = useState<WebsshHost | null>(null)
  const [moveIds, setMoveIds] = useState<string[] | null>(null)
  const [tagIds, setTagIds] = useState<string[] | null>(null)
  const [history, setHistory] = useState<{ host: WebsshHost; sessions: WebsshHostSessionSummary[]; loading: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const groupNames = new Map(props.groups.map((group) => [group.id, group.name]))
  const pageCount = Math.max(1, Math.ceil(props.total / props.pageSize))
  const selectedHosts = props.hosts.filter((host) => props.chosen.has(host.id))
  const allChosen = props.hosts.length > 0 && selectedHosts.length === props.hosts.length
  const filtering = Boolean(props.query || props.folderId || props.tag || props.quick !== 'all')

  const pickerFolders = useMemo(() => props.groups.map((group) => ({
    id: group.id,
    parentId: group.parentId || null,
    name: group.name,
    icon: group.icon || null,
    color: group.color || null,
    position: group.position,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    noteCount: props.overview?.folders.find((folder) => folder.id === group.id)?.hostCount,
  })), [props.groups, props.overview])

  const applyAction = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try {
      await action()
      toast({ title: success, tone: 'success' })
      props.onChanged()
    } catch (caught) {
      toast({ title: caught instanceof ApiError ? caught.message : t('webssh.error.generic'), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const toggleFavorite = async (host: WebsshHost) => {
    await applyAction(
      () => websshApi.patchHost(host.id, { favorite: !host.favorite }),
      host.favorite ? t('webssh.toast.unfavorited') : t('webssh.toast.favorited'),
    )
  }

  const duplicate = async (host: WebsshHost) => {
    await applyAction(() => websshApi.duplicateHost(host.id), t('webssh.toast.host_duplicated'))
  }

  const copyAddress = async (host: WebsshHost) => {
    const ok = await copyText(`${host.username}@${host.host}:${host.port}`)
    toast({ title: ok ? t('webssh.toast.address_copied') : t('webssh.common.copy_failed'), tone: ok ? 'success' : 'danger' })
  }

  const moveHosts = async (ids: string[], groupId: string) => {
    if (ids.length === 1) {
      await applyAction(() => websshApi.moveHost(ids[0]!, { groupId }), t('webssh.toast.host_moved'))
      return
    }
    await applyAction(() => websshApi.batchHosts({ action: 'move', ids, groupId }), t('webssh.toast.hosts_moved', { count: ids.length }))
  }

  const tagHosts = async (ids: string[], tags: string[]) => {
    if (ids.length === 1) {
      const host = props.hosts.find((entry) => entry.id === ids[0])
      if (!host) return
      const merged = [...new Set([...host.tags, ...tags])]
      await applyAction(() => websshApi.patchHost(host.id, { tags: merged }), t('webssh.toast.tags_added'))
      return
    }
    await applyAction(() => websshApi.batchHosts({ action: 'tag', ids, tags }), t('webssh.toast.tags_added'))
  }

  const removeHosts = async (targets: WebsshHost[]) => {
    if (targets.length === 0) return
    const agreed = await confirm({
      title: targets.length === 1
        ? t('webssh.host.remove_title')
        : t('webssh.list.batch_delete_title', { count: targets.length }),
      description: targets.length === 1
        ? t('webssh.host.remove_description', { name: targets[0]!.name })
        : t('webssh.list.batch_delete_body'),
      confirmLabel: t('webssh.actions.delete'),
      tone: 'danger',
    })
    if (!agreed) return
    const ids = targets.map((host) => host.id)
    const action = ids.length === 1
      ? () => websshApi.deleteHost(ids[0]!)
      : () => websshApi.batchHosts({ action: 'delete', ids })
    await applyAction(action, t('webssh.toast.host_deleted'))
    props.onChosenChange(new Set())
    if (props.selectedId && ids.includes(props.selectedId)) props.onSelect('')
  }

  const batchFavorite = async () => {
    const allStarred = selectedHosts.every((host) => host.favorite)
    await applyAction(
      () => websshApi.batchHosts({ action: allStarred ? 'unfavorite' : 'favorite', ids: selectedHosts.map((host) => host.id) }),
      allStarred ? t('webssh.toast.unfavorited') : t('webssh.toast.favorited'),
    )
  }

  const reorder = async (host: WebsshHost, direction: 'up' | 'down') => {
    const peers = props.hosts.filter((entry) => entry.groupId === host.groupId)
    const index = peers.findIndex((entry) => entry.id === host.id)
    if (direction === 'up') {
      const target = peers[index - 1]
      if (!target) return
      await applyAction(
        () => websshApi.moveHost(host.id, { groupId: host.groupId, beforeId: target.id }),
        t('webssh.toast.host_moved'),
      )
      return
    }
    const target = peers[index + 2]
    await applyAction(
      () => websshApi.moveHost(host.id, { groupId: host.groupId, beforeId: target?.id ?? '' }),
      t('webssh.toast.host_moved'),
    )
  }

  const openMenu = (host: WebsshHost, event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!props.chosen.has(host.id)) props.onChosenChange(new Set([host.id]))
    setMenuHost(host)
    menu.close()
    menu.onContextMenu(event)
  }

  const openMenuFromKeyboard = (host: WebsshHost, event: React.KeyboardEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    openMenu(host, {
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      clientX: rect.left,
      clientY: rect.bottom,
    } as unknown as React.MouseEvent)
  }

  const focusRow = (offset: number, currentId: string) => {
    const index = props.hosts.findIndex((host) => host.id === currentId)
    const next = props.hosts[Math.max(0, Math.min(props.hosts.length - 1, index + offset))]
    if (next) rowRefs.current.get(next.id)?.focus()
  }

  const openHistory = (host: WebsshHost) => {
    setHistory({ host, sessions: [], loading: true })
    websshApi.hostSessions(host.id)
      .then((sessions) => setHistory({ host, sessions, loading: false }))
      .catch((caught: unknown) => {
        setHistory({ host, sessions: [], loading: false })
        toast({ title: caught instanceof ApiError ? caught.message : t('webssh.error.generic'), tone: 'danger' })
      })
  }

  const menuHostActions: MenuItem[] = menuHost ? [
    { id: 'connect', label: t('webssh.menu.connect'), icon: <SquareTerminal size={13} aria-hidden="true" />, combo: '↵', onSelect: () => props.onConnect(menuHost) },
    { id: 'new-tab', label: t('webssh.menu.new_tab'), icon: <Plus size={13} aria-hidden="true" />, onSelect: () => props.onNewTab(menuHost) },
    { id: 'edit', label: t('webssh.actions.edit'), icon: <Pencil size={13} aria-hidden="true" />, combo: 'F2', onSelect: () => props.onEdit(menuHost) },
    { id: 'duplicate', label: t('webssh.menu.duplicate'), icon: <CopyPlus size={13} aria-hidden="true" />, onSelect: () => void duplicate(menuHost) },
    { id: 'copy', label: t('webssh.menu.copy_address'), icon: <Copy size={13} aria-hidden="true" />, separatorBefore: true, onSelect: () => void copyAddress(menuHost) },
    { id: 'move', label: t('webssh.menu.move'), icon: <FolderInput size={13} aria-hidden="true" />, separatorBefore: true, onSelect: () => setMoveIds([menuHost.id]) },
    { id: 'tag', label: t('webssh.menu.tag'), icon: <TagIcon size={13} aria-hidden="true" />, onSelect: () => setTagIds([menuHost.id]) },
    {
      id: 'favorite',
      label: menuHost.favorite ? t('webssh.menu.unfavorite') : t('webssh.menu.favorite'),
      icon: <Star size={13} aria-hidden="true" />,
      checked: menuHost.favorite,
      onSelect: () => void toggleFavorite(menuHost),
    },
    {
      id: 'order',
      label: t('webssh.menu.order'),
      icon: <ArrowUp size={13} aria-hidden="true" />,
      separatorBefore: true,
      disabled: props.sort !== 'manual',
      reason: props.sort === 'manual' ? undefined : t('webssh.menu.reason_manual_sort'),
      submenu: ({ closeMenu }) => (
        <MenuSubmenuList
          label={t('webssh.menu.order')}
          items={[
            { id: 'up', label: t('webssh.menu.move_up'), icon: <ArrowUp size={13} aria-hidden="true" />, onSelect: () => { closeMenu(); void reorder(menuHost, 'up') } },
            { id: 'down', label: t('webssh.menu.move_down'), icon: <ArrowDown size={13} aria-hidden="true" />, onSelect: () => { closeMenu(); void reorder(menuHost, 'down') } },
          ]}
        />
      ),
    },
    { id: 'history', label: t('webssh.menu.history'), icon: <History size={13} aria-hidden="true" />, onSelect: () => openHistory(menuHost) },
    { id: 'delete', label: t('webssh.actions.delete'), icon: <Trash2 size={13} aria-hidden="true" />, tone: 'danger', separatorBefore: true, onSelect: () => void removeHosts([menuHost]) },
  ] : []

  return (
    <section
      aria-label={t('webssh.list.title')}
      className="flex min-h-0 w-full flex-col border-[var(--border-subtle)] md:w-[360px] md:shrink-0 md:border-r"
    >
      <div className="shrink-0 space-y-2 border-b border-[var(--border-subtle)] p-3">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <Input
              ref={props.searchRef}
              value={props.query}
              onChange={(event) => props.onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (isImeComposing(event)) return
                if (event.key === 'Escape' && props.query) {
                  event.preventDefault()
                  props.onQueryChange('')
                }
              }}
              placeholder={t('webssh.list.search_placeholder')}
              aria-label={t('webssh.list.search_placeholder')}
              aria-keyshortcuts="Meta+K Control+K"
              leading={<Search size={13} aria-hidden="true" />}
              trailing={props.query ? (
                <IconButton label={t('webssh.list.clear_search')} size="xs" onClick={() => props.onQueryChange('')}>
                  <X size={11} aria-hidden="true" />
                </IconButton>
              ) : undefined}
            />
          </div>
          <Tooltip label={t('webssh.actions.new_host')} side="bottom">
            <IconButton label={t('webssh.actions.new_host')} variant="primary" onClick={props.onNew}>
              <Plus size={14} aria-hidden="true" />
            </IconButton>
          </Tooltip>
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {filtering ? t('webssh.list.filtered_count', { count: props.total }) : t('webssh.list.count', { count: props.total })}
          </p>
          <div className="flex shrink-0 items-center gap-0.5">
            {filtering && (
              <Tooltip label={t('webssh.list.clear_filters')} side="bottom">
                <IconButton label={t('webssh.list.clear_filters')} size="sm" onClick={props.onClearFilters}>
                  <X size={13} aria-hidden="true" />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip label={props.density === 'compact' ? t('webssh.list.comfortable') : t('webssh.list.compact')} side="bottom">
              <IconButton
                label={props.density === 'compact' ? t('webssh.list.comfortable') : t('webssh.list.compact')}
                size="sm"
                onClick={() => props.onDensityChange(props.density === 'compact' ? 'comfortable' : 'compact')}
              >
                {props.density === 'compact' ? <Rows4 size={13} aria-hidden="true" /> : <Rows3 size={13} aria-hidden="true" />}
              </IconButton>
            </Tooltip>
            <SelectMenu
              size="sm"
              width={168}
              label={t('webssh.list.sort')}
              value={props.sort}
              onChange={(value) => props.onSortChange(value as WebsshHostSort)}
              options={[
                { value: 'manual', label: t('webssh.list.sort_manual') },
                { value: 'name', label: t('webssh.list.sort_name') },
                { value: 'recent', label: t('webssh.list.sort_recent') },
                { value: 'created', label: t('webssh.list.sort_created') },
              ]}
              className="w-[116px]"
            />
          </div>
        </div>

        {selectedHosts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-[var(--r-md)] bg-[var(--bg-raised)] p-1.5">
            <span className="px-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('webssh.list.selected', { count: selectedHosts.length })}
            </span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setTagIds(selectedHosts.map((host) => host.id))}>
              {t('webssh.list.batch_tag')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMoveIds(selectedHosts.map((host) => host.id))}>
              {t('webssh.list.batch_move')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void batchFavorite()}>
              {t('webssh.list.batch_favorite')}
            </Button>
            <Button size="sm" variant="ghost" className="text-[var(--danger)]" disabled={busy} onClick={() => void removeHosts(selectedHosts)}>
              {t('webssh.actions.delete')}
            </Button>
            <IconButton label={t('webssh.list.clear_selection')} size="xs" onClick={() => props.onChosenChange(new Set())}>
              <X size={11} aria-hidden="true" />
            </IconButton>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest('[data-webssh-host-row]')) return
        event.preventDefault()
      }}>
        {props.loading && props.hosts.length === 0 && <NoteListSkeleton count={7} />}
        {!props.loading && props.error && (
          <div className="p-6 text-center text-[length:var(--text-12)] text-[var(--danger)]">
            <p>{props.error}</p>
            <Button size="sm" variant="secondary" className="mt-3" onClick={props.onRetry}>{t('webssh.actions.retry')}</Button>
          </div>
        )}
        {!props.loading && !props.error && props.hosts.length === 0 && (
          <Empty
            art={props.query || props.tag ? 'search' : props.folderId ? 'folder' : 'select'}
            title={filtering ? t('webssh.list.no_results') : t('webssh.list.empty_title')}
            description={filtering ? t('webssh.list.no_results_hint') : t('webssh.list.empty_description')}
            compact
            action={!filtering && (
              <Button variant="primary" icon={<Plus size={13} aria-hidden="true" />} onClick={props.onNew}>
                {t('webssh.actions.new_host')}
              </Button>
            )}
          />
        )}
        {props.hosts.length > 0 && (
          <>
            <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5">
              <Checkbox
                checked={allChosen}
                ariaLabel={t('webssh.list.select_all')}
                onChange={(next) => props.onChosenChange(next ? new Set(props.hosts.map((host) => host.id)) : new Set())}
              />
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                {t('webssh.list.select_all')}
              </span>
              <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('webssh.list.page_of', { page: props.page, count: pageCount })}</span>
            </div>
            <div role="list" aria-label={t('webssh.list.title')}>
              {props.hosts.map((host) => {
                const on = props.chosen.has(host.id)
                const selected = host.id === props.selectedId
                const folderName = host.groupId ? groupNames.get(host.groupId) : undefined
                return (
                  <div
                    key={host.id}
                    role="listitem"
                    tabIndex={0}
                    data-webssh-host-row
                    data-host-id={host.id}
                    draggable
                    ref={(node) => {
                      if (node) rowRefs.current.set(host.id, node)
                      else rowRefs.current.delete(host.id)
                    }}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(WEBSSH_HOST_DRAG, host.id)
                      event.dataTransfer.effectAllowed = 'move'
                      if (!props.chosen.has(host.id)) props.onChosenChange(new Set([host.id]))
                    }}
                    onDragOver={(event) => {
                      if (!event.dataTransfer.types.includes(WEBSSH_HOST_DRAG)) return
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                    }}
                    onDrop={(event) => {
                      const dragged = event.dataTransfer.getData(WEBSSH_HOST_DRAG)
                      if (!dragged || dragged === host.id) return
                      event.preventDefault()
                      void applyAction(
                        () => websshApi.moveHost(dragged, { groupId: host.groupId, beforeId: host.id }),
                        t('webssh.toast.host_moved'),
                      )
                    }}
                    onClick={() => props.onSelect(host.id)}
                    onDoubleClick={() => props.onConnect(host)}
                    onContextMenu={(event) => openMenu(host, event)}
                    onKeyDown={(event) => {
                      if (isImeComposing(event)) return
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        props.onSelect(host.id)
                      }
                      if (event.key === 'F2') {
                        event.preventDefault()
                        props.onEdit(host)
                      }
                      if (event.key === 'Delete') {
                        event.preventDefault()
                        void removeHosts([host])
                      }
                      if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        focusRow(1, host.id)
                      }
                      if (event.key === 'ArrowUp') {
                        event.preventDefault()
                        focusRow(-1, host.id)
                      }
                      if (event.key === 'F10' && event.shiftKey) {
                        event.preventDefault()
                        openMenuFromKeyboard(host, event)
                      }
                    }}
                    className={cn(
                      'group relative flex cursor-default items-start gap-2 border-b border-[var(--border-subtle)] px-3 transition-colors duration-[var(--dur-fast)]',
                      props.density === 'compact' ? 'py-1.5' : 'py-2.5',
                      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
                      selected ? 'bg-[var(--bg-raised)]' : on ? 'bg-[var(--accent-soft)]/35' : 'hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                      <Checkbox
                        checked={on}
                        ariaLabel={t('webssh.list.select_one', { name: host.name })}
                        onChange={(next) => {
                          const updated = new Set(props.chosen)
                          if (next) updated.add(host.id)
                          else updated.delete(host.id)
                          props.onChosenChange(updated)
                        }}
                        className="mt-0.5"
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {host.color && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: host.color }} />}
                        <span className="min-w-0 truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{host.name}</span>
                        {props.density === 'comfortable' && (
                          <span className="shrink-0 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
                            {host.lastConnectedAt ? relativeTime(host.lastConnectedAt) : t('webssh.list.never')}
                          </span>
                        )}
                        <span onClick={(event) => event.stopPropagation()}>
                          <Tooltip label={host.favorite ? t('webssh.menu.unfavorite') : t('webssh.menu.favorite')} side="bottom">
                            <IconButton
                              label={host.favorite ? t('webssh.menu.unfavorite') : t('webssh.menu.favorite')}
                              size="xs"
                              aria-pressed={host.favorite}
                              onClick={() => void toggleFavorite(host)}
                            >
                              <Star size={12} aria-hidden="true" className={host.favorite ? 'fill-[var(--warning)] text-[var(--warning)]' : 'text-[var(--text-quaternary)]'} />
                            </IconButton>
                          </Tooltip>
                        </span>
                        <IconButton
                          label={t('webssh.list.more_actions')}
                          size="xs"
                          className="opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                          onClick={(event) => openMenu(host, event)}
                        >
                          <MoreHorizontal size={12} aria-hidden="true" />
                        </IconButton>
                      </div>
                      <div className={cn('truncate font-mono text-[length:var(--text-11-5)] text-[var(--text-tertiary)]', props.density === 'compact' ? 'mt-0.5' : 'mt-0.5')}>
                        {host.username}@{host.host}:{host.port}
                        {props.density === 'compact' && <span className="ms-2 text-[var(--text-quaternary)]">{host.lastConnectedAt ? relativeTime(host.lastConnectedAt) : t('webssh.list.never')}</span>}
                      </div>
                      {props.density === 'comfortable' && (folderName || host.tags.length > 0) && (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {folderName && (
                            <button
                              type="button"
                              onClick={(event) => { event.stopPropagation(); props.onFilterFolder(host.groupId) }}
                              className="inline-flex items-center gap-1 rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]"
                            >
                              <FolderClosed size={9} aria-hidden="true" />
                              {folderName}
                            </button>
                          )}
                          {host.tags.slice(0, 3).map((tag) => (
                            <button
                              key={tag}
                              type="button"
                              onClick={(event) => { event.stopPropagation(); props.onFilterTag(tag) }}
                              className="rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]"
                            >
                              {tag}
                            </button>
                          ))}
                          {host.tags.length > 3 && <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">+{host.tags.length - 3}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {pageCount > 1 && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3 py-2">
          <Button size="sm" variant="ghost" disabled={props.page <= 1} onClick={() => props.onPageChange(props.page - 1)}>
            {t('webssh.actions.previous')}
          </Button>
          <span className="text-[length:var(--text-11-5)] tabular text-[var(--text-tertiary)]">
            {t('webssh.list.page_of', { page: props.page, count: pageCount })}
          </span>
          <Button size="sm" variant="ghost" disabled={props.page >= pageCount} onClick={() => props.onPageChange(props.page + 1)}>
            {t('webssh.actions.next')}
          </Button>
        </div>
      )}

      {menu.point && <Menu anchor={menu.point} open onClose={() => { menu.close(); setMenuHost(null) }} items={menuHostActions} />}
      <FolderPicker
        open={moveIds !== null}
        title={t('webssh.menu.move')}
        folders={pickerFolders}
        allowRoot
        rootLabel={t('webssh.list.folder_root')}
        onSelect={(folderId) => {
          const ids = moveIds ?? []
          setMoveIds(null)
          void moveHosts(ids, folderId ?? '')
        }}
        onClose={() => setMoveIds(null)}
      />
      <HostTagDialog
        open={tagIds !== null}
        existingTags={props.overview?.tags ?? []}
        hostCount={tagIds?.length ?? 0}
        onClose={() => setTagIds(null)}
        onConfirm={(tags) => {
          const ids = tagIds ?? []
          setTagIds(null)
          void tagHosts(ids, tags)
        }}
      />
      <HostHistoryDialog state={history} onClose={() => setHistory(null)} />
    </section>
  )
}

function HostHistoryDialog({
  state,
  onClose,
}: {
  state: { host: WebsshHost; sessions: WebsshHostSessionSummary[]; loading: boolean } | null
  onClose: () => void
}) {
  return (
    <Modal
      open={state !== null}
      onClose={onClose}
      title={state ? t('webssh.history.title', { name: state.host.name }) : t('webssh.history.title_generic')}
      width={520}
      footer={<Button variant="ghost" onClick={onClose}>{t('webssh.actions.close')}</Button>}
    >
      {state?.loading && <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('webssh.common.loading')}</p>}
      {state && !state.loading && state.sessions.length === 0 && (
        <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('webssh.history.empty')}</p>
      )}
      {state && !state.loading && state.sessions.length > 0 && (
        <ul className="divide-y divide-[var(--border-subtle)]">
          {state.sessions.map((session) => (
            <li key={session.id} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1">
                <Tooltip label={fullTime(session.startedAt)} side="bottom">
                  <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{relativeTime(session.startedAt)}</span>
                </Tooltip>
                <span className="ms-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{session.closeReason || session.errorCode || '—'}</span>
              </span>
              <span className={cn(
                'shrink-0 rounded-[var(--r-xs)] px-1.5 py-0.5 text-[length:var(--text-10-5)]',
                session.status === 'error' ? 'bg-[var(--danger)]/10 text-[var(--danger)]' : 'bg-[var(--bg-inset)] text-[var(--text-tertiary)]',
              )}>
                {t(SESSION_STATUS_KEY[session.status])}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
