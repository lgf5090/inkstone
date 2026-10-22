import type { FileViewerRendererPluginInput } from '@file-viewer/core'
import type { FilePreviewTarget } from './types'

/**
 * A lazy loader for one renderer package. Each returns the package's default plugin, widened once
 * here: the packages type their handler to a narrower render target than the viewer registry's
 * default, so the plugin only fits the `renderers` option after this assertion.
 */
export type FilePreviewLoader = () => Promise<{ default: FileViewerRendererPluginInput }>

type RendererKey =
  | 'pdf'
  | 'image'
  | 'text'
  | 'spreadsheet'
  | 'word'
  | 'presentation'
  | 'media'
  | 'archive'
  | 'ofd'

/**
 * The one place that names which renderer package serves which file. Nothing here may import a
 * renderer statically: these functions are the sole entry points, so a PDF only ever pulls the PDF
 * chunk and never the spreadsheet, media or archive one.
 */
const RENDERER_LOADERS: Record<RendererKey, () => Promise<unknown>> = {
  pdf: () => import('@file-viewer/renderer-pdf'),
  image: () => import('@file-viewer/renderer-image'),
  text: () => import('@file-viewer/renderer-text'),
  spreadsheet: () => import('@file-viewer/renderer-spreadsheet'),
  word: () => import('@file-viewer/renderer-word'),
  presentation: () => import('@file-viewer/renderer-presentation'),
  media: () => import('@file-viewer/renderer-media'),
  archive: () => import('@file-viewer/renderer-archive'),
  ofd: () => import('@file-viewer/renderer-ofd'),
}

const IMAGE_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'tif', 'svg', 'ico', 'heic', 'heif', 'jxl',
]

const PDF_EXTENSIONS = ['pdf']

const TEXT_EXTENSIONS = [
  'md', 'markdown', 'txt', 'log', 'json', 'json5', 'jsonc', 'ndjson', 'js', 'mjs', 'cjs', 'jsx',
  'ts', 'tsx', 'css', 'scss', 'sass', 'less', 'styl', 'html', 'htm', 'xhtml', 'xml', 'xsl', 'xslt',
  'vue', 'svelte', 'astro', 'yaml', 'yml', 'toml', 'ini', 'conf', 'env', 'properties',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'sql', 'go', 'rs', 'java', 'kt', 'kts', 'swift',
  'rb', 'php', 'py', 'pl', 'pm', 'lua', 'scala', 'groovy', 'dart', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp',
  'hh', 'cs', 'vb', 'm', 'mm', 'proto', 'graphql', 'gql', 'prisma', 'tex', 'bib', 'diff', 'patch', 'ics',
]

const SPREADSHEET_EXTENSIONS = [
  'xlsx', 'xlsm', 'xlsb', 'xls', 'xlt', 'xla', 'xlam', 'xltm', 'xltx', 'csv', 'tsv', 'ods', 'fods', 'dbf',
]

const WORD_EXTENSIONS = ['docx', 'docm', 'dotx', 'dotm', 'doc', 'dot', 'rtf', 'odt', 'ott']

const PRESENTATION_EXTENSIONS = [
  'pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm', 'ppt', 'pot', 'odp',
]

/** Only the codecs `renderer-media` declares; mov/avi/mkv have no renderer here and stay unsupported. */
const MEDIA_EXTENSIONS = [
  'mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'weba', 'mid', 'midi',
  'mp4', 'webm', 'm4v', 'm3u8',
]

const ARCHIVE_EXTENSIONS = [
  'zip', 'zipx', '7z', 'rar', 'tar', 'gz', 'gzip', 'tgz', 'bz2', 'bzip2', 'tbz', 'tbz2', 'xz', 'txz',
  'lzma', 'zst', 'tzst', 'cab', 'ar', 'cpio', 'iso', 'xar', 'lha', 'lzh', 'jar', 'war', 'ear', 'apk', 'cbz', 'cbr',
]

function extensionMap(entries: ReadonlyArray<readonly [readonly string[], RendererKey]>): Record<string, RendererKey> {
  const map: Record<string, RendererKey> = {}
  for (const [extensions, renderer] of entries) {
    for (const extension of extensions) {
      map[extension] = renderer
    }
  }
  return map
}

/** OFD is China's national layout-document standard (GB/T 33190): e-invoices and archived official files. */
const OFD_EXTENSIONS = ['ofd']

const EXTENSION_TO_RENDERER = extensionMap([
  [IMAGE_EXTENSIONS, 'image'],
  [PDF_EXTENSIONS, 'pdf'],
  [TEXT_EXTENSIONS, 'text'],
  [SPREADSHEET_EXTENSIONS, 'spreadsheet'],
  [WORD_EXTENSIONS, 'word'],
  [PRESENTATION_EXTENSIONS, 'presentation'],
  [MEDIA_EXTENSIONS, 'media'],
  [ARCHIVE_EXTENSIONS, 'archive'],
  [OFD_EXTENSIONS, 'ofd'],
])

const MIME_TO_RENDERER: Record<string, RendererKey> = {
  'application/pdf': 'pdf',
  'application/json': 'text',
  'application/xml': 'text',
  'text/xml': 'text',
  'application/xhtml+xml': 'text',
  'text/csv': 'spreadsheet',
  'application/csv': 'spreadsheet',
  'text/tab-separated-values': 'spreadsheet',
  'application/zip': 'archive',
  'application/x-zip-compressed': 'archive',
  'application/x-7z-compressed': 'archive',
  'application/x-rar-compressed': 'archive',
  'application/vnd.rar': 'archive',
  'application/x-tar': 'archive',
  'application/gzip': 'archive',
  'application/x-gzip': 'archive',
  'application/x-bzip2': 'archive',
  'application/x-xz': 'archive',
  'application/x-cpio': 'archive',
  'application/msword': 'word',
  'application/rtf': 'word',
  'text/rtf': 'word',
  'application/vnd.ms-excel': 'spreadsheet',
  'application/vnd.ms-powerpoint': 'presentation',
  'application/vnd.oasis.opendocument.text': 'word',
  'application/vnd.oasis.opendocument.presentation': 'presentation',
  'application/vnd.oasis.opendocument.spreadsheet': 'spreadsheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template': 'word',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template': 'spreadsheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow': 'presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.template': 'presentation',
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase()
}

/**
 * Extension first: a stored attachment's mime is often the generic `application/octet-stream`, so its
 * name is the only reliable signal. The mime is the fallback for a nameless blob.
 */
function rendererKeyFor(target: FilePreviewTarget): RendererKey | null {
  const extension = extensionOf(target.filename)
  const byExtension = EXTENSION_TO_RENDERER[extension]
  if (byExtension) {
    return byExtension
  }

  const normalizedMime = target.mime.toLowerCase().split(';', 1)[0].trim()
  const byMime = MIME_TO_RENDERER[normalizedMime]
  if (byMime) {
    return byMime
  }

  if (normalizedMime.startsWith('image/')) return 'image'
  if (normalizedMime.startsWith('audio/') || normalizedMime.startsWith('video/')) return 'media'
  if (normalizedMime.startsWith('text/')) return 'text'
  return null
}

export function resolveFilePreviewLoader(target: FilePreviewTarget): FilePreviewLoader | null {
  const rendererKey = rendererKeyFor(target)
  if (!rendererKey) {
    return null
  }
  const load = RENDERER_LOADERS[rendererKey]
  return async () => (await load()) as { default: FileViewerRendererPluginInput }
}
