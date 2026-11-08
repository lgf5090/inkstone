import { ICON_SPRITE_CELL, ICON_SPRITE_MAX_CANVAS } from '@shared/development/icons/limits'
import { encodePngRgba } from './png'

export interface SpriteAsset {
  name: string
  svg: string
}

export interface SpriteIcon {
  name: string
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface SpriteJson {
  version: 1
  sprite: string
  prefix: string
  cell: number
  padding: number
  columns: number
  rows: number
  width: number
  height: number
  icons: SpriteIcon[]
}

export function iconSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'icon'
}

export function uniqueSlugs(names: readonly string[]): string[] {
  const used = new Set<string>()
  return names.map((name) => {
    const base = iconSlug(name)
    let candidate = base
    let index = 2
    while (used.has(candidate)) candidate = `${base}-${index++}`
    used.add(candidate)
    return candidate
  })
}

export function svgViewBox(svg: string): string {
  const match = /viewBox\s*=\s*["']([^"']+)["']/i.exec(svg)
  if (match?.[1]) return match[1]
  const width = /(?:^|\s)width\s*=\s*["']([\d.]+)/i.exec(svg)?.[1]
  const height = /(?:^|\s)height\s*=\s*["']([\d.]+)/i.exec(svg)?.[1]
  return width && height ? `0 0 ${width} ${height}` : '0 0 24 24'
}

/** The children of an outer `<svg>` element, with declarations, comments and the wrapper removed. */
export function svgInner(svg: string): string {
  const withoutHeader = svg
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
  const start = withoutHeader.search(/<svg\b[^>]*>/i)
  if (start < 0) return withoutHeader
  const openEnd = withoutHeader.indexOf('>', start) + 1
  const close = withoutHeader.lastIndexOf('</svg>')
  if (close < openEnd) return withoutHeader.slice(openEnd)
  return withoutHeader.slice(openEnd, close)
}

export function buildSvgSymbolSprite(assets: readonly SpriteAsset[], spriteId: string): { svg: string; json: SpriteJson; icons: SpriteIcon[] } {
  const slugs = uniqueSlugs(assets.map((asset) => asset.name))
  const symbols = assets.map((asset, index) => {
    const slug = slugs[index]!
    const viewBox = svgViewBox(asset.svg)
    return `<symbol id="${slug}" viewBox="${viewBox}">${svgInner(asset.svg)}</symbol>`
  })
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" data-sprite="${spriteId}">${symbols.join('')}</svg>`
  const icons: SpriteIcon[] = slugs.map((slug) => ({ name: slug, id: slug, x: 0, y: 0, width: 0, height: 0 }))
  return {
    svg,
    icons,
    json: {
      version: 1,
      sprite: spriteId,
      prefix: '',
      cell: 0,
      padding: 0,
      columns: 0,
      rows: 0,
      width: 0,
      height: 0,
      icons,
    },
  }
}

export interface PngSpriteResult {
  png: Uint8Array
  json: SpriteJson
  css: string
  scss: string
}

function cssClass(slug: string): string {
  return `.icon-${slug}`
}

function cssBlock(icons: readonly SpriteIcon[], scale: number): string {
  return icons.map((icon) => `${cssClass(icon.id)}{background-position:-${icon.x * scale}px -${icon.y * scale}px}`).join('\n')
}

function sheetCss(json: SpriteJson, icons: readonly SpriteIcon[], base: string): string {
  const size = json.cell
  const baseRule = `.icon-sprite{display:inline-block;width:${size}px;height:${size}px;background-image:url('${base}.png');background-repeat:no-repeat}`
  const highRule = `@media (-webkit-min-device-pixel-ratio:2),(min-resolution:2dppx){.icon-sprite{background-image:url('${base}@2x.png');background-size:${json.width}px ${json.height}px}}`
  return `${baseRule}\n${cssBlock(icons, 1)}\n${highRule}`
}

function sheetScss(json: SpriteJson, icons: readonly SpriteIcon[], scss: boolean): string {
  if (!scss) return ''
  return `$sprite-url: 'sprite.png';\n$sprite-size: ${json.width}px ${json.height}px;\n${icons.map((icon) => `${cssClass(icon.id)}{background-position:-${icon.x}px -${icon.y}px}`).join('\n')}\n`
}

function gridFor(count: number, cell: number): { columns: number; rows: number; width: number; height: number } {
  let columns = Math.max(1, Math.ceil(Math.sqrt(count)))
  columns = Math.min(columns, Math.floor(ICON_SPRITE_MAX_CANVAS / cell))
  const rows = Math.ceil(count / columns)
  return { columns, rows, width: columns * cell, height: rows * cell }
}

export async function buildPngSprite(assets: readonly SpriteAsset[], spriteId: string, padding: number, scale: 1 | 2, scss: boolean): Promise<PngSpriteResult> {
  const { rasterizeSvgPixels } = await import('./raster')
  const slugs = uniqueSlugs(assets.map((asset) => asset.name))
  const iconSize = ICON_SPRITE_CELL * scale
  const cell = iconSize + padding * 2 * scale
  const grid = gridFor(assets.length, cell)
  if (grid.width > ICON_SPRITE_MAX_CANVAS || grid.height > ICON_SPRITE_MAX_CANVAS) {
    throw new Error('The sprite sheet would exceed the canvas limit')
  }
  const sheet = new Uint8Array(grid.width * grid.height * 4)
  const icons: SpriteIcon[] = []

  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index]!
    const rendered = await rasterizeSvgPixels(asset.svg, iconSize)
    const column = index % grid.columns
    const row = Math.floor(index / grid.columns)
    const originX = column * cell + padding * scale
    const originY = row * cell + padding * scale
    for (let y = 0; y < Math.min(rendered.height, iconSize); y += 1) {
      for (let x = 0; x < Math.min(rendered.width, iconSize); x += 1) {
        const source = (y * rendered.width + x) * 4
        const alpha = rendered.rgba[source + 3] ?? 0
        if (!alpha) continue
        const target = ((originY + y) * grid.width + originX + x) * 4
        sheet[target] = rendered.rgba[source]!
        sheet[target + 1] = rendered.rgba[source + 1]!
        sheet[target + 2] = rendered.rgba[source + 2]!
        sheet[target + 3] = alpha
      }
    }
    icons.push({ name: slugs[index]!, id: slugs[index]!, x: originX, y: originY, width: iconSize, height: iconSize })
  }

  const json: SpriteJson = {
    version: 1,
    sprite: spriteId,
    prefix: '',
    cell,
    padding,
    columns: grid.columns,
    rows: grid.rows,
    width: grid.width,
    height: grid.height,
    icons,
  }
  return {
    png: encodePngRgba(grid.width, grid.height, sheet),
    json,
    css: sheetCss(json, icons, 'sprite'),
    scss: sheetScss(json, icons, scss),
  }
}
