/** Which contents the preview dialog can show without handing the bytes to a plugin. */

export type R2PreviewKind = 'image' | 'text' | null

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'])
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yaml', 'yml',
  'js', 'mjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'sql', 'toml', 'ini',
])

function extensionOf(key: string): string {
  const name = key.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function previewKindFor(contentType: string, key: string): R2PreviewKind {
  const type = contentType.toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('text/')) return 'text'
  if (type === 'application/json' || type.endsWith('+json') || type === 'application/xml') return 'text'
  if (type === 'application/javascript' || type === 'application/x-javascript') return 'text'
  if (IMAGE_EXTENSIONS.has(extensionOf(key))) return 'image'
  if (TEXT_EXTENSIONS.has(extensionOf(key))) return 'text'
  return null
}
