/**
 * One DOM element as an image, for every surface that exports pixels: the kanban board's view
 * snapshot. A board is markup the browser has already laid out, and the browser will draw markup
 * for us if it arrives inside an SVG it can load as an image — so the element is serialized into
 * one, turned into pixels by a canvas, and encoded as a PNG. That is the whole renderer: no
 * screenshot library, and the picture is the same markup the screen drew, styles included.
 */
const SVG_NS = 'http://www.w3.org/2000/svg'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

/** Two pixels per design pixel: the exported image is twice the element's own box. */
export const ELEMENT_IMAGE_SCALE = 2

/** The box an exported image has, in design pixels. */
export interface ElementImageGeometry {
  width: number
  height: number
}

// The stylesheets the document is wearing, as one block of text. An SVG image is a single data URL
// with no document and no base URL behind it, so anything a rule points at has to travel inside the
// text: without this, the picture would render in a fallback face instead of the app's own type.
export async function collectDocumentCss(): Promise<string> {
  const rules: string[] = []
  for (const sheet of [...document.styleSheets]) {
    let cssRules: CSSRuleList | null = null
    try {
      cssRules = sheet.cssRules
    }
    catch {
      // Best-effort: a cross-origin stylesheet cannot be read, and what the app draws does not
      // depend on one — every rule the picture needs is in the app's own bundle.
      continue
    }
    for (const rule of [...(cssRules ?? [])]) rules.push(rule.cssText)
  }
  return inlineStylesheetAssets(rules.join('\n'))
}

/** One element as a PNG at `ELEMENT_IMAGE_SCALE` times its own box. */
export async function renderElementPng(element: HTMLElement, geometry: ElementImageGeometry, css: string): Promise<Blob> {
  const svg = await elementSvg(element, geometry, css)
  const serialized = new XMLSerializer().serializeToString(svg)
  // A data URL, not an object one: an SVG loaded from `blob:` counts as cross-origin here, which
  // taints the canvas — `toBlob` then hands back nothing and the export dies on its first picture.
  // The percent-encoding that costs is the price of a canvas that can read.
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`)
  // A fresh canvas per picture rather than one reused: the encoder costs the same either way, while
  // a shared canvas holds its multi-megapixel backing store open for the whole export instead of
  // letting it go with the picture that needed it.
  const canvas = document.createElement('canvas')
  canvas.width = geometry.width * ELEMENT_IMAGE_SCALE
  canvas.height = geometry.height * ELEMENT_IMAGE_SCALE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('a 2d canvas is unavailable')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('the picture could not be encoded as a PNG'))
    }, 'image/png')
  })
}

/** The element as one downloadable file, named what the reader will recognise. */
export function saveImage(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// The element as an SVG the browser can draw. The element keeps its own classes and the stylesheet
// comes along, so what it draws is what it looked like; the box the caller measured is set on the
// holder, because the element's own live container is not part of what is serialized.
async function elementSvg(element: HTMLElement, geometry: ElementImageGeometry, css: string): Promise<SVGSVGElement> {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('xmlns', SVG_NS)
  svg.setAttribute('width', String(geometry.width))
  svg.setAttribute('height', String(geometry.height))
  // The image is a document of its own, and the design tokens hang off its root: without the theme
  // attributes the app's own skin is missing and every picture draws as bare black text on nothing.
  for (const { name, value } of document.documentElement.attributes) svg.setAttribute(name, value)
  const foreign = document.createElementNS(SVG_NS, 'foreignObject')
  foreign.setAttribute('x', '0')
  foreign.setAttribute('y', '0')
  foreign.setAttribute('width', '100%')
  foreign.setAttribute('height', '100%')
  const holder = document.createElementNS(XHTML_NS, 'div')
  holder.setAttribute('xmlns', XHTML_NS)
  holder.setAttribute('style', `width:${geometry.width}px;height:${geometry.height}px;`)
  const style = document.createElementNS(XHTML_NS, 'style')
  style.textContent = css
  holder.append(style, await cloneElement(element))
  foreign.append(holder)
  svg.append(foreign)
  return svg
}

// Two kinds of content cannot ride inside the SVG. A canvas's pixels are not in its markup, so each
// one is swapped for a still of itself. An `<img>` is in the markup, but the picture it points at
// lives in a document this SVG image has no part in, so a URL resolves to nothing and the exported
// picture shows a broken-image glyph where the element had a picture. Both travel as bytes instead.
async function cloneElement(element: HTMLElement): Promise<HTMLElement> {
  const clone = element.cloneNode(true) as HTMLElement
  const sources = [...element.querySelectorAll('canvas')]
  clone.querySelectorAll('canvas').forEach((canvas, index) => {
    const source = sources[index]
    if (source) freezeCanvas(canvas, source)
  })
  await inlineImages(clone)
  return clone
}

async function inlineImages(clone: HTMLElement): Promise<void> {
  for (const image of [...clone.querySelectorAll('img')]) {
    const src = image.getAttribute('src') ?? ''
    if (!src || src.startsWith('data:')) continue
    const dataUrl = await readAssetAsDataUrl(src)
    // A picture that cannot be read keeps its URL, which the SVG cannot resolve: the export loses
    // that one image and says so in the log, the way an unreadable canvas still does.
    if (dataUrl) image.setAttribute('src', dataUrl)
  }
}

function freezeCanvas(canvas: HTMLCanvasElement, source: HTMLCanvasElement): void {
  try {
    const still = document.createElement('img')
    still.setAttribute('src', source.toDataURL('image/png'))
    still.setAttribute('style', `width:${source.clientWidth || source.width}px;height:${source.clientHeight || source.height}px`)
    canvas.replaceWith(still)
  }
  catch (error: unknown) {
    // Best-effort: a canvas whose pixels cannot be read back (a cross-origin image went into it)
    // keeps its empty canvas in the picture, and the rest of it is unaffected.
    console.warn('[inkstone] element image could not freeze a canvas', error)
  }
}

async function inlineStylesheetAssets(css: string): Promise<string> {
  const urls = new Set(
    [...css.matchAll(/url\((['"]?)([^'"]+)\1\)/g)]
      .map((match) => match[2] ?? '')
      .filter((url) => url && !url.startsWith('data:') && !url.startsWith('#')),
  )
  let output = css
  for (const url of urls) {
    const dataUrl = await readAssetAsDataUrl(url)
    if (!dataUrl) continue
    output = output
      .split(`url("${url}")`).join(`url("${dataUrl}")`)
      .split(`url('${url}')`).join(`url('${dataUrl}')`)
      .split(`url(${url})`).join(`url(${dataUrl})`)
  }
  return output
}

async function readAssetAsDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { credentials: 'same-origin' })
    if (!response.ok) return null
    return await blobToDataUrl(await response.blob())
  }
  catch (error: unknown) {
    // Best-effort: an asset that cannot be read keeps its original URL, which an SVG image cannot
    // resolve, so the picture simply renders without it.
    console.warn('[inkstone] element image asset could not be inlined', url, error)
    return null
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('the asset could not be read'))
    reader.readAsDataURL(blob)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('the picture could not be decoded'))
    image.src = src
  })
}
