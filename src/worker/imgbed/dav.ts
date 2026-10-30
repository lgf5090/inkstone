import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { verifyPassword } from '../lib/password'
import { parseOthersSettings } from '@shared/imgbed/settings'
import { baseNameOf } from '@shared/imgbed/model'
import { getSettingsGroup, getFile, listFiles } from './store'
import { listResolvedChannels } from './channels'
import { getWholeFile, deleteWholeFile, moveWholeFile } from './storage'
import { deleteFileRow, renameFileRow } from './store'
import type { ImgbedFile } from '@shared/imgbed/model'
import type { ImgbedActor } from './auth'
import { imgbedResponseHeaders } from './file-headers'
import { requestClientIp } from '../lib/request'
import { ThrottleError, assertNotLocked, clearLoginFailures, recordLoginFailure } from '../lib/throttle'

export const imgbedDavRoutes = new Hono<AppBindings>()

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function escapeHtml(value: string): string {
  return escapeXml(value)
}

function multiStatus(items: { href: string; status: number; message?: string }[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${items.map((item) => `<D:response><D:href>${escapeXml(item.href)}</D:href><D:status>HTTP/1.1 ${item.status}${item.message ? ` ${escapeXml(item.message)}` : ''}</D:status></D:response>`).join('')}</D:multistatus>`
}

async function davSettings(c: { env: AppBindings['Bindings']; req: { header: (name: string) => string | undefined; raw: Request } }) {
  const others = parseOthersSettings(await getSettingsGroup(c.env.DB, 'others'))
  if (!others.webDAV.enabled) throw new ApiError(503, 'internal', 'WebDAV is disabled')
  if (!others.webDAV.username || !others.webDAV.passwordHash) throw new ApiError(503, 'internal', 'WebDAV credentials are not configured')
  const key = `imgbed-dav:${requestClientIp(c.req.raw)}`
  try { await assertNotLocked(c.env.DB, [{ key, freeFails: 5 }]) }
  catch (error) {
    if (error instanceof ThrottleError) return { settings: others, response: new Response('Too many attempts', { status: 429, headers: { 'Retry-After': String(error.retryAfterSec) } }) }
    throw error
  }
  const authorization = c.req.header('authorization') ?? ''
  const match = /^Basic\s+(.+)$/i.exec(authorization)
  if (!match) {
    return { settings: others, response: new Response('Authorization required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Image bed"' } }) }
  }
  let decoded = ''
  try { decoded = atob(match[1]!) } catch { return { settings: others, response: new Response('Malformed authorization', { status: 400 }) } }
  const separator = decoded.indexOf(':')
  const username = separator < 0 ? decoded : decoded.slice(0, separator)
  const password = separator < 0 ? '' : decoded.slice(separator + 1)
  if (username !== others.webDAV.username || !(await verifyPassword(password, others.webDAV.passwordHash))) {
    await recordLoginFailure(c.env.DB, [{ key, freeFails: 5 }]).catch((error) => console.warn('[inkstone] image-bed WebDAV throttle write failed:', (error as Error).message))
    return { settings: others, response: new Response('Invalid credentials', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Image bed"' } }) }
  }
  await clearLoginFailures(c.env.DB, [{ key }]).catch((error) => console.warn('[inkstone] image-bed WebDAV throttle clear failed:', (error as Error).message))
  return { settings: others, response: null }
}

function davPath(c: { req: { path: string } }): string {
  const raw = c.req.path.replace(/^\/imgbed\/dav\/?/, '')
  let path: string
  try { path = decodeURIComponent(raw) } catch { throw new ApiError(400, 'bad_request', 'Invalid WebDAV path') }
  if (path.includes('..') || path.includes('\\') || /[\u0000-\u001f]/.test(path)) throw new ApiError(400, 'bad_request', 'Invalid WebDAV path')
  return path
}

async function ownerId(c: { env: AppBindings['Bindings'] }): Promise<string> {
  const row = await c.env.DB.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").first<{ id: string }>()
  if (!row?.id) throw new ApiError(503, 'internal', 'No account can own WebDAV uploads')
  return row.id
}

async function channelFor(env: AppBindings['Bindings'], db: D1Database, file: ImgbedFile) {
  const channels = await listResolvedChannels(env, db, true)
  return channels.find((channel) => channel.type === file.source && channel.name === file.channelName)
    ?? null
}

imgbedDavRoutes.on(['OPTIONS'], '*', () => new Response(null, {
  status: 200,
  headers: { Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MOVE, MKCOL', DAV: '1', 'MS-Author-Via': 'DAV' },
}))

imgbedDavRoutes.on(['GET', 'HEAD'], '*', async (c) => {
  const auth = await davSettings(c)
  if (auth.response) return auth.response
  const path = davPath(c)
  if (!path || path.endsWith('/')) {
    const dir = path.replace(/\/+$/, '')
    const result = await listFiles(c.env.DB, { dir, count: -1, recursive: false })
    const rows = [
      `<li><strong>${dir ? '<a href="../">../</a>' : ''}</strong></li>`,
      ...result.directories.map((entry) => `<li><a href="${escapeHtml(entry.slice(dir ? dir.length + 1 : 0))}/">${escapeHtml(entry.split('/').filter(Boolean).pop() ?? entry)}/</a></li>`),
      ...result.files.map((file) => `<li><a href="${escapeHtml(file.id.slice(dir ? dir.length + 1 : 0))}">${escapeHtml(baseNameOf(file.id))}</a> - ${file.sizeBytes} B</li>`),
    ]
    return new Response(`<!doctype html><html><body><h1>${escapeHtml(`/${dir}`)}</h1><ul>${rows.join('')}</ul></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }
  const file = await getFile(c.env.DB, path)
  if (!file) return new Response('Not Found', { status: 404 })
  const channel = await channelFor(c.env, c.env.DB, file)
  if (!channel) return new Response('Channel is not configured', { status: 503 })
  const response = await getWholeFile(c.env, channel, file, c.req.header('range') ?? null)
  if (!response) return new Response('Not Found', { status: 404 })
  const headers = imgbedResponseHeaders(file, { admin: true, download: false, cacheControl: 'private, no-store' })
  const contentType = response.headers.get('content-type')
  const contentLength = response.headers.get('content-length')
  if (contentType) headers.set('Content-Type', contentType)
  if (contentLength) headers.set('Content-Length', contentLength)
  return new Response(c.req.method === 'HEAD' ? null : response.body, { status: response.status, headers })
})

imgbedDavRoutes.put('*', async (c) => {
  const auth = await davSettings(c)
  if (auth.response) return auth.response
  const path = davPath(c)
  if (!path || path.endsWith('/')) return new Response('Invalid file name', { status: 400 })
  const bytes = new Uint8Array(await c.req.raw.arrayBuffer())
  if (bytes.byteLength > 100 * 1024 * 1024) return new Response('File is too large', { status: 413 })
  const existing = await getFile(c.env.DB, path)
  if (existing) {
    const channel = await channelFor(c.env, c.env.DB, existing)
    if (channel) await deleteWholeFile(c.env, channel, existing).catch(() => {})
    await deleteFileRow(c.env.DB, existing.id)
  }
  const fileName = baseNameOf(path)
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1).replace(/\/$/, '') : ''
  const fileType = fileName.includes('.') ? '' : 'application/octet-stream'
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: fileType || 'application/octet-stream' }), fileName)
  const { uploadSingle } = await import('./upload-service')
  const actor: ImgbedActor = {
    kind: 'session', userId: await ownerId(c), role: 'owner',
    scopes: ['list', 'upload', 'delete', 'manage'], actorKey: 'dav',
  }
  await uploadSingle(c.env, c.env.DB, actor, c.req.raw, form, {
    uploadChannel: auth.settings.webDAV.uploadChannel || undefined,
    channelName: auth.settings.webDAV.channelName || undefined,
    uploadFolder: folder,
    uploadNameType: 'origin',
  })
  return new Response(null, { status: 201 })
})

imgbedDavRoutes.delete('*', async (c) => {
  const auth = await davSettings(c)
  if (auth.response) return auth.response
  const path = davPath(c)
  if (!path) return new Response('Invalid path', { status: 400 })
  const exact = await getFile(c.env.DB, path)
  const files = exact
    ? [exact]
    : (await listFiles(c.env.DB, { dir: path.replace(/\/$/, ''), count: -1, recursive: true })).files
  if (!files.length) return new Response('Not Found', { status: 404 })
  const results: { href: string; status: number; message?: string }[] = []
  let deleted = 0
  for (const file of files) {
    const channel = await channelFor(c.env, c.env.DB, file)
    try {
      if (!channel) throw new Error('channel_not_configured')
      await deleteWholeFile(c.env, channel, file)
      await deleteFileRow(c.env.DB, file.id)
      deleted += 1
    } catch (error) {
      results.push({ href: `/imgbed/dav/${file.id}`, status: 500, message: error instanceof Error ? error.message : 'delete_failed' })
    }
  }
  if (!results.length) return new Response(null, { status: 204 })
  return new Response(multiStatus(results), { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
})

imgbedDavRoutes.on(['PROPFIND'], '*', async (c) => {
  const auth = await davSettings(c)
  if (auth.response) return auth.response
  const path = davPath(c)
  const depth = c.req.header('depth') ?? '1'
  if (depth === 'infinity') return new Response('Depth infinity is not supported', { status: 403 })
  const exactFile = await getFile(c.env.DB, path)
  if (exactFile) {
    const href = `/imgbed/dav/${path}`
    const xml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${escapeXml(href)}</D:href><D:propstat><D:prop><D:displayname>${escapeXml(baseNameOf(path))}</D:displayname><D:resourcetype/><D:getcontentlength>${exactFile.sizeBytes}</D:getcontentlength><D:getcontenttype>${escapeXml(exactFile.fileType)}</D:getcontenttype><D:getlastmodified>${new Date(exactFile.updatedAt).toUTCString()}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`
    return new Response(xml, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
  }
  const dir = path.replace(/\/+$/, '')
  const result = await listFiles(c.env.DB, { dir: dir ? `${dir}/` : '', count: -1, recursive: false })
  const responses: string[] = []
  const href = `/imgbed/dav/${dir ? `${dir}/` : ''}`
  responses.push(`<D:response><D:href>${escapeXml(href)}</D:href><D:propstat><D:prop><D:displayname>${escapeXml(dir.split('/').pop() || '/')}</D:displayname><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`)
  if (depth !== '0') {
    for (const entry of result.directories) {
      const name = entry.split('/').filter(Boolean).pop() ?? entry
      responses.push(`<D:response><D:href>${escapeXml(`/imgbed/dav/${entry}`)}</D:href><D:propstat><D:prop><D:displayname>${escapeXml(name)}</D:displayname><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`)
    }
    for (const file of result.files) {
      responses.push(`<D:response><D:href>${escapeXml(`/imgbed/dav/${file.id}`)}</D:href><D:propstat><D:prop><D:displayname>${escapeXml(baseNameOf(file.id))}</D:displayname><D:resourcetype/><D:getcontentlength>${file.sizeBytes}</D:getcontentlength><D:getcontenttype>${escapeXml(file.fileType)}</D:getcontenttype><D:getlastmodified>${new Date(file.updatedAt).toUTCString()}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`)
    }
  }
  return new Response(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
})

imgbedDavRoutes.on(['MOVE'], '*', async (c) => {
  const auth = await davSettings(c)
  if (auth.response) return auth.response
  const source = davPath(c)
  const destination = c.req.header('destination')
  if (!destination) return new Response('Destination is required', { status: 400 })
  const dest = new URL(destination)
  if (dest.host !== new URL(c.req.url).host) return new Response('Cross-host moves are not allowed', { status: 502 })
  const target = decodeURIComponent(dest.pathname.replace(/^\/imgbed\/dav\/?/, '')).replace(/\/+$/, '')
  if (!target || target.includes('..')) return new Response('Invalid destination', { status: 400 })
  const file = await getFile(c.env.DB, source)
  if (file) {
    const channel = await channelFor(c.env, c.env.DB, file)
    if (!channel) return new Response('Channel is not configured', { status: 503 })
    try {
      const move = await moveWholeFile(c.env, channel, file, target, file.fileType)
      await renameFileRow(c.env.DB, source, target, move.objectKey)
      return new Response(null, { status: 201 })
    } catch (error) {
      return new Response(error instanceof Error ? error.message : 'move_failed', { status: 502 })
    }
  }
  const folder = source.replace(/\/$/, '')
  const files = (await listFiles(c.env.DB, { dir: folder, count: -1, recursive: true })).files
  if (!files.length) return new Response('Not Found', { status: 404 })
  const results: { href: string; status: number; message?: string }[] = []
  let moved = 0
  for (const item of files) {
    const channel = await channelFor(c.env, c.env.DB, item)
    const relative = item.id.slice(folder.length + 1)
    const newId = `${target}/${relative}`
    try {
      if (!channel) throw new Error('channel_not_configured')
      const move = await moveWholeFile(c.env, channel, item, newId, item.fileType)
      await renameFileRow(c.env.DB, item.id, newId, move.objectKey)
      moved += 1
    } catch (error) {
      results.push({ href: `/imgbed/dav/${item.id}`, status: 500, message: error instanceof Error ? error.message : 'move_failed' })
    }
  }
  if (!results.length) return new Response(null, { status: 201 })
  return new Response(multiStatus(results), { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
})

imgbedDavRoutes.on(['MKCOL'], '*', async (c) => {
  const auth = await davSettings(c)
  if (auth.response) return auth.response
  const path = davPath(c)
  if (!path) return new Response('Invalid path', { status: 400 })
  const existing = (await listFiles(c.env.DB, { dir: path.replace(/\/$/, ''), count: 1 })).files.length > 0
  return new Response(null, { status: existing ? 405 : 201 })
})
