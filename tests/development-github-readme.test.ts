import { describe, expect, it } from 'vitest'
import { renderGithubReadme } from '../src/client/features/development/github/lib/readme'

const OPTIONS = { fullName: 'acme/repo', defaultBranch: 'main' }
const proxied = (url: string): string => `/api/development/github/image?url=${encodeURIComponent(url)}`

describe('GitHub README rendering', () => {
  it('rewrites relative images to raw and relative links to blob', () => {
    const html = renderGithubReadme([
      '![shot](./images/shot.png "Shot")',
      '[docs](docs/guide.md)',
      '[root](/LICENSE)',
      '[anchor](#install)',
      '[site](https://example.com)',
    ].join('\n\n'), OPTIONS)
    expect(html).toContain(`src="${proxied('https://github.com/acme/repo/raw/main/images/shot.png')}"`)
    expect(html).toContain('href="https://github.com/acme/repo/blob/main/docs/guide.md"')
    expect(html).toContain('href="https://github.com/acme/repo/blob/main/LICENSE"')
    expect(html).toContain('href="#readme-install"')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('keeps query and hash suffixes on relative links', () => {
    const html = renderGithubReadme('[file](docs/a.md?plain=1#L2)', OPTIONS)
    expect(html).toContain('href="https://github.com/acme/repo/blob/main/docs/a.md?plain=1#L2"')
  })

  it('adds safe image attributes and upgrades protocol-relative URLs', () => {
    const html = renderGithubReadme('![logo](//cdn.example.com/logo.png)', OPTIONS)
    expect(html).toContain(`src="${proxied('https://cdn.example.com/logo.png')}"`)
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('referrerpolicy="no-referrer"')
  })

  it('removes scripts, styles and event handlers', () => {
    const html = renderGithubReadme([
      '<script>alert(1)</script>',
      '<style>body{display:none}</style>',
      '<img src="https://example.com/x.png" onerror="alert(1)" style="position:fixed">',
      '<a href="javascript:alert(1)">bad</a>',
    ].join('\n\n'), OPTIONS)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
    expect(html).not.toContain('<style')
    expect(html).not.toContain('style=')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('loading="lazy"')
  })

  it('allows data images but not data links', () => {
    const image = renderGithubReadme('![pixel](data:image/png;base64,iVBORw0KGgo=)', OPTIONS)
    expect(image).toContain('src="data:image/png;base64,iVBORw0KGgo="')
    const link = renderGithubReadme('<a href="data:text/html,hello">file</a>', OPTIONS)
    expect(link).not.toContain('data:text/html')
  })

  it('resolves images inside raw HTML and preserves GitHub layout attributes', () => {
    const html = renderGithubReadme([
      '<p align="center">',
      '  <a href="docs/guide.md"><img src="assets/hero.svg" alt="Hero" width="100%"></a>',
      '</p>',
      '<table><tr><td width="33%" valign="top"><h3>Feature</h3></td></tr></table>',
    ].join('\n'), OPTIONS)
    expect(html).toContain(`src="${proxied('https://github.com/acme/repo/raw/main/assets/hero.svg')}"`)
    expect(html).toContain('href="https://github.com/acme/repo/blob/main/docs/guide.md"')
    expect(html).toContain('align="center"')
    expect(html).toContain('width="100%"')
    expect(html).toContain('width="33%"')
    expect(html).toContain('valign="top"')
  })

  it('adds GitHub-style heading ids so README anchors resolve', () => {
    const html = renderGithubReadme('## Quick start\n\n[Jump](#quick-start)', OPTIONS)
    expect(html).toContain('<h2 id="readme-quick-start">Quick start</h2>')
    expect(html).toContain('href="#readme-quick-start"')
    const duplicate = renderGithubReadme('## Same\n\n## Same', OPTIONS)
    expect(duplicate).toContain('<h2 id="readme-same">')
    expect(duplicate).toContain('<h2 id="readme-same-1">')
  })

  it('prefixes author-supplied ids so they cannot collide with the app', () => {
    const html = renderGithubReadme('<a id="root"></a>\n\n[Top](#root)', OPTIONS)
    expect(html).toContain('id="readme-root"')
    expect(html).toContain('href="#readme-root"')
  })

  it('drops arbitrary classes that could borrow app styles but keeps code and table classes', () => {
    const html = renderGithubReadme([
      '<div class="fixed inset-0 z-[9999]">overlay</div>',
      '',
      '| A | B |\n| --- | --- |\n| 1 | 2 |',
      '',
      '```ts\nconst value = 1\n```',
    ].join('\n'), OPTIONS)
    expect(html).not.toContain('fixed')
    expect(html).not.toContain('inset-0')
    expect(html).toContain('class="github-md-table"')
    expect(html).toContain('class="language-ts"')
  })

  it('keeps the code fence language class', () => {
    const html = renderGithubReadme('```ts\nconst value = 1\n```', OPTIONS)
    expect(html).toContain('<code class="language-ts">')
  })

  it('returns the caller supplied empty markup', () => {
    expect(renderGithubReadme('   ', OPTIONS, '<p>empty</p>')).toBe('<p>empty</p>')
    expect(renderGithubReadme('', OPTIONS)).toBe('')
  })

  it('preserves absolute image and external anchor markup', () => {
    const html = renderGithubReadme([
      '[remote](https://example.com/a)',
      '![remote](https://example.com/a.png)',
    ].join('\n\n'), OPTIONS)
    expect(html).toContain('href="https://example.com/a"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain(`src="${proxied('https://example.com/a.png')}"`)
    expect(html).toContain('loading="lazy"')
  })

  it('does not wrap an already proxied image twice', () => {
    const url = proxied('https://example.com/a.png')
    const html = renderGithubReadme(`![remote](${url})`, OPTIONS)
    expect(html).toContain(`src="${url}"`)
    expect(html).not.toContain('url=%2Fapi%2F')
  })
})
