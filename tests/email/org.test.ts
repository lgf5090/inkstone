import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  emailFolderDepth,
  emailFolderDepthAllowed,
  emailFolderDescendantIds,
  emailFolderNameTaken,
  emailFolderSubtreeHeight,
  emailFolderTree,
  emailFolderWouldCycle,
  flattenEmailFolderTree,
} from '../../src/shared/email/folders'
import {
  emailTagAncestorPaths,
  emailTagLeafName,
  emailTagParentPath,
  emailTagPathTaken,
  isValidEmailTagPath,
  normalizeEmailTagPath,
} from '../../src/shared/email/tags'
import type { EmailFolder } from '../../src/shared/email/model'
import { applyMailboxMigrations } from '../../src/worker/email/mailbox-schema'
import { MailboxStore, type EmailData } from '../../src/worker/email/mailbox-store'
import { makeSqlExec } from '../doubles/do-sqlite'

const DAY_MS = 24 * 60 * 60 * 1000

let sqlite: DatabaseSync
let store: MailboxStore

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  const sql = makeSqlExec(sqlite)
  applyMailboxMigrations(sql)
  store = new MailboxStore(sql)
})

function message(id: string, overrides: Omit<Partial<EmailData>, 'id'> = {}): EmailData {
  return {
    id,
    subject: 'Subject',
    sender: 'sender@example.com',
    recipient: 'me@example.com',
    date: Date.now(),
    body: '<p>Hello</p>',
    ...overrides,
  }
}

function folderRefs(): Array<{ id: string; name: string; parentId: string | null; sortOrder: number }> {
  return store.getFolders().map((folder) => ({
    id: folder.id,
    name: folder.name,
    parentId: folder.parent_id,
    sortOrder: folder.sort_order,
  }))
}

describe('shared folder helpers', () => {
  const folders: EmailFolder[] = [
    { id: 'root', name: 'Root', isDeletable: true, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
    { id: 'child', name: 'Child', isDeletable: true, unreadCount: 0, parentId: 'root', color: null, sortOrder: 0 },
    { id: 'grand', name: 'Grand', isDeletable: true, unreadCount: 0, parentId: 'child', color: null, sortOrder: 0 },
    { id: 'other', name: 'Other', isDeletable: true, unreadCount: 0, parentId: null, color: null, sortOrder: 1 },
  ]

  it('builds and flattens a folder tree with depths', () => {
    const tree = emailFolderTree(folders)
    expect(tree.map((node) => node.folder.id)).toEqual(['root', 'other'])
    expect(tree[0]!.children[0]!.folder.id).toBe('child')
    expect(tree[0]!.children[0]!.depth).toBe(1)
    expect(tree[0]!.children[0]!.children[0]!.depth).toBe(2)
    expect(flattenEmailFolderTree(tree, new Set(['root'])).map((node) => node.folder.id))
      .toEqual(['root', 'child', 'other'])
    expect(flattenEmailFolderTree(tree, new Set(['root', 'child'])).map((node) => node.folder.id))
      .toEqual(['root', 'child', 'grand', 'other'])
  })

  it('measures descendants, depth and cycles', () => {
    expect(emailFolderDescendantIds(folders, 'root')).toEqual(['child', 'grand'])
    expect(emailFolderDepth(folders, 'grand')).toBe(3)
    expect(emailFolderSubtreeHeight(folders, 'root')).toBe(3)
    expect(emailFolderWouldCycle(folders, 'root', 'grand')).toBe(true)
    expect(emailFolderWouldCycle(folders, 'root', 'root')).toBe(true)
    expect(emailFolderWouldCycle(folders, 'root', 'other')).toBe(false)
    expect(emailFolderDepthAllowed(folders, 'grand')).toBe(true)
  })

  it('keeps names unique per parent only', () => {
    expect(emailFolderNameTaken(folders, null, 'root')).toBe(true)
    expect(emailFolderNameTaken(folders, null, 'Root', 'root')).toBe(false)
    expect(emailFolderNameTaken(folders, 'root', 'child')).toBe(true)
    expect(emailFolderNameTaken(folders, 'other', 'child')).toBe(false)
  })
})

describe('shared tag path helpers', () => {
  it('normalizes and validates hierarchical tag paths', () => {
    expect(normalizeEmailTagPath(' work / meeting ')).toBe('work/meeting')
    expect(normalizeEmailTagPath('a//b/')).toBe('a/b')
    expect(isValidEmailTagPath('work/meeting')).toBe(true)
    expect(isValidEmailTagPath('   ')).toBe(false)
    expect(isValidEmailTagPath(`a/${'x'.repeat(61)}`)).toBe(false)
    expect(isValidEmailTagPath('bad\\path')).toBe(false)
    expect(emailTagParentPath('work/meeting')).toBe('work')
    expect(emailTagParentPath('work')).toBeNull()
    expect(emailTagLeafName('work/meeting')).toBe('meeting')
    expect(emailTagAncestorPaths('a/b/c')).toEqual(['a', 'a/b'])
  })

  it('detects duplicate paths case-insensitively', () => {
    const tags = [{ id: '1', name: 'Work' }, { id: '2', name: 'work/meeting' }]
    expect(emailTagPathTaken(tags, 'work')).toBe(true)
    expect(emailTagPathTaken(tags, 'WORK', '1')).toBe(false)
    expect(emailTagPathTaken(tags, 'work/meeting')).toBe(true)
  })
})

describe('mailbox migrations', () => {
  it('upgrades a migration 1 mailbox and stays idempotent', () => {
    const legacy = new DatabaseSync(':memory:')
    legacy.exec(`CREATE TABLE email_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    legacy.exec(`CREATE TABLE email_folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_deletable INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )`)
    legacy.exec(`CREATE UNIQUE INDEX idx_email_folders_name ON email_folders(name COLLATE NOCASE)`)
    legacy.exec(`CREATE TABLE email_messages (id TEXT PRIMARY KEY)`)
    legacy.exec(`INSERT INTO email_folders (id, name, is_deletable, created_at) VALUES
      ('inbox', 'Inbox', 0, 0), ('sent', 'Sent', 0, 0), ('draft', 'Drafts', 0, 0),
      ('archive', 'Archive', 0, 0), ('trash', 'Trash', 0, 0), ('spam', 'Spam', 0, 0),
      ('fold1', 'Projects', 1, 1000)`)
    legacy.exec(`INSERT INTO email_migrations (name, applied_at) VALUES ('1_initial_setup', 1)`)

    const sql = makeSqlExec(legacy)
    applyMailboxMigrations(sql)

    const columns = legacy.prepare(`PRAGMA table_info(email_folders)`).all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['parent_id', 'color', 'sort_order']),
    )
    const messageColumns = legacy.prepare(`PRAGMA table_info(email_messages)`).all() as Array<{ name: string }>
    expect(messageColumns.map((column) => column.name)).toContain('snoozed_until')
    const tables = legacy.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('email_tags', 'email_message_tags')`,
    ).all() as Array<{ name: string }>
    expect(tables.map((table) => table.name).sort()).toEqual(['email_message_tags', 'email_tags'])
    const upgraded = legacy.prepare(
      `SELECT parent_id, color, sort_order FROM email_folders WHERE id = 'fold1'`,
    ).get() as { parent_id: string | null; color: string | null; sort_order: number }
    expect(upgraded).toEqual({ parent_id: null, color: null, sort_order: 0 })
    const applied = legacy.prepare(`SELECT name FROM email_migrations ORDER BY name`).all() as Array<{ name: string }>
    expect(applied.map((row) => row.name)).toEqual([
      '1_initial_setup',
      '2_org_tags',
      '3_snooze',
      '4_inbound_rules',
      '5_email_templates',
    ])
    const ruleTables = legacy.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('email_filters', 'email_blocked_senders')`,
    ).all() as Array<{ name: string }>
    expect(ruleTables.map((table) => table.name).sort()).toEqual(['email_blocked_senders', 'email_filters'])
    const templateTables = legacy.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'email_templates'`,
    ).all() as Array<{ name: string }>
    expect(templateTables.map((table) => table.name)).toEqual(['email_templates'])

    applyMailboxMigrations(sql)
    const reapplied = legacy.prepare(`SELECT COUNT(*) AS total FROM email_migrations`).get() as { total: number }
    expect(reapplied.total).toBe(5)
    const folderCount = legacy.prepare(`SELECT COUNT(*) AS total FROM email_folders`).get() as { total: number }
    expect(folderCount.total).toBe(7)
  })
})

describe('nested folders', () => {
  it('creates nested folders with colors and sibling-only uniqueness', () => {
    const projects = store.createFolder('Projects', null, '#2563eb')
    expect(projects).toMatchObject({ parent_id: null, color: '#2563eb', sort_order: 0 })
    const backend = store.createFolder('Backend', projects!.id)
    expect(backend).toMatchObject({ parent_id: projects!.id, color: null, sort_order: 0 })
    const rootBackend = store.createFolder('Backend')
    expect(rootBackend).not.toBeNull()
    expect(rootBackend!.parent_id).toBeNull()
    expect(store.createFolder('backend', projects!.id)).toBeNull()

    const folders = store.getFolders()
    expect(folders.find((folder) => folder.id === backend!.id)?.parent_id).toBe(projects!.id)
    expect(folders.find((folder) => folder.id === projects!.id)?.unread_count).toBe(0)
  })

  it('rejects self, cycles and nesting beyond five levels', () => {
    const root = store.createFolder('Root')!
    const child = store.createFolder('Child', root.id)!
    expect(store.updateFolder(root.id, { parentId: root.id })).toBeNull()
    expect(store.updateFolder(root.id, { parentId: child.id })).toBeNull()
    expect(store.updateFolder(root.id, { name: 'Root two' })?.name).toBe('Root two')

    let parentId: string | null = null
    const chain: string[] = []
    for (let level = 0; level < 5; level++) {
      const created = store.createFolder(`Level ${level}`, parentId)
      expect(created).not.toBeNull()
      chain.push(created!.id)
      parentId = created!.id
    }
    expect(store.createFolder('Level 5', parentId)).toBeNull()
    expect(store.updateFolder(chain[0]!, { parentId: chain[4]! })).toBeNull()
    const leaf = store.createFolder('Leaf')!
    expect(store.updateFolder(leaf.id, { parentId: chain[3]! })?.parent_id).toBe(chain[3])
  })

  it('protects system folders from updates and deletes', () => {
    expect(store.updateFolder('inbox', { name: 'In' })).toBeNull()
    expect(store.updateFolder('inbox', { color: '#2563eb' })).toBeNull()
    expect(store.deleteFolder('inbox')).toBeNull()
  })

  it('promotes children and moves messages when a folder is deleted', () => {
    const parent = store.createFolder('Parent')!
    const child = store.createFolder('Child', parent.id)!
    const grandchild = store.createFolder('Grandchild', child.id)!
    store.createEmail(parent.id, message('parent-message'))
    store.createEmail(child.id, message('child-message'))

    expect(store.deleteFolder(parent.id)).toEqual({ deletedMessageIds: [] })
    const folders = store.getFolders()
    expect(folders.find((folder) => folder.id === child.id)?.parent_id).toBeNull()
    expect(folders.find((folder) => folder.id === grandchild.id)?.parent_id).toBe(child.id)
    expect(store.getEmail('parent-message')?.folder_id).toBe('inbox')
    expect(store.getEmail('child-message')?.folder_id).toBe(child.id)
  })

  it('removes tag assignments when a folder deletes its messages', () => {
    const folder = store.createFolder('Bulk')!
    const tag = store.createTag('bulk')!
    store.createEmail(folder.id, message('bulk-message'))
    expect(store.attachTag('bulk-message', tag.id)).toBe(true)

    expect(store.deleteFolder(folder.id, true)).toEqual({ deletedMessageIds: ['bulk-message'] })
    expect(store.getEmail('bulk-message')).toBeNull()
    expect(store.listTags().find((row) => row.id === tag.id)?.count).toBe(0)
  })

  it('renames promoted children when their name is already taken at the parent level', () => {
    const parent = store.createFolder('Holder')!
    const child = store.createFolder('Work', parent.id)!
    const existing = store.createFolder('Work')!

    expect(store.deleteFolder(parent.id)).toEqual({ deletedMessageIds: [] })
    const folders = store.getFolders()
    expect(folders.find((folder) => folder.id === existing.id)?.name).toBe('Work')
    expect(folders.find((folder) => folder.id === child.id)).toMatchObject({
      name: 'Work (2)',
      parent_id: null,
    })
  })
})

describe('message tags', () => {
  it('creates, renames and deletes tags without rewriting child paths', () => {
    const work = store.createTag('work')!
    const meeting = store.createTag('work/meeting', '#2563eb')!
    expect(meeting).toMatchObject({ name: 'work/meeting', color: '#2563eb', count: 0 })
    expect(store.createTag('WORK')).toBeNull()

    const renamed = store.updateTag(work.id, { name: 'job' })
    expect(renamed?.name).toBe('job')
    expect(store.listTags().map((tag) => tag.name).sort()).toEqual(['job', 'work/meeting'])
    expect(store.updateTag(work.id, { name: 'work/meeting' })).toBeNull()
    expect(store.findTagByPath('WORK/MEETING')?.id).toBe(meeting.id)

    expect(store.deleteTag(meeting.id)).toBe(true)
    expect(store.deleteTag(meeting.id)).toBe(false)
    expect(store.findTagByPath('work/meeting')).toBeNull()
  })

  it('attaches idempotently, counts live messages and filters lists and searches', () => {
    const work = store.createTag('work')!
    const meeting = store.createTag('work/meeting')!
    store.createEmail('inbox', message('m1'))
    store.createEmail('inbox', message('m2'))
    store.createEmail('archive', message('m3'))

    expect(store.attachTag('m1', work.id)).toBe(true)
    expect(store.attachTag('m1', work.id)).toBe(true)
    expect(store.attachTag('m2', meeting.id)).toBe(true)
    expect(store.attachTag('missing', work.id)).toBe(false)
    expect(store.attachTag('m1', 'missing')).toBe(false)

    expect(store.listTags().find((tag) => tag.id === work.id)?.count).toBe(1)
    expect(store.getEmails({ tag: 'work' }).map((row) => row.id)).toEqual(['m1'])
    expect(store.getEmails({ tag: 'WORK' }).map((row) => row.id)).toEqual(['m1'])
    expect(store.getEmails({ tag: 'work/meeting' }).map((row) => row.id)).toEqual(['m2'])
    expect(store.getEmails({ tag: 'work/meeting', folder: 'inbox' }).map((row) => row.id)).toEqual(['m2'])
    expect(store.getEmails({ tag: 'work/meeting', folder: 'archive' })).toEqual([])
    expect(store.countEmails({ tag: 'work' })).toBe(1)
    expect(store.searchEmails({ tag: 'work/meeting' }).map((row) => row.id)).toEqual(['m2'])
    expect(store.countSearchResults({ tag: 'work/meeting' })).toBe(1)

    store.trashEmail('m1')
    expect(store.listTags().find((tag) => tag.id === work.id)?.count).toBe(0)
    expect(store.getEmails({ tag: 'work' })).toEqual([])
    store.restoreEmail('m1')
    expect(store.listTags().find((tag) => tag.id === work.id)?.count).toBe(1)

    expect(store.detachTag('m1', meeting.id)).toBe(false)
    expect(store.detachTag('m1', work.id)).toBe(true)
    expect(store.detachTag('m1', work.id)).toBe(false)
    expect(store.listTags().find((tag) => tag.id === work.id)?.count).toBe(0)
  })

  it('removes assignments when a tag is deleted', () => {
    const tag = store.createTag('temporary')!
    store.createEmail('inbox', message('m1'))
    expect(store.attachTag('m1', tag.id)).toBe(true)
    expect(store.deleteTag(tag.id)).toBe(true)
    expect(store.getEmails({ tag: 'temporary' })).toEqual([])
    const rows = sqlite.prepare(`SELECT COUNT(*) AS total FROM email_message_tags`).get() as { total: number }
    expect(rows.total).toBe(0)
  })

  it('removes assignments when messages are permanently removed', () => {
    const tag = store.createTag('cleanup')!
    store.createEmail('inbox', message('m1'))
    store.createEmail('inbox', message('m2'))
    expect(store.attachTag('m1', tag.id)).toBe(true)
    expect(store.attachTag('m2', tag.id)).toBe(true)

    expect(store.deleteEmail('m1')).toBe(true)
    store.trashEmail('m2')
    expect(store.emptyTrash()).toEqual(['m2'])

    const rows = sqlite.prepare(`SELECT COUNT(*) AS total FROM email_message_tags`).get() as { total: number }
    expect(rows.total).toBe(0)
    expect(store.listTags().find((row) => row.id === tag.id)?.count).toBe(0)
  })
})

describe('mailbox stats', () => {
  it('counts folders, overview totals, trash and the last seven days', () => {
    const now = Date.UTC(2026, 9, 23, 12, 0, 0)
    const custom = store.createFolder('Custom')!
    store.createEmail('inbox', message('m1', { date: now - 60 * 60 * 1000, starred: true, hasAttachment: true }))
    store.createEmail('inbox', message('m2', { date: now - 2 * DAY_MS, read: true }))
    store.createEmail('archive', message('m3', { date: now - 8 * DAY_MS, read: true, starred: true }))
    store.createEmail('sent', message('m4', { date: now - 3 * 60 * 60 * 1000 }))
    store.createEmail('draft', message('m5', { date: now - 30 * 60 * 1000 }))
    store.createEmail('inbox', message('m6'))
    store.trashEmail('m6')
    store.createEmail(custom.id, message('m7', { date: now - DAY_MS, hasAttachment: true }))

    const stats = store.mailboxStats(now)
    expect(stats).toMatchObject({
      total: 6,
      read: 3,
      unread: 3,
      starred: 2,
      withAttachments: 2,
      sent: 1,
      draft: 1,
      trash: 1,
    })
    expect(stats.folders.find((folder) => folder.folderId === 'inbox')).toEqual({
      folderId: 'inbox',
      total: 2,
      read: 1,
      unread: 1,
      starred: 1,
      withAttachments: 1,
    })
    expect(stats.folders.find((folder) => folder.folderId === custom.id)).toEqual({
      folderId: custom.id,
      total: 1,
      read: 0,
      unread: 1,
      starred: 0,
      withAttachments: 1,
    })
    expect(stats.folders).toHaveLength(7)
    expect(stats.receivedLast7Days).toHaveLength(7)
    expect(stats.sentLast7Days).toHaveLength(7)
    expect(stats.receivedLast7Days.at(-1)).toEqual({ date: '2026-10-23', count: 1 })
    expect(stats.receivedLast7Days.reduce((total, day) => total + day.count, 0)).toBe(3)
    expect(stats.sentLast7Days.at(-1)).toEqual({ date: '2026-10-23', count: 1 })
    expect(stats.sentLast7Days.reduce((total, day) => total + day.count, 0)).toBe(1)
    expect('attachmentBytes' in stats).toBe(false)
  })
})

describe('folder ordering', () => {
  it('sorts system folders first, then siblings by sort order', () => {
    const parent = store.createFolder('Parent')!
    const second = store.createFolder('Second', parent.id)!
    const first = store.createFolder('First', parent.id)!
    store.updateFolder(second.id, { sortOrder: 1 })
    store.updateFolder(first.id, { sortOrder: 0 })

    expect(folderRefs().slice(0, 6).map((folder) => folder.id)).toEqual(
      ['inbox', 'sent', 'draft', 'archive', 'trash', 'spam'],
    )
    expect(folderRefs().filter((folder) => folder.parentId === parent.id).map((folder) => folder.name))
      .toEqual(['First', 'Second'])
  })
})
