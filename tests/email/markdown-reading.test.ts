// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { emailMarkdownSource, looksLikeMarkdown } from '../../src/client/features/email/markdown-reading'

describe('email markdown reading', () => {
  it('recovers the lines of a plain-text message wrapped in divs', () => {
    const source = emailMarkdownSource([
      '<div dir="ltr"># 欢迎使用 Inkstone</div>',
      '<div><br></div>',
      '<div>&gt; [!TIP] 先知道这五件事</div>',
      '<div>- [ ] 第一件事</div>',
    ].join(''))
    expect(source).toContain('# 欢迎使用 Inkstone')
    expect(source).toContain('> [!TIP] 先知道这五件事')
    expect(source).toContain('- [ ] 第一件事')
    expect(looksLikeMarkdown(source!)).toBe(true)
  })

  it('leaves an email that already carries real formatting to the HTML reader', () => {
    expect(emailMarkdownSource('<p><strong>Hi</strong> <a href="https://example.com">there</a></p>')).toBeNull()
    expect(emailMarkdownSource('<img src="https://example.com/a.png">')).toBeNull()
  })

  it('does not treat an ordinary plain-text note as markdown', () => {
    expect(looksLikeMarkdown('Thanks, see you tomorrow.\n\nBest,\nAda')).toBe(false)
    expect(looksLikeMarkdown('- one\n- two')).toBe(false)
  })

  it('recognises a markdown document and returns its source untouched', () => {
    const source = '# Title\n\n> [!NOTE] Details\n\n- [ ] task'
    expect(emailMarkdownSource(source)).toBe(source)
    expect(looksLikeMarkdown(source)).toBe(true)
  })
})
