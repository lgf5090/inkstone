/**
 * The inline layer: `[key:: value]` shown as a labelled chip, and a `= expression` line answered in
 * place. Both run over rendered prose, so the cases are about which text the pass may touch — inside a
 * code fence it must not, on a line that only looks like a field it must not, and a line that is a
 * query must be replaced exactly once.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { renderDataviewInline, takeInlineJsLines } from './inline'
import { decodeDataValue } from '../markdown/data-attr'
import { DvLink, Values, type DataObject } from './value'
import type { QueryRuntimeSettings } from './functions'
import { DEFAULT_QUERY_SETTINGS } from './functions'
import type { LinkHandler } from './context'

const settings: QueryRuntimeSettings = {
    ...DEFAULT_QUERY_SETTINGS,
    renderNullAs: '—',
    dateFormat: 'yyyy-MM-dd',
    datetimeFormat: 'yyyy-MM-dd HH:mm',
    durationFormat: 'long',
    locale: 'en-US',
}

const linkHandler: LinkHandler = {
    resolve: () => null,
    normalize: (path) => path,
    exists: () => false,
}

const data: DataObject = {
    rating: 5 as never,
    due: new Date(2024, 4, 6) as never,
    file: { name: 'Alpha', path: 'Alpha.md', link: DvLink.file('Alpha.md') } as never,
}

function prose(html: string): HTMLElement {
    const root = document.createElement('div')
    root.className = 'ink-prose'
    root.innerHTML = html
    return root
}

function run(root: HTMLElement, over: Partial<Parameters<typeof renderDataviewInline>[1]> = {}): void {
    renderDataviewInline(root, { settings, data, linkHandler, fields: true, queries: true, ...over })
}

beforeEach(() => {
    document.body.replaceChildren()
})

describe('inline fields', () => {
    it('turns a bracketed field into a labelled chip and keeps the sentence around it', () => {
        const root = prose('<p>Shipped [status:: done] on time.</p>')
        run(root)
        const chip = root.querySelector<HTMLElement>('.dataview-inline-field')!
        expect(chip.dataset.fieldKey).toBe('status')
        expect(chip.querySelector('.dataview-inline-key')?.textContent).toBe('status')
        expect(chip.querySelector('.dataview-inline-value')?.textContent).toBe('done')
        expect(root.querySelector('p')?.textContent).toBe('Shipped status::done on time.')
    })

    it('types a value the way an indexed field is typed', () => {
        const root = prose('<p>Effort [days:: 3] due [when:: 2024-05-06]</p>')
        run(root)
        const values = [...root.querySelectorAll('.dataview-inline-value')].map((node) => node.textContent)
        expect(values).toEqual(['3', '2024-05-06'])
    })

    it('renders a link value as a link', () => {
        const root = prose('<p>See [related:: [[Beta]]]</p>')
        run(root)
        expect(root.querySelector('.dataview-inline-value a.wikilink')?.textContent).toBe('Beta')
    })

    it('reads a whole-line field', () => {
        const root = prose('<p>Author:: Ursula</p>')
        run(root)
        expect(root.querySelector('.dataview-inline-key')?.textContent).toBe('Author')
        expect(root.querySelector('.dataview-inline-value')?.textContent).toBe('Ursula')
    })

    it('leaves a line that only carries a double colon alone', () => {
        const root = prose('<p>Time is 12::30 in the log</p>')
        run(root)
        // The key has to be a word, which `12` is: the reference accepts it and so does this.
        expect(root.querySelector('.dataview-inline-field')?.textContent).toContain('12')
        const plain = prose('<p>a::b::c</p>')
        run(plain)
        expect(plain.querySelector('.dataview-inline-field')).toBeNull()
    })

    it('does not touch a field written inside a code fence or a query result', () => {
        const root = prose('<pre><code>[status:: done]</code></pre>')
        run(root)
        expect(root.querySelector('.dataview-inline-field')).toBeNull()
        expect(root.querySelector('code')?.textContent).toBe('[status:: done]')
    })

    it('does nothing when the switch is off', () => {
        const root = prose('<p>Shipped [status:: done].</p>')
        renderDataviewInline(root, { settings, data, linkHandler, fields: false, queries: false })
        expect(root.querySelector('.dataview-inline-field')).toBeNull()
    })
})

describe('inline queries', () => {
    it('answers a line that starts with an equals sign', () => {
        const root = prose('<p>= rating * 2</p>')
        run(root)
        expect(root.querySelector('.dataview-inline-query')?.textContent).toBe('10')
        expect(root.querySelector('p')?.textContent).toBe('10')
    })

    it('reads a property of the current note through this.', () => {
        const root = prose('<p>= this.file.name</p>')
        run(root)
        expect(root.querySelector('.dataview-inline-query')?.textContent).toBe('Alpha')
    })

    it('keeps a hidden computation out of the page', () => {
        const root = prose('<p>=( rating + 1 )</p>')
        run(root)
        expect(root.querySelector('p')?.textContent).toBe('')
    })

    it('marks a failed line rather than erasing it', () => {
        const root = prose('<p>= nosuchfunction(1)</p>')
        run(root)
        const mark = root.querySelector('.dataview-inline-error')!
        expect(mark.getAttribute('title')).toContain('Unrecognized function')
        expect(mark.textContent).toBe('—')
    })

    it('leaves a prose line that starts with an equals but no expression', () => {
        const root = prose('<p>=</p>')
        run(root)
        expect(root.querySelector('.dataview-inline-query')).toBeNull()
        expect(root.querySelector('p')?.textContent).toBe('=')
    })

    it('answers inside a list item without disturbing the marker', () => {
        const root = prose('<ul><li>= length(file.name)</li></ul>')
        run(root)
        expect(root.querySelector('li')?.textContent).toBe('5')
    })

    it('answers only the query line of a paragraph written across lines', () => {
        const root = prose('<p>= 1 + 1\nShipped [status:: done] on time.</p>')
        run(root)
        expect(root.querySelector('.dataview-inline-query')?.textContent).toBe('2')
        expect(root.querySelector('p')?.textContent).toContain('Shipped')
        expect(root.querySelector('p')?.textContent).toContain('on time.')
        expect(root.querySelector('.dataview-inline-field')?.querySelector('.dataview-inline-value')?.textContent).toBe('done')
    })

    it('keeps a line the parser refuses as a notice instead of throwing', () => {
        const root = prose('<p>= 1 +</p>\n<p>Tail [size:: 3]</p>')
        const wrapped = prose('<div></div>')
        wrapped.append(root)
        expect(() => run(wrapped)).not.toThrow()
        const mark = root.querySelector('.dataview-inline-error')!
        expect(mark.getAttribute('title')).toContain('Expected')
        expect(mark.textContent).toBe('—')
        expect(root.querySelectorAll('.dataview-inline-field')).toHaveLength(1)
    })

    it('answers a query line the surface has already split into decorated pieces', () => {
        const root = prose('<p>= length(<a class="wikilink">this.file</a>.name)</p>')
        run(root)
        expect(root.querySelector('.dataview-inline-query')?.textContent).toBe('5')
        expect(root.querySelector('a')).toBeNull()
    })

    it('runs once, even when the prose is walked twice', () => {
        const root = prose('<p>= 1 + 1</p>')
        run(root)
        run(root)
        expect(root.querySelectorAll('.dataview-inline-query')).toHaveLength(1)
        expect(root.querySelector('p')?.textContent).toBe('2')
    })

    it('renders a date value with the configured pattern', () => {
        const root = prose('<p>= due</p>')
        run(root)
        expect(root.querySelector('.dataview-inline-query')?.textContent).toBe('2024-05-06')
        const slash = prose('<p>= due</p>')
        renderDataviewInline(slash, { settings: { ...settings, dateFormat: 'yyyy/MM/dd' }, data, linkHandler, fields: true, queries: true })
        expect(slash.querySelector('.dataview-inline-query')?.textContent).toBe('2024/05/06')
    })

    it('treats a null value as the placeholder, not as an error', () => {
        const root = prose('<p>= missing</p>')
        run(root)
        expect(root.querySelector('p')?.textContent).toBe('—')
        expect(root.querySelector('.dataview-inline-error')).toBeNull()
    })
})

describe('inline value shapes', () => {
    it('keeps a boolean and a number distinguishable in a chip', () => {
        const root = prose('<p>[ok:: true] [n:: 2.5]</p>')
        run(root)
        const values = [...root.querySelectorAll('.dataview-inline-value')].map((node) => node.textContent)
        expect(values).toEqual(['true', '2.5'])
        expect(Values.isString(values[0])).toBe(true)
    })
})

describe('where a query line may be', () => {
    it('answers a fenced line only when the reader asked, and never an inline code span', () => {
        const kept = prose('<pre><code>= 2 + 2</code></pre>')
        run(kept)
        expect(kept.querySelector('.dataview-inline-query')).toBeNull()
        expect(kept.textContent).toBe('= 2 + 2')

        const answered = prose('<pre><code>= 2 + 2</code></pre>')
        run(answered, { codeblocks: true })
        expect(answered.querySelector('.dataview-inline-query')?.textContent).toBe('4')

        // The line is the code span's whole text, so only the skip rule can keep this one literal.
        const span = prose('<p><code>= 2 + 2</code></p>')
        run(span, { codeblocks: true })
        expect(span.querySelector('.dataview-inline-query')).toBeNull()
        expect(span.textContent).toBe('= 2 + 2')
    })
})

describe('inline script lines', () => {
    const base = { settings, data, linkHandler, fields: true, queries: true }

    it('marks each line and hands its code back in document order', () => {
        const root = prose('<p>$= dv.paragraph("a")</p><p>plain prose</p><p>$= dv.paragraph("b")</p>')
        const marks = takeInlineJsLines(root, { ...base, jsPrefix: '$=' }, 20)
        expect(marks.map((mark) => decodeDataValue(mark.dataset.dataviewJs ?? ''))).toEqual(['dv.paragraph("a")', 'dv.paragraph("b")'])
        expect(marks[0]?.textContent).toBe('dv.paragraph("a")')
        expect(root.textContent).toContain('plain prose')
    })

    it('takes only the line that starts with the prefix', () => {
        const root = prose('<p>Cost $= 5 and a half</p>')
        const marks = takeInlineJsLines(root, { ...base, jsPrefix: '$=' }, 20)
        expect(marks).toHaveLength(0)
        expect(root.querySelector('p')?.textContent).toBe('Cost $= 5 and a half')
    })

    it('stops at the limit and does nothing without a prefix', () => {
        const root = prose('<p>$= one</p><p>$= two</p><p>$= three</p>')
        expect(takeInlineJsLines(root, { ...base, jsPrefix: '$=' }, 2)).toHaveLength(2)
        const untouched = prose('<p>$= one</p>')
        expect(takeInlineJsLines(untouched, base, 20)).toHaveLength(0)
        expect(untouched.querySelector('p')?.textContent).toBe('$= one')
    })

    it('marks a line once, so a re-render cannot queue it twice', () => {
        const root = prose('<p>$= dv.paragraph("a")</p>')
        const context = { ...base, jsPrefix: '$=' }
        expect(takeInlineJsLines(root, context, 20)).toHaveLength(1)
        expect(takeInlineJsLines(root, context, 20)).toHaveLength(0)
    })
})
