// @vitest-environment jsdom
/**
 * The manifest the browser reads before it offers to install anything.
 *
 * Nothing checked this file: it is a hand-written document that four different surfaces have to agree
 * with — the token the shell paints with, the `theme-color` metas the same document carries, the scope
 * the worker registers at (`src/client/store/pwa.test.ts` holds that half), and the real size of the PNG
 * each icon entry names. Every one of those has drifted at least once, and a manifest whose icon size,
 * colour or scope is wrong is an install that looks wrong, tints the status bar with the wrong colour,
 * or does not happen at all.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface Icon {
  src: string
  sizes: string
  type: string
  purpose: string
}

interface Manifest {
  id: string
  name: string
  short_name: string
  lang: string
  start_url: string
  scope: string
  display: string
  display_override?: string[]
  background_color: string
  theme_color: string
  icons: Icon[]
}

// Read from the project root, the way every source-reading test in `tests/` does it.
const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as Manifest
const html = readFileSync('index.html', 'utf8')

/** Reads one `--bg-base` out of the theme block the shell paints with. */
function themeBaseColor(scheme: 'light' | 'dark'): string {
  const css = readFileSync('src/client/styles/tokens.css', 'utf8')
  const start = css.indexOf(`:root[data-theme='${scheme}']`)
  expect(start, `tokens.css has no :root[data-theme='${scheme}'] block to read a colour from`).toBeGreaterThanOrEqual(0)
  const color = /--bg-base:\s*(#[0-9a-fA-F]{6})/.exec(css.slice(start))?.[1]
  expect(color, `the ${scheme} block names no solid --bg-base`).toBeTruthy()
  return color!.toLowerCase()
}

/** The side an icon file really has, read out of its PNG header. */
function pngSize(file: string): { width: number, height: number } {
  // Read as bytes, not as a Node `Buffer`: the type map this run gets hands back a buffer without the
  // Buffer methods on it, and a PNG's size is four big-endian bytes at a fixed offset anyway.
  const bytes = Uint8Array.from(readFileSync(`public/${file}`))
  const signature = Array.from(bytes.subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('')
  expect(signature, `${file} is not a PNG the browser can decode`).toBe('89504e470d0a1a0a')
  const word = (offset: number) =>
    (((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0)
  return { width: word(16), height: word(20) }
}

describe('the manifest', () => {
  it('parses, and names the app the way the document names it', () => {
    // An unparseable manifest is not a broken install hint, it is no install hint at all, and the browser
    // says so in a console line most readers never open. The two names are what a launcher labels.
    expect(manifest.name).toBe('Inkstone')
    expect(manifest.short_name).toBe('Inkstone')
    expect(manifest.lang).toBe('en-US')
  })

  it('tints the app with the colour the shell actually paints', () => {
    // `theme_color` is the band the operating system draws above the page, and the page paints the area
    // under it with `--bg-base`; two spellings of that colour is a seam a reader sees on every launch.
    // The document's own `theme-color` metas are the same claim in a browser tab, so all of them have to
    // agree with the token — which is what drifted before this test existed, in both directions.
    expect(manifest.theme_color).toBe(themeBaseColor('light'))
    expect(manifest.background_color).toBe(themeBaseColor('light'))
    const light = /name="theme-color" content="(#[0-9a-fA-F]{6})" media="\(prefers-color-scheme: light\)"/.exec(html)
    const dark = /name="theme-color" content="(#[0-9a-fA-F]{6})" media="\(prefers-color-scheme: dark\)"/.exec(html)
    expect(light?.[1]?.toLowerCase(), 'index.html has no light theme-color meta to agree with the manifest').toBe(manifest.theme_color)
    expect(dark?.[1]?.toLowerCase(), 'index.html has no dark theme-color meta').toBe(themeBaseColor('dark'))
  })

  it('asks for the display mode that makes the safe-area padding mean something', () => {
    // Half the shell pads itself with `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)`. Those
    // lengths are only ever non-zero when the page owns the area behind the notch and the home bar, which
    // is what `standalone` plus `viewport-fit=cover` buys; a `browser` display, or an override that steps
    // back out to one, leaves every one of those paddings as dead space over a reader's content.
    expect(manifest.display).toBe('standalone')
    expect(manifest.display_override, 'an override list would be the display mode this assertion is about').toBeUndefined()
    expect(html).toContain('viewport-fit=cover')
    // The legacy iOS status-bar style paints its own opaque band over the inset the page already pads
    // itself for, so the app keeps relying on the insets rather than on it.
    expect(html).not.toContain('apple-mobile-web-app-status-bar-style')
  })

  it('opens on the entry point the worker is registered to control', () => {
    // The other half of this lives in `src/client/store/pwa.test.ts`, which reads the scope the store
    // really registers at. A `start_url` outside the worker's scope is an app that cannot be installed,
    // and an `id` that is not the URL the manifest is served from makes the installed app a second app.
    expect(manifest.scope).toBe('/')
    expect(manifest.start_url).toBe('/')
    expect(manifest.id).toBe('/')
  })

  it('ships the icons it claims, at the sizes it claims', () => {
    const sides = manifest.icons.map((icon) => {
      const [width, height] = icon.sizes.split('x').map(Number)
      const actual = pngSize(icon.src.replace(/^\//, ''))
      expect(actual.width, `${icon.src} is not the width the manifest declares`).toBe(width)
      expect(actual.height, `${icon.src} is not the height the manifest declares`).toBe(height)
      return { purpose: icon.purpose, type: icon.type, width: actual.width }
    })
    // Chrome's installability floor: a square icon of at least 192px and one of at least 512 usable as
    // `any`, plus a maskable one that reaches 512 so a launcher that crops still shows the mark.
    const any = sides.filter((icon) => icon.purpose === 'any' && icon.type === 'image/png').map((icon) => icon.width)
    expect(any).toEqual(expect.arrayContaining([192, 512]))
    expect(sides.find((icon) => icon.purpose === 'maskable')!.width).toBeGreaterThanOrEqual(512)
  })

  it('is the file the document points at, and nothing else has to be', () => {
    // The link is what makes the manifest reachable at all, and the icon the same document hands to iOS,
    // which ignores the manifest for its own home-screen tile.
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')
    expect(pngSize('apple-touch-icon.png')).toEqual({ width: 180, height: 180 })
  })
})
