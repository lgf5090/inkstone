/**
 * The local Univer collaboration service for the Office tab.
 *
 * Univer's history panel, realtime sessions and conflict resolution are all served by the same
 * collaboration core, so this process stands that core up: a Service owns the authoritative documents,
 * an Endpoint maps the browser protocol onto it, and the Node transport carries both the HTTP reads and
 * the WebSocket session. The memory adapter keeps it single-process and disposable — this is the
 * development origin, not a durable store; the app's own R2 revisions remain the file of record.
 *
 * Run with `npm start` from this directory. Nothing here is part of the app's build.
 */
import { createServer } from 'node:http'
import express from 'express'
import { LocaleType, LogLevel } from '@univerjs/core'
import { MemoryDatabaseAdapter } from '@univerjs-pro/collaboration-database-memory'
import { UniverCollabEndpoint } from '@univerjs-pro/collaboration-endpoint'
import { UniverCollabService } from '@univerjs-pro/collaboration-service'
import { createNodeTransport } from '@univerjs-pro/collaboration-transport-node'
import { ErrorCode, UniverType } from '@univerjs/protocol'

const PORT = Number(process.env.PORT ?? 3090)
const HOST = process.env.HOST ?? '127.0.0.1'

/** A blank sheet, used when a caller seeds an id without data. */
function emptySheet(id, name) {
  return {
    id,
    rev: 1,
    name,
    appVersion: '',
    locale: LocaleType.EN_US,
    sheetOrder: ['sheet-1'],
    sheets: {
      'sheet-1': { id: 'sheet-1', name: 'Sheet1', rowCount: 1000, columnCount: 26, cellData: {} },
    },
    styles: {},
    resources: [],
  }
}

function emptyDocument(id, name) {
  return {
    id,
    rev: 1,
    name,
    appVersion: '',
    locale: LocaleType.EN_US,
    documentStyle: { pageSize: { width: 594.3, height: 840.51 }, marginTop: 100, marginBottom: 100, marginLeft: 100, marginRight: 100 },
    body: { dataStream: `\r\n`, paragraphs: [{ startIndex: 0, paragraphId: 'p1' }], textRuns: [], sectionBreaks: [] },
  }
}

const database = new MemoryDatabaseAdapter()
const service = new UniverCollabService({ dbAdapter: database, logLevel: LogLevel.WARN })
const endpoint = new UniverCollabEndpoint(service)
const transport = createNodeTransport()

/**
 * Identity comes from the caller. The app's worker proxies these requests and stamps the header from
 * the session it already verified; anything else falls back to a single local reader so the service is
 * usable from curl.
 */
transport.use(async (context, next) => {
  const forwarded = context.req?.headers?.['x-inkstone-user']
  context.userID = typeof forwarded === 'string' && forwarded ? forwarded : 'local-reader'
  await next()
})

transport.register(endpoint)

const app = express()
app.use(express.json({ limit: '64mb' }))

// The app's worker asks the collaboration service to adopt a document the first time it is opened.
app.post('/inkstone/seed', async (request, response) => {
  const { unitId, type, name, snapshot, userId } = request.body ?? {}
  if (typeof unitId !== 'string' || !unitId) {
    response.status(400).json({ error: 'unitId is required' })
    return
  }
  const unitType = type === 'docs' ? UniverType.UNIVER_DOC : UniverType.UNIVER_SHEET
  const data = snapshot && typeof snapshot === 'object'
    ? { ...snapshot, id: unitId }
    : (unitType === UniverType.UNIVER_DOC ? emptyDocument(unitId, name ?? unitId) : emptySheet(unitId, name ?? unitId))
  try {
    await service.createUnitFromData({ type: unitType, data }, { userID: typeof userId === 'string' && userId ? userId : 'local-reader' })
    response.json({ created: true, unitId })
  } catch (error) {
    // A document that already exists is the normal case on the second open.
    response.json({ created: false, unitId, note: String(error?.message ?? error).slice(0, 200) })
  }
})

// The client asks this before reading a document; the dev service grants the local reader everything.
app.post('/universer-api/authz/-/object/-/batch_allowed', (request, response) => {
  const requests = Array.isArray(request.body?.requests) ? request.body.requests : []
  response.json({
    error: { code: ErrorCode.OK, message: '' },
    objectActions: requests.map((item) => ({
      unitID: item.unitID,
      objectID: item.objectID,
      actions: (item.actions ?? []).map((action) => ({ action, allowed: true })),
    })),
  })
})

app.get('/health', (_request, response) => {
  response.json({ ok: true, units: service.getUnits?.()?.length ?? null })
})

const server = createServer(app)
transport.attach(server)
server.listen(PORT, HOST, () => {
  console.log(`[univer-collab] listening on http://${HOST}:${PORT}`)
})
