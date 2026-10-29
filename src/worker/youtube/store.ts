/**
 * The saved YouTube library in D1.
 *
 * Every statement here is scoped by `user_id`; nothing reads a row by id alone. Rows keep the full
 * upstream snapshot in `data_json` and only the columns the list views sort or render beside it. The
 * helpers below translate between those rows and the shared model, and every failure the client can
 * cause is an `ApiError` so the route layer never has to invent an error shape.
 */
import type {
  SavedYouTubeChannel,
  SavedYouTubePlaylist,
  SavedYouTubeVideo,
  YouTubeChannel,
  YouTubeLibrary,
  YouTubePlaylist,
  YouTubeTag,
  YouTubeVideo,
} from '@shared/youtube/model'
import { YOUTUBE_MAX_LIBRARY_VIDEOS, wouldCreateTagCycle } from '@shared/youtube/model'
import {
  YOUTUBE_MAX_DATA_BYTES,
  YOUTUBE_MAX_THUMBNAIL_LENGTH,
  YOUTUBE_MAX_TITLE_LENGTH,
  isYoutubeId,
  jsonByteLength,
  normalizeNotes,
  normalizeTagIds,
  normalizeTagName,
  youtubeColor,
} from '@shared/youtube/validate'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'

interface VideoRow {
  id: string
  title: string
  thumbnail_url: string
  channel_id: string
  channel_title: string
  data_json: string
  tag_ids: string
  pinned: number
  favorited: number
  notes: string
  created_at: number
  updated_at: number
}

interface ChannelRow {
  id: string
  data_json: string
  tag_ids: string
  pinned: number
  notes: string
  created_at: number
  updated_at: number
}

interface PlaylistRow {
  id: string
  data_json: string
  tag_ids: string
  pinned: number
  favorited: number
  notes: string
  created_at: number
  updated_at: number
}

interface TagRow {
  id: string
  name: string
  color: string
  parent_id: string | null
  sort_order: number
  created_at: number
}

/** The body a PUT may carry. The store validates every field it actually reads. */
export interface SaveWriteInput {
  data?: unknown
  pinned?: unknown
  favorited?: unknown
  tagIds?: unknown
  notes?: unknown
}

/** The body a tag create or patch may carry. */
export interface TagWriteInput {
  name?: unknown
  color?: unknown
  parentId?: unknown
  sortOrder?: unknown
}

const VIDEO_COLUMNS = `id, title, thumbnail_url, channel_id, channel_title, data_json, tag_ids,
  pinned, favorited, notes, created_at, updated_at`
const CHANNEL_COLUMNS = 'id, data_json, tag_ids, pinned, notes, created_at, updated_at'
const PLAYLIST_COLUMNS = 'id, data_json, tag_ids, pinned, favorited, notes, created_at, updated_at'
const TAG_COLUMNS = 'id, name, color, parent_id, sort_order, created_at'

function invalidInput(message: string): ApiError {
  return new ApiError(400, 'youtube_invalid_input', message)
}

function notFound(message: string): ApiError {
  return new ApiError(404, 'youtube_not_found', message)
}

/**
 * A snapshot or tag list that cannot be parsed is read as empty rather than as an error: one bad
 * row must not make the whole library unreadable, and the write path always stores canonical JSON.
 */
function parseJsonObject<T>(raw: string): T {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T
  } catch {
    // Corrupt JSON is handled by the empty-object answer below.
  }
  return {} as unknown as T
}

function parseTagIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === 'string')
    }
  } catch {
    // Corrupt JSON is handled by the empty-list answer below.
  }
  return []
}

function text(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : ''
}

function rowToVideo(row: VideoRow): SavedYouTubeVideo {
  return {
    id: row.id,
    title: row.title,
    thumbnailUrl: row.thumbnail_url,
    channelId: row.channel_id,
    channelTitle: row.channel_title,
    data: parseJsonObject<YouTubeVideo>(row.data_json),
    tagIds: parseTagIds(row.tag_ids),
    pinned: row.pinned === 1,
    favorited: row.favorited === 1,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToChannel(row: ChannelRow): SavedYouTubeChannel {
  return {
    id: row.id,
    data: parseJsonObject<YouTubeChannel>(row.data_json),
    tagIds: parseTagIds(row.tag_ids),
    pinned: row.pinned === 1,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToPlaylist(row: PlaylistRow): SavedYouTubePlaylist {
  return {
    id: row.id,
    data: parseJsonObject<YouTubePlaylist>(row.data_json),
    tagIds: parseTagIds(row.tag_ids),
    pinned: row.pinned === 1,
    favorited: row.favorited === 1,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToTag(row: TagRow): YouTubeTag {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  }
}

export async function readLibrary(db: D1Database, userId: string): Promise<YouTubeLibrary> {
  const limit = YOUTUBE_MAX_LIBRARY_VIDEOS
  const tags = await db.prepare(
    `SELECT ${TAG_COLUMNS} FROM youtube_tags
     WHERE user_id = ?1
     ORDER BY sort_order ASC, created_at ASC, id ASC`,
  ).bind(userId).all<TagRow>()

  // One row past the ceiling answers "was there more" without a second count query.
  const videos = await db.prepare(
    `SELECT ${VIDEO_COLUMNS} FROM youtube_videos
     WHERE user_id = ?1
     ORDER BY updated_at DESC, id ASC
     LIMIT ?2`,
  ).bind(userId, limit + 1).all<VideoRow>()

  const channels = await db.prepare(
    `SELECT ${CHANNEL_COLUMNS} FROM youtube_channels
     WHERE user_id = ?1
     ORDER BY pinned DESC, updated_at DESC, id ASC`,
  ).bind(userId).all<ChannelRow>()

  const playlists = await db.prepare(
    `SELECT ${PLAYLIST_COLUMNS} FROM youtube_playlists
     WHERE user_id = ?1
     ORDER BY pinned DESC, favorited DESC, updated_at DESC, id ASC`,
  ).bind(userId).all<PlaylistRow>()

  const truncated = videos.results.length > limit
  return {
    tags: tags.results.map(rowToTag),
    videos: videos.results.slice(0, limit).map(rowToVideo),
    channels: channels.results.map(rowToChannel),
    playlists: playlists.results.map(rowToPlaylist),
    truncated,
  }
}

function assertPathId(id: string): void {
  if (!isYoutubeId(id)) throw ApiError.badRequest('The YouTube id is invalid')
}

function assertData(data: unknown, id: string): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw invalidInput('data must be an object')
  }
  const record = data as Record<string, unknown>
  if (!isYoutubeId(record.id) || record.id !== id) {
    throw invalidInput('data.id must match the id in the path')
  }
  if (jsonByteLength(data) > YOUTUBE_MAX_DATA_BYTES) {
    throw ApiError.tooLarge('The saved snapshot is too large')
  }
  return record
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalidInput(`${field} must be a boolean`)
  return value
}

function notesField(value: unknown): string {
  const notes = normalizeNotes(value)
  if (notes === null) throw invalidInput('notes must be a string')
  return notes
}

function tagIdsField(value: unknown): string[] {
  const tagIds = normalizeTagIds(value)
  if (tagIds === null) throw invalidInput('tagIds must be an array of tag ids')
  return tagIds
}

/** Every tag a write names has to belong to the same account that owns the row. */
async function assertTagsExist(db: D1Database, userId: string, tagIds: readonly string[]): Promise<void> {
  if (tagIds.length === 0) return
  const rows = await db.prepare(
    `SELECT id FROM youtube_tags
     WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
  ).bind(userId, JSON.stringify(tagIds)).all<{ id: string }>()
  if (rows.results.length !== tagIds.length) {
    throw invalidInput('tagIds contains a tag that does not belong to this account')
  }
}

async function videoRow(db: D1Database, userId: string, id: string): Promise<VideoRow | null> {
  return await db.prepare(
    `SELECT ${VIDEO_COLUMNS} FROM youtube_videos WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<VideoRow>()
}

async function channelRow(db: D1Database, userId: string, id: string): Promise<ChannelRow | null> {
  return await db.prepare(
    `SELECT ${CHANNEL_COLUMNS} FROM youtube_channels WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<ChannelRow>()
}

async function playlistRow(db: D1Database, userId: string, id: string): Promise<PlaylistRow | null> {
  return await db.prepare(
    `SELECT ${PLAYLIST_COLUMNS} FROM youtube_playlists WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<PlaylistRow>()
}

export async function saveVideo(
  db: D1Database,
  userId: string,
  id: string,
  input: SaveWriteInput,
): Promise<SavedYouTubeVideo> {
  assertPathId(id)
  const data = assertData(input.data, id)
  const existing = await videoRow(db, userId, id)
  const pinned = input.pinned === undefined ? existing?.pinned === 1 : booleanField(input.pinned, 'pinned')
  const favorited = input.favorited === undefined
    ? existing?.favorited === 1
    : booleanField(input.favorited, 'favorited')
  const tagIds = input.tagIds === undefined
    ? (existing ? parseTagIds(existing.tag_ids) : [])
    : tagIdsField(input.tagIds)
  if (input.tagIds !== undefined) await assertTagsExist(db, userId, tagIds)
  const notes = input.notes === undefined ? existing?.notes ?? '' : notesField(input.notes)
  const now = Date.now()

  await db.prepare(
    `INSERT INTO youtube_videos
       (user_id, id, title, thumbnail_url, channel_id, channel_title, data_json, tag_ids,
        pinned, favorited, notes, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT(user_id, id) DO UPDATE SET
       title = excluded.title,
       thumbnail_url = excluded.thumbnail_url,
       channel_id = excluded.channel_id,
       channel_title = excluded.channel_title,
       data_json = excluded.data_json,
       tag_ids = excluded.tag_ids,
       pinned = excluded.pinned,
       favorited = excluded.favorited,
       notes = excluded.notes,
       updated_at = excluded.updated_at`,
  ).bind(
    userId,
    id,
    text(data.title, YOUTUBE_MAX_TITLE_LENGTH),
    text(data.thumbnailUrl, YOUTUBE_MAX_THUMBNAIL_LENGTH),
    text(data.channelId, 64),
    text(data.channelTitle, YOUTUBE_MAX_TITLE_LENGTH),
    JSON.stringify(data),
    JSON.stringify(tagIds),
    pinned ? 1 : 0,
    favorited ? 1 : 0,
    notes,
    existing?.created_at ?? now,
    now,
  ).run()

  const saved = await videoRow(db, userId, id)
  if (!saved) throw new Error('The saved video disappeared after its write')
  return rowToVideo(saved)
}

export async function deleteVideo(db: D1Database, userId: string, id: string): Promise<void> {
  await db.prepare('DELETE FROM youtube_videos WHERE user_id = ?1 AND id = ?2').bind(userId, id).run()
}

export async function saveChannel(
  db: D1Database,
  userId: string,
  id: string,
  input: SaveWriteInput,
): Promise<SavedYouTubeChannel> {
  assertPathId(id)
  assertData(input.data, id)
  const existing = await channelRow(db, userId, id)
  const pinned = input.pinned === undefined ? existing?.pinned === 1 : booleanField(input.pinned, 'pinned')
  const tagIds = input.tagIds === undefined
    ? (existing ? parseTagIds(existing.tag_ids) : [])
    : tagIdsField(input.tagIds)
  if (input.tagIds !== undefined) await assertTagsExist(db, userId, tagIds)
  const notes = input.notes === undefined ? existing?.notes ?? '' : notesField(input.notes)
  const now = Date.now()

  await db.prepare(
    `INSERT INTO youtube_channels
       (user_id, id, data_json, tag_ids, pinned, notes, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(user_id, id) DO UPDATE SET
       data_json = excluded.data_json,
       tag_ids = excluded.tag_ids,
       pinned = excluded.pinned,
       notes = excluded.notes,
       updated_at = excluded.updated_at`,
  ).bind(
    userId,
    id,
    JSON.stringify(input.data),
    JSON.stringify(tagIds),
    pinned ? 1 : 0,
    notes,
    existing?.created_at ?? now,
    now,
  ).run()

  const saved = await channelRow(db, userId, id)
  if (!saved) throw new Error('The saved channel disappeared after its write')
  return rowToChannel(saved)
}

export async function deleteChannel(db: D1Database, userId: string, id: string): Promise<void> {
  await db.prepare('DELETE FROM youtube_channels WHERE user_id = ?1 AND id = ?2').bind(userId, id).run()
}

export async function savePlaylist(
  db: D1Database,
  userId: string,
  id: string,
  input: SaveWriteInput,
): Promise<SavedYouTubePlaylist> {
  assertPathId(id)
  assertData(input.data, id)
  const existing = await playlistRow(db, userId, id)
  const pinned = input.pinned === undefined ? existing?.pinned === 1 : booleanField(input.pinned, 'pinned')
  const favorited = input.favorited === undefined
    ? existing?.favorited === 1
    : booleanField(input.favorited, 'favorited')
  const tagIds = input.tagIds === undefined
    ? (existing ? parseTagIds(existing.tag_ids) : [])
    : tagIdsField(input.tagIds)
  if (input.tagIds !== undefined) await assertTagsExist(db, userId, tagIds)
  const notes = input.notes === undefined ? existing?.notes ?? '' : notesField(input.notes)
  const now = Date.now()

  await db.prepare(
    `INSERT INTO youtube_playlists
       (user_id, id, data_json, tag_ids, pinned, favorited, notes, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(user_id, id) DO UPDATE SET
       data_json = excluded.data_json,
       tag_ids = excluded.tag_ids,
       pinned = excluded.pinned,
       favorited = excluded.favorited,
       notes = excluded.notes,
       updated_at = excluded.updated_at`,
  ).bind(
    userId,
    id,
    JSON.stringify(input.data),
    JSON.stringify(tagIds),
    pinned ? 1 : 0,
    favorited ? 1 : 0,
    notes,
    existing?.created_at ?? now,
    now,
  ).run()

  const saved = await playlistRow(db, userId, id)
  if (!saved) throw new Error('The saved playlist disappeared after its write')
  return rowToPlaylist(saved)
}

export async function deletePlaylist(db: D1Database, userId: string, id: string): Promise<void> {
  await db.prepare('DELETE FROM youtube_playlists WHERE user_id = ?1 AND id = ?2').bind(userId, id).run()
}

async function tagRows(db: D1Database, userId: string): Promise<TagRow[]> {
  const rows = await db.prepare(
    `SELECT ${TAG_COLUMNS} FROM youtube_tags WHERE user_id = ?1`,
  ).bind(userId).all<TagRow>()
  return rows.results
}

async function tagRow(db: D1Database, userId: string, id: string): Promise<TagRow | null> {
  return await db.prepare(
    `SELECT ${TAG_COLUMNS} FROM youtube_tags WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<TagRow>()
}

async function parentIdField(db: D1Database, userId: string, value: unknown): Promise<string | null> {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw invalidInput('parentId must be a tag id or null')
  const parent = await tagRow(db, userId, value)
  if (!parent) throw invalidInput('The parent tag does not exist')
  return value
}

async function nextSortOrder(db: D1Database, userId: string, parentId: string | null): Promise<number> {
  const row = await db.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM youtube_tags
     WHERE user_id = ?1 AND parent_id IS ?2`,
  ).bind(userId, parentId).first<{ next: number }>()
  return row?.next ?? 0
}

export async function createTag(
  db: D1Database,
  userId: string,
  input: TagWriteInput,
): Promise<YouTubeTag> {
  const name = normalizeTagName(input.name)
  if (name === null) throw invalidInput('A tag name must be between 1 and 32 characters')
  const color = youtubeColor(input.color)
  const parentId = await parentIdField(db, userId, input.parentId)
  const id = newId()
  const createdAt = Date.now()
  const sortOrder = await nextSortOrder(db, userId, parentId)

  await db.prepare(
    `INSERT INTO youtube_tags (user_id, id, name, color, parent_id, sort_order, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(userId, id, name, color, parentId, sortOrder, createdAt).run()

  return { id, name, color, parentId, sortOrder, createdAt }
}

export async function updateTag(
  db: D1Database,
  userId: string,
  id: string,
  patch: TagWriteInput,
): Promise<YouTubeTag> {
  const existing = await tagRow(db, userId, id)
  if (!existing) throw notFound('The tag does not exist')

  const has = (key: keyof TagWriteInput) => Object.prototype.hasOwnProperty.call(patch, key)
  let name = existing.name
  let color = existing.color
  let parentId = existing.parent_id
  let sortOrder = existing.sort_order

  if (has('name')) {
    const normalized = normalizeTagName(patch.name)
    if (normalized === null) throw invalidInput('A tag name must be between 1 and 32 characters')
    name = normalized
  }
  if (has('color')) color = youtubeColor(patch.color)
  if (has('parentId')) {
    parentId = await parentIdField(db, userId, patch.parentId)
    if (parentId !== null) {
      const tags = (await tagRows(db, userId)).map(rowToTag)
      if (wouldCreateTagCycle(tags, id, parentId)) {
        throw invalidInput('A tag cannot be moved under itself or one of its descendants')
      }
    }
  }
  if (has('sortOrder')) {
    if (typeof patch.sortOrder !== 'number'
      || !Number.isSafeInteger(patch.sortOrder)
      || patch.sortOrder < 0) {
      throw invalidInput('sortOrder must be a non-negative integer')
    }
    sortOrder = patch.sortOrder
  }

  await db.prepare(
    `UPDATE youtube_tags
     SET name = ?3, color = ?4, parent_id = ?5, sort_order = ?6
     WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id, name, color, parentId, sortOrder).run()

  return { id, name, color, parentId, sortOrder, createdAt: existing.created_at }
}

/**
 * Delete a tag and everything below it, then repair every reference in the same transaction.
 *
 * The subtree is collected with a recursive CTE (UNION also stops a loop written by an older build),
 * and the write batch removes the tags, strips their ids from all three `tag_ids` columns, and drops
 * videos that are left with no pin, no favourite and no tag at all.
 */
export async function deleteTag(
  db: D1Database,
  userId: string,
  id: string,
): Promise<{ removedTagIds: string[] }> {
  const subtree = await db.prepare(
    `WITH RECURSIVE subtree(id) AS (
       SELECT id FROM youtube_tags WHERE user_id = ?1 AND id = ?2
       UNION
       SELECT child.id FROM youtube_tags child
       JOIN subtree ON child.parent_id = subtree.id
       WHERE child.user_id = ?1
     )
     SELECT id FROM subtree`,
  ).bind(userId, id).all<{ id: string }>()

  const removedTagIds = subtree.results.map((row) => row.id)
  if (removedTagIds.length === 0) return { removedTagIds }

  const removedJson = JSON.stringify(removedTagIds)
  const removeFromArray = `(
    SELECT COALESCE(json_group_array(value), '[]')
    FROM json_each(tag_ids)
    WHERE value NOT IN (SELECT value FROM json_each(?1))
  )`
  const referencesRemoved = `EXISTS (
    SELECT 1 FROM json_each(tag_ids)
    WHERE value IN (SELECT value FROM json_each(?1))
  )`
  const everyTagRemoved = `${referencesRemoved} AND NOT EXISTS (
    SELECT 1 FROM json_each(tag_ids)
    WHERE value NOT IN (SELECT value FROM json_each(?1))
  )`

  await db.batch([
    db.prepare(
      `DELETE FROM youtube_tags
       WHERE user_id = ?2 AND id IN (SELECT value FROM json_each(?1))`,
    ).bind(removedJson, userId),
    // A video whose every tag is leaving the tree ends the batch as a row with no tag at all. It is
    // removed only when that emptiness is caused by this deletion, not because it was already empty.
    db.prepare(
      `DELETE FROM youtube_videos
       WHERE user_id = ?2 AND pinned = 0 AND favorited = 0 AND json_valid(tag_ids)
         AND ${everyTagRemoved}`,
    ).bind(removedJson, userId),
    db.prepare(
      `UPDATE youtube_videos SET tag_ids = ${removeFromArray}
       WHERE user_id = ?2 AND json_valid(tag_ids) AND ${referencesRemoved}`,
    ).bind(removedJson, userId),
    db.prepare(
      `UPDATE youtube_channels SET tag_ids = ${removeFromArray}
       WHERE user_id = ?2 AND json_valid(tag_ids) AND ${referencesRemoved}`,
    ).bind(removedJson, userId),
    db.prepare(
      `UPDATE youtube_playlists SET tag_ids = ${removeFromArray}
       WHERE user_id = ?2 AND json_valid(tag_ids) AND ${referencesRemoved}`,
    ).bind(removedJson, userId),
  ])

  return { removedTagIds }
}
