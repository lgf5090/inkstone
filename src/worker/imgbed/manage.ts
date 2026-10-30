import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import {
  IMGBED_LINK_FORMATS,
  fileIdentity,
  linkContentsFor,
  linkFor,
  normalizeTags,
  sanitizeFileName,
  sanitizeFolderPath,
  type ImgbedFile,
  type ImgbedLinkFormat,
  type ImgbedListQuery,
} from '@shared/imgbed/model'
import { parseSettingsGroup, type ImgbedOthersSettings, type ImgbedSecuritySettings } from '@shared/imgbed/settings'
import { requireImgbedActor, type ImgbedActor } from './auth'
import { listResolvedChannels } from './channels'
import {
  addFileTags,
  allDirectories,
  getSidebarData,
  setFileFlags,
  autocompleteTags,
  deleteFileRow,
  fileExists,
  filesByIp,
  getFile,
  getFileTags,
  getSettingsGroup,
  getStats,
  getChannelUsage,
  insertFile,
  listFiles,
  renameFileRow,
  removeFileTags,
  replaceFileTags,
  saveSettingsGroup,
  customerRows,
} from './store'
import { blockedIps, blockIp, scopeAllows, unblockIp } from './tokens'
import { deleteWholeFile, moveWholeFile } from './storage'

export function actorCanManage(actor: ImgbedActor | null): boolean {
  if (!actor) return false
  return actor.kind === 'session' ? actor.role === 'owner' : scopeAllows(actor.scopes, 'manage')
}

export function redactImgbedFile(file: ImgbedFile, privileged: boolean): ImgbedFile {
  if (privileged) return file
  return { ...file, objectKey: '', uploadIp: null, uploadAddress: null, parts: null }
}

export const imgbedManageRoutes = new Hono<AppBindings>()

function queryList(c: { req: { url: string } }): ImgbedListQuery {
  const url = new URL(c.req.url)
  const list = (key: string) => (url.searchParams.get(key) ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  return {
    dir: url.searchParams.get('dir') ?? '',
    start: Number(url.searchParams.get('start') ?? 0),
    count: url.searchParams.get('count') === null ? 50 : Number(url.searchParams.get('count')),
    search: url.searchParams.get('search') ?? '',
    includeTags: list('includeTags'),
    excludeTags: list('excludeTags'),
    listType: list('listType'),
    accessStatus: list('accessStatus'),
    label: list('label'),
    fileType: list('fileType'),
    channel: list('channel'),
    channelName: list('channelName'),
    favorite: url.searchParams.get('favorite') === 'true',
    pinned: url.searchParams.get('pinned') === 'true',
    tagPrefix: url.searchParams.get('tagPrefix') ?? '',
    createdFrom: url.searchParams.get('createdFrom') ? Number(url.searchParams.get('createdFrom')) : undefined,
    createdTo: url.searchParams.get('createdTo') ? Number(url.searchParams.get('createdTo')) : undefined,
    recursive: url.searchParams.get('recursive') === 'true',
    sort: (url.searchParams.get('sort') ?? 'time') as ImgbedListQuery['sort'],
    sortOrder: (url.searchParams.get('sortOrder') ?? 'desc') as ImgbedListQuery['sortOrder'],
  }
}

function fileForBackup(file: ImgbedFile) {
  return {
    id: file.id, objectKey: file.objectKey, fileName: file.fileName, fileType: file.fileType,
    sizeBytes: file.sizeBytes, width: file.width, height: file.height,
    uploadIp: file.uploadIp, uploadAddress: file.uploadAddress, listType: file.listType,
    label: file.label, directory: file.directory, source: file.source, externalLink: file.externalLink,
    channel: file.channel, channelName: file.channelName, isChunked: file.isChunked,
    parts: file.parts, uploaderId: file.uploaderId, createdAt: file.createdAt,
    updatedAt: file.updatedAt, favorite: file.favorite, pinned: file.pinned, tags: file.tags,
  }
}

function directoryTree(directories: string[]): { name: string; path: string; children: unknown[] } {
  const root: { name: string; path: string; children: any[] } = { name: '/', path: '', children: [] }
  const nodes = new Map<string, { name: string; path: string; children: any[] }>([['', root]])
  for (const directory of [...directories].sort()) {
    const parts = directory.split('/').filter(Boolean)
    let parent = root
    let path = ''
    for (const part of parts) {
      path += `${part}/`
      let node = nodes.get(path)
      if (!node) {
        node = { name: part, path, children: [] }
        nodes.set(path, node)
        parent.children.push(node)
      }
      parent = node
    }
  }
  return root
}

imgbedManageRoutes.get('/manage/list', async (c) => {
  const actor = await requireImgbedActor(c, 'list')
  const result = await listFiles(c.env.DB, queryList(c))
  const privileged = actorCanManage(actor)
  return c.json({ ...result, files: result.files.map((file) => redactImgbedFile(file, privileged)) })
})

imgbedManageRoutes.get('/manage/sidebar', async (c) => {
  await requireImgbedActor(c, 'list')
  const url = new URL(c.req.url)
  return c.json(await getSidebarData(c.env.DB, {
    timezoneOffset: Number(url.searchParams.get('tz') ?? 0),
    days: Number(url.searchParams.get('days') ?? 90),
  }))
})

imgbedManageRoutes.post('/manage/files/flags', async (c) => {
  await requireImgbedActor(c, 'upload')
  const body = await c.req.json().catch(() => null) as { ids?: string[]; favorite?: boolean; pinned?: boolean } | null
  const ids = Array.isArray(body?.ids) ? body!.ids.filter((id) => typeof id === 'string').slice(0, 1000) : []
  if (!ids.length) throw ApiError.badRequest('ids are required')
  const flags = { ...(typeof body?.favorite === 'boolean' ? { favorite: body.favorite } : {}), ...(typeof body?.pinned === 'boolean' ? { pinned: body.pinned } : {}) }
  if (!Object.keys(flags).length) throw ApiError.badRequest('favorite or pinned is required')
  await setFileFlags(c.env.DB, ids, flags)
  return c.json({ ok: true, updated: ids.length })
})

imgbedManageRoutes.get('/manage/stats', async (c) => {
  await requireImgbedActor(c, 'manage')
  const url = new URL(c.req.url)
  return c.json(await getStats(c.env.DB, {
    timezoneOffset: Number(url.searchParams.get('timezoneOffset') ?? 0),
    startDate: url.searchParams.get('trendStartDate') ?? undefined,
    endDate: url.searchParams.get('trendEndDate') ?? undefined,
    maxPoints: Number(url.searchParams.get('trendMaxPoints') ?? 90),
    seriesLimit: Number(url.searchParams.get('trendSeriesLimit') ?? 8),
  }))
})

imgbedManageRoutes.get('/manage/quota', async (c) => {
  await requireImgbedActor(c, 'manage')
  const channels = await listResolvedChannels(c.env, c.env.DB, true)
  const usage = await getChannelUsage(c.env.DB)
  return c.json({ channels, usage })
})

imgbedManageRoutes.get('/manage/files/links', async (c) => {
  const actor = await requireImgbedActor(c, 'list')
  const id = new URL(c.req.url).searchParams.get('id') ?? ''
  const file = await getFile(c.env.DB, id)
  if (!file) throw ApiError.notFound('File not found')
  if (!actorCanManage(actor)) return c.json({ links: [{ kind: 'originUrl', value: `/imgbed/file/${file.id}` }] })
  const channels = await listResolvedChannels(c.env, c.env.DB, true)
  const channel = channels.find((item) => item.type === file.source && item.name === file.channelName)
  const base = String(channel?.config.publicUrl ?? channel?.config.cdnDomain ?? '').replace(/\/+$/, '')
  const links = linkContentsFor(file.channel).map((kind) => {
    if (kind === 'tgId') return { kind, value: file.objectKey }
    if (kind === 's3Location') return { kind, value: file.objectKey }
    if (kind === 's3CdnFileUrl') return { kind, value: base ? `${base}/${file.objectKey}` : '' }
    if (kind === 'webdavPublicUrl') return { kind, value: base ? `${base}/${file.objectKey}` : '' }
    return { kind, value: `/imgbed/file/${file.id}` }
  }).filter((item) => item.value)
  return c.json({ links })
})

imgbedManageRoutes.get('/manage/files', async (c) => {
  const actor = await requireImgbedActor(c, 'list')
  const id = new URL(c.req.url).searchParams.get('id') ?? ''
  const file = await getFile(c.env.DB, id)
  if (!file) throw ApiError.notFound('File not found')
  return c.json(redactImgbedFile(file, actorCanManage(actor)))
})

imgbedManageRoutes.patch('/manage/files', async (c) => {
  const actor = await requireImgbedActor(c, 'delete')
  const body = await c.req.json().catch(() => null) as { id?: string; fileName?: string; fileType?: string } | null
  if (!body?.id) throw ApiError.badRequest('id is required')
  const file = await getFile(c.env.DB, body.id)
  if (!file) throw ApiError.notFound('File not found')
  const fileName = typeof body.fileName === 'string' ? sanitizeFileName(body.fileName) : undefined
  const fileType = typeof body.fileType === 'string' && body.fileType.length <= 255 ? body.fileType : undefined
  await c.env.DB.prepare(
    `UPDATE imgbed_files SET
       file_name = COALESCE(?2, file_name),
       file_type = COALESCE(?3, file_type),
       updated_at = ?4
     WHERE id = ?1`,
  ).bind(body.id, fileName ?? null, fileType ?? null, Date.now()).run()
  const updated = await getFile(c.env.DB, body.id)
  return c.json(updated ? redactImgbedFile(updated, actorCanManage(actor)) : null)
})

imgbedManageRoutes.post('/manage/files/access', async (c) => {
  await requireImgbedActor(c, 'delete')
  const body = await c.req.json().catch(() => null) as { ids?: string[]; listType?: string; label?: string } | null
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string').slice(0, 1000) : []
  if (!ids.length) throw ApiError.badRequest('ids are required')
  const listType = ['None', 'White', 'Block'].includes(body?.listType ?? '') ? body!.listType! : undefined
  const label = ['None', 'everyone', 'teen', 'adult'].includes(body?.label ?? '') ? body!.label! : undefined
  const results: { id: string; ok: boolean }[] = []
  for (const id of ids) {
    const result = await c.env.DB.prepare(
      `UPDATE imgbed_files SET
         list_type = COALESCE(?2, list_type), label = COALESCE(?3, label), updated_at = ?4
       WHERE id = ?1`,
    ).bind(id, listType ?? null, label ?? null, Date.now()).run()
    results.push({ id, ok: (result.meta.changes ?? 0) > 0 })
  }
  return c.json({ results }, results.every((result) => result.ok) ? 200 : 207)
})

imgbedManageRoutes.post('/manage/files/rename', async (c) => {
  await requireImgbedActor(c, 'delete')
  const body = await c.req.json().catch(() => null) as { id?: string; newId?: string } | null
  if (!body?.id || !body.newId) throw ApiError.badRequest('id and newId are required')
  const file = await getFile(c.env.DB, body.id)
  if (!file) throw ApiError.notFound('File not found')
  const newId = sanitizeFolderPath(body.newId)
  if (!newId || newId.startsWith('/')) throw ApiError.badRequest('newId is invalid')
  if (newId !== body.id && await fileExists(c.env.DB, newId)) throw ApiError.conflict('The target file already exists')
  const channels = await listResolvedChannels(c.env, c.env.DB, true)
  const channel = channels.find((item) => item.type === file.source && item.name === file.channelName)
  if (!channel) throw ApiError.badRequest('The file channel is not configured')
  const move = await moveWholeFile(c.env, channel, file, newId, file.fileType)
  await renameFileRow(c.env.DB, file.id, newId, move.objectKey)
  return c.json(await getFile(c.env.DB, newId))
})

imgbedManageRoutes.post('/manage/files/move', async (c) => {
  await requireImgbedActor(c, 'delete')
  const body = await c.req.json().catch(() => null) as { ids?: string[]; dist?: string; folder?: string } | null
  const dist = sanitizeFolderPath(body?.dist ?? '')
  const ids = Array.isArray(body?.ids) ? body.ids : body?.folder ? [body.folder] : []
  if (!ids.length) throw ApiError.badRequest('ids are required')
  const processed: unknown[] = []
  const failed: unknown[] = []
  for (const id of ids.slice(0, 50)) {
    const file = await getFile(c.env.DB, id)
    if (!file) { failed.push({ id, error: 'not_found' }); continue }
    const newId = dist ? `${dist}/${file.id.split('/').pop()}` : file.id.split('/').pop()!
    try {
      const channels = await listResolvedChannels(c.env, c.env.DB, true)
      const channel = channels.find((item) => item.type === file.source && item.name === file.channelName)
        ?? channels.find((item) => item.type === file.source)
      if (!channel) throw new Error('channel_not_configured')
      const move = await moveWholeFile(c.env, channel, file, newId, file.fileType)
      await renameFileRow(c.env.DB, id, newId, move.objectKey)
      processed.push({ id, newId })
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : 'move_failed' })
    }
  }
  return c.json({ processed, failed })
})

imgbedManageRoutes.delete('/manage/files', async (c) => {
  await requireImgbedActor(c, 'delete')
  const url = new URL(c.req.url)
  const id = url.searchParams.get('id') ?? ''
  if (!id) throw ApiError.badRequest('id is required')
  const files = url.searchParams.get('folder') === 'true'
    ? (await listFiles(c.env.DB, { dir: id, count: -1, recursive: true })).files
    : await getFile(c.env.DB, id).then((file) => file ? [file] : [])
  if (!files.length) throw ApiError.notFound('File not found')
  const channels = await listResolvedChannels(c.env, c.env.DB, true)
  const failed: unknown[] = []
  let deleted = 0
  for (const file of files) {
    const channel = channels.find((item) => item.type === file.source && item.name === file.channelName)
    try {
      if (channel) await deleteWholeFile(c.env, channel, file)
      await deleteFileRow(c.env.DB, file.id)
      deleted++
    } catch (error) {
      failed.push({ id: file.id, error: error instanceof Error ? error.message : 'delete_failed' })
    }
  }
  return c.json({ deleted, failed: failed.length, errors: failed }, failed.length ? 207 : 200)
})

imgbedManageRoutes.post('/manage/files/copy-links', async (c) => {
  await requireImgbedActor(c, 'list')
  const body = await c.req.json().catch(() => null) as { ids?: string[]; format?: string } | null
  const format = (IMGBED_LINK_FORMATS as readonly string[]).includes(body?.format ?? '') ? body!.format as ImgbedLinkFormat : 'originUrl'
  const page = await getSettingsGroup(c.env.DB, 'page')
  const base = page.urlPrefix || `${new URL(c.req.url).origin}/imgbed/file`
  const ids = Array.isArray(body?.ids) ? body.ids : []
  const links: string[] = []
  for (const id of ids) {
    const file = await getFile(c.env.DB, id)
    if (file) links.push(linkFor(file, format, base))
  }
  return c.json({ links: links.join('\n'), count: links.length })
})

imgbedManageRoutes.get('/directory-tree', async (c) => {
  await requireImgbedActor(c, 'list')
  return c.json({ tree: directoryTree(await allDirectories(c.env.DB)) })
})

imgbedManageRoutes.get('/manage/tags', async (c) => {
  await requireImgbedActor(c, 'list')
  const id = new URL(c.req.url).searchParams.get('id') ?? ''
  return c.json({ fileId: id, tags: await getFileTags(c.env.DB, id) })
})

async function applyTags(c: { env: AppBindings['Bindings']; req: { json: () => Promise<unknown> } }, actionOverride?: 'set' | 'add' | 'remove') {
  const body = await c.req.json().catch(() => null) as { id?: string; ids?: string[]; tags?: string[]; action?: string } | null
  const action = actionOverride ?? (['set', 'add', 'remove'].includes(body?.action ?? '') ? body!.action as 'set' | 'add' | 'remove' : 'add')
  const tags = normalizeTags(Array.isArray(body?.tags) ? body!.tags : [])
  const ids = Array.isArray(body?.ids) ? body!.ids : body?.id ? [body.id] : []
  if (!ids.length) throw ApiError.badRequest('id is required')
  const results: { id: string; tags: string[]; ok: boolean }[] = []
  for (const id of ids.slice(0, 1000)) {
    const file = await getFile(c.env.DB, id)
    if (!file) { results.push({ id, tags: [], ok: false }); continue }
    if (action === 'set') await replaceFileTags(c.env.DB, id, tags)
    else if (action === 'add') await addFileTags(c.env.DB, id, tags)
    else await removeFileTags(c.env.DB, id, tags)
    results.push({ id, tags: await getFileTags(c.env.DB, id), ok: true })
  }
  return results
}

imgbedManageRoutes.post('/manage/tags', async (c) => {
  await requireImgbedActor(c, 'delete')
  const results = await applyTags(c)
  return c.json({ results }, results.every((result) => result.ok) ? 200 : 207)
})

imgbedManageRoutes.post('/manage/tags/batch', async (c) => {
  await requireImgbedActor(c, 'delete')
  const results = await applyTags(c)
  return c.json({ results }, results.every((result) => result.ok) ? 200 : 207)
})

imgbedManageRoutes.get('/manage/tags/autocomplete', async (c) => {
  await requireImgbedActor(c, 'list')
  const url = new URL(c.req.url)
  const prefix = (url.searchParams.get('prefix') ?? '').toLowerCase()
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 20)))
  return c.json({ tags: await autocompleteTags(c.env.DB, prefix, limit) })
})

imgbedManageRoutes.post('/manage/tags/apply', async (c) => {
  await requireImgbedActor(c, 'delete')
  const body = await c.req.json().catch(() => null) as { items?: { fileId: string; tags: string[]; sourceIdentity?: string }[] } | null
  const items = Array.isArray(body?.items) ? body!.items.slice(0, 50) : []
  if (!items.length) throw ApiError.badRequest('items are required')
  const results: unknown[] = []
  for (const item of items) {
    const file = await getFile(c.env.DB, item.fileId)
    if (!file) { results.push({ fileId: item.fileId, saved: false, error: 'not_found' }); continue }
    if (item.sourceIdentity && await fileIdentity(file) !== item.sourceIdentity) {
      results.push({ fileId: item.fileId, saved: false, error: 'file_changed' })
      continue
    }
    const tags = normalizeTags(item.tags ?? [])
    await addFileTags(c.env.DB, item.fileId, tags)
    results.push({ fileId: item.fileId, saved: true, tags: await getFileTags(c.env.DB, item.fileId), changed: tags.length > 0 })
  }
  return c.json({ results }, results.every((result) => (result as { saved: boolean }).saved) ? 200 : 207)
})

imgbedManageRoutes.get('/manage/backup', async (c) => {
  await requireImgbedActor(c, 'manage')
  const files = (await listFiles(c.env.DB, { count: -1, recursive: true })).files
  const settings = {
    page: await getSettingsGroup(c.env.DB, 'page'),
    upload: await getSettingsGroup(c.env.DB, 'upload'),
    security: await getSettingsGroup(c.env.DB, 'security'),
    others: await getSettingsGroup(c.env.DB, 'others'),
    ai: await getSettingsGroup(c.env.DB, 'ai'),
  }
  const security = settings.security
  security.moderate.moderateContentApiKey = ''
  const others = settings.others
  others.webDAV.passwordHash = ''
  const payload = { format: 'inkstone-imgbed-backup', version: 1, timestamp: Date.now(), files: files.map(fileForBackup), settings: { ...settings, security, others } }
  return new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="imgbed-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      'Cache-Control': 'no-store',
    },
  })
})

imgbedManageRoutes.post('/manage/restore', async (c) => {
  await requireImgbedActor(c, 'manage')
  const body = await c.req.json().catch(() => null) as {
    format?: string; version?: number; files?: Record<string, unknown>[]; settings?: Record<string, unknown>
  } | null
  if (body?.format !== 'inkstone-imgbed-backup' || body.version !== 1) throw ApiError.badRequest('Unsupported backup format')
  let restoredFiles = 0
  let failedFiles = 0
  for (const raw of (body.files ?? []).slice(0, 50)) {
    try {
      const id = sanitizeFolderPath(String(raw.id ?? ''))
      if (!id) throw new Error('invalid id')
      await insertFile(c.env.DB, {
        id,
        objectKey: String(raw.objectKey ?? ''),
        fileName: String(raw.fileName ?? id.split('/').pop() ?? id),
        fileType: String(raw.fileType ?? 'application/octet-stream'),
        sizeBytes: Number(raw.sizeBytes ?? 0),
        width: raw.width === null || raw.width === undefined ? null : Number(raw.width),
        height: raw.height === null || raw.height === undefined ? null : Number(raw.height),
        uploadIp: typeof raw.uploadIp === 'string' ? raw.uploadIp : null,
        uploadAddress: typeof raw.uploadAddress === 'string' ? raw.uploadAddress : null,
        listType: String(raw.listType ?? 'None'),
        label: String(raw.label ?? 'None'),
        source: String(raw.source ?? 'upload'),
        externalLink: typeof raw.externalLink === 'string' ? raw.externalLink : null,
        channel: String(raw.channel ?? 'CloudflareR2'),
        channelName: String(raw.channelName ?? 'R2'),
        isChunked: raw.isChunked === true || raw.isChunked === 1,
        parts: Array.isArray(raw.parts) ? raw.parts as never : null,
        uploaderId: typeof raw.uploaderId === 'string' ? raw.uploaderId : null,
        createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
      })
      if (Array.isArray(raw.tags)) await replaceFileTags(c.env.DB, id, normalizeTags(raw.tags.map(String)))
      if (raw.favorite === true || raw.favorite === 1 || raw.pinned === true || raw.pinned === 1) {
        await setFileFlags(c.env.DB, [id], {
          ...(raw.favorite === true || raw.favorite === 1 ? { favorite: true } : {}),
          ...(raw.pinned === true || raw.pinned === 1 ? { pinned: true } : {}),
        })
      }
      restoredFiles++
    } catch {
      failedFiles++
    }
  }
  let restoredSettings = 0
  if (body.settings) {
    for (const group of ['page', 'upload', 'security', 'others', 'ai'] as const) {
      const value = body.settings[group]
      if (value === undefined) continue
      try {
        const previous = await getSettingsGroup(c.env.DB, group)
        const parsed = parseSettingsGroup(group, value, previous)
        if (group === 'security') {
          const next = parsed as ImgbedSecuritySettings
          next.moderate.moderateContentApiKey = (previous as ImgbedSecuritySettings).moderate.moderateContentApiKey
        }
        if (group === 'others') {
          const next = parsed as ImgbedOthersSettings
          next.webDAV.passwordHash = (previous as ImgbedOthersSettings).webDAV.passwordHash
        }
        await saveSettingsGroup(c.env.DB, group, parsed)
        restoredSettings++
      } catch {
      }
    }
  }
  return c.json({ restoredFiles, failedFiles, restoredSettings }, failedFiles ? 207 : 200)
})

imgbedManageRoutes.get('/manage/customers', async (c) => {
  await requireImgbedActor(c, 'manage')
  const url = new URL(c.req.url)
  const start = Math.max(0, Number(url.searchParams.get('start') ?? 0))
  const count = Math.max(1, Math.min(200, Number(url.searchParams.get('count') ?? 20)))
  const rows = await customerRows(c.env.DB, start, count)
  const blocked = new Set(await blockedIps(c.env.DB))
  return c.json({ customers: rows.map((row) => ({ ...row, blocked: blocked.has(row.ip) })), blocked: [...blocked] })
})

imgbedManageRoutes.get('/manage/customers/files', async (c) => {
  await requireImgbedActor(c, 'manage')
  const url = new URL(c.req.url)
  const ip = url.searchParams.get('ip') ?? ''
  if (!ip) throw ApiError.badRequest('ip is required')
  const start = Math.max(0, Number(url.searchParams.get('start') ?? 0))
  const count = Math.max(1, Math.min(200, Number(url.searchParams.get('count') ?? 20)))
  return c.json(await filesByIp(c.env.DB, ip, start, count))
})

imgbedManageRoutes.post('/manage/customers/blocked-ips', async (c) => {
  await requireImgbedActor(c, 'manage')
  const body = await c.req.json().catch(() => null) as { ip?: string } | null
  if (!body?.ip || body.ip.length > 64) throw ApiError.badRequest('ip is required')
  await blockIp(c.env.DB, body.ip)
  return c.json({ ok: true })
})

imgbedManageRoutes.delete('/manage/customers/blocked-ips', async (c) => {
  await requireImgbedActor(c, 'manage')
  const ip = new URL(c.req.url).searchParams.get('ip') ?? ''
  if (!ip) throw ApiError.badRequest('ip is required')
  await unblockIp(c.env.DB, ip)
  return c.json({ ok: true })
})
