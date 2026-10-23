import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  Bookmark,
  Bot,
  PanelLeft,
  Paperclip,
  RefreshCw,
  Search,
  Settings,
  X,
} from 'lucide-react'
import type { EmailAccount, EmailBatchAction, EmailSummary, EmailTag } from '@shared/email/model'
import { MAX_EMAIL_CONTEXT_SNIPPET, type EmailAssistantContext } from '@shared/email/assistant-context'
import { parseEmailSearchQuery } from '@shared/email/search'
import { Button, IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { Drawer, confirm, prompt } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { navigateToAddress, navigateToPath } from '../../lib/app-history'
import { useBreakpoint } from '../../lib/hooks'
import { DEFAULT_LAYOUT, PANEL_WIDTHS, useUi } from '../../store/ui'
import { Resizer } from '../shell/Resizer'
import { useAssistant } from '../chat/assistant-store'
import { AssistantDock } from '../chat/AssistantDock'
import { useAssistantToolRefresh } from '../chat/tool-refresh'
import type { EmailAddress, EmailComposeMode } from './email-address'
import { emailFolderPath, emailSearchPath, emailSettingsPath } from './email-address'
import { attachEmailTagToMessage, emailTagSearchQuery, reportEmailFailure } from './email-org'
import { emailErrorText } from './errors'
import { useEmailShortcuts } from './email-shortcuts'
import { messageSubject } from './format'
import { useEmailStore } from './store'
import { FolderSidebar, FolderSidebarRail } from './FolderSidebar'
import { EmailAccountCard } from './AccountCard'
import { MessageBatchBar } from './MessageBatchBar'
import { MessageList } from './MessageList'
import { MessagePane } from './MessagePane'
import { TrashPanel } from './TrashPanel'

type MailboxAddress = Extract<EmailAddress, { kind: 'mailbox' | 'search' }>

const EMAIL_WRITE_TOOLS = new Set([
  'email_draft_reply',
  'email_draft',
  'email_mark_read',
  'email_move',
  'email_discard_draft',
])

const NAV_RAIL_WIDTH = 48

function searchMessageAddress(accountId: string, query: string, messageId: string): { path: string; search: string } {
  return {
    path: `/email/accounts/${encodeURIComponent(accountId)}/search`,
    search: `q=${encodeURIComponent(query)}&message=${encodeURIComponent(messageId)}`,
  }
}

export function MailboxPage({ address, account }: { address: MailboxAddress; account: EmailAccount }) {
  const breakpoint = useBreakpoint()
  const desktop = breakpoint === 'desktop'
  const folders = useEmailStore((state) => state.folders)
  const foldersError = useEmailStore((state) => state.foldersError)
  const tags = useEmailStore((state) => state.tags)
  const tagsStatus = useEmailStore((state) => state.tagsStatus)
  const tagsError = useEmailStore((state) => state.tagsError)
  const searches = useEmailStore((state) => state.searches)
  const searchesStatus = useEmailStore((state) => state.searchesStatus)
  const searchesError = useEmailStore((state) => state.searchesError)
  const accounts = useEmailStore((state) => state.accounts)
  const messages = useEmailStore((state) => state.messages)
  const total = useEmailStore((state) => state.total)
  const listStatus = useEmailStore((state) => state.listStatus)
  const listError = useEmailStore((state) => state.listError)
  const listRefreshing = useEmailStore((state) => state.listRefreshing)
  const page = useEmailStore((state) => state.page)
  const focusFilter = useEmailStore((state) => state.focusFilter)
  const setFocusFilter = useEmailStore((state) => state.setFocusFilter)
  const selectedId = useEmailStore((state) => state.selectedId)
  const selectedMessage = useEmailStore((state) => state.selectedMessage)
  const selectedStatus = useEmailStore((state) => state.selectedStatus)
  const selectedError = useEmailStore((state) => state.selectedError)
  const thread = useEmailStore((state) => state.thread)
  const threadStatus = useEmailStore((state) => state.threadStatus)
  const threadError = useEmailStore((state) => state.threadError)
  const selectedIds = useEmailStore((state) => state.selectedIds)
  const actionError = useEmailStore((state) => state.actionError)
  const clearActionError = useEmailStore((state) => state.clearActionError)
  const loadFolders = useEmailStore((state) => state.loadFolders)
  const loadTags = useEmailStore((state) => state.loadTags)
  const loadSearches = useEmailStore((state) => state.loadSearches)
  const createSearch = useEmailStore((state) => state.createSearch)
  const renameSearch = useEmailStore((state) => state.renameSearch)
  const deleteSearch = useEmailStore((state) => state.deleteSearch)
  const createFolder = useEmailStore((state) => state.createFolder)
  const renameFolder = useEmailStore((state) => state.renameFolder)
  const updateFolder = useEmailStore((state) => state.updateFolder)
  const deleteFolder = useEmailStore((state) => state.deleteFolder)
  const loadList = useEmailStore((state) => state.loadList)
  const searchEmails = useEmailStore((state) => state.searchEmails)
  const loadPage = useEmailStore((state) => state.loadPage)
  const refresh = useEmailStore((state) => state.refresh)
  const openMessage = useEmailStore((state) => state.openMessage)
  const clearOpenMessage = useEmailStore((state) => state.clearOpenMessage)
  const toggleSelected = useEmailStore((state) => state.toggleSelected)
  const selectRange = useEmailStore((state) => state.selectRange)
  const selectAll = useEmailStore((state) => state.selectAll)
  const clearSelection = useEmailStore((state) => state.clearSelection)
  const batchEmails = useEmailStore((state) => state.batchEmails)
  const setRead = useEmailStore((state) => state.setRead)
  const toggleStar = useEmailStore((state) => state.toggleStar)
  const moveMessage = useEmailStore((state) => state.moveMessage)
  const deleteMessage = useEmailStore((state) => state.deleteMessage)
  const snoozeMessage = useEmailStore((state) => state.snoozeMessage)
  const retrySend = useEmailStore((state) => state.retrySend)
  const startPolling = useEmailStore((state) => state.startPolling)
  const stopPolling = useEmailStore((state) => state.stopPolling)

  const searchMode = address.kind === 'search'
  const folderId = address.kind === 'mailbox' ? address.folderId : null
  const query = address.kind === 'search' ? address.query : ''
  const parsedQuery = searchMode ? parseEmailSearchQuery(query) : null
  const activeTagName = parsedQuery?.tag ?? null
  const activeSystemSearch = parsedQuery?.important === true
    ? 'important' as const
    : parsedQuery?.followUp === true
      ? 'followup' as const
      : null
  const messageId = address.messageId
  const [searchDraft, setSearchDraft] = useState(query)
  const [folderDrawer, setFolderDrawer] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const railWidth = breakpoint === 'mobile' ? 48 : 56
  const assistantDockOpen = useUi((state) => state.assistantDockOpen)
  const navCollapsed = useUi((state) => state.emailNavCollapsed)
  const navWidth = useUi((state) => state.emailNavWidth)
  const toggleNav = useUi((state) => state.toggleEmailNav)
  const setLayout = useUi((state) => state.setLayout)
  const lastAssistantEmail = useRef<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const emailContext = useMemo<EmailAssistantContext>(() => ({
    accountId: account.id,
    address: account.address,
    folderId,
    messageId: selectedMessage?.id ?? null,
    threadId: selectedMessage?.threadId ?? null,
    subject: selectedMessage?.subject ?? null,
    sender: selectedMessage?.sender ?? null,
    recipient: selectedMessage?.recipient ?? null,
    date: selectedMessage?.date ?? null,
    snippet: selectedMessage?.snippet?.slice(0, MAX_EMAIL_CONTEXT_SNIPPET) ?? null,
    threadCount: selectedMessage?.threadCount ?? (thread.length || null),
  }), [account.address, account.id, folderId, selectedMessage, thread.length])

  useEffect(() => {
    if (desktop) setFolderDrawer(false)
  }, [desktop])

  useEffect(() => {
    setSearchDraft(query)
  }, [query])

  useEffect(() => {
    void loadFolders(account.id)
  }, [account.id, loadFolders])

  useEffect(() => {
    void loadTags(account.id)
  }, [account.id, loadTags])

  useEffect(() => {
    void loadSearches(account.id)
  }, [account.id, loadSearches])

  useEffect(() => {
    setFocusFilter('all')
    if (searchMode) void searchEmails(account.id, query)
    else void loadList(account.id, folderId ?? 'inbox')
  }, [account.id, folderId, query, searchMode, loadList, searchEmails, setFocusFilter])

  useEffect(() => {
    if (!messageId) {
      clearOpenMessage()
      return
    }
    void openMessage(account.id, messageId)
  }, [account.id, messageId, openMessage, clearOpenMessage])

  useEffect(() => {
    clearSelection()
  }, [account.id, folderId, query, clearSelection])

  useEffect(() => {
    startPolling()
    return () => stopPolling()
  }, [startPolling, stopPolling])

  useEffect(() => {
    const key = `${account.id}|${folderId ?? ''}|${selectedMessage?.id ?? ''}`
    if (lastAssistantEmail.current === key) return
    lastAssistantEmail.current = key
    useAssistant.getState().setEmailContextOn(true)
  }, [account.id, folderId, selectedMessage?.id])

  useAssistantToolRefresh(EMAIL_WRITE_TOOLS, refresh)

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

  const snooze = async (messageId: string, until: string): Promise<boolean> => {
    const snoozed = await snoozeMessage(account.id, messageId, until)
    if (snoozed) useUi.getState().toast({ title: t('email.snooze.done'), tone: 'success' })
    return snoozed
  }

  const removeFolder = async (id: string): Promise<void> => {
    await deleteFolder(account.id, id)
    if (folderId === id) navigateToPath(emailFolderPath(account.id, 'inbox'))
  }

  const selectFolder = (id: string): void => {
    setFolderDrawer(false)
    if (id === 'trash') {
      setTrashOpen(true)
      return
    }
    navigateToPath(emailFolderPath(account.id, id))
  }

  const openSearch = (searchQuery: string): void => {
    setFolderDrawer(false)
    const target = emailSearchPath(account.id, searchQuery)
    const cut = target.indexOf('?')
    navigateToAddress(cut < 0 ? target : target.slice(0, cut), cut < 0 ? '' : target.slice(cut + 1))
  }

  const selectTag = (name: string): void => {
    openSearch(emailTagSearchQuery(name))
  }

  const saveCurrentSearch = async (): Promise<void> => {
    if (!searchMode) return
    const raw = query.trim()
    if (!raw) return
    const name = await prompt({
      title: t('email.saved_search.save_title'),
      description: t('email.saved_search.save_hint'),
      defaultValue: query,
      placeholder: query,
      confirmLabel: t('email.saved_search.save'),
    })
    if (name === null) return
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      await createSearch(account.id, trimmed, query)
      useUi.getState().toast({ title: t('email.saved_search.saved'), tone: 'success' })
    } catch (reason) {
      reportEmailFailure(reason)
    }
  }

  const moveTo = (summary: EmailSummary, folderIdTo: string): void => {
    void moveMessage(account.id, summary.id, folderIdTo)
  }

  const archive = (summary: EmailSummary): void => {
    moveTo(summary, 'archive')
  }

  const selectMessage = (summary: EmailSummary, modifiers: { shiftKey: boolean }): void => {
    if (modifiers.shiftKey) selectRange(summary.id)
    else toggleSelected(summary.id)
  }

  const selectPageMessages = (selected: boolean): void => {
    selectAll(messages.map((message) => message.id), selected)
  }

  const runBatch = (action: EmailBatchAction, folderIdTo?: string): Promise<boolean> =>
    batchEmails(account.id, action, folderIdTo)

  const tagMessage = async (summary: EmailSummary, tag: EmailTag): Promise<void> => {
    try {
      await attachEmailTagToMessage(account.id, summary.id, tag.id)
    } catch (error) {
      reportEmailFailure(error)
    }
  }

  const dropMessagesOnFolder = async (targetFolderId: string, emailIds: string[]): Promise<void> => {
    const ids = [...new Set(emailIds)]
    if (ids.length === 0) return
    if (targetFolderId === 'draft' || targetFolderId === 'sent') {
      useUi.getState().toast({ title: t('email.drag.reject'), tone: 'danger' })
      return
    }
    const action: EmailBatchAction = targetFolderId === 'trash'
      ? 'trash'
      : targetFolderId === 'archive'
        ? 'archive'
        : 'move'
    const moved = await batchEmails(account.id, action, action === 'move' ? targetFolderId : undefined, ids)
    if (!moved) {
      useUi.getState().toast({
        title: t('email.toast.failed'),
        description: useEmailStore.getState().actionError ?? undefined,
        tone: 'danger',
      })
      return
    }
    clearSelection()
  }

  const dropMessagesOnTag = async (tag: EmailTag, emailIds: string[]): Promise<void> => {
    const ids = [...new Set(emailIds)]
    if (ids.length === 0) return
    const results = await Promise.allSettled(ids.map((id) => api.email.attachTag(account.id, id, { tagId: tag.id })))
    await loadTags(account.id, { silent: true })
    await refresh()
    clearSelection()
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) {
      useUi.getState().toast({
        title: t('email.toast.failed'),
        description: emailErrorText(failure.reason),
        tone: 'danger',
      })
    }
  }

  const refreshNow = (): void => {
    void refresh()
  }

  const composing = address.kind === 'mailbox' && address.compose !== null
  const selectedSummaries = messages.filter((summary) => selectedIds.has(summary.id))

  const archiveShortcut = (): void => {
    if (selectedIds.size > 0) {
      void runBatch('archive')
      return
    }
    if (selectedMessage) archive(selectedMessage)
  }

  const trashShortcut = async (): Promise<void> => {
    if (selectedIds.size > 0) {
      const ok = await confirm({
        title: t('email.batch.delete_title'),
        description: t('email.batch.delete_hint'),
        confirmLabel: t('email.detail.delete'),
        tone: 'danger',
      })
      if (ok) await runBatch('trash')
      return
    }
    if (selectedMessage) await removeSummary(selectedMessage)
  }

  const toggleReadShortcut = (): void => {
    if (selectedIds.size > 0) {
      const allRead = selectedSummaries.length > 0 && selectedSummaries.every((summary) => summary.read)
      void runBatch(allRead ? 'unread' : 'read')
      return
    }
    if (selectedMessage) void setRead(account.id, selectedMessage.id, !selectedMessage.read)
  }

  const toggleStarShortcut = (): void => {
    if (selectedIds.size > 0) {
      const allStarred = selectedSummaries.length > 0 && selectedSummaries.every((summary) => summary.starred)
      void runBatch(allStarred ? 'unstar' : 'star')
      return
    }
    if (selectedMessage) void toggleStar(account.id, selectedMessage.id)
  }

  const focusSearch = (): void => {
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }

  useEmailShortcuts({
    composeNew: () => compose('new'),
    reply: (mode) => compose(mode),
    canCompose: () => !composing,
    canReply: () => !composing && messageId !== null && selectedMessage !== null,
    archive: archiveShortcut,
    trash: () => { void trashShortcut() },
    toggleRead: toggleReadShortcut,
    toggleStar: toggleStarShortcut,
    focusSearch,
    goInbox: () => navigateToPath(emailFolderPath(account.id, 'inbox')),
  })

  const paneTools = (
    <>
      <IconButton label={t('attachments.manage')} size="sm" className="size-11 md:size-7" onClick={() => useUi.getState().setAttachmentHub('email')}>
        <Paperclip size={15} />
      </IconButton>
      <IconButton
        label={t('email.header.ai')}
        size="sm"
        className="size-11 md:size-7"
        active={assistantDockOpen}
        onClick={() => useUi.getState().setAssistantDock(!assistantDockOpen)}
      >
        <Bot size={15} />
      </IconButton>
      <IconButton label={t('email.header.settings')} size="sm" className="size-11 md:size-7" onClick={() => navigateToPath(emailSettingsPath(account.id))}>
        <Settings size={15} />
      </IconButton>
    </>
  )

  const searchField = (
    <form role="search" onSubmit={submitSearch} className="flex min-w-0 flex-1 items-center">
      <div className="min-w-0 flex-1">
        <Input
          ref={searchInputRef}
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
          placeholder={t('email.search.placeholder')}
          aria-label={t('email.search.placeholder')}
          leading={<Search size={12} />}
          trailing={searchDraft
            ? (
                <IconButton label={t('email.search.clear')} size="xs" onClick={clearSearch}>
                  <X size={12} />
                </IconButton>
              )
            : null}
          className="h-9 w-full"
        />
      </div>
    </form>
  )

  const listToolbar = (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2">
      {!desktop && (
        <IconButton label={t('email.header.folders')} size="sm" className="size-9" onClick={() => setFolderDrawer(true)}>
          <PanelLeft size={16} />
        </IconButton>
      )}
      {searchField}
      <IconButton
        label={t('email.saved_search.save_action')}
        size="sm"
        className="size-9"
        disabled={!searchMode}
        onClick={() => { void saveCurrentSearch() }}
      >
        <Bookmark size={15} />
      </IconButton>
      <IconButton label={t('email.header.refresh')} size="sm" className="size-9" onClick={refreshNow} disabled={listRefreshing}>
        <RefreshCw size={15} className={listRefreshing ? 'animate-[ink-spin_0.7s_linear_infinite]' : undefined} />
      </IconButton>
    </div>
  )

  const folderSidebar = (compactCard = false) => (
    <FolderSidebar
      accountId={account.id}
      folders={folders}
      activeFolderId={folderId}
      activeSystemSearch={activeSystemSearch}
      onSelectSystemSearch={openSearch}
      onSelect={selectFolder}
      onCreate={(name, parentId) => createFolder(account.id, name, parentId)}
      onRename={(id, name) => renameFolder(account.id, id, name)}
      onColor={(id, color) => updateFolder(account.id, id, { color })}
      onMove={(id, parentId) => updateFolder(account.id, id, { parentId })}
      onDelete={removeFolder}
      onDropMessages={(targetFolderId, emailIds) => { void dropMessagesOnFolder(targetFolderId, emailIds) }}
      onDropTagMessages={(tag, emailIds) => { void dropMessagesOnTag(tag, emailIds) }}
      tags={tags}
      tagsStatus={tagsStatus}
      tagsError={tagsError}
      activeTagName={activeTagName}
      onSelectTag={selectTag}
      onReloadTags={() => loadTags(account.id)}
      searches={searches}
      searchesStatus={searchesStatus}
      searchesError={searchesError}
      activeSearchQuery={searchMode ? query : null}
      onSelectSearch={openSearch}
      onSaveCurrentSearch={() => { void saveCurrentSearch() }}
      onRenameSearch={(searchId, name) => renameSearch(account.id, searchId, name)}
      onDeleteSearch={(searchId) => deleteSearch(account.id, searchId)}
      onReloadSearches={() => loadSearches(account.id)}
      onClose={() => setFolderDrawer(false)}
      onCollapse={desktop ? toggleNav : undefined}
      footer={<EmailAccountCard accounts={accounts} activeAccountId={account.id} compact={compactCard} onNavigate={() => setFolderDrawer(false)} />}
    />
  )

  const listPane = (
    <div className="relative flex h-full min-h-0 flex-col">
      {listToolbar}
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
      tags={tags}
      selectedId={selectedId}
      selectedIds={selectedIds}
      dragEnabled={!composing}
      focusFilter={focusFilter}
      focusedInboxEnabled={account.settings.focusedInbox !== false}
      onFocusFilterChange={(filter) => {
        setFocusFilter(filter)
        void loadList(account.id, folderId ?? 'inbox')
      }}
      onOpen={openSummary}
      onToggleSelect={selectMessage}
      onSelectAll={selectPageMessages}
      onToggleStar={(summary) => { void toggleStar(account.id, summary.id) }}
      onToggleRead={(summary) => { void setRead(account.id, summary.id, !summary.read) }}
      onMove={moveTo}
      onArchive={archive}
      onTag={(summary, tag) => { void tagMessage(summary, tag) }}
      onDelete={(summary) => { void removeSummary(summary) }}
      onRetry={(summary) => { void retry(summary) }}
      onPage={(next) => { void loadPage(next) }}
      onReload={() => {
        if (searchMode) void searchEmails(account.id, query, page)
        else void loadList(account.id, folderId ?? 'inbox', page)
      }}
      onManageTrash={() => setTrashOpen(true)}
      onCompose={() => compose('new')}
      />
      <MessageBatchBar
        selectedCount={selectedIds.size}
        folders={folders}
        onClear={clearSelection}
        onAction={runBatch}
      />
    </div>
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
      onSnooze={snooze}
      onBack={desktop ? undefined : goList}
      tools={paneTools}
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
      {alerts}
      <div className="flex min-h-0 flex-1">
        {desktop ? (
          <>
            <div
              style={{ width: navCollapsed ? NAV_RAIL_WIDTH : navWidth }}
              className="shrink-0 overflow-hidden border-r border-[var(--border-subtle)] transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
            >
              {navCollapsed
                ? (
                    <FolderSidebarRail
                      folders={folders}
                      activeFolderId={folderId}
                      onSelect={selectFolder}
                      onExpand={toggleNav}
                      footer={<EmailAccountCard accounts={accounts} activeAccountId={account.id} compact />}
                    />
                  )
                : folderSidebar()}
            </div>
            {!navCollapsed && (
              <Resizer
                label={t('shell.resize_navigation_panel')}
                value={navWidth}
                min={PANEL_WIDTHS.emailNav.min}
                max={PANEL_WIDTHS.emailNav.max}
                onChange={(emailNavWidth) => setLayout({ emailNavWidth })}
                onReset={() => setLayout({ emailNavWidth: DEFAULT_LAYOUT.emailNavWidth })}
              />
            )}
            <div className="flex w-[380px] min-w-[360px] max-w-[420px] shrink-0 flex-col border-r border-[var(--border-subtle)]">
              {listPane}
            </div>
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{pane}</div>
          </>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {messageId || (address.kind === 'mailbox' && address.compose) ? pane : listPane}
          </div>
        )}
        {assistantDockOpen && <AssistantDock surface="email" email={emailContext} />}
      </div>
      {!desktop && (
        <Drawer
          open={folderDrawer}
          onClose={() => setFolderDrawer(false)}
          side="left"
          width={280}
          title={t('email.header.folders')}
          leftOffset={railWidth}
        >
          {folderSidebar()}
        </Drawer>
      )}
      <TrashPanel open={trashOpen} accountId={account.id} onClose={() => setTrashOpen(false)} />
    </div>
  )
}
