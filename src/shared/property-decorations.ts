export const COVER_SHAPES = [
  'initial',
  'initial-2',
  'initial-3',
  'vertical-cover',
  'vertical-contain',
  'horizontal-cover',
  'horizontal-contain',
  'square',
  'circle',
] as const

export type CoverShape = (typeof COVER_SHAPES)[number]

export const COVER_POSITIONS = ['left', 'right', 'top', 'bottom'] as const

export type CoverPosition = (typeof COVER_POSITIONS)[number]

export type PropertyImageSource =
  | { kind: 'attachment'; name: string }
  | { kind: 'url'; url: string }

export interface PropertyImageValue {
  source: PropertyImageSource
  alt: string
}

export interface NotePropertyNames {
  banner: string
  icon: string
  cover: string[]
  coverShape: string
  coverPosition: string
  bannerPosition: string
}

export const DEFAULT_PROPERTY_NAMES: NotePropertyNames = {
  banner: 'banner',
  icon: 'icon',
  cover: ['cover'],
  coverShape: 'cover_shape',
  coverPosition: 'cover_position',
  bannerPosition: 'banner_position',
}

const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i

const WIKI_LINK = /^!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/

const MARKDOWN_LINK = /^!?\[([^\]]*)\]\(([^)]*)\)$/

const HTTP_URL = /^https?:\/\/[^\s<>"'`\\]+$/i

const SCHEMED = /^[a-z][a-z0-9+.-]*:/i

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[A-Za-z0-9+/=\s]{1,600000}$/

const YOUTUBE_WATCH = /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,20})(?:[&?][^\s]*)?$/i

const MAX_URL_LENGTH = 2048

const MAX_ICON_TEXT_LENGTH = 32


export function parsePropertyImage(raw: unknown): PropertyImageValue | null {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text)
    return null

  const wiki = WIKI_LINK.exec(text)
  if (wiki)
    return { source: attachmentSource(wiki[1] ?? ''), alt: (wiki[2] ?? '').trim() }

  const link = MARKDOWN_LINK.exec(text)
  if (link) {
    const resolved = resolveTarget((link[2] ?? '').trim())
    return resolved ? { ...resolved, alt: (link[1] ?? '').trim() } : null
  }

  const direct = resolveTarget(text)
  if (direct)
    return { ...direct, alt: '' }

  if (DATA_IMAGE.test(text))
    return { source: { kind: 'url', url: text.replace(/\s/g, '') }, alt: '' }

  return null
}

const LINK_TITLE = /\s+["'(][^"')]*["')]$/


function resolveTarget(raw: string): { source: PropertyImageSource } | null {
  const target = raw.replace(LINK_TITLE, '').trim()
  if (!target)
    return null
  if (SCHEMED.test(target) && !HTTP_URL.test(target))
    return null
  const youtube = YOUTUBE_WATCH.exec(target)
  if (youtube?.[1])
    return { source: { kind: 'url', url: `https://img.youtube.com/vi/${youtube[1]}/maxresdefault.jpg` } }
  if (HTTP_URL.test(target))
    return isSafeUrl(target) ? { source: { kind: 'url', url: target } } : null
  if (IMAGE_EXTENSION.test(target))
    return { source: attachmentSource(target) }
  return null
}

function attachmentSource(target: string): { kind: 'attachment'; name: string } {
  const cleaned = (target.split('#')[0] ?? '').split('?')[0]!.trim()
  const name = (cleaned.split(/[\\/]/).pop() ?? '').trim()
  return { kind: 'attachment', name }
}

function isSafeUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH)
    return false
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      return false
    return !parsed.username && !parsed.password
  }
  catch {
    return false
  }
}


export function coverShapeOrNull(raw: unknown): CoverShape | null {
  const text = typeof raw === 'string' ? raw.trim().toLocaleLowerCase() : ''
  return (COVER_SHAPES as readonly string[]).includes(text) ? (text as CoverShape) : null
}


export function coverPositionOrNull(raw: unknown): CoverPosition | null {
  const text = typeof raw === 'string' ? raw.trim().toLocaleLowerCase() : ''
  return (COVER_POSITIONS as readonly string[]).includes(text) ? (text as CoverPosition) : null
}


export function bannerPositionPercent(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace('%', '').trim())
  if (!Number.isFinite(value))
    return null
  return Math.min(100, Math.max(0, Math.round(value)))
}


export type PropertyIconValue =
  | { kind: 'image'; image: PropertyImageValue }
  | { kind: 'glyph'; text: string }


export function parsePropertyIcon(raw: unknown): PropertyIconValue | null {
  const image = parsePropertyImage(raw)
  if (image)
    return { kind: 'image', image }
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text)
    return null
  const chars = Array.from(text)
  return { kind: 'glyph', text: chars.slice(0, MAX_ICON_TEXT_LENGTH).join('') }
}

export interface CoverWidths {
  width1: number
  width2: number
  width3: number
}


export function coverWidthFor(widths: CoverWidths, shape: CoverShape | string): number {
  if (shape === 'initial-2' || shape === 'square' || shape === 'circle')
    return widths.width2
  if (shape === 'initial-3' || shape === 'horizontal-cover' || shape === 'horizontal-contain')
    return widths.width3
  return widths.width1
}

export interface NoteCoverDecoration {
  property: string
  image: PropertyImageValue
  shape: CoverShape
  position: CoverPosition
}

export interface NoteBannerDecoration {
  property: string
  image: PropertyImageValue
  positionPercent: number
}

export interface NoteIconDecoration {
  property: string
  icon: PropertyIconValue
}

export interface NoteDecorations {
  cover: NoteCoverDecoration | null
  banner: NoteBannerDecoration | null
  icon: NoteIconDecoration | null
}

export interface DecorationDefaults {
  coverShape: CoverShape
  coverPosition: CoverPosition
  bannerPosition: number
}


export function readNoteDecorations(
  data: Record<string, unknown>,
  names: NotePropertyNames,
  defaults: DecorationDefaults,
): NoteDecorations {
  const cover = readCover(data, names, defaults)
  const banner = readBanner(data, names, defaults)
  const icon = readIcon(data, names)
  return { cover, banner, icon }
}

function readCover(
  data: Record<string, unknown>,
  names: NotePropertyNames,
  defaults: DecorationDefaults,
): NoteCoverDecoration | null {
  for (const property of names.cover) {
    if (!property)
      continue
    const image = parsePropertyImage(lookup(data, property))
    if (!image)
      continue
    return {
      property,
      image,
      shape: coverShapeOrNull(lookup(data, names.coverShape)) ?? defaults.coverShape,
      position: coverPositionOrNull(lookup(data, names.coverPosition)) ?? defaults.coverPosition,
    }
  }
  return null
}

function readBanner(
  data: Record<string, unknown>,
  names: NotePropertyNames,
  defaults: DecorationDefaults,
): NoteBannerDecoration | null {
  if (!names.banner)
    return null
  const image = parsePropertyImage(lookup(data, names.banner))
  if (!image)
    return null
  return {
    property: names.banner,
    image,
    positionPercent: bannerPositionPercent(lookup(data, names.bannerPosition)) ?? defaults.bannerPosition,
  }
}

function readIcon(data: Record<string, unknown>, names: NotePropertyNames): NoteIconDecoration | null {
  if (!names.icon)
    return null
  const icon = parsePropertyIcon(lookup(data, names.icon))
  return icon ? { property: names.icon, icon } : null
}

function lookup(data: Record<string, unknown>, path: string): unknown {
  if (!path)
    return undefined
  if (Object.prototype.hasOwnProperty.call(data, path))
    return data[path]
  const keys = path.split('.')
  let current: unknown = data
  for (const key of keys) {
    if (!current || typeof current !== 'object' || Array.isArray(current))
      return undefined
    if (!Object.prototype.hasOwnProperty.call(current, key))
      return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
