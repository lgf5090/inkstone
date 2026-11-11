import { memo, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Clock, Compass, Download, FileText, Layers, Pin, Plus, Settings2, Star, Tag as TagIcon, X } from 'lucide-react'
import type { GithubCollection, GithubTag, GithubViewId, SavedGithubRepo } from '@shared/development/github/types'
import { GITHUB_ALL_VIEW, GITHUB_COLLECTION_VIEW_PREFIX, GITHUB_EXPLORE_VIEW, GITHUB_FAV_VIEW, GITHUB_PINNED_VIEW } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { isImeComposing } from '../../../../lib/ime'
import { Button, IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { Modal, Menu, confirm, type MenuItem } from '../../../../components/overlay'
import { SelectMenu } from '../../../../components/select-menu'
import { useUi } from '../../../../store/ui'
import { SidebarItem, SectionLabel, TagTreeList } from './TagSidebarParts'
import type { RecentRepoRef } from '../prefs'

type TreeKind = 'tag' | 'collection'
interface ContextTarget {
  kind: TreeKind
  id: string
  anchor: HTMLElement
}
interface TreeDialog {
  mode: 'rename' | 'move' | 'child'
  kind: TreeKind
  id?: string
  name: string
}

function descendants(kind: TreeKind, id: string, tags: GithubTag[], collections: GithubCollection[]): string[] {
  const source: { id: string; parentId: string | null }[] = kind === 'tag' ? tags : collections
  const found = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const entry of source) {
      if (entry.parentId && (entry.parentId === id || found.has(entry.parentId)) && !found.has(entry.id) && entry.id !== id) {
        found.add(entry.id)
        grew = true
      }
    }
  }
  return [...found]
}

function flattenParents(kind: TreeKind, tags: GithubTag[], collections: GithubCollection[], excludeId?: string) {
  const excluded = new Set<string>(excludeId ? [excludeId, ...descendants(kind, excludeId, tags, collections)] : [])
  const source: { id: string; name: string; parentId: string | null }[] = kind === 'tag' ? tags : collections
  const byParent = new Map<string | null, typeof source>()
  for (const entry of source) {
    if (excluded.has(entry.id)) continue
    byParent.set(entry.parentId, [...(byParent.get(entry.parentId) ?? []), entry])
  }
  const rows: { value: string; label: string }[] = [{ value: 'ROOT', label: t('development.github.collections.top_level') }]
  const walk = (parent: string | null, depth: number) => {
    for (const entry of byParent.get(parent) ?? []) {
      rows.push({ value: entry.id, label: `${'— '.repeat(depth)}${entry.name}` })
      walk(entry.id, depth + 1)
    }
  }
  walk(null, 0)
  return rows
}

export const RepoSidebar = memo(function RepoSidebar({
  tags,
  collections,
  savedRepos,
  selectedView,
  onSelect,
  expanded,
  onToggleExpand,
  onManageTags,
  onManageCollections,
  onImportRepo,
  onAddTag,
  onUpdateTag,
  onDeleteTags,
  onSaveCollection,
  onDeleteCollection,
  recentRepos,
  onOpenRecent,
  onClearRecent,
}: {
  tags: GithubTag[]
  collections: GithubCollection[]
  savedRepos: SavedGithubRepo[]
  selectedView: GithubViewId
  onSelect: (view: GithubViewId) => void
  expanded: Set<string>
  onToggleExpand: (id: string) => void
  onManageTags: () => void
  onManageCollections: () => void
  onImportRepo: () => void
  onAddTag: (name: string, color: string, parentId: string | null) => void
  onUpdateTag: (id: string, patch: { name: string; color: string; parentId: string | null }) => void
  onDeleteTags: (ids: string[]) => void
  onSaveCollection: (collection: GithubCollection) => void
  onDeleteCollection: (id: string) => void
  recentRepos: RecentRepoRef[]
  onOpenRecent: (fullName: string) => void
  onClearRecent: () => void
}) {
  const toast = useUi((state) => state.toast)
  const pinned = useMemo(() => savedRepos.filter((repo) => repo.pinned).length, [savedRepos])
  const favorite = useMemo(() => savedRepos.filter((repo) => repo.favorited).length, [savedRepos])
  const [context, setContext] = useState<ContextTarget | null>(null)
  const [dialog, setDialog] = useState<TreeDialog | null>(null)
  const [draft, setDraft] = useState('')
  const [moveTo, setMoveTo] = useState('ROOT')
  const anchorRef = useRef<HTMLElement | null>(null)

  const openContext = (kind: TreeKind, id: string, event: React.MouseEvent) => {
    event.preventDefault()
    anchorRef.current = event.currentTarget as HTMLElement
    setContext({ kind, id, anchor: event.currentTarget as HTMLElement })
  }

  const targetTag = context?.kind === 'tag' ? tags.find((tag) => tag.id === context.id) : undefined
  const targetCollection = context?.kind === 'collection' ? collections.find((collection) => collection.id === context.id) : undefined
  const targetName = targetTag?.name ?? targetCollection?.name ?? ''

  const copy = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast({ title: message, tone: 'success' })
    } catch {
      toast({ title: t('development.github.common.copy_failed'), tone: 'danger' })
    }
  }

  const openDialog = (mode: TreeDialog['mode']) => {
    if (!context) return
    setDraft(mode === 'rename' ? targetName : '')
    setMoveTo('ROOT')
    setDialog({ mode, kind: context.kind, id: context.id, name: targetName })
  }

  const contextItems: MenuItem[] = context ? [
    {
      id: 'open',
      label: t('development.github.sidebar.open'),
      onSelect: () => onSelect(context.kind === 'tag' ? `tag:${context.id}` : `${GITHUB_COLLECTION_VIEW_PREFIX}${context.id}`),
    },
    { id: 'rename', label: t('development.github.sidebar.rename'), onSelect: () => openDialog('rename') },
    { id: 'move', label: t('development.github.sidebar.move'), onSelect: () => openDialog('move') },
    { id: 'child', label: t('development.github.sidebar.new_child'), onSelect: () => openDialog('child') },
    { id: 'copy-name', label: t('development.github.sidebar.copy_name'), onSelect: () => void copy(targetName, t('development.github.sidebar.copied')) },
    {
      id: 'copy-link',
      label: t('development.github.sidebar.copy_link'),
      onSelect: () => void copy(`${location.origin}/development/github#${context.kind}-${context.id}`, t('development.github.sidebar.copied')),
    },
    {
      id: 'delete',
      label: t('common.delete'),
      onSelect: () => {
        const childIds = descendants(context.kind, context.id, tags, collections)
        const affected = context.kind === 'tag'
          ? savedRepos.filter((repo) => repo.tagIds.some((id) => id === context.id || childIds.includes(id))).length
          : (targetCollection?.repoIds.length ?? 0) + collections.filter((entry) => childIds.includes(entry.id)).reduce((sum, entry) => sum + entry.repoIds.length, 0)
        void confirm({
          title: t('development.github.sidebar.delete_title', { name: targetName }),
          description: t('development.github.sidebar.delete_desc', { name: targetName, children: childIds.length, repos: affected }),
          confirmLabel: t('common.delete'),
          tone: 'danger',
        }).then((ok) => {
          if (!ok) return
          if (context.kind === 'tag') onDeleteTags([context.id, ...childIds])
          else onDeleteCollection(context.id)
        })
      },
    },
  ] : []

  const saveDialog = () => {
    if (!dialog) return
    if (dialog.mode === 'move') {
      const parentId = moveTo === 'ROOT' ? null : moveTo
      if (dialog.kind === 'tag') {
        const tag = tags.find((entry) => entry.id === dialog.id)
        if (tag) onUpdateTag(tag.id, { name: tag.name, color: tag.color, parentId })
      } else {
        const collection = collections.find((entry) => entry.id === dialog.id)
        if (collection) onSaveCollection({ ...collection, parentId, updatedAt: Date.now() })
      }
    } else {
      const name = draft.trim()
      if (!name) return
      if (dialog.mode === 'rename' && dialog.id) {
        if (dialog.kind === 'tag') {
          const tag = tags.find((entry) => entry.id === dialog.id)
          if (tag) onUpdateTag(tag.id, { name, color: tag.color, parentId: tag.parentId })
        } else {
          const collection = collections.find((entry) => entry.id === dialog.id)
          if (collection) onSaveCollection({ ...collection, name, updatedAt: Date.now() })
        }
      } else if (dialog.mode === 'child') {
        const parentId = dialog.id ?? null
        if (dialog.kind === 'tag') {
          const parent = tags.find((entry) => entry.id === parentId)
          onAddTag(name, parent?.color ?? '#64748b', parentId)
        } else {
          const now = Date.now()
          onSaveCollection({
            id: `gh-collection-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            name,
            description: '',
            parentId,
            repoIds: [],
            createdAt: now,
            updatedAt: now,
          })
        }
      }
    }
    setDialog(null)
  }

  const collectionChildren = useMemo(() => {
    const map = new Map<string | null, GithubCollection[]>()
    for (const collection of collections) {
      const parent = collection.parentId && collections.some((entry) => entry.id === collection.parentId) ? collection.parentId : null
      map.set(parent, [...(map.get(parent) ?? []), collection])
    }
    return map
  }, [collections])

  const repoTotal = (collection: GithubCollection): number => collection.repoIds.length
    + (collectionChildren.get(collection.id) ?? []).reduce((sum, child) => sum + repoTotal(child), 0)

  const renderCollections = (parent: string | null, depth: number) => (collectionChildren.get(parent) ?? []).map((collection) => {
    const key = `col:${collection.id}`
    const children = collectionChildren.get(collection.id) ?? []
    const open = expanded.has(key)
    const subtreeRepos = repoTotal(collection)
    return (
      <div key={collection.id} data-slot="collection-row" data-collection-id={collection.id}>
        <div className="flex items-center gap-1" style={{ paddingLeft: `${depth * 12}px` }}>
          {children.length > 0
            ? <IconButton label={open ? t('development.github.common.collapse') : t('development.github.common.expand')} size="sm" onClick={() => onToggleExpand(key)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</IconButton>
            : <span className="w-6 shrink-0" />}
          <div className="min-w-0 flex-1">
            <SidebarItem
              icon={<Layers size={14} />}
              label={collection.name}
              count={subtreeRepos}
              active={selectedView === `${GITHUB_COLLECTION_VIEW_PREFIX}${collection.id}`}
              onClick={() => onSelect(`${GITHUB_COLLECTION_VIEW_PREFIX}${collection.id}`)}
              onContextMenu={(event) => openContext('collection', collection.id, event)}
            />
          </div>
        </div>
        {open && children.length > 0 && renderCollections(collection.id, depth + 1)}
      </div>
    )
  })

  return (
    <aside className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--bg-sunken)]" data-slot="repo-sidebar">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-1 p-2">
          <SidebarItem icon={<Compass size={14} className="text-[var(--accent)]" />} label={t('development.github.repos.discover')} active={selectedView === GITHUB_EXPLORE_VIEW} onClick={() => onSelect(GITHUB_EXPLORE_VIEW)} />
          <SidebarItem icon={<Download size={14} />} label={t('development.github.repos.import_repo')} active={false} onClick={onImportRepo} />
          {recentRepos.length > 0 && (
            <>
              <div className="my-2 border-t border-[var(--border-subtle)]" />
              <div className="flex items-center gap-1 px-2 pb-1">
                <Clock size={12} className="text-[var(--text-tertiary)]" />
                <SectionLabel>{t('development.github.repos.recent')}</SectionLabel>
                <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5" onClick={onClearRecent} title={t('development.github.repos.clear_recent')} aria-label={t('development.github.repos.clear_recent')}><X size={12} /></Button>
              </div>
              {recentRepos.map((entry) => <SidebarItem key={entry.fullName} icon={<Clock size={12} />} label={entry.fullName} active={false} onClick={() => onOpenRecent(entry.fullName)} />)}
            </>
          )}
          <div className="my-2 border-t border-[var(--border-subtle)]" />
          <SectionLabel>{t('development.github.repos.my_repos')}</SectionLabel>
          <SidebarItem icon={<FileText size={14} />} label={t('development.github.repos.all')} count={savedRepos.length} active={selectedView === GITHUB_ALL_VIEW} onClick={() => onSelect(GITHUB_ALL_VIEW)} />
          <SidebarItem icon={<Pin size={14} className="text-[var(--warning)]" />} label={t('development.github.repos.pinned')} count={pinned} active={selectedView === GITHUB_PINNED_VIEW} onClick={() => onSelect(GITHUB_PINNED_VIEW)} />
          <SidebarItem icon={<Star size={14} className="text-[var(--warning)]" />} label={t('development.github.repos.favorited')} count={favorite} active={selectedView === GITHUB_FAV_VIEW} onClick={() => onSelect(GITHUB_FAV_VIEW)} />
          <div className="my-2 border-t border-[var(--border-subtle)]" />
          <div className="flex items-center gap-1 px-2 pb-1">
            <TagIcon size={12} className="text-[var(--text-tertiary)]" />
            <SectionLabel>{t('development.github.tags.section')}</SectionLabel>
            <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5" onClick={onManageTags} title={t('development.github.tags.manage')} aria-label={t('development.github.tags.manage')}><Settings2 size={12} /></Button>
          </div>
          <TagTreeList tags={tags} items={savedRepos} selectedView={selectedView} onSelect={onSelect} expanded={expanded} onToggleExpand={onToggleExpand} emptyAction={onManageTags} onContextMenu={(tag, event) => openContext('tag', tag.id, event)} />
          <div className="my-2 border-t border-[var(--border-subtle)]" />
          <div className="flex items-center gap-1 px-2 pb-1">
            <Layers size={12} className="text-[var(--text-tertiary)]" />
            <SectionLabel>{t('development.github.collections.section')}</SectionLabel>
            <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5" onClick={onManageCollections} title={t('development.github.collections.manage')} aria-label={t('development.github.collections.manage')}><Settings2 size={12} /></Button>
          </div>
          {collections.length === 0
            ? <SidebarItem icon={<Plus size={12} />} label={t('development.github.collections.create_first')} active={false} onClick={onManageCollections} />
            : renderCollections(null, 0)}
        </div>
      </div>
      <Menu anchor={anchorRef} open={Boolean(context)} onClose={() => setContext(null)} items={contextItems} align="start" width={210} label={t('development.github.sidebar.menu')} />
      <Modal
        open={Boolean(dialog)}
        onClose={() => setDialog(null)}
        title={dialog?.mode === 'move'
          ? t('development.github.sidebar.move_title', { name: dialog.name })
          : dialog?.mode === 'rename'
            ? t('development.github.sidebar.rename_title', { name: dialog.name })
            : t('development.github.sidebar.new_child')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>{t('common.cancel')}</Button>
            <Button onClick={saveDialog} disabled={dialog?.mode !== 'move' && !draft.trim()}>{t('common.save')}</Button>
          </>
        }
      >
        {dialog?.mode === 'move' ? (
          <SelectMenu
            label={t('development.github.sidebar.parent')}
            value={moveTo}
            options={flattenParents(dialog.kind, tags, collections, dialog.id)}
            onChange={setMoveTo}
            searchable
            className="w-full"
          />
        ) : (
          <Input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t('development.github.sidebar.name')} aria-label={t('development.github.sidebar.name')} onKeyDown={(event) => { if (event.key === 'Enter' && !isImeComposing(event)) saveDialog() }} />
        )}
        <p className="mt-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.github.sidebar.dialog_hint')}</p>
      </Modal>
    </aside>
  )
})
