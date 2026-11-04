/**
 * The ScriptsHub tools: the assistant can find, read, create and publish a snippet.
 *
 * Every call goes through the same `ScriptsHubStore` the screens and the HTTP routes use, so the
 * account boundary and the path validation are the ones the app already enforces. Publishing is a
 * write rather than a destructive action — it exposes a file the reader chose, and the reader can
 * pause or remove it from the same card — but the tool names the exact path and visibility in its
 * answer, so the model cannot read a publish as a local edit.
 */

import { isScriptLanguage } from '@shared/scriptshub/languages'
import { publicationUrlPath } from '@shared/scriptshub/path'
import { ScriptsHubStore } from '../scriptshub/store'
import { ToolError, type ToolDefinition } from './tools'

const MAX_LIST = 30
const MAX_READ_CHARS = 160_000

const LIMIT_FIELD = {
  type: 'integer' as const,
  description: `How many snippets to return. Defaults to 10, at most ${MAX_LIST}.`,
  minimum: 1,
  maximum: MAX_LIST,
  optional: true,
}

const DATE_FIELD = {
  type: 'string' as const,
  description: 'An ISO instant for an optional expiry, for example 2026-12-31T23:59:59Z.',
  maxLength: 40,
  optional: true,
  nullable: true,
}

function limitOf(value: unknown): number {
  return typeof value === 'number' ? Math.min(MAX_LIST, Math.max(1, Math.trunc(value))) : 10
}

function summary(snippet: Awaited<ReturnType<ScriptsHubStore['listSnippets']>>['items'][number]) {
  return {
    id: snippet.id,
    title: snippet.title,
    description: snippet.description,
    language: snippet.language,
    folderId: snippet.folderId,
    tags: snippet.tags.map((tag) => tag.name),
    files: snippet.fileCount,
    favorite: snippet.isFavorite,
    pinned: snippet.isPinned,
    deprecated: snippet.isDeprecated,
    publications: snippet.publications.map((publication) => ({ fileId: publication.fileId, path: publication.path })),
    updatedAt: new Date(snippet.updatedAt).toISOString(),
  }
}

export const SCRIPTSHUB_TOOLS: ToolDefinition[] = [
  {
    name: 'scriptshub_search',
    permission: 'read',
    maxCallsPerTurn: 6,
    description: 'Search saved script snippets by title, description or file content. Returns summaries and ids; call scriptshub_read for the code.',
    fields: {
      query: { type: 'string', description: 'Words to find. A blank query lists the most recent snippets.', maxLength: 200, optional: true },
      folderId: { type: 'string', description: 'Only snippets in this folder and its subfolders.', maxLength: 64, optional: true },
      tagId: { type: 'string', description: 'Only snippets wearing this tag id.', maxLength: 64, optional: true },
      limit: LIMIT_FIELD,
    },
    async run(args, ctx) {
      const store = new ScriptsHubStore(ctx.env.DB, ctx.store.userId)
      const list = await store.listSnippets({
        search: typeof args.query === 'string' ? args.query : '',
        folderId: typeof args.folderId === 'string' ? args.folderId : null,
        tagId: typeof args.tagId === 'string' ? args.tagId : null,
        limit: limitOf(args.limit),
      })
      return { total: list.total, snippets: list.items.map(summary) }
    },
  },
  {
    name: 'scriptshub_read',
    permission: 'read',
    maxCallsPerTurn: 8,
    description: 'Read one snippet with every file, its tags and its distribution path. Call scriptshub_search first to find the id.',
    fields: {
      id: { type: 'string', minLength: 1, maxLength: 64, description: 'The snippet id.' },
    },
    async run(args, ctx) {
      const store = new ScriptsHubStore(ctx.env.DB, ctx.store.userId)
      const detail = await store.getSnippet(String(args.id))
      let budget = MAX_READ_CHARS
      const files = detail.files.map((file) => {
        const content = file.content.slice(0, Math.max(0, budget))
        budget -= content.length
        return {
          id: file.id,
          name: file.name,
          language: file.language,
          content,
          truncated: content.length < file.content.length,
        }
      })
      return {
        id: detail.id,
        title: detail.title,
        description: detail.description,
        notes: detail.notes,
        sourceUrl: detail.sourceUrl,
        folderId: detail.folderId,
        language: detail.language,
        tags: detail.tags.map((tag) => ({ id: tag.id, name: tag.name })),
        files,
        publications: detail.publications.map((publication) => ({
          id: publication.id,
          fileId: publication.fileId,
          fileName: detail.files.find((file) => file.id === publication.fileId)?.name ?? '',
          path: publication.path,
          visibility: publication.visibility,
          enabled: publication.isEnabled,
          expiresAt: publication.expiresAt ? new Date(publication.expiresAt).toISOString() : null,
          url: publicationUrlPath(publication.path),
        })),
        revisionCount: detail.revisionCount,
      }
    },
  },
  {
    name: 'scriptshub_create',
    permission: 'write',
    maxCallsPerTurn: 4,
    description: 'Create a snippet with one or more files. Use this for a command the reader wants to keep; do not write a note and call it a script.',
    fields: {
      title: { type: 'string', minLength: 1, maxLength: 160, description: 'The snippet title.' },
      description: { type: 'string', maxLength: 400, description: 'What the script does.', optional: true },
      language: {
        type: 'string',
        description: 'The primary language id, for example shell, python, javascript, sql.',
        maxLength: 24,
        enum: ['shell', 'powershell', 'python', 'javascript', 'typescript', 'json', 'yaml', 'toml', 'sql', 'markdown', 'ruby', 'go', 'rust', 'php', 'lua', 'batch', 'dockerfile', 'text'],
        optional: true,
      },
      folderId: { type: 'string', description: 'The folder to file it in.', maxLength: 64, optional: true, nullable: true },
      tags: { type: 'array', items: 'string', description: 'Tag names to apply, created when missing.', maxItems: 8, optional: true },
      fileName: { type: 'string', maxLength: 128, description: 'The first file name. Defaults from the language.', optional: true },
      content: { type: 'string', maxLength: 512_000, description: 'The first file body.', optional: true },
    },
    async run(args, ctx) {
      const store = new ScriptsHubStore(ctx.env.DB, ctx.store.userId)
      const language = isScriptLanguage(args.language) ? args.language : 'shell'
      const created = await store.createSnippet({
        title: String(args.title),
        description: typeof args.description === 'string' ? args.description : '',
        folderId: typeof args.folderId === 'string' ? args.folderId : null,
        language,
      })
      const tagIds: string[] = []
      for (const name of Array.isArray(args.tags) ? args.tags : []) {
        if (typeof name !== 'string') continue
        const existing = (await store.listTags()).find((tag) => !tag.parentId && tag.name.toLowerCase() === name.trim().toLowerCase())
        const tag = existing ?? await store.createTag({ name })
        tagIds.push(tag.id)
      }
      const file = created.files[0]
      if (!file) throw new ToolError('The snippet was created without a file')
      const saved = await store.saveSnippet(created.id, {
        title: created.title,
        description: typeof args.description === 'string' ? args.description : '',
        folderId: typeof args.folderId === 'string' ? args.folderId : null,
        language,
        sourceUrl: '',
        notes: '',
        tags: tagIds,
        files: [{
          id: file.id,
          name: typeof args.fileName === 'string' && args.fileName.trim() ? args.fileName.trim() : file.name,
          language,
          content: typeof args.content === 'string' ? args.content : '',
        }],
      }, 'save')
      return {
        id: saved.id,
        title: saved.title,
        files: saved.files.map((entry) => ({ id: entry.id, name: entry.name, language: entry.language })),
        revisionCount: saved.revisionCount,
      }
    },
  },
  {
    name: 'scriptshub_publish',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Publish one file of a snippet at its own public path that a curl command can fetch. Each file has its own publication; the path is validated before anything is written.',
    fields: {
      snippetId: { type: 'string', minLength: 1, maxLength: 64, description: 'The snippet id.' },
      fileId: { type: 'string', maxLength: 64, description: 'The file to publish. Defaults to the snippet\'s first file.', optional: true },
      path: { type: 'string', minLength: 1, maxLength: 200, description: 'The distribution path, for example system/linux/flatpak-setup.sh.' },
      visibility: {
        type: 'string',
        enum: ['public', 'token'],
        description: 'public serves anyone with the address; token requires the gate token in the URL.',
        optional: true,
      },
      expiresAt: DATE_FIELD,
    },
    async run(args, ctx) {
      const store = new ScriptsHubStore(ctx.env.DB, ctx.store.userId)
      const snippet = await store.getSnippet(String(args.snippetId))
      const fileId = typeof args.fileId === 'string' ? args.fileId : snippet.files[0]?.id
      if (!fileId) throw new ToolError('No snippet file has that id.')
      let expiresAt: number | null = null
      if (typeof args.expiresAt === 'string' && args.expiresAt) {
        const parsed = Date.parse(args.expiresAt)
        if (!Number.isFinite(parsed)) throw new ToolError('"expiresAt" must be an ISO instant.')
        expiresAt = parsed
      }
      const created = await store.createPublication(snippet.id, {
        fileId,
        path: String(args.path),
        visibility: args.visibility === 'token' ? 'token' : 'public',
        expiresAt,
        createShortlink: false,
      })
      return {
        id: created.id,
        fileId: created.fileId,
        fileName: snippet.files.find((file) => file.id === created.fileId)?.name ?? '',
        path: created.path,
        url: publicationUrlPath(created.path),
        detailPage: `/sc-view/${created.id}`,
        visibility: created.visibility,
        expiresAt: created.expiresAt ? new Date(created.expiresAt).toISOString() : null,
      }
    },
  },
  {
    name: 'scriptshub_stats',
    permission: 'read',
    maxCallsPerTurn: 4,
    description: 'Read ScriptsHub aggregates: snippet counts, publication share, downloads, unique visitors, top scripts and failed requests. Counts are real rows, never samples.',
    fields: {
      range: {
        type: 'string',
        enum: ['7d', '30d', '365d'],
        description: 'The window. Defaults to 30d.',
        optional: true,
      },
    },
    async run(args, ctx) {
      const store = new ScriptsHubStore(ctx.env.DB, ctx.store.userId)
      const range = args.range === '7d' || args.range === '365d' ? args.range : '30d'
      const stats = await store.stats(range)
      return {
        range: stats.range,
        since: new Date(stats.since).toISOString(),
        overview: stats.overview,
        distribution: {
          downloads: stats.distribution.downloads,
          uniqueVisitors: stats.distribution.uniqueVisitors,
          topScripts: stats.distribution.topScripts,
          failures: stats.distribution.failures,
          referrers: stats.distribution.referrers,
          browsers: stats.distribution.browsers,
        },
        snippets: {
          hotCopies: stats.snippets.hotCopies.slice(0, 5),
          revisions: stats.snippets.revisions,
        },
      }
    },
  },
]
