import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownBlocks } from './renderer'

function render(source: string): string {
  return renderMarkdown(source).html
}

describe('the ::: media layout block', () => {
  it('lays one source line out as one row of cells', () => {
    const html = render('::: media\n![[beach.png]] ![设计草图](attachments/sketch.png)\n:::\n')
    // The sanitizer re-serializes a valueless attribute as `name=""`; CSS and the enhancer read both the same.
    expect(html).toContain('<div class="markdown-media" data-media="" data-line="0">')
    expect(html).toContain('class="markdown-media-row"')
    expect(html.match(/class="markdown-media-cell"/g)).toHaveLength(2)
    expect(html).toContain('data-media-cells="2"')
    // The row knows the line it came from, which is what a drag has to rewrite.
    expect(html).toContain('data-media-row')
    expect(html).toContain('data-line="1"')
  })

  it('keeps every embed it was given, in the order it was given them', () => {
    const html = render('::: media\n![[a.png]] ![b](b.webp)\n![[clip.mp4]]\n:::\n')
    expect(html).toContain('data-embed-target')
    expect(html).toContain('<img src="b.webp"')
    expect(html).toContain('data-media-kind="video"')
    expect(html.match(/class="markdown-media-row"/g)).toHaveLength(2)
  })

  it('puts the row settings where CSS can read them', () => {
    const html = render('::: media wrap=left width=40% gap=narrow cols=3\n![[a.png]] ![[b.png]] {w=1:2.5 h=300 align=left}\n:::\n')
    expect(html).toContain('data-media-wrap="left"')
    expect(html).toContain('data-media-width="40"')
    expect(html).toContain('data-media-gap="narrow"')
    expect(html).toContain('data-media-columns="3"')
    expect(html).toContain('data-media-row-weights="1,2.5"')
    expect(html).toContain('data-media-row-height="300"')
    expect(html).toContain('data-media-row-align="left"')
    // A default says nothing, so the markup stays the length of what the author actually chose.
    expect(html).not.toContain('data-media-align')
    expect(html).not.toContain('data-media-radius')
  })

  it('draws a caption from a title and from an alias that is not a size', () => {
    const titled = render('::: media\n![alt](a.png "The beach at dusk")\n:::\n')
    expect(titled).toContain('<figcaption>The beach at dusk</figcaption>')
    const aliased = render('::: media\n![[a.png|The beach at dusk]]\n:::\n')
    expect(aliased).toContain('data-media-caption')
    expect(aliased).toContain('The beach at dusk</div>')
    expect(render('::: media\n![[a.png|600]]\n:::\n')).not.toContain('data-media-caption')
  })

  it('escapes a caption, because it is author text in a page that runs scripts', () => {
    const html = render('::: media\n![[a.png|<img src=x onerror=alert(1)>]]\n:::\n')
    expect(html).not.toContain('onerror=alert(1)>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('numbers a figure once and points a reference at it', () => {
    const html = render('::: media numbered\n![[a.png|First {#fig:first}]]\n![[b.png|Second]]\n:::\n\nSee @fig:first and @fig:missing.\n')
    expect(html).toContain('data-media-figure="1"')
    expect(html).toContain('data-media-figure="2"')
    expect(html).toContain('id="^fig-first"')
    expect(html).toContain('data-block-id="fig-first"')
    expect(html).toContain('<a class="figure-reference" data-block-ref="fig-first" href="#%5Efig-first">')
    // A reference to a figure the note never named is left as the author spelled it.
    expect(html).toContain('@fig:missing')
    expect(html).not.toContain('data-block-ref="fig-missing"')
  })

  it('names a figure without being asked to number the block', () => {
    const html = render('::: media\n![[a.png|Dusk {#fig:dusk}]]\n:::\n\n@fig:dusk\n')
    expect(html).toContain('data-media-numbered="true"')
    expect(html).toContain('data-media-figure="1"')
  })

  it('holds a paragraph of its own as a text frame', () => {
    const html = render('::: media wrap=right width=30%\nA side note about the picture.\n:::\n')
    expect(html).toContain('data-media-text="true"')
    expect(html).toContain('<p>A side note about the picture.</p>')
    expect(html).not.toContain('markdown-media-row')
  })

  it('gives up the layout when the body mixes prose with pictures', () => {
    const html = render('::: media\n![[a.png]]\nSome words beside the picture.\n:::\n')
    expect(html).not.toContain('markdown-media')
    // Nothing is lost by giving up: the embed and the prose both still render, the way they did before.
    expect(html).toContain('data-embed-target')
    expect(html).toContain('Some words beside the picture.')
  })

  it('is not a layout inside a code fence, and an unclosed gallery still holds its own lines', () => {
    expect(render('```\n::: media\n![[a.png]]\n```\n')).not.toContain('markdown-media')
    const open = render('::: media\n![[a.png]]\n![[b.png]]\n')
    expect(open).toContain('markdown-media')
    expect(open.match(/class="markdown-media-cell"/g)).toHaveLength(2)
    // Like an unclosed ``` fence, an unclosed container claims the rest of its own context.
    expect(render('::: media\n![[a.png]]\n\nTrailing paragraph.\n')).not.toContain('markdown-media')
  })

  it('leaves the words that are not a layout alone', () => {
    expect(render('::: mediaof the ring\nplain text\n:::\n')).not.toContain('class="markdown-media"')
    expect(render('::: mediatype\nplain text\n:::\n')).not.toContain('class="markdown-media"')
  })

  it('renders as one live-preview block, addressed by its own lines', () => {
    const source = '::: media\n![[a.png]] ![[b.png]]\n:::\n\ntext\n'
    const blocks = renderMarkdownBlocks(source).blocks
    const media = blocks.find((block) => block.html.includes('markdown-media'))
    expect(media?.startLine).toBe(0)
    expect(media?.endLine).toBe(3)
  })
})
