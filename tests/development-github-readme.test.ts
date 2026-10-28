import { describe, expect, it } from 'vitest'
import { renderGithubReadme } from '../src/client/features/development/github/lib/readme'

const OPTIONS = { fullName: 'acme/repo', defaultBranch: 'main' }

describe('GitHub README rendering', () => {
  it('rewrites relative images to raw and relative links to blob', () => {
    const html = renderGithubReadme([
      '![shot](./images/shot.png "Shot")',
      '[docs](docs/guide.md)',
      '[root](/LICENSE)',
      '[anchor](#install)',
      '[site](https://example.com)',
    ].join('\n\n'), OPTIONS)
    expect(html).toContain('src="https://github.com/acme/repo/raw/main/images/shot.png"')
    expect(html).toContain('href="https://github.com/acme/repo/blob/main/docs/guide.md"')
    expect(html).toContain('href="https://github.com/acme/repo/blob/main/LICENSE"')
    expect(html).toContain('href="#install"')
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
    expect(html).toContain('src="https://cdn.example.com/logo.png"')
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
    expect(html).toContain('src="https://example.com/a.png"')
    expect(html).toContain('loading="lazy"')
  })
})
