import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Button, Spinner } from '../../components/primitives'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useNavStore } from '../nav/nav-store'
import { AdminError, AdminLoading, useAdminResource } from './shared'

const NavApp = lazy(() => import('../nav/NavApp').then((module) => ({ default: module.NavApp })))

type FriendsView = 'friends' | 'applications'

/**
 * The friend-link manager is the nav app, scoped by selecting the reserved category. Applications
 * arrive in their own reserved category; moving an edited link into the friends category approves it.
 */
export function FriendsAdminPanel() {
  const config = useAdminResource(() => api.blog.friendsConfig(), [])
  const [view, setView] = useState<FriendsView>('friends')
  const links = useNavStore((state) => state.links)
  const categories = useNavStore((state) => state.categories)

  useEffect(() => {
    if (!config.data) return
    useNavStore.getState().selectCategory(view === 'friends' ? config.data.friends.id : config.data.applications.id)
  }, [config.data, view])

  const pending = useMemo(() => {
    if (!config.data) return 0
    const ids = new Set([
      config.data.applications.id,
      ...categories.filter((category) => category.parentId === config.data!.applications.id).map((category) => category.id),
    ])
    return links.filter((link) => ids.has(link.categoryId)).length
  }, [categories, config.data, links])

  if (config.error) {
    return <div className="p-6"><AdminError message={config.error} onRetry={() => void config.reload()} /></div>
  }
  if (!config.data) return <AdminLoading />

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-[length:var(--text-12-5)] font-semibold text-[var(--text-primary)]">{t('blog.admin.friends')}</p>
          <p className="text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
            {t('blog.admin.friends_nav_hint')} {t('blog.admin.friends_approve_hint')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant={view === 'friends' ? 'primary' : 'ghost'} data-friends-view="friends" onClick={() => setView('friends')}>
            {config.data.friends.name}
          </Button>
          <Button size="sm" variant={view === 'applications' ? 'primary' : 'ghost'} data-friends-view="applications" onClick={() => setView('applications')}>
            {t('blog.admin.friends_applications')}{pending > 0 ? ` ${pending}` : ''}
          </Button>
          <a
            href="/nav"
            className="inline-flex items-center rounded-[var(--r-md)] px-2 py-1.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            {t('blog.admin.friends_open_nav')}
          </a>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
          <NavApp />
        </Suspense>
      </div>
    </div>
  )
}
