import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  Bot,
  ChevronDown,
  Mail,
  MoreHorizontal,
  PanelLeft,
  RefreshCw,
  Search,
  Settings,
  X,
} from 'lucide-react'
import type { EmailAccount, EmailSummary } from '@shared/email/model'
import { Button, IconButton } from '../../components/primitives'
import { Empty } from '../../components/feedback'
import { Input } from '../../components/form'
import { Drawer, Menu, confirm, type MenuItem } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { navigateToAddress, navigateToPath } from '../../lib/app-history'
import { useBreakpoint } from '../../lib/hooks'
import { useUi } from '../../store/ui'
import type { EmailAddress, EmailComposeMode } from './email-address'
import { emailFolderPath, emailSettingsPath } from './email-address'
import { messageSubject } from './format'
import { useEmailStore } from './store'
import { FolderSidebar } from './FolderSidebar'
import { MessageList } from './MessageList'
import { MessagePane } from './MessagePane'
import { TrashPanel } from './TrashPanel'

type MailboxAddress = Extract<EmailAddress, { kind: 'mailbox' | 'search' }>

function searchMessageAddress(accountId: string, query: string, messageId: string): { path: string; search: string } {
  return {
    path: `/email/accounts/${encodeURIComponent(accountId)}/search`,
    search: `q=${encodeURIComponent(query)}&message=${encodeURIComponent(messageId)}`,
  }
}

export function MailboxPage({ address, account }: { address: MailboxAddress; account: EmailAccount }) {
  const breakpoint = useBreakpoint()
  const desktop = breakpoint === 'desktop'
  const compact = breakpoint === 'mobile'
  const folders = useEmailStore((state) => state.folders)
  const foldersError = useEmailStore((state) => state.foldersError)
  const accounts = useEmailStore((state) => state.accounts)
  const messages = useEmailStore((state) => state.messages)
  const total = useEmailStore((state) => state.total)
  const listStatus = useEmailStore((state) => state.listStatus)
  const listError = useEmailStore((state) => state.listError)
  const listRefreshing = useEmailStore((state) => state.listRefreshing)
  const page = useEmailStore((state) => state.page)
  const selectedId = useEmailStore((state) => state.selectedId)
  const selectedMessage = useEmailStore((state) => state.selectedMessage)
  const selectedStatus = useEmailStore((state) => state.selectedStatus)
  const selectedError = useEmailStore((state) => state.selectedError)
  const thread = useEmailStore((state) => state.thread)
  const threadStatus = useEmailStore((state) => state.threadStatus)
  const threadError = useEmailStore((state) => state.threadError)
  const actionError = useEmailStore((state) => state.actionError)
  const clearActionError = useEmailStore((state) => state.clearActionError)
  const loadFolders = useEmailStore((state) => state.loadFolders)
  const createFolder = useEmailStore((state) => state.createFolder)
  const renameFolder = useEmailStore((state) => state.renameFolder)
  const deleteFolder = useEmailStore((state) => state.deleteFolder)
  const loadList = useEmailStore((state) => state.loadList)
  const searchEmails = useEmailStore((state) => state.searchEmails)
  const loadPage = useEmailStore((state) => state.loadPage)
  const refresh = useEmailStore((state) => state.refresh)
  const openMessage = useEmailStore((state) => state.openMessage)
  const clearSelection = useEmailStore((state) => state.clearSelection)
  const setRead = useEmailStore((state) => state.setRead)
  const toggleStar = useEmailStore((state) => state.toggleStar)
  const deleteMessage = useEmailStore((state) => state.deleteMessage)
  const retrySend = useEmailStore((state) => state.retrySend)
  const startPolling = useEmailStore((state) => state.startPolling)
  const stopPolling = useEmailStore((state) => state.stopPolling)

  const searchMode = address.kind === 'search'
  const folderId = address.kind === 'mailbox' ? address.folderId : null
  const query = address.kind === 'search' ? address.query : ''
  const messageId = address.messageId
  const [searchDraft, setSearchDraft] = useState(query)
  const [searchOpen, setSearchOpen] = useState(false)
  const [folderDrawer, setFolderDrawer] = useState(false)
  const [accountMenu, setAccountMenu] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const accountAnchor = useRef<HTMLButtonElement>(null)
  const moreAnchor = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setSearchDraft(query)
  }, [query])

  useEffect(() => {
    void loadFolders(account.id)
  }, [account.id, loadFolders])

  useEffect(() => {
    if (searchMode) void searchEmails(account.id, query)
    else void loadList(account.id, folderId ?? 'inbox')
  }, [account.id, folderId, query, searchMode, loadList, searchEmails])

  useEffect(() => {
    if (!messageId) {
      clearSelection()
      return
    }
    void openMessage(account.id, messageId)
  }, [account.id, messageId, openMessage, clearSelection])

  useEffect(() => {
    startPolling()
    return () => stopPolling()
  }, [startPolling, stopPolling])

  const goList = (): void => {
    if (searchMode) {
      navigateToAddress(
        `/email/accounts/${encodeURIComponent(account.id)}/search`,
        `q=${encodeURIComponent(query)}`,
      )
      return
    }
    navigateToPath(emailFolderPath(account.id, folderId ?? 'inbox'))
  }

  const openSummary = (summary: EmailSummary): void => {
    if (searchMode) {
      const target = searchMessageAddress(account.id, query, summary.id)
      navigateToAddress(target.path, target.search)
      return
    }
    navigateToAddress(
      emailFolderPath(account.id, folderId ?? summary.folderId ?? 'inbox'),
      `message=${encodeURIComponent(summary.id)}`,
    )
  }

  const submitSearch = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const trimmed = searchDraft.trim()
    if (!trimmed) return
    setSearchOpen(false)
    navigateToAddress(
      `/email/accounts/${encodeURIComponent(account.id)}/search`,
      `q=${encodeURIComponent(trimmed)}`,
    )
  }

  const clearSearch = (): void => {
    setSearchDraft('')
    if (searchMode) {
      navigateToPath(emailFolderPath(account.id, 'inbox'))
    }
  }

  const compose = (mode: EmailComposeMode): void => {
    const base = emailFolderPath(account.id, selectedMessage?.folderId ?? folderId ?? 'inbox')
    const params = new URLSearchParams({ compose: mode })
    if (messageId) params.set('message', messageId)
    navigateToAddress(base, params.toString())
  }

  const editDraft = (draftId: string): void => {
    navigateToAddress(emailFolderPath(account.id, 'draft'), `compose=new&draft=${encodeURIComponent(draftId)}`)
  }

  const cancelCompose = (): void => {
    if (messageId) {
      navigateToAddress(
        emailFolderPath(account.id, selectedMessage?.folderId ?? folderId ?? 'inbox'),
        `message=${encodeURIComponent(messageId)}`,
      )
    } else {
      goList()
    }
  }

  const removeSummary = async (summary: EmailSummary): Promise<void> => {
    const permanent = (folderId ?? summary.folderId) === 'trash'
    const ok = await confirm({
      title: t(permanent ? 'email.detail.delete_forever_title' : 'email.detail.delete_title', { subject: messageSubject(summary) }),
      description: t(permanent ? 'email.detail.delete_forever_hint' : 'email.detail.delete_hint'),
      confirmLabel: t(permanent ? 'email.detail.delete_forever' : 'email.detail.delete'),
      tone: 'danger',
    })
    if (!ok) return
    const removed = await deleteMessage(account.id, summary.id, permanent)
    if (removed && selectedId === summary.id) goList()
  }

  const retry = async (summary: EmailSummary): Promise<void> => {
    const sent = await retrySend(account.id, summary.id)
    if (sent) useUi.getState().toast({ title: t('email.list.retry_sent'), tone: 'success' })
  }

  const removeFolder = async (id: string): Promise<void> => {
    await deleteFolder(account.id, id)
    if (folderId === id) navigateToPath(emailFolderPath(account.id, 'inbox'))
  }

  const refreshNow = (): void => {
    void refresh()
  }

  const accountItems: MenuItem[] = [
    ...accounts.map((entry) => ({
      id: entry.id,
      label: entry.displayName || entry.address,
      icon: <Mail size={14} />,
      checked: entry.id === account.id,
      onSelect: () => navigateToPath(emailFolderPath(entry.id, 'inbox')),
    })),
    {
      id: 'settings',
      label: t('email.header.settings'),
      icon: <Settings size={14} />,
      separatorBefore: true,
      onSelect: () => navigateToPath(emailSettingsPath(account.id)),
    },
    {
      id: 'home',
      label: t('email.header.all_accounts'),
      icon: <Mail size={14} />,
      onSelect: () => navigateToPath('/email'),
    },
  ]

  const moreItems: MenuItem[] = [
    { id: 'refresh', label: t('email.header.refresh'), icon: <RefreshCw size={14} />, onSelect: refreshNow },
    { id: 'ai', label: t('email.header.ai'), icon: <Bot size={14} />, onSelect: () => setAiOpen(true) },
    { id: 'settings', label: t('email.header.settings'), icon: <Settings size={14} />, onSelect: () => navigateToPath(emailSettingsPath(account.id)) },
    { id: 'accounts', label: t('email.header.all_accounts'), icon: <Mail size={14} />, separatorBefore: true, onSelect: () => navigateToPath('/email') },
  ]

  const searchField = (
    <form role="search" onSubmit={submitSearch} className="flex min-w-0 items-center gap-1">
      <Input
        value={searchDraft}
        onChange={(event) => setSearchDraft(event.target.value)}
        placeholder={t('email.search.placeholder')}
        aria-label={t('email.search.placeholder')}
        leading={<Search size={12} />}
        className="h-9 w-44 lg:w-64"
      />
      {searchDraft && (
        <IconButton label={t('email.search.clear')} size="xs" onClick={clearSearch}>
          <X size={13} />
        </IconButton>
      )}
    </form>
  )

  const header = (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 md:px-3">
      {!desktop && messageId && (
        <IconButton label={t('email.header.back')} size="sm" className="size-11 md:size-8" onClick={goList}>
          <ArrowLeft size={16} />
        </IconButton>
      )}
      {!desktop && !messageId && (
        <IconButton label={t('email.header.folders')} size="sm" className="size-11 md:size-8" onClick={() => setFolderDrawer(true)}>
          <PanelLeft size={16} />
        </IconButton>
      )}
      <button
        ref={accountAnchor}
        type="button"
        onClick={() => setAccountMenu((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={accountMenu}
        className="flex min-w-0 max-w-56 items-center gap-1 rounded-[var(--r-md)] px-1.5 py-1 text-left hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
      >
        <span className="min-w-0 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {account.displayName || account.address}
        </span>
        <ChevronDown size={12} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
      </button>
      {compact ? (
        searchOpen ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <form role="search" onSubmit={submitSearch} className="flex min-w-0 flex-1 items-center gap-1">
              <Input
                autoFocus
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder={t('email.search.placeholder')}
                aria-label={t('email.search.placeholder')}
                leading={<Search size={12} />}
                className="h-9 w-full"
              />
              {searchDraft && (
                <IconButton label={t('email.search.clear')} size="xs" onClick={clearSearch}>
                  <X size={13} />
                </IconButton>
              )}
            </form>
            <IconButton label={t('common.close')} size="sm" className="size-11" onClick={() => setSearchOpen(false)}>
              <X size={16} />
            </IconButton>
          </div>
        ) : (
          <div className="ml-auto flex items-center gap-0.5">
            <IconButton label={t('email.header.search')} size="sm" className="size-11" onClick={() => setSearchOpen(true)}>
              <Search size={16} />
            </IconButton>
            <IconButton
              ref={moreAnchor}
              label={t('email.header.more')}
              size="sm"
              className="size-11"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <MoreHorizontal size={16} />
            </IconButton>
          </div>
        )
      ) : (
        <div className="ml-auto flex min-w-0 items-center gap-1">
          {searchField}
          <IconButton label={t('email.header.refresh')} size="sm" className="size-11 md:size-7" onClick={refreshNow} disabled={listRefreshing}>
            <RefreshCw size={15} className={listRefreshing ? 'animate-[ink-spin_0.7s_linear_infinite]' : undefined} />
          </IconButton>
          <IconButton label={t('email.header.ai')} size="sm" className="size-11 md:size-7" active={aiOpen} onClick={() => setAiOpen((open) => !open)}>
            <Bot size={15} />
          </IconButton>
          <IconButton label={t('email.header.settings')} size="sm" className="size-11 md:size-7" onClick={() => navigateToPath(emailSettingsPath(account.id))}>
            <Settings size={15} />
          </IconButton>
        </div>
      )}
      <Menu
        anchor={accountAnchor}
        open={accountMenu}
        onClose={() => setAccountMenu(false)}
        items={accountItems}
        align="start"
        width={240}
        label={t('email.a11y.account_menu')}
      />
      {compact && (
        <Menu
          anchor={moreAnchor}
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          items={moreItems}
          align="end"
          width={200}
          label={t('email.header.more')}
        />
      )}
    </header>
  )

  const folderSidebar = (
    <FolderSidebar
      folders={folders}
      activeFolderId={folderId}
      onSelect={(id) => navigateToPath(emailFolderPath(account.id, id))}
      onCreate={(name) => createFolder(account.id, name)}
      onRename={(id, name) => renameFolder(account.id, id, name)}
      onDelete={removeFolder}
      onClose={() => setFolderDrawer(false)}
    />
  )

  const listPane = (
    <MessageList
      messages={messages}
      total={total}
      status={listStatus}
      error={listError}
      page={page}
      refreshing={listRefreshing}
      searchMode={searchMode}
      query={query}
      folderId={folderId}
      folders={folders}
      selectedId={selectedId}
      onOpen={openSummary}
      onToggleStar={(summary) => { void toggleStar(account.id, summary.id) }}
      onToggleRead={(summary) => { void setRead(account.id, summary.id, !summary.read) }}
      onDelete={(summary) => { void removeSummary(summary) }}
      onRetry={(summary) => { void retry(summary) }}
      onPage={(next) => { void loadPage(next) }}
      onReload={() => {
        if (searchMode) void searchEmails(account.id, query, page)
        else void loadList(account.id, folderId ?? 'inbox', page)
      }}
      onManageTrash={() => setTrashOpen(true)}
    />
  )

  const pane = (
    <MessagePane
      account={account}
      folderId={folderId}
      summary={selectedMessage}
      thread={thread}
      threadStatus={threadStatus}
      threadError={threadError}
      selectedStatus={selectedStatus}
      selectedError={selectedError}
      folders={folders}
      compose={address.kind === 'mailbox' ? address.compose : null}
      draftId={address.kind === 'mailbox' ? address.draftId : null}
      onCompose={compose}
      onEditDraft={editDraft}
      onCancelCompose={cancelCompose}
      onClosed={goList}
      onReload={() => { if (messageId) void openMessage(account.id, messageId) }}
    />
  )

  const alerts = (
    <>
      {actionError && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--danger-soft)] px-3 py-1.5 text-[length:var(--text-11)] text-[var(--danger)]">
          <span className="min-w-0 flex-1">{actionError}</span>
          <IconButton label={t('common.close')} size="xs" onClick={clearActionError}>
            <X size={12} />
          </IconButton>
        </div>
      )}
      {foldersError && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-raised)] px-3 py-1.5 text-[length:var(--text-11)] text-[var(--warning)]">
          <span className="min-w-0 flex-1">{foldersError}</span>
          <Button size="sm" variant="ghost" onClick={() => { void loadFolders(account.id) }}>{t('common.retry')}</Button>
        </div>
      )}
    </>
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      {header}
      {alerts}
      {desktop ? (
        <div className="flex min-h-0 flex-1">
          <aside className="w-[232px] shrink-0 border-r border-[var(--border-subtle)]">
            {folderSidebar}
          </aside>
          <div className="flex w-[380px] min-w-[360px] max-w-[420px] shrink-0 flex-col border-r border-[var(--border-subtle)]">
            {listPane}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">{pane}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {messageId || (address.kind === 'mailbox' && address.compose) ? pane : listPane}
        </div>
      )}
      <Drawer
        open={folderDrawer}
        onClose={() => setFolderDrawer(false)}
        side="left"
        width={280}
        title={t('email.header.folders')}
      >
        {folderSidebar}
      </Drawer>
      <Drawer
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        side="right"
        width={360}
        title={t('email.ai.title')}
      >
        <Empty art="notes" title={t('email.ai.title')} description={t('email.ai.hint')} />
      </Drawer>
      <TrashPanel open={trashOpen} accountId={account.id} onClose={() => setTrashOpen(false)} />
    </div>
  )
}
