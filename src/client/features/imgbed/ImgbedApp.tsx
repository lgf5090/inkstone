import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Bot, HardDrive, Images, LayoutGrid, Settings, Shield, Upload } from 'lucide-react'
import type { AssistantPageContext } from '@shared/assistant'
import type { MessageKey } from '@shared/locales/en-US'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { navigateToPath, usePathname } from '../../lib/app-history'
import { IconButton } from '../../components/primitives'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { AssistantDock } from '../chat/AssistantDock'
import { UploadPage } from './upload/UploadPage'
import { LibraryPage } from './library/LibraryPage'
import { SettingsPage } from './settings/SettingsPage'
import { CustomersPage } from './customers/CustomersPage'

type ImgbedPage = 'upload' | 'library' | 'settings' | 'customers'

function pageFor(pathname: string): ImgbedPage {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  if (path === '/imgbed/dashboard') return 'library'
  if (path === '/imgbed/settings') return 'settings'
  if (path === '/imgbed/customers') return 'customers'
  return 'upload'
}

const NAV: readonly { page: ImgbedPage; path: string; labelKey: MessageKey; icon: typeof Upload }[] = [
  { page: 'upload', path: '/imgbed', labelKey: 'imgbed.nav.upload', icon: Upload },
  { page: 'library', path: '/imgbed/dashboard', labelKey: 'imgbed.nav.library', icon: LayoutGrid },
  { page: 'settings', path: '/imgbed/settings', labelKey: 'imgbed.nav.settings', icon: Settings },
  { page: 'customers', path: '/imgbed/customers', labelKey: 'imgbed.nav.customers', icon: Shield },
]

const PAGE_LABEL_KEYS: Record<ImgbedPage, MessageKey> = {
  upload: 'imgbed.nav.upload',
  library: 'imgbed.nav.library',
  settings: 'imgbed.nav.settings',
  customers: 'imgbed.nav.customers',
}

export function ImgbedApp(): ReactElement {
  if (IS_DEMO_MODE) return <div className="flex h-full items-center justify-center p-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('imgbed.demo_unavailable' as never)}</div>
  const pathname = usePathname()
  const page = pageFor(pathname)
  const user = useSession((state) => state.user)
  const owner = user?.role === 'owner'
  const nav = useMemo(() => NAV.filter((item) => owner || (item.page !== 'settings' && item.page !== 'customers')), [owner])
  const dockOpen = useUi((state) => state.assistantDockOpen)
  const setAssistantDock = useUi((state) => state.setAssistantDock)
  // The library is the only page that can say what its filters are; every other page describes itself.
  // Held here rather than in the library because the dock is mounted once for the whole app, so leaving
  // the library must not leave its filter facts on screen.
  const [libraryContext, setLibraryContext] = useState<AssistantPageContext | null>(null)
  useEffect(() => {
    if (page !== 'library') setLibraryContext(null)
  }, [page])
  const pageContext = useMemo<AssistantPageContext>(() => libraryContext ?? {
    surface: 'imgbed',
    label: t(PAGE_LABEL_KEYS[page]),
    facts: [`page: ${page}`],
  }, [libraryContext, page])

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-imgbed-app="">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]">
            <Images size={16} />
          </span>
          <h1 className="hidden truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)] sm:block">{t('imgbed.title')}</h1>
        </div>
        <nav aria-label={t('imgbed.title')} className="flex min-w-0 flex-1 flex-nowrap items-center gap-0.5 overflow-x-auto [scrollbar-width:none] sm:gap-1">
          {nav.map((item) => {
            const Icon = item.icon
            const active = item.page === page
            return (
              <a
                key={item.page}
                href={item.path}
                aria-current={active ? 'page' : undefined}
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                  event.preventDefault()
                  navigateToPath(item.path)
                }}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-md)] px-1.5 py-1.5 text-[length:var(--text-12)] sm:px-2',
                  'transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
                  active ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                <Icon size={14} />
                {t(item.labelKey)}
              </a>
            )
          })}
        </nav>
        <IconButton
          label={t('assistant.dock.title')}
          active={dockOpen}
          onClick={() => setAssistantDock(!dockOpen)}
        >
          <Bot size={15} />
        </IconButton>
        <a
          href="/imgbed/browse"
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-default)] px-2 py-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]" aria-label={t('imgbed.nav.public')}
        >
          <HardDrive size={14} />
          <span className="hidden sm:inline">{t('imgbed.nav.public')}</span>
        </a>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">
          {page === 'upload' && <UploadPage owner={owner} />}
          {page === 'library' && <LibraryPage onContextChange={setLibraryContext} />}
          {page === 'settings' && (owner ? <SettingsPage /> : <OwnerOnly />)}
          {page === 'customers' && (owner ? <CustomersPage /> : <OwnerOnly />)}
        </main>
        {dockOpen && <AssistantDock surface="imgbed" pageContext={pageContext} />}
      </div>
    </div>
  )
}

function OwnerOnly(): ReactElement {
  return <div className="flex h-full items-center justify-center p-8 text-[length:var(--text-13)] text-[var(--text-tertiary)]">{t('imgbed.owner_only')}</div>
}
