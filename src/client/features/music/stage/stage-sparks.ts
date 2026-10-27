// The optional spark overlay.
//
// Sparks are a decoration for the six hundred milliseconds after a word begins, and nothing else.
// The canvas is created only when the setting is on, and the stage's single animation frame clears it
// as soon as the last burst ages out; there is no second loop for this file.
import { STAGE_SPARK_WINDOW_MS, lineRandom } from './stage-math'

const PARTICLES_PER_WORD = 8
const MIN_DISTANCE = 16
const MAX_DISTANCE = 58
const STREAK_LENGTH = 7
const MAX_DEVICE_PIXEL_RATIO = 2

export interface SparkOrigin {
  x: number
  y: number
}

export interface SparkParticle {
  dx: number
  dy: number
  alpha: number
}

/**
 * The particles of one word's burst, in canvas pixels.
 *
 * Positions are a pure function of the seed and elapsed time, so a frame can be drawn twice without
 * the sparks jumping. `elapsedMs` is clamped to the window, which is what makes the last frame fade
 * rather than pop.
 */
export function sparkParticles(
  seed: number,
  elapsedMs: number,
  windowMs = STAGE_SPARK_WINDOW_MS,
): SparkParticle[] {
  const progress = Math.max(0, Math.min(1, elapsedMs / Math.max(1, windowMs)))
  const eased = 1 - (1 - progress) ** 2
  const random = lineRandom(`spark:${seed}`)
  return Array.from({ length: PARTICLES_PER_WORD }, () => {
    const angle = random() * Math.PI * 2
    const distance = (MIN_DISTANCE + random() * (MAX_DISTANCE - MIN_DISTANCE)) * eased
    return {
      dx: Math.cos(angle) * distance,
      dy: Math.sin(angle) * distance,
      alpha: 1 - progress,
    }
  })
}

function sparkColor(canvas: HTMLCanvasElement): string {
  if (typeof window === 'undefined') return 'rgba(255, 255, 255, 0.85)'
  const accent = window.getComputedStyle(canvas).getPropertyValue('--music-accent').trim()
  // The token always resolves in the app; the literal is the same neutral used before the first
  // paint, where a canvas cannot inherit text colour.
  return accent || 'rgba(255, 255, 255, 0.85)'
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const ratio = Math.min(MAX_DEVICE_PIXEL_RATIO, window.devicePixelRatio || 1)
  const width = Math.round(canvas.clientWidth * ratio)
  const height = Math.round(canvas.clientHeight * ratio)
  if (width <= 0 || height <= 0) return null
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  return ctx
}

/** Draw the bursts that are still inside their window, replacing whatever the last frame left. */
export function drawStageSparks(
  canvas: HTMLCanvasElement,
  bursts: readonly { index: number, elapsedMs: number, seed: number }[],
  origins: readonly SparkOrigin[],
): void {
  const ctx = context(canvas)
  if (!ctx) return
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  ctx.clearRect(0, 0, width, height)
  if (!bursts.length) return
  ctx.strokeStyle = sparkColor(canvas)
  ctx.lineWidth = 1.4
  ctx.lineCap = 'round'
  const fallback = { x: width / 2, y: height / 2 }
  for (const burst of bursts) {
    const origin = origins.length ? origins[burst.index % origins.length]! : fallback
    for (const particle of sparkParticles(burst.seed, burst.elapsedMs)) {
      const length = Math.hypot(particle.dx, particle.dy) || 1
      const tailX = origin.x + particle.dx
      const tailY = origin.y + particle.dy
      ctx.globalAlpha = Math.max(0, particle.alpha)
      ctx.beginPath()
      ctx.moveTo(tailX, tailY)
      ctx.lineTo(
        tailX + (particle.dx / length) * STREAK_LENGTH,
        tailY + (particle.dy / length) * STREAK_LENGTH,
      )
      ctx.stroke()
    }
  }
  ctx.globalAlpha = 1
}

/** Remove the last frame's sparks without resizing the backing store. */
export function clearStageSparks(canvas: HTMLCanvasElement): void {
  const width = canvas.width
  const height = canvas.height
  if (width <= 0 || height <= 0) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width, height)
}
