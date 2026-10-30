import { Hono } from 'hono'
import type { AppBindings } from '../env'
import type { ImgbedFile } from '@shared/imgbed/model'
import { parseSecuritySettings } from '@shared/imgbed/settings'
import { getSettingsGroup, listFiles, randomFile } from './store'
import { requestClientIp } from '../lib/request'
import { checkRateLimit } from './rate-limit'
import { publicDirectoryAllowed } from './access'

export const imgbedPublicRoutes = new Hono<AppBindings>()
export const imgbedRandomRoutes = new Hono<AppBindings>()

function allowedDirectories(value: string): string[] {
  return String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
}

imgbedPublicRoutes.get('/public/config', async (c) => {
  const others = await getSettingsGroup(c.env.DB, 'others')
  if (!others.publicBrowse.enabled) return c.json({ enabled: false, allowedDirs: [] })
  return c.json({
    enabled: true,
    allowedDirs: allowedDirectories(others.publicBrowse.allowedDir),
  })
})

imgbedPublicRoutes.get('/public/list', async (c) => {
  const limit = checkRateLimit(`imgbed-public-list:${requestClientIp(c.req.raw)}`, 240, 60_000)
  if (!limit.ok) return c.json({ error: 'Too many requests' }, 429, { 'Retry-After': String(limit.retryAfterSec), 'Access-Control-Allow-Origin': '*' })
  const others = await getSettingsGroup(c.env.DB, 'others')
  if (!others.publicBrowse.enabled) {
    return c.json({ error: 'Public browse is disabled' }, 403)
  }
  const security = parseSecuritySettings(await getSettingsGroup(c.env.DB, 'security'))
  const url = new URL(c.req.url)
  let dir = (url.searchParams.get('dir') ?? '').replace(/\.\./g, '_').replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (dir.startsWith('/')) dir = dir.slice(1)
  if (dir && !dir.endsWith('/')) dir += '/'
  const allowed = allowedDirectories(others.publicBrowse.allowedDir)
  const root = dir === ''
  const rootEntryAllowed = allowed.some((entry) => {
    const normalized = entry.replace(/^\/+|\/+$/g, '')
    return normalized === '*' || normalized === ''
  })
  if (!(root && allowed.length > 0) && !publicDirectoryAllowed(dir.replace(/\/$/, ''), others.publicBrowse.allowedDir)) {
    return c.json({ error: 'Directory not allowed' }, 403)
  }
  const search = (url.searchParams.get('search') ?? '').trim().toLowerCase()
  const type = url.searchParams.get('type') ?? ''
  const recursive = url.searchParams.get('recursive') === 'true'
  const start = Math.max(0, Number(url.searchParams.get('start') ?? 0))
  const count = Math.max(1, Math.min(200, Number(url.searchParams.get('count') ?? 50)))
  const result = await listFiles(c.env.DB, {
    dir, start, count, search, recursive,
    fileType: type ? [type] : undefined,
    accessStatus: ['normal'],
    ...(security.access.whiteListMode ? { listType: ['White'] } : {}),
  })
  const hideRootFiles = root && allowed.length > 0 && !rootEntryAllowed
  const directories = result.directories.filter((entry) => publicDirectoryAllowed(entry.replace(/\/$/, ''), others.publicBrowse.allowedDir))
  return c.json({
    files: hideRootFiles ? [] : result.files.map(publicFile),
    directories,
    totalCount: hideRootFiles ? 0 : result.totalCount,
    returnedCount: hideRootFiles ? 0 : result.returnedCount,
    allowedDirs: allowed,
    fromCache: false,
  }, 200, { 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' })
})

function publicFile(file: ImgbedFile) {
  return {
    name: file.id,
    metadata: {
      FileType: file.fileType,
      TimeStamp: file.createdAt,
      UpdatedAt: file.updatedAt,
      FileSize: (file.sizeBytes / 1024 / 1024).toFixed(2),
      Width: file.width,
      Height: file.height,
    },
  }
}

interface DeviceInfo { mode: 'client-hints' | 'user-agent' | null; ratio?: number; mobile?: boolean }

function detectDevice(c: { req: { header: (name: string) => string | undefined } }): DeviceInfo {
  const width = Number(c.req.header('sec-ch-viewport-width') ?? 0)
  const height = Number(c.req.header('sec-ch-viewport-height') ?? 0)
  if (width > 0 && height > 0) return { mode: 'client-hints', ratio: width / height }
  const ua = c.req.header('user-agent') ?? ''
  if (ua) return { mode: 'user-agent', mobile: /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|Opera Mini|IEMobile/i.test(ua) }
  return { mode: null }
}

function resolveOrientation(device: DeviceInfo): string {
  if (device.mode === 'client-hints' && device.ratio !== undefined) {
    if (device.ratio > 1.1) return 'landscape'
    if (device.ratio < 0.9) return 'portrait'
    return 'square'
  }
  if (device.mode === 'user-agent') return device.mobile ? 'portrait' : 'landscape'
  return ''
}

imgbedRandomRoutes.get('/random', async (c) => {
  const limit = checkRateLimit(`imgbed-random:${requestClientIp(c.req.raw)}`, 120, 60_000)
  if (!limit.ok) return c.json({ error: 'Too many requests' }, 429, { 'Retry-After': String(limit.retryAfterSec), 'Access-Control-Allow-Origin': '*' })
  const others = await getSettingsGroup(c.env.DB, 'others')
  if (!others.randomImageAPI.enabled) return c.json({ error: 'Random is disabled' }, 403, { 'Access-Control-Allow-Origin': '*' })
  const security = parseSecuritySettings(await getSettingsGroup(c.env.DB, 'security'))
  const url = new URL(c.req.url)
  let dir = (url.searchParams.get('dir') ?? '').replace(/\.\./g, '_').replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (dir.startsWith('/')) dir = dir.slice(1)
  dir = dir.replace(/\/$/, '')
  if (dir && !publicDirectoryAllowed(dir, others.randomImageAPI.allowedDir)) {
    return c.json({ error: 'Directory not allowed' }, 403, { 'Access-Control-Allow-Origin': '*' })
  }
  const content = (url.searchParams.get('content') ?? 'image').split(',').map((item) => item.trim()).filter(Boolean)
  const orientationParam = url.searchParams.get('orientation') ?? ''
  const device = detectDevice(c)
  const orientation = ['landscape', 'portrait', 'square'].includes(orientationParam)
    ? orientationParam as 'landscape' | 'portrait' | 'square'
    : orientationParam === 'auto' ? resolveOrientation(device) as 'landscape' | 'portrait' | 'square' | '' : ''
  const allowed = allowedDirectories(others.randomImageAPI.allowedDir)
  const allAllowed = allowed.some((entry) => entry.replace(/^\/+|\/+$/g, '') === '*')
  const allowedDirs = allowed.map((entry) => entry.replace(/^\/+|\/+$/g, '')).filter((entry) => entry && entry !== '*')
  const whiteList = security.access.whiteListMode ? { listType: ['White'] } : {}
  const query = (targetDir: string, targetOrientation: string | undefined) => ({
    dir: targetDir,
    fileType: content,
    accessStatus: ['normal'],
    ...whiteList,
    ...(targetOrientation ? { orientation: targetOrientation as 'landscape' | 'portrait' | 'square' } : {}),
  })
  const pick = async (targetOrientation: string | undefined): Promise<ImgbedFile | null> => {
    if (dir) return randomFile(c.env.DB, query(dir, targetOrientation))
    if (!allowed.length || allAllowed) return randomFile(c.env.DB, query('', targetOrientation))
    const candidates = [...allowedDirs].sort(() => Math.random() - 0.5)
    for (const candidate of candidates) {
      const file = await randomFile(c.env.DB, query(candidate, targetOrientation))
      if (file) return file
    }
    return null
  }
  let file = await pick(orientation || undefined)
  if (!file && orientationParam === 'auto') file = await pick(undefined)
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
  if (orientationParam === 'auto') {
    headers['Accept-CH'] = 'Sec-CH-Viewport-Width, Sec-CH-Viewport-Height'
    headers.Vary = 'Sec-CH-Viewport-Width, Sec-CH-Viewport-Height, User-Agent'
  }
  if (!file) return c.json({}, 200, headers)
  const path = `${url.origin}/imgbed/file/${file.id.split('/').map(encodeURIComponent).join('/')}`
  if (url.searchParams.get('type') === 'img') return Response.redirect(path, 302)
  return url.searchParams.get('form') === 'text' ? c.text(path, 200, headers) : c.json({ url: path }, 200, headers)
})
