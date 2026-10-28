import { useMemo, type ReactElement } from 'react'
import { HardDrive, Images, LayoutGrid, Settings, Shield, Upload } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { navigateToPath, usePathname } from '../../lib/app-history'
import { useSession } from '../../store/session'
import { IS_DEMO_MODE } from '../../lib/runtime'
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

export function ImgbedApp(): ReactElement {
  if (IS_DEMO_MODE) return <div className="flex h-full items-center justify-center p-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('imgbed.demo_unavailable' as never)}</div>
  const pathname = usePathname()
  const page = pageFor(pathname)
  const user = useSession((state) => state.user)
  const owner = user?.role === 'owner'
  const nav = useMemo(() => NAV.filter((item) => owner || (item.page !== 'settings' && item.page !== 'customers')), [owner])

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-imgbed-app="">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]">
            <Images size={16} />
          </span>
          <h1 className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('imgbed.title')}</h1>
        </div>
        <nav aria-label={t('imgbed.title')} className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
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
                  'inline-flex items-center gap-1.5 rounded-[var(--r-md)] px-2 py-1.5 text-[length:var(--text-12)]',
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
        <a
          href="/imgbed/browse"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-default)] px-2 py-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
        >
          <HardDrive size={14} />
          {t('imgbed.nav.public')}
        </a>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        {page === 'upload' && <UploadPage owner={owner} />}
        {page === 'library' && <LibraryPage />}
        {page === 'settings' && (owner ? <SettingsPage /> : <OwnerOnly />)}
        {page === 'customers' && (owner ? <CustomersPage /> : <OwnerOnly />)}
      </main>
    </div>
  )
}

function OwnerOnly(): ReactElement {
  return <div className="flex h-full items-center justify-center p-8 text-[length:var(--text-13)] text-[var(--text-tertiary)]">{t('imgbed.owner_only')}</div>
}
