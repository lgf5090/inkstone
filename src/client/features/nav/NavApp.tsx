import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, ArrowDown, ArrowUp, Bot, CheckCircle2, ChevronDown, ChevronRight, Cloud,
  ChevronsDown, ChevronsUp,
  Copy, ExternalLink, FolderCog, FolderPlus, GripVertical, History, LayoutGrid, List, Lock,
  RefreshCw,
  MoreHorizontal, PanelLeft, Pencil, Pin, Plus, QrCode, Rows3, Search, Settings,
  Trash2, TrendingUp, Unplug, Upload, X,
} from 'lucide-react'
import { compileQuery, queryMatches } from '../../lib/query-match'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { copyText } from '../../lib/clipboard'
import { usePinyinVersion } from '../../lib/pinyin'
import { isImeComposing } from '../../lib/ime'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { Button, Badge, IconButton } from '../../components/primitives'
import { Input, Segmented } from '../../components/form'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Drawer, Menu, confirm, useContextMenu, type MenuItem } from '../../components/overlay'
import { SelectMenu } from '../../components/select-menu'
import { useUi } from '../../store/ui'
import { useAssistantToolRefresh } from '../chat/tool-refresh'
import { AssistantDock } from '../chat/AssistantDock'
import {
  avatarTint, buildSearchUrl, initialFor, isHttpUrl, linkMatchesQuery,
  type NavCategory, type NavLink,
} from '@shared/nav/model'
import type { NavAssistantContext } from '@shared/nav/assistant-context'
import { useNavStore } from './nav-store'
import { NavIcon } from './nav-icons'
import { NavLinkEditor } from './NavLinkEditor'
import { NavSettingsModal } from './NavSettings'
import { NavBackupModal } from './NavBackupPanel'
import { CategoryManagerModal, UnlockModal } from './NavCategories'
import { LinkCheckerModal } from './NavChecker'
import { ImportExportModal, QrModal } from './NavImport'

const NAV_WRITE_TOOLS = new Set([
  'nav_create_link',
  'nav_update_link',
  'nav_move_links',
  'nav_rewrite_links',
  'nav_create_category',
  'nav_update_category',
  'nav_sort_links',
  'nav_delete_links',
  'nav_delete_category',
])

const NAV_RENDER_PAGE = 120
const AUTO_LOAD_LIMIT = 600

function createMatcher(query: string): (link: NavLink) => boolean {
  const text = query.trim()
  if (!text) return () => true
  const compiled = compileQuery(text)
  if (compiled.error) return () => true
  if (compiled.pattern) {
    return (link) => {
      compiled.pattern!.lastIndex = 0
      return compiled.pattern!.test(link.title) || compiled.pattern!.test(link.description ?? '') || compiled.pattern!.test(link.url)
    }
  }
  return (link) => queryMatches(compiled, link.title) !== null || linkMatchesQuery(link, text)
}

function LinkIcon({ link, size = 40 }: { link: NavLink; size?: number }) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null)
  if (link.icon && failedIcon !== link.icon) {
    return (
      <span className="flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--r-md)] bg-[var(--bg-inset)]" style={{ width: size, height: size }}>
        <img src={link.icon} alt="" width={size * 0.7} height={size * 0.7} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="object-contain" onError={() => setFailedIcon(link.icon)} />
      </span>
    )
  }
  return (
    <span className="flex shrink-0 items-center justify-center rounded-[var(--r-md)] font-semibold text-[var(--text-primary)]" style={{ width: size, height: size, fontSize: size * 0.38, backgroundColor: 'var(--bg-inset)', background: `color-mix(in oklab, ${avatarTint(link.title || link.url)} 18%, var(--bg-surface))` }} aria-hidden>
      {initialFor(link.title, link.url)}
    </span>
  )
}

function SyncBadge({ status }: { status: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (status === 'idle') return null
  return (
    <span className={cn('hidden items-center gap-1 text-[length:var(--text-10-5)] sm:flex', status === 'error' ? 'text-[var(--danger)]' : status === 'saved' ? 'text-[var(--success)]' : 'text-[var(--text-tertiary)]')}>
      {status === 'saved' ? <CheckCircle2 size={12} /> : status === 'error' ? <AlertCircle size={12} /> : <span className="size-2 animate-pulse rounded-full bg-current" />}
      {status === 'saving' ? t('nav.sync.saving') : status === 'saved' ? t('nav.sync.saved') : t('nav.sync.error')}
    </span>
  )
}

interface CardProps {
  link: NavLink
  detailed: boolean
  visitCount?: number
  sorting: boolean
  onOpen: (link: NavLink) => void
  onEdit: (link: NavLink) => void
  onDelete: (link: NavLink) => void
  onMenu: (link: NavLink, point: { x: number; y: number }) => void
  onMove: (link: NavLink, direction: -1 | 1) => void
  onDropOn: (target: NavLink) => void
  onDragStart?: (link: NavLink) => void
  onDragEnd?: () => void
}

function LinkCard({ link, detailed, visitCount, sorting, onOpen, onEdit, onDelete, onMenu, onMove, onDropOn, onDragStart, onDragEnd }: CardProps) {
  const titleId = `nav-title-${link.id}`
  const anchorProps = isHttpUrl(link.url)
    ? { href: link.url, target: '_blank', rel: 'noopener noreferrer' }
    : { href: link.url }
  return (
    <article
      draggable={sorting}
      className={cn(
        'group relative flex min-w-0 flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] transition-[transform,box-shadow,border-color,background-color] duration-[var(--dur-fast)] hover:-translate-y-0.5 hover:border-[var(--border-default)] hover:bg-[var(--bg-raised)] hover:shadow-[var(--shadow-soft)] [content-visibility:auto]',
        detailed ? 'gap-1 p-3 [contain-intrinsic-size:auto_88px]' : 'min-h-[56px] justify-center p-2.5 [contain-intrinsic-size:auto_56px]',
        sorting && 'cursor-grab',
      )}
      onContextMenu={(event) => { event.preventDefault(); onMenu(link, { x: event.clientX, y: event.clientY }) }}
      onDragStart={(event) => { if (!sorting) { event.preventDefault(); return }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', link.id); onDragStart?.(link) }}
      onDragEnd={() => onDragEnd?.()}
      onDragOver={(event) => { if (sorting) event.preventDefault() }}
      onDrop={(event) => { if (sorting) { event.preventDefault(); onDropOn(link) } }}
    >
      <a {...anchorProps} draggable={sorting ? false : undefined} aria-labelledby={titleId} className="absolute inset-0 z-0 rounded-[var(--r-md)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => onOpen(link)} onAuxClick={(event) => { if (event.button === 1) onOpen(link) }} />
      <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-2.5">
        <LinkIcon link={link} size={detailed ? 40 : 32} />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-9 [@media(hover:hover)]:pr-0">
          <span id={titleId} className={cn('min-w-0 truncate font-medium text-[var(--text-primary)]', detailed ? 'text-[length:var(--text-14)]' : 'text-[length:var(--text-13)]')}>{link.title}</span>
          {link.pinned && <Pin size={11} className="shrink-0 text-[var(--warning)]" aria-label={t('nav.pinned')} />}
          {typeof visitCount === 'number' && visitCount > 0 && <Badge tone="neutral" className="shrink-0 whitespace-nowrap">{t('nav.visit_count', { count: visitCount })}</Badge>}
        </div>
        <div className={cn('pointer-events-auto absolute right-0.5 top-0.5 z-20 flex items-center gap-0.5', !sorting && 'opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100')}>
          <span className="hidden [@media(hover:hover)]:inline-flex"><IconButton label={t('nav.edit')} onClick={() => onEdit(link)}><Pencil size={13} /></IconButton><IconButton label={t('nav.delete')} onClick={() => onDelete(link)}><Trash2 size={13} /></IconButton></span>
          <IconButton label={t('nav.more')} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onMenu(link, { x: rect.right, y: rect.bottom }) }}><MoreHorizontal size={14} /></IconButton>
        </div>
      </div>
      {detailed && link.description && (
        <p className="pointer-events-none relative z-10 mt-0.5 line-clamp-2 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">{link.description}</p>
      )}
      {detailed && (
        <p className="pointer-events-none relative z-10 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{link.url}</p>
      )}
      {sorting && (
        <div className="pointer-events-auto relative z-10 mt-1 flex items-center justify-between gap-1 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
          <span aria-hidden="true" className="inline-flex cursor-grab items-center gap-1 rounded-[var(--r-xs)] px-1 py-0.5">
            <GripVertical size={12} /> {t('nav.sort')}
          </span>
          <span className="flex items-center gap-0.5">
            <IconButton label={t('nav.move_up')} onClick={() => onMove(link, -1)}><ArrowUp size={13} /></IconButton>
            <IconButton label={t('nav.move_down')} onClick={() => onMove(link, 1)}><ArrowDown size={13} /></IconButton>
          </span>
        </div>
      )}
    </article>
  )
}

function SectionTitle({ icon, title, count, action }: { icon: React.ReactNode; title: string; count: number; action?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[var(--text-tertiary)]">{icon}</span>
        <h3 className="text-[length:var(--text-12-5)] font-semibold text-[var(--text-primary)]">{title}</h3>
        <Badge tone="neutral">{count}</Badge>
      </div>
      {action}
    </div>
  )
}

interface CategoryRowProps {
  label: string
  icon: string
  count: number
  active: boolean
  locked: boolean
  small?: boolean
  expanded?: boolean
  hasChildren?: boolean
  onSelect: () => void
  onToggle?: () => void
  onContextMenu?: (event: React.MouseEvent) => void
  onMenuAt?: (point: { x: number; y: number }) => void
}

const LONG_PRESS_MS = 480

function CategoryRow({ label, icon, count, active, locked, small, expanded, hasChildren, onSelect, onToggle, onContextMenu, onMenuAt }: CategoryRowProps) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const suppressed = useRef(false)

  function endPress(): void {
    if (!press.current) return
    clearTimeout(press.current.timer)
    press.current = null
  }

  function beginPress(event: React.PointerEvent): void {
    if (event.pointerType === 'mouse' || !onMenuAt) return
    const { clientX: x, clientY: y } = event
    suppressed.current = false
    press.current = {
      x,
      y,
      timer: setTimeout(() => {
        press.current = null
        suppressed.current = true
        onMenuAt({ x, y })
      }, LONG_PRESS_MS),
    }
  }

  function movePress(event: React.PointerEvent): void {
    if (!press.current) return
    if (Math.abs(event.clientX - press.current.x) > 8 || Math.abs(event.clientY - press.current.y) > 8) endPress()
  }

  useEffect(() => () => {
    if (press.current) clearTimeout(press.current.timer)
  }, [])

  return (
    <div
      onContextMenu={onContextMenu}
      className={cn('flex items-center gap-0.5 rounded-[var(--r-sm)]', active ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}
    >
      {!small && (
        <span className="flex size-9 shrink-0 items-center justify-center md:size-7">
          {hasChildren ? (
            <button type="button" onClick={onToggle} aria-label={expanded ? t('nav.collapse_sidebar') : t('nav.expand_sidebar')} aria-expanded={expanded} className="flex size-9 items-center justify-center rounded-[var(--r-xs)] hover:bg-[var(--bg-active)] md:size-7">
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          ) : null}
        </span>
      )}
      <button
        type="button"
        onClick={() => { if (suppressed.current) { suppressed.current = false; return } onSelect() }}
        onKeyDown={(event) => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          onMenuAt?.({ x: rect.left + 12, y: rect.bottom - 2 })
        }}
        onPointerDown={beginPress}
        onPointerMove={movePress}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        onPointerLeave={endPress}
        aria-current={active ? 'page' : undefined}
        className={cn('flex min-h-11 min-w-0 flex-1 items-center gap-1.5 py-2 pr-1 text-left md:min-h-0 md:py-1.5', small ? 'pl-2 text-[length:var(--text-11-5)]' : 'text-[length:var(--text-12)]')}
      >
        <NavIcon name={icon} size={small ? 13 : 15} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {locked && <Lock size={11} className="shrink-0 text-[var(--warning)]" aria-label={t('nav.locked')} />}
        <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">{count}</span>
      </button>
    </div>
  )
}

export function NavApp() {
  if (IS_DEMO_MODE) {
    return <div className="flex h-full items-center justify-center p-8 text-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">{t('nav.demo_unavailable')}</div>
  }
  const status = useNavStore((state) => state.status)
  const error = useNavStore((state) => state.error)
  const categories = useNavStore((state) => state.categories)
  const links = useNavStore((state) => state.links)
  const visits = useNavStore((state) => state.visits)
  const counts = useNavStore((state) => state.counts)
  const settings = useNavStore((state) => state.settings)
  const sync = useNavStore((state) => state.sync)
  const unlockTokens = useNavStore((state) => state.unlockTokens)
  const selectedCategory = useNavStore((state) => state.selectedCategory)
  const selectedSubcategory = useNavStore((state) => state.selectedSubcategory)
  const query = useNavStore((state) => state.query)
  const pageKey = `${selectedCategory ?? ''}|${selectedSubcategory ?? ''}|${query}`
  const load = useNavStore((state) => state.load)
  const setQuery = useNavStore((state) => state.setQuery)
  const selectCategory = useNavStore((state) => state.selectCategory)
  const saveDisplay = useNavStore((state) => state.saveDisplay)
  const saveSearch = useNavStore((state) => state.saveSearch)
  const updateLink = useNavStore((state) => state.updateLink)
  const deleteLink = useNavStore((state) => state.deleteLink)
  const reorderLinks = useNavStore((state) => state.reorderLinks)
  const toast = useUi((state) => state.toast)
  const assistantDockOpen = useUi((state) => state.assistantDockOpen)
  const setAssistantDock = useUi((state) => state.setAssistantDock)
  const pinyinVersion = usePinyinVersion()
  const deferredQuery = useDeferredValue(query)
  const matcher = useMemo(() => createMatcher(deferredQuery), [deferredQuery, pinyinVersion])
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    if (typeof window === 'undefined') return false
    try { return window.localStorage.getItem('inkstone.nav.sidebarHidden') === '1' } catch { return false }
  })
  const [mobileOpen, setMobileOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editor, setEditor] = useState<{ open: boolean; link: NavLink | null; initial: { title: string; url: string } | null; defaultCategoryId?: string }>({ open: false, link: null, initial: null })
  const [unlockCategory, setUnlockCategory] = useState<NavCategory | null>(null)
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false)
  const [categoryManagerTarget, setCategoryManagerTarget] = useState<{ editId?: string | null; parentId?: string | null; deleteId?: string | null } | null>(null)
  const [categoryFilter, setCategoryFilter] = useState('')
  const [checkerOpen, setCheckerOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [qr, setQr] = useState<{ url: string; title: string } | null>(null)
  const [sortingPinned, setSortingPinned] = useState(false)
  const [sortingNormal, setSortingNormal] = useState(false)
  const [renderPage, setRenderPage] = useState({ key: pageKey, limit: NAV_RENDER_PAGE })
  const renderLimit = renderPage.key === pageKey ? renderPage.limit : NAV_RENDER_PAGE
  const [dragId, setDragId] = useState<string | null>(null)
  const [menuLink, setMenuLink] = useState<NavLink | null>(null)
  const [categoryMenu, setCategoryMenu] = useState<{ category: NavCategory | null; point: { x: number; y: number } } | null>(null)
  const context = useContextMenu()
  const settingsAnchor = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)

  useEffect(() => { void load() }, [load])
  useAssistantToolRefresh(NAV_WRITE_TOOLS, () => load(true))
  useEffect(() => {
    if (typeof window === 'undefined') return
    try { window.localStorage.setItem('inkstone.nav.sidebarHidden', sidebarHidden ? '1' : '0') } catch { /* ignore */ }
  }, [sidebarHidden])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const url = params.get('add_url')
    if (!url) return
    const title = params.get('add_title') ?? ''
    window.history.replaceState({}, '', window.location.pathname)
    if (!isHttpUrl(url) && !url.startsWith('mailto:') && !url.startsWith('tel:')) return
    setEditor({ open: true, link: null, initial: { title, url } })
  }, [])
  useEffect(() => {
    setSortingPinned(false)
    setSortingNormal(false)
  }, [selectedCategory, selectedSubcategory, query])
  useEffect(() => {
    setRenderPage((current) => current.key === pageKey ? current : { key: pageKey, limit: NAV_RENDER_PAGE })
  }, [pageKey])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      if (event.key === '/') {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        openEditor()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const selectedRoot = categories.find((category) => category.id === selectedCategory && !category.parentId) ?? null
  const subcategories = useMemo(() => selectedRoot ? categories.filter((category) => category.parentId === selectedRoot.id).sort((a, b) => a.sortOrder - b.sortOrder) : [], [categories, selectedRoot])
  const expandableRoots = useMemo(() => categories.filter((category) => !category.parentId && categories.some((item) => item.parentId === category.id)), [categories])
  const allRootsExpanded = expandableRoots.length > 0 && expandableRoots.every((category) => expanded.has(category.id))
  const sidebarTree = useMemo(() => {
    const roots = categories.filter((category) => !category.parentId).sort((a, b) => a.sortOrder - b.sortOrder)
    const children = new Map<string, NavCategory[]>()
    for (const category of categories) {
      if (!category.parentId) continue
      const siblings = children.get(category.parentId) ?? []
      siblings.push(category)
      children.set(category.parentId, siblings)
    }
    for (const siblings of children.values()) siblings.sort((a, b) => a.sortOrder - b.sortOrder)
    const text = categoryFilter.trim()
    if (!text) return { roots, children, filtering: false }
    const compiled = compileQuery(text)
    const matches = (name: string): boolean => queryMatches(compiled, name) !== null
    const visibleRoots = roots.filter((root) => matches(root.name) || (children.get(root.id) ?? []).some((child) => matches(child.name)))
    const visibleChildren = new Map<string, NavCategory[]>()
    for (const root of visibleRoots) {
      const all = children.get(root.id) ?? []
      visibleChildren.set(root.id, matches(root.name) ? all : all.filter((child) => matches(child.name)))
    }
    return { roots: visibleRoots, children: visibleChildren, filtering: true }
  }, [categories, categoryFilter, pinyinVersion])
  const scopedLinks = useMemo(() => {
    let scoped = links
    if (selectedSubcategory) scoped = links.filter((link) => link.categoryId === selectedSubcategory)
    else if (selectedCategory) {
      const scope = new Set([selectedCategory, ...categories.filter((category) => category.parentId === selectedCategory).map((category) => category.id)])
      scoped = links.filter((link) => scope.has(link.categoryId))
    }
    return scoped.filter(matcher)
  }, [links, selectedCategory, selectedSubcategory, categories, matcher])
  const showSmart = !selectedCategory && !selectedSubcategory && !query.trim()
  const recent = useMemo(() => {
    if (!showSmart) return []
    const quota = Math.max(0, settings.display.recentLinksCount)
    if (!quota) return []
    const byId = new Map(links.map((link) => [link.id, link]))
    return Object.entries(visits)
      .filter(([id, visit]) => visit.lastVisitedAt > 0 && byId.has(id))
      .sort((a, b) => b[1].lastVisitedAt - a[1].lastVisitedAt)
      .slice(0, quota)
      .map(([id]) => byId.get(id)!)
  }, [showSmart, settings.display.recentLinksCount, visits, links])
  const frequent = useMemo(() => {
    if (!showSmart) return []
    const quota = Math.max(0, settings.display.frequentLinksCount)
    if (!quota) return []
    const byId = new Map(links.map((link) => [link.id, link]))
    return Object.entries(visits)
      .filter(([id, visit]) => visit.visitCount > 0 && byId.has(id))
      .sort((a, b) => b[1].visitCount - a[1].visitCount || b[1].lastVisitedAt - a[1].lastVisitedAt)
      .slice(0, quota)
      .map(([id]) => ({ link: byId.get(id)!, count: visits[id]!.visitCount }))
  }, [showSmart, settings.display.frequentLinksCount, visits, links])
  const pinned = useMemo(() => scopedLinks.filter((link) => link.pinned).sort((a, b) => a.pinnedOrder - b.pinnedOrder), [scopedLinks])
  const selectedSubcategoryName = categories.find((category) => category.id === selectedSubcategory)?.name ?? null
  const navContext = useMemo<NavAssistantContext>(() => ({
    categoryId: selectedCategory,
    categoryName: selectedRoot?.name ?? null,
    subcategoryId: selectedSubcategory,
    subcategoryName: selectedSubcategoryName,
    query: query.trim() || null,
    totalLinks: links.length,
    visibleLinks: scopedLinks.length,
    pinnedCount: pinned.length,
    lockedCategories: categories.filter((category) => category.hasPassword).length,
    unlockTokens: Object.values(unlockTokens),
  }), [selectedCategory, selectedRoot?.name, selectedSubcategory, selectedSubcategoryName, query, links.length, scopedLinks.length, pinned.length, categories, unlockTokens])
  const normal = useMemo(() => scopedLinks.filter((link) => !link.pinned).sort((a, b) => a.sortOrder - b.sortOrder), [scopedLinks])
  const visibleNormal = normal.slice(0, renderLimit)
  const hasMoreNormal = visibleNormal.length < normal.length
  useEffect(() => {
    const node = loadMoreRef.current
    if (!node || renderLimit >= AUTO_LOAD_LIMIT) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setRenderPage((current) => ({
          key: pageKey,
          limit: (current.key === pageKey ? current.limit : NAV_RENDER_PAGE) + NAV_RENDER_PAGE,
        }))
      }
    }, { rootMargin: '800px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMoreNormal, normal.length, pageKey, renderLimit])
  const canSortPinned = !selectedCategory && !query.trim()
  const normalScopeId = selectedSubcategory ?? (selectedRoot && subcategories.length === 0 ? selectedRoot.id : null)
  const canSortNormal = !query.trim() && Boolean(normalScopeId)
  const detailed = settings.display.cardStyle === 'detailed'
  const activeSearchSource = settings.search.sources.find((source) => source.id === settings.search.selectedSourceId && source.enabled) ?? null

  const categoryCount = useCallback((category: NavCategory): number => {
    const own = counts.byCategory[category.id] ?? 0
    if (category.parentId) return own
    return own + categories.filter((child) => child.parentId === category.id).reduce((sum, child) => sum + (counts.byCategory[child.id] ?? 0), 0)
  }, [counts.byCategory, categories])
  const isLocked = (category: NavCategory): boolean => category.hasPassword && !unlockTokens[category.id]

  function openEditor(link: NavLink | null = null, initial: { title: string; url: string } | null = null): void {
    setEditor({ open: true, link, initial, defaultCategoryId: selectedSubcategory ?? selectedCategory ?? undefined })
  }

  function openCategoryManager(target: { editId?: string | null; parentId?: string | null; deleteId?: string | null } | null = null): void {
    setCategoryManagerTarget(target)
    setCategoryManagerOpen(true)
  }

  function closeCategoryManager(): void {
    setCategoryManagerOpen(false)
    setCategoryManagerTarget(null)
  }

  async function chooseCategory(category: NavCategory | null, subcategory: string | null = null): Promise<void> {
    setMobileOpen(false)
    if (category && isLocked(category)) {
      setUnlockCategory(category)
      return
    }
    if (category?.parentId) {
      selectCategory(category.parentId, category.id)
      return
    }
    if (category) {
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(category.id)) next.delete(category.id)
        else next.add(category.id)
        return next
      })
    }
    selectCategory(category?.id ?? null, subcategory)
  }

  async function recordOpen(link: NavLink): Promise<void> {
    useNavStore.getState().recordVisit(link)
  }

  async function removeLink(link: NavLink): Promise<void> {
    if (!(await confirm({ title: t('nav.link.delete_confirm'), tone: 'danger', confirmLabel: t('nav.delete') }))) return
    try { await deleteLink(link.id) } catch (reason) { toast({ title: reason instanceof Error ? reason.message : t('nav.error.generic'), tone: 'danger' }) }
  }

  async function togglePin(link: NavLink): Promise<void> {
    try { await updateLink(link.id, { pinned: !link.pinned }) } catch (reason) { toast({ title: reason instanceof Error ? reason.message : t('nav.error.generic'), tone: 'danger' }) }
  }

  async function copyLink(link: NavLink): Promise<void> {
    if (await copyText(link.url)) toast({ title: t('nav.copied'), tone: 'success' })
    else toast({ title: t('nav.error.generic'), tone: 'danger' })
  }

  function openMenu(link: NavLink, point: { x: number; y: number }): void {
    setMenuLink(link)
    context.openAt(point)
  }

  function openCategoryMenu(event: React.MouseEvent, category: NavCategory | null): void {
    event.preventDefault()
    event.stopPropagation()
    setCategoryMenu({ category, point: { x: event.clientX, y: event.clientY } })
  }

  async function copyCategoryName(category: NavCategory): Promise<void> {
    if (await copyText(category.name)) toast({ title: t('nav.category.copied'), tone: 'success' })
    else toast({ title: t('nav.error.generic'), tone: 'danger' })
  }

  function categoryMenuItemsFor(category: NavCategory | null): MenuItem[] {
    if (!category) {
      return [
        { id: 'new-root', label: t('nav.category.add_root'), icon: <FolderPlus size={13} />, onSelect: () => openCategoryManager({ parentId: null }) },
        { id: 'manage', label: t('nav.category_manager'), icon: <FolderCog size={13} />, onSelect: () => openCategoryManager() },
        { id: 'refresh', label: t('nav.refresh'), icon: <RefreshCw size={13} />, onSelect: () => void load(true) },
      ]
    }
    const hasChildren = categories.some((item) => item.parentId === category.id)
    return [
      { id: 'open', label: t('nav.open'), icon: <ExternalLink size={13} />, onSelect: () => void chooseCategory(category) },
      ...(category.parentId ? [] : [{
        id: 'child', label: t('nav.category.add_child', { name: category.name }), icon: <FolderPlus size={13} />, onSelect: () => openCategoryManager({ parentId: category.id }),
      }]),
      { id: 'edit', label: t('nav.edit'), icon: <Pencil size={13} />, onSelect: () => openCategoryManager({ editId: category.id }) },
      { id: 'copy-name', label: t('nav.copy_name'), icon: <Copy size={13} />, onSelect: () => void copyCategoryName(category) },
      ...(category.parentId || !hasChildren ? [] : [{
        id: 'toggle', label: expanded.has(category.id) ? t('nav.category.collapse') : t('nav.category.expand'), icon: <ChevronRight size={13} />, onSelect: () => setExpanded((current) => { const next = new Set(current); if (next.has(category.id)) next.delete(category.id); else next.add(category.id); return next }),
      }]),
      ...(isLocked(category) ? [{ id: 'unlock', label: t('nav.unlock.action'), icon: <Lock size={13} />, onSelect: () => setUnlockCategory(category) }] : []),
      { id: 'manage', label: t('nav.category_manager'), icon: <FolderCog size={13} />, onSelect: () => openCategoryManager() },
      { id: 'delete', label: t('nav.category.delete_title'), icon: <Trash2 size={13} />, tone: 'danger' as const, separatorBefore: true, onSelect: () => openCategoryManager({ deleteId: category.id }) },
    ]
  }

  async function moveWithin(list: NavLink[], link: NavLink, direction: -1 | 1, categoryId: string | null): Promise<void> {
    const index = list.findIndex((item) => item.id === link.id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= list.length) return
    const next = [...list]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    try {
      await reorderLinks(categoryId ? 'category' : 'pinned', next.map((item) => item.id), categoryId ?? undefined)
    } catch (reason) {
      toast({ title: reason instanceof Error ? reason.message : t('nav.error.generic'), tone: 'danger' })
    }
  }

  function dropOn(list: NavLink[], target: NavLink, categoryId: string | null): void {
    if (!dragId || dragId === target.id) return
    const from = list.findIndex((item) => item.id === dragId)
    const to = list.findIndex((item) => item.id === target.id)
    if (from < 0 || to < 0) return
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved!)
    setDragId(null)
    void reorderLinks(categoryId ? 'category' : 'pinned', next.map((item) => item.id), categoryId ?? undefined).catch((reason) => {
      toast({ title: reason instanceof Error ? reason.message : t('nav.error.generic'), tone: 'danger' })
    })
  }

  async function submitSearch(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (settings.search.mode !== 'external' || !query.trim()) return
    if (!activeSearchSource) {
      toast({ title: t('nav.search.no_source'), tone: 'warning' })
      return
    }
    const target = buildSearchUrl(activeSearchSource, query)
    if (target) window.open(target, '_blank', 'noopener,noreferrer')
  }

  function changeMode(mode: 'internal' | 'external'): void {
    const next = { ...settings.search, mode, selectedSourceId: settings.search.selectedSourceId ?? settings.search.sources.find((source) => source.enabled)?.id ?? null }
    void saveSearch(next).catch((reason) => toast({ title: reason instanceof Error ? reason.message : t('nav.error.generic'), tone: 'danger' }))
  }

  function changeEngine(id: string): void {
    void saveSearch({ ...settings.search, selectedSourceId: id || null }).catch((reason) => toast({ title: reason instanceof Error ? reason.message : t('nav.error.generic'), tone: 'danger' }))
  }

  function toggleCardStyle(): void {
    void saveDisplay({ ...settings.display, cardStyle: detailed ? 'simple' : 'detailed' }).catch((reason) => toast({ title: reason instanceof Error ? reason.message : t('nav.error.generic'), tone: 'danger' }))
  }

  const menuItems: MenuItem[] = menuLink ? [
    { id: 'open', label: t('nav.open'), icon: <ExternalLink size={13} />, onSelect: () => { void recordOpen(menuLink); window.open(menuLink.url, '_blank', 'noopener,noreferrer') } },
    { id: 'copy', label: t('nav.copy'), icon: <Copy size={13} />, onSelect: () => void copyLink(menuLink) },
    { id: 'qr', label: t('nav.qr'), icon: <QrCode size={13} />, onSelect: () => setQr({ url: menuLink.url, title: menuLink.title }) },
    { id: 'pin', label: menuLink.pinned ? t('nav.unpin') : t('nav.pin'), icon: <Pin size={13} />, onSelect: () => void togglePin(menuLink) },
    { id: 'edit', label: t('nav.edit'), icon: <Pencil size={13} />, separatorBefore: true, onSelect: () => openEditor(menuLink) },
    { id: 'delete', label: t('nav.delete'), icon: <Trash2 size={13} />, tone: 'danger', onSelect: () => void removeLink(menuLink) },
  ] : []

  function sidebar() {
    return (
      <div className="flex min-h-full flex-col gap-0.5 p-2" onContextMenu={(event) => { if (event.target === event.currentTarget) openCategoryMenu(event, null) }}>
        <div className="relative mb-1">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" />
          <Input
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}
            placeholder={t('nav.category.filter')}
            aria-label={t('nav.category.filter')}
            className="pl-7 pr-7"
          />
          {categoryFilter && (
            <IconButton
              label={t('nav.search.clear')}
              size="xs"
              className="absolute right-0 top-1/2 -translate-y-1/2"
              onClick={() => setCategoryFilter('')}
            >
              <X size={12} />
            </IconButton>
          )}
        </div>
        <CategoryRow label={t('nav.all')} icon="layout-grid" count={counts.total} active={!selectedCategory} locked={false} onSelect={() => void chooseCategory(null)} onContextMenu={(event) => openCategoryMenu(event, null)} onMenuAt={(point) => setCategoryMenu({ category: null, point })} />
        {sidebarTree.roots.length === 0 && sidebarTree.filtering && (
          <p className="px-2 py-3 text-center text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('nav.category.no_match')}</p>
        )}
        {sidebarTree.roots.map((root) => {
          const children = sidebarTree.children.get(root.id) ?? []
          const fullChildren = categories.filter((category) => category.parentId === root.id)
          const open = sidebarTree.filtering || expanded.has(root.id)
          return (
            <div key={root.id}>
              <CategoryRow
                label={root.name}
                icon={root.icon}
                count={categoryCount(root)}
                active={selectedCategory === root.id && !selectedSubcategory}
                locked={isLocked(root)}
                hasChildren={!sidebarTree.filtering && fullChildren.length > 0}
                expanded={open}
                onToggle={() => setExpanded((current) => { const next = new Set(current); if (next.has(root.id)) next.delete(root.id); else next.add(root.id); return next })}
                onSelect={() => void chooseCategory(root)}
                onContextMenu={(event) => openCategoryMenu(event, root)} onMenuAt={(point) => setCategoryMenu({ category: root, point })}
              />
              {open && children.map((child) => (
                <div key={child.id} className="ml-3 border-l border-[var(--border-subtle)] pl-1">
                  <CategoryRow
                    label={child.name}
                    icon={child.icon}
                    count={counts.byCategory[child.id] ?? 0}
                    active={selectedSubcategory === child.id}
                    locked={isLocked(child)}
                    small
                    onSelect={() => void chooseCategory(root, child.id)}
                    onContextMenu={(event) => openCategoryMenu(event, child)} onMenuAt={(point) => setCategoryMenu({ category: child, point })}
                  />
                </div>
              ))}
            </div>
          )
        })}
      </div>
    )
  }

  if (status === 'loading' && !links.length && !categories.length) return <LoadingBlock label={t('nav.loading')} />
  if (status === 'error' && !links.length && !categories.length) {
    return <Empty art="folder" title={t('nav.error.generic')} description={error ?? undefined} action={<Button onClick={() => void load(true)}>{t('nav.retry')}</Button>} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-nav-app="">
      <header className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-2 sm:px-3">
        <div className="flex flex-wrap items-center gap-2">
          <IconButton label={t('nav.categories')} className="md:hidden" onClick={() => setMobileOpen(true)}><PanelLeft size={16} /></IconButton>
          {sidebarHidden && <IconButton label={t('nav.expand_sidebar')} className="hidden md:inline-flex" onClick={() => setSidebarHidden(false)}><PanelLeft size={16} /></IconButton>}
          <h1 className="min-w-0 max-w-[180px] truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{settings.display.navTitle || t('nav.title')}</h1>
          <form onSubmit={(event) => void submitSearch(event)} className="flex min-w-[240px] flex-1 flex-wrap items-center gap-1.5">
            <Segmented size="sm" value={settings.search.mode} onChange={(value) => changeMode(value as 'internal' | 'external')} options={[{ value: 'internal', label: t('nav.search.internal') }, { value: 'external', label: t('nav.search.external') }]} label={t('nav.settings.mode')} />
            {settings.search.mode === 'external' && (
              <SelectMenu
                size="sm"
                label={t('nav.search.engine')}
                value={activeSearchSource?.id ?? ''}
                options={settings.search.sources.filter((source) => source.enabled).map((source) => ({ value: source.id, label: source.name }))}
                onChange={changeEngine}
                placeholder={t('nav.search.engine')}
                className="max-w-[150px]"
              />
            )}
            <div className="relative min-w-[160px] flex-1">
              <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" />
              <Input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || isImeComposing(event)) return
                  event.preventDefault()
                  setQuery('')
                  event.currentTarget.blur()
                }}
                placeholder={activeSearchSource && settings.search.mode === 'external' ? t('nav.search.use_engine', { name: activeSearchSource.name }) : t('nav.search.placeholder')}
                aria-label={t('nav.search.placeholder')}
                className="pl-7 pr-7"
              />
              {query && <IconButton label={t('nav.search.clear')} size="xs" className="absolute right-0 top-1/2 -translate-y-1/2" onClick={() => setQuery('')}><X size={12} /></IconButton>}
            </div>
          </form>
          <SyncBadge status={sync} />
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="secondary" className="hidden sm:inline-flex" icon={<FolderCog size={14} />} onClick={() => openCategoryManager()} title={t('nav.category_manager')}><span className="hidden sm:inline">{t('nav.category_manager')}</span></Button>
            <Button size="sm" variant="secondary" className="hidden sm:inline-flex" icon={<Cloud size={14} />} onClick={() => setBackupOpen(true)} title={t('nav.backup.title')}><span className="hidden sm:inline">{t('nav.backup.title')}</span></Button>
            <Button size="sm" variant="secondary" icon={detailed ? <Rows3 size={14} /> : <LayoutGrid size={14} />} onClick={toggleCardStyle} title={t('nav.card_style')}><span className="hidden sm:inline">{detailed ? t('nav.card_switch_simple') : t('nav.card_switch_detailed')}</span></Button>
            <Button size="sm" variant="secondary" icon={<Unplug size={14} />} onClick={() => setCheckerOpen(true)} title={t('nav.checker')}><span className="hidden sm:inline">{t('nav.checker')}</span></Button>
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => openEditor()}>{t('nav.add')}</Button>
            <IconButton label={t('nav.ai.open')} active={assistantDockOpen} onClick={() => setAssistantDock(!assistantDockOpen)}><Bot size={15} /></IconButton>
            <IconButton ref={settingsAnchor} label={t('nav.settings')} onClick={() => setSettingsMenuOpen(true)}><Settings size={15} /></IconButton>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {!sidebarHidden && (
          <aside onContextMenu={(event) => { if (event.target === event.currentTarget) openCategoryMenu(event, null) }} className="hidden w-[228px] shrink-0 overflow-y-auto border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] md:block">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[length:var(--text-10-5)] font-semibold uppercase tracking-wide text-[var(--text-quaternary)]">{t('nav.categories')}</span>
              <div className="flex items-center gap-0.5">
                {expandableRoots.length > 0 && (
                  <IconButton
                    label={allRootsExpanded ? t('nav.collapse_all') : t('nav.expand_all')}
                    size="sm"
                    onClick={() => setExpanded(allRootsExpanded ? new Set() : new Set(expandableRoots.map((category) => category.id)))}
                  >
                    {allRootsExpanded ? <ChevronsUp size={13} /> : <ChevronsDown size={13} />}
                  </IconButton>
                )}
                <IconButton label={t('nav.collapse_sidebar')} size="sm" onClick={() => setSidebarHidden(true)}><ChevronRight size={13} className="rotate-180" /></IconButton>
              </div>
            </div>
            {sidebar()}
          </aside>
        )}
        <main className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-3">
          {subcategories.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1 border-b border-[var(--border-subtle)] pb-2">
              <button type="button" onClick={() => selectCategory(selectedRoot!.id, null)} className={cn('rounded-full px-2.5 py-1 text-[length:var(--text-11-5)]', !selectedSubcategory ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'bg-[var(--bg-raised)] text-[var(--text-secondary)]')}>
                {t('nav.all')}<span className="ml-1 opacity-70">{categoryCount(selectedRoot!)}</span>
              </button>
              {subcategories.map((sub) => (
                <button key={sub.id} type="button" onClick={() => void chooseCategory(selectedRoot, sub.id)} className={cn('flex items-center gap-1 rounded-full px-2.5 py-1 text-[length:var(--text-11-5)]', selectedSubcategory === sub.id ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'bg-[var(--bg-raised)] text-[var(--text-secondary)]')}>
                  <NavIcon name={sub.icon} size={12} />{sub.name}{isLocked(sub) && <Lock size={10} className="text-[var(--warning)]" />}<span className="opacity-70">{counts.byCategory[sub.id] ?? 0}</span>
                </button>
              ))}
            </div>
          )}

          {showSmart && recent.length > 0 && (
            <section className="mb-5">
              <SectionTitle icon={<History size={14} />} title={t('nav.recent')} count={recent.length} action={<span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('nav.recent_quota', { shown: recent.length, quota: settings.display.recentLinksCount })}</span>} />
              <div className={cn('grid items-start [grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr))]', detailed ? 'gap-3' : 'gap-2')}>
                {recent.map((link) => <LinkCard key={link.id} link={link} detailed={detailed} sorting={false} onOpen={(item) => void recordOpen(item)} onEdit={openEditor} onDelete={(item) => void removeLink(item)} onMenu={openMenu} onMove={() => {}} onDropOn={() => {}} />)}
              </div>
            </section>
          )}
          {showSmart && frequent.length > 0 && (
            <section className="mb-5">
              <SectionTitle icon={<TrendingUp size={14} />} title={t('nav.frequent')} count={frequent.length} action={<span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('nav.frequent_quota', { shown: frequent.length, quota: settings.display.frequentLinksCount })}</span>} />
              <div className={cn('grid items-start [grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr))]', detailed ? 'gap-3' : 'gap-2')}>
                {frequent.map(({ link, count }) => <LinkCard key={link.id} link={link} detailed={detailed} visitCount={count} sorting={false} onOpen={(item) => void recordOpen(item)} onEdit={openEditor} onDelete={(item) => void removeLink(item)} onMenu={openMenu} onMove={() => {}} onDropOn={() => {}} />)}
              </div>
            </section>
          )}

          {pinned.length > 0 && (
            <section className="mb-5">
              <SectionTitle
                icon={<Pin size={14} />}
                title={t('nav.pinned')}
                count={pinned.length}
                action={canSortPinned ? <Button size="sm" variant={sortingPinned ? 'primary' : 'ghost'} icon={<GripVertical size={13} />} onClick={() => setSortingPinned(!sortingPinned)}>{sortingPinned ? t('nav.sort_done') : t('nav.sort')}</Button> : undefined}
              />
              <div className={cn('grid items-start [grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr))]', detailed ? 'gap-3' : 'gap-2')}>
                {pinned.map((link) => <LinkCard key={link.id} link={link} detailed={detailed} sorting={sortingPinned} onOpen={(item) => void recordOpen(item)} onEdit={openEditor} onDelete={(item) => void removeLink(item)} onMenu={openMenu} onMove={(item, direction) => void moveWithin(pinned, item, direction, null)} onDropOn={(target) => dropOn(pinned, target, null)} onDragStart={(item) => setDragId(item.id)} onDragEnd={() => setDragId(null)} />)}
              </div>
            </section>
          )}

          <section>
            <SectionTitle
              icon={<List size={14} />}
              title={selectedSubcategory ? categories.find((category) => category.id === selectedSubcategory)?.name ?? t('nav.all') : selectedRoot?.name ?? t('nav.all')}
              count={normal.length}
              action={canSortNormal ? <Button size="sm" variant={sortingNormal ? 'primary' : 'ghost'} icon={<GripVertical size={13} />} onClick={() => setSortingNormal(!sortingNormal)}>{sortingNormal ? t('nav.sort_done') : t('nav.sort')}</Button> : undefined}
            />
            {normal.length === 0 && pinned.length > 0 ? (
              <p className="rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] px-3 py-5 text-center text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('nav.empty.no_more')}</p>
            ) : normal.length === 0 ? (
              <Empty art="folder" title={query.trim() ? t('nav.empty_search.title') : t('nav.empty.title')} description={query.trim() ? t('nav.empty_search.description') : t('nav.empty.description')} action={!query.trim() ? <div className="flex flex-wrap justify-center gap-2"><Button icon={<Plus size={13} />} onClick={() => openEditor()}>{t('nav.add')}</Button><Button variant="secondary" icon={<Upload size={13} />} onClick={() => setImportOpen(true)}>{t('nav.import_short')}</Button></div> : undefined} />
            ) : (
              <>
                <div className={cn('grid items-start [grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr))]', detailed ? 'gap-3' : 'gap-2')}>
                  {visibleNormal.map((link) => <LinkCard key={link.id} link={link} detailed={detailed} sorting={sortingNormal} onOpen={(item) => void recordOpen(item)} onEdit={openEditor} onDelete={(item) => void removeLink(item)} onMenu={openMenu} onMove={(item, direction) => void moveWithin(normal, item, direction, normalScopeId)} onDropOn={(target) => dropOn(normal, target, normalScopeId)} onDragStart={(item) => setDragId(item.id)} onDragEnd={() => setDragId(null)} />)}
                </div>
                {hasMoreNormal && (
                  <div ref={loadMoreRef} className="mt-3 flex justify-center">
                    <Button size="sm" variant="secondary" onClick={() => setRenderPage({ key: pageKey, limit: renderLimit + NAV_RENDER_PAGE })}>
                      {t('nav.load_more', { shown: visibleNormal.length, total: normal.length })}
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
        </main>
        {assistantDockOpen && <AssistantDock surface="nav" nav={navContext} />}
      </div>

      <Drawer open={mobileOpen} onClose={() => setMobileOpen(false)} side="left" width={300} title={t('nav.categories')}>
        {sidebar()}
      </Drawer>

      <NavLinkEditor
        open={editor.open}
        link={editor.link}
        initial={editor.initial}
        defaultCategoryId={editor.defaultCategoryId}
        onClose={() => setEditor({ open: false, link: null, initial: null })}
      />
      <CategoryManagerModal open={categoryManagerOpen} onClose={closeCategoryManager} initialEditId={categoryManagerTarget?.editId ?? null} initialParentId={categoryManagerTarget?.parentId} initialDeleteId={categoryManagerTarget?.deleteId ?? null} />
      <UnlockModal
        category={unlockCategory}
        onClose={() => {
          const locked = unlockCategory
          setUnlockCategory(null)
          if (locked && useNavStore.getState().unlockTokens[locked.id]) {
            if (locked.parentId) selectCategory(locked.parentId, locked.id)
            else selectCategory(locked.id, null)
          }
        }}
      />
      <LinkCheckerModal open={checkerOpen} onClose={() => setCheckerOpen(false)} onEditLink={(link) => { setCheckerOpen(false); openEditor(link) }} />
      <ImportExportModal open={importOpen} onClose={() => setImportOpen(false)} />
      <QrModal open={Boolean(qr)} onClose={() => setQr(null)} url={qr?.url ?? ''} title={qr?.title ?? ''} />
      <NavSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <NavBackupModal open={backupOpen} onClose={() => setBackupOpen(false)} />

      <Menu
        anchor={settingsAnchor}
        open={settingsMenuOpen}
        onClose={() => setSettingsMenuOpen(false)}
        items={[
          { id: 'categories', label: t('nav.category_manager'), icon: <FolderCog size={13} />, onSelect: () => openCategoryManager() },
          { id: 'import', label: t('nav.import_export'), icon: <Upload size={13} />, onSelect: () => setImportOpen(true) },
          { id: 'checker', label: t('nav.checker'), icon: <Unplug size={13} />, onSelect: () => setCheckerOpen(true) },
          { id: 'webdav', label: t('nav.backup.title'), icon: <Cloud size={13} />, onSelect: () => setBackupOpen(true) },
          { id: 'settings', label: t('nav.settings'), icon: <Settings size={13} />, separatorBefore: true, onSelect: () => setSettingsOpen(true) },
        ]}
        align="end"
        width={210}
        label={t('nav.settings')}
      />
      <Menu
        anchor={context.point ?? { x: 0, y: 0 }}
        open={Boolean(context.point && menuLink)}
        onClose={() => { context.close(); setMenuLink(null) }}
        items={menuItems}
        width={200}
        label={t('nav.more')}
      />
      <Menu
        anchor={categoryMenu?.point ?? { x: 0, y: 0 }}
        open={Boolean(categoryMenu)}
        onClose={() => setCategoryMenu(null)}
        items={categoryMenu ? categoryMenuItemsFor(categoryMenu.category) : []}
        width={220}
        label={t('nav.categories')}
      />
    </div>
  )
}
