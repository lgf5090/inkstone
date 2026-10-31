import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import {
  CalendarDays,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  FileText,
  Files,
  Image as ImageIcon,
  LayoutDashboard,
  Layers,
  Link2,
  Menu as MenuIcon,
  Newspaper,
  MessageSquare,
  PanelsTopLeft,
  Plus,
  Settings,
  Tags,
  Upload,
  UserRound,
  Wrench,
} from 'lucide-react'
import { Avatar, IconButton, SectionLabel, Spinner } from '../../components/primitives'
import { Drawer } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { navigateToPath, usePathname } from '../../lib/app-history'
import { useSession } from '../../store/session'
import { useAdminResource } from './shared'
import { DashboardPanel } from './DashboardPanel'
import { CalendarPanel } from './CalendarPanel'
import { PostsPanel } from './PostsPanel'
import { MediaPanel } from './MediaPanel'
import { CommentsPanel } from './CommentsPanel'
import { PagesPanel } from './PagesPanel'
import { TaxonomyPanel } from './TaxonomyPanel'
import { CollectionsPanel } from './CollectionsPanel'
import { MenusPanel } from './MenusPanel'
import { WidgetsPanel } from './WidgetsPanel'
import { RedirectsPanel } from './RedirectsPanel'
import { ToolsPanel } from './ToolsPanel'
import { ImportExportPanel } from './ImportExportPanel'
import { AccountPanel } from './AccountPanel'
import { SettingsPanel } from './SettingsPanel'
import { FriendsAdminPanel } from './FriendsAdminPanel'

const PostEditor = lazy(() => import('./PostEditor').then((module) => ({ default: module.PostEditor })))
const PageEditor = lazy(() => import('./PageEditor').then((module) => ({ default: module.PageEditor })))

type NavId =
  | 'dashboard' | 'calendar' | 'posts' | 'pages' | 'media'
  | 'comments' | 'categories' | 'tags' | 'series' | 'friends' | 'moments' | 'albums' | 'collections'
  | 'menus' | 'widgets' | 'redirects' | 'tools' | 'import' | 'account' | 'settings'

interface NavItem {
  id: NavId
  path: string
  label: MessageKey
  icon: typeof LayoutDashboard
}

const CONTENT_NAV: NavItem[] = [
  { id: 'posts', path: '/blog-admin/posts', label: 'blog.admin.posts', icon: FileText },
  { id: 'pages', path: '/blog-admin/pages', label: 'blog.admin.pages', icon: Files },
  { id: 'media', path: '/blog-admin/media', label: 'blog.admin.media', icon: ImageIcon },
]

const MANAGE_NAV: NavItem[] = [
  { id: 'comments', path: '/blog-admin/comments', label: 'blog.admin.comments', icon: MessageSquare },
  { id: 'categories', path: '/blog-admin/categories', label: 'blog.admin.categories', icon: Tags },
  { id: 'tags', path: '/blog-admin/tags', label: 'blog.admin.tags', icon: Tags },
  { id: 'series', path: '/blog-admin/series', label: 'blog.admin.series', icon: Layers },
  { id: 'friends', path: '/blog-admin/friends', label: 'blog.admin.friends', icon: Link2 },
  { id: 'moments', path: '/blog-admin/moments', label: 'blog.admin.moments', icon: PanelsTopLeft },
  { id: 'albums', path: '/blog-admin/albums', label: 'blog.admin.albums', icon: ImageIcon },
  { id: 'collections', path: '/blog-admin/collections/moments', label: 'blog.admin.collections', icon: Layers },
  { id: 'menus', path: '/blog-admin/menus', label: 'blog.admin.menus', icon: MenuIcon },
  { id: 'widgets', path: '/blog-admin/widgets', label: 'blog.admin.widgets', icon: PanelsTopLeft },
  { id: 'redirects', path: '/blog-admin/redirects', label: 'blog.admin.redirects', icon: Link2 },
]

const ADMIN_NAV: NavItem[] = [
  { id: 'tools', path: '/blog-admin/tools', label: 'blog.admin.tools', icon: Wrench },
  { id: 'import', path: '/blog-admin/import', label: 'blog.admin.import_export', icon: Upload },
  { id: 'account', path: '/blog-admin/account', label: 'blog.admin.account', icon: UserRound },
  { id: 'settings', path: '/blog-admin/settings', label: 'blog.admin.settings', icon: Settings },
]

const ALL_NAV = [
  { id: 'dashboard', path: '/blog-admin', label: 'blog.admin.dashboard', icon: LayoutDashboard } as NavItem,
  { id: 'calendar', path: '/blog-admin/calendar', label: 'blog.admin.calendar', icon: CalendarDays } as NavItem,
  ...CONTENT_NAV,
  ...MANAGE_NAV,
  ...ADMIN_NAV,
]

function activeNav(pathname: string): NavId {
  const clean = pathname.replace(/\/+$/, '') || '/blog-admin'
  if (clean === '/blog-admin') return 'dashboard'
  const rest = clean.slice('/blog-admin/'.length).split('/')
  const first = rest[0]
  if (first === 'posts') return 'posts'
  if (first === 'pages') return 'pages'
  if (first === 'media') return 'media'
  if (first === 'comments') return 'comments'
  if (first === 'categories' || first === 'tags' || first === 'series') return first
  if (first === 'friends') return 'friends'
  if (first === 'moments') return 'moments'
  if (first === 'albums') return 'albums'
  if (first === 'collections') return rest[1] === 'friends' ? 'friends' : 'collections'
  if (first === 'menus') return 'menus'
  if (first === 'widgets') return 'widgets'
  if (first === 'redirects') return 'redirects'
  if (first === 'tools') return 'tools'
  if (first === 'import') return 'import'
  if (first === 'account') return 'account'
  if (first === 'settings') return 'settings'
  if (first === 'calendar') return 'calendar'
  return 'dashboard'
}

function NavLink({ item, active, badge }: { item: NavItem; active: boolean; badge?: number }) {
  const Icon = item.icon
  return (
    <a
      href={item.path}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        navigateToPath(item.path)
      }}
      className={active
        ? 'flex items-center gap-2.5 rounded-[var(--r-md)] bg-[var(--accent-soft)] px-2.5 py-1.5 text-[length:var(--text-12-5)] font-medium text-[var(--accent-on-soft)]'
        : 'flex items-center gap-2.5 rounded-[var(--r-md)] px-2.5 py-1.5 text-[length:var(--text-12-5)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}
    >
      <Icon size={15} aria-hidden="true" className="shrink-0 opacity-80" />
      <span className="min-w-0 flex-1 truncate">{t(item.label)}</span>
      {badge !== undefined && badge > 0 && (
        <span className="shrink-0 rounded-full bg-[var(--warning-soft)] px-1.5 text-[length:var(--text-10-5)] tabular text-[var(--warning)]">{badge}</span>
      )}
    </a>
  )
}

function SidebarBody({
  active,
  siteTitle,
  blogUrl,
  pendingComments,
  onNavigate,
}: {
  active: NavId
  siteTitle: string
  blogUrl: string
  pendingComments: number
  onNavigate?: () => void
}) {
  const groups: { label: MessageKey | null; items: NavItem[] }[] = [
    { label: null, items: [ALL_NAV[0], ALL_NAV[1]] },
    { label: 'blog.admin.group_content', items: CONTENT_NAV },
    { label: 'blog.admin.group_manage', items: MANAGE_NAV },
    { label: 'blog.admin.group_admin', items: ADMIN_NAV },
  ]
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-3">
        <span aria-hidden="true" className="grid size-7 place-items-center rounded-[var(--r-md)] bg-[var(--accent)] text-[var(--accent-contrast)]"><Newspaper size={15} /></span>
        <div className="min-w-0">
          <p className="truncate text-[length:var(--text-12-5)] font-semibold text-[var(--text-primary)]">{siteTitle || t('blog.admin.title')}</p>
          <p className="truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('blog.admin.workspace')}</p>
        </div>
      </div>
      <nav aria-label={t('blog.admin.navigation')} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.map((group) => (
          <div key={group.label ?? 'primary'} className="mb-3">
            {group.label && <SectionLabel className="px-2.5">{t(group.label)}</SectionLabel>}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <div key={item.id} onClick={onNavigate}>
                  <NavLink item={item} active={active === item.id} badge={item.id === 'comments' ? pendingComments : undefined} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="shrink-0 border-t border-[var(--border-subtle)] p-2">
        {blogUrl ? (
          <a
            href={blogUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-[var(--r-md)] px-2.5 py-1.5 text-[length:var(--text-12)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
          >
            <ExternalLink size={14} aria-hidden="true" />
            {t('blog.admin.open_blog')}
          </a>
        ) : (
          <span className="flex items-center gap-2 px-2.5 py-1.5 text-[length:var(--text-12)] text-[var(--text-quaternary)]">
            <ExternalLink size={14} aria-hidden="true" />
            {t('blog.admin.open_blog')}
          </span>
        )}
        <a
          href="/blog-admin/account"
          onClick={(event) => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return
            event.preventDefault()
            navigateToPath('/blog-admin/account')
            onNavigate?.()
          }}
          className="mt-1 flex items-center gap-2 rounded-[var(--r-md)] px-2.5 py-1.5 text-[length:var(--text-12)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <CircleHelp size={14} aria-hidden="true" />
          {t('blog.admin.account')}
        </a>
      </div>
    </div>
  )
}

export function BlogAdminApp() {
  const pathname = usePathname()
  const status = useSession((state) => state.status)
  const role = useSession((state) => state.user?.role)
  const user = useSession((state) => state.user)
  const active = activeNav(pathname)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const settings = useAdminResource(() => api.blog.settings.get(), [])
  const overview = useAdminResource(() => api.blog.overview(), [])

  useEffect(() => {
    setDrawerOpen(false)
  }, [pathname])

  if (status !== 'authed') {
    return <div className="flex h-full items-center justify-center"><Spinner /></div>
  }
  if (role !== 'owner') {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-[var(--text-tertiary)]">{t('blog.admin.forbidden')}</div>
  }

  const site = settings.data?.site as { title?: string; url?: string } | undefined
  const siteTitle = typeof site?.title === 'string' ? site.title : ''
  const blogUrl = typeof site?.url === 'string' ? site.url : ''
  const pendingComments = overview.data?.commentsPending ?? 0
  const clean = pathname.replace(/\/+$/, '') || '/blog-admin'

  return (
    <div className="flex h-full min-h-0 bg-[var(--bg-base)]">
      <aside className="hidden w-60 shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] md:block">
        <SidebarBody
          active={active}
          siteTitle={siteTitle}
          blogUrl={blogUrl}
          pendingComments={pendingComments}
        />
      </aside>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} side="left" width={264} ariaLabel={t('blog.admin.navigation')}>
        <SidebarBody
          active={active}
          siteTitle={siteTitle}
          blogUrl={blogUrl}
          pendingComments={pendingComments}
          onNavigate={() => setDrawerOpen(false)}
        />
      </Drawer>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 md:px-4">
          <IconButton className="md:hidden" label={t('blog.admin.navigation')} onClick={() => setDrawerOpen(true)}>
            <MenuIcon size={17} />
          </IconButton>
          <div className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            <span className="hidden sm:inline">{siteTitle || t('blog.admin.title')}</span>
            <ChevronRight size={12} aria-hidden="true" className="hidden sm:inline" />
            <span className="truncate font-medium text-[var(--text-primary)]">{t(navLabel(active))}</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {blogUrl && (
              <a
                href={blogUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden items-center gap-1.5 rounded-[var(--r-md)] px-2 py-1.5 text-[length:var(--text-12)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] sm:inline-flex"
              >
                <ExternalLink size={13} aria-hidden="true" />
                {t('blog.admin.live_view')}
              </a>
            )}
            <a
              href="/blog-admin/posts/new"
              onClick={(event) => {
                if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return
                event.preventDefault()
                navigateToPath('/blog-admin/posts/new')
              }}
              className="hidden items-center gap-1 rounded-[var(--r-md)] bg-[var(--accent)] px-2.5 py-1.5 text-[length:var(--text-12)] font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-hover)] sm:inline-flex"
            >
              <Plus size={13} aria-hidden="true" />
              {t('blog.admin.new_post')}
            </a>
            <a
              href="/blog-admin/account"
              onClick={(event) => {
                if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return
                event.preventDefault()
                navigateToPath('/blog-admin/account')
              }}
              aria-label={t('blog.admin.account')}
              className="inline-flex size-8 items-center justify-center rounded-full"
            >
              <Avatar name={user?.name || user?.username || 'Owner'} src={user?.avatarUrl ?? undefined} size={26} />
            </a>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-hidden">
          <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
            <AdminRoute pathname={clean} onReloadOverview={overview.reload} settings={settings.data} siteTitle={siteTitle} blogUrl={blogUrl} onSettingsSaved={settings.reload} />
          </Suspense>
        </main>
      </div>
    </div>
  )
}

function navLabel(id: NavId): MessageKey {
  return ALL_NAV.find((item) => item.id === id)?.label ?? 'blog.admin.dashboard'
}

function AdminRoute({
  pathname,
  onReloadOverview,
  settings,
  siteTitle,
  blogUrl,
  onSettingsSaved,
}: {
  pathname: string
  onReloadOverview: () => Promise<void>
  settings: import('@shared/blog/settings').BlogSettings | null
  siteTitle: string
  blogUrl: string
  onSettingsSaved: () => Promise<void>
}) {
  if (pathname === '/blog-admin') {
    return <Scroll><DashboardPanel siteTitle={siteTitle} blogUrl={blogUrl} /></Scroll>
  }
  if (pathname === '/blog-admin/calendar') return <Scroll><CalendarPanel /></Scroll>
  if (pathname === '/blog-admin/posts') return <Scroll><PostsPanel onReloadOverview={onReloadOverview} /></Scroll>
  if (pathname === '/blog-admin/posts/new') return <NewPostRoute type="post" />
  if (pathname.startsWith('/blog-admin/posts/')) {
    return <PostEditor noteId={decodeURIComponent(pathname.slice('/blog-admin/posts/'.length))} />
  }
  if (pathname === '/blog-admin/pages') return <Scroll><PagesPanel /></Scroll>
  if (pathname === '/blog-admin/pages/new') return <NewPostRoute type="page" />
  if (pathname.startsWith('/blog-admin/pages/note/')) {
    return <PageEditor identifier={`note:${decodeURIComponent(pathname.slice('/blog-admin/pages/note/'.length))}`} />
  }
  if (pathname.startsWith('/blog-admin/pages/')) {
    return <PageEditor identifier={decodeURIComponent(pathname.slice('/blog-admin/pages/'.length))} />
  }
  if (pathname === '/blog-admin/media') return <Scroll><MediaPanel /></Scroll>
  if (pathname === '/blog-admin/comments') return <Scroll><CommentsPanel /></Scroll>
  if (pathname === '/blog-admin/categories') return <Scroll><TaxonomyPanel initialKind="categories" /></Scroll>
  if (pathname === '/blog-admin/tags') return <Scroll><TaxonomyPanel initialKind="tags" /></Scroll>
  if (pathname === '/blog-admin/series') return <Scroll><TaxonomyPanel initialKind="series" /></Scroll>
  if (pathname === '/blog-admin/friends' || pathname === '/blog-admin/collections/friends') return <FriendsAdminPanel />
  if (pathname === '/blog-admin/moments') return <Scroll><CollectionsPanel kind="moments" /></Scroll>
  if (pathname === '/blog-admin/albums') return <Scroll><CollectionsPanel kind="albums" /></Scroll>
  if (pathname.startsWith('/blog-admin/collections/')) {
    const kind = pathname.slice('/blog-admin/collections/'.length).split('/')[0]
    return <Scroll><CollectionsPanel kind={kind} /></Scroll>
  }
  if (pathname === '/blog-admin/menus') return <Scroll><MenusPanel /></Scroll>
  if (pathname === '/blog-admin/widgets') return <Scroll><WidgetsPanel /></Scroll>
  if (pathname === '/blog-admin/redirects') return <Scroll><RedirectsPanel /></Scroll>
  if (pathname === '/blog-admin/tools') return <Scroll><ToolsPanel /></Scroll>
  if (pathname === '/blog-admin/import') return <Scroll><ImportExportPanel /></Scroll>
  if (pathname === '/blog-admin/account') return <Scroll><AccountPanel /></Scroll>
  if (pathname === '/blog-admin/settings') {
    return <Scroll><SettingsPanel settings={settings} onSaved={onSettingsSaved} /></Scroll>
  }
  return <Scroll><DashboardPanel siteTitle={siteTitle} blogUrl={blogUrl} /></Scroll>
}

function Scroll({ children }: { children: ReactNode }) {
  return <div className="h-full overflow-y-auto p-4 md:p-6">{children}</div>
}

function NewPostRoute({ type }: { type: 'post' | 'page' }) {
  const [error, setError] = useState('')
  const created = useRef<Promise<string | null> | null>(null)
  useEffect(() => {
    if (!created.current) {
      created.current = import('../blog/publish').then(({ createBlogDraft }) =>
        createBlogDraft(type, t(type === 'page' ? 'blog.admin.untitled_page' : 'blog.admin.untitled_post')),
      )
    }
    let cancelled = false
    void created.current.then((id) => {
      if (cancelled) return
      if (!id) {
        setError(t('blog.admin.create_failed'))
        return
      }
      navigateToPath(type === 'page' ? `/blog-admin/pages/note/${encodeURIComponent(id)}` : `/blog-admin/posts/${encodeURIComponent(id)}`)
    })
    return () => {
      cancelled = true
    }
  }, [type])
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      {error ? <p role="alert" className="text-[length:var(--text-12-5)] text-[var(--danger)]">{error}</p> : <Spinner />}
    </div>
  )
}
