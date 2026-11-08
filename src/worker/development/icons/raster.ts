import { initWasm, Resvg } from '@resvg/resvg-wasm'
import wasm from '@resvg/resvg-wasm/index_bg.wasm'
import type { Env } from '../../env'

/**
 * Rasterization for conversion jobs.
 *
 * `resvg` is compiled at deploy time and initialized once per isolate. Raster sources already carry
 * pixels, so they go through the Images binding instead; when that binding is absent the original
 * bytes are only usable at their own size, which is the same "do not upscale" rule the UI states.
 */

let ready: Promise<void> | null = null

async function ensureWasm(): Promise<void> {
  if (!ready) ready = initWasm(wasm)
  await ready
}

export interface RasterResult {
  png: Uint8Array
  width: number
  height: number
}

export async function rasterizeSvg(svg: string, width: number): Promise<RasterResult> {
  await ensureWasm()
  const renderer = new Resvg(svg, {
    fitTo: { mode: 'width', value: Math.max(1, Math.round(width)) },
    background: 'rgba(0,0,0,0)',
  })
  const image = renderer.render()
  return { png: image.asPng(), width: image.width, height: image.height }
}

export async function rasterizeSvgPixels(svg: string, width: number): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  await ensureWasm()
  const renderer = new Resvg(svg, {
    fitTo: { mode: 'width', value: Math.max(1, Math.round(width)) },
    background: 'rgba(0,0,0,0)',
  })
  const image = renderer.render()
  return { rgba: image.pixels, width: image.width, height: image.height }
}

interface ImagesBindingLike {
  input(body: ReadableStream | ArrayBuffer | Uint8Array): {
    transform(options: Record<string, unknown>): {
      output(options: Record<string, unknown>): Promise<{ response(): Response }>
    }
  }
}

async function throughImages(env: Env, body: BodyInit, width: number, format: 'image/png' | 'image/webp'): Promise<Uint8Array | null> {
  if (!env.IMAGES) return null
  try {
    const images = env.IMAGES as unknown as ImagesBindingLike
    const stream = body instanceof ReadableStream ? body : new Response(body).body
    if (!stream) return null
    const output = await images.input(stream).transform({ width }).output({ format })
    return new Uint8Array(await output.response().arrayBuffer())
  } catch (error) {
    console.warn('[inkstone] icon image transform failed:', error)
    return null
  }
}

/**
 * Produce a PNG at `width` from an uploaded raster.
 *
 * `sourceWidth` lets the caller apply the "never upscale" rule without decoding the raster twice.
 */
export async function rasterRasterToPng(
  env: Env,
  bytes: Uint8Array,
  mime: string,
  width: number,
  sourceWidth: number,
): Promise<RasterResult | null> {
  const target = Math.max(1, Math.min(width, sourceWidth))
  if (mime === 'image/png' && target === sourceWidth) {
    return { png: bytes, width: sourceWidth, height: sourceWidth }
  }
  const output = await throughImages(env, bytes, target, 'image/png')
  if (!output) return null
  return { png: output, width: target, height: target }
}

export async function webpThumbnail(env: Env, bytes: Uint8Array, mime: string, width: number): Promise<Uint8Array | null> {
  if (mime === 'image/svg+xml') {
    const raster = await rasterizeSvg(new TextDecoder().decode(bytes), Math.max(width, 192))
    return throughImages(env, raster.png, width, 'image/webp')
  }
  return throughImages(env, bytes, width, 'image/webp')
}
