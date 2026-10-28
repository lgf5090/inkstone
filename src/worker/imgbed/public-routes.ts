import { Hono } from 'hono'
import type { AppBindings } from '../env'
import type { ImgbedFile } from '@shared/imgbed/model'
import { parseSecuritySettings } from '@shared/imgbed/settings'
import { getSettingsGroup, listFiles } from './store'
import { publicDirectoryAllowed } from './access'

export const imgbedPublicRoutes = new Hono<AppBindings>()
export const imgbedRandomRoutes = new Hono<AppBindings>()

function allowedDirectories(value: string): string[] {
  return String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
}

imgbedPublicRoutes.get('/public/config', async (c) => {
  const others = await getSettingsGroup(c.env.DB, 'others')
  return c.json({
    enabled: others.publicBrowse.enabled,
    allowedDirs: allowedDirectories(others.publicBrowse.allowedDir),
  })
})

imgbedPublicRoutes.get('/public/list', async (c) => {
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
  if (!publicDirectoryAllowed(dir.replace(/\/$/, ''), others.publicBrowse.allowedDir)) {
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
  const directories = result.directories.filter((entry) => publicDirectoryAllowed(entry.replace(/\/$/, ''), others.publicBrowse.allowedDir))
  return c.json({
    files: result.files.map(publicFile),
    directories,
    totalCount: result.totalCount,
    returnedCount: result.returnedCount,
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
  const others = await getSettingsGroup(c.env.DB, 'others')
  if (!others.randomImageAPI.enabled) return c.json({ error: 'Random is disabled' }, 403, { 'Access-Control-Allow-Origin': '*' })
  const security = parseSecuritySettings(await getSettingsGroup(c.env.DB, 'security'))
  const url = new URL(c.req.url)
  let dir = (url.searchParams.get('dir') ?? '').replace(/\.\./g, '_').replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (dir.startsWith('/')) dir = dir.slice(1)
  dir = dir.replace(/\/$/, '')
  if (!publicDirectoryAllowed(dir, others.randomImageAPI.allowedDir)) {
    return c.json({ error: 'Directory not allowed' }, 403, { 'Access-Control-Allow-Origin': '*' })
  }
  const content = (url.searchParams.get('content') ?? 'image').split(',').map((item) => item.trim()).filter(Boolean)
  const orientationParam = url.searchParams.get('orientation') ?? ''
  const device = detectDevice(c)
  const orientation = ['landscape', 'portrait', 'square'].includes(orientationParam)
    ? orientationParam
    : orientationParam === 'auto' ? resolveOrientation(device) : ''
  const result = await listFiles(c.env.DB, {
    dir, count: -1, recursive: true,
    fileType: content,
    accessStatus: ['normal'],
    ...(security.access.whiteListMode ? { listType: ['White'] } : {}),
  })
  let files = result.files
  const beforeOrientation = files
  if (orientation) {
    files = files.filter((file) => {
      if (!file.width || !file.height) return false
      const ratio = file.width / file.height
      if (orientation === 'landscape') return ratio > 1.1
      if (orientation === 'portrait') return ratio < 0.9
      return ratio >= 0.9 && ratio <= 1.1
    })
    if (!files.length && orientationParam === 'auto') files = beforeOrientation
  }
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
  if (orientationParam === 'auto') {
    headers['Accept-CH'] = 'Sec-CH-Viewport-Width, Sec-CH-Viewport-Height'
    headers.Vary = 'Sec-CH-Viewport-Width, Sec-CH-Viewport-Height, User-Agent'
  }
  if (!files.length) return c.json({}, 200, headers)
  const file = files[Math.floor(Math.random() * files.length)]!
  const path = `${url.origin}/imgbed/file/${file.id}`
  if (url.searchParams.get('type') === 'img') return Response.redirect(path, 302)
  if (url.searchParams.get('type') === 'url') {
    return url.searchParams.get('form') === 'text' ? c.text(path, 200, headers) : c.json({ url: path }, 200, headers)
  }
  return url.searchParams.get('form') === 'text' ? c.text(path, 200, headers) : c.json({ url: path }, 200, headers)
})
