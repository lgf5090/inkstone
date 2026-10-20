/**
 * The icon vocabulary: what may be stored, and which mark a row gets when it has not chosen one.
 *
 * The parser is the boundary between a row and a renderer, so the cases that matter are the ones that
 * must not become markup: an unknown brand, a Lucide name this build does not ship, an oversized upload,
 * and a URL that is not an image at all. The inference cases pin the ordering — a gateway's model id still
 * wears the model family, and gemma is not swallowed by gemini.
 */
import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS } from '../src/shared/assistant'
import {
  ASSISTANT_BRANDS,
  MAX_ASSISTANT_ICON_CHARS,
  iconForModel,
  iconForProvider,
  parseAssistantIcon,
} from '../src/shared/assistant-icons'

describe('stored icons', () => {
  it('keeps a known brand and drops one this build does not ship', () => {
    expect(parseAssistantIcon('brand:deepseek')).toBe('brand:deepseek')
    expect(parseAssistantIcon('deepseek')).toBe('brand:deepseek')
    expect(parseAssistantIcon('brand:not-a-vendor')).toBe('')
  })

  it('keeps an emoji and a lucide name, and refuses an unknown glyph', () => {
    expect(parseAssistantIcon('emoji:🐋')).toBe('emoji:🐋')
    expect(parseAssistantIcon('lucide:Bot')).toBe('lucide:Bot')
    expect(parseAssistantIcon('lucide:NotARealIcon')).toBe('')
    expect(parseAssistantIcon('emoji:\n')).toBe('')
  })

  it('accepts only small raster data URLs', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    expect(parseAssistantIcon(png)).toBe(png)
    expect(parseAssistantIcon('data:image/svg+xml;base64,PHN2Zz4=')).toBe('')
    expect(parseAssistantIcon('https://example.com/icon.png')).toBe('')
    expect(parseAssistantIcon(`data:image/png;base64,${'A'.repeat(MAX_ASSISTANT_ICON_CHARS)}`)).toBe('')
  })

  it('gives every built-in preset a brand the picker can draw', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (!preset.icon) continue
      expect(parseAssistantIcon(preset.icon), preset.id).toBe(preset.icon)
      expect(preset.icon.startsWith('brand:'), preset.id).toBe(true)
    }
    expect(new Set(ASSISTANT_BRANDS.map((brand) => brand.key)).size).toBe(ASSISTANT_BRANDS.length)
  })
})

describe('inferred marks', () => {
  it('reads a provider brand from its stored choice, label or address', () => {
    expect(iconForProvider({ icon: 'emoji:🦊', label: 'Anything', baseUrl: 'https://example.com' })).toBe('emoji:🦊')
    expect(iconForProvider({ icon: '', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' })).toBe('brand:deepseek')
    expect(iconForProvider({ icon: '', label: 'My gateway', baseUrl: 'https://api.x.ai/v1' })).toBe('brand:xai')
    expect(iconForProvider({ icon: '', label: 'Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })).toBe('brand:qwen')
    expect(iconForProvider({ icon: '', label: 'Azure OpenAI', baseUrl: 'https://mine.openai.azure.com' })).toBe('brand:azure')
    expect(iconForProvider({ icon: '', label: 'Something else', baseUrl: 'https://api.example.com' })).toBe('')
  })

  it('lets the model family beat the gateway that serves it', () => {
    const openrouter = { icon: '', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' }
    expect(iconForModel({ icon: '', model: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' }, openrouter)).toBe('brand:deepseek')
    expect(iconForModel({ icon: '', model: 'zai-org/GLM-5.3', label: 'GLM' }, openrouter)).toBe('brand:zhipu')
    expect(iconForModel({ icon: '', model: 'kimi-k2', label: 'Kimi K2' }, openrouter)).toBe('brand:kimi')
    expect(iconForModel({ icon: '', model: 'gemma-4-31b', label: 'Gemma 4' }, { icon: '', label: 'Google', baseUrl: 'https://generativelanguage.googleapis.com' }))
      .toBe('brand:gemma')
  })

  it('falls back to the provider, and then to no mark at all', () => {
    const provider = { icon: '', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' }
    expect(iconForModel({ icon: '', model: 'custom-model', label: 'Custom' }, provider)).toBe('brand:deepseek')
    expect(iconForModel({ icon: 'lucide:Cpu', model: 'custom-model', label: 'Custom' }, provider)).toBe('lucide:Cpu')
    expect(iconForModel({ icon: '', model: 'custom-model', label: 'Custom' }, null)).toBe('')
  })
})
