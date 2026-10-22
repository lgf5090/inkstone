import { Hono } from 'hono'
import { MEMO_IMPORT_CHUNK_BYTES } from '@shared/memos/constants'
import type { AppBindings } from '../../env'
import { ApiError, errorResponse } from '../../lib/errors'
import { JSON_BODY_LIMITS, readBytesWithinLimit, readJson, readOptionalJson } from '../../lib/request'
import { requireMemoUser } from '../../memos/auth'
import { buildMemoExport } from '../../memos/export'
import {
  MemoImportError,
  appendMemoImportChunk,
  buildMemoImportPlan,
  cancelMemoImportSession,
  commitMemoImport,
  createMemoImportSession,
} from '../../memos/import'

const EXPORT_CONTENT_TYPE = 'application/zip'

export const memoTransferRoutes = new Hono<AppBindings>()

memoTransferRoutes.use('*', requireMemoUser)

memoTransferRoutes.onError((err, c) => {
  if (err instanceof MemoImportError) {
    return c.json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    }, err.status)
  }
  return errorResponse(c, err)
})

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

memoTransferRoutes.post('/import/sessions', async (c) => {
  const body = await readJson<{ filename?: unknown; totalSize?: unknown }>(c, JSON_BODY_LIMITS.small)
  const session = await createMemoImportSession(c.env, c.get('userId'), body)
  return c.json(session, 201)
})

memoTransferRoutes.put('/import/sessions/:id', async (c) => {
  const offset = chunkOffset(c.req.header('x-chunk-offset') ?? c.req.query('offset'))
  let bytes: Uint8Array
  try {
    bytes = await readBytesWithinLimit(c.req.raw.body, MEMO_IMPORT_CHUNK_BYTES)
  } catch (error) {
    if (error instanceof ApiError && error.status === 413) {
      throw new MemoImportError(
        413,
        'memo_import_too_large',
        `Each chunk must be at most ${MEMO_IMPORT_CHUNK_BYTES} bytes`,
      )
    }
    throw error
  }
  const result = await appendMemoImportChunk(c.env, c.get('userId'), c.req.param('id'), offset, bytes)
  return c.json(result)
})

memoTransferRoutes.post('/import/sessions/:id/plan', async (c) => {
  const plan = await buildMemoImportPlan(c.env, c.get('userId'), c.req.param('id'))
  return c.json(plan)
})

memoTransferRoutes.post('/import/sessions/:id/commit', async (c) => {
  const body = await readOptionalJson<{ conflictPolicy?: unknown }>(c, JSON_BODY_LIMITS.small, {})
  const report = await commitMemoImport(
    c.env,
    c.get('userId'),
    c.req.param('id'),
    body.conflictPolicy,
  )
  return c.json(report)
})

memoTransferRoutes.delete('/import/sessions/:id', async (c) => {
  await cancelMemoImportSession(c.env, c.get('userId'), c.req.param('id'))
  return c.json({ ok: true })
})

function chunkOffset(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    throw new MemoImportError(400, 'memo_import_invalid', 'The x-chunk-offset header is required')
  }
  const offset = Number(raw)
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new MemoImportError(
      400,
      'memo_import_invalid',
      'The x-chunk-offset header must be a non-negative integer',
    )
  }
  return offset
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(filename)}`
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}
