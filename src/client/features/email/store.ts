import { create } from 'zustand'
import type {
  EmailAccount,
  EmailAccountSettings,
  EmailBatchAction,
  EmailConfig,
  EmailFolder,
  EmailMailboxStats,
  EmailMessage,
  EmailSummary,
  EmailTag,
} from '@shared/email/model'
import { EMAIL_PAGE_SIZE } from '@shared/email/model'
import { emailSearchParams, parseEmailSearchQuery } from '@shared/email/search'
import type { EmailSavedSearch } from '@shared/email/searches'
import type { EmailContact, EmailGroupWithMembers } from '@shared/email/contacts'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { emailErrorText } from './errors'

export type EmailLoadStatus = 'idle' | 'loading' | 'ready' | 'error'
export type EmailListMode = 'folder' | 'search'
export type EmailFocusFilter = 'all' | 'focused' | 'other'
export type EmailReadFilter = 'all' | 'unread' | 'read'

const POLL_INTERVAL_MS = 30_000

const SNOOZE_LATER_HOURS = 3

export type EmailSnoozePreset = 'later_today' | 'tomorrow' | 'next_week'

export interface EmailSnoozeOption {
  preset: EmailSnoozePreset
  key: 'email.snooze.later_today' | 'email.snooze.tomorrow' | 'email.snooze.next_week'
  until: string
}

export type EmailFollowUpPreset = 'tomorrow' | 'next_week'

export interface EmailFollowUpOption {
  preset: EmailFollowUpPreset
  key: 'email.followup.tomorrow' | 'email.followup.next_week'
  at: string
}

export function emailSnoozeOptions(now = new Date()): EmailSnoozeOption[] {
  const laterToday = new Date(now.getTime() + SNOOZE_LATER_HOURS * 60 * 60 * 1000)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(8, 0, 0, 0)
  const nextWeek = new Date(now)
  nextWeek.setDate(nextWeek.getDate() + 7)
  nextWeek.setHours(8, 0, 0, 0)
  return [
    { preset: 'later_today', key: 'email.snooze.later_today', until: laterToday.toISOString() },
    { preset: 'tomorrow', key: 'email.snooze.tomorrow', until: tomorrow.toISOString() },
    { preset: 'next_week', key: 'email.snooze.next_week', until: nextWeek.toISOString() },
  ]
}

export function emailFollowUpOptions(now = new Date()): EmailFollowUpOption[] {
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(8, 0, 0, 0)
  const nextWeek = new Date(now)
  nextWeek.setDate(nextWeek.getDate() + 7)
  nextWeek.setHours(8, 0, 0, 0)
  return [
    { preset: 'tomorrow', key: 'email.followup.tomorrow', at: tomorrow.toISOString() },
    { preset: 'next_week', key: 'email.followup.next_week', at: nextWeek.toISOString() },
  ]
}

let overviewSequence = 0
let listSequence = 0
let messageSequence = 0
let trashSequence = 0
let statsSequence = 0
let contactsSequence = 0
let pollTimer: number | null = null
let visibilityBound = false

interface MailboxSnapshot {
  messages: EmailSummary[]
  total: number
  trash: EmailSummary[]
  trashTotal: number
  selectedId: string | null
  selectedMessage: EmailMessage | null
  thread: EmailMessage[]
  folders: EmailFolder[]
  selectedIds: Set<string>
  selectionAnchorId: string | null
}

interface EmailState {
  config: EmailConfig | null
  configStatus: EmailLoadStatus
  accounts: EmailAccount[]
  accountsStatus: EmailLoadStatus
  accountsError: string | null

  folders: EmailFolder[]
  foldersStatus: EmailLoadStatus
  foldersError: string | null
  foldersAccountId: string | null

  tags: EmailTag[]
  tagsStatus: EmailLoadStatus
  tagsError: string | null
  tagsAccountId: string | null
  searches: EmailSavedSearch[]
  searchesStatus: EmailLoadStatus
  searchesError: string | null
  searchesAccountId: string | null
  stats: EmailMailboxStats | null
  statsStatus: EmailLoadStatus
  statsError: string | null
  contacts: EmailContact[]
  contactsStatus: EmailLoadStatus
  contactsError: string | null
  groups: EmailGroupWithMembers[]
  groupsStatus: EmailLoadStatus
  groupsError: string | null

  messages: EmailSummary[]
  total: number
  listStatus: EmailLoadStatus
  listError: string | null
  listRefreshing: boolean
  listMode: EmailListMode
  accountId: string | null
  folderId: string | null
  searchQuery: string
  page: number
  focusFilter: EmailFocusFilter
  readFilter: EmailReadFilter

  selectedId: string | null
  selectedMessage: EmailMessage | null
  selectedStatus: EmailLoadStatus
  selectedError: string | null
  thread: EmailMessage[]
  threadStatus: EmailLoadStatus
  threadError: string | null

  selectedIds: Set<string>
  selectionAnchorId: string | null

  trash: EmailSummary[]
  trashTotal: number
  trashStatus: EmailLoadStatus
  trashError: string | null
  trashPage: number

  actionError: string | null

  loadAccounts: () => Promise<void>
  createAccount: (input: { localPart: string; domain: string; displayName?: string }) => Promise<EmailAccount>
  updateAccount: (accountId: string, input: { displayName?: string; settings: EmailAccountSettings }) => Promise<EmailAccount>
  deleteAccount: (accountId: string) => Promise<void>

  loadFolders: (accountId: string, options?: { silent?: boolean }) => Promise<void>
  createFolder: (accountId: string, name: string, parentId?: string | null, color?: string | null) => Promise<void>
  updateFolder: (accountId: string, folderId: string, patch: { name?: string, parentId?: string | null, color?: string | null, sortOrder?: number }) => Promise<void>
  renameFolder: (accountId: string, folderId: string, name: string) => Promise<void>
  deleteFolder: (accountId: string, folderId: string, deleteEmails?: boolean) => Promise<void>
  loadTags: (accountId: string, options?: { silent?: boolean }) => Promise<void>
  loadSearches: (accountId: string, options?: { silent?: boolean }) => Promise<void>
  createSearch: (accountId: string, name: string, query: string) => Promise<EmailSavedSearch>
  renameSearch: (accountId: string, searchId: string, name: string) => Promise<void>
  deleteSearch: (accountId: string, searchId: string) => Promise<void>
  loadStats: (accountId: string) => Promise<void>

  loadList: (accountId: string, folderId: string, page?: number, options?: { silent?: boolean }) => Promise<void>
  searchEmails: (accountId: string, query: string, page?: number, options?: { silent?: boolean }) => Promise<void>
  setFocusFilter: (filter: EmailFocusFilter) => void
  setReadFilter: (filter: EmailReadFilter) => void
  loadContacts: (options?: { silent?: boolean }) => Promise<void>
  loadPage: (page: number) => Promise<void>
  refresh: () => Promise<void>

  openMessage: (accountId: string, messageId: string) => Promise<void>
  clearOpenMessage: () => void
  toggleSelected: (id: string) => void
  selectRange: (id: string) => void
  selectAll: (ids: readonly string[], selected: boolean) => void
  clearSelection: () => void
  batchEmails: (accountId: string, action: EmailBatchAction, folderId?: string, ids?: readonly string[]) => Promise<boolean>
  markThreadRead: (accountId: string, message: EmailMessage) => Promise<boolean>
  setRead: (accountId: string, messageId: string, read: boolean) => Promise<boolean>
  toggleStar: (accountId: string, messageId: string) => Promise<boolean>
  toggleImportant: (accountId: string, messageId: string) => Promise<boolean>
  muteThread: (accountId: string, threadId: string, muted: boolean) => Promise<boolean>
  setFollowUp: (accountId: string, messageId: string, at: string | null) => Promise<boolean>
  moveMessage: (accountId: string, messageId: string, folderId: string) => Promise<boolean>
  deleteMessage: (accountId: string, messageId: string, permanent?: boolean) => Promise<boolean>
  snoozeMessage: (accountId: string, messageId: string, until: string) => Promise<boolean>
  retrySend: (accountId: string, messageId: string) => Promise<boolean>

  loadTrash: (accountId: string, page?: number) => Promise<void>
  restoreTrash: (accountId: string, messageId: string) => Promise<void>
  purgeTrash: (accountId: string, messageId: string) => Promise<void>
  emptyTrash: (accountId: string) => Promise<void>

  startPolling: () => void
  stopPolling: () => void
  clearActionError: () => void
}

const INITIAL = {
  config: null as EmailConfig | null,
  configStatus: 'idle' as EmailLoadStatus,
  accounts: [] as EmailAccount[],
  accountsStatus: 'idle' as EmailLoadStatus,
  accountsError: null as string | null,
  folders: [] as EmailFolder[],
  foldersStatus: 'idle' as EmailLoadStatus,
  foldersError: null as string | null,
  foldersAccountId: null as string | null,
  tags: [] as EmailTag[],
  tagsStatus: 'idle' as EmailLoadStatus,
  tagsError: null as string | null,
  tagsAccountId: null as string | null,
  searches: [] as EmailSavedSearch[],
  searchesStatus: 'idle' as EmailLoadStatus,
  searchesError: null as string | null,
  searchesAccountId: null as string | null,
  stats: null as EmailMailboxStats | null,
  statsStatus: 'idle' as EmailLoadStatus,
  statsError: null as string | null,
  contacts: [] as EmailContact[],
  contactsStatus: 'idle' as EmailLoadStatus,
  contactsError: null as string | null,
  groups: [] as EmailGroupWithMembers[],
  groupsStatus: 'idle' as EmailLoadStatus,
  groupsError: null as string | null,
  messages: [] as EmailSummary[],
  total: 0,
  listStatus: 'idle' as EmailLoadStatus,
  listError: null as string | null,
  listRefreshing: false,
  listMode: 'folder' as EmailListMode,
  accountId: null as string | null,
  folderId: null as string | null,
  searchQuery: '',
  page: 1,
  focusFilter: 'all' as EmailFocusFilter,
  readFilter: 'all' as EmailReadFilter,
  selectedId: null as string | null,
  selectedMessage: null as EmailMessage | null,
  selectedStatus: 'idle' as EmailLoadStatus,
  selectedError: null as string | null,
  thread: [] as EmailMessage[],
  threadStatus: 'idle' as EmailLoadStatus,
  threadError: null as string | null,
  selectedIds: new Set<string>(),
  selectionAnchorId: null as string | null,
  trash: [] as EmailSummary[],
  trashTotal: 0,
  trashStatus: 'idle' as EmailLoadStatus,
  trashError: null as string | null,
  trashPage: 1,
  actionError: null as string | null,
}

const visibilityHandler = (): void => {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    void useEmailStore.getState().refresh()
  }
}

function snapshot(state: EmailState): MailboxSnapshot {
  return {
    messages: state.messages,
    total: state.total,
    trash: state.trash,
    trashTotal: state.trashTotal,
    selectedId: state.selectedId,
    selectedMessage: state.selectedMessage,
    thread: state.thread,
    folders: state.folders,
    selectedIds: state.selectedIds,
    selectionAnchorId: state.selectionAnchorId,
  }
}

function sortedThread(messages: EmailMessage[]): EmailMessage[] {
  const unique = new Map<string, EmailMessage>()
  for (const message of messages) unique.set(message.id, message)
  return [...unique.values()].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
}

function adjustFolderUnread(folders: EmailFolder[], folderId: string | null, delta: number): EmailFolder[] {
  if (!folderId) return folders
  return folders.map((folder) => folder.id === folderId
    ? { ...folder, unreadCount: Math.max(0, folder.unreadCount + delta) }
    : folder)
}

function updateSummary(list: EmailSummary[], id: string, patch: Partial<EmailSummary>): EmailSummary[] {
  return list.map((entry) => entry.id === id ? { ...entry, ...patch } : entry)
}

function updateThread(list: EmailMessage[], id: string, patch: Partial<EmailMessage>): EmailMessage[] {
  return list.map((entry) => entry.id === id ? { ...entry, ...patch } : entry)
}

function findSummary(state: EmailState, id: string): EmailSummary | null {
  return state.messages.find((entry) => entry.id === id)
    ?? state.trash.find((entry) => entry.id === id)
    ?? (state.selectedMessage?.id === id ? state.selectedMessage : null)
    ?? state.thread.find((entry) => entry.id === id)
    ?? null
}

export const useEmailStore = create<EmailState>((set, get) => ({
  ...INITIAL,

  loadAccounts: async () => {
    const sequence = ++overviewSequence
    const state = get()
    set({
      accountsStatus: state.accounts.length > 0 ? 'ready' : 'loading',
      configStatus: state.config ? 'ready' : 'loading',
      accountsError: null,
    })
    try {
      const config = await api.email.getConfig()
      if (sequence !== overviewSequence) return
      let accounts = await api.email.listAccounts()
      if (sequence !== overviewSequence) return
      let ensureError: string | null = null
      if (config.addresses.length > 0) {
        try {
          const created = await api.email.ensureAccounts()
          if (sequence !== overviewSequence) return
          if (created.length > 0) {
            accounts = await api.email.listAccounts()
            if (sequence !== overviewSequence) return
          }
        } catch (reason) {
          ensureError = emailErrorText(reason)
        }
      }
      set({
        config,
        configStatus: 'ready',
        accounts,
        accountsStatus: 'ready',
        accountsError: ensureError,
      })
    } catch (reason) {
      if (sequence !== overviewSequence) return
      set({
        accountsStatus: 'error',
        configStatus: get().config ? 'ready' : 'error',
        accountsError: emailErrorText(reason),
      })
    }
  },

  createAccount: async (input) => {
    const account = await api.email.createAccount(input)
    set((state) => ({ accounts: [...state.accounts, account] }))
    return account
  },

  updateAccount: async (accountId, input) => {
    const updated = await api.email.updateAccount(accountId, input)
    set((state) => ({
      accounts: state.accounts.map((account) => account.id === updated.id ? updated : account),
    }))
    return updated
  },

  deleteAccount: async (accountId) => {
    await api.email.deleteAccount(accountId)
    if (get().accountId === accountId) {
      get().stopPolling()
      set({
        messages: [],
        total: 0,
        listStatus: 'idle',
        listError: null,
        folders: [],
        foldersAccountId: null,
        foldersStatus: 'idle',
        tags: [],
        tagsStatus: 'idle',
        tagsError: null,
        tagsAccountId: null,
        searches: [],
        searchesStatus: 'idle',
        searchesError: null,
        searchesAccountId: null,
        stats: null,
        statsStatus: 'idle',
        statsError: null,
        contacts: [],
        contactsStatus: 'idle',
        contactsError: null,
        groups: [],
        groupsStatus: 'idle',
        groupsError: null,
        selectedId: null,
        selectedMessage: null,
        selectedStatus: 'idle',
        selectedError: null,
        thread: [],
        threadStatus: 'idle',
        threadError: null,
        selectedIds: new Set<string>(),
        selectionAnchorId: null,
        folderId: null,
        accountId: null,
        trash: [],
        trashTotal: 0,
        trashStatus: 'idle',
        trashError: null,
      })
    }
    set((state) => ({ accounts: state.accounts.filter((account) => account.id !== accountId) }))
  },

  loadFolders: async (accountId, options) => {
    const silent = options?.silent === true
    set((state) => ({
      folders: state.foldersAccountId === accountId ? state.folders : [],
      foldersAccountId: accountId,
      foldersStatus: silent ? state.foldersStatus : 'loading',
      foldersError: null,
    }))
    try {
      const folders = await api.email.listFolders(accountId)
      if (get().foldersAccountId !== accountId) return
      set({ folders, foldersStatus: 'ready', foldersError: null })
    } catch (reason) {
      if (get().foldersAccountId !== accountId) return
      set({
        foldersStatus: silent ? get().foldersStatus : 'error',
        foldersError: emailErrorText(reason),
      })
    }
  },

  createFolder: async (accountId, name, parentId = null, color = null) => {
    await api.email.createFolder(accountId, name, parentId, color)
    await get().loadFolders(accountId, { silent: true })
  },

  updateFolder: async (accountId, folderId, patch) => {
    await api.email.updateFolder(accountId, folderId, patch)
    await get().loadFolders(accountId, { silent: true })
  },

  renameFolder: async (accountId, folderId, name) => {
    await get().updateFolder(accountId, folderId, { name })
  },

  deleteFolder: async (accountId, folderId, deleteEmails = false) => {
    await api.email.deleteFolder(accountId, folderId, deleteEmails)
    await get().loadFolders(accountId, { silent: true })
    await get().refresh()
  },

  loadTags: async (accountId, options) => {
    const silent = options?.silent === true
    set((state) => ({
      tags: state.tagsAccountId === accountId ? state.tags : [],
      tagsAccountId: accountId,
      tagsStatus: silent ? state.tagsStatus : 'loading',
      tagsError: null,
    }))
    try {
      const tags = await api.email.listTags(accountId)
      if (get().tagsAccountId !== accountId) return
      set({ tags, tagsStatus: 'ready', tagsError: null })
    } catch (reason) {
      if (get().tagsAccountId !== accountId) return
      set({
        tagsStatus: silent ? get().tagsStatus : 'error',
        tagsError: emailErrorText(reason),
      })
    }
  },

  loadSearches: async (accountId, options) => {
    const silent = options?.silent === true
    set((state) => ({
      searches: state.searchesAccountId === accountId ? state.searches : [],
      searchesAccountId: accountId,
      searchesStatus: silent ? state.searchesStatus : 'loading',
      searchesError: null,
    }))
    try {
      const searches = await api.email.listSearches(accountId)
      if (get().searchesAccountId !== accountId) return
      set({ searches, searchesStatus: 'ready', searchesError: null })
    } catch (reason) {
      if (get().searchesAccountId !== accountId) return
      set({
        searchesStatus: silent ? get().searchesStatus : 'error',
        searchesError: emailErrorText(reason),
      })
    }
  },

  createSearch: async (accountId, name, query) => {
    const created = await api.email.createSearch(accountId, { name, query })
    await get().loadSearches(accountId, { silent: true })
    return created
  },

  renameSearch: async (accountId, searchId, name) => {
    await api.email.updateSearch(accountId, searchId, { name })
    await get().loadSearches(accountId, { silent: true })
  },

  deleteSearch: async (accountId, searchId) => {
    await api.email.deleteSearch(accountId, searchId)
    await get().loadSearches(accountId, { silent: true })
  },

  setReadFilter: (filter) => {
    set({ readFilter: filter })
  },

  loadContacts: async (options) => {
    const silent = options?.silent === true
    const sequence = ++contactsSequence
    set((state) => ({
      contactsStatus: silent ? state.contactsStatus : 'loading',
      contactsError: null,
      groupsStatus: silent ? state.groupsStatus : 'loading',
      groupsError: null,
    }))
    try {
      const [contacts, groups] = await Promise.all([
        api.email.listContacts(''),
        api.email.listGroups(),
      ])
      if (sequence !== contactsSequence) return
      set({ contacts, contactsStatus: 'ready', contactsError: null, groups, groupsStatus: 'ready', groupsError: null })
    } catch (reason) {
      if (sequence !== contactsSequence) return
      set({
        contactsStatus: silent ? get().contactsStatus : 'error',
        contactsError: emailErrorText(reason),
        groupsStatus: silent ? get().groupsStatus : 'error',
        groupsError: emailErrorText(reason),
      })
    }
  },

  loadStats: async (accountId) => {
    const sequence = ++statsSequence
    set({ statsStatus: 'loading', statsError: null })
    try {
      const stats = await api.email.getStats(accountId)
      if (sequence !== statsSequence) return
      set({ stats, statsStatus: 'ready', statsError: null })
    } catch (reason) {
      if (sequence !== statsSequence) return
      set({ statsStatus: 'error', statsError: emailErrorText(reason) })
    }
  },

  loadList: async (accountId, folderId, page = 1, options) => {
    const silent = options?.silent === true
    const sequence = ++listSequence
    const focusFilter = get().focusFilter
    const readFilter = get().readFilter
    set((state) => ({
      accountId,
      folderId,
      listMode: 'folder',
      searchQuery: '',
      page,
      focusFilter: folderId === 'inbox' ? state.focusFilter : 'all',
      listError: null,
      listRefreshing: silent,
      listStatus: silent ? state.listStatus : 'loading',
      ...(silent ? {} : { messages: [], total: 0, selectedIds: new Set<string>(), selectionAnchorId: null }),
    }))
    try {
      const result = await api.email.listEmails(accountId, {
        folder: folderId,
        focused: folderId === 'inbox' && focusFilter !== 'all'
          ? focusFilter === 'focused' ? '1' : '0'
          : undefined,
        is_read: readFilter === 'all' ? undefined : readFilter === 'read' ? '1' : '0',
        page,
        limit: EMAIL_PAGE_SIZE,
        threaded: 'true',
      })
      if (sequence !== listSequence) return
      set((state) => ({
        messages: result.emails,
        total: result.totalCount,
        listStatus: 'ready',
        listError: null,
        listRefreshing: false,
        selectedIds: new Set(
          [...state.selectedIds].filter((id) => result.emails.some((entry) => entry.id === id)),
        ),
        selectionAnchorId: state.selectionAnchorId && result.emails.some((entry) => entry.id === state.selectionAnchorId)
          ? state.selectionAnchorId
          : null,
      }))
    } catch (reason) {
      if (sequence !== listSequence) return
      set({
        listStatus: silent ? get().listStatus : 'error',
        listError: emailErrorText(reason),
        listRefreshing: false,
      })
    }
  },

  searchEmails: async (accountId, query, page = 1, options) => {
    const silent = options?.silent === true
    const sequence = ++listSequence
    const trimmed = query.trim()
    set((state) => ({
      accountId,
      folderId: null,
      listMode: 'search',
      searchQuery: query,
      page,
      listError: null,
      listRefreshing: silent,
      listStatus: silent ? state.listStatus : 'loading',
      ...(silent ? {} : { messages: [], total: 0, selectedIds: new Set<string>(), selectionAnchorId: null }),
    }))
    if (!trimmed) {
      set({ messages: [], total: 0, listStatus: 'ready', listRefreshing: false })
      return
    }
    try {
      const result = await api.email.search(accountId, {
        ...emailSearchParams(parseEmailSearchQuery(trimmed)),
        page,
        limit: EMAIL_PAGE_SIZE,
      })
      if (sequence !== listSequence) return
      set((state) => ({
        messages: result.emails,
        total: result.totalCount,
        listStatus: 'ready',
        listError: null,
        listRefreshing: false,
        selectedIds: new Set(
          [...state.selectedIds].filter((id) => result.emails.some((entry) => entry.id === id)),
        ),
        selectionAnchorId: state.selectionAnchorId && result.emails.some((entry) => entry.id === state.selectionAnchorId)
          ? state.selectionAnchorId
          : null,
      }))
    } catch (reason) {
      if (sequence !== listSequence) return
      set({
        listStatus: silent ? get().listStatus : 'error',
        listError: emailErrorText(reason),
        listRefreshing: false,
      })
    }
  },

  loadPage: async (page) => {
    const state = get()
    if (!state.accountId) return
    if (state.listMode === 'search') {
      await get().searchEmails(state.accountId, state.searchQuery, page)
      return
    }
    if (state.folderId) await get().loadList(state.accountId, state.folderId, page)
  },

  setFocusFilter: (filter) => set({ focusFilter: filter }),

  refresh: async () => {
    const state = get()
    if (!state.accountId) return
    const tasks: Promise<void>[] = [
      get().loadFolders(state.accountId, { silent: true }),
      get().loadTags(state.accountId, { silent: true }),
      get().loadSearches(state.accountId, { silent: true }),
      get().loadContacts({ silent: true }),
    ]
    if (state.listMode === 'search') {
      tasks.push(get().searchEmails(state.accountId, state.searchQuery, state.page, { silent: true }))
    } else if (state.folderId) {
      tasks.push(get().loadList(state.accountId, state.folderId, state.page, { silent: true }))
    }
    await Promise.allSettled(tasks)
  },

  openMessage: async (accountId, messageId) => {
    const sequence = ++messageSequence
    set({
      selectedId: messageId,
      selectedMessage: null,
      selectedStatus: 'loading',
      selectedError: null,
      thread: [],
      threadStatus: 'loading',
      threadError: null,
    })
    try {
      const message = await api.email.getEmail(accountId, messageId)
      if (sequence !== messageSequence) return
      let thread = [message]
      let threadError: string | null = null
      if (message.threadId) {
        try {
          const rows = await api.email.getThread(accountId, message.threadId)
          if (sequence !== messageSequence) return
          if (rows.length > 0) thread = rows
        } catch (reason) {
          if (sequence !== messageSequence) return
          threadError = emailErrorText(reason)
        }
      }
      const sorted = sortedThread(thread)
      const selected = sorted.find((entry) => entry.id === message.id) ?? message
      set({
        selectedMessage: selected,
        selectedStatus: 'ready',
        selectedError: null,
        thread: sorted,
        threadStatus: threadError ? 'error' : 'ready',
        threadError,
      })
      if (sorted.some((entry) => !entry.read)) void get().markThreadRead(accountId, selected)
    } catch (reason) {
      if (sequence !== messageSequence) return
      const error = emailErrorText(reason)
      set({
        selectedStatus: 'error',
        selectedError: error,
        threadStatus: 'error',
        threadError: error,
      })
    }
  },

  clearOpenMessage: () => {
    messageSequence += 1
    set({
      selectedId: null,
      selectedMessage: null,
      selectedStatus: 'idle',
      selectedError: null,
      thread: [],
      threadStatus: 'idle',
      threadError: null,
    })
  },

  toggleSelected: (id) => set((state) => {
    const selectedIds = new Set(state.selectedIds)
    if (selectedIds.has(id)) selectedIds.delete(id)
    else selectedIds.add(id)
    return { selectedIds, selectionAnchorId: id }
  }),

  selectRange: (id) => set((state) => {
    const ids = state.messages.map((entry) => entry.id)
    const anchorIndex = state.selectionAnchorId ? ids.indexOf(state.selectionAnchorId) : -1
    const targetIndex = ids.indexOf(id)
    if (anchorIndex < 0 || targetIndex < 0) {
      const selectedIds = new Set(state.selectedIds)
      selectedIds.add(id)
      return { selectedIds, selectionAnchorId: id }
    }
    const start = Math.min(anchorIndex, targetIndex)
    const end = Math.max(anchorIndex, targetIndex)
    const selectedIds = new Set(state.selectedIds)
    for (const entry of ids.slice(start, end + 1)) selectedIds.add(entry)
    return { selectedIds, selectionAnchorId: id }
  }),

  selectAll: (ids, selected) => set((state) => {
    const selectedIds = new Set(state.selectedIds)
    for (const id of ids) {
      if (selected) selectedIds.add(id)
      else selectedIds.delete(id)
    }
    return { selectedIds, selectionAnchorId: selected ? ids[0] ?? null : null }
  }),

  clearSelection: () => set({ selectedIds: new Set<string>(), selectionAnchorId: null }),

  batchEmails: async (accountId, action, folderId, ids) => {
    const targets = ids && ids.length > 0 ? [...new Set(ids)] : [...get().selectedIds]
    if (targets.length === 0) return false
    set({ actionError: null })
    try {
      await api.email.batchEmails(accountId, folderId ? { ids: targets, action, folderId } : { ids: targets, action })
      set({ selectedIds: new Set<string>(), selectionAnchorId: null })
      await get().refresh()
      return true
    } catch (reason) {
      set({ actionError: emailErrorText(reason) })
      return false
    }
  },

  markThreadRead: async (accountId, message) => {
    const state = get()
    const threadId = message.threadId
    const ids = new Set(state.thread.map((entry) => entry.id))
    ids.add(message.id)
    const matches = (entry: EmailSummary): boolean => ids.has(entry.id) || (Boolean(threadId) && entry.threadId === threadId)
    const listed = state.messages.filter((entry) => matches(entry) && !entry.read)
    const unread = state.thread.some((entry) => !entry.read) || !message.read
    if (listed.length === 0 && !unread) return true
    const before = snapshot(state)
    const delta = Math.max(listed.length, !message.read ? 1 : 0)
    set({
      messages: state.messages.map((entry) => matches(entry) ? { ...entry, read: true } : entry),
      thread: state.thread.map((entry) => ({ ...entry, read: true })),
      selectedMessage: state.selectedMessage ? { ...state.selectedMessage, read: true } : null,
      folders: adjustFolderUnread(state.folders, message.folderId, -delta),
    })
    try {
      if (threadId) await api.email.markThreadRead(accountId, threadId)
      else await api.email.updateEmail(accountId, message.id, { read: true })
      return true
    } catch (reason) {
      set({ ...before, actionError: emailErrorText(reason) })
      return false
    }
  },

  setRead: async (accountId, messageId, read) => {
    const state = get()
    const summary = findSummary(state, messageId)
    if (!summary || summary.read === read) return true
    const before = snapshot(state)
    const delta = read ? -1 : 1
    set({
      messages: updateSummary(state.messages, messageId, { read }),
      trash: updateSummary(state.trash, messageId, { read }),
      thread: updateThread(state.thread, messageId, { read }),
      selectedMessage: state.selectedMessage?.id === messageId
        ? { ...state.selectedMessage, read }
        : state.selectedMessage,
      folders: adjustFolderUnread(state.folders, summary.folderId, delta),
    })
    try {
      const updated = await api.email.updateEmail(accountId, messageId, { read })
      set({
        messages: updateSummary(get().messages, messageId, { read: updated.read }),
        trash: updateSummary(get().trash, messageId, { read: updated.read }),
        thread: updateThread(get().thread, messageId, { read: updated.read }),
      })
      return true
    } catch (reason) {
      set({ ...before, actionError: emailErrorText(reason) })
      return false
    }
  },

  toggleStar: async (accountId, messageId) => {
    const state = get()
    const summary = findSummary(state, messageId)
    if (!summary) return false
    const starred = !summary.starred
    const before = snapshot(state)
    set({
      messages: updateSummary(state.messages, messageId, { starred }),
      trash: updateSummary(state.trash, messageId, { starred }),
      thread: updateThread(state.thread, messageId, { starred }),
      selectedMessage: state.selectedMessage?.id === messageId
        ? { ...state.selectedMessage, starred }
        : state.selectedMessage,
    })
    try {
      const updated = await api.email.updateEmail(accountId, messageId, { starred })
      set({
        messages: updateSummary(get().messages, messageId, { starred: updated.starred }),
        trash: updateSummary(get().trash, messageId, { starred: updated.starred }),
        thread: updateThread(get().thread, messageId, { starred: updated.starred }),
      })
      return true
    } catch (reason) {
      set({ ...before, actionError: emailErrorText(reason) })
      return false
    }
  },

  toggleImportant: async (accountId, messageId) => {
    const state = get()
    const summary = findSummary(state, messageId)
    if (!summary) return false
    const important = !summary.important
    const before = snapshot(state)
    set({
      messages: updateSummary(state.messages, messageId, { important }),
      trash: updateSummary(state.trash, messageId, { important }),
      thread: updateThread(state.thread, messageId, { important }),
      selectedMessage: state.selectedMessage?.id === messageId
        ? { ...state.selectedMessage, important }
        : state.selectedMessage,
    })
    try {
      const updated = await api.email.updateEmail(accountId, messageId, { important })
      set({
        messages: updateSummary(get().messages, messageId, { important: updated.important }),
        trash: updateSummary(get().trash, messageId, { important: updated.important }),
        thread: updateThread(get().thread, messageId, { important: updated.important }),
        actionError: null,
      })
      if (get().listMode === 'search' && parseEmailSearchQuery(get().searchQuery).important === true) {
        await get().refresh()
      }
      return true
    } catch (reason) {
      set({ ...before, actionError: emailErrorText(reason) })
      return false
    }
  },

  muteThread: async (accountId, threadId, muted) => {
    const state = get()
    const before = snapshot(state)
    const apply = <T extends EmailSummary>(list: T[]): T[] =>
      list.map((entry) => entry.threadId === threadId ? { ...entry, muted } : entry)
    set({
      messages: apply(state.messages),
      trash: apply(state.trash),
      thread: apply(state.thread),
      selectedMessage: state.selectedMessage?.threadId === threadId
        ? { ...state.selectedMessage, muted }
        : state.selectedMessage,
    })
    try {
      await api.email.muteThread(accountId, threadId, muted)
      await get().refresh()
      return true
    } catch (reason) {
      set({ ...before, actionError: emailErrorText(reason) })
      return false
    }
  },

  setFollowUp: async (accountId, messageId, at) => {
    set({ actionError: null })
    try {
      const updated = await api.email.setFollowUp(accountId, messageId, at)
      const patch = { important: updated.important, followUpAt: updated.followUpAt }
      set((state) => ({
        messages: updateSummary(state.messages, messageId, patch),
        trash: updateSummary(state.trash, messageId, patch),
        thread: updateThread(state.thread, messageId, patch),
        selectedMessage: state.selectedMessage?.id === messageId
          ? { ...state.selectedMessage, ...patch }
          : state.selectedMessage,
      }))
    } catch (reason) {
      set({ actionError: emailErrorText(reason) })
      return false
    }
    await get().refresh()
    return true
  },

  moveMessage: async (accountId, messageId, folderId) => {
    const state = get()
    const summary = findSummary(state, messageId)
    if (!summary) return false
    if (summary.folderId === folderId) return true
    const before = snapshot(state)
    const removeFromList = state.listMode === 'folder' && state.folderId === summary.folderId
    const clearsSelection = state.selectedId === messageId
      || state.thread.some((entry) => entry.id === messageId)
    set({
      messages: removeFromList
        ? state.messages.filter((entry) => entry.id !== messageId)
        : state.messages,
      total: removeFromList ? Math.max(0, state.total - 1) : state.total,
      selectedId: clearsSelection ? null : state.selectedId,
      selectedMessage: clearsSelection ? null : state.selectedMessage,
      selectedStatus: clearsSelection ? 'idle' : state.selectedStatus,
      selectedError: clearsSelection ? null : state.selectedError,
      thread: clearsSelection ? [] : state.thread,
      threadStatus: clearsSelection ? 'idle' : state.threadStatus,
      threadError: clearsSelection ? null : state.threadError,
      selectedIds: new Set([...state.selectedIds].filter((id) => id !== messageId)),
      selectionAnchorId: state.selectionAnchorId === messageId ? null : state.selectionAnchorId,
      folders: adjustFolderUnread(
        adjustFolderUnread(state.folders, summary.folderId, summary.read ? 0 : -1),
        folderId,
        summary.read ? 0 : 1,
      ),
    })
    try {
      await api.email.moveEmail(accountId, messageId, folderId)
      return true
    } catch (reason) {
      set({ ...before, actionError: emailErrorText(reason) })
      return false
    }
  },

  deleteMessage: async (accountId, messageId, permanent = false) => {
    const state = get()
    const summary = findSummary(state, messageId)
    if (!summary) return false
    const before = snapshot(state)
    const clearsSelection = state.selectedId === messageId
      || state.thread.some((entry) => entry.id === messageId)
    const inTrashList = state.trash.some((entry) => entry.id === messageId)
    const inMessageList = state.messages.some((entry) => entry.id === messageId)
    set({
      messages: state.messages.filter((entry) => entry.id !== messageId),
      total: inMessageList ? Math.max(0, state.total - 1) : state.total,
      trash: state.trash.filter((entry) => entry.id !== messageId),
      trashTotal: inTrashList ? Math.max(0, state.trashTotal - 1) : state.trashTotal,
      selectedId: clearsSelection ? null : state.selectedId,
      selectedMessage: clearsSelection ? null : state.selectedMessage,
      selectedStatus: clearsSelection ? 'idle' : state.selectedStatus,
      selectedError: clearsSelection ? null : state.selectedError,
      thread: clearsSelection ? [] : state.thread,
      threadStatus: clearsSelection ? 'idle' : state.threadStatus,
      threadError: clearsSelection ? null : state.threadError,
      selectedIds: new Set([...state.selectedIds].filter((id) => id !== messageId)),
      selectionAnchorId: state.selectionAnchorId === messageId ? null : state.selectionAnchorId,
      folders: permanent || summary.read
        ? state.folders
        : adjustFolderUnread(state.folders, summary.folderId, -1),
    })
    try {
      await api.email.deleteEmail(accountId, messageId, permanent)
      return true
    } catch (reason) {
      set({ ...before, actionError: emailErrorText(reason) })
      return false
    }
  },

  snoozeMessage: async (accountId, messageId, until) => {
    set({ actionError: null })
    try {
      await api.email.snoozeEmail(accountId, messageId, until)
    } catch (reason) {
      set({ actionError: emailErrorText(reason) })
      return false
    }
    await get().refresh()
    return true
  },

  retrySend: async (accountId, messageId) => {
    try {
      const result = await api.email.retrySend(accountId, messageId)
      if (result.status === 'failed') {
        set({ actionError: result.error ?? t('email.errors.send_failed') })
        return false
      }
      set((state) => ({
        messages: updateSummary(state.messages, messageId, { deliveryStatus: result.status }),
        actionError: null,
      }))
      await get().refresh()
      return true
    } catch (reason) {
      set({ actionError: emailErrorText(reason) })
      return false
    }
  },

  loadTrash: async (accountId, page = 1) => {
    const sequence = ++trashSequence
    set({ trashStatus: 'loading', trashError: null, trashPage: page })
    try {
      const result = await api.email.listTrash(accountId, { page, limit: EMAIL_PAGE_SIZE })
      if (sequence !== trashSequence) return
      set({
        trash: result.emails,
        trashTotal: result.totalCount,
        trashStatus: 'ready',
        trashError: null,
        trashPage: page,
      })
    } catch (reason) {
      if (sequence !== trashSequence) return
      set({ trashStatus: 'error', trashError: emailErrorText(reason) })
    }
  },

  restoreTrash: async (accountId, messageId) => {
    await api.email.restoreEmail(accountId, messageId)
    set((state) => ({
      trash: state.trash.filter((entry) => entry.id !== messageId),
      trashTotal: Math.max(0, state.trashTotal - 1),
      selectedId: state.selectedId === messageId ? null : state.selectedId,
      selectedMessage: state.selectedMessage?.id === messageId ? null : state.selectedMessage,
    }))
    await get().refresh()
  },

  purgeTrash: async (accountId, messageId) => {
    await api.email.deleteEmail(accountId, messageId, true)
    set((state) => ({
      trash: state.trash.filter((entry) => entry.id !== messageId),
      trashTotal: Math.max(0, state.trashTotal - 1),
      selectedId: state.selectedId === messageId ? null : state.selectedId,
      selectedMessage: state.selectedMessage?.id === messageId ? null : state.selectedMessage,
    }))
    await get().refresh()
  },

  emptyTrash: async (accountId) => {
    await api.email.emptyTrash(accountId)
    set({ trash: [], trashTotal: 0, trashStatus: 'ready' })
    await get().refresh()
  },

  startPolling: () => {
    if (typeof window === 'undefined' || pollTimer !== null) return
    const tick = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void get().refresh()
    }
    pollTimer = window.setInterval(tick, POLL_INTERVAL_MS)
    if (typeof document !== 'undefined' && !visibilityBound) {
      document.addEventListener('visibilitychange', visibilityHandler)
      visibilityBound = true
    }
  },

  stopPolling: () => {
    if (pollTimer !== null && typeof window !== 'undefined') window.clearInterval(pollTimer)
    pollTimer = null
    if (typeof document !== 'undefined' && visibilityBound) {
      document.removeEventListener('visibilitychange', visibilityHandler)
      visibilityBound = false
    }
  },

  clearActionError: () => set({ actionError: null }),
}))

export const EMAIL_POLL_INTERVAL_MS = POLL_INTERVAL_MS
