import { sha256Hex } from '../../lib/encoding'
import type { Env } from '../../env'
import type { IconJob, IconJobOptions } from '@shared/development/icons/types'
import { ICON_SPRITE_MAX_ASSETS } from '@shared/development/icons/limits'
import type { JobAssetRow } from './store'
import {
  finishJobIfComplete,
  getJob,
  getJobAssets,
  jobOutputRows,
  markJobRunning,
  recordJobOutput,
  setJobItemOutcome,
  syncJobProgress,
  usageFor,
} from './store'
import { encodeIco, icoSizesToken } from './ico'
import { rasterRasterToPng, rasterizeSvg } from './raster'
import { buildPngSprite, buildSvgSymbolSprite } from './sprite'
import { getIconObject, putIconObject, spriteObjectUrl, userShard } from './r2'
import { sanitizeSvgText } from './svg-sanitize'

export interface ConvertedFile {
  name: string
  key: string
  bytes: Uint8Array
  contentType: string
  public: boolean
}

export interface ConvertedItem {
  outputs: Record<string, string>
  files: ConvertedFile[]
}

class Budget {
  private remaining: number
  constructor(quota: number, used: number) {
    this.remaining = Math.max(0, quota - used)
  }
  take(bytes: number): boolean {
    if (bytes > this.remaining) return false
    this.remaining -= bytes
    return true
  }
}

async function objectBytes(env: Env, key: string): Promise<Uint8Array> {
  const object = await getIconObject(env, key)
  if (!object) throw new Error('The source object was not found')
  return new Uint8Array(await object.arrayBuffer())
}

async function svgForAsset(env: Env, asset: JobAssetRow): Promise<string> {
  if (asset.format !== 'svg') throw new Error('Only SVG assets can be rasterized on the server')
  const bytes = await objectBytes(env, asset.r2Key)
  return sanitizeSvgText(new TextDecoder().decode(bytes), 1024 * 1024)
}

function pngKey(shard: string, sha256: string, width: number): string {
  return `development/icons/png/u${shard}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}-w${width}.png`
}

function icoKey(shard: string, sha256: string, token: string): string {
  return `development/icons/ico/u${shard}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}-ico-${token}.ico`
}

async function pngAt(env: Env, asset: JobAssetRow, size: number): Promise<{ png: Uint8Array; width: number }> {
  if (asset.format === 'svg') {
    const rendered = await rasterizeSvg(await svgForAsset(env, asset), size)
    return { png: rendered.png, width: rendered.width }
  }
  const bytes = await objectBytes(env, asset.r2Key)
  const result = await rasterRasterToPng(env, bytes, asset.mime, size, asset.width ?? size)
  if (!result) throw new Error('Raster resizing is not configured')
  return { png: result.png, width: result.width }
}

function addFile(files: ConvertedFile[], budget: Budget, file: ConvertedFile): string {
  if (file.key && !files.some((entry) => entry.key === file.key)) {
    if (!budget.take(file.bytes.byteLength)) throw new Error('icons_quota_exceeded')
    files.push(file)
  }
  return file.key
}

async function convertPng(env: Env, shard: string, asset: JobAssetRow, options: Extract<IconJobOptions, { kind: 'png' }>, budget: Budget): Promise<ConvertedItem> {
  const files: ConvertedFile[] = []
  const outputs: Record<string, string> = {}
  for (const size of options.sizes) {
    const rendered = await pngAt(env, asset, size)
    const key = pngKey(shard, asset.sha256, rendered.width)
    addFile(files, budget, { name: String(size), key, bytes: rendered.png, contentType: 'image/png', public: true })
    outputs[String(size)] = `/api/development/icons/objects/png/u${shard}/${asset.sha256.slice(0, 2)}/${asset.sha256.slice(2, 4)}/${asset.sha256}-w${rendered.width}.png`
  }
  return { outputs, files }
}

async function convertIco(env: Env, shard: string, asset: JobAssetRow, options: Extract<IconJobOptions, { kind: 'ico' }>, budget: Budget): Promise<ConvertedItem> {
  const entries = []
  for (const size of [...options.sizes].sort((left, right) => left - right)) {
    const rendered = await pngAt(env, asset, size)
    entries.push({ size, png: rendered.png })
  }
  const ico = encodeIco(entries)
  const token = icoSizesToken(options.sizes)
  const key = icoKey(shard, asset.sha256, token)
  const files: ConvertedFile[] = [{ name: 'ico', key, bytes: ico, contentType: 'image/x-icon', public: true }]
  addFile(files, budget, files[0]!)
  return {
    outputs: { ico: `/api/development/icons/objects/ico/u${shard}/${asset.sha256.slice(0, 2)}/${asset.sha256.slice(2, 4)}/${asset.sha256}-ico-${token}.ico` },
    files,
  }
}

function spriteSetHash(assets: readonly JobAssetRow[], options: IconJobOptions): Promise<string> {
  const recipe = JSON.stringify({ kind: options.kind, options, assets: assets.map((asset) => asset.sha256).sort() })
  return sha256Hex(recipe)
}

async function manifestFor(job: IconJob, assets: readonly JobAssetRow[], files: readonly { name: string; key: string; bytes: number }[]): Promise<Uint8Array> {
  return new TextEncoder().encode(JSON.stringify({
    version: 1,
    jobId: job.id,
    kind: job.kind,
    recipe: job.options,
    generatedAt: new Date().toISOString(),
    assets: assets.map((asset) => ({
      assetId: asset.id,
      name: asset.name,
      format: asset.format,
      sha256: asset.sha256,
      license: asset.license,
      sourceUrl: asset.sourceUrl,
      collectionId: asset.collectionId,
    })),
    files: files.map((file) => ({ name: file.name, key: file.key, bytes: file.bytes })),
  }, null, 2))
}

async function writeFiles(env: Env, files: readonly ConvertedFile[]): Promise<void> {
  for (const file of files) {
    await putIconObject(env, file.key, file.bytes, file.contentType, file.public ? 'public, max-age=31536000, immutable' : 'private, no-store')
  }
}

async function recordFiles(env: Env, userId: string, jobId: string, assetId: string, files: readonly ConvertedFile[], outputs: Record<string, string>): Promise<void> {
  for (const file of files) {
    const digest = await sha256Hex(file.bytes)
    await recordJobOutput(env.DB, userId, jobId, assetId, file.name, file.key, file.bytes.byteLength, digest)
  }
  await setJobItemOutcome(env.DB, userId, jobId, assetId, 'done', outputs)
}

async function processSprite(env: Env, userId: string, job: IconJob, assets: readonly JobAssetRow[], budget: Budget): Promise<void> {
  const shard = await userShard(userId)
  const setHash = await spriteSetHash(assets, job.options)
  const sources = await Promise.all(assets.map(async (asset) => ({ asset, svg: await svgForAsset(env, asset) })))
  const files: ConvertedFile[] = []
  const spriteId = `sprite-${setHash.slice(0, 12)}`
  let outputs: Record<string, string>

  if (job.options.kind === 'sprite_svg') {
    const sprite = buildSvgSymbolSprite(sources.map(({ asset, svg }) => ({ name: asset.name, svg })), spriteId)
    const base = `development/icons/sprite/u${shard}/${setHash}`
    const svgBytes = new TextEncoder().encode(sprite.svg)
    const jsonBytes = new TextEncoder().encode(JSON.stringify(sprite.json, null, 2))
    addFile(files, budget, { name: 'sprite', key: `${base}/sprite.svg`, bytes: svgBytes, contentType: 'image/svg+xml', public: true })
    addFile(files, budget, { name: 'index', key: `${base}/sprite.json`, bytes: jsonBytes, contentType: 'application/json', public: true })
    outputs = {
      svg: spriteObjectUrl(shard, setHash, 'sprite.svg'),
      json: spriteObjectUrl(shard, setHash, 'sprite.json'),
    }
  } else {
    const options = job.options as Extract<IconJobOptions, { kind: 'sprite_png' }>
    const base = `development/icons/sprite/u${shard}/${setHash}`
    const rendered = await buildPngSprite(sources.map(({ asset, svg }) => ({ name: asset.name, svg })), spriteId, options.padding, 1, options.scss)
    const pngBytes = rendered.png
    const jsonBytes = new TextEncoder().encode(JSON.stringify(rendered.json, null, 2))
    const cssBytes = new TextEncoder().encode(rendered.css)
    addFile(files, budget, { name: 'sprite', key: `${base}/sprite.png`, bytes: pngBytes, contentType: 'image/png', public: true })
    addFile(files, budget, { name: 'index', key: `${base}/sprite.json`, bytes: jsonBytes, contentType: 'application/json', public: true })
    addFile(files, budget, { name: 'css', key: `${base}/sprite.css`, bytes: cssBytes, contentType: 'text/css', public: true })
    outputs = {
      png: spriteObjectUrl(shard, setHash, 'sprite.png'),
      json: spriteObjectUrl(shard, setHash, 'sprite.json'),
      css: spriteObjectUrl(shard, setHash, 'sprite.css'),
    }
    if (options.scales.includes(2)) {
      const high = await buildPngSprite(sources.map(({ asset, svg }) => ({ name: asset.name, svg })), spriteId, options.padding, 2, false)
      addFile(files, budget, { name: 'sprite2x', key: `${base}/sprite@2x.png`, bytes: high.png, contentType: 'image/png', public: true })
      outputs.png2x = spriteObjectUrl(shard, setHash, 'sprite@2x.png')
    }
    if (rendered.scss) {
      addFile(files, budget, { name: 'scss', key: `${base}/sprite.scss`, bytes: new TextEncoder().encode(rendered.scss), contentType: 'text/x-scss', public: true })
      outputs.scss = spriteObjectUrl(shard, setHash, 'sprite.scss')
    }
  }

  await writeFiles(env, files)
  for (const file of files) {
    const digest = await sha256Hex(file.bytes)
    await recordJobOutput(env.DB, userId, job.id, job.id, file.name, file.key, file.bytes.byteLength, digest)
  }
  for (const asset of assets) await setJobItemOutcome(env.DB, userId, job.id, asset.id, 'done', outputs)
}

async function processItems(env: Env, userId: string, job: IconJob, assets: readonly JobAssetRow[], budget: Budget): Promise<void> {
  const shard = await userShard(userId)
  for (const asset of assets) {
    try {
      if (job.options.kind === 'png') {
        const result = await convertPng(env, shard, asset, job.options, budget)
        await writeFiles(env, result.files)
        await recordFiles(env, userId, job.id, asset.id, result.files, result.outputs)
      } else if (job.options.kind === 'ico') {
        const result = await convertIco(env, shard, asset, job.options, budget)
        await writeFiles(env, result.files)
        await recordFiles(env, userId, job.id, asset.id, result.files, result.outputs)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Conversion failed'
      await setJobItemOutcome(env.DB, userId, job.id, asset.id, 'failed', {}, reason)
    }
  }
}

export async function writeManifest(env: Env, userId: string, job: IconJob, assets: readonly JobAssetRow[]): Promise<string> {
  const shard = await userShard(userId)
  const outputs = await jobOutputRows(env.DB, userId, job.id)
  const files = outputs.map((row) => ({ name: row.name, key: row.r2Key, bytes: row.bytes }))
  const key = `development/icons/manifests/u${shard}/${job.id}.json`
  await putIconObject(env, key, await manifestFor(job, assets, files), 'application/json', 'private, no-store')
  return key
}

/**
 * Advance a job by one bounded chunk.
 *
 * A queue message calls this once; a browser fallback calls it only to finalize the manifest. The
 * expensive conversion itself never runs inside the request that created the job.
 */
export async function processJob(env: Env, userId: string, jobId: string): Promise<{ status: IconJob['status']; pending: number }> {
  const job = await getJob(env.DB, userId, jobId)
  if (['done', 'partial', 'failed', 'canceled'].includes(job.status)) {
    return { status: job.status, pending: 0 }
  }
  await markJobRunning(env.DB, userId, jobId)
  const usage = await usageFor(env.DB, userId)
  const budget = new Budget(usage.quotaBytes, usage.usedBytes)
  const pending = await getJobAssets(env.DB, userId, jobId, true)

  if (job.options.kind === 'sprite_svg' || job.options.kind === 'sprite_png') {
    if (pending.length > ICON_SPRITE_MAX_ASSETS) {
      for (const asset of pending) await setJobItemOutcome(env.DB, userId, jobId, asset.id, 'failed', {}, 'icons_sprite_too_large')
    } else {
      try {
        await processSprite(env, userId, job, pending, budget)
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Sprite generation failed'
        for (const asset of pending) await setJobItemOutcome(env.DB, userId, jobId, asset.id, 'failed', {}, reason)
      }
    }
  } else {
    await processItems(env, userId, job, pending, budget)
  }

  const counts = await syncJobProgress(env.DB, userId, jobId)
  const latest = await getJob(env.DB, userId, jobId)
  if (latest.status === 'canceled') return { status: 'canceled', pending: 0 }
  if (counts.pending === 0) {
    const all = await getJobAssets(env.DB, userId, jobId, false)
    const key = await writeManifest(env, userId, job, all)
    const status = await finishJobIfComplete(env.DB, userId, jobId, key)
    return { status: status ?? 'partial', pending: 0 }
  }
  return { status: 'running', pending: counts.pending }
}

/** Finalize a job whose outputs the browser has already uploaded. */
export async function finalizeBrowserJob(env: Env, userId: string, jobId: string): Promise<IconJob['status']> {
  const job = await getJob(env.DB, userId, jobId)
  if (job.status === 'canceled') return 'canceled'
  const counts = await syncJobProgress(env.DB, userId, jobId)
  if (counts.pending > 0) {
    await markJobRunning(env.DB, userId, jobId)
    return 'running'
  }
  const assets = await getJobAssets(env.DB, userId, jobId, false)
  const key = await writeManifest(env, userId, job, assets)
  return (await finishJobIfComplete(env.DB, userId, jobId, key)) ?? 'running'
}

export interface ExportArtifacts {
  files: ConvertedFile[]
  perAsset: Record<string, Record<string, string>>
  shared: Record<string, string>
}

/** Build artifacts for an export without touching the job tables. */
export async function buildExportArtifacts(
  env: Env,
  userId: string,
  assets: readonly JobAssetRow[],
  options: IconJobOptions,
): Promise<ExportArtifacts> {
  const shard = await userShard(userId)
  const budget = new Budget(Number.MAX_SAFE_INTEGER, 0)
  const files: ConvertedFile[] = []
  const perAsset: Record<string, Record<string, string>> = {}
  const shared: Record<string, string> = {}

  if (options.kind === 'sprite_svg' || options.kind === 'sprite_png') {
    const setHash = await spriteSetHash(assets, options)
    const sources = await Promise.all(assets.map(async (asset) => ({ asset, svg: await svgForAsset(env, asset) })))
    const spriteId = `sprite-${setHash.slice(0, 12)}`
    const base = `development/icons/sprite/u${shard}/${setHash}`
    if (options.kind === 'sprite_svg') {
      const sprite = buildSvgSymbolSprite(sources.map(({ asset, svg }) => ({ name: asset.name, svg })), spriteId)
      addFile(files, budget, { name: 'sprite', key: `${base}/sprite.svg`, bytes: new TextEncoder().encode(sprite.svg), contentType: 'image/svg+xml', public: true })
      addFile(files, budget, { name: 'index', key: `${base}/sprite.json`, bytes: new TextEncoder().encode(JSON.stringify(sprite.json, null, 2)), contentType: 'application/json', public: true })
    } else {
      const rendered = await buildPngSprite(sources.map(({ asset, svg }) => ({ name: asset.name, svg })), spriteId, options.padding, 1, options.scss)
      addFile(files, budget, { name: 'sprite', key: `${base}/sprite.png`, bytes: rendered.png, contentType: 'image/png', public: true })
      addFile(files, budget, { name: 'index', key: `${base}/sprite.json`, bytes: new TextEncoder().encode(JSON.stringify(rendered.json, null, 2)), contentType: 'application/json', public: true })
      addFile(files, budget, { name: 'css', key: `${base}/sprite.css`, bytes: new TextEncoder().encode(rendered.css), contentType: 'text/css', public: true })
      if (options.scales.includes(2)) {
        const high = await buildPngSprite(sources.map(({ asset, svg }) => ({ name: asset.name, svg })), spriteId, options.padding, 2, false)
        addFile(files, budget, { name: 'sprite2x', key: `${base}/sprite@2x.png`, bytes: high.png, contentType: 'image/png', public: true })
      }
      if (rendered.scss) addFile(files, budget, { name: 'scss', key: `${base}/sprite.scss`, bytes: new TextEncoder().encode(rendered.scss), contentType: 'text/x-scss', public: true })
    }
    for (const file of files) shared[file.name] = file.key
    return { files, perAsset, shared }
  }

  for (const asset of assets) {
    const result = options.kind === 'png'
      ? await convertPng(env, shard, asset, options, budget)
      : await convertIco(env, shard, asset, options, budget)
    files.push(...result.files)
    perAsset[asset.id] = result.outputs
  }
  return { files, perAsset, shared }
}

