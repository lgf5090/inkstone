import type { Env } from '../../env'
import { newId } from '../../lib/id'
import { sha256Hex } from '../../lib/encoding'
import {
  ICON_ICONIFY_MAX_BYTES,
  ICON_ICONIFY_SOURCE,
  ICON_ICONIFY_TIMEOUT_MS,
  ICON_SEED_IMPORT_LIMIT,
} from '@shared/development/icons/limits'
import { builtinLibrary } from '@shared/development/icons/builtins'
import type { IconCollectionStats, IconImport, IconImportItem } from '@shared/development/icons/types'
import { ensureSettings, usageFor } from './store'
import { deleteIconObject, getIconObject, iconObjectKey, iconThumbKey, putIconObject, userShard } from './r2'
import { webpThumbnail } from './raster'
import { sanitizeSvgText } from './svg-sanitize'
import { detectColorMode } from './import'

export type IconBulkMode = 'full' | 'missing' | 'seed'

interface IconifyIcon {
  body: string
  width?: number
  height?: number
}

interface IconifySource {
  width?: number
  height?: number
  icons?: Record<string, IconifyIcon>
  aliases?: Record<string, { parent: string }>
  info?: IconifyInfo
}

interface IconifyInfo {
  name?: string
  license?: { title?: string; spdx?: string }
  author?: { name?: string; url?: string }
}

interface PreparedIcon extends IconifyIcon {
  name: string
}

interface ImportManifest {
  chunkSize: number
  /** Names this job will walk (the missing subset for a fill-missing job). */
  total: number
  /** Names in the whole collection, so the drill-down can report the true set size. */
  sourceTotal: number
  name: string
  license: string
  homepage: string
}

const CHUNK_SIZE = 50

async function fetchJson<T>(url: string, limit = ICON_ICONIFY_MAX_BYTES): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(ICON_ICONIFY_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`The Iconify endpoint returned ${response.status}`)
  const text = await response.text()
  if (text.length > limit) throw new Error('The Iconify response is too large')
  return JSON.parse(text) as T
}

/**
 * Fetching one collection archive once and splitting it into 50-icon chunks turns a paginated import
 * into a sequence of small R2 reads: the expensive 8 MB download happens at creation, and a resumed
 * step never touches the network or re-downloads the name list.
 */
async function fetchSource(prefix: string): Promise<{ names: string[]; icons: Record<string, PreparedIcon>; width: number; height: number; name: string; license: string; homepage: string }> {
  const [source, info] = await Promise.all([
    fetchJson<IconifySource>(`${ICON_ICONIFY_SOURCE}/${prefix}/icons.json`, ICON_ICONIFY_MAX_BYTES),
    fetchJson<IconifyInfo>(`${ICON_ICONIFY_SOURCE}/${prefix}/info.json`, 256 * 1024).catch(() => ({} as IconifyInfo)),
  ])
  const raw = source.icons ?? {}
  // Aliases are alternate names for the same glyph, not additional icons. Importing them would make
  // the planned total exceed the rows the grid can show (they collide on the content hash).
  const names = Object.keys(raw).sort()
  if (!names.length) throw new Error('The Iconify collection has no icons')
  const icons: Record<string, PreparedIcon> = {}
  for (const name of names) {
    const icon = raw[name]
    if (icon) icons[name] = { ...icon, name }
  }
  return {
    names,
    icons,
    width: source.width ?? 24,
    height: source.height ?? 24,
    name: info.name ?? source.info?.name ?? builtinLibrary(prefix)?.name ?? prefix,
    license: info.license?.spdx ?? info.license?.title ?? source.info?.license?.spdx ?? source.info?.license?.title ?? builtinLibrary(prefix)?.license ?? '',
    homepage: info.author?.url ?? source.info?.author?.url ?? builtinLibrary(prefix)?.homepage ?? '',
  }
}

function stagingPrefix(shard: string, id: string): string {
  return `development/icons/imports/${shard}/${id}`
}

function manifestKey(shard: string, id: string): string {
  return `${stagingPrefix(shard, id)}/manifest.json`
}

function chunkKey(shard: string, id: string, index: number): string {
  return `${stagingPrefix(shard, id)}/chunk-${index}.json`
}

async function writeJson(env: Env, key: string, value: unknown): Promise<void> {
  await putIconObject(env, key, new TextEncoder().encode(JSON.stringify(value)), 'application/json', 'private, no-store')
}

async function readJsonObject<T>(env: Env, key: string): Promise<T | null> {
  const object = await getIconObject(env, key)
  if (!object) return null
  try {
    return JSON.parse(await object.text()) as T
  } catch {
    return null
  }
}

async function ensureCollection(env: Env, userId: string, prefix: string, name: string, license: string, homepage: string): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT id FROM development_icons_collections WHERE user_id=?1 AND slug=?2`,
  ).bind(userId, prefix).first<{ id: string }>()
  if (existing) return existing.id
  const id = newId()
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO development_icons_collections
       (user_id, id, name, slug, description, source, license, homepage, sort_order, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, '', 'iconify', ?5, ?6, 0, ?7, ?7)`,
  ).bind(userId, id, name, prefix, license, homepage, now).run()
  return id
}

async function existingNames(db: D1Database, userId: string, collectionId: string, names: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (let index = 0; index < names.length; index += 90) {
    const slice = names.slice(index, index + 90)
    const marks = slice.map((_, offset) => `?${offset + 3}`).join(', ')
    const rows = await db.prepare(
      `SELECT id, name_key FROM development_icons_assets
        WHERE user_id=?1 AND collection_id=?2 AND name_key IN (${marks})`,
    ).bind(userId, collectionId, ...slice.map((name) => name.toLowerCase())).all<{ id: string; name_key: string }>()
    for (const row of rows.results ?? []) map.set(row.name_key, row.id)
  }
  return map
}

async function missingNames(env: Env, userId: string, collectionId: string, names: string[]): Promise<string[]> {
  const existing = await existingNames(env.DB, userId, collectionId, names)
  return names.filter((name) => !existing.has(name.toLowerCase()))
}

function importRow(row: Record<string, unknown>): IconImport {
  return {
    id: String(row.id),
    kind: 'iconify',
    status: String(row.status) as IconImport['status'],
    prefix: String(row.prefix),
    totalItems: Number(row.total_items ?? 0),
    processedItems: Number(row.processed_items ?? 0),
    failedItems: Number(row.failed_items ?? 0),
    skippedItems: Number(row.skipped_items ?? 0),
    bytesTotal: Number(row.bytes_total ?? 0),
    error: String(row.error ?? ''),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
  }
}

async function getImportRow(env: Env, userId: string, id: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(`SELECT * FROM development_icons_imports WHERE user_id=?1 AND id=?2`).bind(userId, id).first<Record<string, unknown>>()
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await run(items[index]!)
    }
  })
  await Promise.all(workers)
  return output
}

export async function createBulkImport(env: Env, userId: string, prefix: string, mode: IconBulkMode): Promise<IconImport> {
  const running = await env.DB.prepare(
    `SELECT * FROM development_icons_imports
      WHERE user_id=?1 AND prefix=?2 AND status='running' AND kind='iconify'
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(userId, prefix).first<Record<string, unknown>>()
  if (running) return importRow(running)

  const source = await fetchSource(prefix)
  const collectionId = await ensureCollection(env, userId, prefix, source.name, source.license, source.homepage)
  const missing = mode === 'full' ? source.names : await missingNames(env, userId, collectionId, source.names)
  // A seed is a small, announced top-up rather than a silent half-import: it stage-copies only as many
  // missing names as the library's seed target still needs, so a killed seed resumes and a partially
  // seeded collection is topped up to the target instead of being treated as complete.
  const capacity = builtinLibrary(prefix)?.seedLimit ?? ICON_SEED_IMPORT_LIMIT
  const seeded = mode === 'seed'
    ? Number((await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM development_icons_assets WHERE user_id=?1 AND collection_id=?2`,
      ).bind(userId, collectionId).first<{ n: number }>())?.n ?? 0)
    : 0
  const names = mode === 'seed' ? missing.slice(0, Math.max(0, capacity - seeded)) : missing

  const id = newId()
  const now = Date.now()
  const status = names.length ? 'running' : 'done'
  const shard = await userShard(userId)
  const manifest: ImportManifest = {
    chunkSize: CHUNK_SIZE,
    total: names.length,
    sourceTotal: source.names.length,
    name: source.name,
    license: source.license,
    homepage: source.homepage,
  }
  await writeJson(env, manifestKey(shard, id), manifest)
  const chunks: number[] = []
  for (let index = 0; index < names.length; index += CHUNK_SIZE) chunks.push(index / CHUNK_SIZE)
  await mapLimit(chunks, 8, async (index) => {
    const slice = names.slice(index * CHUNK_SIZE, index * CHUNK_SIZE + CHUNK_SIZE)
    const icons: Record<string, IconifyIcon> = {}
    for (const name of slice) {
      const icon = source.icons[name]
      if (icon) icons[name] = { body: icon.body, width: icon.width, height: icon.height }
    }
    await writeJson(env, chunkKey(shard, id, index), { names: slice, icons, width: source.width, height: source.height })
  })
  await env.DB.prepare(
    `INSERT INTO development_icons_imports
       (user_id, id, kind, status, prefix, total_items, processed_items, failed_items, skipped_items, bytes_total, error, created_at, updated_at, finished_at)
     VALUES (?1, ?2, 'iconify', ?3, ?4, ?5, 0, 0, 0, 0, '', ?6, ?6, ?7)`,
  ).bind(userId, id, status, prefix, names.length, now, names.length ? null : now).run()
  const row = await getImportRow(env, userId, id)
  return row ? importRow(row) : {
    id, kind: 'iconify', status, prefix, totalItems: names.length, processedItems: 0,
    failedItems: 0, skippedItems: 0, bytesTotal: 0, error: '', createdAt: now, updatedAt: now,
    finishedAt: names.length ? null : now,
  }
}

export interface BulkStepResult {
  import: IconImport
  failures: IconImportItem[]
}

/**
 * One chunk per call. `processed_items` is the cursor: closing the tab pauses the import and the
 * next visit resumes at the same chunk. Names already in the collection are skipped before any byte
 * is written, so a repeated import and "fill missing" are both idempotent.
 */
export async function stepBulkImport(env: Env, userId: string, id: string): Promise<BulkStepResult> {
  const row = await getImportRow(env, userId, id)
  if (!row) throw new Error('The import was not found')
  const status = String(row.status)
  if (status !== 'running') {
    return { import: importRow(row), failures: await failedItems(env, userId, id) }
  }

  const prefix = String(row.prefix)
  const collection = await env.DB.prepare(
    `SELECT id, name, license, homepage FROM development_icons_collections WHERE user_id=?1 AND slug=?2`,
  ).bind(userId, prefix).first<{ id: string; name: string; license: string; homepage: string }>()
  if (!collection) throw new Error('The collection was not found')

  const total = Number(row.total_items ?? 0)
  const start = Number(row.processed_items ?? 0)
  if (start >= total) {
    const now = Date.now()
    await env.DB.prepare(
      `UPDATE development_icons_imports SET status='done', updated_at=?3, finished_at=?3
        WHERE user_id=?1 AND id=?2 AND status='running'`,
    ).bind(userId, id, now).run()
    const done = await getImportRow(env, userId, id)
    return { import: done ? importRow(done) : importRow(row), failures: await failedItems(env, userId, id) }
  }

  const now = Date.now()
  const claim = await env.DB.prepare(
    `UPDATE development_icons_imports SET updated_at=?4
      WHERE user_id=?1 AND id=?2 AND processed_items=?3 AND status='running'`,
  ).bind(userId, id, start, now).run()
  if (!claim.meta.changes) {
    const current = await getImportRow(env, userId, id)
    return { import: current ? importRow(current) : importRow(row), failures: await failedItems(env, userId, id) }
  }

  const shard = await userShard(userId)
  const chunkIndex = Math.floor(start / CHUNK_SIZE)
  const chunk = await readJsonObject<{ names: string[]; icons: Record<string, IconifyIcon>; width?: number; height?: number }>(env, chunkKey(shard, id, chunkIndex))
  if (!chunk) {
    await env.DB.prepare(
      `UPDATE development_icons_imports SET status='failed', error=?3, updated_at=?4, finished_at=?4 WHERE user_id=?1 AND id=?2`,
    ).bind(userId, id, 'The staged import chunk is missing; run fill missing again', Date.now()).run()
    const current = await getImportRow(env, userId, id)
    return { import: current ? importRow(current) : importRow(row), failures: await failedItems(env, userId, id) }
  }

  const existing = await existingNames(env.DB, userId, collection.id, chunk.names)
  const settings = await ensureSettings(env.DB, userId)
  let usage = await usageFor(env.DB, userId)

  let failed = 0
  let skipped = 0
  let bytes = 0
  const itemRows: { name: string; status: string; assetId: string | null; error: string }[] = []
  const assetRows: { id: string; name: string; content: Uint8Array; sha256: string; key: string; thumbKey: string | null; width: number; height: number; license: string; sourceUrl: string; colorMode: string }[] = []

  for (const name of chunk.names) {
    const existingId = existing.get(name.toLowerCase())
    if (existingId) {
      skipped += 1
      itemRows.push({ name, status: 'skipped', assetId: existingId, error: 'existing' })
      continue
    }
    const icon = chunk.icons[name]
    if (!icon?.body) {
      failed += 1
      itemRows.push({ name, status: 'failed', assetId: null, error: 'The Iconify collection did not return this icon' })
      continue
    }
    const width = icon.width ?? chunk.width ?? 24
    const height = icon.height ?? chunk.height ?? 24
    try {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${icon.body}</svg>`
      const sanitized = sanitizeSvgText(svg, settings.maxSvgBytes)
      const content = new TextEncoder().encode(sanitized)
      if (usage.usedBytes + content.byteLength > settings.quotaBytes) throw new Error('icons_quota_exceeded')
      const sha256 = await sha256Hex(content)
      assetRows.push({
        id: newId(), name, content, sha256, key: iconObjectKey('svg', shard, sha256), thumbKey: null,
        width, height, license: collection.license, sourceUrl: `${prefix}/${name}`,
        colorMode: detectColorMode(icon.body),
      })
      usage = { ...usage, usedBytes: usage.usedBytes + content.byteLength }
    } catch (error) {
      failed += 1
      itemRows.push({ name, status: 'failed', assetId: null, error: error instanceof Error ? error.message : 'Import failed' })
    }
  }

  const bySha = new Map<string, string>()
  for (let index = 0; index < assetRows.length; index += 90) {
    const chunkRows = assetRows.slice(index, index + 90)
    const marks = chunkRows.map((_, offset) => `?${offset + 2}`).join(', ')
    const rows = await env.DB.prepare(
      `SELECT sha256, id FROM development_icons_assets
        WHERE user_id=?1 AND format='svg' AND sha256 IN (${marks})`,
    ).bind(userId, ...chunkRows.map((asset) => asset.sha256)).all<{ sha256: string; id: string }>()
    for (const entry of rows.results ?? []) bySha.set(entry.sha256, entry.id)
  }

  const seenSha = new Map<string, string>()
  const writable = assetRows.filter((asset) => {
    const same = bySha.get(asset.sha256)
    if (same) {
      skipped += 1
      itemRows.push({ name: asset.name, status: 'skipped', assetId: same, error: 'duplicate' })
      return false
    }
    const sameBatch = seenSha.get(asset.sha256)
    if (sameBatch) {
      skipped += 1
      itemRows.push({ name: asset.name, status: 'skipped', assetId: null, error: 'duplicate' })
      return false
    }
    seenSha.set(asset.sha256, asset.id)
    bytes += asset.content.byteLength
    return true
  })

  // The grid paints `thumbUrl`, which falls back to the raw SVG when no thumbnail exists. Generating the
  // 96px WebP while the chunk is already in memory keeps a bulk import fast to browse; importing it without
  // a thumbnail is what left the deployed library scrolling at a fraction of the frame rate.
  await mapLimit(writable, 8, async (asset) => {
    await putIconObject(env, asset.key, asset.content, 'image/svg+xml')
    try {
      const thumb = await webpThumbnail(env, asset.content, 'image/svg+xml', 96)
      if (thumb) {
        const key = iconThumbKey(shard, asset.sha256, 96)
        await putIconObject(env, key, thumb, 'image/webp')
        asset.thumbKey = key
      }
    } catch (error) {
      console.warn('[inkstone] bulk import thumbnail failed:', error)
    }
  })

  const statements: D1PreparedStatement[] = []
  for (const asset of writable) {
    const createdAt = Date.now()
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO development_icons_assets
         (user_id, id, collection_id, name, name_key, format, mime, bytes, width, height, view_box, sha256, r2_key, thumb_key, keywords, color_mode, license, source_url, sanitized, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'svg', 'image/svg+xml', ?6, ?7, ?8, ?9, ?10, ?11, ?12, '', ?13, ?14, ?15, 1, ?16, ?16)`,
    ).bind(
      userId, asset.id, collection.id, asset.name, asset.name.toLowerCase(), asset.content.byteLength,
      asset.width, asset.height, `0 0 ${asset.width} ${asset.height}`, asset.sha256, asset.key, asset.thumbKey,
      asset.colorMode, asset.license, asset.sourceUrl, createdAt,
    ))
    itemRows.push({ name: asset.name, status: 'done', assetId: asset.id, error: '' })
  }
  for (const item of itemRows) {
    const createdAt = Date.now()
    statements.push(env.DB.prepare(
      `INSERT OR REPLACE INTO development_icons_import_items
         (user_id, import_id, item_key, filename, status, asset_id, error, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    ).bind(userId, id, item.name, `${prefix}/${item.name}.svg`, item.status, item.assetId, item.error, createdAt))
  }
  try {
    for (let index = 0; index < statements.length; index += 100) {
      await env.DB.batch(statements.slice(index, index + 100))
    }
  } catch (error) {
    // A failed write is a failed import, not a silently short collection: the job carries the reason and
    // the drill-down keeps the gap visible so "fill missing" can finish it.
    const reason = error instanceof Error ? error.message : 'The icon rows could not be written'
    await env.DB.prepare(
      `UPDATE development_icons_imports SET status='failed', error=?3, updated_at=?4, finished_at=?4
        WHERE user_id=?1 AND id=?2`,
    ).bind(userId, id, reason, Date.now()).run()
    const failedRow = await getImportRow(env, userId, id)
    return {
      import: failedRow ? importRow(failedRow) : importRow(row),
      failures: await failedItems(env, userId, id),
    }
  }

  const end = Math.min(total, start + chunk.names.length)
  const finished = end >= total
  await env.DB.prepare(
    `UPDATE development_icons_imports
        SET status=?3, processed_items=?4, failed_items=failed_items+?5,
            skipped_items=skipped_items+?6, bytes_total=bytes_total+?7, updated_at=?8, finished_at=?9
      WHERE user_id=?1 AND id=?2`,
  ).bind(userId, id, finished ? 'done' : 'running', end, failed, skipped, bytes, Date.now(), finished ? Date.now() : null).run()
  if (finished) {
    // Only a run where every planned icon failed is a failed import; a partial failure stays "done" with a
    // visible failure count and a retry entry.
    const totals = await env.DB.prepare(
      `SELECT failed_items AS f FROM development_icons_imports WHERE user_id=?1 AND id=?2`,
    ).bind(userId, id).first<{ f: number }>()
    if (Number(totals?.f ?? 0) >= total && total > 0) {
      await env.DB.prepare(
        `UPDATE development_icons_imports SET status='failed', error=?3 WHERE user_id=?1 AND id=?2`,
      ).bind(userId, id, 'Every icon in this import failed').run()
    }
  }

  if (finished) {
    // The staged bodies are only needed while the cursor is moving; the manifest stays for the
    // drill-down's source total.
    const count = Math.ceil(total / CHUNK_SIZE)
    await mapLimit(Array.from({ length: count }, (_, index) => index), 8, async (index) => {
      await deleteIconObject(env, chunkKey(shard, id, index))
    })
  }

  const current = await getImportRow(env, userId, id)
  return {
    import: current ? importRow(current) : importRow(row),
    failures: await failedItems(env, userId, id),
  }
}

export async function cancelBulkImport(env: Env, userId: string, id: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE development_icons_imports SET status='canceled', updated_at=?3, finished_at=?3
      WHERE user_id=?1 AND id=?2 AND status='running'`,
  ).bind(userId, id, Date.now()).run()
}

export async function failedItems(env: Env, userId: string, id: string, limit = 50): Promise<IconImportItem[]> {
  const rows = await env.DB.prepare(
    `SELECT item_key, filename, status, asset_id, error FROM development_icons_import_items
      WHERE user_id=?1 AND import_id=?2 AND status='failed'
      ORDER BY item_key LIMIT ?3`,
  ).bind(userId, id, Math.min(200, Math.max(1, limit))).all<Record<string, unknown>>()
  return (rows.results ?? []).map((entry) => ({
    itemKey: String(entry.item_key),
    filename: String(entry.filename ?? ''),
    status: 'failed',
    assetId: entry.asset_id ? String(entry.asset_id) : null,
    error: String(entry.error ?? ''),
  }))
}

/**
 * The collection drill-down: the full total the import planned, the rows actually in D1, and the
 * latest attempt. The imported number is the count the sidebar shows, so a short count is visible.
 */
export async function collectionStats(env: Env, userId: string, collectionId: string): Promise<IconCollectionStats> {
  const collection = await env.DB.prepare(
    `SELECT id, slug FROM development_icons_collections WHERE user_id=?1 AND id=?2`,
  ).bind(userId, collectionId).first<{ id: string; slug: string }>()
  if (!collection) throw new Error('The collection was not found')
  const [count, last, largest] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM development_icons_assets WHERE user_id=?1 AND collection_id=?2`).bind(userId, collectionId).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT * FROM development_icons_imports
        WHERE user_id=?1 AND prefix=?2 AND kind='iconify'
        ORDER BY created_at DESC LIMIT 1`,
    ).bind(userId, collection.slug).first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT MAX(total_items) AS n FROM development_icons_imports WHERE user_id=?1 AND prefix=?2 AND kind='iconify'`,
    ).bind(userId, collection.slug).first<{ n: number }>(),
  ])
  const imported = Number(count?.n ?? 0)
  const shard = await userShard(userId)
  const manifest = last ? await readJsonObject<ImportManifest>(env, manifestKey(shard, String(last.id))) : null
  const duplicates = last
    ? await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM development_icons_import_items
          WHERE user_id=?1 AND import_id=?2 AND status='skipped' AND error='duplicate'`,
      ).bind(userId, String(last.id)).first<{ n: number }>()
    : null
  // The archive manifest knows the exact set size. Rows written by the retired per-icon seed carry no
  // manifest and used to report `total_items: 140`, which described the seed batch rather than the
  // collection; for those the library's declared total is the honest fallback.
  const declared = manifest?.sourceTotal
    ?? builtinLibrary(collection.slug)?.totalIcons
    ?? manifest?.total
    ?? Number(largest?.n ?? 0)
  // A collection can never hold more rows than its own total; a stale declared size would otherwise show
  // "total 1960, imported 2108".
  const total = Math.max(Number(declared ?? 0), imported)
  // No matching import row means this collection has never run through the archive pipeline (the old
  // per-icon seed wrote a single unlabelled row). Reporting "done" there hid a real gap behind a
  // completed-looking status; "idle" lets the missing count and the fill button tell the truth.
  const status = last ? String(last.status) : 'idle'
  return {
    collectionId,
    prefix: collection.slug,
    total,
    imported,
    missing: Math.max(0, total - imported - Number(duplicates?.n ?? 0)),
    duplicates: Number(duplicates?.n ?? 0),
    lastImportedAt: last ? Number(last.finished_at ?? last.updated_at ?? last.created_at) : null,
    status: status as IconCollectionStats['status'],
    failedItems: Number(last?.failed_items ?? 0),
    importId: last ? String(last.id) : null,
  }
}
