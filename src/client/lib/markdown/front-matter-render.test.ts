import { describe, expect, it } from 'vitest'
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
