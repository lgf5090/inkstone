import { useEffect, useState } from 'react'
import './styles/github.css'
import { t } from '../../../lib/i18n'
import { LoadingBlock, Empty } from '../../../components/feedback'
import { Button } from '../../../components/primitives'
import { useGithubStore } from './store'
import { loadCurrentMirrorId, saveCurrentMirrorId } from './prefs'
import { DEFAULT_GITHUB_MIRRORS } from '@shared/development/github/types'
import type { GithubTab } from './components/ModuleTabs'
import { AccountsDialog } from './components/AccountsView'
import { MirrorDialog } from './components/MirrorDialog'
import { ReposPane } from './components/ReposPane'
import { GistsPane } from './components/GistsPane'

export function GithubApp() {
  const status = useGithubStore((state) => state.status)
  const error = useGithubStore((state) => state.error)
  const load = useGithubStore((state) => state.load)
  const mirrors = useGithubStore((state) => state.mirrors)
  const accounts = useGithubStore((state) => state.accounts)
  const activeAccountId = useGithubStore((state) => state.activeAccountId)
  const setActiveAccount = useGithubStore((state) => state.setActiveAccount)
  const addAccount = useGithubStore((state) => state.addAccount)
  const deleteAccount = useGithubStore((state) => state.deleteAccount)
  const saveMirrors = useGithubStore((state) => state.saveMirrors)
  const [tab, setTab] = useState<GithubTab>('repos')
  const [accountsOpen, setAccountsOpen] = useState(false)
  const [mirrorsOpen, setMirrorsOpen] = useState(false)
  const [currentMirrorId, setCurrentMirrorId] = useState(loadCurrentMirrorId)

  useEffect(() => {
    void load()
  }, [load])

  const normalizedMirrors = mirrors.length > 0 ? mirrors : DEFAULT_GITHUB_MIRRORS
  const currentMirror = normalizedMirrors.find((mirror) => mirror.id === currentMirrorId && mirror.enabled)
    ?? normalizedMirrors.find((mirror) => mirror.enabled)
    ?? normalizedMirrors[0]

  const changeMirror = (id: string) => {
    setCurrentMirrorId(id)
    saveCurrentMirrorId(id)
  }

  if (status === 'loading' || status === 'idle') return <LoadingBlock label={t('development.github.common.loading')} />

  if (status === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty
          art="search"
          title={t('development.github.common.load_failed')}
          description={error ?? undefined}
          action={<Button size="sm" onClick={() => void load()}>{t('development.github.common.retry')}</Button>}
        />
      </div>
    )
  }

  const shared = {
    tab,
    onTabChange: setTab,
    onOpenAccounts: () => setAccountsOpen(true),
    onOpenMirrors: () => setMirrorsOpen(true),
    currentMirrorId: currentMirror?.id ?? '',
    onCurrentMirrorChange: changeMirror,
  }

  return (
    <div data-testid="github-app-root" className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]">
      <div data-testid="github-tab-repos" className={tab === 'repos' ? 'contents' : 'hidden'}>
        <ReposPane {...shared} />
      </div>
      <div data-testid="github-tab-gists" className={tab === 'gists' ? 'contents' : 'hidden'}>
        <GistsPane tab={tab} onTabChange={setTab} onOpenAccounts={shared.onOpenAccounts} onOpenMirrors={shared.onOpenMirrors} currentMirrorId={shared.currentMirrorId} />
      </div>
      <AccountsDialog
        open={accountsOpen}
        onClose={() => setAccountsOpen(false)}
        accounts={accounts}
        activeAccountId={activeAccountId}
        onSetActive={setActiveAccount}
        onAdd={addAccount}
        onDelete={async (id) => { await deleteAccount(id) }}
      />
      <MirrorDialog
        open={mirrorsOpen}
        onClose={() => setMirrorsOpen(false)}
        mirrors={normalizedMirrors}
        currentMirrorId={currentMirror?.id ?? ''}
        onSave={(next) => void saveMirrors(next)}
        onCurrentChange={changeMirror}
      />
    </div>
  )
}
