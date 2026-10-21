import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ChevronRight, Hash, List, ListTree } from 'lucide-react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { MemoDisplayPreferences } from '@shared/memos/types'
import { usePathname } from '../../../lib/app-history'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { treeIndent, treeItemProps, useTreeKeyboard } from '../../../lib/tree'
import type { TagTreeNode } from '../../../lib/tag-tree'
import { Button, IconButton, SectionLabel } from '../../../components/primitives'
import { Skeleton } from '../../../components/feedback'
import { Tooltip } from '../../../components/overlay'
import { memosApi } from '../api'
import { useRevision, type MemoDomain } from '../events'
import { parseMemoPath, type MemoRoute } from '../route'
import { loadMemoDisplayPrefs, useRefreshOnFocus } from '../state'
import { useMemoResource } from '../use-resource'
import {
  buildMemoSearch,
  navigateMemoUrl,
  readMemoUrlState,
  useMemoSearch,
  type MemoUrlState,
} from '../url-state'
import {
  ancestorTagPaths,
  buildMemoTagTree,
  flatMemoTagRows,
  loadMemoTagBrowserPrefs,
  saveMemoTagBrowserPrefs,
  type MemoTagBrowserPrefs,
} from './tag-browser'

const TAG_STATS_DOMAINS: readonly MemoDomain[] = ['stats']

function routeSpaceId(route: MemoRoute): string | null {
  return route.kind === 'space' || route.kind === 'calendar' || route.kind === 'attachments' || route.kind === 'map'
    ? route.spaceId
    : null
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch (error) {
    console.warn('[inkstone] Could not read the browser time zone', error)
    return 'UTC'
  }
}

function displayForUrl(urlState: MemoUrlState): MemoDisplayPreferences {
  const base = loadMemoDisplayPrefs()
  return {
    columns: urlState.columns ?? base.columns,
    compact: urlState.compact ?? base.compact,
    linkPreview: urlState.linkPreview ?? base.linkPreview,
    timeBasis: urlState.orderBy ?? base.timeBasis,
    order: urlState.order ?? base.order,
  }
}

export function TagsSection(): ReactElement {
  const pathname = usePathname()
  const search = useMemoSearch()
  const route = useMemo(() => parseMemoPath(pathname), [pathname])
  const urlState = useMemo(() => readMemoUrlState(search), [search])
  const spaceId = routeSpaceId(route)
  const revision = useRevision('stats')
  useRefreshOnFocus(TAG_STATS_DOMAINS)
  const stats = useMemoResource(
    (signal) => memosApi.stats.get({ spaceId, tz: localTimeZone() }, signal),
    [spaceId, revision],
  )
  const [prefs, setPrefs] = useState<MemoTagBrowserPrefs>(loadMemoTagBrowserPrefs)
  const tree = useMemo(() => buildMemoTagTree(stats.data?.tagCounts ?? {}), [stats.data])
  const expanded = useMemo(() => new Set(prefs.expanded), [prefs.expanded])
  const flatRows = useMemo(() => flatMemoTagRows(tree), [tree])
  const activeTag = urlState.tag
  const revealedTag = useRef<string | null>(null)

  useEffect(() => {
    if (!activeTag) {
      revealedTag.current = null
      return
    }
    if (revealedTag.current === activeTag) return
    revealedTag.current = activeTag
    const missing = ancestorTagPaths(activeTag).filter((path) => !expanded.has(path))
    if (missing.length === 0) return
    const next = { ...prefs, expanded: [...prefs.expanded, ...missing] }
    setPrefs(next)
    saveMemoTagBrowserPrefs(next)
  }, [activeTag, expanded, prefs])

  const changePrefs = (next: MemoTagBrowserPrefs): void => {
    setPrefs(next)
    saveMemoTagBrowserPrefs(next)
  }

  const toggleTag = (path: string): void => {
    changePrefs({
      ...prefs,
      expanded: expanded.has(path)
        ? prefs.expanded.filter((entry) => entry !== path)
        : [...prefs.expanded, path],
    })
  }

  const openTag = (tag: string): void => {
    const display = displayForUrl(urlState)
    const target = route.kind === 'space' ? pathname : MEMOS_APP_PATH
    navigateMemoUrl(target, buildMemoSearch({
      tag,
      spaceId: route.kind === 'space' ? null : spaceId,
      orderBy: display.timeBasis,
      order: display.order,
      display,
    }))
  }

  const loading = stats.status === 'loading' && stats.data === null
  const failed = stats.status === 'error' && stats.data === null
  const empty = stats.data !== null && tree.length === 0

  return (
    <div className="pt-2">
      <div className="flex items-center gap-0.5 pr-1">
        <SectionLabel className="flex-1">{t('memos.nav.tags')}</SectionLabel>
        <Tooltip label={t('memos.tags.tree_mode')} side="left">
          <IconButton
            label={t('memos.tags.tree_mode')}
            size="xs"
            active={prefs.mode === 'tree'}
            onClick={() => changePrefs({ ...prefs, mode: 'tree' })}
          >
            <ListTree size={12} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('memos.tags.flat_mode')} side="left">
          <IconButton
            label={t('memos.tags.flat_mode')}
            size="xs"
            active={prefs.mode === 'flat'}
            onClick={() => changePrefs({ ...prefs, mode: 'flat' })}
          >
            <List size={12} />
          </IconButton>
        </Tooltip>
      </div>
      {loading ? (
        <div className="space-y-1 px-2 py-1">
          <Skeleton className="h-5" />
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : null}
      {failed ? (
        <div className="px-2 py-1">
          <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
            {stats.error ?? t('memos.tags.error')}
          </p>
          <Button size="sm" variant="ghost" className="mt-1 h-7 px-1.5" onClick={stats.reload}>
            {t('memos.common.retry')}
          </Button>
        </div>
      ) : null}
      {empty ? (
        <p className="px-2 py-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
          {t('memos.tags.empty')}
        </p>
      ) : null}
      {tree.length > 0 && prefs.mode === 'tree' ? (
        <ul role="tree" aria-label={t('memos.tags.tree_label')} className="mt-0.5 space-y-px">
          {tree.map((node, index) => (
            <MemoTagTreeItem
              key={node.fullPath}
              node={node}
              expanded={expanded}
              activeTag={activeTag}
              setSize={tree.length}
              posInSet={index + 1}
              onToggle={toggleTag}
              onSelect={openTag}
            />
          ))}
        </ul>
      ) : null}
      {tree.length > 0 && prefs.mode === 'flat' ? (
        <ul aria-label={t('memos.tags.flat_label')} className="mt-0.5 space-y-px">
          {flatRows.map((node) => {
            const active = node.fullPath === activeTag
            return (
              <li key={node.fullPath}>
                <button
                  type="button"
                  data-memo-tag-path={node.fullPath}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => openTag(node.fullPath)}
                  className={cn(
                    'flex min-h-10 w-full items-center gap-1.5 rounded-[var(--r-md)] px-2 text-left',
                    'text-[length:var(--text-12-5)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
                    'md:min-h-0 md:h-7',
                    active
                      ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <Hash size={12} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
                  <span className="min-w-0 flex-1 truncate">{node.fullPath}</span>
                  {node.count > 0 ? (
                    <span className="shrink-0 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">{node.count}</span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

interface MemoTagTreeItemProps {
  node: TagTreeNode
  expanded: ReadonlySet<string>
  activeTag: string | null
  setSize: number
  posInSet: number
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}

function MemoTagTreeItem({
  node,
  expanded,
  activeTag,
  setSize,
  posInSet,
  onToggle,
  onSelect,
}: MemoTagTreeItemProps): ReactElement {
  const onKeyDown = useTreeKeyboard()
  const hasChildren = node.children.length > 0
  const open = hasChildren && expanded.has(node.fullPath)
  const active = node.fullPath === activeTag
  const count = node.isVirtual ? node.totalCount : node.count
  return (
    <li {...treeItemProps({
      level: node.depth + 1,
      expanded: hasChildren ? open : undefined,
      selected: active,
      setSize,
      posInSet,
    })}>
      <div
        className={cn(
          'flex min-h-10 items-center gap-1 rounded-[var(--r-md)] pr-1 md:min-h-0 md:h-7',
          'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
          active
            ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
        )}
        style={{ paddingLeft: treeIndent(node.depth) }}
      >
        {hasChildren ? (
          <button
            type="button"
            data-tree-toggle
            aria-expanded={open}
            aria-label={t(open ? 'memos.tags.collapse' : 'memos.tags.expand', { tag: node.fullPath })}
            onClick={() => onToggle(node.fullPath)}
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-quaternary)] md:size-5',
              'hover:bg-[var(--bg-active)] hover:text-[var(--text-secondary)]',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
            )}
          >
            <ChevronRight
              size={12}
              className={cn('transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)]', open && 'rotate-90')}
            />
          </button>
        ) : (
          <span aria-hidden="true" className="size-6 shrink-0 md:size-5" />
        )}
        <Hash size={12} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
        <button
          type="button"
          data-tree-row
          data-memo-tag-path={node.fullPath}
          aria-current={active ? 'page' : undefined}
          onClick={() => onSelect(node.fullPath)}
          onKeyDown={onKeyDown}
          className={cn(
            'min-w-0 flex-1 self-stretch truncate py-1 text-left text-[length:var(--text-12-5)] font-medium',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
          )}
        >
          {node.name}
        </button>
        {count > 0 ? (
          <span className="shrink-0 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">{count}</span>
        ) : null}
      </div>
      {hasChildren && open ? (
        <ul role="group" className="space-y-px">
          {node.children.map((child, index) => (
            <MemoTagTreeItem
              key={child.fullPath}
              node={child}
              expanded={expanded}
              activeTag={activeTag}
              setSize={node.children.length}
              posInSet={index + 1}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}
