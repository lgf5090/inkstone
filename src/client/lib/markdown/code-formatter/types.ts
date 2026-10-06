export type FormatterCategory =
  | 'c-style'
  | 'html'
  | 'xml'
  | 'css'
  | 'sql'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'python'
  | 'shell'
  | 'ruby'
  | 'lua'
  | 'dockerfile'
  | 'nginx'
  | 'mermaid'
  | 'chart'
  | 'mindmap'
  | 'excalidraw'
  | 'kanban'
  | 'slides'
  | 'diff'
  | 'markdown'
  | 'table'
  | 'generic'

const CATEGORY_MAP: Record<string, FormatterCategory> = {
  javascript: 'c-style',
  js: 'c-style',
  mjs: 'c-style',
  cjs: 'c-style',
  typescript: 'c-style',
  ts: 'c-style',
  mts: 'c-style',
  cts: 'c-style',
  jsx: 'c-style',
  tsx: 'c-style',
  c: 'c-style',
  h: 'c-style',
  cpp: 'c-style',
  'c++': 'c-style',
  cc: 'c-style',
  cxx: 'c-style',
  hpp: 'c-style',
  hh: 'c-style',
  csharp: 'c-style',
  cs: 'c-style',
  'c#': 'c-style',
  dotnet: 'c-style',
  java: 'c-style',
  kotlin: 'c-style',
  kt: 'c-style',
  kts: 'c-style',
  swift: 'c-style',
  go: 'c-style',
  golang: 'c-style',
  rust: 'c-style',
  rs: 'c-style',
  php: 'c-style',
  dart: 'c-style',
  graphql: 'c-style',
  gql: 'c-style',
  powershell: 'c-style',
  ps1: 'c-style',
  ps: 'c-style',
  scala: 'c-style',
  solidity: 'c-style',
  sol: 'c-style',
  zig: 'c-style',
  objc: 'c-style',
  'objective-c': 'c-style',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  vue: 'html',
  svelte: 'html',
  xml: 'xml',
  svg: 'xml',
  plist: 'xml',
  rss: 'xml',
  atom: 'xml',
  css: 'css',
  scss: 'css',
  less: 'css',
  stylus: 'css',
  sql: 'sql',
  postgresql: 'sql',
  postgres: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  plsql: 'sql',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  webmanifest: 'json',
  geojson: 'json',
  topojson: 'json',
  ndjson: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'toml',
  cfg: 'toml',
  python: 'python',
  py: 'python',
  py3: 'python',
  bash: 'shell',
  sh: 'shell',
  shell: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  ruby: 'ruby',
  rb: 'ruby',
  lua: 'lua',
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
  containerfile: 'dockerfile',
  nginx: 'nginx',
  conf: 'nginx',
  mermaid: 'mermaid',
  plantuml: 'mermaid',
  chart: 'chart',
  chartjs: 'chart',
  echarts: 'chart',
  mindmap: 'mindmap',
  'mind-elixir': 'mindmap',
  excalidraw: 'excalidraw',
  kanban: 'kanban',
  'notion-kanban': 'kanban',
  board: 'kanban',
  'bento-slides': 'slides',
  slides: 'slides',
  ppt: 'slides',
  bento: 'slides',
  'bento-slide': 'slides',
  diff: 'diff',
  patch: 'diff',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'markdown',
  table: 'table',
}

export function resolveCategory(rawLang: string): FormatterCategory {
  const normalized = (rawLang || '').toLowerCase().trim()
  if (CATEGORY_MAP[normalized]) return CATEGORY_MAP[normalized]
  const base = normalized.replace(/^\./, '').split(/[\s:{[(\]]/)[0]?.trim() ?? ''
  return CATEGORY_MAP[base] ?? 'generic'
}

export function clampIndent(tabSize: number): number {
  return Number.isFinite(tabSize) ? Math.min(8, Math.max(1, Math.trunc(tabSize))) : 2
}

export function indentOf(tabSize: number): string {
  return ' '.repeat(clampIndent(tabSize))
}

/**
 * How deep a formatter will indent. Nesting depth is the one number a note can grow without bound while
 * its byte size stays small — a thousand `<div>` with nothing between them is eleven kilobytes — and an
 * indent per level makes the output grow with the square of it. Real documents stop nesting long before
 * this, so the cap is invisible on anything a person wrote and keeps one press from asking for megabytes.
 */
export const MAX_INDENT_LEVEL = 24

export function padAt(indent: string, level: number): string {
  return indent.repeat(Math.min(MAX_INDENT_LEVEL, Math.max(0, level)))
}
