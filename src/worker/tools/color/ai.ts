/**
 * AI Color Palette and Poetic Interpretation Engine.
 * Reuses Chat App's `AssistantStore` and `runOneShot` for zero extra dependencies.
 */

import { generateAlgorithmicPalettes } from '@shared/tools/color/colorspace-algorithms'
import { normalizeHex } from '@shared/tools/color/spaces'
import type {
  AiPaletteRequest,
  AiPaletteResult,
  PoeticColorInterpretation,
} from '@shared/tools/color/types'
import { runOneShot } from '../../assistant/one-shot'
import { AssistantStore } from '../../assistant/store'
import type { Env } from '../../env'

const AI_COLOR_DEADLINE_MS = 25000

export const COLOR_AI_FALLBACK_NAMES = [
  '山青', '黛水', '晴岚', '霁色', '秋香', '凝脂', '暮云', '朱殷', '苍玉', '玄影',
]

export const COLOR_AI_FALLBACK_STORIES = [
  '远岫空濛如积翠，深林独坐见清幽',
  '碧水初平两岸春，微澜轻拂带流光',
  '长空如洗天高远，片云初散日微晴',
  '雨后新晴云破处，苍茫一抹动客心',
  '满庭黄叶随风舞，浅浅秋光向晚凉',
  '素肌玉骨含香韵，淡然自有一种清',
  '半落青山斜照里，暮霞低卷雁声沉',
  '绛雪凝丹明落照，一枝初秀染红霞',
  '苍苔古木深沉处，玉润含光冷翠凝',
  '夜色如墨沉深渊，万象归宁月一痕',
]

/**
 * Generates an AI color palette scheme based on user prompt, seed color, and stylistic preferences.
 */
export async function generateAiPalette(
  env: Env,
  userId: string,
  request: AiPaletteRequest,
): Promise<AiPaletteResult> {
  const seed = normalizeHex(request.seedHex || '#627486', true)
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
        title: parsed.title || `${style} Color Inspiration`,
        description: parsed.description || 'Harmonious color palette customized by AI.',
        colors: parsed.colors.map((c, i) => ({
          hex: normalizeHex(c.hex, true),
          name: c.name || `Color ${i + 1}`,
          description: c.description || '',
        })),
        tags: Array.isArray(parsed.tags) ? parsed.tags : [style, tone],
      }
    }
  } catch {
    // Graceful offline fallback: derive high-quality palette via algorithmic engine
  }

  // Algorithmic Fallback
  const algorithmic = generateAlgorithmicPalettes(seed)
  const chosenGroup = algorithmic[Math.floor(Math.random() * algorithmic.length)]
  const fallbackColors = chosenGroup.colors.slice(0, count)

  return {
    title: `${style} Harmonic Inspiration`,
    description: `Balanced color scheme computed for seed ${seed} based on color space algorithms.`,
    colors: fallbackColors.map((hex, i) => ({
      hex,
      name: `Color ${i + 1}`,
      description: i === 0 ? 'Primary' : i === 1 ? 'Accent' : 'Transition',
    })),
    tags: [style, 'algorithmic', tone],
  }
}

export type { PoeticColorInterpretation } from '@shared/tools/color/types'

/**
 * Generates poetic Chinese aesthetic interpretations for extracted image colors
 */
export async function interpretAiPoeticColors(
  env: Env,
  userId: string,
  colors: string[],
  theme = 'Natural Harmony',
): Promise<PoeticColorInterpretation[]> {
  const normColors = colors.map((c) => normalizeHex(c, true))

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
      return parsed.map((item, idx) => ({
        hex: normColors[idx] || normalizeHex(item.hex, true),
        name: item.name || `Color ${idx + 1}`,
        story: item.story || 'Extracted color',
      }))
    }
  } catch {
    // Fallback
  }

  // Graceful offline fallback
  return normColors.map((hex, i) => ({
    hex,
    name: COLOR_AI_FALLBACK_NAMES[i % COLOR_AI_FALLBACK_NAMES.length],
    story: COLOR_AI_FALLBACK_STORIES[i % COLOR_AI_FALLBACK_STORIES.length],
  }))
}
