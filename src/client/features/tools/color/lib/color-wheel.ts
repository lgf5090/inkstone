import { hslToRgb } from '@shared/tools/color/spaces'

/**
 * The color wheel's pixel field and its blit, kept apart from the component.
 *
 * The disk used to be written with `putImageData` after `ctx.scale(dpr, dpr)`, on the assumption that the
 * scale would enlarge it. `putImageData` copies device pixels and ignores the context transform, so on any
 * display that is not exactly 1× the wheel landed in the top-left corner at 1/dpr of its box while the
 * pointer math kept answering for the full CSS size. Splitting the field (pure) from the blit (canvas) is
 * what lets the geometry be tested at all: jsdom has no 2D context.
 */

/** Opaque inside the disk, transparent outside, anti-aliased across the boundary. */
const EDGE_FEATHER_PX = 1

/** Radius inset that keeps the disk off the canvas edge, so the border never clips a color. */
const EDGE_INSET_PX = 2

export function buildWheelPixels(size: number, lightness: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4)
  const cx = size / 2
  const cy = size / 2
  const radius = size / 2 - EDGE_INSET_PX

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const dy = y - cy
      const dist = Math.hypot(dx, dy)
      const pixel = (y * size + x) * 4

      if (dist > radius) continue

      let angle = Math.atan2(dy, dx) * (180 / Math.PI)
      if (angle < 0) angle += 360
      const sat = Math.min(100, (dist / radius) * 100)
      const rgb = hslToRgb({ h: angle, s: sat, l: lightness })

      data[pixel] = rgb.r
      data[pixel + 1] = rgb.g
      data[pixel + 2] = rgb.b
      data[pixel + 3] = Math.round(Math.min(1, Math.max(0, radius - dist + EDGE_FEATHER_PX)) * 255)
    }
  }

  return data
}

/**
 * Sizes the blit.
 *
 * The backing store carries the device pixels; the drawing itself stays in CSS units under a `dpr` scale,
 * which is the only way the disk ends up filling the box the pointer math already assumes.
 */
export function wheelBlitPlan(cssSize: number, dpr: number): { backing: number; drawSize: number } {
  return { backing: Math.max(1, Math.round(cssSize * dpr)), drawSize: cssSize }
}

/**
 * Paints the wheel into `canvas` at the device's own resolution.
 *
 * The field is computed at CSS size and then scaled up by `drawImage`, which is the one canvas call that
 * honours the transform. Computing it at device size instead would quadruple a per-pixel HSL conversion on
 * every lightness change, and a hue field has no detail for the extra samples to resolve.
 */
export function drawWheel(canvas: HTMLCanvasElement, size: number, lightness: number): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const { backing } = wheelBlitPlan(size, dpr)
  canvas.width = backing
  canvas.height = backing
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const field = document.createElement('canvas')
  field.width = size
  field.height = size
  const fieldCtx = field.getContext('2d')
  if (!fieldCtx) return

  const image = fieldCtx.createImageData(size, size)
  image.data.set(buildWheelPixels(size, lightness))
  fieldCtx.putImageData(image, 0, 0)

  ctx.clearRect(0, 0, size, size)
  ctx.drawImage(field, 0, 0, size, size)
}
