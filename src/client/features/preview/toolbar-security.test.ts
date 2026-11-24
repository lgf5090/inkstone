import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { enhanceCodeBlockToolbarsInRoot } from './code-block-toolbar'
import { enhancePanelToolbarsInRoot } from './panel-toolbar'
import { enhanceTabsToolbarsInRoot } from './tabs-toolbar'
import { enhanceExampleLayoutsInRoot } from './example-layout'

const payload = '0"><img id="audit-injected" src=x><div x="'

function rootWith(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

describe('preview toolbar attribute safety', () => {
  it('drops a non-numeric data-line during markdown purification', () => {
    const source = `<div class="code-block" data-line="0&quot;><img id=&quot;audit-injected&quot; src=x><div x=&quot;"><div class="code-block-head"></div></div>`
    const rendered = renderMarkdown(source).html
    const root = rootWith(rendered)
    expect(root.querySelector('.code-block')?.getAttribute('data-line')).toBeNull()
    enhanceCodeBlockToolbarsInRoot(root)
    expect(root.querySelector('#audit-injected')).toBeNull()
  })

  it('escapes crafted line values in every toolbar that builds an id from them', () => {
    const code = rootWith('<div class="code-block"><div class="code-block-head"></div></div>')
    const panel = rootWith('<div class="markdown-align"></div>')
    const tabs = rootWith('<div class="markdown-tabs" data-tabs="demo"></div>')
    const example = rootWith('<div class="markdown-example" data-example-family="md"><div class="markdown-example-head"></div><div class="markdown-example-grid"></div></div>')
    for (const root of [code, panel, tabs, example]) {
      const block = root.firstElementChild as HTMLElement
      block.dataset.line = payload
    }

    enhanceCodeBlockToolbarsInRoot(code)
    enhancePanelToolbarsInRoot(panel)
    enhanceTabsToolbarsInRoot(tabs)
    enhanceExampleLayoutsInRoot(example)

    for (const root of [code, panel, tabs, example]) {
      expect(root.querySelector('#audit-injected')).toBeNull()
      expect(root.querySelector('img')).toBeNull()
    }
  })
})
