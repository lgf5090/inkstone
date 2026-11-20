import { describe, expect, it } from 'vitest'
import { renderGithubReadme } from '../src/client/features/development/github/lib/readme'

const OPTIONS = { fullName: 'acme/repo', defaultBranch: 'main' }
const render = (md: string): string => renderGithubReadme(md, OPTIONS)

describe('GFM coverage', () => {
  it('renders tables with alignment carried by align, not the stripped style', () => {
    const html = render('| a | b |\n| :- | -: |\n| 1 | 2 |')
    expect(html).toContain('class="github-md-table"')
    expect(html).toContain('align="left"')
    expect(html).toContain('align="right"')
    expect(html).not.toContain('style=')
  })

  it('renders task items as inert marks rather than inputs', () => {
    const html = render('- [x] done\n- [ ] todo')
    expect(html).toContain('gh-task gh-task-done')
    expect(html).toContain('class="gh-task"')
    expect(html).not.toContain('<input')
  })

  it('renders strikethrough, autolinks and line breaks', () => {
    const html = render('~~gone~~ and https://example.com<br>next')
    expect(html).toContain('<s>gone</s>')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('<br>')
  })

  it('renders footnotes with references, back references and prefixed anchors', () => {
    const html = render('text[^1]\n\n[^1]: the note')
    expect(html).toContain('class="footnote-ref"')
    expect(html).toContain('class="footnotes-list"')
    expect(html).toContain('class="footnote-backref"')
    expect(html).toContain('id="readme-fn1"')
    expect(html).toContain('href="#readme-fn1"')
    expect(html).toContain('href="#readme-fnref1"')
    expect(html).toContain('the note')
  })

  it('renders all five alert kinds without leaving the marker behind', () => {
    for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const) {
      const slug = kind.toLowerCase()
      const html = render(`> [!${kind}]\n> body text`)
      expect(html).toContain(`class="gh-alert gh-alert-${slug}"`)
      expect(html).toContain('data-label=')
      expect(html).toContain('body text')
      expect(html).not.toContain(`[!${kind}]`)
    }
  })

  it('leaves an unknown alert marker as ordinary quote text', () => {
    const html = render('> [!FOO]\n> body')
    expect(html).not.toContain('gh-alert')
    expect(html).toContain('[!FOO]')
  })

  it('keeps picture and source, resolving every candidate in srcset', () => {
    const html = render('<picture><source srcset="img/a.avif 1x, img/a@2x.avif 2x"><img src="img/a.png" alt="x"></picture>')
    expect(html).toContain('<picture>')
    expect(html).toContain('<source')
    expect(html).toContain('https://raw.githubusercontent.com/acme/repo/main/img/a.avif 1x')
    expect(html).toContain('https://raw.githubusercontent.com/acme/repo/main/img/a@2x.avif 2x')
    expect(html).toContain('src="https://raw.githubusercontent.com/acme/repo/main/img/a.png"')
  })

  it('keeps collapsed sections, indented code and inline HTML', () => {
    const html = render([
      '<details>',
      '<summary>More</summary>',
      '',
      'hidden',
      '',
      '</details>',
      '',
      '    indented block',
      '',
      'press <kbd>Ctrl</kbd>, H<sub>2</sub>O, x<sup>2</sup>, <mark>hi</mark>',
    ].join('\n'))
    expect(html).toContain('<details>')
    expect(html).toContain('<summary>More</summary>')
    expect(html).toContain('<pre><code>indented block')
    expect(html).toContain('<kbd>Ctrl</kbd>')
    expect(html).toContain('<sub>2</sub>')
    expect(html).toContain('<sup>2</sup>')
    expect(html).toContain('<mark>hi</mark>')
  })

  it('hides HTML comments and prefixes every heading anchor', () => {
    const html = render('before <!-- hidden --> after\n\n## Section One\n\n[jump](#section-one)')
    expect(html).not.toContain('hidden')
    expect(html).toContain('id="readme-section-one"')
    expect(html).toContain('href="#readme-section-one"')
  })

  it('encodes math for the shared KaTeX pass', () => {
    const inline = render('Euler: $e^{i\\pi}+1=0$')
    expect(inline).toContain('class="math-inline"')
    expect(inline).toContain('data-math="b64.')
    expect(inline).toContain('e^{i\\pi}+1=0')

    const block = render('$$\n\\int_0^1 x dx\n$$')
    expect(block).toContain('class="math-block"')
    expect(block).toContain('data-math="b64.')
  })

  it('does not treat prices as math', () => {
    const html = render('costs $5 and $6 per seat')
    expect(html).not.toContain('math-inline')
    expect(html).toContain('$5')
  })

  it('keeps nested lists and relative links intact', () => {
    const html = render('- a\n  - b\n    1. c\n\n[doc](docs/a.md)')
    expect(html).toContain('<ul>')
    expect(html).toContain('<ol>')
    expect(html).toContain('https://github.com/acme/repo/blob/main/docs/a.md')
  })
})
