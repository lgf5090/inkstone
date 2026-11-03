/**
 * The blog tools the assistant can call.
 *
 * The note is the article and `blog_posts` is a projection of it, exactly as the blog admin treats it: a
 * title, a body, a publish flag or a tag changes in the note and `syncBlogPostFromNote` carries it across.
 * Only the fields a post owns on its own — the excerpt, the meta description, the slug override and the
 * series — are written through `updateAdminPostMeta`, which is also the code that keeps slugs unique.
 * Nothing here builds SQL or invents a slug the admin screen would then refuse.
 *
 * The blog belongs to the owner account, so every tool stops with a tool error for anyone else: the
 * projection is site-wide, and a member's assistant must not reach it.
 */

import { readBlogFrontMatter, setBlogPublished, slugifyBlogTitle } from '@shared/blog/frontmatter'
import type { BlogPostStatus } from '@shared/blog/model'
import { parseLocalTime } from '@shared/assistant-time'
import { extractTags, parseFrontMatter, replaceTagInContent, setFrontMatterValue } from '@shared/markdown-utils'
import { blogOwnerUserId, bulkAdminPosts, findPostById, findPostByNoteId, listAdminPosts, listPostTags, recordBlogAudit, syncBlogPostFromNote, updateAdminPostMeta, type BlogPostWithNames, type BlogPostWithNote } from '../blog/store'
import { listTaxonomy } from '../blog/taxonomy'
import { ApiError } from '../lib/errors'
import { loadMcpNote } from '../mcp/retrieval'
import { editMcpNote } from '../mcp/writes'
import { assertNoteReadable } from './note-scope'
import { ToolError, type FieldSpec, type PreparedTarget, type ToolContext, type ToolDefinition } from './tools'

const MAX_LISTED_POSTS = 50
const MAX_CONTENT_CHARS = 12_000
const MAX_TITLE_CANDIDATES = 5
const MAX_DESCRIPTION_CHARS = 200
const MAX_TAGS = 20
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/

const POST_REF_FIELD: FieldSpec = {
  type: 'string',
  description: 'Post id, or the id of the note the post is projected from.',
  minLength: 1,
  maxLength: 64,
}

/** Post store refusals arrive as plain error codes; the model reads a tool error instead. */
async function ask<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ToolError) throw error
    if (error instanceof ApiError) throw new ToolError(error.message)
    if (error instanceof Error) throw new ToolError(error.message)
    throw error
  }
}

async function requireBlogOwner(ctx: ToolContext): Promise<void> {
  const ownerId = await blogOwnerUserId(ctx.env.DB)
  if (!ownerId || ownerId !== ctx.store.userId) {
    throw new ToolError('The blog belongs to the account owner. This account cannot read or change blog posts.')
  }
}

function writeContext(ctx: ToolContext) {
  if (!ctx.writeContext) throw new ToolError('Note writing is not available in this run.')
  return ctx.writeContext
}

async function postFor(ctx: ToolContext, ref: string): Promise<BlogPostWithNote> {
  const trimmed = ref.trim()
  const row = await findPostById(ctx.env.DB, ctx.store.userId, trimmed)
    ?? await findPostByNoteId(ctx.env.DB, ctx.store.userId, trimmed)
  if (!row) throw new ToolError('No blog post has that id. Call blog_list_posts for the ids.')
  return row
}

/** The body a reader reads: the front matter is metadata, not the article. */
function postBody(content: string): string {
  return parseFrontMatter(content).body
}

function replaceBody(content: string, body: string): string {
  const parsed = parseFrontMatter(content)
  if (parsed.lineOffset <= 0) return body
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  return `${lines.slice(0, parsed.lineOffset).join('\n')}\n${body}`
}

function withTags(content: string, tags: readonly string[]): string {
  const wanted = [...new Set(tags.map((tag) => tag.replace(/^#/, '').trim()).filter(Boolean))].slice(0, MAX_TAGS)
  let next = content
  for (const current of extractTags(content)) {
    if (!wanted.includes(current)) next = replaceTagInContent(next, current, null)
  }
  return setFrontMatterValue(next, 'tags', wanted)
}

function asBlogPost(content: string): string {
  return readBlogFrontMatter(content).type === 'post' ? content : setFrontMatterValue(content, 'blogType', 'post')
}

async function seriesIdFor(ctx: ToolContext, name: string): Promise<string> {
  const wanted = name.trim()
  const { series } = await listTaxonomy(ctx.env.DB, ctx.store.userId)
  const hit = series.find((entry) => entry.id === wanted || entry.slug === wanted || entry.name === wanted)
  if (!hit) {
    const names = series.slice(0, 8).map((entry) => entry.name).join(', ')
    throw new ToolError(`There is no blog series named "${wanted.slice(0, 60)}".${names ? ` Existing series: ${names}.` : ''}`)
  }
  return hit.id
}

function isoOrNull(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}

function presentPost(row: BlogPostWithNote | BlogPostWithNames, tags: string[]): Record<string, unknown> {
  return {
    id: row.id,
    note_id: row.note_id,
    title: row.title,
    slug: row.slug,
    status: row.status,
    render_status: row.render_status,
    series: row.series_title,
    category: row.category_name,
    excerpt: row.excerpt,
    description: row.description,
    tags,
    published_at: isoOrNull(row.published_at),
    updated_at: isoOrNull(row.updated_at),
    note_in_trash: 'note_deleted_at' in row && row.note_deleted_at !== null,
  }
}

async function tagsFor(ctx: ToolContext, postId: string): Promise<string[]> {
  const map = await listPostTags(ctx.env.DB, ctx.store.userId, [postId])
  return map.get(postId) ?? []
}

async function loadPostContent(ctx: ToolContext, row: BlogPostWithNote): Promise<string | null> {
  await assertNoteReadable(ctx.env.DB, ctx.store.userId, row.note_id, await ctx.noteScope())
  if (row.note_deleted_at !== null) return null
  try {
    return (await loadMcpNote(ctx.env.DB, ctx.store.userId, row.note_id)).content
  } catch {
    return null
  }
}

/** Edit the note once, then let the projection follow; the note stays the source of truth. */
async function writeNoteAndSync(ctx: ToolContext, noteId: string, patch: { content?: string, title?: string }): Promise<void> {
  const current = await loadMcpNote(ctx.env.DB, ctx.store.userId, noteId)
  const content = patch.content ?? current.content
  const title = patch.title ?? current.title
  if (content !== current.content || title !== current.title) {
    await ask(() => editMcpNote(writeContext(ctx), {
      operationId: ctx.callId ?? 'assistant-blog',
      noteId,
      expectedRev: current.rev,
      operation: 'replace_all',
      text: content,
      ...(title !== current.title ? { title } : {}),
    }))
  }
  const saved = await loadMcpNote(ctx.env.DB, ctx.store.userId, noteId)
  await syncBlogPostFromNote(ctx.env.DB, ctx.store.userId, {
    id: noteId,
    title: saved.title,
    content: saved.content,
    deleted_at: null,
  })
}

function localDay(ctx: ToolContext, value: unknown, field: string, endOfDay: boolean): number {
  if (typeof value !== 'string' || !DATE_TEXT.test(value.trim())) {
    throw new ToolError(`"${field}" must be YYYY-MM-DD.`)
  }
  const parsed = parseLocalTime(`${value.trim()}T${endOfDay ? '23:59' : '00:00'}`, ctx.timezone)
  if (parsed === null) throw new ToolError(`"${field}" is not a real date.`)
  return parsed
}

function descriptionFrom(content: string): string {
  const body = postBody(content)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!body) return ''
  const sentenceEnd = body.search(/[.!?\u3002\uff01\uff1f]/)
  const cut = sentenceEnd >= 0 && sentenceEnd < MAX_DESCRIPTION_CHARS ? sentenceEnd + 1 : MAX_DESCRIPTION_CHARS
  return body.slice(0, cut).trim()
}

function titleCandidates(content: string, currentTitle: string): string[] {
  const headings = [...postBody(content).matchAll(/^#{1,2}\s+(.{1,120})$/gm)]
    .map((match) => match[1]!.trim())
    .filter(Boolean)
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const title of [currentTitle, ...headings]) {
    const text = title.trim()
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    candidates.push(text)
    if (candidates.length >= MAX_TITLE_CANDIDATES) break
  }
  if (candidates.length === 1 && currentTitle.trim()) {
    candidates.push(`${currentTitle.trim()}: a field note`)
  }
  return candidates.slice(0, MAX_TITLE_CANDIDATES)
}

async function freeSlug(ctx: ToolContext, requested: string, postId: string): Promise<string> {
  const base = slugifyBlogTitle(requested)
  const { results } = await ctx.env.DB
    .prepare('SELECT id, slug FROM blog_posts WHERE user_id = ?1 AND slug LIKE ?2')
    .bind(ctx.store.userId, `${base}%`)
    .all<{ id: string, slug: string }>()
  const taken = new Set(results.filter((row) => row.id !== postId).map((row) => row.slug))
  if (!taken.has(base)) return base
  for (let index = 2; index <= 100; index += 1) {
    if (!taken.has(`${base}-${index}`)) return `${base}-${index}`
  }
  return `${base}-${Date.now()}`
}

function resolveStatus(value: unknown): string {
  const status = typeof value === 'string' ? value.trim() : 'all'
  return ['all', 'draft', 'published', 'scheduled', 'pending', 'trash'].includes(status) ? status : 'all'
}

export const BLOG_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'blog_list_posts',
    description: 'List the blog posts this owner has, with id, note id, status, series, slug and dates. Filter by status, series, a title/slug search, or the day the post was published or last updated. Call it to find the post a sentence refers to.',
    permission: 'read',
    fields: {
      status: { type: 'string', enum: ['all', 'draft', 'published', 'scheduled', 'pending', 'trash'], description: 'Which posts: all (default), a status, or the trash.', optional: true },
      series: { type: 'string', description: 'Series name, slug or id.', maxLength: 120, optional: true },
      q: { type: 'string', description: 'Words from the title or slug.', maxLength: 200, optional: true },
      from: { type: 'string', description: 'Only posts published or updated on or after this day: YYYY-MM-DD.', maxLength: 32, optional: true },
      to: { type: 'string', description: 'Only posts published or updated on or before this day: YYYY-MM-DD.', maxLength: 32, optional: true },
      limit: { type: 'integer', description: 'How many posts to return, 1-50. Default 20.', minimum: 1, maximum: MAX_LISTED_POSTS, optional: true },
    },
    async run(args, ctx) {
      await requireBlogOwner(ctx)
      const seriesId = typeof args.series === 'string' && args.series.trim() ? await seriesIdFor(ctx, args.series) : undefined
      const limit = typeof args.limit === 'number' ? Math.min(MAX_LISTED_POSTS, Math.max(1, args.limit)) : 20
      const fromMs = args.from === undefined ? undefined : localDay(ctx, args.from, 'from', false)
      const toMs = args.to === undefined ? undefined : localDay(ctx, args.to, 'to', true)
      const listing = await ask(() => listAdminPosts(ctx.env.DB, ctx.store.userId, {
        status: resolveStatus(args.status),
        q: typeof args.q === 'string' ? args.q : '',
        ...(seriesId ? { seriesId } : {}),
        ...(fromMs === undefined ? {} : { fromMs }),
        ...(toMs === undefined ? {} : { toMs }),
        limit,
      }))
      const tags = await listPostTags(ctx.env.DB, ctx.store.userId, listing.rows.map((row) => row.id))
      return {
        total: listing.total,
        returned: listing.rows.length,
        posts: listing.rows.map((row) => presentPost(row, tags.get(row.id) ?? [])),
        ...(listing.total > listing.rows.length ? { note: 'More posts match than are listed; narrow the filter or raise limit.' } : {}),
      }
    },
  },
  {
    name: 'blog_read_post',
    description: 'Read one blog post: its status, slug, series, tags, excerpt and the note body behind it. Give the post id from blog_list_posts, or the note id.',
    permission: 'read',
    fields: {
      id: POST_REF_FIELD,
      include_content: { type: 'boolean', description: 'Include the note body. Default true.', optional: true },
    },
    async run(args, ctx) {
      await requireBlogOwner(ctx)
      const row = await postFor(ctx, String(args.id))
      const content = args.include_content === false ? null : await loadPostContent(ctx, row)
      return {
        post: presentPost(row, await tagsFor(ctx, row.id)),
        ...(content === null
          ? { content: null, note: 'The note behind this post is unavailable or in the trash.' }
          : { content: content.slice(0, MAX_CONTENT_CHARS), content_truncated: content.length > MAX_CONTENT_CHARS }),
      }
    },
  },
  {
    name: 'blog_create_draft',
    description: 'Turn a note into a real blog draft: mark the note as a post that is not published yet, then build its blog row through the same sync the admin uses. The note id stays the mapping, so calling again returns the same draft instead of a duplicate. Returns the draft post with its id, slug and status.',
    permission: 'write',
    fields: {
      note_id: { type: 'string', description: 'The note to turn into a blog draft.', minLength: 1, maxLength: 26 },
      title: { type: 'string', description: 'Rename the note to this title. Omit to keep it.', minLength: 1, maxLength: 300, optional: true },
      slug: { type: 'string', description: 'Desired slug; the projection makes it unique. Omit to derive it from the title.', maxLength: 200, optional: true },
      series: { type: 'string', description: 'Existing series name, slug or id to file it under.', maxLength: 120, optional: true },
      tags: { type: 'array', description: 'Tags to set on the note, which the post shows. Omit to keep the note tags.', items: 'string', maxItems: MAX_TAGS, optional: true },
    },
    async run(args, ctx) {
      await requireBlogOwner(ctx)
      const noteId = String(args.note_id)
      await assertNoteReadable(ctx.env.DB, ctx.store.userId, noteId, await ctx.noteScope())
      const existing = await findPostByNoteId(ctx.env.DB, ctx.store.userId, noteId)
      if (existing && existing.deleted_at !== null) {
        await bulkAdminPosts(ctx.env.DB, ctx.store.userId, [noteId], 'restore')
      }
      const note = await loadMcpNote(ctx.env.DB, ctx.store.userId, noteId)
      if (existing && existing.deleted_at === null) {
        const tags = await tagsFor(ctx, existing.id)
        return { created: false, note_id: noteId, post: presentPost(existing, tags), note_text: 'This note already has a blog draft.' }
      }
      let content = asBlogPost(note.content)
      content = setBlogPublished(content, false)
      if (typeof args.slug === 'string' && args.slug.trim()) content = setFrontMatterValue(content, 'blogSlug', args.slug.trim())
      if (typeof args.series === 'string' && args.series.trim()) content = setFrontMatterValue(content, 'blogSeries', args.series.trim())
      if (Array.isArray(args.tags)) {
        content = withTags(content, args.tags.filter((tag): tag is string => typeof tag === 'string'))
      }
      await writeNoteAndSync(ctx, noteId, {
        content,
        ...(typeof args.title === 'string' && args.title.trim() ? { title: args.title.trim() } : {}),
      })
      const row = await postFor(ctx, noteId)
      await recordBlogAudit(ctx.env.DB, ctx.store.userId, 'post.draft', 'post', row.id, { noteId, by: 'assistant' })
      return { created: true, note_id: noteId, post: presentPost(row, await tagsFor(ctx, row.id)) }
    },
  },
  {
    name: 'blog_update_post',
    description: 'Edit an existing blog post. The body replaces the note body and the front matter is kept; title renames the note; excerpt, description, slug and series are written to the post itself. Tags replace the note tags, which the post shows.',
    permission: 'write',
    fields: {
      id: POST_REF_FIELD,
      title: { type: 'string', description: 'New title, which renames the note.', minLength: 1, maxLength: 300, optional: true },
      body: { type: 'string', description: 'New Markdown body, without front matter; the existing front matter is kept.', maxLength: 60_000, optional: true },
      excerpt: { type: 'string', description: 'Listing excerpt. Empty string clears it.', maxLength: 2_000, optional: true },
      description: { type: 'string', description: 'SEO/meta description. Empty string clears it.', maxLength: 2_000, optional: true },
      slug: { type: 'string', description: 'New slug; the post store keeps it unique.', maxLength: 200, optional: true },
      series: { type: 'string', description: 'Existing series name, slug or id. Empty string removes the series.', maxLength: 120, optional: true },
      series_order: { type: 'integer', description: 'Position inside the series.', minimum: 0, maximum: 9999, optional: true },
      tags: { type: 'array', description: 'Tags that replace the note tags.', items: 'string', maxItems: MAX_TAGS, optional: true },
    },
    async run(args, ctx) {
      await requireBlogOwner(ctx)
      const row = await postFor(ctx, String(args.id))
      await assertNoteReadable(ctx.env.DB, ctx.store.userId, row.note_id, await ctx.noteScope())
      const current = await loadMcpNote(ctx.env.DB, ctx.store.userId, row.note_id)
      let content = current.content
      if (typeof args.body === 'string') content = replaceBody(content, args.body)
      if (Array.isArray(args.tags)) {
        content = withTags(content, args.tags.filter((tag): tag is string => typeof tag === 'string'))
      }
      const title = typeof args.title === 'string' ? args.title.trim() : undefined
      if (content !== current.content || title !== undefined) await writeNoteAndSync(ctx, row.note_id, { content, ...(title ? { title } : {}) })
      const patch: Parameters<typeof updateAdminPostMeta>[3] = {}
      if (typeof args.excerpt === 'string') patch.excerpt = args.excerpt
      if (typeof args.description === 'string') patch.description = args.description
      if (typeof args.slug === 'string' && args.slug.trim()) patch.slug = args.slug.trim()
      if (typeof args.series === 'string') patch.seriesId = args.series.trim() ? await seriesIdFor(ctx, args.series) : null
      if (typeof args.series_order === 'number') patch.seriesOrder = Math.trunc(args.series_order)
      if (Object.keys(patch).length > 0) await ask(() => updateAdminPostMeta(ctx.env.DB, ctx.store.userId, row.id, patch))
      const updated = await postFor(ctx, row.id)
      await recordBlogAudit(ctx.env.DB, ctx.store.userId, 'post.update', 'post', updated.id, { by: 'assistant', fields: Object.keys(patch) })
      return { updated: true, post: presentPost(updated, await tagsFor(ctx, updated.id)) }
    },
  },
  {
    name: 'blog_seo',
    description: 'Return real, writable SEO fields for a post: title candidates taken from the article itself, a summary, a unique slug and tag suggestions. With apply left on it writes the fields you pass (and the derived summary and slug), so the admin screen shows them; with apply off it only answers with the values it would write.',
    permission: 'write',
    fields: {
      id: POST_REF_FIELD,
      title: { type: 'string', description: 'The title you chose from the candidates.', minLength: 1, maxLength: 300, optional: true },
      description: { type: 'string', description: 'The SEO summary you wrote. Omit to derive one from the body.', maxLength: MAX_DESCRIPTION_CHARS, optional: true },
      slug: { type: 'string', description: 'Desired slug. Omit to derive one from the title.', maxLength: 200, optional: true },
      tags: { type: 'array', description: 'Tags to suggest and, when applying, set on the note.', items: 'string', maxItems: MAX_TAGS, optional: true },
      apply: { type: 'boolean', description: 'Write the fields into the post. Default true.', optional: true },
    },
    async run(args, ctx) {
      await requireBlogOwner(ctx)
      const row = await postFor(ctx, String(args.id))
      await assertNoteReadable(ctx.env.DB, ctx.store.userId, row.note_id, await ctx.noteScope())
      const content = await loadPostContent(ctx, row) ?? ''
      const currentTags = await tagsFor(ctx, row.id)
      const chosenTitle = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : row.title
      const description = typeof args.description === 'string' && args.description.trim()
        ? args.description.trim()
        : descriptionFrom(content) || row.excerpt
      const tags = Array.isArray(args.tags)
        ? [...new Set(args.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.replace(/^#/, '').trim()).filter(Boolean))].slice(0, MAX_TAGS)
        : currentTags
      const requestedSlug = typeof args.slug === 'string' && args.slug.trim() ? args.slug.trim() : chosenTitle
      const apply = args.apply !== false
      const slug = apply ? requestedSlug : await freeSlug(ctx, requestedSlug, row.id)
      const candidates = titleCandidates(content, row.title)
      if (!apply) {
        return {
          applied: false,
          title_candidates: candidates,
          suggested: { title: chosenTitle, description, slug, tags },
          post: presentPost(row, currentTags),
        }
      }
      const note = await loadMcpNote(ctx.env.DB, ctx.store.userId, row.note_id)
      let next = note.content
      if (Array.isArray(args.tags)) next = withTags(next, tags)
      await writeNoteAndSync(ctx, row.note_id, {
        content: next,
        ...(chosenTitle !== row.title ? { title: chosenTitle } : {}),
      })
      const patch: Parameters<typeof updateAdminPostMeta>[3] = {
        slug,
        excerpt: description,
        description,
      }
      await ask(() => updateAdminPostMeta(ctx.env.DB, ctx.store.userId, row.id, patch))
      const updated = await postFor(ctx, row.id)
      await recordBlogAudit(ctx.env.DB, ctx.store.userId, 'post.seo', 'post', updated.id, { slug, by: 'assistant' })
      return {
        applied: true,
        title_candidates: candidates,
        applied_fields: { title: updated.title, description: updated.description, excerpt: updated.excerpt, slug: updated.slug, tags: await tagsFor(ctx, updated.id) },
        post: presentPost(updated, await tagsFor(ctx, updated.id)),
      }
    },
  },
  {
    name: 'blog_publish',
    description: 'Publish a blog post to the public site. Proposing it raises an approval card naming the title and slug; nothing changes until the reader approves. Approving sets the note\'s publish flag and syncs the projection, so the post becomes published when its render is ready and lands as pending_snapshot when the body still needs a fresh render in the admin.',
    permission: 'destructive',
    fields: { id: POST_REF_FIELD },
    async prepare(args, ctx): Promise<PreparedTarget> {
      await requireBlogOwner(ctx)
      const row = await postFor(ctx, String(args.id))
      if (row.deleted_at !== null) throw new ToolError('That post is in the trash. Restore it before publishing.')
      if (row.note_deleted_at !== null) throw new ToolError('The note behind this post is in the trash, so there is nothing to publish.')
      const title = row.title.trim()
      if (!title) throw new ToolError('Give the post a title before publishing.')
      const content = await loadPostContent(ctx, row)
      if (content === null) throw new ToolError('The note behind this post is unavailable.')
      if (!postBody(content).trim()) throw new ToolError('Give the post a body before publishing.')
      if (!row.slug.trim()) throw new ToolError('This post has no slug yet; run blog_seo first.')
      return { targetId: row.id, targetLabel: `${title} · /${row.slug}` }
    },
    async commit(targetId, ctx) {
      await requireBlogOwner(ctx)
      const row = await postFor(ctx, targetId)
      await assertNoteReadable(ctx.env.DB, ctx.store.userId, row.note_id, await ctx.noteScope())
      const note = await loadMcpNote(ctx.env.DB, ctx.store.userId, row.note_id)
      if (!readBlogFrontMatter(note.content).isPublished) {
        const content = setBlogPublished(note.content, true)
        await ask(() => editMcpNote(writeContext(ctx), {
          operationId: ctx.callId ?? 'assistant-blog-publish',
          noteId: row.note_id,
          expectedRev: note.rev,
          operation: 'replace_all',
          text: content,
        }))
      }
      const saved = await loadMcpNote(ctx.env.DB, ctx.store.userId, row.note_id)
      await syncBlogPostFromNote(ctx.env.DB, ctx.store.userId, {
        id: row.note_id,
        title: saved.title,
        content: saved.content,
        deleted_at: null,
      })
      const published = await postFor(ctx, targetId)
      const status: BlogPostStatus = published.status
      await recordBlogAudit(ctx.env.DB, ctx.store.userId, 'post.publish', 'post', published.id, {
        slug: published.slug,
        status,
        by: 'assistant',
      })
      return {
        published: status === 'published' || status === 'scheduled',
        status,
        id: published.id,
        note_id: published.note_id,
        title: published.title,
        slug: published.slug,
        ...(status === 'pending_snapshot'
          ? { note: 'The publish flag is set, but this body has no fresh render yet. Open the post in the blog admin to render its snapshot; the public site shows it afterwards.' }
          : {}),
      }
    },
  },
]
