/**
 * The Cloudflare container's frame: a second navigation rail and the screen it names.
 *
 * The app is a guest on the notebook's rail, so it brings its own navigation rather than borrowing
 * the notebook sidebar: ten screens is more than a sidebar section should carry, and the reader who
 * is inside Cloudflare is looking at Cloudflare's own vocabulary (DNS, Workers, R2), not at notes.
 *
 * Copy is loaded before the first screen is drawn. A reader who opens the app with a slow network
 * sees a loading state, not a screen full of dotted keys.
 */
import { useEffect, useState, type ComponentType, type ReactElement } from 'react'
import './cloudflare.css'
import {
  Boxes, Cloud, Database, Globe, LayoutDashboard, MonitorSmartphone, Settings, Sparkles, Store, Users, Waypoints,
} from 'lucide-react'
import { cn } from '../../lib/cn'
import { navigateToAddress, usePathname, useSearch } from '../../lib/app-history'
import { t, useLocale } from '../../lib/i18n'
import { LoadingBlock } from '../../components/feedback'
import { Button } from '../../components/primitives'
import {
  ensureCloudflareMessages,
  useCfT,
  useCloudflareMessagesVersion,
  cloudflareMessagesLocale,
  type CloudflareMessageKey,
} from './i18n'
import {
  parseCloudflareAddress,
  cloudflareScreenPath,
  type CloudflareScreen,
  type CloudflareAiTab,
} from './cloudflare-address'
import { DashboardScreen } from './screens/DashboardScreen'
import { AccountsScreen } from './screens/AccountsScreen'
import { DnsScreen } from './screens/DnsScreen'
import { WorkersScreen } from './screens/WorkersScreen'
import { StorageScreen } from './screens/StorageScreen'
import { TunnelsScreen } from './screens/TunnelsScreen'
import { AiScreen } from './screens/AiScreen'
import { BrowserRenderScreen } from './screens/BrowserRenderScreen'
import { StoreScreen } from './screens/StoreScreen'
import { SettingsScreen } from './screens/SettingsScreen'

interface NavItem {
  screen: CloudflareScreen
  labelKey: CloudflareMessageKey
  icon: ComponentType<{ size?: number; className?: string }>
}

const NAV_ITEMS: readonly NavItem[] = [
  { screen: 'dashboard', labelKey: 'cloudflare.dashboard.title', icon: LayoutDashboard },
  { screen: 'accounts', labelKey: 'cloudflare.accounts.title', icon: Users },
  { screen: 'dns', labelKey: 'cloudflare.dns.title', icon: Globe },
  { screen: 'workers', labelKey: 'cloudflare.workers.title', icon: Boxes },
  { screen: 'storage', labelKey: 'cloudflare.storage.title', icon: Database },
  { screen: 'tunnels', labelKey: 'cloudflare.tunnels.tunnel_management', icon: Waypoints },
  { screen: 'ai', labelKey: 'cloudflare.ai.title', icon: Sparkles },
  { screen: 'browser-render', labelKey: 'cloudflare.browser_render.title', icon: MonitorSmartphone },
  { screen: 'store', labelKey: 'cloudflare.store.title', icon: Store },
  { screen: 'settings', labelKey: 'cloudflare.settings.title', icon: Settings },
]

function NavLink({ item, active }: { item: NavItem; active: boolean }): ReactElement {
  const tcf = useCfT()
  const Icon = item.icon
  return (
    <a
      href={cloudflareScreenPath(item.screen)}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        // A modified press or a middle click belongs to the browser: let it open a new tab.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        navigateToAddress(cloudflareScreenPath(item.screen))
      }}
      className={cn(
        'flex shrink-0 items-center gap-2 rounded-[var(--r-md)] px-2 py-2 text-[length:var(--text-12)]',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]',
        active
          ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <Icon size={15} className="shrink-0" />
      <span className="truncate">{tcf(item.labelKey)}</span>
    </a>
  )
}

function Screen({ screen, aiTab }: { screen: CloudflareScreen; aiTab: CloudflareAiTab }) {
  switch (screen) {
    case 'accounts': return <AccountsScreen />
    case 'dns': return <DnsScreen />
    case 'workers': return <WorkersScreen />
    case 'storage': return <StorageScreen />
    case 'tunnels': return <TunnelsScreen />
    case 'ai': return <AiScreen tab={aiTab} />
    case 'browser-render': return <BrowserRenderScreen />
    case 'store': return <StoreScreen />
    case 'settings': return <SettingsScreen />
    default: return <DashboardScreen />
  }
}

export function CloudflareApp(): ReactElement {
  const pathname = usePathname()
  const search = useSearch()
  const locale = useLocale()
  const address = parseCloudflareAddress(pathname, search)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  // Subscribing here is what redraws the frame after the catalogue lands, including after a switch.
  useCloudflareMessagesVersion()

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    ensureCloudflareMessages(locale)
      .then(() => {
        if (cancelled) return
        setStatus(cloudflareMessagesLocale() === locale ? 'ready' : 'error')
      })
      .catch((error: unknown) => {
        console.error('[inkstone] Cloudflare copy failed to load:', error)
        if (!cancelled) setStatus('error')
      })
    return () => { cancelled = true }
  }, [locale, attempt])

  if (status === 'loading') {
    return <div className="flex h-full items-center justify-center"><LoadingBlock /></div>
  }
  if (status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">{t('common.action_failed')}</p>
        <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>{t('common.retry')}</Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)] md:flex-row">
      <nav
        aria-label={t('app.tabs.navigation')}
        className={cn(
          'flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2',
          'no-scrollbar md:w-40 md:flex-col md:overflow-visible md:border-b-0 md:border-r md:p-2',
        )}
      >
        <div className="flex items-center gap-2 px-2 pb-1 text-[length:var(--text-12)] font-semibold text-[var(--text-primary)] max-md:hidden">
          <Cloud size={15} />
          <span>{t('app.tabs.cloudflare')}</span>
        </div>
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.screen} item={item} active={address.screen === item.screen} />
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-hidden">
        <Screen screen={address.screen} aiTab={address.aiTab} />
      </div>
    </div>
  )
}
