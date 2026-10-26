/**
 * AI Color Palette and Poetic Interpretation Engine.
 * Reuses Chat App's `AssistantStore` and `runOneShot` for zero extra dependencies.
 */

import { generateAlgorithmicPalettes } from '@shared/tools/color/colorspace-algorithms'
import { normalizeHex } from '@shared/tools/color/spaces'
import type { AiPaletteRequest, AiPaletteResult } from '@shared/tools/color/types'
import { runOneShot } from '../../assistant/one-shot'
import { AssistantStore } from '../../assistant/store'
import type { Env } from '../../env'

const AI_COLOR_DEADLINE_MS = 25000

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
  const style = request.style || '现代'
  const tone = request.tone || 'all'
  const userPrompt = request.prompt || ''

  try {
    const assistant = new AssistantStore(env.DB, userId, env)
    const settings = await assistant.getSettings()

    const system = `你是一位世界顶尖的色彩美学专家与调色大师。
请根据用户的种子色、风格、色系与描述，设计一套和谐、专业、富有设计美感的 ${count} 色调色板。
请以严格的 JSON 格式输出，不要包含 markdown 代码块包裹，结构如下：
{
  "title": "方案名称（诗意且富有现代设计感）",
  "description": "设计构思与调和意境解析（50-100字）",
  "colors": [
    {
      "hex": "#xxxxxx (6位小写十六进制)",
      "name": "该颜色的优雅艺术名称（如远山青、晚霞绯、暮云灰）",
      "description": "色彩角色（如主色、强调色、背景色）"
    }
  ],
  "tags": ["风格标签1", "标签2", "标签3"]
}`

    const user = `设计要求：
- 种子主色：${seed}
- 风格偏好：${style}
- 色调走向：${tone === 'all' ? '平衡' : tone === 'warm' ? '暖色调' : tone === 'cool' ? '冷色调' : '中性色调'}
- 配色数量：${count} 个颜色
${userPrompt ? `- 场景创意描述：${userPrompt}` : ''}`

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
        title: parsed.title || `${style}色彩灵感`,
        description: parsed.description || '由 AI 调色专家定制的和谐配色方案',
        colors: parsed.colors.map((c, i) => ({
          hex: normalizeHex(c.hex, true),
          name: c.name || `色彩 ${i + 1}`,
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
    title: `${style} · 和弦调和灵感`,
    description: `基于专业色彩空间算法为种子色 ${seed} 计算的平衡和弦调色方案，具备出色的感知过渡与明暗对比。`,
    colors: fallbackColors.map((hex, i) => ({
      hex,
      name: `色彩 ${i + 1}`,
      description: i === 0 ? '主基调' : i === 1 ? '视觉焦点' : '平衡过渡',
    })),
    tags: [style, '算法调和', tone],
  }
}

export interface PoeticColorInterpretation {
  hex: string
  name: string
  story: string
}

/**
 * Generates poetic Chinese aesthetic interpretations for extracted image colors
 */
export async function interpretAiPoeticColors(
  env: Env,
  userId: string,
  colors: string[],
  theme = '画面意境',
): Promise<PoeticColorInterpretation[]> {
  const normColors = colors.map((c) => normalizeHex(c, true))

  try {
    const assistant = new AssistantStore(env.DB, userId, env)
    const settings = await assistant.getSettings()

    const system = `你是一位精通中国传统文化、二十四节气与东方美学的色彩诗人。
请对给出的色彩 HEX 列表，结合画面意境赋予每一个颜色富有东方诗意美学的名字与一句话意境解说。
以严格的 JSON 数组输出：
[
  {
    "hex": "#xxxxxx",
    "name": "诗意中文色彩名（2-4字，如海天霞、晴山蓝、晚波绿）",
    "story": "一句话意境描述（如：落日沉入苍波时的水色微澜）"
  }
]`

    const user = `主题：${theme}
需要赋名的颜色列表：${normColors.join(', ')}`

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
        name: item.name || `东方色 ${idx + 1}`,
        story: item.story || '画面提取色彩',
      }))
    }
  } catch {
    // Fallback
  }

  // Graceful offline fallback
  const fallbackNames = ['山青', '黛水', '晴岚', '霁色', '秋香', '凝脂', '暮云', '朱殷', '苍玉', '玄影']
  const fallbackStories = [
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

  return normColors.map((hex, i) => ({
    hex,
    name: fallbackNames[i % fallbackNames.length],
    story: fallbackStories[i % fallbackStories.length],
  }))
}
