import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { requireMemoUser } from '../../memos/auth'
import { buildMemoExport } from '../../memos/export'

const EXPORT_CONTENT_TYPE = 'application/zip'

export const memoTransferRoutes = new Hono<AppBindings>()

memoTransferRoutes.use('*', requireMemoUser)

memoTransferRoutes.get('/export', async (c) => {
  const archive = await buildMemoExport(c.env, c.get('userId'))
  return new Response(archive.stream, {
    headers: {
      'content-type': EXPORT_CONTENT_TYPE,
      'content-disposition': contentDisposition(archive.filename),
      'cache-control': 'private, no-store',
    },
  })
})

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(filename)}`
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}
