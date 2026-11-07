/**
 * The host rail: saved views, the folder tree and the tag tree.
 *
 * The shape follows the ScriptsHub rail so a reader who knows one organizer knows the other: views at
 * the top with their counts, then folders with inline counts, then tags. A host dragged onto a folder
 * row is moved there; the same move is reachable from the folder and row menus for keyboard users.
 */
import { useMemo, useState } from 'react'
import {
  ChevronRight, FolderClosed, FolderInput, FolderPlus, History,
  LayoutList, MoreHorizontal, Palette, Pencil, Pin, Plus, Star, Tag, Trash2, X,
} from 'lucide-react'
import type {
  WebsshHostFolder,
  WebsshHostQuickView,
  WebsshHostsOverview,
  WebsshProvider,
} from '@shared/webssh/types'
import { WEBSSH_BUILTIN_PROVIDERS } from '@shared/webssh/providers'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Input, commitOnEnter } from '../../components/form'
import { Drawer, Menu, MenuSubmenuList, Modal, confirm, useContextMenu, type MenuItem } from '../../components/overlay'
import { ColorWellField } from '../../components/color-field'
import { FolderColorMenu } from '../folders/FolderAppearanceMenus'
import { HostIcon, providerText } from './HostIcon'
import { websshApi } from './api'
import { ApiError } from '../../lib/api'
import { useUi } from '../../store/ui'

export const WEBSSH_HOST_DRAG = 'application/x-webssh-host'

export interface HostSidebarSelection {
  quick: WebsshHostQuickView
  folderId: string
  tag: string
  provider: string
}

interface FolderDialogState {
  mode: 'create' | 'rename'
  parentId: string
  folder: WebsshHostFolder | null
  name: string
  color: string
}

export function HostSidebar({
  open,
  mobile = false,
  overview,
  providers,
  selection,
  onOpenChange,
  onSelectQuick,
  onSelectFolder,
  onSelectTag,
  onSelectProvider,
  onNewHost,
  onMoveHost,
  onChanged,
}: {
  open: boolean
  mobile?: boolean
  overview: WebsshHostsOverview | null
  providers: readonly WebsshProvider[]
  selection: HostSidebarSelection
  onOpenChange: (open: boolean) => void
  onSelectQuick: (quick: WebsshHostQuickView) => void
  onSelectFolder: (folderId: string) => void
  onSelectTag: (tag: string) => void
  onSelectProvider: (provider: string) => void
  onNewHost: (folderId: string) => void
  onMoveHost: (hostId: string, groupId: string) => void
  onChanged: () => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<FolderDialogState | null>(null)
  const [saving, setSaving] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const toast = useUi((state) => state.toast)
  const folders = overview?.folders ?? []
  const tags = overview?.tags ?? []
  const providerCounts = new Map((overview?.providers ?? []).map((entry) => [entry.id, entry]))
  const providerIds = [...WEBSSH_BUILTIN_PROVIDERS.map((provider) => provider.id), ...providers.filter((provider) => provider.id.startsWith('custom:')).map((provider) => provider.id)]
  const tree = useMemo(() => buildFolderTree(folders), [folders])

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submitDialog = async () => {
    if (!dialog) return
    const name = dialog.name.trim()
    if (!name) return
    setSaving(true)
    setDialogError(null)
    try {
      if (dialog.mode === 'create') {
        await websshApi.createGroup({ name, parentId: dialog.parentId || undefined, color: dialog.color })
        if (dialog.parentId) setExpanded((current) => new Set(current).add(dialog.parentId))
      } else if (dialog.folder) {
        await websshApi.updateGroup(dialog.folder.id, { name, color: dialog.color })
      }
      setDialog(null)
      onChanged()
    } catch (caught) {
      setDialogError(caught instanceof ApiError ? caught.message : t('webssh.error.generic'))
    } finally {
      setSaving(false)
    }
  }

  const deleteFolder = async (folder: WebsshHostFolder) => {
    const agreed = await confirm({
      title: t('webssh.folder.delete_title', { name: folder.name }),
      description: t('webssh.folder.delete_body', { count: folder.hostCount }),
      confirmLabel: t('webssh.actions.delete'),
      tone: 'danger',
    })
    if (!agreed) return
    try {
      await websshApi.deleteGroup(folder.id)
      toast({ title: t('webssh.toast.folder_deleted'), tone: 'success' })
      onChanged()
    } catch (caught) {
      toast({ title: caught instanceof ApiError ? caught.message : t('webssh.error.generic'), tone: 'danger' })
    }
  }

  const setColor = async (folder: WebsshHostFolder, color: string | null) => {
    try {
      await websshApi.updateGroup(folder.id, { color: color ?? '' })
      onChanged()
    } catch (caught) {
      toast({ title: caught instanceof ApiError ? caught.message : t('webssh.error.generic'), tone: 'danger' })
    }
  }

  const content = (
    <div className="flex h-full min-h-0 w-full flex-col">
      <nav aria-label={t('webssh.sidebar.views')} className="space-y-px px-2 pt-2">
        <ViewRow
          active={selection.quick === 'all' && !selection.folderId && !selection.tag && !selection.provider}
          icon={<LayoutList size={14} aria-hidden="true" />}
          label={t('webssh.sidebar.all')}
          count={overview?.total}
          onClick={() => onSelectQuick('all')}
        />
        <ViewRow
          active={selection.quick === 'favorites' && !selection.folderId && !selection.tag && !selection.provider}
          icon={<Star size={14} aria-hidden="true" />}
          label={t('webssh.sidebar.favorites')}
          count={overview?.favorites}
          onClick={() => onSelectQuick('favorites')}
        />
        <ViewRow
          active={selection.quick === 'pinned' && !selection.folderId && !selection.tag && !selection.provider}
          icon={<Pin size={14} aria-hidden="true" />}
          label={t('webssh.sidebar.pinned')}
          count={overview?.pinned}
          onClick={() => onSelectQuick('pinned')}
        />
        <ViewRow
          active={selection.quick === 'recent' && !selection.folderId && !selection.tag && !selection.provider}
          icon={<History size={14} aria-hidden="true" />}
          label={t('webssh.sidebar.recent')}
          count={overview?.connected}
          onClick={() => onSelectQuick('recent')}
        />
      </nav>

      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-3">
        <section aria-labelledby="webssh-folders-heading">
          <div className="flex items-center gap-1 px-1.5">
            <p id="webssh-folders-heading" className="min-w-0 flex-1 text-[length:var(--text-10-5)] font-semibold tracking-wide text-[var(--text-quaternary)] uppercase">
              {t('webssh.sidebar.folders')}
            </p>
            <IconButton
              label={t('webssh.sidebar.new_folder')}
              size="xs"
              onClick={() => {
                setDialogError(null)
                setDialog({ mode: 'create', parentId: '', folder: null, name: '', color: '' })
              }}
            >
              <FolderPlus size={12} aria-hidden="true" />
            </IconButton>
          </div>
          <div role="group" aria-label={t('webssh.sidebar.folders')} className="mt-1 space-y-px">
            {tree.length === 0 && (
              <p className="px-2 py-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('webssh.sidebar.no_folders')}</p>
            )}
            {tree.map((node) => (
              <FolderNode
                key={node.folder.id}
                node={node}
                depth={0}
                allFolders={folders}
                expanded={expanded}
                activeId={selection.folderId}
                onToggle={toggle}
                onChoose={(id) => onSelectFolder(id)}
                onNewSubfolder={(parentId) => {
                  setDialogError(null)
                  setDialog({ mode: 'create', parentId, folder: null, name: '', color: '' })
                }}
                onNewHost={onNewHost}
                onRename={(folder) => {
                  setDialogError(null)
                  setDialog({ mode: 'rename', parentId: folder.parentId, folder, name: folder.name, color: folder.color })
                }}
                onColor={setColor}
                onDelete={deleteFolder}
                onDropHost={onMoveHost}
                onChanged={onChanged}
              />
            ))}
            <div
              className="rounded-[var(--r-md)] px-2 py-1.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]"
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(WEBSSH_HOST_DRAG)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(event) => {
                const hostId = event.dataTransfer.getData(WEBSSH_HOST_DRAG)
                if (hostId) onMoveHost(hostId, '')
              }}
            >
              {t('webssh.sidebar.drop_root')}
            </div>
          </div>
        </section>

        <section aria-labelledby="webssh-tags-heading">
          <p id="webssh-tags-heading" className="px-1.5 text-[length:var(--text-10-5)] font-semibold tracking-wide text-[var(--text-quaternary)] uppercase">
            {t('webssh.sidebar.tags')}
          </p>
          <div role="group" aria-label={t('webssh.sidebar.tags')} className="mt-1 space-y-px">
            {tags.length === 0 && (
              <p className="px-2 py-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('webssh.sidebar.no_tags')}</p>
            )}
            {selection.tag && (
              <button
                type="button"
                onClick={() => onSelectTag('')}
                className="flex h-9 w-full items-center gap-1.5 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-11-5)] text-[var(--accent-on-soft)] hover:bg-[var(--bg-hover)] md:h-[26px]"
              >
                <X size={11} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{t('webssh.sidebar.clear_tag')}</span>
              </button>
            )}
            {tags.map((tag) => (
              <button
                key={tag.name}
                type="button"
                aria-current={selection.tag === tag.name ? 'page' : undefined}
                onClick={() => onSelectTag(tag.name)}
                className={cn(
                  'flex h-9 w-full items-center gap-1.5 rounded-[var(--r-md)] px-2 text-left md:h-[26px]',
                  selection.tag === tag.name
                    ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                <Tag size={12} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)]">{tag.name}</span>
                <span className="tabular shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">{tag.count}</span>
              </button>
            ))}
          </div>
        </section>

        <section aria-labelledby="webssh-providers-heading">
          <p id="webssh-providers-heading" className="px-1.5 text-[length:var(--text-10-5)] font-semibold tracking-wide text-[var(--text-quaternary)] uppercase">
            {t('webssh.sidebar.providers')}
          </p>
          <div role="group" aria-label={t('webssh.sidebar.providers')} className="mt-1 space-y-px">
            {selection.provider && (
              <button
                type="button"
                onClick={() => onSelectProvider('')}
                className="flex h-9 w-full items-center gap-1.5 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-11-5)] text-[var(--accent-on-soft)] hover:bg-[var(--bg-hover)] md:h-[26px]"
              >
                <X size={11} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{t('webssh.sidebar.clear_provider')}</span>
              </button>
            )}
            {providerIds.map((id) => {
              const count = providerCounts.get(id)
              const label = providerText(id, providers)
              return (
                <button
                  key={id}
                  type="button"
                  aria-current={selection.provider === id ? 'page' : undefined}
                  onClick={() => onSelectProvider(selection.provider === id ? '' : id)}
                  className={cn(
                    'flex h-9 w-full items-center gap-1.5 rounded-[var(--r-md)] px-2 text-left md:h-[26px]',
                    selection.provider === id
                      ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                    !count?.hostCount && 'opacity-60',
                  )}
                >
                  <HostIcon host={{ name: '', provider: id, iconKind: '', iconValue: '', iconUrl: '' }} providers={providers} size={13} />
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)]">{label}</span>
                  {count && count.hostCount > 0 && (
                    <span className="tabular shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">{count.hostCount}</span>
                  )}
                </button>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )

  return (
    <>
      {mobile ? (
        <Drawer open={open} onClose={() => onOpenChange(false)} side="left" width={286} title={t('webssh.sidebar.title')}>
          {content}
        </Drawer>
      ) : (
        <aside
          id="webssh-sidebar"
          aria-hidden={!open}
          {...(open ? {} : { inert: true })}
          className={cn(
            'h-full min-h-0 shrink-0 overflow-hidden bg-[var(--bg-sunken)]',
            'transition-[width,border-color] duration-[var(--dur-base)] ease-[var(--ease-out)] motion-reduce:transition-none',
            'hidden md:block',
            open ? 'w-[232px] border-r border-[var(--border-subtle)]' : 'w-0 border-r-0 border-transparent',
          )}
        >
          <div className="h-full w-[232px]">{content}</div>
        </aside>
      )}
      <FolderNameDialog
        state={dialog}
        saving={saving}
        error={dialogError}
        onChange={setDialog}
        onClose={() => setDialog(null)}
        onSubmit={() => void submitDialog()}
      />
    </>
  )
}

function ViewRow({ active, icon, label, count, onClick }: {
  active: boolean
  icon: React.ReactNode
  label: string
  count: number | undefined
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'flex h-10 w-full items-center gap-2 rounded-[var(--r-md)] px-2.5 text-left text-[length:var(--text-12-5)] md:h-[30px]',
        active ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="tabular shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{count}</span>
      )}
    </button>
  )
}

interface FolderTreeNode {
  folder: WebsshHostFolder
  children: FolderTreeNode[]
}

function buildFolderTree(folders: readonly WebsshHostFolder[]): FolderTreeNode[] {
  const byParent = new Map<string, WebsshHostFolder[]>()
  for (const folder of folders) {
    const siblings = byParent.get(folder.parentId) ?? []
    siblings.push(folder)
    byParent.set(folder.parentId, siblings)
  }
  const build = (parentId: string): FolderTreeNode[] => (byParent.get(parentId) ?? [])
    .map((folder) => ({ folder, children: build(folder.id) }))
  return build('')
}

function descendantIds(folders: readonly WebsshHostFolder[], id: string): Set<string> {
  const out = new Set<string>()
  const walk = (parentId: string) => {
    for (const folder of folders) {
      if (folder.parentId !== parentId) continue
      out.add(folder.id)
      walk(folder.id)
    }
  }
  walk(id)
  return out
}

function FolderNode({
  node, depth, allFolders, expanded, activeId,
  onToggle, onChoose, onNewSubfolder, onNewHost, onRename, onColor, onDelete, onDropHost, onChanged,
}: {
  node: FolderTreeNode
  depth: number
  allFolders: readonly WebsshHostFolder[]
  expanded: Set<string>
  activeId: string
  onToggle: (id: string) => void
  onChoose: (id: string) => void
  onNewSubfolder: (parentId: string) => void
  onNewHost: (folderId: string) => void
  onRename: (folder: WebsshHostFolder) => void
  onColor: (folder: WebsshHostFolder, color: string | null) => void
  onDelete: (folder: WebsshHostFolder) => void
  onDropHost: (hostId: string, groupId: string) => void
  onChanged: () => void
}) {
  const menu = useContextMenu()
  const [over, setOver] = useState(false)
  const isOpen = expanded.has(node.folder.id)
  const hasChildren = node.children.length > 0
  const excluded = descendantIds(allFolders, node.folder.id)
  const moveTargets = allFolders.filter((folder) => folder.id !== node.folder.id && !excluded.has(folder.id))

  const moveInto = async (targetId: string) => {
    await websshApi.updateGroup(node.folder.id, { parentId: targetId })
    onChanged()
  }

  const items: MenuItem[] = [
    { id: 'new-host', label: t('webssh.folder.new_host'), icon: <Plus size={13} aria-hidden="true" />, onSelect: () => onNewHost(node.folder.id) },
    { id: 'new-subfolder', label: t('webssh.sidebar.new_subfolder'), icon: <FolderPlus size={13} aria-hidden="true" />, onSelect: () => onNewSubfolder(node.folder.id) },
    { id: 'rename', label: t('webssh.actions.rename'), icon: <Pencil size={13} aria-hidden="true" />, combo: 'F2', onSelect: () => onRename(node.folder) },
    {
      id: 'color',
      label: t('webssh.folder.color'),
      icon: <Palette size={13} aria-hidden="true" />,
      separatorBefore: true,
      submenu: ({ closeMenu }) => (
        <FolderColorMenu color={node.folder.color || null} onSelectColor={(color) => {
          onColor(node.folder, color)
          closeMenu()
        }} />
      ),
    },
    {
      id: 'move',
      label: t('webssh.folder.move_to'),
      icon: <FolderInput size={13} aria-hidden="true" />,
      separatorBefore: true,
      submenu: ({ closeMenu }) => (
        <MenuSubmenuList
          label={t('webssh.folder.move_to')}
          items={[
            { id: 'move-root', label: t('webssh.folder.move_top'), onSelect: () => { closeMenu(); void moveInto('') } },
            ...moveTargets.map((folder) => ({
              id: `move-${folder.id}`,
              label: folder.name,
              onSelect: () => { closeMenu(); void moveInto(folder.id) },
            })),
          ]}
        />
      ),
    },
    { id: 'delete', label: t('webssh.actions.delete'), icon: <Trash2 size={13} aria-hidden="true" />, tone: 'danger', separatorBefore: true, onSelect: () => onDelete(node.folder) },
  ]

  return (
    <div>
      <div
        data-webssh-folder-id={node.folder.id}
        className={cn(
          'group relative flex h-10 items-center gap-1 rounded-[var(--r-md)] pr-1 md:h-[28px]',
          activeId === node.folder.id ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
          over && 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]',
        )}
        style={{ paddingLeft: depth * 14 + 4 }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(WEBSSH_HOST_DRAG)) return
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
          setOver(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOver(false)
          const hostId = event.dataTransfer.getData(WEBSSH_HOST_DRAG)
          if (hostId) onDropHost(hostId, node.folder.id)
        }}
      >
        <button
          type="button"
          aria-label={isOpen ? t('webssh.sidebar.collapse') : t('webssh.sidebar.expand')}
          aria-expanded={hasChildren ? isOpen : undefined}
          disabled={!hasChildren}
          onClick={(event) => {
            event.stopPropagation()
            onToggle(node.folder.id)
          }}
          className={cn('flex size-6 shrink-0 items-center justify-center text-[var(--text-quaternary)] md:size-4', isOpen && 'rotate-90', !hasChildren && 'invisible')}
        >
          <ChevronRight size={11} aria-hidden="true" />
        </button>
        {node.folder.icon
          ? <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center text-[length:var(--text-13)] leading-none" style={{ color: node.folder.color || undefined }}>{node.folder.icon}</span>
          : <FolderClosed size={13} aria-hidden="true" style={{ color: node.folder.color || 'var(--text-tertiary)' }} />}
        <button
          type="button"
          onClick={() => onChoose(node.folder.id)}
          onDoubleClick={() => onRename(node.folder)}
          onContextMenu={(event) => {
            event.preventDefault()
            menu.onContextMenu(event)
          }}
          onKeyDown={(event) => {
            if (event.key === 'F2') {
              event.preventDefault()
              onRename(node.folder)
            }
            if (event.key === 'Delete') {
              event.preventDefault()
              onDelete(node.folder)
            }
          }}
          className="min-w-0 flex-1 truncate py-1 text-left text-[length:var(--text-12)] font-medium"
        >
          {node.folder.name}
        </button>
        {node.folder.hostCount > 0 && (
          <span className="tabular shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{node.folder.hostCount}</span>
        )}
        <IconButton
          label={t('webssh.list.more_actions')}
          size="xs"
          onClick={(event) => {
            event.stopPropagation()
            menu.close()
            menu.onContextMenu(event)
          }}
          className="opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
        >
          <MoreHorizontal size={12} aria-hidden="true" />
        </IconButton>
      </div>
      {isOpen && node.children.map((child) => (
        <FolderNode
          key={child.folder.id}
          node={child}
          depth={depth + 1}
          allFolders={allFolders}
          expanded={expanded}
          activeId={activeId}
          onToggle={onToggle}
          onChoose={onChoose}
          onNewSubfolder={onNewSubfolder}
          onNewHost={onNewHost}
          onRename={onRename}
          onColor={onColor}
          onDelete={onDelete}
          onDropHost={onDropHost}
          onChanged={onChanged}
        />
      ))}
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} />}
    </div>
  )
}

function FolderNameDialog({ state, saving, error, onChange, onClose, onSubmit }: {
  state: FolderDialogState | null
  saving: boolean
  error: string | null
  onChange: (state: FolderDialogState | null) => void
  onClose: () => void
  onSubmit: () => void
}) {
  return (
    <Modal
      open={state !== null}
      onClose={onClose}
      title={state?.mode === 'create' ? t('webssh.folder.new_title') : t('webssh.folder.rename_title')}
      width={420}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('webssh.actions.cancel')}</Button>
          <Button variant="primary" loading={saving} disabled={!state?.name.trim()} onClick={onSubmit}>
            {t('webssh.actions.save')}
          </Button>
        </>
      )}
    >
      {state && (
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('webssh.folder.name')}</span>
            <Input
              autoFocus
              value={state.name}
              onChange={(event) => onChange({ ...state, name: event.target.value })}
              onKeyDown={(event) => commitOnEnter(event, onSubmit)}
              placeholder={t('webssh.folder.name_placeholder')}
            />
          </label>
          <div className="flex items-center gap-2">
            <ColorWellField
              value={state.color || null}
              label={t('webssh.folder.color')}
              onChange={(color) => onChange({ ...state, color })}
            />
            <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.folder.color_hint')}</span>
          </div>
          {error && <p className="text-[length:var(--text-11-5)] text-[var(--danger)]">{error}</p>}
        </div>
      )}
    </Modal>
  )
}
