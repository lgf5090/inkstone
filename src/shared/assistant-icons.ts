/**
 * What a provider or a model wears in a list.
 *
 * Four kinds of mark share one string so a row can carry exactly one answer: a built-in brand, an emoji,
 * a Lucide name, or an uploaded image as a data URL. `brand:` and `lucide:` are closed sets — the picker
 * can only choose what this file names, and the server validates against the same list. An emoji is
 * whatever the reader picked. An upload is a small image the browser has already cropped and scaled, so
 * the server only has to check that the string is one of the three image types and short enough to be a
 * row rather than a file store.
 */
import type { AssistantModel, AssistantProvider } from './assistant'

export interface AssistantBrand {
  key: string
  label: string
  /** The colour of the mark's tile when no SVG is available, and of the picker's selection ring. */
  color: string
  /** The letters a vendor with no SVG is drawn as. */
  monogram: string
  /** Lower-case fragments that identify this brand in a provider name, address or model id. */
  aliases: readonly string[]
}

/**
 * The brands the app knows by name.
 *
 * The order is the inference order: a more specific family comes before the company that owns it, so
 * `gemma` is read before `gemini`, `hunyuan` before `tencent`, and a gateways's model id such as
 * `deepseek/deepseek-chat` still wears DeepSeek rather than the gateway's mark.
 */
export const ASSISTANT_BRANDS: readonly AssistantBrand[] = [
  { key: 'deepseek', label: 'DeepSeek', color: '#4D6BFE', monogram: 'D', aliases: ['deepseek'] },
  { key: 'qwen', label: 'Qwen', color: '#615CED', monogram: 'Q', aliases: ['qwen', 'qwq', 'qvq', 'dashscope'] },
  { key: 'zhipu', label: 'Zhipu GLM', color: '#2F5BEA', monogram: 'Z', aliases: ['zhipu', 'chatglm', 'glm', 'bigmodel'] },
  { key: 'kimi', label: 'Kimi', color: '#1F2937', monogram: 'K', aliases: ['kimi', 'moonshot'] },
  { key: 'minimax', label: 'MiniMax', color: '#F23D5C', monogram: 'M', aliases: ['minimax', 'abab'] },
  { key: 'bytedance', label: 'ByteDance / Doubao', color: '#325AB4', monogram: 'BD', aliases: ['bytedance', 'doubao', 'seed-'] },
  { key: 'baidu', label: 'Baidu / ERNIE', color: '#2932E1', monogram: 'B', aliases: ['baidu', 'ernie', 'wenxin'] },
  { key: 'stepfun', label: 'StepFun', color: '#5B6CFF', monogram: 'S', aliases: ['stepfun', 'step-1', 'step-2'] },
  { key: 'yi', label: '01.AI / Yi', color: '#0E7C66', monogram: 'Y', aliases: ['zeroone', '01.ai', 'yi-'] },
  { key: 'modelbest', label: 'ModelBest', color: '#2D6CDF', monogram: 'MB', aliases: ['modelbest', 'minicpm'] },
  { key: 'mistral', label: 'Mistral AI', color: '#FF7000', monogram: 'M', aliases: ['mistral', 'mixtral', 'codestral', 'devstral'] },
  { key: 'xai', label: 'xAI / Grok', color: '#111111', monogram: 'x', aliases: ['xai', 'x.ai', 'grok'] },
  { key: 'cohere', label: 'Cohere', color: '#39594D', monogram: 'C', aliases: ['cohere', 'command-'] },
  { key: 'gemma', label: 'Gemma', color: '#4285F4', monogram: 'G', aliases: ['gemma'] },
  { key: 'googlecloud', label: 'Google Cloud', color: '#4285F4', monogram: 'GC', aliases: ['googlecloud', 'aiplatform', 'vertex'] },
  { key: 'gemini', label: 'Google Gemini', color: '#4285F4', monogram: 'G', aliases: ['gemini', 'google'] },
  { key: 'meta', label: 'Meta / Llama', color: '#0866FF', monogram: 'M', aliases: ['meta', 'llama'] },
  { key: 'anthropic', label: 'Anthropic / Claude', color: '#D97757', monogram: 'A', aliases: ['anthropic', 'claude'] },
  { key: 'azure', label: 'Azure AI', color: '#0078D4', monogram: 'Az', aliases: ['azure', 'openai.azure.com'] },
  { key: 'openai', label: 'OpenAI', color: '#000000', monogram: 'AI', aliases: ['openai', 'chatgpt', 'gpt', 'o1-', 'o3-', 'o4-'] },
  { key: 'microsoft', label: 'Microsoft / Phi', color: '#5E5E5E', monogram: 'MS', aliases: ['microsoft', 'phi-'] },
  { key: 'nvidia', label: 'NVIDIA', color: '#76B900', monogram: 'NV', aliases: ['nvidia', 'nemotron'] },
  { key: 'hunyuan', label: 'Tencent Hunyuan', color: '#0052D9', monogram: 'H', aliases: ['hunyuan'] },
  { key: 'tencent', label: 'Tencent', color: '#0052D9', monogram: 'T', aliases: ['tencent'] },
  { key: 'baichuan', label: 'Baichuan', color: '#1F6FEB', monogram: 'B', aliases: ['baichuan'] },
  { key: 'internlm', label: 'InternLM', color: '#1E5EFF', monogram: 'IL', aliases: ['internlm'] },
  { key: 'upstage', label: 'Upstage', color: '#6E56CF', monogram: 'U', aliases: ['upstage', 'solar-'] },
  { key: 'perplexity', label: 'Perplexity', color: '#1FB8CD', monogram: 'P', aliases: ['perplexity', 'sonar', 'pplx'] },
  { key: 'huggingface', label: 'Hugging Face', color: '#FFD21E', monogram: 'HF', aliases: ['huggingface', 'hugging face'] },
  { key: 'modelscope', label: 'ModelScope', color: '#6C4CF1', monogram: 'MS', aliases: ['modelscope'] },
  { key: 'aws', label: 'AWS / Bedrock', color: '#FF9900', monogram: 'AWS', aliases: ['aws', 'bedrock', 'amazonaws'] },
  { key: 'alibaba', label: 'Alibaba Cloud', color: '#FF6A00', monogram: 'A', aliases: ['alibaba', 'aliyun'] },
  { key: 'volcengine', label: 'Volcengine', color: '#1664FF', monogram: 'V', aliases: ['volcengine', 'volces'] },
  { key: 'openrouter', label: 'OpenRouter', color: '#6467F2', monogram: 'OR', aliases: ['openrouter'] },
  { key: 'siliconflow', label: 'SiliconFlow', color: '#6E56CF', monogram: 'SF', aliases: ['siliconflow', 'siliconcloud'] },
  { key: 'together', label: 'Together AI', color: '#0F6FFF', monogram: 'T', aliases: ['together'] },
  { key: 'cerebras', label: 'Cerebras', color: '#F15A24', monogram: 'C', aliases: ['cerebras'] },
  { key: 'fireworks', label: 'Fireworks AI', color: '#FF5A1F', monogram: 'F', aliases: ['fireworks'] },
  { key: 'deepinfra', label: 'DeepInfra', color: '#4B6BFB', monogram: 'DI', aliases: ['deepinfra'] },
  { key: 'ollama', label: 'Ollama', color: '#111111', monogram: 'O', aliases: ['ollama'] },
  { key: 'groq', label: 'Groq', color: '#F55036', monogram: 'G', aliases: ['groq'] },
]

const BRAND_BY_KEY = new Map(ASSISTANT_BRANDS.map((brand) => [brand.key, brand]))

export const ASSISTANT_BRAND_KEYS: readonly string[] = ASSISTANT_BRANDS.map((brand) => brand.key)

/**
 * The Lucide names the picker offers and the server accepts.
 *
 * A closed list rather than "whatever lucide has": an icon name is stored in a row and read by a later
 * build, and a name that build no longer ships would render as a blank tile with nothing to explain it.
 */
export const ASSISTANT_LUCIDE_ICON_NAMES: readonly string[] = [
  'Bot', 'Sparkles', 'Brain', 'Cpu', 'Zap', 'Cloud', 'Rocket', 'Wand2',
  'Star', 'Circle', 'Hexagon', 'Boxes', 'Globe2', 'Search', 'Database', 'Code2',
  'Terminal', 'Shield', 'Feather', 'Flame', 'Leaf', 'Moon', 'Sun', 'Gift',
  'Gem', 'Workflow', 'Network', 'Server', 'Layers', 'Compass', 'Atom', 'Orbit',
  'Aperture', 'CircuitBoard', 'Blocks', 'Container', 'Satellite', 'Telescope', 'Microscope', 'FlaskConical',
]

/** A small, recognisable set for a model or provider that is not really about a vendor mark. */
export const ASSISTANT_ICON_EMOJIS: readonly string[] = [
  '🤖', '🧠', '✨', '🚀', '🦾', '🪄', '🔮', '🧩',
  '🛠️', '⚙️', '🧪', '🔬', '📡', '🛰️', '🌐', '💡',
  '🔥', '⚡', '🌊', '🪐', '🌙', '☀️', '🦉', '🐋',
  '🐳', '🐬', '🦊', '🐼', '🐧', '🦄', '🐙', '🦋',
  '🌱', '🍀', '🎯', '🧭', '🗺️', '📚', '📝', '🖋️',
  '🎨', '🎧', '🎤', '🔊', '🧿', '🧬', '🧮', '👾',
]

/** The most a stored icon may be: a 96 px WebP is far under this, and a whole image file is far over it. */
export const MAX_ASSISTANT_ICON_CHARS = 160_000

const LUCIDE_NAMES = new Set(ASSISTANT_LUCIDE_ICON_NAMES)
const DATA_ICON = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i

/**
 * A stored icon, or the empty string for "use the inferred default".
 *
 * The read side is forgiving: a value written by an older build, a removed brand key or a hand-edited
 * row reads as no icon rather than as a broken row. The route turns a non-empty value this function
 * cannot read into a refusal, so an edit never silently loses the reader's choice.
 */
export function parseAssistantIcon(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('data:')) {
    return trimmed.length <= MAX_ASSISTANT_ICON_CHARS && DATA_ICON.test(trimmed) ? trimmed : ''
  }
  if (trimmed.startsWith('brand:')) {
    const key = trimmed.slice(6)
    return BRAND_BY_KEY.has(key) ? `brand:${key}` : ''
  }
  if (trimmed.startsWith('emoji:')) {
    const emoji = trimmed.slice(6).trim()
    return emoji && emoji.length <= 32 && !/[\u0000-\u001f\u007f]/.test(emoji) ? `emoji:${emoji}` : ''
  }
  if (trimmed.startsWith('lucide:')) {
    const name = trimmed.slice(7)
    return LUCIDE_NAMES.has(name) ? `lucide:${name}` : ''
  }
  // A bare brand key is what earlier rows and hand-written values tend to carry; reading it is free.
  return BRAND_BY_KEY.has(trimmed) ? `brand:${trimmed}` : ''
}

export function assistantBrand(key: string): AssistantBrand | undefined {
  return BRAND_BY_KEY.get(key)
}

function inferredBrand(text: string): string {
  const lowered = text.toLowerCase()
  return ASSISTANT_BRANDS.find((brand) => brand.aliases.some((alias) => lowered.includes(alias)))?.key ?? ''
}

/**
 * The mark a provider wears: its own choice first, then the brand its name or address names.
 *
 * A custom provider called "DeepSeek" and a stored preset both land on the same mark; a gateway keeps
 * its own name because no vendor fragment matched, and the reader can still choose one by hand.
 */
export function iconForProvider(provider: Pick<AssistantProvider, 'icon' | 'label' | 'baseUrl'>): string {
  const explicit = parseAssistantIcon(provider.icon)
  if (explicit) return explicit
  const key = inferredBrand(`${provider.label} ${provider.baseUrl}`)
  return key ? `brand:${key}` : ''
}

/**
 * The mark a model wears: its own choice, then the family its id names, then its provider's mark.
 *
 * The family wins over the provider because a gateway's own logo says nothing about which model answered;
 * a model id that names no family is still identified by the provider it runs on.
 */
export function iconForModel(
  model: Pick<AssistantModel, 'icon' | 'model' | 'label'>,
  provider?: Pick<AssistantProvider, 'icon' | 'label' | 'baseUrl'> | null,
): string {
  const explicit = parseAssistantIcon(model.icon)
  if (explicit) return explicit
  const key = inferredBrand(`${model.model} ${model.label}`)
  if (key) return `brand:${key}`
  return provider ? iconForProvider(provider) : ''
}
