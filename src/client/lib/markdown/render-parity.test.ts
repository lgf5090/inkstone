import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownBlocks } from './renderer'

const BLOCKS: Array<[string, string]> = [
  ['heading', '# H1\n\n## H2\n'],
  ['paragraph', 'Some **bold** and *em* and `code` text.\n'],
  ['inline-marks', '==hit== ~~struck~~ <u>under</u> <sup>up</sup> <sub>down</sub>\n'],
  ['quote', '> quoted\n> more\n'],
  ['bullet-list', '- a\n- b\n  - nested\n'],
  ['ordered-list', '1. a\n2. b\n'],
  ['task-list', '- [ ] open\n- [x] done\n  - [ ] child\n'],
  ['table', '| a | b |\n| --- | --- |\n| 1 | 2 |\n'],
  ['code', '```js\nconst a = 1\n```\n'],
  ['hr', 'before\n\n---\n\nafter\n'],
  ['image', '![alt](/x.png "t")\n'],
  ['wikilink', '[[Other]] and [[Other|alias]] and [[Other#Head]]\n'],
  ['tag', 'text #alpha #beta/gamma\n'],
  ['footnote', 'note[^a]\n\n[^a]: foot\n'],
  ['block-ref', 'para ^abc\n\n[[#^abc]]\n'],
  ['math', 'inline $x^2$ and block\n\n$$\ny=1\n$$\n'],
  ['callout', '> [!note] Title\n> body\n'],
  ['callout-fold', '> [!tip]- Folded\n> body\n'],
  ['details', '::: details [click]\nhidden body\n:::\n'],
  ['tabs', ':::: tabs\n::: tab-item One\nfirst\n:::\n\n::: tab-item Two\nsecond\n:::\n::::\n'],
  ['columns', ':::: cols {split=50}\n::: col\nleft\n:::\n\n::: col\nright\n:::\n::::\n'],
  ['timeline', '::: timeline 历程 {dense}\n:: [milestone] 2024-01-15 立项\n说明文字\n::\n::::\n'],
  ['media', '::: media 图排 {cols=3}\n![[a.png]]\n![[b.png]]\n:::\n'],
  ['mermaid', '```mermaid\nflowchart LR\n  A-->B\n```\n'],
  ['chart', '```chart style=table\n| :string: | 数量 |\n| --- | --- |\n| r | 1 |\n```\n'],
  ['mindmap', '```mindmap\n# Root\n## A\n## B\n```\n'],
  ['kanban', '```kanban\n## 待办\n- [ ] 任务\n```\n'],
  ['dataview', '```dataview\nLIST FROM #x\n```\n'],
  ['inline-field', 'status:: reading\n'],
  ['embed', '![[Other]]\n'],
  ['html', '<div class="x">raw</div>\n'],
  ['comment', 'visible %% hidden %% tail\n'],
  ['example', '~~~~md-example title="T"\n**bold**\n~~~~\n'],
  ['front-matter', '---\ntitle: X\ntags: [a]\n---\n\n# body\n'],
]

/**
 * The two entry points differ in one legitimate way: each render mints a document id, and the blocks
 * that wire a label to a control embed it in `id`/`href`/`aria-*`. Everything around that id has to be
 * the same markup, because the live editor shows a note the reading pane also shows.
 */
function comparable(html: string): string {
  return html
    .replace(/ink-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ink-DOC')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .trim()
}

function previewMarkup(source: string): string {
  return comparable(renderMarkdown(source, { hideFrontMatter: true }).html)
}

function liveMarkup(source: string): string {
  return comparable(renderMarkdownBlocks(source, { hideFrontMatter: true }).blocks.map(block => block.html).join(''))
}

describe('the live editor and the preview render the same markup', () => {
  for (const [name, source] of BLOCKS) {
    it(`renders ${name} identically`, () => {
      expect(liveMarkup(source)).toBe(previewMarkup(source))
    })
  }

  it('keeps the source line each block came from', () => {
    const source = ['# H1', '', 'para', '', '- a', '- b', '', '| x |', '| - |', '| 1 |'].join('\n')
    const lines = renderMarkdownBlocks(source, { hideFrontMatter: true }).blocks.map(block => block.startLine)
    expect(lines).toEqual([0, 2, 4, 7])
  })
})
