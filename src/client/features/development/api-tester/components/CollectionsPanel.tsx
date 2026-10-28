import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderPlus, Globe, Plus, Radio, Search, Settings2, Tag as TagIcon, Webhook, X } from 'lucide-react'
import type { CollectionNode, RequestKind, TagNode } from '@shared/development/api-tester/types'
import { newApiTesterId } from '@shared/development/api-tester/ids'
import { defaultRequest, defaultWs } from '@shared/development/api-tester/state'
import type { MenuItem } from '../../../../components/overlay'
import { Menu } from '../../../../components/overlay'
import { IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { useApiTesterStore } from '../store'
import { childrenOf, collectionMatches, filterByTag, tagCounts } from '../lib/tree'
import { CollectionRow, type CollectionDragState, type CollectionFolderOption } from './CollectionRow'
import { TagTree } from './TagTree'
import { TagManagerDialog } from './TagManagerDialog'

function tagPath(tags: readonly TagNode[], id: string): string {
  const byId = new Map(tags.map((tag) => [tag.id, tag]))
  const parts: string[] = []
  let current = byId.get(id)
  while (current) {
    parts.unshift(current.name)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return parts.join(' / ')
}

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <Input
      type="search"
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      leading={<Search size={12} aria-hidden="true" />}
      trailing={
        value ? (
          <IconButton size="xs" label={t('development.apitester.clear')} onClick={() => onChange('')}>
            <X size={11} />
          </IconButton>
        ) : undefined
      }
      onChange={(event) => onChange(event.target.value)}
      className="h-7 text-[length:var(--text-11-5)]"
    />
  )
}

export function CollectionsPanel({
  compact,
  onOpenTagManager,
  onRunCollection,
  onRequestClose,
}: {
  compact: boolean
  onOpenTagManager: () => void
  onRunCollection: (folder: CollectionNode) => void
  onRequestClose?: () => void
}) {
  const nodes = useApiTesterStore((s) => s.state.nodes)
  const tags = useApiTesterStore((s) => s.state.tags)
  const activeId = useApiTesterStore((s) => s.activeId)
  const openTab = useApiTesterStore((s) => s.openTab)
  const updateNode = useApiTesterStore((s) => s.updateNode)
  const addNode = useApiTesterStore((s) => s.addNode)
  const deleteNode = useApiTesterStore((s) => s.deleteNode)
  const duplicateNode = useApiTesterStore((s) => s.duplicateNode)
  const moveNode = useApiTesterStore((s) => s.moveNode)
  const reorderNodes = useApiTesterStore((s) => s.reorderNodes)
  const addTag = useApiTesterStore((s) => s.addTag)
  const updateTag = useApiTesterStore((s) => s.updateTag)
  const deleteTag = useApiTesterStore((s) => s.deleteTag)

  const [search, setSearch] = useState('')
  const [tagSearch, setTagSearch] = useState('')
  const [activeTagId, setActiveTagId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const addRef = useRef<HTMLButtonElement>(null)
  const dragState = useRef<CollectionDragState>({ sourceId: null, overId: null, position: 'after' })

  const matchedIds = useMemo(
    () => (search.trim() ? collectionMatches(nodes, search) : null),
    [nodes, search],
  )
  const tagFilter = useMemo(
    () => (activeTagId ? filterByTag(nodes, activeTagId) : null),
    [nodes, activeTagId],
  )
  const visibleNodes = useMemo(() => {
    let list: readonly CollectionNode[] = nodes
    if (tagFilter) list = tagFilter.visibleNodes
    if (matchedIds) list = list.filter((node) => matchedIds.has(node.id))
    return list
  }, [nodes, matchedIds, tagFilter])
  const roots = useMemo(() => childrenOf(visibleNodes, null), [visibleNodes])

  const autoExpandIds = useMemo(() => {
    const ids = new Set<string>()
    if (matchedIds) for (const id of matchedIds) ids.add(id)
    if (tagFilter) for (const id of tagFilter.autoExpandIds) ids.add(id)
    return ids
  }, [matchedIds, tagFilter])

  useEffect(() => {
    if (autoExpandIds.size === 0) return
    setExpanded((previous) => {
      let changed = false
      const next = new Set(previous)
      for (const id of autoExpandIds) {
        if (!next.has(id)) {
          next.add(id)
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [autoExpandIds])

  useEffect(() => {
    if (activeTagId && !tags.some((tag) => tag.id === activeTagId)) setActiveTagId(null)
  }, [activeTagId, tags])

  const counts = useMemo(() => tagCounts(tags, nodes), [tags, nodes])
  const folderOptions = useMemo(() => {
    const options: CollectionFolderOption[] = []
    const walk = (parentId: string | null, prefix: string) => {
      for (const node of childrenOf(nodes, parentId)) {
        if (node.type !== 'folder') continue
        const label = prefix ? `${prefix} / ${node.name}` : node.name
        options.push({ id: node.id, label })
        walk(node.id, label)
      }
    }
    walk(null, '')
    return options
  }, [nodes])

  const filtering = Boolean(search.trim() || activeTagId)
  const activeTag = activeTagId ? tags.find((tag) => tag.id === activeTagId) : undefined

  const toggle = (id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectRequest = (id: string) => {
    openTab(id)
    if (compact) onRequestClose?.()
  }

  const add = (kind: RequestKind | 'folder', parentId: string | null) => {
    const order = childrenOf(nodes, parentId).reduce((max, node) => Math.max(max, node.order), 0) + 1
    const id = newApiTesterId()
    const base = {
      id,
      name: t(
        kind === 'folder'
          ? 'development.apitester.new_folder_name'
          : kind === 'graphql'
            ? 'development.apitester.new_graphql_name'
            : kind === 'websocket'
              ? 'development.apitester.new_websocket_name'
              : 'development.apitester.new_request_name',
      ),
      parentId,
      order,
      tags: [],
      updatedAt: Date.now(),
    }
    if (kind === 'folder') {
      addNode({ ...base, type: 'folder' })
    } else if (kind === 'websocket') {
      addNode({ ...base, type: 'request', kind, ws: defaultWs() })
    } else {
      addNode({ ...base, type: 'request', kind, request: defaultRequest() })
    }
    setSearch('')
    setActiveTagId(null)
    if (parentId) setExpanded((previous) => new Set(previous).add(parentId))
    setRenameTarget(id)
  }

  const removeNode = (id: string) => {
    if (renameTarget === id) setRenameTarget(null)
    deleteNode(id)
  }

  const duplicate = (id: string) => duplicateNode(id, t('development.apitester.copy_suffix'))

  const move = (id: string, parentId: string | null) => {
    moveNode(id, parentId)
    if (parentId) setExpanded((previous) => new Set(previous).add(parentId))
  }

  const openTagManager = () => {
    setTagManagerOpen(true)
    onOpenTagManager()
  }

  const addMenuItems: MenuItem[] = [
    { id: 'new-rest', label: t('development.apitester.new_rest'), icon: <Globe size={14} />, onSelect: () => add('rest', null) },
    { id: 'new-graphql', label: t('development.apitester.new_graphql'), icon: <Webhook size={14} />, onSelect: () => add('graphql', null) },
    { id: 'new-websocket', label: t('development.apitester.new_websocket'), icon: <Radio size={14} />, onSelect: () => add('websocket', null) },
    { id: 'new-folder', label: t('development.apitester.new_folder'), icon: <FolderPlus size={14} />, separatorBefore: true, onSelect: () => add('folder', null) },
  ]

  const emptyText = activeTagId
    ? t('development.apitester.no_requests_in_tag')
    : search.trim()
      ? t('development.apitester.no_match')
      : t('development.apitester.no_requests')

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t('development.apitester.collections')} data-testid="collections-panel">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2 py-1.5">
        <TagIcon size={12} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
          {t('development.apitester.tags')}
        </span>
        {activeTagId && (
          <IconButton size="xs" label={t('development.apitester.clear')} onClick={() => setActiveTagId(null)}>
            <X size={11} />
          </IconButton>
        )}
        <IconButton size="xs" label={t('development.apitester.manage_tags')} onClick={openTagManager}>
          <Settings2 size={12} />
        </IconButton>
      </div>
      <div className="shrink-0 px-2 py-1">
        <SearchField value={tagSearch} onChange={setTagSearch} placeholder={t('development.apitester.search_tags')} />
      </div>
      <div className="max-h-[38%] min-h-[56px] shrink-0 overflow-y-auto overscroll-contain px-1 pb-1">
        <TagTree
          tags={tags}
          counts={counts}
          activeTagId={activeTagId}
          searchKeyword={tagSearch}
          onSelect={(id) => setActiveTagId((current) => (current === id ? null : id))}
        />
      </div>

      <div className="flex shrink-0 items-center gap-1 border-y border-[var(--border-subtle)] px-2 py-1.5">
        <Globe size={12} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
          {t('development.apitester.collections')}
        </span>
        <IconButton
          ref={addRef}
          size="xs"
          label={t('development.apitester.new_request')}
          aria-haspopup="menu"
          aria-expanded={addOpen}
          onClick={() => setAddOpen((open) => !open)}
        >
          <Plus size={13} />
        </IconButton>
        <Menu
          anchor={addRef}
          open={addOpen}
          onClose={() => setAddOpen(false)}
          items={addMenuItems}
          align="end"
          width={190}
          label={t('development.apitester.new_request')}
        />
      </div>
      <div className="shrink-0 px-2 py-1">
        <SearchField value={search} onChange={setSearch} placeholder={t('development.apitester.search_requests')} />
        {activeTag && (
          <div className="flex items-center gap-1 pt-1 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
            <TagIcon size={10} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{tagPath(tags, activeTag.id)}</span>
            <IconButton size="xs" label={t('development.apitester.clear')} onClick={() => setActiveTagId(null)}>
              <X size={10} />
            </IconButton>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
        {roots.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            <Globe size={26} className="opacity-30" aria-hidden="true" />
            <p>{emptyText}</p>
            <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('development.apitester.click_plus_to_create')}</p>
          </div>
        ) : (
          roots.map((node) => (
            <CollectionRow
              key={node.id}
              node={node}
              depth={0}
              nodes={visibleNodes}
              allNodes={nodes}
              folderOptions={folderOptions}
              activeId={activeId}
              expanded={expanded}
              compact={compact}
              filtering={filtering}
              renameTarget={renameTarget}
              dragState={dragState}
              onSelect={selectRequest}
              onToggle={toggle}
              onRename={(id, name) => updateNode(id, { name })}
              onRenameDone={(id) => setRenameTarget((current) => (current === id ? null : current))}
              onAdd={add}
              onDelete={removeNode}
              onDuplicate={duplicate}
              onMove={move}
              onReorder={(parentId, orderedIds) => reorderNodes(parentId, orderedIds)}
              onRunCollection={onRunCollection}
            />
          ))
        )}
      </div>

      <TagManagerDialog
        open={tagManagerOpen}
        onClose={() => setTagManagerOpen(false)}
        tags={tags}
        onAdd={addTag}
        onUpdate={updateTag}
        onDelete={deleteTag}
      />
    </section>
  )
}
