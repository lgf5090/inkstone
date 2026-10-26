/**
 * The attachment hub's scope registry.
 *
 * Every app module that owns files registers here, and the registration is the only per-app
 * difference the hub carries: it says which table holds the rows, which object-key prefix new
 * uploads land under, and which path serves the bytes. Nothing else in the hub branches on the
 * application.
 *
 * The scope reaches the worker from a URL segment, so it is validated against this list rather
 * than trusted: an unvalidated prefix would let one account write objects into another's namespace
 * (`user_id` is the segment that keeps them apart), and an unvalidated table name would be an SQL
 * injection dressed up as configuration.
 */

export const ATTACHMENT_SCOPES = ['notes', 'todos', 'memos', 'chat', 'email', 'calendar'] as const

export type AttachmentScope = (typeof ATTACHMENT_SCOPES)[number]

/** The table a scope's rows live in, as a literal union so it can be interpolated into SQL safely. */
export type AttachmentScopeTable = 'attachments' | 'memos_attachments' | 'chat_attachments' | 'email_attachments'

export interface AttachmentScopeDescriptor {
  readonly id: AttachmentScope
  /** First path segment of every object this scope writes. */
  readonly prefix: string
  readonly table: AttachmentScopeTable
  /**
   * Where the bytes are served from.
   *
   * This string is already baked into stored note and memo bodies, into backup manifests and into
   * the restore path's matching regex, so it is a read address, not a routing choice: re-basing it
   * is a content migration, and the hub deliberately keeps serving through the existing doors.
   */
  readonly urlBase: string
  /**
   * The column pointing at whichever object currently claims this file, or null when no such
   * column exists. Chat keeps its links on the turn that consumed the file instead, which is why
   * the hub asks each scope a different question about liveness.
   */
  readonly ownerColumn: string | null
  /** The column holding the object key. Memos and chat name it differently and store it per row. */
  readonly keyColumn: string
  /** Chat records keep no dimensions, so the inspector's size line has to know when to stay quiet. */
  readonly hasDimensions: boolean
  /**
   * Whether the scope's rows share the table that notes writes.
   *
   * Task uploads have always been ordinary rows here, distinguished only by a null `note_id` —
   * which is also what a note's file looks like once its note is trashed, so the split has to be
   * made by the `scope` column and cannot be inferred at read time.
   */
  readonly sharesNotesTable: boolean
}

export const ATTACHMENT_SCOPE_DESCRIPTORS = {
  notes: {
    id: 'notes',
    prefix: 'notes',
    table: 'attachments',
    urlBase: '/api/files',
    ownerColumn: 'note_id',
    keyColumn: 'object_key',
    hasDimensions: true,
    sharesNotesTable: true,
  },
  todos: {
    id: 'todos',
    prefix: 'todos',
    table: 'attachments',
    urlBase: '/api/files',
    ownerColumn: 'note_id',
    keyColumn: 'object_key',
    hasDimensions: true,
    sharesNotesTable: true,
  },
  calendar: {
    id: 'calendar',
    prefix: 'calendar',
    table: 'attachments',
    urlBase: '/api/files',
    ownerColumn: 'note_id',
    keyColumn: 'object_key',
    hasDimensions: true,
    sharesNotesTable: true,
  },
  memos: {
    id: 'memos',
    prefix: 'memos',
    table: 'memos_attachments',
    urlBase: '/api/memos/files',
    ownerColumn: 'memo_id',
    keyColumn: 'storage_key',
    hasDimensions: true,
    sharesNotesTable: false,
  },
  chat: {
    id: 'chat',
    prefix: 'chat',
    table: 'chat_attachments',
    urlBase: '/api/assistant/files',
    ownerColumn: null,
    keyColumn: 'key',
    hasDimensions: false,
    sharesNotesTable: false,
  },
  email: {
    id: 'email',
    prefix: 'mail',
    table: 'email_attachments',
    urlBase: '/api/email/files',
    ownerColumn: 'email_id',
    keyColumn: 'object_key',
    hasDimensions: true,
    sharesNotesTable: false,
  },
} as const satisfies Record<AttachmentScope, AttachmentScopeDescriptor>


export const ATTACHMENT_SCOPE_LIST: readonly AttachmentScope[] = ATTACHMENT_SCOPES

export function isAttachmentScope(value: unknown): value is AttachmentScope {
  return typeof value === 'string' && (ATTACHMENT_SCOPES as readonly string[]).includes(value)
}

export function attachmentScope(value: unknown): AttachmentScopeDescriptor {
  if (!isAttachmentScope(value)) {
    throw new Error(`Unknown attachment scope: ${String(value)}`)
  }
  return ATTACHMENT_SCOPE_DESCRIPTORS[value]
}

/**
 * The SQL that narrows a query to one scope's rows.
 *
 * Only notes and todos share a table, so only they need a discriminator; memos and chat are already
 * separated by which table they are in, and filtering them on a column they do not have would fail.
 *
 * The value is inlined rather than bound because it comes from this module's own closed union and
 * never from a caller — a scope that failed validation cannot reach here — and because a bound
 * parameter that some branches of the fragment omit would leave callers counting placeholders they
 * do not all use.
 */
export function scopeColumnFilter(scope: AttachmentScope): string {
  const descriptor = ATTACHMENT_SCOPE_DESCRIPTORS[scope]
  return descriptor.sharesNotesTable ? `scope = '${descriptor.id}'` : '1 = 1'
}


