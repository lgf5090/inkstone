import type { IconAssetSummary, IconJob } from '@shared/development/icons/types'
import { ICON_SPRITE_CELL } from '@shared/development/icons/limits'
import { uploadJobItemOutputs, uploadJobSprite } from '../api'

/**
 * Browser-side conversion.
 *
 * This is the fallback when no Queues binding is deployed: the client rasterizes with Canvas,
 * packs ICO/sprite containers itself, and uploads the real bytes to the job. The server re-checks
 * every file before it records an output, so the job cannot reach `done` on a status change alone.
 */

interface LoadedAsset {
  asset: IconAssetSummary
  blob: Blob
  svg?: string
}

async function loadAsset(asset: IconAssetSummary): Promise<LoadedAsset> {
  const response = await fetch(asset.rawUrl)
  if (!response.ok) throw new Error(`Could not read ${asset.name}`)
  const blob = await response.blob()
  if (asset.format === 'svg') return { asset, blob, svg: await blob.text() }
  return { asset, blob }
}

function scaledSvg(svg: string, width: number, height: number): string {
  const sized = svg.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    const cleaned = attrs.replace(/\s(?:width|height)\s*=\s*["'][^"']*["']/gi, '')
    return `<svg${cleaned} width="${width}" height="${height}">`
  })
  return sized
}

function viewBoxRatio(svg: string): number {
  const match = /viewBox\s*=\s*["']([^"']+)["']/i.exec(svg)
  if (!match) return 1
  const parts = match[1]!.trim().split(/\s+/).map(Number)
  if (parts.length !== 4 || !parts[2] || !parts[3]) return 1
  return parts[3] / parts[2]
}

async function decodeSource(source: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (source.type === 'image/svg+xml') {
    const url = URL.createObjectURL(source)
    const image = new Image()
    image.src = url
    await image.decode()
    URL.revokeObjectURL(url)
    return image
  }
  return createImageBitmap(source)
}

async function drawToBlob(source: Blob, width: number, height: number): Promise<Blob> {
  const bitmap = await decodeSource(source)
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height })
  const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!context) throw new Error('Canvas is not available')
  context.clearRect(0, 0, width, height)
  context.drawImage(bitmap as CanvasImageSource, 0, 0, width, height)
  if ('close' in bitmap) bitmap.close()
  if (canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type: 'image/png' })
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png'))
}

export async function renderPng(loaded: LoadedAsset, size: number): Promise<Blob> {
  if (loaded.svg) {
    const height = Math.max(1, Math.round(size * viewBoxRatio(loaded.svg)))
    const blob = new Blob([scaledSvg(loaded.svg, size, height)], { type: 'image/svg+xml' })
    return drawToBlob(blob, size, height)
  }
  const sourceWidth = loaded.asset.width ?? size
  const target = Math.min(size, sourceWidth)
  return drawToBlob(loaded.blob, target, target)
}

function icoToken(sizes: readonly number[]): string {
  return [...new Set(sizes)].sort((a, b) => a - b).join('-')
}

export async function buildIco(pngs: readonly { size: number; blob: Blob }[]): Promise<Blob> {
  const payloads = await Promise.all(pngs.map(async (entry) => ({ size: entry.size, bytes: new Uint8Array(await entry.blob.arrayBuffer()) })))
  const header = 6 + payloads.length * 16
  const total = header + payloads.reduce((sum, entry) => sum + entry.bytes.byteLength, 0)
  const output = new Uint8Array(total)
  const view = new DataView(output.buffer)
  view.setUint16(0, 0, true)
  view.setUint16(2, 1, true)
  view.setUint16(4, payloads.length, true)
  let offset = header
  payloads.forEach((entry, index) => {
    const base = 6 + index * 16
    output[base] = entry.size === 256 ? 0 : entry.size
    output[base + 1] = entry.size === 256 ? 0 : entry.size
    view.setUint16(base + 4, 1, true)
    view.setUint16(base + 6, 32, true)
    view.setUint32(base + 8, entry.bytes.byteLength, true)
    view.setUint32(base + 12, offset, true)
    output.set(entry.bytes, offset)
    offset += entry.bytes.byteLength
  })
  return new Blob([output], { type: 'image/x-icon' })
}

function slug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'icon'
}

function uniqueSlugs(names: readonly string[]): string[] {
  const used = new Set<string>()
  return names.map((name) => {
    const base = slug(name)
    let candidate = base
    let index = 2
    while (used.has(candidate)) candidate = `${base}-${index++}`
    used.add(candidate)
    return candidate
  })
}

function innerSvg(svg: string): string {
  const start = svg.search(/<svg\b[^>]*>/i)
  if (start < 0) return svg
  const openEnd = svg.indexOf('>', start) + 1
  const close = svg.lastIndexOf('</svg>')
  return close > openEnd ? svg.slice(openEnd, close) : svg.slice(openEnd)
}

function svgViewBox(svg: string): string {
  return /viewBox\s*=\s*["']([^"']+)["']/i.exec(svg)?.[1] ?? '0 0 24 24'
}

export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function buildSvgSprite(loaded: readonly LoadedAsset[]): Promise<{ files: Record<string, Blob>; setHash: string }> {
  const slugs = uniqueSlugs(loaded.map((entry) => entry.asset.name))
  const symbols = loaded.map((entry, index) => `<symbol id="${slugs[index]}" viewBox="${svgViewBox(entry.svg ?? '')}">${innerSvg(entry.svg ?? '')}</symbol>`)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${symbols.join('')}</svg>`
  const json = { version: 1, sprite: 'sprite', icons: slugs.map((id) => ({ id, name: id, x: 0, y: 0, width: 0, height: 0 })) }
  const setHash = await sha256Text(JSON.stringify({ kind: 'sprite_svg', assets: loaded.map((entry) => entry.asset.sha256).sort() }))
  return {
    setHash,
    files: {
      sprite: new Blob([svg], { type: 'image/svg+xml' }),
      index: new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }),
    },
  }
}

export async function buildPngSprite(
  loaded: readonly LoadedAsset[],
  padding: number,
  scales: readonly number[],
  scss: boolean,
): Promise<{ files: Record<string, Blob>; setHash: string }> {
  const slugs = uniqueSlugs(loaded.map((entry) => entry.asset.name))
  const scale = scales.includes(2) ? 2 : 1
  const iconSize = ICON_SPRITE_CELL * scale
  const cell = iconSize + padding * 2 * scale
  const columns = Math.max(1, Math.ceil(Math.sqrt(loaded.length)))
  const rows = Math.ceil(loaded.length / columns)
  const width = columns * cell
  const height = rows * cell
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height })
  const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!context) throw new Error('Canvas is not available')
  const icons: { name: string; id: string; x: number; y: number; width: number; height: number }[] = []
  for (let index = 0; index < loaded.length; index += 1) {
    const blob = await renderPng(loaded[index]!, iconSize)
    const bitmap = await createImageBitmap(blob)
    const x = (index % columns) * cell + padding * scale
    const y = Math.floor(index / columns) * cell + padding * scale
    context.drawImage(bitmap, x, y, iconSize, iconSize)
    bitmap.close?.()
    icons.push({ name: slugs[index]!, id: slugs[index]!, x, y, width: iconSize, height: iconSize })
  }
  const png = canvas instanceof OffscreenCanvas
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png'))
  const json = { version: 1, sprite: 'sprite', cell, padding, columns, rows, width, height, icons }
  const css = `.icon-sprite{display:inline-block;width:${cell}px;height:${cell}px;background-image:url('sprite.png');background-repeat:no-repeat}\n${icons.map((icon) => `.icon-${icon.id}{background-position:-${icon.x}px -${icon.y}px}`).join('\n')}`
  const files: Record<string, Blob> = {
    sprite: png,
    index: new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }),
    css: new Blob([css], { type: 'text/css' }),
  }
  if (scss) files.scss = new Blob([css], { type: 'text/x-scss' })
  if (scales.includes(2)) {
    const high = await buildSheet(loaded, padding, 2)
    files.sprite2x = high
  }
  const setHash = await sha256Text(JSON.stringify({ kind: 'sprite_png', padding, scales: [...scales].sort(), assets: loaded.map((entry) => entry.asset.sha256).sort() }))
  return { files, setHash }
}

async function buildSheet(loaded: readonly LoadedAsset[], padding: number, scale: number): Promise<Blob> {
  const iconSize = ICON_SPRITE_CELL * scale
  const cell = iconSize + padding * 2 * scale
  const columns = Math.max(1, Math.ceil(Math.sqrt(loaded.length)))
  const rows = Math.ceil(loaded.length / columns)
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(columns * cell, rows * cell) : Object.assign(document.createElement('canvas'), { width: columns * cell, height: rows * cell })
  const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!context) throw new Error('Canvas is not available')
  for (let index = 0; index < loaded.length; index += 1) {
    const bitmap = await createImageBitmap(await renderPng(loaded[index]!, iconSize))
    context.drawImage(bitmap, (index % columns) * cell + padding * scale, Math.floor(index / columns) * cell + padding * scale, iconSize, iconSize)
    bitmap.close?.()
  }
  return canvas instanceof OffscreenCanvas
    ? canvas.convertToBlob({ type: 'image/png' })
    : new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png'))
}

export interface BrowserConversionProgress {
  done: number
  total: number
  lastMs?: number
}

const CONCURRENCY = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2))

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('The conversion was canceled', 'AbortError')
}

async function mapLimit<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      aborted(signal)
      const index = cursor
      cursor += 1
      await worker(items[index]!)
    }
  })
  await Promise.all(runners)
  aborted(signal)
}

export async function runBrowserConversion(
  job: IconJob,
  assets: readonly IconAssetSummary[],
  onProgress?: (progress: BrowserConversionProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  let done = 0
  const step = (startedAt: number): void => {
    done += 1
    onProgress?.({ done, total: assets.length, lastMs: performance.now() - startedAt })
  }

  if (job.options.kind === 'png') {
    const options = job.options
    await mapLimit(assets, CONCURRENCY, async (asset) => {
      const startedAt = performance.now()
      const loaded = await loadAsset(asset)
      const blobs = await Promise.all(options.sizes.map((size) => renderPng(loaded, size)))
      await uploadJobItemOutputs(job.id, asset.id, 'png', options.sizes, blobs)
      step(startedAt)
    }, signal)
    return
  }
  if (job.options.kind === 'ico') {
    const options = job.options
    await mapLimit(assets, CONCURRENCY, async (asset) => {
      const startedAt = performance.now()
      const loaded = await loadAsset(asset)
      const sizes = options.sizes
      const pngs = await Promise.all(sizes.map(async (size) => ({ size, blob: await renderPng(loaded, size) })))
      await uploadJobItemOutputs(job.id, asset.id, 'ico', sizes, [await buildIco(pngs)])
      step(startedAt)
    }, signal)
    return
  }
  const loaded = await Promise.all(assets.map(loadAsset))
  aborted(signal)
  if (job.options.kind === 'sprite_svg') {
    const sprite = await buildSvgSprite(loaded)
    aborted(signal)
    await uploadJobSprite(job.id, sprite.setHash, sprite.files)
    onProgress?.({ done: assets.length, total: assets.length })
    return
  }
  const sprite = await buildPngSprite(loaded, job.options.padding, job.options.scales, job.options.scss)
  aborted(signal)
  await uploadJobSprite(job.id, sprite.setHash, sprite.files)
  onProgress?.({ done: assets.length, total: assets.length })
}

export { icoToken }
