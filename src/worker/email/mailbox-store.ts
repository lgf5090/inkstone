import { newId } from '../lib/id'
import { EMAIL_AUTO_DRAFT_LEASE_MS, EMAIL_PAGE_SIZE, EMAIL_MAX_PAGE_SIZE, EMAIL_SEND_RATE_LIMIT_DAY, EMAIL_SEND_RATE_LIMIT_HOUR } from '@shared/email/model'
import type { SqlExec } from './mailbox-schema'

export interface EmailData {
  id: string
  subject: string
  sender: string
  recipient: string
  cc?: string | null
  bcc?: string | null
  date: number
  body: string
  bodySource?: string | null
  read?: boolean
  starred?: boolean
  inReplyTo?: string | null
  emailReferences?: string | null
  threadId?: string | null
  messageId?: string | null
  rawHeaders?: string | null
  deliveryStatus?: string | null
  deliveryError?: string | null
  providerMessageId?: string | null
  attachmentsSkipped?: boolean
  hasAttachment?: boolean
  size?: number
}

export interface EmailRow {
  id: string
  folder_id: string
  subject: string
  sender: string
  recipient: string
  cc: string | null
  bcc: string | null
  date: number
  received_at: number
  read: number
  starred: number
  body: string
  body_source: string | null
  in_reply_to: string | null
  email_references: string | null
  thread_id: string | null
  message_id: string | null
  raw_headers: string | null
  delivery_status: string | null
  delivery_error: string | null
  provider_message_id: string | null
  attachments_skipped: number
  has_attachment: number
  size: number
  deleted_at: number | null
  created_at: number
  updated_at: number
}

export interface FolderRow {
  id: string
  name: string
  is_deletable: number
  created_at: number
  unread_count?: number
}

export interface FolderRestoreData {
  id: string
  name: string
  isDeletable: boolean
  createdAt: number
}

export interface EmailRestoreData extends EmailData {
  folderId: string
  receivedAt: number
  deletedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface ListOptions {
  folder?: string
  threadId?: string
  page?: number
  limit?: number
  sortColumn?: string
  sortDirection?: 'ASC' | 'DESC'
}

export interface SearchOptions {
  query?: string
  folder?: string
  from?: string
  to?: string
  subject?: string
  dateStart?: number
  dateEnd?: number
  isRead?: boolean
  isStarred?: boolean
  hasAttachment?: boolean
  page?: number
  limit?: number
}

export interface OperationClaim {
  status: 'claimed' | 'duplicate' | 'conflict'
  messageId?: string
}

const SORT_COLUMNS: Record<string, string> = {
  id: 'id',
  subject: 'subject',
  sender: 'sender',
  recipient: 'recipient',
  date: 'date',
  read: 'read',
  starred: 'starred',
}

const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
    LOWER(subject),
    'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
    're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function normalizeSubject(value: string): string {
  return value.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, '').trim().toLowerCase()
}

export class MailboxStore {
  constructor(
    private readonly sql: SqlExec,
    private readonly storage?: { transactionSync<T>(closure: () => T): T },
  ) {}

  private rows<T>(query: string, ...bindings: unknown[]): T[] {
    return [...this.sql.exec<T>(query, ...bindings)]
  }

  private one<T>(query: string, ...bindings: unknown[]): T | null {
    return this.rows<T>(query, ...bindings)[0] ?? null
  }

  getFolders(): FolderRow[] {
    return this.rows<FolderRow>(
      `SELECT f.id, f.name, f.is_deletable, f.created_at,
              COALESCE(SUM(CASE WHEN m.read = 0 AND m.deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS unread_count
         FROM email_folders f
         LEFT JOIN email_messages m ON m.folder_id = f.id
        GROUP BY f.id, f.name, f.is_deletable, f.created_at
        ORDER BY CASE f.id
          WHEN 'inbox' THEN 0 WHEN 'sent' THEN 1 WHEN 'draft' THEN 2
          WHEN 'archive' THEN 3 WHEN 'trash' THEN 4 WHEN 'spam' THEN 5 ELSE 6 END,
          f.created_at ASC`,
    )
  }

  createFolder(name: string): FolderRow | null {
    const existing = this.one<FolderRow>(`SELECT * FROM email_folders WHERE name = ?1 COLLATE NOCASE`, name)
    if (existing) return null
    const id = newId()
    this.sql.exec(
      `INSERT INTO email_folders (id, name, is_deletable, created_at) VALUES (?1, ?2, 1, ?3)`,
      id,
      name,
      Date.now(),
    )
    return this.one<FolderRow>(`SELECT * FROM email_folders WHERE id = ?1`, id)
  }

  updateFolder(id: string, name: string): FolderRow | null {
    const existing = this.one<FolderRow>(
      `SELECT * FROM email_folders WHERE name = ?1 COLLATE NOCASE AND id != ?2`,
      name,
      id,
    )
    if (existing) return null
    this.sql.exec(`UPDATE email_folders SET name = ?1 WHERE id = ?2 AND is_deletable = 1`, name, id)
    return this.one<FolderRow>(`SELECT * FROM email_folders WHERE id = ?1`, id)
  }

  deleteFolder(id: string, deleteEmails = false): { deletedMessageIds: string[] } | null {
    const folder = this.one<FolderRow>(`SELECT * FROM email_folders WHERE id = ?1`, id)
    if (!folder || folder.is_deletable === 0) return null
    const deletedMessageIds = deleteEmails
      ? this.rows<{ id: string }>(`SELECT id FROM email_messages WHERE folder_id = ?1`, id).map((row) => row.id)
      : []
    const run = () => {
      if (deleteEmails) this.sql.exec(`DELETE FROM email_messages WHERE folder_id = ?1`, id)
      else this.sql.exec(`UPDATE email_messages SET folder_id = 'inbox', updated_at = ?1 WHERE folder_id = ?2`, Date.now(), id)
      this.sql.exec(`DELETE FROM email_folders WHERE id = ?1`, id)
    }
    if (this.storage) this.storage.transactionSync(run)
    else run()
    return { deletedMessageIds }
  }

  listAllEmails(): EmailRow[] {
    return this.rows<EmailRow>(`SELECT * FROM email_messages ORDER BY id ASC`)
  }

  importFolder(folder: FolderRestoreData): boolean {
    const existing = this.one<{ id: string }>(`SELECT id FROM email_folders WHERE id = ?1`, folder.id)
    if (existing) return false
    const named = this.one<{ id: string }>(
      `SELECT id FROM email_folders WHERE name = ?1 COLLATE NOCASE`,
      folder.name,
    )
    if (named) return false
    this.sql.exec(
      `INSERT INTO email_folders (id, name, is_deletable, created_at) VALUES (?1, ?2, ?3, ?4)`,
      folder.id,
      folder.name,
      folder.isDeletable ? 1 : 0,
      folder.createdAt,
    )
    return true
  }

  importEmail(email: EmailRestoreData): boolean {
    const existing = this.one<{ id: string }>(`SELECT id FROM email_messages WHERE id = ?1`, email.id)
    if (existing) return false
    const folder = this.one<{ id: string }>(`SELECT id FROM email_folders WHERE id = ?1`, email.folderId)
    if (!folder) return false
    this.sql.exec(
      `INSERT INTO email_messages (
         id, folder_id, subject, sender, recipient, cc, bcc, date, received_at,
         read, starred, body, body_source, in_reply_to, email_references, thread_id,
         message_id, raw_headers, delivery_status, delivery_error, provider_message_id,
         attachments_skipped, has_attachment, size, deleted_at, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
         ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27)`,
      email.id,
      email.folderId,
      email.subject,
      email.sender,
      email.recipient,
      email.cc ?? null,
      email.bcc ?? null,
      email.date,
      email.receivedAt,
      email.read ? 1 : 0,
      email.starred ? 1 : 0,
      email.body,
      email.bodySource ?? null,
      email.inReplyTo ?? null,
      email.emailReferences ?? null,
      email.threadId ?? null,
      email.messageId ?? null,
      email.rawHeaders ?? null,
      email.deliveryStatus ?? null,
      email.deliveryError ?? null,
      email.providerMessageId ?? null,
      email.attachmentsSkipped ? 1 : 0,
      email.hasAttachment ? 1 : 0,
      email.size ?? 0,
      email.deletedAt,
      email.createdAt,
      email.updatedAt,
    )
    return true
  }

  getEmails(options: ListOptions = {}): EmailRow[] {
    const page = Math.max(1, Math.trunc(options.page ?? 1))
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? EMAIL_PAGE_SIZE), 1), EMAIL_MAX_PAGE_SIZE)
    const sortColumn = SORT_COLUMNS[options.sortColumn ?? 'date'] ?? 'date'
    const direction = options.sortDirection === 'ASC' ? 'ASC' : 'DESC'
    const clauses = ['deleted_at IS NULL']
    const bindings: unknown[] = []
    if (options.folder) {
      clauses.push(`folder_id = (SELECT id FROM email_folders WHERE id = ? OR name = ? COLLATE NOCASE LIMIT 1)`)
      bindings.push(options.folder, options.folder)
    }
    if (options.threadId) {
      clauses.push(`thread_id = ?`)
      bindings.push(options.threadId)
    }
    bindings.push(limit, (page - 1) * limit)
    return this.rows<EmailRow>(
      `SELECT *, SUBSTR(body, 1, 300) AS snippet FROM email_messages WHERE ${clauses.join(' AND ')}
        ORDER BY ${sortColumn} ${direction}, id ${direction} LIMIT ? OFFSET ?`,
      ...bindings,
    )
  }

  countEmails(options: { folder?: string; threadId?: string } = {}): number {
    const clauses = ['deleted_at IS NULL']
    const bindings: unknown[] = []
    if (options.folder) {
      clauses.push(`folder_id = (SELECT id FROM email_folders WHERE id = ? OR name = ? COLLATE NOCASE LIMIT 1)`)
      bindings.push(options.folder, options.folder)
    }
    if (options.threadId) {
      clauses.push(`thread_id = ?`)
      bindings.push(options.threadId)
    }
    const row = this.one<{ total: number }>(
      `SELECT COUNT(*) AS total FROM email_messages WHERE ${clauses.join(' AND ')}`,
      ...bindings,
    )
    return Number(row?.total ?? 0)
  }

  getThreadedEmails(options: ListOptions = {}): Record<string, unknown>[] {
    if (!options.folder) return this.getEmails(options) as unknown as Record<string, unknown>[]
    const page = Math.max(1, Math.trunc(options.page ?? 1))
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? EMAIL_PAGE_SIZE), 1), EMAIL_MAX_PAGE_SIZE)
    const offset = (page - 1) * limit
    if (options.folder === 'draft') {
      return this.rows<Record<string, unknown>>(
        `WITH folder_emails AS (
           SELECT *, COALESCE(in_reply_to, id) AS draft_group_key
             FROM email_messages
            WHERE deleted_at IS NULL
              AND folder_id = (SELECT id FROM email_folders WHERE id = ?1 OR name = ?1 COLLATE NOCASE LIMIT 1)
         ),
         draft_stats AS (
           SELECT draft_group_key, COUNT(*) AS thread_count,
                  SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS thread_unread_count,
                  GROUP_CONCAT(DISTINCT sender) AS participants
             FROM folder_emails GROUP BY draft_group_key
         ),
         latest_per_group AS (
           SELECT fe.*, ROW_NUMBER() OVER (PARTITION BY fe.draft_group_key ORDER BY fe.date DESC) AS rn
             FROM folder_emails fe
         )
         SELECT lp.id, lp.subject, lp.sender, lp.recipient, lp.date,
                lp.read, lp.starred, lp.thread_id, lp.folder_id,
                lp.cc, lp.bcc, lp.has_attachment, lp.delivery_status,
                lp.in_reply_to, lp.email_references,
                SUBSTR(lp.body, 1, 300) AS snippet,
                ds.thread_count, ds.thread_unread_count, ds.participants
           FROM latest_per_group lp
           JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
          WHERE lp.rn = 1
          ORDER BY lp.date DESC LIMIT ?2 OFFSET ?3`,
        options.folder,
        limit,
        offset,
      )
    }
    return this.rows<Record<string, unknown>>(
      `WITH folder_emails AS (
         SELECT *, COALESCE(thread_id, id) AS raw_thread_id,
                ${NORMALIZED_SUBJECT_SQL} AS normalized_subject
           FROM email_messages
          WHERE deleted_at IS NULL
            AND folder_id = (SELECT id FROM email_folders WHERE id = ?1 OR name = ?1 COLLATE NOCASE LIMIT 1)
       ),
       thread_to_conversation AS (
         SELECT raw_thread_id, normalized_subject,
                CASE WHEN thread_id IS NOT NULL THEN raw_thread_id
                     ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject) END AS conversation_id
           FROM folder_emails
          GROUP BY raw_thread_id, normalized_subject, thread_id
       ),
       all_emails_with_conversation AS (
         SELECT e.*, COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) AS conversation_id
           FROM email_messages e
           LEFT JOIN thread_to_conversation tc ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
          WHERE e.deleted_at IS NULL
       ),
       conversation_stats AS (
         SELECT conversation_id, COUNT(*) AS thread_count,
                SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS thread_unread_count,
                SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) AS thread_read_count,
                GROUP_CONCAT(DISTINCT sender) AS participants,
                SUM(CASE WHEN folder_id = 'draft' THEN 1 ELSE 0 END) AS has_draft
           FROM all_emails_with_conversation
          WHERE conversation_id IN (
            SELECT DISTINCT conversation_id FROM all_emails_with_conversation
             WHERE folder_id = (SELECT id FROM email_folders WHERE id = ?1 OR name = ?1 COLLATE NOCASE LIMIT 1)
          )
          GROUP BY conversation_id
       ),
       latest_message_per_conversation AS (
         SELECT conversation_id, folder_id,
                ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) AS rn
           FROM all_emails_with_conversation
       ),
       latest_in_folder AS (
         SELECT fe.*, COALESCE(tc.conversation_id, fe.raw_thread_id) AS conversation_id,
                ROW_NUMBER() OVER (PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id) ORDER BY fe.date DESC) AS rn
           FROM folder_emails fe
           LEFT JOIN thread_to_conversation tc ON fe.raw_thread_id = tc.raw_thread_id
       )
       SELECT lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
              lif.read, lif.starred, lif.thread_id, lif.folder_id,
              lif.cc, lif.bcc, lif.has_attachment, lif.delivery_status,
              lif.in_reply_to, lif.email_references,
              SUBSTR(lif.body, 1, 300) AS snippet,
              cs.thread_count, cs.thread_unread_count, cs.participants,
              CASE WHEN lmc.folder_id != 'sent' AND lmc.folder_id != 'draft' AND cs.thread_read_count > 0
                   THEN 1 ELSE 0 END AS needs_reply,
              CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END AS has_draft
         FROM latest_in_folder lif
         JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
         LEFT JOIN latest_message_per_conversation lmc
           ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
        WHERE lif.rn = 1
        ORDER BY lif.date DESC LIMIT ?2 OFFSET ?3`,
      options.folder,
      limit,
      offset,
    )
  }

  countThreadedEmails(folder: string): number {
    if (folder === 'draft') {
      const row = this.one<{ total: number }>(
        `SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) AS total
           FROM email_messages
          WHERE deleted_at IS NULL
            AND folder_id = (SELECT id FROM email_folders WHERE id = ?1 OR name = ?1 COLLATE NOCASE LIMIT 1)`,
        folder,
      )
      return Number(row?.total ?? 0)
    }
    const row = this.one<{ total: number }>(
      `WITH folder_emails AS (
         SELECT COALESCE(thread_id, id) AS raw_thread_id, thread_id,
                ${NORMALIZED_SUBJECT_SQL} AS normalized_subject
           FROM email_messages
          WHERE deleted_at IS NULL
            AND folder_id = (SELECT id FROM email_folders WHERE id = ?1 OR name = ?1 COLLATE NOCASE LIMIT 1)
       ),
       thread_to_conversation AS (
         SELECT raw_thread_id,
                CASE WHEN thread_id IS NOT NULL THEN raw_thread_id
                     WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
                     ELSE raw_thread_id END AS conversation_id
           FROM folder_emails
          GROUP BY raw_thread_id, normalized_subject, thread_id
       )
       SELECT COUNT(DISTINCT conversation_id) AS total FROM thread_to_conversation`,
      folder,
    )
    return Number(row?.total ?? 0)
  }

  getEmail(id: string): EmailRow | null {
    return this.one<EmailRow>(`SELECT * FROM email_messages WHERE id = ?1 AND deleted_at IS NULL`, id)
  }

  getThreadEmails(threadId: string): EmailRow[] {
    return this.rows<EmailRow>(
      `SELECT * FROM email_messages
        WHERE thread_id = ?1 AND deleted_at IS NULL ORDER BY date ASC, id ASC`,
      threadId,
    )
  }

  updateEmail(id: string, patch: { read?: boolean; starred?: boolean }): EmailRow | null {
    const sets: string[] = []
    const bindings: unknown[] = []
    if (patch.read !== undefined) {
      sets.push('read = ?')
      bindings.push(patch.read ? 1 : 0)
    }
    if (patch.starred !== undefined) {
      sets.push('starred = ?')
      bindings.push(patch.starred ? 1 : 0)
    }
    if (!sets.length) return this.getEmail(id)
    sets.push('updated_at = ?')
    bindings.push(Date.now(), id)
    this.sql.exec(`UPDATE email_messages SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, ...bindings)
    return this.getEmail(id)
  }

  markThreadRead(threadId: string): void {
    this.sql.exec(
      `UPDATE email_messages SET read = 1, updated_at = ?1
        WHERE thread_id = ?2 AND deleted_at IS NULL AND read = 0`,
      Date.now(),
      threadId,
    )
  }

  trashEmail(id: string): string | null {
    const row = this.one<{ folder_id: string }>(
      `SELECT folder_id FROM email_messages WHERE id = ?1 AND deleted_at IS NULL`,
      id,
    )
    if (!row) return null
    const now = Date.now()
    this.sql.exec(
      `UPDATE email_messages SET folder_id = 'trash', deleted_at = ?1, updated_at = ?1
        WHERE id = ?2 AND deleted_at IS NULL`,
      now,
      id,
    )
    return row.folder_id
  }

  restoreEmail(id: string): boolean {
    const row = this.one<{ deleted_at: number | null }>(
      `SELECT deleted_at FROM email_messages WHERE id = ?1`,
      id,
    )
    if (!row?.deleted_at) return false
    const now = Date.now()
    this.sql.exec(
      `UPDATE email_messages SET folder_id = 'inbox', deleted_at = NULL, updated_at = ?1 WHERE id = ?2`,
      now,
      id,
    )
    return true
  }

  listTrash(options: { page?: number; limit?: number } = {}): EmailRow[] {
    const page = Math.max(1, Math.trunc(options.page ?? 1))
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? EMAIL_PAGE_SIZE), 1), EMAIL_MAX_PAGE_SIZE)
    return this.rows<EmailRow>(
      `SELECT *, SUBSTR(body, 1, 300) AS snippet FROM email_messages WHERE deleted_at IS NOT NULL
        ORDER BY deleted_at DESC, id DESC LIMIT ?1 OFFSET ?2`,
      limit,
      (page - 1) * limit,
    )
  }

  countTrash(): number {
    const row = this.one<{ total: number }>(`SELECT COUNT(*) AS total FROM email_messages WHERE deleted_at IS NOT NULL`)
    return Number(row?.total ?? 0)
  }

  emptyTrash(): string[] {
    const ids = this.rows<{ id: string }>(`SELECT id FROM email_messages WHERE deleted_at IS NOT NULL`).map((row) => row.id)
    if (ids.length) {
      this.sql.exec(`DELETE FROM email_messages WHERE deleted_at IS NOT NULL`)
    }
    return ids
  }

  purgeExpiredTrash(cutoff: number): string[] {
    const ids = this.rows<{ id: string }>(
      `SELECT id FROM email_messages WHERE deleted_at IS NOT NULL AND deleted_at < ?1`,
      cutoff,
    ).map((row) => row.id)
    if (ids.length) {
      this.sql.exec(`DELETE FROM email_messages WHERE deleted_at IS NOT NULL AND deleted_at < ?1`, cutoff)
    }
    return ids
  }

  deleteEmail(id: string): boolean {
    const row = this.one<{ id: string }>(`SELECT id FROM email_messages WHERE id = ?1`, id)
    if (!row) return false
    this.sql.exec(`DELETE FROM email_messages WHERE id = ?1`, id)
    return true
  }

  moveEmail(id: string, folderId: string): boolean {
    const folder = this.one<{ id: string }>(`SELECT id FROM email_folders WHERE id = ?1`, folderId)
    if (!folder) return false
    const message = this.one<{ id: string }>(
      `SELECT id FROM email_messages WHERE id = ?1 AND deleted_at IS NULL`,
      id,
    )
    if (!message) return false
    this.sql.exec(
      `UPDATE email_messages SET folder_id = ?1, deleted_at = NULL, updated_at = ?2 WHERE id = ?3`,
      folderId,
      Date.now(),
      id,
    )
    return true
  }

  searchEmails(options: SearchOptions): EmailRow[] {
    const built = this.buildSearch(options)
    const page = Math.max(1, Math.trunc(options.page ?? 1))
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? EMAIL_PAGE_SIZE), 1), EMAIL_MAX_PAGE_SIZE)
    return this.rows<EmailRow>(
      `SELECT e.*, SUBSTR(e.body, 1, 300) AS snippet, f.name AS folder_name FROM email_messages e
         LEFT JOIN email_folders f ON f.id = e.folder_id
        WHERE ${built.where}
        ORDER BY e.date DESC, e.id DESC LIMIT ? OFFSET ?`,
      ...built.bindings,
      limit,
      (page - 1) * limit,
    )
  }

  countSearchResults(options: SearchOptions): number {
    const built = this.buildSearch(options)
    const row = this.one<{ total: number }>(
      `SELECT COUNT(*) AS total FROM email_messages e WHERE ${built.where}`,
      ...built.bindings,
    )
    return Number(row?.total ?? 0)
  }

  private buildSearch(options: SearchOptions): { where: string; bindings: unknown[] } {
    const clauses = ['e.deleted_at IS NULL']
    const bindings: unknown[] = []
    const like = (value: string) => `%${escapeLike(value)}%`
    if (options.query) {
      const term = like(options.query)
      clauses.push(`(e.subject LIKE ? ESCAPE '\\' OR e.body LIKE ? ESCAPE '\\' OR e.sender LIKE ? ESCAPE '\\' OR e.recipient LIKE ? ESCAPE '\\' OR e.cc LIKE ? ESCAPE '\\' OR e.bcc LIKE ? ESCAPE '\\')`)
      bindings.push(term, term, term, term, term, term)
    }
    if (options.folder) {
      clauses.push(`e.folder_id = (SELECT id FROM email_folders WHERE id = ? OR name = ? COLLATE NOCASE LIMIT 1)`)
      bindings.push(options.folder, options.folder)
    }
    if (options.from) {
      clauses.push(`e.sender LIKE ? ESCAPE '\\'`)
      bindings.push(like(options.from))
    }
    if (options.to) {
      const term = like(options.to)
      clauses.push(`(e.recipient LIKE ? ESCAPE '\\' OR e.cc LIKE ? ESCAPE '\\' OR e.bcc LIKE ? ESCAPE '\\')`)
      bindings.push(term, term, term)
    }
    if (options.subject) {
      clauses.push(`e.subject LIKE ? ESCAPE '\\'`)
      bindings.push(like(options.subject))
    }
    if (options.dateStart !== undefined) {
      clauses.push(`e.date >= ?`)
      bindings.push(options.dateStart)
    }
    if (options.dateEnd !== undefined) {
      clauses.push(`e.date <= ?`)
      bindings.push(options.dateEnd)
    }
    if (options.isRead !== undefined) {
      clauses.push(`e.read = ?`)
      bindings.push(options.isRead ? 1 : 0)
    }
    if (options.isStarred !== undefined) {
      clauses.push(`e.starred = ?`)
      bindings.push(options.isStarred ? 1 : 0)
    }
    if (options.hasAttachment !== undefined) {
      clauses.push(`e.has_attachment = ?`)
      bindings.push(options.hasAttachment ? 1 : 0)
    }
    return { where: clauses.join(' AND '), bindings }
  }

  findThreadBySubject(subject: string, sender?: string): string | null {
    const normalized = normalizeSubject(subject)
    if (!normalized) return null
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    const rows = this.rows<{ thread_id: string; subject: string; senders: string; recipients: string }>(
      `SELECT thread_id, subject,
              GROUP_CONCAT(DISTINCT LOWER(sender)) AS senders,
              GROUP_CONCAT(DISTINCT LOWER(recipient)) AS recipients
         FROM email_messages
        WHERE thread_id IS NOT NULL AND thread_id != id AND date >= ?1 AND deleted_at IS NULL
        GROUP BY thread_id
        ORDER BY MAX(date) DESC LIMIT 50`,
      cutoff,
    )
    const normalizedSender = sender?.trim().toLowerCase()
    for (const row of rows) {
      if (normalizeSubject(row.subject) !== normalized) continue
      if (normalizedSender) {
        const participants = `${row.senders},${row.recipients}`
        if (!participants.includes(normalizedSender)) continue
      }
      return row.thread_id
    }
    return null
  }

  checkSendRateLimit(now = Date.now()): string | null {
    const hour = this.one<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM email_messages
        WHERE folder_id = 'sent' AND deleted_at IS NULL AND date >= ?1`,
      now - 60 * 60 * 1000,
    )
    if (Number(hour?.cnt ?? 0) >= EMAIL_SEND_RATE_LIMIT_HOUR) {
      return `Rate limit exceeded: max ${EMAIL_SEND_RATE_LIMIT_HOUR} emails per hour per mailbox`
    }
    const day = this.one<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM email_messages
        WHERE folder_id = 'sent' AND deleted_at IS NULL AND date >= ?1`,
      now - 24 * 60 * 60 * 1000,
    )
    if (Number(day?.cnt ?? 0) >= EMAIL_SEND_RATE_LIMIT_DAY) {
      return `Rate limit exceeded: max ${EMAIL_SEND_RATE_LIMIT_DAY} emails per day per mailbox`
    }
    return null
  }

  createEmail(folder: string, email: EmailData): boolean {
    const folderRow = this.one<{ id: string }>(
      `SELECT id FROM email_folders WHERE id = ?1 OR name = ?1 COLLATE NOCASE LIMIT 1`,
      folder,
    )
    if (!folderRow) return false
    const now = Date.now()
    const sent = folderRow.id === 'sent'
    this.sql.exec(
      `INSERT INTO email_messages (
         id, folder_id, subject, sender, recipient, cc, bcc, date, received_at,
         read, starred, body, body_source, in_reply_to, email_references, thread_id,
         message_id, raw_headers, delivery_status, delivery_error, provider_message_id,
         attachments_skipped, has_attachment, size, deleted_at, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
         ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, NULL, ?25, ?25)`,
      email.id,
      folderRow.id,
      email.subject,
      email.sender,
      email.recipient,
      email.cc ?? null,
      email.bcc ?? null,
      email.date,
      email.date,
      sent ? 1 : email.read ? 1 : 0,
      email.starred ? 1 : 0,
      email.body,
      email.bodySource ?? null,
      email.inReplyTo ?? null,
      email.emailReferences ?? null,
      email.threadId ?? null,
      email.messageId ?? null,
      email.rawHeaders ?? null,
      email.deliveryStatus ?? null,
      email.deliveryError ?? null,
      email.providerMessageId ?? null,
      email.attachmentsSkipped ? 1 : 0,
      email.hasAttachment ? 1 : 0,
      email.size ?? 0,
      now,
    )
    return true
  }

  saveDraft(draftId: string | null, email: EmailData): string | null {
    const id = draftId ?? email.id
    const existing = draftId ? this.one<{ id: string }>(`SELECT id FROM email_messages WHERE id = ?1`, draftId) : null
    const now = Date.now()
    if (existing) {
      this.sql.exec(
        `UPDATE email_messages SET folder_id = 'draft', subject = ?1, sender = ?2, recipient = ?3,
           cc = ?4, bcc = ?5, body = ?6, body_source = ?7, in_reply_to = ?8,
           thread_id = ?9, date = ?10, updated_at = ?10 WHERE id = ?11`,
        email.subject,
        email.sender,
        email.recipient,
        email.cc ?? null,
        email.bcc ?? null,
        email.body,
        email.bodySource ?? null,
        email.inReplyTo ?? null,
        email.threadId ?? null,
        email.date || now,
        id,
      )
      return id
    }
    if (!this.createEmail('draft', { ...email, id, date: email.date || now })) return null
    return id
  }

  sendDraft(draftId: string, fields: {
    body: string
    bodySource: string | null
    messageId: string
    date: number
    sender: string
    recipient: string
    cc: string | null
    bcc: string | null
    inReplyTo: string | null
    threadId: string | null
    emailReferences: string | null
    rawHeaders: string | null
    subject: string
  }): boolean {
    const existing = this.one<{ id: string }>(
      `SELECT id FROM email_messages WHERE id = ?1 AND folder_id = 'draft' AND deleted_at IS NULL`,
      draftId,
    )
    if (!existing) return false
    this.sql.exec(
      `UPDATE email_messages SET folder_id = 'sent', body = ?1, body_source = ?2, message_id = ?3,
         date = ?4, sender = ?5, recipient = ?6, cc = ?7, bcc = ?8, in_reply_to = ?9,
         thread_id = ?10, email_references = ?11, raw_headers = ?12, subject = ?13,
         read = 1, delivery_status = 'pending', delivery_error = NULL, updated_at = ?4
       WHERE id = ?14`,
      fields.body,
      fields.bodySource,
      fields.messageId,
      fields.date,
      fields.sender,
      fields.recipient,
      fields.cc,
      fields.bcc,
      fields.inReplyTo,
      fields.threadId,
      fields.emailReferences,
      fields.rawHeaders,
      fields.subject,
      draftId,
    )
    return true
  }

  setHasAttachment(id: string, value: boolean): void {
    this.sql.exec(
      `UPDATE email_messages SET has_attachment = ?1, updated_at = ?2 WHERE id = ?3`,
      value ? 1 : 0,
      Date.now(),
      id,
    )
  }

  updateDelivery(id: string, status: string, error: string | null, providerMessageId: string | null = null): void {
    this.sql.exec(
      `UPDATE email_messages SET delivery_status = ?1, delivery_error = ?2,
         provider_message_id = COALESCE(?3, provider_message_id), updated_at = ?4 WHERE id = ?5`,
      status,
      error,
      providerMessageId,
      Date.now(),
      id,
    )
  }

  claimInbound(messageKey: string, now = Date.now()): boolean {
    const existing = this.one<{ status: string; created_at: number }>(
      `SELECT status, created_at FROM email_inbound_claims WHERE message_key = ?1`,
      messageKey,
    )
    if (existing?.status === 'done') return false
    if (existing) {
      if (now - existing.created_at < EMAIL_AUTO_DRAFT_LEASE_MS) return false
      this.sql.exec(
        `UPDATE email_inbound_claims SET status = 'pending', created_at = ?1 WHERE message_key = ?2`,
        now,
        messageKey,
      )
      return true
    }
    this.sql.exec(
      `INSERT INTO email_inbound_claims (message_key, status, created_at) VALUES (?1, 'pending', ?2)`,
      messageKey,
      now,
    )
    return true
  }

  completeInbound(messageKey: string): void {
    this.sql.exec(
      `UPDATE email_inbound_claims SET status = 'done' WHERE message_key = ?1`,
      messageKey,
    )
    this.sql.exec(`DELETE FROM email_inbound_claims WHERE created_at < ?1`, Date.now() - 90 * 24 * 60 * 60 * 1000)
  }

  releaseInbound(messageKey: string): void {
    this.sql.exec(`DELETE FROM email_inbound_claims WHERE message_key = ?1`, messageKey)
  }

  claimOperation(operationId: string, requestHash: string, messageId: string): OperationClaim {
    const existing = this.one<{ request_hash: string; message_id: string }>(
      `SELECT request_hash, message_id FROM email_operations WHERE operation_id = ?1`,
      operationId,
    )
    if (existing) {
      return existing.request_hash === requestHash
        ? { status: 'duplicate', messageId: existing.message_id }
        : { status: 'conflict' }
    }
    this.sql.exec(
      `INSERT INTO email_operations (operation_id, request_hash, message_id, created_at) VALUES (?1, ?2, ?3, ?4)`,
      operationId,
      requestHash,
      messageId,
      Date.now(),
    )
    this.sql.exec(`DELETE FROM email_operations WHERE created_at < ?1`, Date.now() - 30 * 24 * 60 * 60 * 1000)
    return { status: 'claimed', messageId }
  }

  deleteAll(): void {
    for (const table of ['email_messages', 'email_folders', 'email_inbound_claims', 'email_operations']) {
      this.sql.exec(`DELETE FROM ${table}`)
    }
  }
}
