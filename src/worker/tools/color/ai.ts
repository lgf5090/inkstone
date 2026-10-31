/**
 * AI Color Palette and Poetic Interpretation Engine.
 * Reuses Chat App's `AssistantStore` and `runOneShot` for zero extra dependencies.
 */

import { generateAlgorithmicPalettes } from '@shared/tools/color/colorspace-algorithms'
import { DEFAULT_SEED_HEX } from '@shared/tools/color/contract'
import { TRADITIONAL_CHINESE_COLORS } from '@shared/tools/color/presets/traditional-chinese'
import { deltaE76, hexToRgb, normalizeHex } from '@shared/tools/color/spaces'
import type {
  AiPaletteRequest,
  AiPaletteResult,
  PoeticColorInterpretation,
  PoeticInterpretResult,
} from '@shared/tools/color/types'
import { runOneShot, OneShotError } from '../../assistant/one-shot'
import { AssistantStore } from '../../assistant/store'
import type { Env } from '../../env'
import type { AiFallbackReason } from '@shared/tools/color/contract'

const AI_COLOR_DEADLINE_MS = 25000

/**
 * Why the model did not answer, in terms the reader can act on.
 *
 * `no_model` and `quota` are settings the reader can fix; the rest are transient. Collapsing them into
 * one "AI failed" toast taught nobody which button to press, so the kind survives the fallback.
 */
function fallbackReason(error: unknown): AiFallbackReason {
  if (error instanceof OneShotError) return error.kind
  return 'upstream'
}

/**
 * Fills a palette request from the algorithmic engine.
 *
 * One algorithmic group holds at most six colors, so a reader who asked for eight used to be handed four
 * with no comment. The groups overlap heavily, hence the de-duplication, and the random start keeps repeat
 * requests from returning the same list every time.
 */
function algorithmicFallback(seed: string, count: number): string[] {
  const groups = generateAlgorithmicPalettes(seed)
  const start = Math.floor(Math.random() * groups.length)
  const picked: string[] = []
  const seen = new Set<string>()

  for (let offset = 0; offset < groups.length && picked.length < count; offset++) {
    for (const raw of groups[(start + offset) % groups.length].colors) {
      const hex = normalizeHex(raw, true)
      if (seen.has(hex)) continue
      seen.add(hex)
      picked.push(hex)
      if (picked.length >= count) break
    }
  }

  return picked
}

/**
 * Clips a model's text to the width the columns and the palette schema allow.
 *
 * The model answers whatever it likes; these strings are stored and later rendered, so an unbounded reply
 * would be a 200 KB "color name" in the reader's palette list.
 */
function clip(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/**
 * Generates an AI color palette scheme based on user prompt, seed color, and stylistic preferences.
 */
export async function generateAiPalette(
  env: Env,
  userId: string,
  request: AiPaletteRequest,
): Promise<AiPaletteResult> {
  const seed = normalizeHex(request.seedHex || DEFAULT_SEED_HEX, true)
  const count = Math.min(8, Math.max(3, request.count || 5))
  const style = request.style || 'modern'
  const tone = request.tone || 'all'
  const userPrompt = request.prompt || ''

  try {
    const assistant = new AssistantStore(env.DB, userId, env)
    const settings = await assistant.getSettings()

    const system = `You are a world-class color designer and aesthetics expert.
Design a harmonious, professional, beautifully balanced palette of ${count} colors based on the user's seed color, style, tone, and description.
Provide poetic or creative color names (if prompt is in Chinese, use authentic Chinese aesthetic names; if English, use English names).
Output strictly valid JSON with no markdown wrapping:
{
  "title": "Palette title",
  "description": "Design concept and harmony rationale (50-100 words)",
  "colors": [
    {
      "hex": "#xxxxxx (lowercase 6-digit hex)",
      "name": "Artistic color name",
      "description": "Color role (e.g. primary, accent, background)"
    }
  ],
  "tags": ["tag1", "tag2", "tag3"]
}`

    const user = `Design requirements:
- Seed color: ${seed}
- Style: ${style}
- Tone: ${tone}
- Color count: ${count}
${userPrompt ? `- Description: ${userPrompt}` : ''}`

    const result = await runOneShot(assistant, settings, {
      system,
      user,
      maxOutputTokens: 2048,
      temperature: 0.7,
      timeoutMs: AI_COLOR_DEADLINE_MS,
      structured: true,
    })

    const cleanJson = result.text.trim().replace(/^```json/i, '').replace(/```$/i, '').trim()
    const parsed = JSON.parse(cleanJson) as AiPaletteResult

    if (parsed && Array.isArray(parsed.colors) && parsed.colors.length > 0) {
      return {
        title: clip(parsed.title, 100) || `${style} Color Inspiration`,
        description: clip(parsed.description, 1000) || 'Harmonious color palette customized by AI.',
        colors: parsed.colors.slice(0, count).map((c, i) => ({
          hex: normalizeHex(typeof c.hex === 'string' ? c.hex : '', true),
          name: clip(c.name, 100) || `Color ${i + 1}`,
          description: clip(c.description, 200),
        })),
        tags: (Array.isArray(parsed.tags) ? parsed.tags : [style, tone])
          .slice(0, 8)
          .map((tag) => clip(tag, 50))
          .filter(Boolean),
        degraded: false,
      }
    }
    // The model answered with something unusable: still an algorithmic palette, still worth reporting.
    return degradedPalette(seed, count, style, tone, 'malformed')
  } catch (error: unknown) {
    return degradedPalette(seed, count, style, tone, fallbackReason(error))
  }
}

function degradedPalette(
  seed: string,
  count: number,
  style: string,
  tone: string,
  reason: AiFallbackReason,
): AiPaletteResult {
  const fallbackColors = algorithmicFallback(seed, count)
  return {
    title: `${style} Harmonic Inspiration`,
    description: `Balanced color scheme computed for seed ${seed} based on color space algorithms.`,
    colors: fallbackColors.map((hex, i) => ({
      hex,
      name: `Color ${i + 1}`,
      description: i === 0 ? 'Primary' : i === 1 ? 'Accent' : 'Transition',
    })),
    tags: [style, 'algorithmic', tone],
    degraded: true,
    reason,
  }
}

export type { PoeticColorInterpretation } from '@shared/tools/color/types'

/**
 * Names a color after the closest entry in the traditional palette.
 *
 * The offline fallback used to hand back the same ten poetic names in rotation, so a reader who named two
 * different photos got the same lyric couplet on a red and on a grey, and nothing about the answer was
 * about the color. Naming by nearest catalogued color is not a model's answer, but it is an answer about
 * the color, and it is reproducible.
 */
function nearestTraditionalColor(hex: string): PoeticColorInterpretation {
  const rgb = hexToRgb(hex)
  let best = TRADITIONAL_CHINESE_COLORS[0]
  let bestDelta = Number.POSITIVE_INFINITY
  for (const item of TRADITIONAL_CHINESE_COLORS) {
    const delta = deltaE76(rgb, hexToRgb(item.hex))
    if (delta < bestDelta) {
      bestDelta = delta
      best = item
    }
  }
  const provenance = [best.solarTerm, best.series, best.pinyin].filter(Boolean).join(' · ')
  return {
    hex,
    name: best.name,
    story: provenance,
  }
}

/**
 * Generates poetic Chinese aesthetic interpretations for extracted image colors
 */
export async function interpretAiPoeticColors(
  env: Env,
  userId: string,
  colors: string[],
  theme = 'Natural Harmony',
): Promise<PoeticInterpretResult> {
  const normColors = colors.map((c) => normalizeHex(c, true))
  const fallback = (reason: AiFallbackReason): PoeticInterpretResult => ({
    items: normColors.map(nearestTraditionalColor),
    degraded: true,
    reason,
  })

  try {
    const assistant = new AssistantStore(env.DB, userId, env)
    const settings = await assistant.getSettings()

    const system = `You are a poetic colorist expert in Chinese traditional culture and oriental color aesthetics.
For the given list of color hexes, provide an authentic poetic Chinese aesthetic name (2-4 Chinese characters) and a one-sentence imagery story in Chinese for each color.
Output strictly a JSON array:
[
  {
    "hex": "#xxxxxx",
    "name": "Chinese poetic name",
    "story": "Chinese poetic story sentence"
  }
]`

    const user = `Theme: ${theme}
Colors: ${normColors.join(', ')}`

    const result = await runOneShot(assistant, settings, {
      system,
      user,
      maxOutputTokens: 2048,
      temperature: 0.6,
      timeoutMs: AI_COLOR_DEADLINE_MS,
      structured: true,
    })

    const cleanJson = result.text.trim().replace(/^```json/i, '').replace(/```$/i, '').trim()
    const parsed = JSON.parse(cleanJson) as PoeticColorInterpretation[]

    if (Array.isArray(parsed) && parsed.length > 0) {
      return {
        items: parsed.slice(0, normColors.length).map((item, idx) => ({
          hex: normColors[idx] || normalizeHex(typeof item.hex === 'string' ? item.hex : '', true),
          name: clip(item.name, 100) || `Color ${idx + 1}`,
          story: clip(item.story, 300) || 'Extracted color',
        })),
        degraded: false,
      }
    }
    return fallback('malformed')
  } catch (error: unknown) {
    return fallback(fallbackReason(error))
  }
}
