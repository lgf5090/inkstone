import { describe, expect, it } from 'vitest'
import { mergeSettings } from '@shared/constants'
import { styleSettingsOf } from '@shared/property-style'
import type { PropertyRenderOptions } from './renderer'
import { renderMarkdown } from './renderer'

const SOURCE = ['---', 'title: Example', 'tags: [demo]', '---', '', '# Heading', '', 'body'].join('\n')

describe('renderMarkdown front matter block', () => {
  it('renders a read-only properties fold by default', () => {
    expect(renderMarkdown(SOURCE).html).toContain('frontmatter-properties')
  })

  it('leaves the block to the editable panel when asked to hide it', () => {
    const html = renderMarkdown(SOURCE, { hideFrontMatter: true }).html
    expect(html).not.toContain('frontmatter-properties')
    expect(html).toContain('Heading')
    expect(html).toContain('body')
  })

  it('still surfaces unparseable front matter while hidden', () => {
    const broken = ['---', 'title: [unclosed', '---', 'body'].join('\n')
    const html = renderMarkdown(broken, { hideFrontMatter: true }).html
    expect(html).toContain('frontmatter-error')
  })

  it('keeps the default for every other caller', () => {
    expect(renderMarkdown(SOURCE).html).toContain('frontmatter-properties')
    expect(renderMarkdown('# only body').html).not.toContain('frontmatter-properties')
  })
})

const PRETTY = [
  '---',
  'title: Example',
  'status: reading',
  'pages: 120',
  'due: 2026-10-01',
  'secret: hidden text',
  'cover: "[[Cover.png]]"',
  'cover_shape: circle',
  'banner: "https://example.test/b.jpg"',
  'icon: "\uD83C\uDF81"',
  'tags: [demo]',
  '---',
  '',
  '# Heading',
  '',
  'body',
].join('\n')

function options(patch: Record<string, unknown> = {}, extra: Partial<PropertyRenderOptions> = {}): PropertyRenderOptions {
  const properties = mergeSettings({ properties: patch }).properties
  return {
    style: styleSettingsOf(properties),
    names: {
      banner: properties.bannerProperty,
      icon: properties.iconProperty,
      cover: [...properties.coverProperties],
      coverShape: properties.coverShapeProperty,
      coverPosition: properties.coverPositionProperty,
      bannerPosition: properties.bannerPositionProperty,
    },
    defaults: { coverShape: properties.coverShape, coverPosition: properties.coverPosition, bannerPosition: properties.bannerPosition },
    revealHidden: properties.revealHidden,
    iconInline: properties.iconInline,
    iconSize: properties.iconSize,
    bannerHeight: properties.bannerHeight,
    bannerFade: properties.bannerFade,
    coverWidths: { width1: properties.coverWidth, width2: properties.coverWidth2, width3: properties.coverWidth3 },
    locale: 'en-US',
    now: new Date(2026, 9, 8, 12, 0, 0).getTime(),
    ...extra,
  }
}

describe('renderMarkdown pretty properties', () => {
  it('renders the decorated block instead of the plain fold', () => {
    const html = renderMarkdown(PRETTY, { properties: options() }).html
    expect(html).toContain('pp-block')
    expect(html).toContain('data-property-key="status"')
    expect(html).toContain('data-property-key="due"')
    expect(html).toContain('data-relative-date="past"')
  })

  it('keeps the plain fold when the feature is off', () => {
    const html = renderMarkdown(PRETTY, { properties: options({ enabled: false }) }).html
    expect(html).not.toContain('pp-block')
    expect(html).toContain('frontmatter-properties')
  })

  it('drops a hidden row and brings it back under reveal', () => {
    const hidden = renderMarkdown(PRETTY, { properties: options({ hidden: ['secret'] }) }).html
    expect(hidden).not.toContain('data-property-key="secret"')
    const revealed = renderMarkdown(PRETTY, { properties: options({ hidden: ['secret'] }, { revealHidden: true }) }).html
    expect(revealed).toContain('pp-row-hidden')
    expect(revealed).toContain('data-property-key="secret"')
  })

  it('paints a hex value through the colour-only exemption and a token through a class', () => {
    const html = renderMarkdown(PRETTY, {
      properties: options({ colors: { status: { reading: { text: '#059669' } }, title: { Example: { text: 'accent' } } } }),
    }).html
    expect(html).toContain('style="color:#059669"')
    expect(html).toContain('class="pp-text-token"')
  })

  it('draws a progress element for a numeric rule', () => {
    const html = renderMarkdown(PRETTY, { properties: options({ progress: { pages: { max: 240 } } }) }).html
    expect(html).toContain('<progress class="pp-progress" max="240" value="120"')
  })

  it('carries the cover shape and the attachment target, and the banner url', () => {
    const html = renderMarkdown(PRETTY, { properties: options() }).html
    expect(html).toContain('pp-cover is-left is-circle')
    expect(html).toContain('data-pp-cover-width="250"')
    expect(html).toContain('data-embed-target')
    expect(html).toContain('src="https://example.test/b.jpg"')
    expect(html).toContain('data-pp-banner-height="150"')
  })

  it('refuses a script or an event handler smuggled through a property value', () => {
    const hostile = ['---', 'title: "<img src=x onerror=alert(1)>"', '---', 'body'].join('\n')
    const html = renderMarkdown(hostile, { properties: options() }).html
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<svg')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    const markdownValue = renderMarkdown(hostile, { properties: options({ formats: { title: { markdown: true } } }) }).html
    expect(markdownValue).not.toContain('<img src=x')
    expect(markdownValue).not.toContain('onerror=')
  })

  it('renders a formatted value and leaves the raw text in the note', () => {
    const html = renderMarkdown(PRETTY, { properties: options({ formats: { pages: { template: '{{percent propertyValue 480}}' } } }) }).html
    expect(html).toContain('25%')
    expect(html).not.toContain('data-property-value="120"')
  })
})
