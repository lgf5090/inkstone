/**
 * The Memos tools: the app's memos reached from the assistant.
 *
 * Every read and write goes through `MemosStore`, the same store the Memos app and its HTTP routes use,
 * so a tool cannot reach a row the app itself would refuse: the store pins every query to the reader's
 * own `user_id`, and the space lookup below refuses an id that is not the reader's before a list runs.
 *
 * A comment is published under the reader's own name beside their memo, so it is approved like a
 * deletion rather than fired on the model's say-so — the model can propose the words, the reader
 * presses the button. Deletion is the same prepare/commit pair, bounded to one small batch, and the
 * card names the exact memos and how many there are before anything is removed.
 */

import { MEMO_VISIBILITIES, type Memo, type MemoVisibility } from '@shared/memos/types'
import { MemosStore, type MemoAttachmentObjectRef } from '../memos/store'
import { deleteMemoObjects } from '../memos/cleanup'
import { listSpaces, spaceBelongsToUser } from '../memos/spaces'
import { ToolError, type ToolContext, type ToolDefinition } from './tools'

const DEFAULT_LIMIT = 20
const MAX_LIST_LIMIT = 50
const MAX_COMMENTS = 50
const MAX_DELETE_BATCH = 10
const MEMO_READ_PATH = '/memos/m/'
const MAX_LIST_CONTENT_CHARS = 600

const DATE_FIELD_DESCRIPTION = 'A local calendar day, YYYY-MM-DD.'
const SPACE_FIELD = {
  type: 'string' as const,
  description: 'A space id or its exact title. Omit for every space; null for memos filed in no space.',
  maxLength: 120,
  optional: true,
  nullable: true,
}
const TAG_FIELD = {
  type: 'string' as const,
  description: 'An exact tag, without the leading #.',
  maxLength: 120,
  optional: true,
}
const SINCE_FIELD = { type: 'string' as const, description: `Only memos created on or after this day. ${DATE_FIELD_DESCRIPTION}`, maxLength: 10, optional: true }
const UNTIL_FIELD = { type: 'string' as const, description: `Only memos created on or before this day. ${DATE_FIELD_DESCRIPTION}`, maxLength: 10, optional: true }
const LIMIT_FIELD = {
  type: 'integer' as const,
  description: `How many memos to return. Defaults to ${DEFAULT_LIMIT}, at most ${MAX_LIST_LIMIT}.`,
  minimum: 1,
  maximum: MAX_LIST_LIMIT,
  optional: true,
}

/** A quoted fragment of the reader's own text, shortened so an approval card stays readable. */
function quoted(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function excerpt(text: string, max = MAX_LIST_CONTENT_CHARS): string {
  const clean = text.trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function isoSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

function limitOf(value: unknown): number {
  return typeof value === 'number' ? Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(value))) : DEFAULT_LIMIT
}

/** A string literal inside a memo filter expression, escaped the way the filter lexer reads it. */
function filterLiteral(value: string): string {
  return value
    .replace(/\r?\n/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
}

function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function dayOf(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new ToolError(`"${field}" must be YYYY-MM-DD.`)
  const text = value.trim()
  if (!isCalendarDay(text)) throw new ToolError(`"${field}" must be a real calendar day, YYYY-MM-DD.`)
  return text
}

/**
 * The space an argument names, checked against the reader's own spaces.
 *
 * `undefined` means "no restriction", `null` means "the unfiled list", and an id means that space.
 * The extra `spaceBelongsToUser` call is the same guard the store applies on create: a space id the
 * reader does not own is refused before a listing runs rather than answered as an empty page.
 */
async function spaceIdOf(value: unknown, ctx: ToolContext): Promise<string | null | undefined> {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new ToolError('A space is named by its id or title.')
  const ref = value.trim()
  if (!ref) return null
  const spaces = await listSpaces(ctx.env.DB, ctx.store.userId)
  const match = spaces.find((space) => space.id === ref) ?? spaces.find((space) => space.title === ref)
  if (!match) throw new ToolError(`No space matches "${quoted(ref, 60)}". Call the Memos app to see the spaces, or omit it.`)
  if (!(await spaceBelongsToUser(ctx.env.DB, ctx.store.userId, match.id))) {
    throw new ToolError('That space is not yours.')
  }
  return match.id
}

/** The filter expression the memo list understands, built only from fields the tool itself validated. */
function memoFilter(input: {
  query?: unknown
  tag?: unknown
  since?: unknown
  until?: unknown
}): string | undefined {
  const parts: string[] = []
  if (typeof input.query === 'string') {
    const query = input.query.trim()
    if (query) parts.push(`content.contains("${filterLiteral(query)}")`)
  }
  if (typeof input.tag === 'string') {
    const tag = input.tag.trim().replace(/^#/, '')
    if (tag) parts.push(`tag in ["${filterLiteral(tag)}"]`)
  }
  const since = dayOf(input.since, 'since')
  if (since) parts.push(`created_ts >= timestamp("${since}")`)
  const until = dayOf(input.until, 'until')
  if (until) parts.push(`created_ts < timestamp("${until}") + duration("24h")`)
  return parts.length ? parts.join(' && ') : undefined
}

function presentMemo(memo: Memo): Record<string, unknown> {
  return {
    id: memo.id,
    title: memo.title,
    content: excerpt(memo.content),
    tags: memo.tags,
    visibility: memo.visibility,
    space_id: memo.spaceId,
    pinned: memo.pinned,
    comments: memo.commentCount,
    created_at: isoSeconds(memo.createdAt),
    updated_at: isoSeconds(memo.updatedAt),
    url: `${MEMO_READ_PATH}${memo.id}`,
  }
}

function presentComment(memo: Memo): Record<string, unknown> {
  return {
    id: memo.id,
    content: excerpt(memo.content, 1000),
    created_at: isoSeconds(memo.createdAt),
    url: `${MEMO_READ_PATH}${memo.parentId ?? memo.id}#memos-comments`,
  }
}

async function listMemos(
  ctx: ToolContext,
  input: { space?: unknown, tag?: unknown, since?: unknown, until?: unknown, query?: unknown, limit?: unknown, state?: 'normal' | 'archived' },
): Promise<Memo[]> {
  const store = new MemosStore(ctx.env.DB, ctx.store.userId)
  const spaceId = await spaceIdOf(input.space, ctx)
  const page = await store.list({
    state: input.state ?? 'normal',
    spaceId,
    filter: memoFilter(input),
    limit: limitOf(input.limit),
    tz: ctx.timezone,
  })
  return page.items
}

/** The tags in a create call, checked against what the memo parser would actually keep. */
function memoTagList(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ToolError('Tags must be a list of names.')
  const tags: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const tag = entry.trim().replace(/^#/, '')
    if (!tag) continue
    if (/\s/.test(tag)) throw new ToolError(`A tag cannot contain spaces: "${quoted(tag, 40)}".`)
    tags.push(tag.split('/').map((segment) => segment.trim()).filter(Boolean).join('/'))
  }
  return [...new Set(tags)].slice(0, 16)
}

/** The body a memo write stores: the reader's text, with any tags the call named added as #tags. */
function memoBody(content: string, tags: string[]): string {
  const body = content.trim()
  if (!body) throw new ToolError('A memo needs some content.')
  const missing = tags.filter((tag) => !body.includes(`#${tag}`))
  if (!missing.length) return body
  return `${body}\n\n${missing.map((tag) => `#${tag}`).join(' ')}`
}

function visibilityOf(value: unknown): MemoVisibility | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(MEMO_VISIBILITIES as readonly string[]).includes(value)) {
    throw new ToolError('Visibility must be private, protected, or public.')
  }
  return value as MemoVisibility
}

/** The memos a deletion names, either by id or by the same filters a search uses. */
async function deleteTargets(args: Record<string, unknown>, ctx: ToolContext): Promise<Memo[]> {
  if (Array.isArray(args.ids)) {
    const ids = args.ids.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    if (!ids.length) throw new ToolError('A deletion names at least one memo id.')
    if (ids.length > MAX_DELETE_BATCH) {
      throw new ToolError(`A single approval deletes at most ${MAX_DELETE_BATCH} memos. Split the request into smaller batches.`)
    }
    const store = new MemosStore(ctx.env.DB, ctx.store.userId)
    const memos: Memo[] = []
    for (const id of [...new Set(ids)]) {
      const memo = await store.get(id)
      if (!memo) throw new ToolError(`Memo ${id} no longer exists. Search again for the memos to delete.`)
      memos.push(memo)
    }
    return memos
  }

  if (args.query === undefined && args.tag === undefined && args.since === undefined && args.until === undefined) {
    throw new ToolError('Name the memo ids, or search words, a tag, or a date range that select them.')
  }
  const memos = await listMemos(ctx, { ...args, limit: MAX_DELETE_BATCH })
  if (!memos.length) throw new ToolError('No memos match that selection, so there is nothing to delete.')
  return memos
}

function deleteLabel(memos: Memo[]): string {
  const names = memos.slice(0, 3).map((memo) => `"${quoted(memo.title || memo.content, 32)}"`)
  const more = memos.length > 3 ? ', …' : ''
  return `${memos.length} memo${memos.length === 1 ? '' : 's'}: ${names.join(', ')}${more}`
}

export const MEMOS_TOOLS: ToolDefinition[] = [
  {
    name: 'memo_list',
    permission: 'read',
    maxCallsPerTurn: 6,
    description: 'List memos, newest first, optionally within one space, one tag, or a created-date range. Comments are not included; use memo_read for one memo and its comments.',
    fields: {
      space: SPACE_FIELD,
      tag: TAG_FIELD,
      since: SINCE_FIELD,
      until: UNTIL_FIELD,
      archived: { type: 'boolean', description: 'Read the archive instead of the current memos.', optional: true },
      limit: LIMIT_FIELD,
    },
    async run(args, ctx) {
      const memos = await listMemos(ctx, {
        space: args.space,
        tag: args.tag,
        since: args.since,
        until: args.until,
        limit: args.limit,
        state: args.archived === true ? 'archived' : 'normal',
      })
      return { count: memos.length, memos: memos.map(presentMemo) }
    },
  },
  {
    name: 'memo_search',
    permission: 'read',
    maxCallsPerTurn: 6,
    description: 'Search memo bodies for words, then narrow by space, tag, and the day they were created. Case-insensitive; a match is a substring of the memo body.',
    fields: {
      query: { type: 'string', minLength: 1, maxLength: 200, description: 'Words to find in the memo body.' },
      space: SPACE_FIELD,
      tag: TAG_FIELD,
      since: SINCE_FIELD,
      until: UNTIL_FIELD,
      limit: LIMIT_FIELD,
    },
    async run(args, ctx) {
      const memos = await listMemos(ctx, {
        query: args.query,
        space: args.space,
        tag: args.tag,
        since: args.since,
        until: args.until,
        limit: args.limit,
      })
      return { query: args.query, count: memos.length, memos: memos.map(presentMemo) }
    },
  },
  {
    name: 'memo_read',
    permission: 'read',
    maxCallsPerTurn: 8,
    description: 'Read one memo in full, with its comments (oldest first) and its space and tags. Call memo_search or memo_list first to find the id.',
    fields: {
      id: { type: 'string', minLength: 1, maxLength: 64, description: 'The memo id.' },
      comments: { type: 'integer', minimum: 1, maximum: MAX_COMMENTS, description: `How many comments to return. Defaults to 20.`, optional: true },
    },
    async run(args, ctx) {
      const store = new MemosStore(ctx.env.DB, ctx.store.userId)
      const memo = await store.get(String(args.id))
      if (!memo) throw new ToolError('No memo has that id.')
      const comments = await store.listComments(memo.id, {
        limit: typeof args.comments === 'number' ? Math.min(MAX_COMMENTS, Math.max(1, Math.trunc(args.comments))) : 20,
        tz: ctx.timezone,
      })
      return {
        memo: presentMemo(memo),
        full_content: memo.content,
        comments: (comments?.items ?? []).map(presentComment),
      }
    },
  },
  {
    name: 'memo_create',
    permission: 'write',
    maxCallsPerTurn: 5,
    description: 'Record a new memo. Tags are written into the body as #tags, and the memo lands in the reader\'s own space; name a space to file it there.',
    fields: {
      content: { type: 'string', minLength: 1, maxLength: 20_000, description: 'The memo body, in Markdown. Tags may also be given separately.' },
      tags: { type: 'array', items: 'string', maxItems: 16, maxLength: 120, description: 'Tag names, without the leading #.', optional: true },
      visibility: {
        type: 'string',
        enum: MEMO_VISIBILITIES,
        description: 'private (default), protected (any signed-in reader), or public.',
        optional: true,
      },
      space: SPACE_FIELD,
    },
    async run(args, ctx) {
      const content = memoBody(String(args.content), memoTagList(args.tags))
      const spaceId = await spaceIdOf(args.space, ctx)
      const store = new MemosStore(ctx.env.DB, ctx.store.userId)
      const visibility = visibilityOf(args.visibility)
      const memo = await store.create({
        content,
        ...(visibility ? { visibility } : {}),
        ...(spaceId !== undefined ? { spaceId } : {}),
      })
      return { created: presentMemo(memo) }
    },
  },
  {
    name: 'memo_comment',
    permission: 'destructive',
    keepArgs: true,
    maxCallsPerTurn: 5,
    description: 'Propose a comment on one memo. The comment is published under the reader\'s own name, so nothing is written until they approve it.',
    fields: {
      memo: { type: 'string', minLength: 1, maxLength: 64, description: 'The parent memo id. Call memo_search or memo_list to find it.' },
      content: { type: 'string', minLength: 1, maxLength: 10_000, description: 'The comment body, in Markdown.' },
    },
    async prepare(args, ctx) {
      const store = new MemosStore(ctx.env.DB, ctx.store.userId)
      const memo = await store.get(String(args.memo))
      if (!memo) throw new ToolError('No memo has that id.')
      if (memo.parentId) throw new ToolError('That row is a comment; reply to its parent memo instead.')
      const body = String(args.content).trim()
      if (!body) throw new ToolError('A comment needs some content.')
      return {
        targetId: memo.id,
        targetLabel: `${quoted(memo.title || memo.content, 60)} · ${quoted(body, 60)}`,
      }
    },
    async commit(targetId, ctx, args) {
      const store = new MemosStore(ctx.env.DB, ctx.store.userId)
      const parent = await store.get(targetId)
      if (!parent) throw new ToolError('This memo no longer exists.')
      const body = typeof args.content === 'string' ? args.content.trim() : ''
      if (!body) throw new ToolError('This comment has no content.')
      const comment = await store.create({ content: body, parentId: parent.id })
      return { comment: presentComment(comment) }
    },
  },
  {
    name: 'memo_delete',
    permission: 'destructive',
    maxCallsPerTurn: 2,
    description: `Propose deleting memos: name up to ${MAX_DELETE_BATCH} ids, or search words/a tag/a date range that select them. The card names the memos and how many there are; nothing is deleted until the reader approves it.`,
    fields: {
      ids: {
        type: 'array',
        items: 'string',
        maxItems: MAX_DELETE_BATCH,
        maxLength: 64,
        description: `The memo ids to delete, at most ${MAX_DELETE_BATCH} in one approval.`,
        optional: true,
      },
      query: { type: 'string', minLength: 1, maxLength: 200, description: 'Words that select the memos to delete, used when ids are not given.', optional: true },
      space: SPACE_FIELD,
      tag: TAG_FIELD,
      since: SINCE_FIELD,
      until: UNTIL_FIELD,
    },
    async prepare(args, ctx) {
      const memos = await deleteTargets(args, ctx)
      return {
        targetId: memos.map((memo) => memo.id).join(','),
        targetLabel: deleteLabel(memos),
      }
    },
    async commit(targetId, ctx) {
      const ids = targetId.split(',').filter(Boolean)
      if (!ids.length) throw new ToolError('This deletion names no memo.')
      if (ids.length > MAX_DELETE_BATCH) throw new ToolError(`A single approval deletes at most ${MAX_DELETE_BATCH} memos.`)
      const store = new MemosStore(ctx.env.DB, ctx.store.userId)
      let deleted = 0
      const objects: MemoAttachmentObjectRef[] = []
      for (const id of ids) {
        // Read again rather than trusting the id: a memo removed between the card and the press is gone,
        // and a deletion must not become a 404 that reports the whole approval as failed.
        const memo = await store.get(id)
        if (!memo) continue
        const result = await store.delete(id)
        if (!result) continue
        deleted++
        objects.push(...result.attachmentObjects)
      }
      if (!deleted) throw new ToolError('Those memos no longer exist.')
      if (objects.length) await deleteMemoObjects(ctx.env, objects)
      return { deleted, ids }
    },
  },
]
