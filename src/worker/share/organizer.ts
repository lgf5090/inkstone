/**
 * The share hub's organizer: the rules a folder, a tag or a link's filing has to satisfy, and the
 * writes that apply them.
 *
 * This is the half that decides *whether* a write is allowed; `organizer-store.ts` holds the statements
 * and `routes/share-organizer.ts` the HTTP. Splitting it that way is what lets the tree-depth, sibling
 * uniqueness, tag-name and quota rules be the same ones the notebook's own organizer enforces
 * (`routes/folders.ts`, `routes/tags.ts`) without either one importing the other — the hub has to feel
 * like the rest of the app, and a hub that allowed a 40-level folder tree or a tag name with a space in
 * it would be an app with two answers to the same question.
 *
 * The filing rules and the records are coupled in one place on purpose: a share stores its folder by
 * *id* and its tags by *name*, so writing a tag list means resolving each name against this account's
 * `share_tags` rows. Storing a name nobody owns is how a published collection comes to cover nothing.
 */

import { LIMITS } from '@shared/constants'
import { normalizeOrganizerIcon, organizerColorOrNull } from '@shared/organizer-colors'
import { isUsableTagName } from '@shared/markdown-utils'
import type { ShareFolder, ShareTag } from '@shared/share-hub'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import {
  ShareOrganizerStore,
  type ShareFolderOrderRow,
  type ShareFolderPatchColumn,
  type ShareFolderRow,
  type ShareOrganizeColumn,
  type ShareOrganizeSnapshot,
  type ShareTagRow,
} from './organizer-store'
import { recordShareAudit, shareAuditDiff, shareAuditSnapshot, type ShareAuditEntry } from './audit'
import { parseShareTags, serializeShareTags } from './store'

/** The name a folder gets when the owner creates one without typing a name, as in the notebook. */
const DEFAULT_FOLDER_NAME = 'New folder'

/** The gap between two folder positions; the same spacing the notebook's tree leaves between rows. */
const POSITION_GAP = 1000

/**
 * How many links one batch request may name.
 *
 * The ceiling is a request-size guard, not a product rule: every action is one statement per chunk of
 * ids, and a body that named a hundred thousand notes would be a hundred thousand statements inside one
 * account's request. Two hundred is the most that fits the small body limit this route reads with — an
 * id is 26 characters, plus the quotes and commas — and it is well past any selection a hub screen can
 * put on screen. It is checked before the ids are deduplicated, so a body cannot buy room by repeating
 * them.
 */
export const MAX_BATCH_SHARE_IDS = 200

/** A folder write, as the route read it: the values are still whatever JSON held. */
export interface ShareFolderWrite {
  name?: unknown
  parentId?: unknown
  icon?: unknown
  color?: unknown
  position?: unknown
}

/**
 * A folder name: trimmed and bounded, or null when the request named none.
 *
 * Null is a real answer rather than a failure: creating a folder with an empty box is how the notebook
 * files a "New folder 3", while renaming one to nothing is a mistake the hub has to say so about. The
 * length test runs on the trimmed value because the unique sibling index compares what is stored.
 */
export function shareFolderName(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw ApiError.badRequest('name must be a string')
  const name = raw.trim()
  if (!name) return null
  if (name.length > LIMITS.folderNameMaxLength) {
    throw ApiError.badRequest(`Folder name cannot exceed ${LIMITS.folderNameMaxLength} characters`)
  }
  return name
}

/**
 * A tag name: leading hashes dropped, no spaces, bounded.
 *
 * The same rule the notebook's tags hold to (`isUsableTagName`), because a share's tag array is read by
 * the same sidebar filters and a name with a space in it cannot be selected by anything.
 */
export function shareTagName(raw: unknown): string {
  if (typeof raw !== 'string') throw ApiError.badRequest('name must be a string')
  const name = raw.trim().replace(/^#+/, '')
  if (!name) throw ApiError.badRequest('Tag name cannot be empty')
  if (name.length > LIMITS.tagNameMaxLength) {
    throw ApiError.badRequest(`Tag name cannot exceed ${LIMITS.tagNameMaxLength} characters`)
  }
  if (!isUsableTagName(name)) throw ApiError.badRequest('Tag names cannot contain spaces or #')
  return name
}

/** A colour from the shared ramp or a plain six-digit hex; anything else is refused before SQL. */
export function shareOrganizerColor(raw: unknown, label: string): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw ApiError.badRequest(`${label} must be a string or null`)
  const color = organizerColorOrNull(raw)
  if (!color) throw ApiError.badRequest(`${label} is not a supported color`)
  return color
}

/** An icon: the shared truncation rule, so a hub folder's icon cannot be a paragraph. */
export function shareOrganizerIcon(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw ApiError.badRequest('icon must be a string or null')
  return normalizeOrganizerIcon(raw)
}

/** The float a `position REAL` column holds, bounded to what the ordering arithmetic can survive. */
export function shareFolderPosition(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw ApiError.badRequest('position must be a finite number')
  }
  const bound = 1e15
  if (raw < -bound || raw > bound) throw ApiError.badRequest('position is out of range')
  return raw
}

/** Where a folder is going: null for the root, and only something shaped like an id may be a place. */
export function shareFolderParentId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw ApiError.badRequest('parentId must be a string or null')
  const parentId = raw.trim()
  if (!parentId) return null
  if (!isValidId(parentId)) throw ApiError.badRequest('parentId is not a valid folder id')
  return parentId
}

/** The note ids one batch body names: valid ids, deduplicated, inside the request ceiling. */
export function shareBatchNoteIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw ApiError.badRequest('noteIds must be an array')
  if (!raw.length) throw ApiError.badRequest('noteIds must name at least one note')
  if (raw.length > MAX_BATCH_SHARE_IDS) {
    throw ApiError.badRequest(`A batch can act on at most ${MAX_BATCH_SHARE_IDS} links at once`)
  }
  const seen = new Set<string>()
  for (const value of raw) {
    if (!isValidId(value)) throw ApiError.badRequest('noteIds must be valid note ids')
    seen.add(value)
  }
  return [...seen]
}

/** One boolean the request had to name, read as the flag the column holds. */
export function shareEnabledFlag(raw: unknown): boolean {
  if (typeof raw !== 'boolean') throw ApiError.badRequest('enabled must be a boolean')
  return raw
}

/**
 * The tag list a write asked for, as the names to store.
 *
 * Duplicated and bounded here, resolved against the account's records by the caller: the count limit is
 * about the shape of the list, and whether a name belongs to this account is a separate question with a
 * separate answer. The ceiling is measured against what arrived rather than what survived the dedupe —
 * a body that named thirty tags twice asked for thirty tags.
 */
export function shareTagList(raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw ApiError.badRequest('tags must be an array of tag names')
  if (raw.length > LIMITS.shareTagsMaxPerShare) {
    throw ApiError.badRequest(`A link can carry at most ${LIMITS.shareTagsMaxPerShare} tags`)
  }
  const seen = new Set<string>()
  for (const value of raw) seen.add(shareTagName(value))
  return [...seen]
}

/** How deep a folder sits, counting itself: the same walk the notebook's tree does. */
export function shareFolderDepth(rows: readonly ShareFolderOrderRow[], id: string): number {
  const parents = new Map(rows.map((row) => [row.id, row.parent_id]))
  let depth = 1
  const guard = new Set<string>([id])
  let cursor = parents.get(id) ?? null
  while (cursor && !guard.has(cursor) && depth < 64) {
    guard.add(cursor)
    cursor = parents.get(cursor) ?? null
    depth += 1
  }
  return depth
}

/** How tall the tree under a folder is, so a move can be measured before it is made. */
export function shareFolderSubtreeHeight(rows: readonly ShareFolderOrderRow[], rootId: string): number {
  const children = new Map<string, string[]>()
  for (const row of rows) {
    if (!row.parent_id) continue
    const list = children.get(row.parent_id)
    if (list) list.push(row.id)
    else children.set(row.parent_id, [row.id])
  }
  let height = 1
  const stack: Array<[string, number]> = [[rootId, 1]]
  const visited = new Set<string>()
  while (stack.length) {
    const [id, depth] = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    height = Math.max(height, depth)
    for (const child of children.get(id) ?? []) stack.push([child, depth + 1])
  }
  return height
}

/**
 * The parent a write may name.
 *
 * Four rules, all of them the notebook's: the parent has to exist and be this account's (a foreign id
 * is simply not in the account's own tree), it cannot be the folder itself or one of its descendants,
 * the walk up must not already contain a cycle, and the levels below the new spot have to stay inside
 * `LIMITS.folderDepthMax`. Depth counts levels, so a new folder under a parent at the ceiling is the
 * one that gets refused, and a move takes the height of the subtree coming with it.
 */
export function resolveShareFolderParent(
  rows: readonly ShareFolderOrderRow[],
  parentId: string | null,
  selfId?: string,
): string | null {
  if (!parentId) return null
  const byId = new Map(rows.map((row) => [row.id, row]))
  if (!byId.has(parentId)) throw ApiError.badRequest('The parent folder does not exist')
  const parents = new Map(rows.map((row) => [row.id, row.parent_id]))
  const visited = new Set<string>()
  let cursor: string | null = parentId
  while (cursor) {
    if (cursor === selfId) throw ApiError.badRequest('A folder cannot be moved into its own descendant')
    if (visited.has(cursor)) throw ApiError.badRequest('The folder hierarchy contains a cycle')
    visited.add(cursor)
    cursor = parents.get(cursor) ?? null
  }
  const below = selfId ? shareFolderSubtreeHeight(rows, selfId) : 1
  if (shareFolderDepth(rows, parentId) + below > LIMITS.folderDepthMax) {
    throw ApiError.badRequest(`Folder depth cannot exceed ${LIMITS.folderDepthMax} levels`)
  }
  return parentId
}

/** A name for a folder created without one, kept unique among its siblings the way the notebook does. */
export function availableShareFolderName(
  folders: readonly ShareFolderRow[],
  parentId: string | null,
  base = DEFAULT_FOLDER_NAME,
): string {
  const names = new Set(
    folders.filter((folder) => (folder.parent_id ?? null) === parentId).map((folder) => folder.name.toLocaleLowerCase()),
  )
  if (!names.has(base.toLocaleLowerCase())) return base
  let suffix = 2
  while (names.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix += 1
  return `${base} ${suffix}`
}

/** Where a new folder lands: after everything already in the place it is going. */
export function nextShareFolderPosition(folders: readonly ShareFolderRow[], parentId: string | null): number {
  const siblings = folders.filter((folder) => (folder.parent_id ?? null) === parentId)
  if (!siblings.length) return POSITION_GAP
  return Math.max(...siblings.map((folder) => folder.position)) + POSITION_GAP
}

/** A folder row, in the shape the hub's client holds. */
export function toShareFolder(row: ShareFolderRow): ShareFolder {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** A tag row, in the shape the hub's client holds. */
export function toShareTag(row: ShareTagRow): ShareTag {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    isPinned: row.is_pinned === 1,
    createdAt: row.created_at,
  }
}

/** What an organize write names: the folder to file under and the tag list to store. */
export interface ShareFilingWrite {
  folderId?: string | null
  tags?: readonly string[]
}

/**
 * The two filing fields, read the same way by both organize endpoints.
 *
 * A field the body left out is a field the write leaves alone; `null` is the owner saying "unfile it".
 * Those have to stay different or a batch that only carries tags would clear every folder in the
 * selection, which is the one thing an owner never means.
 */
export function shareFilingWrite(body: Record<string, unknown>): ShareFilingWrite {
  const filing: ShareFilingWrite = {}
  if (body.folderId !== undefined) {
    if (body.folderId === null) filing.folderId = null
    else if (typeof body.folderId !== 'string') throw ApiError.badRequest('folderId must be a string or null')
    else filing.folderId = body.folderId.trim() || null
  }
  if (body.tags !== undefined) filing.tags = shareTagList(body.tags)
  return filing
}

/** The filing of one link, read back after the write: what the row holds, not what was asked for. */
export interface ShareFilingResult {
  noteId: string
  slug: string
  folderId: string | null
  tags: string[]
}

/**
 * The hub's organizer, bound to the account the request authenticated as.
 *
 * Every method takes input the route has already read and answers with rows, an `ApiError`, or the count
 * the route reports. The link writes record their own history: a filing change is the kind of edit an
 * owner asks "when did this stop being public?" about, and a trail that only covered the passcode would
 * answer that question with nothing.
 */
export class ShareOrganizer {
  private readonly store: ShareOrganizerStore

  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {
    this.store = new ShareOrganizerStore(db, userId)
  }

  // --- folders -------------------------------------------------------------

  listFolders(): Promise<ShareFolderRow[]> {
    return this.store.listFolders()
  }

  async createFolder(write: ShareFolderWrite): Promise<ShareFolderRow> {
    const rows = await this.store.folderOrderRows()
    const all = await this.store.listFolders()
    const parentId = resolveShareFolderParent(rows, shareFolderParentId(write.parentId))
    if (await this.store.countFolders() >= LIMITS.shareFoldersMaxPerUser) {
      throw ApiError.badRequest(`An account can hold at most ${LIMITS.shareFoldersMaxPerUser} share folders`)
    }
    const named = shareFolderName(write.name)
    return this.store.createFolder({
      id: newId(),
      parentId,
      name: named ?? availableShareFolderName(all, parentId),
      icon: shareOrganizerIcon(write.icon),
      color: shareOrganizerColor(write.color, 'color'),
      position: write.position === undefined
        ? nextShareFolderPosition(all, parentId)
        : shareFolderPosition(write.position),
      now: Date.now(),
    })
  }

  /** `null` is the id belonging to nobody: the same answer for "gone" and "not yours". */
  async patchFolder(id: string, write: ShareFolderWrite): Promise<ShareFolderRow | null> {
    const existing = await this.store.folderRow(id)
    if (!existing) return null
    const rows = await this.store.folderOrderRows()
    const columns: Partial<Record<ShareFolderPatchColumn, string | number | null>> = {}
    if (write.name !== undefined) {
      const name = shareFolderName(write.name)
      if (!name) throw ApiError.badRequest('Folder name cannot be empty')
      columns.name = name
    }
    if (write.icon !== undefined) columns.icon = shareOrganizerIcon(write.icon)
    if (write.color !== undefined) columns.color = shareOrganizerColor(write.color, 'color')
    if (write.position !== undefined) columns.position = shareFolderPosition(write.position)
    if (write.parentId !== undefined) {
      const parentId = resolveShareFolderParent(rows, shareFolderParentId(write.parentId), id)
      if (parentId !== existing.parent_id) columns.parent_id = parentId
    }
    if (!Object.keys(columns).length) return existing
    const patched = await this.store.patchFolder(id, columns, Math.max(Date.now(), existing.updated_at + 1))
    if (!patched) throw ApiError.conflict('The folder changed elsewhere. Refresh and try again')
    return patched
  }

  /** Deletes a folder and detaches what was in it. `false` is both "no such folder" and "not yours". */
  async deleteFolder(id: string): Promise<boolean> {
    const folder = await this.store.folderRow(id)
    if (!folder) return false
    return this.store.deleteFolder(folder)
  }

  // --- tags ----------------------------------------------------------------

  listTags(): Promise<ShareTagRow[]> {
    return this.store.listTags()
  }

  /**
   * Creates one tag record from what the request named.
   *
   * The name and colour are read here rather than handed in already validated: the rules are the
   * organizer's, and a caller that could pass a name past them would make this the one place in the hub
   * where a tag with a space in it can be born.
   */
  async createTag(name: unknown, color: unknown): Promise<ShareTagRow> {
    const usable = shareTagName(name)
    if (await this.store.countTags() >= LIMITS.shareTagsMaxPerUser) {
      throw ApiError.badRequest(`An account can hold at most ${LIMITS.shareTagsMaxPerUser} share tags`)
    }
    return this.store.createTag({
      id: newId(),
      name: usable,
      color: shareOrganizerColor(color, 'color'),
      now: Date.now(),
    })
  }

  /**
   * Renames a tag, or writes its colour and pin.
   *
   * The two are separate requests, exactly as in `routes/tags.ts`: a rename moves the name every link
   * stores, so letting it ride alongside a pin flip would make one failed step of the pair unclear and
   * leave the links half-moved.
   */
  async patchTag(
    id: string,
    write: { name?: unknown; color?: unknown; isPinned?: unknown },
  ): Promise<{ row: ShareTagRow | null; rewritten: number }> {
    const existing = await this.store.tagRow(id)
    if (!existing) return { row: null, rewritten: 0 }
    if (write.isPinned !== undefined && typeof write.isPinned !== 'boolean') {
      throw ApiError.badRequest('isPinned must be a boolean')
    }
    const color = write.color === undefined ? existing.color : shareOrganizerColor(write.color, 'color')
    const isPinned = write.isPinned === undefined ? existing.is_pinned === 1 : (write.isPinned as boolean)
    if (write.name === undefined) {
      await this.store.patchTag(id, { color, isPinned })
      return { row: await this.store.tagRow(id), rewritten: 0 }
    }
    if (write.isPinned !== undefined) {
      throw ApiError.badRequest('Rename and pinning have to be sent as separate requests')
    }
    const name = shareTagName(write.name)
    if (name === existing.name) {
      await this.store.patchTag(id, { color, isPinned: existing.is_pinned === 1 })
      return { row: await this.store.tagRow(id), rewritten: 0 }
    }
    const renamed = await this.store.renameTag(existing, name, color)
    return { row: await this.store.tagRow(id), rewritten: renamed.rewritten }
  }

  /** Deletes a tag record and strips its name from every link that still carries it. */
  async deleteTag(id: string): Promise<{ removed: boolean; rewritten: number }> {
    const tag = await this.store.tagRow(id)
    if (!tag) return { removed: false, rewritten: 0 }
    return this.store.deleteTag(tag)
  }

  // --- filing links --------------------------------------------------------

  /**
   * Resolves the names an organize request carried against this account's tag records.
   *
   * A name with no record is refused rather than created: the hub's tag list is what the owner sees in
   * the sidebar, and a filing write that minted records from free text would fill it with the typos of
   * every batch dialog that ever mistyped one.
   */
  async resolveTagNames(names: readonly string[]): Promise<string[]> {
    if (!names.length) return []
    const existing = await this.store.existingTagNames(names)
    const missing = names.filter((name) => !existing.has(name))
    if (missing.length) throw ApiError.badRequest(`Unknown share tags: ${missing.join(', ')}`)
    return [...names]
  }

  /** Files one link. `null` means the account holds no link for that note, which the route calls 404. */
  async organizeNote(noteId: string, filing: ShareFilingWrite): Promise<ShareFilingResult | null> {
    const before = await this.store.liveShare(noteId)
    if (!before) return null
    const columns = await this.filingColumns(filing)
    const applied = await this.store.patchShares([noteId], columns)
    if (!applied) throw ApiError.conflict('The link changed elsewhere. Refresh and try again')
    await this.recordFilingAudit([noteId], new Map([[before.note_id, before]]), 'update')
    return this.filingResult(noteId)
  }

  /** Applies one folder and one tag list to the links the request named. */
  async batchOrganize(noteIds: readonly string[], filing: ShareFilingWrite): Promise<number> {
    const columns = await this.filingColumns(filing)
    const before = await this.store.organizeSnapshots(noteIds)
    const applied = await this.store.patchShares(noteIds, columns)
    await this.recordFilingAudit(noteIds, before, 'batch')
    return applied
  }

  /** Pauses or resumes the named links. A paused link answers 404 to a reader and stays in the list. */
  async batchEnabled(noteIds: readonly string[], enabled: boolean): Promise<number> {
    const before = await this.store.organizeSnapshots(noteIds)
    const applied = await this.store.patchShares(noteIds, { is_enabled: enabled ? 1 : 0 })
    await this.recordFilingAudit(noteIds, before, 'batch')
    return applied
  }

  /** Revokes the named links: the row goes, and with it the passcode sessions addressed by its slug. */
  async batchRevoke(noteIds: readonly string[]): Promise<number> {
    const before = await this.store.organizeSnapshots(noteIds)
    const removed = await this.store.revokeShares(noteIds)
    const now = Date.now()
    const entries: ShareAuditEntry[] = [...before.values()].map((row) => ({
      userId: this.userId,
      noteId: row.note_id,
      slug: row.slug,
      action: 'revoke' as const,
      changed: [],
      createdAt: now,
    }))
    await recordShareAudit(this.db, entries)
    return removed
  }

  /**
   * The filing columns to write, with the folder and the tag names resolved against this account.
   *
   * A write that named neither is refused here rather than sending an empty `UPDATE`: an organize that
   * changed nothing is a client that lost a checkbox, and answering as if it had worked would be the
   * silent no-op the hub's own confirm dialog exists to avoid.
   */
  private async filingColumns(filing: ShareFilingWrite): Promise<Partial<Record<ShareOrganizeColumn, string | number | null>>> {
    const columns: Partial<Record<ShareOrganizeColumn, string | number | null>> = {}
    if (filing.folderId !== undefined) columns.folder_id = await this.assertFolder(filing.folderId)
    if (filing.tags !== undefined) columns.tags = serializeShareTags(await this.resolveTagNames(filing.tags))
    if (!Object.keys(columns).length) throw ApiError.badRequest('Send a folder, tags, or both')
    return columns
  }

  /** The folder a filing write names, checked to be one this account owns. */
  private async assertFolder(folderId: string | null): Promise<string | null> {
    if (!folderId) return null
    if (!isValidId(folderId)) throw ApiError.badRequest('folderId is not a valid folder id')
    const folder = await this.store.folderRow(folderId)
    if (!folder) throw ApiError.notFound('The folder does not exist')
    return folder.id
  }

  /** The link's filing as the row holds it now, or `null` if the link went away under the write. */
  private async filingResult(noteId: string): Promise<ShareFilingResult | null> {
    const row = await this.store.liveShare(noteId)
    if (!row) return null
    return { noteId, slug: row.slug, folderId: row.folder_id, tags: parseShareTags(row.tags) }
  }

  /**
   * The history one filing write leaves behind.
   *
   * The diff is computed against the rows read back after the write, so what is recorded is what the
   * database ended up holding rather than what the request asked for, and a link the batch did not
   * actually move produces no entry at all.
   */
  private async recordFilingAudit(
    noteIds: readonly string[],
    before: Map<string, ShareOrganizeSnapshot>,
    action: 'update' | 'batch',
  ): Promise<void> {
    const after = await this.store.organizeSnapshots(noteIds)
    const now = Date.now()
    const entries: ShareAuditEntry[] = []
    for (const [noteId, row] of after) {
      const previous = before.get(noteId)
      const diff = shareAuditDiff(previous ? shareAuditSnapshot(previous) : null, shareAuditSnapshot(row))
      if (!diff.length) continue
      entries.push({ userId: this.userId, noteId, slug: row.slug, action, changed: diff, createdAt: now })
    }
    await recordShareAudit(this.db, entries)
  }
}
