import { useState, type ReactNode } from 'react'
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  FolderClosed,
  Globe,
  Hash,
  Hourglass,
  Infinity as InfinityIcon,
  KeyRound,
  LayoutDashboard,
  Library,
  Pause,
  Pin,
  Play,
  Plus,
  Star,
  Tag as TagIcon,
  TriangleAlert,
} from 'lucide-react'
import type { ShareCategory, ShareFolder, ShareGlobalStats, ShareTag } from '@shared/share-hub'
import { Button, IconButton } from '../../../components/primitives'
import { Tooltip, confirm, prompt } from '../../../components/overlay'
import { cn } from '../../../lib/cn'
import { t, type MessageKey } from '../../../lib/i18n'
import { shareHubApi } from '../../../lib/api-share-hub'
import { RowMenu } from './row-menu'

/**
 * The hub's left rail: the twelve views, the two organizers a published link can be filed under, and
 * the all-time totals the owner reads the whole panel against.
 *
 * The counts come from `/api/share/stats`, which builds every one of them with `shareStatusSql` — the
 * same generator the list's own SQL uses. A count computed here from the rows we already hold would
 * agree only while the list is unpaginated, and a rail whose number disagrees with the screen it
 * opens is the defect this component exists to avoid rather than to reintroduce.
 */

interface CategoryRow {
  id: ShareCategory
  label: MessageKey
  icon: ReactNode
  /** Which field of the server's summary carries this row's count; `undefined` draws no badge. */
  count: (stats: ShareGlobalStats) => number
}

const CATEGORY_ROWS: readonly CategoryRow[] = [
  { id: 'dashboard', label: 'share.dashboard_title', icon: <LayoutDashboard size={13}/>, count: () => 0 },
  { id: 'collections', label: 'share.collections_title', icon: <Library size={13}/>, count: () => 0 },
  { id: 'all', label: 'share.cat_all', icon: <Globe size={13}/>, count: (s) => s.totalShares },
  { id: 'active', label: 'share.cat_active', icon: <Play size={13}/>, count: (s) => s.activeShares },
  { id: 'pinned', label: 'share.cat_pinned', icon: <Pin size={13}/>, count: (s) => s.pinnedShares },
  { id: 'starred', label: 'share.cat_starred', icon: <Star size={13}/>, count: (s) => s.starredShares },
  { id: 'paused', label: 'share.cat_paused', icon: <Pause size={13}/>, count: (s) => s.pausedShares },
  { id: 'password', label: 'share.cat_password', icon: <KeyRound size={13}/>, count: (s) => s.passwordShares },
  { id: 'expiring_soon', label: 'share.cat_expiring_soon', icon: <Hourglass size={13}/>, count: (s) => s.expiringSoonShares },
  { id: 'expiring', label: 'share.cat_expiring', icon: <CalendarClock size={13}/>, count: (s) => s.expiringShares },
  { id: 'permanent', label: 'share.cat_permanent', icon: <InfinityIcon size={13}/>, count: (s) => s.permanentShares },
  { id: 'expired', label: 'share.cat_expired', icon: <TriangleAlert size={13}/>, count: (s) => s.expiredShares },
]

/** Categories whose row is a count the owner acts on; the two views of their own draw no badge. */
const COUNTLESS: ReadonlySet<ShareCategory> = new Set(['dashboard', 'collections'])

export function HubSidebar(props: {
  category: ShareCategory
  folderId: string | null
  tagName: string | null
  stats: ShareGlobalStats | null
  folders: ShareFolder[]
  tags: ShareTag[]
  onCategory: (category: ShareCategory) => void
  onFolder: (folderId: string | null) => void
  onTag: (tagName: string | null) => void
  /** Called after a folder or tag record changes, so the rail and its counts move together. */
  onOrganizersChanged: () => void
  onNavigate?: () => void
}) {
  const [foldersOpen, setFoldersOpen] = useState(true)
  const [tagsOpen, setTagsOpen] = useState(true)

  const createFolder = async (parentId: string | null) => {
    const name = await prompt({
      title: parentId ? t('share.folder_new_child') : t('share.folder_new_root'),
      placeholder: t('share.folder_name_placeholder'),
    })
    if (!name) return
    try {
      await shareHubApi.folders.create({ name, parentId })
      props.onOrganizersChanged()
    } catch {
      // The rail has no room for an inline error and the tree simply not changing is the signal;
      // the organizer screen that owns folder management reports the reason.
    }
  }

  const renameFolder = async (folder: ShareFolder) => {
    const name = await prompt({
      title: t('share.folder_rename'),
      placeholder: t('share.folder_name_placeholder'),
      defaultValue: folder.name,
    })
    if (!name || name === folder.name) return
    try {
      await shareHubApi.folders.patch(folder.id, { name })
      props.onOrganizersChanged()
    } catch {
      // See `createFolder`.
    }
  }

  const removeFolder = async (folder: ShareFolder) => {
    const yes = await confirm({
      title: t('share.folder_delete_title', { name: folder.name }),
      description: t('share.folder_delete_desc'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!yes) return
    try {
      await shareHubApi.folders.remove(folder.id)
      if (props.folderId === folder.id) props.onFolder(null)
      props.onOrganizersChanged()
    } catch {
      // See `createFolder`.
    }
  }

  const createTag = async () => {
    const name = await prompt({
      title: t('share.tag_new'),
      placeholder: t('share.tag_name_placeholder'),
    })
    if (!name) return
    try {
      await shareHubApi.tags.create({ name })
      props.onOrganizersChanged()
    } catch {
      // See `createFolder`.
    }
  }

  const removeTag = async (tag: ShareTag) => {
    const yes = await confirm({
      title: t('share.tag_delete_title', { name: tag.name }),
      description: t('share.tag_delete_desc'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!yes) return
    try {
      await shareHubApi.tags.remove(tag.id)
      if (props.tagName === tag.name) props.onTag(null)
      props.onOrganizersChanged()
    } catch {
      // See `createFolder`.
    }
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <nav aria-label={t('share.hub_views')}>
          <ul className="space-y-0.5">
            {CATEGORY_ROWS.map((row) => {
              const selected = props.category === row.id && !props.folderId && !props.tagName
              const count = props.stats && !COUNTLESS.has(row.id) ? row.count(props.stats) : null
              return (
                <li key={row.id}>
                  <Button
                    variant="ghost"
                    block
                    icon={row.icon}
                    aria-current={selected ? 'page' : undefined}
                    onClick={() => { props.onCategory(row.id); props.onNavigate?.() }}
                    trailing={count ? <CountBadge value={count} selected={selected}/> : undefined}
                    className={cn(
                      'h-8 justify-start gap-2 px-2.5 text-[length:var(--text-12)]',
                      selected && 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]',
                    )}
                  >
                    {t(row.label)}
                  </Button>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="my-3 h-px bg-[var(--border-subtle)]"/>

        <RailSection
          open={foldersOpen}
          onToggle={() => setFoldersOpen(!foldersOpen)}
          title={t('share.folders_heading')}
          addLabel={t('share.folder_new_root')}
          onAdd={() => void createFolder(null)}
        >
          {foldersOpen && (
            <FolderTree
              folders={props.folders}
              stats={props.stats}
              selectedId={props.folderId}
              onSelect={(id) => { props.onFolder(id); props.onNavigate?.() }}
              onRename={renameFolder}
              onDelete={removeFolder}
              onAddChild={(parent) => void createFolder(parent.id)}
            />
          )}
        </RailSection>

        <div className="my-3 h-px bg-[var(--border-subtle)]"/>

        <RailSection
          open={tagsOpen}
          onToggle={() => setTagsOpen(!tagsOpen)}
          title={t('share.tags_heading')}
          addLabel={t('share.tag_new')}
          onAdd={() => void createTag()}
        >
          {tagsOpen && (
            <ul className="space-y-0.5">
              {props.tags.length === 0
                ? <EmptyRow icon={<TagIcon size={13}/>} label={t('share.no_tags')}/>
                : props.tags.map((tag) => (
                  <li key={tag.id}>
                    <Button
                      variant="ghost"
                      block
                      icon={<Hash size={12}/>}
                      aria-current={props.tagName === tag.name ? 'true' : undefined}
                      onClick={() => { props.onTag(tag.name); props.onNavigate?.() }}
                      trailing={
                        <CountBadge
                          value={props.stats?.tagCounts[tag.name]?.shared ?? 0}
                          selected={props.tagName === tag.name}
                        />
                      }
                      onContextMenu={(event) => { event.preventDefault(); void removeTag(tag) }}
                      className={cn(
                        'h-7 justify-start gap-2 px-2.5 text-[length:var(--text-11-5)]',
                        props.tagName === tag.name && 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]',
                      )}
                    >
                      {tag.name}
                    </Button>
                  </li>
                ))}
            </ul>
          )}
        </RailSection>
      </div>

      <FooterStats stats={props.stats}/>
    </aside>
  )
}

/**
 * The count on a rail row.
 *
 * A zero draws nothing rather than a grey `0`: twelve badges of which ten read zero is how a rail
 * starts to look like decoration, and the row the owner can act on is the one worth marking.
 */
function CountBadge({ value, selected }: { value: number; selected: boolean }) {
  if (!value) return null
  return (
    <span
      className={cn(
        'ml-auto rounded-[var(--r-sm)] px-1.5 py-0.5 text-[length:var(--text-10)] font-medium',
        selected ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]',
      )}
    >
      {value}
    </span>
  )
}

function EmptyRow({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <li className="flex items-center gap-2 px-2.5 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
      {icon}{label}
    </li>
  )
}

function RailSection(props: {
  open: boolean
  onToggle: () => void
  title: string
  addLabel: string
  onAdd: () => void
  children: ReactNode
}) {
  return (
    <section>
      <div className="group/head mb-1 flex items-center justify-between px-2">
        <Button
          variant="ghost"
          size="sm"
          icon={props.open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
          aria-expanded={props.open}
          onClick={props.onToggle}
          className="h-auto gap-1 px-0 text-[length:var(--text-11)] font-semibold text-[var(--text-quaternary)]"
        >
          {props.title}
        </Button>
        <Tooltip label={props.addLabel} side="left">
          {/* The only way to make an organizer from here, so it may not wait for a pointer: it is
              always drawn below `md`, and on the wide layout hover and keyboard both reveal it. */}
          <IconButton
            label={props.addLabel}
            size="sm"
            onClick={props.onAdd}
            className="opacity-100 md:opacity-0 md:group-hover/head:opacity-100 md:focus-visible:opacity-100"
          >
            <Plus size={13}/>
          </IconButton>
        </Tooltip>
      </div>
      {props.children}
    </section>
  )
}

/**
 * The folder tree, walked from the flat rows the server answers with.
 *
 * Depth is the server's rule, not this component's: `shareOrganizerRoutes` refuses a `parentId` that
 * would take the tree past `LIMITS.folderDepthMax`, so a drag the rail could offer is a write the
 * panel would then be told no about. The rail therefore only offers a child of a row it can show.
 */
function FolderTree(props: {
  folders: ShareFolder[]
  stats: ShareGlobalStats | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  onRename: (folder: ShareFolder) => void
  onDelete: (folder: ShareFolder) => void
  onAddChild: (parent: ShareFolder) => void
}) {
  const roots = props.folders.filter((folder) => !folder.parentId)
  if (!props.folders.length) {
    return <ul><EmptyRow icon={<FolderClosed size={13}/>} label={t('share.no_folders')}/></ul>
  }
  return (
    <ul className="space-y-0.5">
      {roots.map((root) => (
        <FolderBranch key={root.id} {...props} folder={root} depth={0}/>
      ))}
    </ul>
  )
}

function FolderBranch(props: {
  folders: ShareFolder[]
  stats: ShareGlobalStats | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  onRename: (folder: ShareFolder) => void
  onDelete: (folder: ShareFolder) => void
  onAddChild: (parent: ShareFolder) => void
  folder: ShareFolder
  depth: number
}) {
  const [open, setOpen] = useState(true)
  const children = props.folders.filter((folder) => folder.parentId === props.folder.id)
  const selected = props.selectedId === props.folder.id
  const shared = props.stats?.folderCounts[props.folder.id]?.shared ?? 0

  return (
    <li>
      <div
        className="flex items-center gap-0.5"
        style={{ paddingLeft: `calc(var(--sp-2) * ${props.depth})` }}
      >
        {children.length > 0 ? (
          <IconButton
            label={open ? t('share.folder_collapse') : t('share.folder_expand')}
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="shrink-0"
          >
            {open ? <ChevronDown size={11}/> : <ChevronRight size={11}/>}
          </IconButton>
        ) : (
          <span aria-hidden className="w-6 shrink-0"/>
        )}
        <Button
          variant="ghost"
          block
          icon={<FolderClosed size={12}/>}
          aria-current={selected ? 'true' : undefined}
          onClick={() => props.onSelect(props.folder.id)}
          trailing={<CountBadge value={shared} selected={selected}/>}
          className={cn(
            'h-7 min-w-0 justify-start gap-2 px-1.5 text-[length:var(--text-11-5)]',
            selected && 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]',
          )}
        >
          <span className="truncate">{props.folder.name}</span>
        </Button>
        <FolderRowMenu
          folder={props.folder}
          onRename={props.onRename}
          onDelete={props.onDelete}
          onAddChild={props.onAddChild}
        />
      </div>
      {open && children.length > 0 && (
        <ul className="space-y-0.5">
          {children.map((child) => (
            <FolderBranch key={child.id} {...props} folder={child} depth={props.depth + 1}/>
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * The per-folder actions live behind a real menu button rather than a right-click: a context menu is
 * the only affordance a touch and a keyboard user do not have, and creating, renaming and deleting a
 * folder is not something to make reachable by one input method only.
 */
function FolderRowMenu(props: {
  folder: ShareFolder
  onRename: (folder: ShareFolder) => void
  onDelete: (folder: ShareFolder) => void
  onAddChild: (parent: ShareFolder) => void
}) {
  return (
    <RowMenu
      label={t('share.folder_row_menu_label', { name: props.folder.name })}
      items={[
        { id: 'add', label: t('share.folder_new_child'), onSelect: () => props.onAddChild(props.folder) },
        { id: 'rename', label: t('share.folder_rename'), onSelect: () => props.onRename(props.folder) },
        { id: 'delete', label: t('common.delete'), tone: 'danger', onSelect: () => props.onDelete(props.folder) },
      ]}
    />
  )
}

/**
 * The three all-time numbers under the rail.
 *
 * These are deliberately the account's whole history rather than the selected range: the range
 * control belongs to the dashboard beside them, and a footer that quietly followed it would put two
 * figures with the same name on screen with two different meanings.
 */
function FooterStats({ stats }: { stats: ShareGlobalStats | null }) {
  const rows: Array<[MessageKey, number]> = [
    ['share.footer_total_shares', stats?.totalShares ?? 0],
    ['share.footer_total_views', stats?.totalViews ?? 0],
    ['share.footer_total_visitors', stats?.totalVisitors ?? 0],
  ]
  return (
    <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2.5">
      {rows.map(([key, value]) => (
        <div key={key} className="flex items-center justify-between py-0.5 text-[length:var(--text-11)]">
          <span className="text-[var(--text-tertiary)]">{t(key)}</span>
          <span className="font-semibold text-[var(--text-primary)]">{value}</span>
        </div>
      ))}
    </div>
  )
}
