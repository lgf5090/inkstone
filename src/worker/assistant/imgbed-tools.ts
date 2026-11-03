/**
 * The image bed, as the assistant's hands.
 *
 * The library screen could already be searched by hand, but asking about it in words had no path: the
 * only image-bed code the turn could reach was the upload pipeline. These tools are that path, and they
 * are deliberately built on the same store and the same access rules the screen uses — `listFiles` for
 * every listing, `getStats` for the totals, the tag writer for tags, `deleteWholeFile` for a removal —
 * so a number the model reports and a number the screen draws cannot disagree.
 *
 * Permissions follow the image bed's own scopes rather than the assistant's: reading the library is open
 * to a member, while tagging, statistics and deletion are the owner's, exactly as the HTTP routes ask
 * (`list` for a listing, `delete`/`manage` for everything that changes a file or reads the whole
 * deployment's usage).
 */

import { dayBounds, localDate } from '@shared/assistant-time'
import { formatBytes } from '@shared/byte-format'
import {
  normalizeTag,
  type ImgbedChannelType,
  type ImgbedFile,
  type ImgbedListQuery,
} from '@shared/imgbed/model'
import { parseAiSettings } from '@shared/imgbed/settings'
import { callModel, parseTags, promptFor } from '../imgbed/ai'
import { getResolvedChannel } from '../imgbed/channels'
import {
  addFileTags,
  deleteFileRow,
  getChannelUsage,
  getFile,
  getSettingsGroup,
  getSidebarData,
  getStats,
  listFiles,
  removeFileTags,
  replaceFileTags,
} from '../imgbed/store'
import { deleteWholeFile, getWholeFile } from '../imgbed/storage'
import { AssistantStore } from './store'
import { ToolError, type ToolContext, type ToolDefinition } from './tools'

const FILE_TYPES = ['image', 'video', 'audio', 'other'] as const
const SORTS = ['time', 'size', 'fileName'] as const
const ORIENTATIONS = ['landscape', 'portrait', 'square'] as const
const TAG_ACTIONS = ['add', 'set', 'remove'] as const

const MAX_LIST_RESULTS = 100
const MAX_FETCH = 500
const MAX_TAG_FILES = 100
const MAX_TAGS = 10
/** The same preview ceiling the AI-tagging route applies: a data URL is a prompt, not a download. */
const MAX_VISION_IMAGE_BYTES = 256 * 1024
const MAX_DELETE_FILES = 50

/**
 * A local calendar day as the instant its day starts.
 *
 * The screen says "2026-11-03", and a file uploaded at 00:30 in Shanghai belongs to that day — which UTC
 * midnight does not express. `dayBounds` is the same helper the to-do tools use, so "today" means one
 * thing across the assistant.
 */
function dayStart(value: unknown, ctx: ToolContext, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new ToolError(`${name} must be YYYY-MM-DD.`)
  const bounds = dayBounds(value, ctx.timezone)
  if (!bounds) throw new ToolError(`Could not understand the date "${value.slice(0, 32)}". Use YYYY-MM-DD.`)
  return bounds.start
}

/** The last millisecond of a local calendar day, because the store's upper bound is inclusive. */
function dayEnd(value: unknown, ctx: ToolContext, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new ToolError(`${name} must be YYYY-MM-DD.`)
  const bounds = dayBounds(value, ctx.timezone)
  if (!bounds) throw new ToolError(`Could not understand the date "${value.slice(0, 32)}". Use YYYY-MM-DD.`)
  return bounds.end - 1
}

function tagsFrom(args: Record<string, unknown>): string[] {
  const raw: string[] = []
  if (typeof args.tag === 'string' && args.tag.trim()) raw.push(args.tag)
  if (Array.isArray(args.tags)) {
    for (const entry of args.tags) if (typeof entry === 'string' && entry.trim()) raw.push(entry)
  }
  const tags: string[] = []
  for (const entry of raw) {
    const tag = normalizeTag(entry)
    if (!tag) throw new ToolError(`"${entry.slice(0, 64)}" is not a tag this image bed can store.`)
    if (!tags.includes(tag)) tags.push(tag)
  }
  return tags
}

/** The URL the image-bed screen itself serves a file at, path segments encoded the same way. */
function fileUrl(ctx: ToolContext, file: ImgbedFile): string {
  return `${ctx.origin.replace(/\/+$/, '')}/imgbed/file/${file.id.split('/').map(encodeURIComponent).join('/')}`
}

function presentFile(ctx: ToolContext, file: ImgbedFile): Record<string, unknown> {
  return {
    id: file.id,
    name: file.fileName,
    type: file.fileType,
    size: formatBytes(file.sizeBytes),
    sizeBytes: file.sizeBytes,
    ...(file.width !== null && file.height !== null ? { dimensions: `${file.width}x${file.height}` } : {}),
    uploaded: localDate(file.createdAt, ctx.timezone),
    tags: file.tags,
    channel: file.channelName || file.channel,
    access: file.listType,
    label: file.label,
    directory: file.directory || '/',
    ...(file.favorite ? { favorite: true } : {}),
    ...(file.pinned ? { pinned: true } : {}),
    url: file.source === 'external' && file.externalLink ? file.externalLink : fileUrl(ctx, file),
  }
}

function queryFor(args: Record<string, unknown>, ctx: ToolContext): ImgbedListQuery {
  const from = dayStart(args.from, ctx, 'from')
  const to = dayEnd(args.to, ctx, 'to')
  if (from !== undefined && to !== undefined && from > to) throw new ToolError('The date range starts after it ends.')
  const type = typeof args.type === 'string' && (FILE_TYPES as readonly string[]).includes(args.type)
    ? [args.type]
    : undefined
  const sort = typeof args.sort === 'string' && (SORTS as readonly string[]).includes(args.sort)
    ? args.sort as ImgbedListQuery['sort']
    : 'time'
  return {
    // Every listing is across folders, the way the library's global filters read: asking about "the
    // image bed" must not silently mean one folder the reader happens to have open.
    dir: '',
    recursive: true,
    skipDirectories: true,
    search: typeof args.search === 'string' ? args.search : '',
    includeTags: tagsFrom(args),
    ...(type ? { fileType: type } : {}),
    ...(from !== undefined ? { createdFrom: from } : {}),
    ...(to !== undefined ? { createdTo: to } : {}),
    sort,
    sortOrder: 'desc',
  }
}

/** Size and orientation are the two filters the listing SQL does not carry, so they are applied here. */
function narrow(files: ImgbedFile[], args: Record<string, unknown>): ImgbedFile[] {
  const minMB = typeof args.minSizeMB === 'number' ? args.minSizeMB : undefined
  const maxMB = typeof args.maxSizeMB === 'number' ? args.maxSizeMB : undefined
  const orientation = typeof args.orientation === 'string' && (ORIENTATIONS as readonly string[]).includes(args.orientation)
    ? args.orientation
    : undefined
  if (minMB === undefined && maxMB === undefined && !orientation) return files
  return files.filter((file) => {
    const mb = file.sizeBytes / (1024 * 1024)
    if (minMB !== undefined && mb < minMB) return false
    if (maxMB !== undefined && mb > maxMB) return false
    if (!orientation) return true
    if (file.width === null || file.height === null) return false
    if (orientation === 'landscape') return file.width > file.height * 1.1
    if (orientation === 'portrait') return file.width < file.height * 0.9
    return file.width >= file.height * 0.9 && file.width <= file.height * 1.1
  })
}

function hasNarrowing(args: Record<string, unknown>): boolean {
  return typeof args.minSizeMB === 'number' || typeof args.maxSizeMB === 'number' || typeof args.orientation === 'string'
}

/**
 * The owner check, reusing the rule the HTTP routes state.
 *
 * The assistant never runs as a token, so the one question left is the account's role: the image-bed
 * routes answer `403 Owner access required` for anything beyond `list`, and a tool refusing differently
 * from the screen would let the model describe an action the reader cannot perform.
 */
async function requireImgbedOwner(ctx: ToolContext, action: string): Promise<void> {
  const row = await ctx.env.DB.prepare('SELECT role FROM users WHERE id = ?1')
    .bind(ctx.store.userId).first<{ role: string }>()
  if (row?.role !== 'owner') throw new ToolError(`Only the owner account can ${action} the image bed.`)
}

async function fileOrThrow(ctx: ToolContext, id: string): Promise<ImgbedFile> {
  const file = await getFile(ctx.env.DB, id)
  if (!file) throw new ToolError(`No image-bed file has the id "${id.slice(0, 120)}". Use img_search or img_recent to find one.`)
  return file
}

function imageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp'
  return null
}

function toDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

/**
 * The vision model's tags for one file, read through the image bed's own AI settings.
 *
 * The bytes come from the file's own storage channel rather than from a public URL: a library with
 * referer rules and a whitelist mode may legitimately refuse an anonymous fetch of a file its owner
 * can see. The ceiling is the same preview ceiling the tagging route applies, because that is the size
 * the prompt was written for; a larger original is reported rather than truncated into a different
 * picture.
 */
async function visionTags(ctx: ToolContext, file: ImgbedFile, signal: AbortSignal): Promise<string[]> {
  if (!file.fileType.startsWith('image/') || file.fileType === 'image/svg+xml') {
    throw new Error('only raster images can be tagged automatically')
  }
  const settings = parseAiSettings(await getSettingsGroup(ctx.env.DB, 'ai'))
  if (!settings.enabled || !settings.modelId) throw new Error('AI tagging is disabled in the image bed settings')
  if (file.source === 'external') throw new Error('an external link has no stored bytes to look at')
  const channel = await getResolvedChannel(ctx.env, ctx.env.DB, file.source as ImgbedChannelType, file.channelName)
  if (!channel) throw new Error('the file\'s storage channel is not configured')
  const response = await getWholeFile(ctx.env, channel, file)
  if (!response) throw new Error('the file could not be read from its storage channel')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_VISION_IMAGE_BYTES) {
    throw new Error(`the file is ${formatBytes(bytes.byteLength)}, larger than the ${formatBytes(MAX_VISION_IMAGE_BYTES)} preview the tagger accepts`)
  }
  const mime = imageType(bytes)
  if (!mime) throw new Error('the stored content is not a JPEG, PNG or WebP image')
  const store = new AssistantStore(ctx.env.DB, ctx.store.userId, ctx.env)
  const model = await store.getModel(settings.modelId)
  if (!model || !model.vision) throw new Error('the chosen tagging model is not a vision model')
  const provider = await store.vendorAccess(model.providerId)
  if (!provider) throw new Error('the tagging model provider has no usable key')
  const answer = await callModel(
    ctx.env, ctx.store.userId, settings.modelId,
    promptFor(settings, settings.preferredTags),
    { mime, dataUrl: toDataUrl(bytes, mime) },
    signal,
  )
  return parseTags(answer.text, settings.maxTags)
}

async function applyTags(ctx: ToolContext, id: string, tags: string[], action: 'add' | 'set' | 'remove'): Promise<string[]> {
  if (action === 'set') await replaceFileTags(ctx.env.DB, id, tags)
  else if (action === 'remove') await removeFileTags(ctx.env.DB, id, tags)
  else await addFileTags(ctx.env.DB, id, tags)
  return await getFile(ctx.env.DB, id).then((file) => file?.tags ?? [])
}

export const IMGBED_TOOLS: ToolDefinition[] = [
  {
    name: 'img_search',
    description: 'Search image-bed files across every folder by keyword, tag, upload date, kind, file size or orientation. Returns real files with ids, URLs, tags and dates. Use img_info with the id for one file\'s full record.',
    permission: 'read',
    fields: {
      search: { type: 'string', description: 'Words in the file name or id.', optional: true, maxLength: 200 },
      tag: { type: 'string', description: 'One exact tag to match, without #. Omit to search every tag.', optional: true, maxLength: 64 },
      tags: { type: 'array', items: 'string', description: 'Tags the file must carry, all of them, without #.', optional: true, maxItems: MAX_TAGS },
      from: { type: 'string', description: 'First upload day to include, local to the reader: YYYY-MM-DD.', optional: true, maxLength: 32 },
      to: { type: 'string', description: 'Last upload day to include, local to the reader: YYYY-MM-DD.', optional: true, maxLength: 32 },
      type: { type: 'string', enum: FILE_TYPES, description: 'Picture, video, audio, or anything else.', optional: true },
      minSizeMB: { type: 'number', description: 'Smallest file size in megabytes.', optional: true, minimum: 0, maximum: 100_000 },
      maxSizeMB: { type: 'number', description: 'Largest file size in megabytes.', optional: true, minimum: 0, maximum: 100_000 },
      orientation: { type: 'string', enum: ORIENTATIONS, description: 'Picture orientation; files with unknown dimensions are left out.', optional: true },
      sort: { type: 'string', enum: SORTS, description: 'Order: time (default), size, or fileName.', optional: true },
      limit: { type: 'integer', description: 'Files to return, 1-100. Default 20.', optional: true, minimum: 1, maximum: MAX_LIST_RESULTS },
    },
    async run(args, ctx) {
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(MAX_LIST_RESULTS, args.limit)) : 20
      const query = queryFor(args, ctx)
      const count = hasNarrowing(args) ? Math.min(MAX_FETCH, Math.max(limit * 10, 100)) : limit
      const result = await listFiles(ctx.env.DB, { ...query, count })
      const files = narrow(result.files, args)
      const returned = files.slice(0, limit)
      return {
        total: result.totalCount,
        matched: hasNarrowing(args) ? files.length : result.totalCount,
        returned: returned.length,
        files: returned.map((file) => presentFile(ctx, file)),
        ...(result.totalCount > result.files.length && hasNarrowing(args)
          ? { note: `The image bed holds ${result.totalCount} matching files; the newest ${result.files.length} were examined before the size/orientation filter.` }
          : returned.length < result.totalCount
            ? { note: `Only the first ${returned.length} of ${result.totalCount} matches are shown. Narrow the search for the rest.` }
            : {}),
      }
    },
  },
  {
    name: 'img_recent',
    description: 'List the image-bed files uploaded most recently, newest first. Use it for "the screenshots from the last few days".',
    permission: 'read',
    fields: {
      days: { type: 'integer', description: 'How many days back to look, 1-90. Default 3.', optional: true, minimum: 1, maximum: 90 },
      type: { type: 'string', enum: FILE_TYPES, description: 'Only pictures, videos, audio or other files.', optional: true },
      tag: { type: 'string', description: 'One exact tag to match, without #.', optional: true, maxLength: 64 },
      limit: { type: 'integer', description: 'Files to return, 1-100. Default 20.', optional: true, minimum: 1, maximum: MAX_LIST_RESULTS },
    },
    async run(args, ctx) {
      const days = typeof args.days === 'number' ? Math.max(1, Math.min(90, args.days)) : 3
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(MAX_LIST_RESULTS, args.limit)) : 20
      const now = Date.now()
      const result = await listFiles(ctx.env.DB, {
        dir: '', recursive: true, skipDirectories: true,
        createdFrom: now - days * 86_400_000, createdTo: now,
        ...(typeof args.type === 'string' && (FILE_TYPES as readonly string[]).includes(args.type) ? { fileType: [args.type] } : {}),
        includeTags: tagsFrom({ tag: args.tag }),
        sort: 'time', sortOrder: 'desc',
        count: limit,
      })
      return {
        days,
        from: localDate(now - days * 86_400_000, ctx.timezone),
        to: localDate(now, ctx.timezone),
        total: result.totalCount,
        returned: result.files.length,
        files: result.files.map((file) => presentFile(ctx, file)),
        ...(result.totalCount > result.files.length ? { note: `Only the newest ${result.files.length} of ${result.totalCount} files in that range are shown.` } : {}),
      }
    },
  },
  {
    name: 'img_info',
    description: 'Read one image-bed file\'s full record: name, kind, size, dimensions, dates, tags, folder, channel, access status and its URL. Accepts an id, or a file name that matches exactly one file.',
    permission: 'read',
    fields: {
      id: { type: 'string', description: 'The file id, or a file name that matches one file.', minLength: 1, maxLength: 512 },
    },
    async run(args, ctx) {
      const ref = String(args.id)
      let file = await getFile(ctx.env.DB, ref)
      if (!file) {
        const found = await listFiles(ctx.env.DB, {
          dir: '', recursive: true, skipDirectories: true, search: ref, count: 5,
        })
        const exact = found.files.filter((entry) => entry.fileName === ref || entry.id === ref)
        if (exact.length === 1) file = exact[0] ?? null
        else if (found.files.length === 1) file = found.files[0] ?? null
      }
      if (!file) throw new ToolError(`No single image-bed file matches "${ref.slice(0, 120)}". Use img_search to find its id.`)
      return { file: presentFile(ctx, file) }
    },
  },
  {
    name: 'img_tag',
    description: 'Add, replace or remove tags on up to 100 image-bed files at once, or let the image bed\'s vision model tag raster images. Accepts explicit tags, vision, or both. Requires the owner account.',
    permission: 'write',
    fields: {
      ids: { type: 'array', items: 'string', description: 'File ids to tag.', maxItems: MAX_TAG_FILES },
      tags: { type: 'array', items: 'string', description: 'Tags to apply, without #. Lowercase, letters/numbers/CJK/underscore/hyphen/slash.', optional: true, maxItems: MAX_TAGS },
      action: { type: 'string', enum: TAG_ACTIONS, description: 'add (default), set to replace every tag, or remove.', optional: true },
      vision: { type: 'boolean', description: 'Also ask the image bed\'s vision model for tags. Set false when the reader only named tags.', optional: true },
    },
    async run(args, ctx) {
      await requireImgbedOwner(ctx, 'tag files in')
      const ids = Array.isArray(args.ids) ? [...new Set(args.ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))] : []
      if (!ids.length) throw new ToolError('Name at least one file id. Use img_search or img_recent to find them.')
      const tags = tagsFrom(args)
      const vision = args.vision === true
      const action = typeof args.action === 'string' && (TAG_ACTIONS as readonly string[]).includes(args.action)
        ? args.action as 'add' | 'set' | 'remove'
        : 'add'
      if (!tags.length && !vision) throw new ToolError('Provide tags to apply, or vision: true to have the vision model propose them.')
      if (vision && action === 'remove') throw new ToolError('Vision proposes tags; it cannot choose which ones to remove. Name the tags instead.')
      const signal = ctx.signal ?? AbortSignal.timeout(30_000)
      const results: Array<Record<string, unknown>> = []
      for (const id of ids) {
        try {
          const file = await fileOrThrow(ctx, id)
          let current: string[] = file.tags
          const proposed = vision ? await visionTags(ctx, file, signal) : []
          if (vision && !proposed.length) {
            results.push({ id, ok: false, error: 'the vision model proposed no tags', tags: current })
            continue
          }
          if (action === 'set') {
            current = await applyTags(ctx, id, [...new Set([...proposed, ...tags])], 'set')
          } else {
            if (proposed.length) current = await applyTags(ctx, id, proposed, 'add')
            if (tags.length) current = await applyTags(ctx, id, tags, action)
          }
          results.push({ id, ok: true, name: file.fileName, tags: current })
        } catch (error) {
          results.push({ id, ok: false, error: error instanceof Error ? error.message : 'tagging failed' })
        }
      }
      const updated = results.filter((entry) => entry.ok === true).length
      return {
        updated,
        failed: results.length - updated,
        results,
        ...(updated === 0 ? { note: 'No file was tagged. Read the errors above before trying a different set of files.' } : {}),
      }
    },
  },
  {
    name: 'img_stats',
    description: 'Report the image bed\'s real totals: file count, space used, files by kind, labels, access status, the busiest tags and per-channel usage. Requires the owner account.',
    permission: 'read',
    fields: {
      topTags: { type: 'integer', description: 'How many tags to include, 1-50. Default 15.', optional: true, minimum: 1, maximum: 50 },
    },
    async run(args, ctx) {
      await requireImgbedOwner(ctx, 'read the statistics of')
      const topTags = typeof args.topTags === 'number' ? Math.max(1, Math.min(50, args.topTags)) : 15
      const [stats, sidebar, channels] = await Promise.all([
        getStats(ctx.env.DB),
        getSidebarData(ctx.env.DB),
        getChannelUsage(ctx.env.DB),
      ])
      return {
        totalFiles: stats.totalFiles,
        totalBytes: stats.totalBytes,
        totalSize: formatBytes(stats.totalBytes),
        categories: stats.categoryStats,
        labels: stats.labelStats,
        access: stats.accessStats,
        directories: stats.directoryCount,
        favorites: sidebar.counts.favorite,
        pinned: sidebar.counts.pinned,
        oldestUpload: stats.oldestAt === null ? null : localDate(stats.oldestAt, ctx.timezone),
        newestUpload: stats.newestAt === null ? null : localDate(stats.newestAt, ctx.timezone),
        topTags: sidebar.tags.slice(0, topTags),
        channels: channels.map((channel) => ({
          channel: channel.channelName || channel.channel,
          files: channel.count,
          size: formatBytes(channel.usedMB * 1024 * 1024),
        })),
      }
    },
  },
  {
    name: 'img_delete',
    description: 'Delete image-bed files and their stored object. This is proposed for the reader to approve; nothing is removed until they press Approve. Requires the owner account.',
    permission: 'destructive',
    fields: {
      ids: { type: 'array', items: 'string', description: 'File ids to delete.', maxItems: MAX_DELETE_FILES },
    },
    async prepare(args, ctx) {
      await requireImgbedOwner(ctx, 'delete files from')
      const ids = Array.isArray(args.ids) ? [...new Set(args.ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))] : []
      if (!ids.length) throw new ToolError('Name at least one file id to delete.')
      const files: ImgbedFile[] = []
      for (const id of ids) {
        const file = await getFile(ctx.env.DB, id)
        if (file) files.push(file)
      }
      if (!files.length) throw new ToolError('None of those ids exist in the image bed. Use img_search to find the right file.')
      const names = files.slice(0, 3).map((file) => file.fileName).join(', ')
      return {
        targetId: files.map((file) => file.id).join('\n'),
        targetLabel: `delete ${files.length} image-bed file(s): ${names}${files.length > 3 ? '…' : ''}`,
      }
    },
    async commit(targetId, ctx) {
      const ids = targetId.split('\n').filter(Boolean)
      let deleted = 0
      const failed: Array<{ id: string, error: string }> = []
      for (const id of ids) {
        const file = await getFile(ctx.env.DB, id)
        if (!file) { failed.push({ id, error: 'not_found' }); continue }
        try {
          const channel = await getResolvedChannel(ctx.env, ctx.env.DB, file.source as ImgbedChannelType, file.channelName)
          if (!channel) throw new Error('channel_not_configured')
          await deleteWholeFile(ctx.env, channel, file)
          await deleteFileRow(ctx.env.DB, file.id)
          deleted += 1
        } catch (error) {
          failed.push({ id, error: error instanceof Error ? error.message : 'delete_failed' })
        }
      }
      return { deleted, failed }
    },
  },
]
