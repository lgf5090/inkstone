import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './renderer'
import { revealPreviewTarget, selectMarkdownTab } from '@/features/preview/markdown-tabs'

function html(source: string): string {
    return renderMarkdown(source).html
}

function panelOf(source: string, tabIndex: number): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = renderMarkdown(source).html
    const panel = host.querySelector<HTMLElement>(`[data-tab-panel="${tabIndex}"]`)
    if (!panel)
        throw new Error(`panel ${tabIndex} missing in ${host.innerHTML}`)
    return panel
}

function buttons(group: HTMLElement): HTMLButtonElement[] {
    return [...group.querySelectorAll<HTMLButtonElement>(':scope > .tab-list [data-tab-button]')]
}

describe('colon containers nest the whole syntax set', () => {
    const inner = [
        ['heading', '## H\n'],
        ['table', '| a |\n| - |\n| b |\n'],
        ['task list', '- [x] done\n'],
        ['code fence', '```ts\nconst a = 1\n:::\n```\n'],
        ['mermaid', '```mermaid\ngraph LR; A-->B\n```\n'],
        ['math block', '$$\na=b\n$$\n'],
        ['callout', '> [!warning] W\n> body\n'],
        ['folded callout', '> [!tip]- T\n> body\n'],
        ['details', '::: details D\ninside\n:::\n'],
        ['nested tab set', ':::: tabs\n::: tab-item In\ninside\n:::\n::::\n'],
        ['md example', '~~~md-example\n**x**\n~~~\n'],
        ['wikilink', '[[Note]]\n'],
        ['embed', '![[Note#Section]]\n'],
        ['footnote', 'text[^f]\n\n[^f]: def\n'],
        ['block id', 'para ^blockid\n'],
    ] as const

    it.each(inner)('keeps %s inside a tab panel', (_name, source) => {
        const panel = panelOf(`:::: tabs\n::: tab-item A\n${source}:::\n::::`, 0)
        expect(panel.innerHTML).not.toMatch(/::{3,}/)
        expect(panel.children.length, panel.innerHTML).toBeGreaterThan(0)
    })

    it.each(inner)('keeps %s inside a details block', (_name, source) => {
        const host = document.createElement('div')
        host.innerHTML = html(`::: details OUTER\n${source}:::`)
        expect(host.innerHTML).not.toMatch(/<p>[^<]*:{3,}/)
        expect(host.querySelector('details')).not.toBeNull()
    })

    it.each(inner)('keeps %s inside a callout body', (_name, source) => {
        const quoted = source.split('\n').map((line) => (line.trim() ? `> ${line}` : '>')).join('\n')
        const host = document.createElement('div')
        host.innerHTML = html(`> [!note] OUTER\n${quoted}`)
        expect(host.innerHTML).not.toMatch(/<p>[^<]*:{3,}/)
    })

    it.each(inner)('keeps %s inside a tab panel of a nested tab set', (_name, source) => {
        const panel = panelOf(`:::: tabs\n::: tab-item Out\n:::: tabs\n::: tab-item In\n${source}:::\n::::\n:::\n::::`, 0)
        const innerGroup = panel.querySelector('[data-tabs]')
        expect(innerGroup, panel.innerHTML).not.toBeNull()
        expect(innerGroup!.querySelector('[data-tab-panel="0"]')!.innerHTML).not.toMatch(/::{3,}/)
    })

    it.each(inner)('keeps %s inside a list item', (_name, source) => {
        const quoted = source.split('\n').map((line) => (line.trim() ? `  ${line}` : '')).join('\n')
        const host = document.createElement('div')
        host.innerHTML = html(`- item\n\n${quoted}`)
        expect(host.innerHTML).not.toMatch(/<p>[^<]*:{3,}/)
    })
})

describe('colon container syntax tolerance', () => {
    it('accepts the space-free spellings', () => {
        const host = document.createElement('div')
        host.innerHTML = html(':::tabs\n:::tab-item A\nx\n:::\n:::')
        expect(host.querySelectorAll('[data-tabs]')).toHaveLength(1)
        expect(host.querySelectorAll('[data-tab-panel]')).toHaveLength(1)
        expect(html(':::details D\nx\n:::')).toContain('<summary>D</summary>')
    })

    it('accepts brace directive spellings at any marker length', () => {
        const host = document.createElement('div')
        host.innerHTML = html(':::::{tab-set}\n:::{tab-item} A\na text\n:::\n:::{tab-item} B\nb text\n:::\n:::::')
        expect(host.querySelectorAll('[data-tab-panel]')).toHaveLength(2)
        expect(host.textContent).toContain('b text')
    })

    it('pairs equal-length tab items with their set', () => {
        for (const source of [
            '::: tabs\n::: tab-item A\none\n:::\n::: tab-item B\ntwo\n:::\n:::',
            ':::: tabs\n:::: tab-item A\none\n::::\n:::: tab-item B\ntwo\n::::\n::::',
        ]) {
            const host = document.createElement('div')
            host.innerHTML = html(source)
            expect(host.querySelectorAll('[data-tab-panel]'), source).toHaveLength(2)
            expect(host.textContent, source).toContain('two')
        }
    })

    it('keeps a tab set without tab items readable as ordinary blocks', () => {
        const host = document.createElement('div')
        host.innerHTML = html(':::: tabs\nplain text only\n::::')
        expect(host.textContent).toContain('plain text only')
        expect(host.querySelectorAll('[data-tabs]')).toHaveLength(0)
    })

    it('keeps an unclosed container claiming the rest of its context', () => {
        const host = document.createElement('div')
        host.innerHTML = html(':::: tabs\n::: tab-item A\nx\n::::')
        expect(host.textContent).toContain('x')
        expect(host.querySelectorAll('[data-tab-panel]')).toHaveLength(1)
        expect(html(':::: tabs\n::: tab-item A\nx\n::::')).not.toMatch(/<p>::::/)
    })

    it('keeps the legacy @tab markers working', () => {
        const host = document.createElement('div')
        host.innerHTML = html(':::: tabs\n@tab A\nx\n\n@tab B\ny\n::::')
        expect(host.querySelectorAll('[data-tab-panel]')).toHaveLength(2)
    })

    it('honours the :selected: option', () => {
        const host = document.createElement('div')
        host.innerHTML = html(':::: tabs\n::: tab-item A\nx\n:::\n::: tab-item B\n:selected:\ny\n:::\n::::')
        const panels = [...host.querySelectorAll<HTMLElement>('[data-tab-panel]')]
        expect(panels[0]!.hidden).toBe(true)
        expect(panels[1]!.hidden).toBe(false)
    })

    it('reads +/-/open fold markers without leaking them into the summary', () => {
        const collapsed = html('::: details - T_minus\nx\n:::')
        expect(collapsed).toContain('<summary>T_minus</summary>')
        expect(collapsed).not.toContain('- T_minus')
        expect(collapsed).not.toContain(' open')
        const opened = html('::: details + T_plus\nx\n:::')
        expect(opened).toContain('<summary>T_plus</summary>')
        expect(opened).toContain(' open')
    })

    it('takes :selected with or without the trailing colon', () => {
        for (const option of [':selected', ':selected:']) {
            const host = document.createElement('div')
            host.innerHTML = html(`:::: tabs\n::: tab-item A\nx\n:::\n::: tab-item B\n${option}\ny\n:::\n::::`)
            const panels = [...host.querySelectorAll<HTMLElement>('[data-tab-panel]')]
            expect([panels[0]!.hidden, panels[1]!.hidden], option).toEqual([true, false])
        }
    })

    it('drops only real option lines, not arbitrary text', () => {
        const panel = panelOf(':::: tabs\n::: tab-item A\n:keepme:\nx\n:::\n::::', 0)
        expect(panel.textContent).toContain(':keepme:')
    })

    it('lets an unknown directive keep its own closer', () => {
        const host = document.createElement('div')
        host.innerHTML = html(':::: tabs\n::: tab-item A\n::: note X\nbody text\n:::\n:::\n::::')
        expect(host.querySelectorAll('[data-tabs]')).toHaveLength(1)
        const panel = host.querySelector<HTMLElement>('[data-tab-panel="0"]')!
        expect(panel.textContent).toContain('body text')
        expect(panel.textContent).toContain('::: note X')
        expect(host.children).toHaveLength(1)
    })

    it('keeps an empty embed or link visible instead of rendering nothing', () => {
        expect(html('![[ ]]')).toContain('![[ ]]')
        expect(html('[[ ]]')).toContain('[[ ]]')
        expect(html('![[note]]')).toContain('data-embed-target')
    })

    it('leaves an unknown colon directive alone', () => {
        expect(html('::: note T\nbody\n:::')).toContain('::: note T')
    })
})

describe('container titles carry inline syntax', () => {
    it('renders emphasis, wikilinks and math in a callout title', () => {
        const result = renderMarkdown('> [!note] **Bold** [[Note]] $x^2$\n> body')
        expect(result.html).toMatch(/<div class="callout-title"><strong>Bold<\/strong> <a class="wikilink"/)
        expect(result.html).toContain('data-math')
        expect(result.hasMath).toBe(true)
    })

    it('renders a wikilink in a details summary', () => {
        expect(html('::: details [[Note]]\nx\n:::')).toContain('<summary><a class="wikilink"')
    })

    it('keeps tab labels as plain text inside the tab button', () => {
        const label = panelOf(':::: tabs\n::: tab-item **B** [[Note]]\nx\n:::\n::::', 0)
        const button = label.closest('[data-tabs]')!.querySelector('button')!
        expect(button.innerHTML).toBe('**B** [[Note]]')
    })
})

describe('tab groups stay independent when nested', () => {
    function mounted(source: string): HTMLElement {
        const host = document.createElement('div')
        host.innerHTML = renderMarkdown(source).html
        document.body.append(host)
        return host
    }

    const nested = [
        ':::: tabs',
        '::: tab-item Out1',
        ':::: tabs',
        '::: tab-item In1',
        'first',
        ':::',
        '::: tab-item In2',
        'second',
        ':::',
        '::::',
        ':::',
        '::: tab-item Out2',
        'other',
        ':::',
        '::::',
    ].join('\n')

    it('an outer selection leaves the inner group selected state untouched', () => {
        const host = mounted(nested)
        const outer = host.querySelector<HTMLElement>('[data-tabs]')!
        const inner = outer.querySelector<HTMLElement>('[data-tab-panel="0"] [data-tabs]')
        expect(inner, outer.innerHTML).not.toBeNull()
        const innerButtons = buttons(inner!)
        expect(innerButtons).toHaveLength(2)
        const innerSecond = inner!.querySelector<HTMLElement>('[data-tab-panel="1"]')!
        selectMarkdownTab(innerButtons[1]!)
        expect(innerSecond.hidden).toBe(false)

        selectMarkdownTab(buttons(outer)[0]!)

        expect(innerButtons.map((button) => button.getAttribute('aria-selected'))).toEqual(['false', 'true'])
        expect(innerButtons[0]!.tabIndex).toBe(-1)
        expect(innerButtons[1]!.tabIndex).toBe(0)
        expect(innerSecond.hidden).toBe(false)
        expect(outer.querySelector<HTMLElement>(':scope > [data-tab-panel="1"]')!.hidden).toBe(true)
        host.remove()
    })

    it('a heading inside an unselected nested panel is revealed before the jump', () => {
        const host = mounted([
            ':::: tabs',
            '::: tab-item Out',
            ':::: tabs',
            '::: tab-item In1',
            'first',
            ':::',
            '::: tab-item In2',
            '## Deep',
            ':::',
            '::::',
            ':::',
            '::::',
        ].join('\n'))
        const outer = host.querySelector<HTMLElement>('[data-tabs]')!
        const inner = host.querySelector<HTMLElement>('[data-tab-panel="0"] [data-tabs]')!
        const deep = host.querySelector<HTMLElement>('#deep')!
        const innerSecond = inner.querySelector<HTMLElement>(':scope > [data-tab-panel="1"]')!
        const innerFirst = inner.querySelector<HTMLElement>(':scope > [data-tab-panel="0"]')!
        expect(innerSecond.hidden).toBe(true)

        revealPreviewTarget(deep)

        expect(innerSecond.hidden).toBe(false)
        expect(innerFirst.hidden).toBe(true)
        expect([...inner.querySelectorAll<HTMLElement>(':scope > .tab-list [data-tab-button]')]
            .map((button) => button.getAttribute('aria-selected'))).toEqual(['false', 'true'])
        expect(outer.querySelector<HTMLElement>(':scope > [data-tab-panel="0"]')!.hidden).toBe(false)
        host.remove()
    })

    it('a heading inside a collapsed details block opens it', () => {
        const host = mounted('::: details - Collapsed\n## Deep\n:::')
        const block = host.querySelector<HTMLDetailsElement>('details')!
        expect(block.open).toBe(false)

        revealPreviewTarget(host.querySelector('#deep'))

        expect(block.open).toBe(true)
        host.remove()
    })

    it('a panel that has no nested group keeps sibling behaviour', () => {
        const host = mounted(':::: tabs\n::: tab-item A\none\n:::\n::: tab-item B\ntwo\n:::\n::::')
        const group = host.querySelector<HTMLElement>('[data-tabs]')!
        selectMarkdownTab(buttons(group)[1]!)
        expect(group.querySelector<HTMLElement>('[data-tab-panel="0"]')!.hidden).toBe(true)
        expect(group.querySelector<HTMLElement>('[data-tab-panel="1"]')!.hidden).toBe(false)
        host.remove()
    })
})
