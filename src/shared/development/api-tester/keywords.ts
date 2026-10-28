export const VARIABLE_TRIGGERS = ['{{', '[[', '\u3010\u3010', '\u300c\u300c'] as const

export const VARIABLE_CLOSERS = ['}}', ']]', '\u3011\u3011', '\u300d\u300d'] as const

export const DYNAMIC_VARIABLES = ['$guid', '$timestamp', '$randomInt', '$randomFloat'] as const

export const TAG_COLOR_NAMES = [
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'zinc',
  'neutral',
  'stone',
  'mauve',
  'olive',
  'mist',
  'taupe',
  'amber',
  'blue',
  'cyan',
  'emerald',
  'fuchsia',
  'green',
  'indigo',
  'lime',
  'orange',
  'pink',
  'purple',
  'red',
  'rose',
  'sky',
  'teal',
  'violet',
  'yellow',
] as const

export const DEFAULT_TAG_COLOR = 'blue'

export const WORKSPACE_COLORS = ['blue', 'emerald', 'amber', 'red', 'purple', 'cyan'] as const

export const DEFAULT_WORKSPACE_COLOR = 'blue'

export const MOCK_LANGUAGES = ['zh', 'en'] as const
export type MockLanguage = (typeof MOCK_LANGUAGES)[number]
