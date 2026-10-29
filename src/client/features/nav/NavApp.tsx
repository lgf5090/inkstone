import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ChevronRight, Cloud,
  Copy, ExternalLink, FolderCog, GripVertical, History, LayoutGrid, List, Lock,
  MoreHorizontal, PanelLeft, Pencil, Pin, Plus, QrCode, Rows3, Search, Settings,
  Trash2, TrendingUp, Unplug, Upload, X,
} from 'lucide-react'
import { compileQuery, queryMatches } from '../../lib/query-match'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { copyText } from '../../lib/clipboard'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { Button, Badge, IconButton } from '../../components/primitives'
import { Input, Segmented } from '../../components/form'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Drawer, Menu, confirm, useContextMenu, type MenuItem } from '../../components/overlay'
import { SelectMenu } from '../../components/select-menu'
import { useUi } from '../../store/ui'
import {
  avatarColor, buildSearchUrl, initialFor, isHttpUrl, linkMatchesQuery,
  type NavCategory, type NavLink,
} from '@shared/nav/model'
import { useNavStore } from './nav-store'
import { NavIcon } from './nav-icons'
import { NavLinkEditor } from './NavLinkEditor'
import { NavSettingsModal, NavBackupModal } from './NavSettings'
import { CategoryManagerModal, UnlockModal } from './NavCategories'
import { LinkCheckerModal } from './NavChecker'
import { ImportExportModal, QrModal } from './NavImport'

function matches(link: NavLink, query: string): boolean {
  const text = query.trim()
  if (!text) return true
  const compiled = compileQuery(text)
  if (compiled.error) return true
  if (compiled.pattern) {
    compiled.pattern.lastIndex = 0
    return compiled.pattern.test(link.title) || compiled.pattern.test(link.description ?? '') || compiled.pattern.test(link.url)
  }
  return queryMatches(compiled, link.title) !== null || linkMatchesQuery(link, text)
}

function LinkIcon({ link, size = 40 }: { link: NavLink; size?: number }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [link.icon])
  if (link.icon && !failed) {
    return (
      <span className="flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--r-md)] bg-[var(--bg-inset)]" style={{ width: size, height: size }}>
        <img src={link.icon} alt="" width={size * 0.7} height={size * 0.7} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="object-contain" onError={() => setFailed(true)} />
      </span>
    )
  }
  return (
    <span className={cn('flex shrink-0 items-center justify-center rounded-[var(--r-md)] font-semibold', avatarColor(link.title || link.url))} style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden>
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
}

function LinkCard({ link, detailed, visitCount, sorting, onOpen, onEdit, onDelete, onMenu, onMove, onDropOn, onDragStart }: CardProps) {
  const titleId = `nav-title-${link.id}`
  const anchorProps = isHttpUrl(link.url)
    ? { href: link.url, target: '_blank', rel: 'noopener noreferrer' }
    : { href: link.url }
  return (
    <article
      className={cn('group relative flex min-w-0 flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5 transition-colors hover:border-[var(--border-default)] hover:bg-[var(--bg-raised)]', detailed ? 'min-h-[92px]' : 'min-h-[52px]')}
      onContextMenu={(event) => { event.preventDefault(); onMenu(link, { x: event.clientX, y: event.clientY }) }}
      onDragOver={(event) => { if (sorting) event.preventDefault() }}
      onDrop={(event) => { if (sorting) { event.preventDefault(); onDropOn(link) } }}
    >
      <a {...anchorProps} aria-labelledby={titleId} className="absolute inset-0 z-0 rounded-[var(--r-md)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => onOpen(link)} onAuxClick={(event) => { if (event.button === 1) onOpen(link) }} />
      <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-2.5">
        <LinkIcon link={link} size={detailed ? 36 : 30} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span id={titleId} className={cn('min-w-0 truncate font-medium text-[var(--text-primary)]', detailed ? 'text-[length:var(--text-13)]' : 'text-[length:var(--text-12)]')}>{link.title}</span>
            {link.pinned && <Pin size={11} className="shrink-0 text-[var(--warning)]" aria-label={t('nav.pinned')} />}
          </div>
          {detailed && <p className="mt-0.5 line-clamp-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{link.description || link.url}</p>}
          {!detailed && <p className="truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{link.url}</p>}
          {typeof visitCount === 'number' && visitCount > 0 && <Badge tone="neutral" className="mt-0.5 w-fit whitespace-nowrap">{t('nav.visit_count', { count: visitCount })}</Badge>}
        </div>
        <div className="pointer-events-auto absolute right-1 top-1 z-20 flex items-center gap-0.5 rounded-[var(--r-sm)] bg-[var(--bg-surface)]/90 p-0.5 opacity-100 shadow-sm backdrop-blur-sm [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100">
          {sorting ? (
            <>
              <IconButton label={t('nav.move_up')} onClick={() => onMove(link, -1)}><ArrowUp size={13} /></IconButton>
              <IconButton label={t('nav.move_down')} onClick={() => onMove(link, 1)}><ArrowDown size={13} /></IconButton>
            </>
          ) : (
            <>
              <IconButton label={t('nav.edit')} onClick={() => onEdit(link)}><Pencil size={13} /></IconButton>
              <IconButton label={t('nav.delete')} onClick={() => onDelete(link)}><Trash2 size={13} /></IconButton>
            </>
          )}
          <IconButton label={t('nav.more')} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onMenu(link, { x: rect.right, y: rect.bottom }) }}><MoreHorizontal size={14} /></IconButton>
        </div>
      </div>
      {sorting && (
        <div className="pointer-events-auto relative z-10 flex items-center gap-1 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
          <button
            type="button"
            draggable
            aria-label={`${t('nav.sort')}: ${link.title}`}
            onDragStart={(event) => { event.dataTransfer.setData('text/plain', link.id); onDragStart?.(link) }}
            className="inline-flex cursor-grab items-center gap-1 rounded-[var(--r-xs)] px-1 py-0.5 hover:bg-[var(--bg-hover)]"
          >
            <GripVertical size={12} /> {t('nav.sort')}
          </button>
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
}

function CategoryRow({ label, icon, count, active, locked, small, expanded, hasChildren, onSelect, onToggle }: CategoryRowProps) {
  return (
    <div className={cn('flex items-center gap-0.5 rounded-[var(--r-sm)]', active ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
      {!small && (
        <span className="flex size-7 shrink-0 items-center justify-center">
          {hasChildren ? (
            <button type="button" onClick={onToggle} aria-label={expanded ? t('nav.collapse_sidebar') : t('nav.expand_sidebar')} aria-expanded={expanded} className="flex size-7 items-center justify-center rounded-[var(--r-xs)] hover:bg-[var(--bg-active)]">
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          ) : null}
        </span>
      )}
      <button type="button" onClick={onSelect} aria-current={active ? 'page' : undefined} className={cn('flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1 text-left', small ? 'pl-2 text-[length:var(--text-11-5)]' : 'text-[length:var(--text-12)]')}>
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
  const load = useNavStore((state) => state.load)
  const setQuery = useNavStore((state) => state.setQuery)
  const selectCategory = useNavStore((state) => state.selectCategory)
  const saveDisplay = useNavStore((state) => state.saveDisplay)
  const saveSearch = useNavStore((state) => state.saveSearch)
  const updateLink = useNavStore((state) => state.updateLink)
  const deleteLink = useNavStore((state) => state.deleteLink)
  const reorderLinks = useNavStore((state) => state.reorderLinks)
  const toast = useUi((state) => state.toast)
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    if (typeof window === 'undefined') return false
    try { return window.localStorage.getItem('inkstone.nav.sidebarHidden') === '1' } catch { return false }
  })
  const [mobileOpen, setMobileOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editor, setEditor] = useState<{ open: boolean; link: NavLink | null; initial: { title: string; url: string } | null; defaultCategoryId?: string }>({ open: false, link: null, initial: null })
  const [unlockCategory, setUnlockCategory] = useState<NavCategory | null>(null)
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false)
  const [checkerOpen, setCheckerOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [qr, setQr] = useState<{ url: string; title: string } | null>(null)
  const [sortingPinned, setSortingPinned] = useState(false)
  const [sortingNormal, setSortingNormal] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [menuLink, setMenuLink] = useState<NavLink | null>(null)
  const context = useContextMenu()
  const settingsAnchor = useRef<HTMLButtonElement>(null)

  useEffect(() => { void load() }, [load])
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

  const selectedRoot = categories.find((category) => category.id === selectedCategory && !category.parentId) ?? null
  const subcategories = useMemo(() => selectedRoot ? categories.filter((category) => category.parentId === selectedRoot.id).sort((a, b) => a.sortOrder - b.sortOrder) : [], [categories, selectedRoot])
  const scopedLinks = useMemo(() => {
    let scoped = links
    if (selectedSubcategory) scoped = links.filter((link) => link.categoryId === selectedSubcategory)
    else if (selectedCategory) {
      const scope = new Set([selectedCategory, ...categories.filter((category) => category.parentId === selectedCategory).map((category) => category.id)])
      scoped = links.filter((link) => scope.has(link.categoryId))
    }
    return scoped.filter((link) => matches(link, query))
  }, [links, selectedCategory, selectedSubcategory, categories, query])
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
  const normal = useMemo(() => scopedLinks.filter((link) => !link.pinned).sort((a, b) => a.sortOrder - b.sortOrder), [scopedLinks])
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

  async function chooseCategory(category: NavCategory | null, subcategory: string | null = null): Promise<void> {
    setMobileOpen(false)
    if (category && isLocked(category)) {
      setUnlockCategory(category)
      return
    }
    if (category && !category.parentId) {
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
      <div className="flex flex-col gap-0.5 p-2">
        <CategoryRow label={t('nav.all')} icon="layout-grid" count={counts.total} active={!selectedCategory} locked={false} onSelect={() => void chooseCategory(null)} />
        {categories.filter((category) => !category.parentId).sort((a, b) => a.sortOrder - b.sortOrder).map((root) => {
          const children = categories.filter((category) => category.parentId === root.id).sort((a, b) => a.sortOrder - b.sortOrder)
          const open = expanded.has(root.id)
          return (
            <div key={root.id}>
              <CategoryRow
                label={root.name}
                icon={root.icon}
                count={categoryCount(root)}
                active={selectedCategory === root.id && !selectedSubcategory}
                locked={isLocked(root)}
                hasChildren={children.length > 0}
                expanded={open}
                onToggle={() => setExpanded((current) => { const next = new Set(current); if (next.has(root.id)) next.delete(root.id); else next.add(root.id); return next })}
                onSelect={() => void chooseCategory(root)}
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
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={activeSearchSource && settings.search.mode === 'external' ? t('nav.search.use_engine', { name: activeSearchSource.name }) : t('nav.search.placeholder')}
                aria-label={t('nav.search.placeholder')}
                className="pl-7 pr-7"
              />
              {query && <IconButton label={t('nav.search.clear')} size="xs" className="absolute right-0 top-1/2 -translate-y-1/2" onClick={() => setQuery('')}><X size={12} /></IconButton>}
            </div>
          </form>
          <SyncBadge status={sync} />
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="secondary" icon={<FolderCog size={14} />} onClick={() => setCategoryManagerOpen(true)} title={t('nav.category_manager')}><span className="hidden sm:inline">{t('nav.category_manager')}</span></Button>
            <Button size="sm" variant="secondary" icon={<Cloud size={14} />} onClick={() => setBackupOpen(true)} title={t('nav.webdav')}><span className="hidden sm:inline">{t('nav.webdav')}</span></Button>
            <Button size="sm" variant="secondary" icon={detailed ? <Rows3 size={14} /> : <LayoutGrid size={14} />} onClick={toggleCardStyle} title={t('nav.card_style')}><span className="hidden sm:inline">{detailed ? t('nav.card_detailed') : t('nav.card_simple')}</span></Button>
            <Button size="sm" variant="secondary" icon={<Unplug size={14} />} onClick={() => setCheckerOpen(true)} title={t('nav.checker')}><span className="hidden sm:inline">{t('nav.checker')}</span></Button>
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => openEditor()}>{t('nav.add')}</Button>
            <IconButton ref={settingsAnchor} label={t('nav.settings')} onClick={() => setSettingsMenuOpen(true)}><Settings size={15} /></IconButton>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {!sidebarHidden && (
          <aside className="hidden w-[228px] shrink-0 overflow-y-auto border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] md:block">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[length:var(--text-10-5)] font-semibold uppercase tracking-wide text-[var(--text-quaternary)]">{t('nav.categories')}</span>
              <IconButton label={t('nav.collapse_sidebar')} size="sm" onClick={() => setSidebarHidden(true)}><ChevronRight size={13} className="rotate-180" /></IconButton>
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
            <section className="mb-4">
              <SectionTitle icon={<History size={14} />} title={t('nav.recent')} count={recent.length} action={<span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('nav.recent_quota', { shown: recent.length, quota: settings.display.recentLinksCount })}</span>} />
              <div className={cn('grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,200px),1fr))]', detailed ? 'gap-2' : 'gap-1.5')}>
                {recent.map((link) => <LinkCard key={link.id} link={link} detailed={detailed} sorting={false} onOpen={(item) => void recordOpen(item)} onEdit={openEditor} onDelete={(item) => void removeLink(item)} onMenu={openMenu} onMove={() => {}} onDropOn={() => {}} />)}
              </div>
            </section>
          )}
          {showSmart && frequent.length > 0 && (
            <section className="mb-4">
              <SectionTitle icon={<TrendingUp size={14} />} title={t('nav.frequent')} count={frequent.length} action={<span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('nav.frequent_quota', { shown: frequent.length, quota: settings.display.frequentLinksCount })}</span>} />
              <div className={cn('grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,200px),1fr))]', detailed ? 'gap-2' : 'gap-1.5')}>
                {frequent.map(({ link, count }) => <LinkCard key={link.id} link={link} detailed={detailed} visitCount={count} sorting={false} onOpen={(item) => void recordOpen(item)} onEdit={openEditor} onDelete={(item) => void removeLink(item)} onMenu={openMenu} onMove={() => {}} onDropOn={() => {}} />)}
              </div>
            </section>
          )}

          {pinned.length > 0 && (
            <section className="mb-4">
              <SectionTitle
                icon={<Pin size={14} />}
                title={t('nav.pinned')}
                count={pinned.length}
                action={canSortPinned ? <Button size="sm" variant={sortingPinned ? 'primary' : 'ghost'} icon={<GripVertical size={13} />} onClick={() => setSortingPinned(!sortingPinned)}>{sortingPinned ? t('nav.sort_done') : t('nav.sort')}</Button> : undefined}
              />
              <div className={cn('grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,200px),1fr))]', detailed ? 'gap-2' : 'gap-1.5')}>
                {pinned.map((link) => <LinkCard key={link.id} link={link} detailed={detailed} sorting={sortingPinned} onOpen={(item) => void recordOpen(item)} onEdit={openEditor} onDelete={(item) => void removeLink(item)} onMenu={openMenu} onMove={(item, direction) => void moveWithin(pinned, item, direction, null)} onDropOn={(target) => dropOn(pinned, target, null)} onDragStart={(item) => setDragId(item.id)} />)}
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
            {normal.length === 0 ? (
              <Empty art="folder" title={query.trim() ? t('nav.empty_search.title') : t('nav.empty.title')} description={query.trim() ? t('nav.empty_search.description') : t('nav.empty.description')} action={!query.trim() ? <Button icon={<Plus size={13} />} onClick={() => openEditor()}>{t('nav.add')}</Button> : undefined} />
            ) : (
              <div className={cn('grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,200px),1fr))]', detailed ? 'gap-2' : 'gap-1.5')}>
                {normal.map((link) => <LinkCard key={link.id} link={link} detailed={detailed} sorting={sortingNormal} onOpen={(item) => void recordOpen(item)} onEdit={openEditor} onDelete={(item) => void removeLink(item)} onMenu={openMenu} onMove={(item, direction) => void moveWithin(normal, item, direction, normalScopeId)} onDropOn={(target) => dropOn(normal, target, normalScopeId)} onDragStart={(item) => setDragId(item.id)} />)}
              </div>
            )}
          </section>
        </main>
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
      <CategoryManagerModal open={categoryManagerOpen} onClose={() => setCategoryManagerOpen(false)} />
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
          { id: 'categories', label: t('nav.category_manager'), icon: <FolderCog size={13} />, onSelect: () => setCategoryManagerOpen(true) },
          { id: 'import', label: t('nav.import_export'), icon: <Upload size={13} />, onSelect: () => setImportOpen(true) },
          { id: 'checker', label: t('nav.checker'), icon: <Unplug size={13} />, onSelect: () => setCheckerOpen(true) },
          { id: 'webdav', label: t('nav.webdav'), icon: <Cloud size={13} />, onSelect: () => setBackupOpen(true) },
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
    </div>
  )
}
