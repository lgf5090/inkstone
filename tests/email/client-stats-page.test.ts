// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMAIL_ATTACHMENT_QUOTA_BYTES } from '@shared/email/model'
import type { EmailAccount, EmailDailyCount, EmailFolder, EmailFolderStats, EmailMailboxStats } from '@shared/email/model'
import { api } from '../../src/client/lib/api'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { t } from '../../src/client/lib/i18n'
import { formatBytes, formatDateKey, formatNumber } from '../../src/client/lib/time'
import { StatsPage } from '../../src/client/features/email/StatsPage'
import { useEmailStore } from '../../src/client/features/email/store'

const original = useEmailStore.getState()

const account: EmailAccount = {
  id: 'a1',
  address: 'ada@example.com',
  displayName: 'Ada',
  settings: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const folders: EmailFolder[] = [
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 3, totalCount: 3, parentId: null, color: null, sortOrder: 0 },
  { id: 'sent', name: 'Sent', isDeletable: false, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 1 },
  { id: 'draft', name: 'Drafts', isDeletable: false, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 2 },
  { id: 'archive', name: 'Archive', isDeletable: false, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 3 },
  { id: 'trash', name: 'Trash', isDeletable: false, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 4 },
  { id: 'spam', name: 'Spam', isDeletable: false, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 5 },
  { id: 'folder-1', name: 'Receipts', isDeletable: true, unreadCount: 2, totalCount: 2, parentId: null, color: '#2563eb', sortOrder: 0 },
]

function folderStats(folderId: string, total: number, read: number, starred: number, withAttachments: number): EmailFolderStats {
  return { folderId, total, read, unread: total - read, starred, withAttachments }
}

function days(counts: readonly number[]): EmailDailyCount[] {
  return counts.map((count, index) => ({
    date: `2026-10-${String(17 + index).padStart(2, '0')}`,
    count,
  }))
}

const stats: EmailMailboxStats = {
  total: 13,
  read: 8,
  unread: 5,
  starred: 4,
  withAttachments: 3,
  sent: 4,
  draft: 1,
  trash: 2,
  attachmentBytes: 5 * 1024 * 1024,
  folders: [
    folderStats('inbox', 6, 3, 2, 1),
    folderStats('sent', 4, 4, 1, 1),
    folderStats('draft', 1, 1, 0, 0),
    folderStats('archive', 0, 0, 0, 0),
    folderStats('trash', 0, 0, 0, 0),
    folderStats('spam', 0, 0, 0, 0),
    folderStats('folder-1', 2, 0, 1, 1),
  ],
  receivedLast7Days: days([0, 1, 2, 0, 4, 1, 0]),
  sentLast7Days: days([0, 0, 1, 0, 1, 0, 2]),
}

const emptyStats: EmailMailboxStats = {
  total: 0,
  read: 0,
  unread: 0,
  starred: 0,
  withAttachments: 0,
  sent: 0,
  draft: 0,
  trash: 0,
  attachmentBytes: 0,
  folders: ['inbox', 'sent', 'draft', 'archive', 'trash', 'spam'].map((id) => folderStats(id, 0, 0, 0, 0)),
  receivedLast7Days: days([0, 0, 0, 0, 0, 0, 0]),
  sentLast7Days: days([0, 0, 0, 0, 0, 0, 0]),
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

function kpiText(id: string): string {
  return document.querySelector(`[data-stats-kpi="${id}"]`)?.textContent ?? ''
}

let view: RenderedElement | null = null

beforeEach(() => {
  useEmailStore.setState(original, true)
  useEmailStore.setState({
    accounts: [account],
    accountsStatus: 'ready',
    accountsError: null,
    folders,
    foldersAccountId: 'a1',
    foldersStatus: 'ready',
    foldersError: null,
    stats: null,
    statsStatus: 'idle',
    statsError: null,
  })
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  useEmailStore.setState(original, true)
})

describe('the mailbox statistics page', () => {
  it('shows the loading state and the mailbox while the statistics are read', async () => {
    const getStats = vi.spyOn(api.email, 'getStats').mockReturnValue(new Promise<EmailMailboxStats>(() => {}))
    view = renderElement(createElement(StatsPage, { accountId: 'a1' }))
    await settle()
    expect(getStats).toHaveBeenCalledWith('a1')
    expect(document.querySelector('[role="status"]')?.textContent).toContain(t('common.loading'))
    expect(document.body.textContent).toContain('ada@example.com')
    expect(button(t('email.header.back'))).toBeDefined()
  })

  it('prints the KPI counts, the folder rows and the last seven days', async () => {
    vi.spyOn(api.email, 'getStats').mockResolvedValue(stats)
    view = renderElement(createElement(StatsPage, { accountId: 'a1' }))
    await settle()
    expect(kpiText('total')).toContain(formatNumber(13))
    expect(kpiText('unread')).toContain(formatNumber(5))
    expect(kpiText('starred')).toContain(formatNumber(4))
    expect(kpiText('sent')).toContain(formatNumber(4))
    expect(kpiText('draft')).toContain(formatNumber(1))
    expect(kpiText('trash')).toContain(formatNumber(2))
    expect(kpiText('attachments')).toContain(formatBytes(5 * 1024 * 1024))
    expect(kpiText('attachments')).toContain(t('email.stats.kpi.attachments_hint', {
      quota: formatBytes(EMAIL_ATTACHMENT_QUOTA_BYTES),
    }))
    const folderRows = document.querySelector('[data-stats-folders]')?.textContent ?? ''
    expect(folderRows).toContain(t('email.folder.inbox'))
    expect(folderRows).toContain(t('email.folder.sent'))
    expect(folderRows).toContain(t('email.folder.archive'))
    expect(folderRows).toContain('Receipts')
    expect(document.querySelector('[data-stats-folders] svg[role="img"]')?.getAttribute('aria-label'))
      .toBe(t('email.stats.folders_caption'))
    const received = document.querySelector('[data-stats-week="received"]')
    expect(received?.textContent).toContain(formatNumber(8))
    expect(received?.textContent).toContain(t('email.stats.week_day', {
      date: formatDateKey('2026-10-21'),
      count: formatNumber(4),
    }))
    const sent = document.querySelector('[data-stats-week="sent"]')
    expect(sent?.textContent).toContain(formatNumber(4))
    expect(sent?.textContent).toContain(t('email.stats.week_day', {
      date: formatDateKey('2026-10-23'),
      count: formatNumber(2),
    }))
  })

  it('reports a failed read and reads again when the reader retries', async () => {
    const getStats = vi.spyOn(api.email, 'getStats')
      .mockRejectedValueOnce(new Error('stats offline'))
      .mockResolvedValueOnce(stats)
    view = renderElement(createElement(StatsPage, { accountId: 'a1' }))
    await settle()
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain(t('email.stats.error'))
    expect(alert?.textContent).toContain('stats offline')
    act(() => { button(t('common.retry')).click() })
    await settle()
    expect(getStats).toHaveBeenCalledTimes(2)
    expect(kpiText('total')).toContain(formatNumber(13))
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows the empty state when the mailbox holds nothing', async () => {
    vi.spyOn(api.email, 'getStats').mockResolvedValue(emptyStats)
    view = renderElement(createElement(StatsPage, { accountId: 'a1' }))
    await settle()
    expect(document.body.textContent).toContain(t('email.stats.empty'))
    expect(document.body.textContent).toContain(t('email.stats.empty_hint'))
    expect(document.querySelector('[data-stats-kpi]')).toBeNull()
  })
})
